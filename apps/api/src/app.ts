import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { COUNTRIES, CURRENCIES, FIELDS, FIELD_GROUP_LABELS, METRICS, POLICY_V1, PROVINCE_CODES, REVIEW_MODES, type EngineInput } from "@agir/contracts";
import { asUser, type BlobStore, type Db } from "@agir/db";
import { DRIVERS, EngineInputError, explore, grid, tornado, type DriverKey, type Shock } from "@agir/engine";
import { kindOf } from "@agir/extraction";
import { MAX_UPLOAD_BYTES } from "@agir/worker";
import { checkPassword, createSession, endSession, hashPassword, rateLimiter, SESSION_DAYS, userForSession } from "./auth.ts";
import { auditPackage, createRun, dealOverview, HttpError, reviewView, runView } from "./services.ts";

export type AppDeps = { db: Db; store: BlobStore; secureCookies: boolean; demoSignIn?: boolean };
type Env = { Variables: { user: { id: string; email: string; name: string } } };

const COOKIE = "agir_session";
const PG_STATUS: Record<string, number> = { "42501": 403, "28000": 401, P0002: 404, "22023": 422, "23505": 409, "40001": 409, "23514": 422 };

export function createApp({ db, store, secureCookies, demoSignIn = false }: AppDeps) {
  const app = new Hono<Env>();
  const authLimit = rateLimiter(20, 60_000);

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...(err.body ? { detail: err.body } : {}) }, err.status as 400);
    if (err instanceof EngineInputError) return c.json({ error: err.message, problems: err.problems }, 422);
    if (err instanceof z.ZodError) return c.json({ error: "Some fields are missing or not valid.", issues: err.issues }, 422);
    const code = (err as { code?: string }).code;
    if (code && PG_STATUS[code]) return c.json({ error: err.message }, PG_STATUS[code] as 400);
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "api.error", path: c.req.path, error: err.message }));
    return c.json({ error: "Something went wrong on our side. It has been logged." }, 500);
  });

  // Mutations must carry a custom header, which a cross-site form cannot send.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && c.req.header("x-agir") !== "1") {
      return c.json({ error: "Missing request header" }, 403);
    }
    await next();
  });

  app.get("/api/health", async (c) => {
    const [r] = await db.query<{ ok: number }>(`select 1 as ok`);
    return c.json({ ok: r?.ok === 1, policy: POLICY_V1.version });
  });

  // ---- Auth -----------------------------------------------------------------------
  const cookieOpts = { httpOnly: true, sameSite: "Lax" as const, secure: secureCookies, path: "/", maxAge: SESSION_DAYS * 86400 };

  app.post("/api/auth/signup", async (c) => {
    if (!authLimit(c.req.header("x-forwarded-for") ?? "local")) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = z
      .object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(10, "Use at least 10 characters").max(200) })
      .parse(await c.req.json());
    const email = body.email.toLowerCase();
    const [exists] = await db.query(`select 1 from users where email = $1`, [email]);
    if (exists) return c.json({ error: "An account with that email already exists." }, 409);
    const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [
      email,
      body.name,
      await hashPassword(body.password),
    ]);
    await asUser(db, u!.id, (tx) => tx.query(`select fn_create_workspace($1)`, [`${body.name.split(" ")[0]}'s workspace`]));
    setCookie(c, COOKIE, await createSession(db, u!.id), cookieOpts);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    if (!authLimit(c.req.header("x-forwarded-for") ?? "local")) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = z.object({ email: z.string(), password: z.string() }).parse(await c.req.json());
    const [u] = await db.query<{ id: string; password_hash: string }>(`select id, password_hash from users where email = $1`, [body.email.toLowerCase()]);
    if (!u || !(await checkPassword(body.password, u.password_hash))) return c.json({ error: "That email and password do not match." }, 401);
    setCookie(c, COOKIE, await createSession(db, u.id), cookieOpts);
    return c.json({ ok: true });
  });

  // Local development only: one-click sign-in as a seeded demo person. The
  // route is not registered at all unless the server was started with it on,
  // which main.ts never does in production.
  app.get("/api/auth/demo", (c) => c.json({ available: demoSignIn }));
  if (demoSignIn) {
    app.post("/api/auth/demo", async (c) => {
      const { who } = z.object({ who: z.enum(["analyst", "reviewer"]) }).parse(await c.req.json());
      const email = who === "analyst" ? "demo@agir.local" : "reviewer@agir.local";
      const [u] = await db.query<{ id: string }>(`select id from users where email = $1`, [email]);
      if (!u) return c.json({ error: "The demo data has not been seeded." }, 404);
      setCookie(c, COOKIE, await createSession(db, u.id), cookieOpts);
      return c.json({ ok: true });
    });
  }

  app.post("/api/auth/logout", async (c) => {
    await endSession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Everything below needs a session.
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    const user = await userForSession(db, getCookie(c, COOKIE));
    if (!user) return c.json({ error: "Sign in to continue." }, 401);
    c.set("user", user);
    await next();
  });

  const as = <T>(c: Context<Env>, fn: (tx: Db) => Promise<T>) => asUser(db, c.get("user").id, fn);

  app.get("/api/me", async (c) => {
    const workspaces = await as(c, (tx) =>
      tx.query(
        `select w.id, w.name, w.review_mode, m.role from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = agir_uid() order by w.created_at`,
      ),
    );
    return c.json({ user: c.get("user"), workspaces });
  });

  app.get("/api/catalog", (c) =>
    c.json({ fields: FIELDS, groups: FIELD_GROUP_LABELS, metrics: METRICS, policy: POLICY_V1 }),
  );

  // ---- Workspaces -----------------------------------------------------------------
  app.post("/api/workspaces", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await c.req.json());
    const [r] = await as(c, (tx) => tx.query<{ id: string }>(`select fn_create_workspace($1) as id`, [name]));
    return c.json({ id: r!.id });
  });

  app.post("/api/workspaces/:ws/review-mode", async (c) => {
    const { mode } = z.object({ mode: z.enum(REVIEW_MODES) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_review_mode($1, $2)`, [c.req.param("ws"), mode]));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:ws/review-grant", async (c) => {
    const body = z.object({ email: z.string().email(), days: z.number().int().min(1).max(90) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_grant_review($1, $2, $3)`, [c.req.param("ws"), body.email, body.days]));
    return c.json({ ok: true });
  });

  app.get("/api/workspaces/:ws/members", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(`select u.id, u.name, u.email, m.role, m.expires_at from workspace_members m join users u on u.id = m.user_id where m.workspace_id = $1 order by u.name`, [c.req.param("ws")]),
    );
    return c.json(rows);
  });

  app.post("/api/workspaces/:ws/members", async (c) => {
    const body = z.object({ email: z.string().email(), role: z.enum(["admin", "analyst", "viewer"]) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_add_member($1, $2, $3)`, [c.req.param("ws"), body.email, body.role]));
    return c.json({ ok: true });
  });

  app.get("/api/workspaces/:ws/audit/verify", async (c) => {
    const [r] = await as(c, (tx) => tx.query(`select * from fn_verify_audit_chain()`));
    return c.json(r);
  });

  // ---- Deals ----------------------------------------------------------------------
  app.get("/api/workspaces/:ws/deals", async (c) => {
    const out = await as(c, async (tx) => {
      const deals = await tx.query<{ id: string }>(`select id from deals where workspace_id = $1 and archived_at is null order by created_at desc`, [c.req.param("ws")]);
      return Promise.all(deals.map((d) => dealOverview(tx, d.id)));
    });
    return c.json(out);
  });

  app.post("/api/workspaces/:ws/deals", async (c) => {
    const body = z
      .object({
        name: z.string().min(1).max(160),
        assetType: z.string().min(1).max(60),
        location: z.string().max(160).default(""),
        currency: z.enum(CURRENCIES).default("CAD"),
        country: z.enum(COUNTRIES).default("CA"),
        province: z.enum(PROVINCE_CODES).nullable().default(null),
      })
      .refine((b) => b.province === null || b.country === "CA", { message: "A province is given only for a deal in Canada.", path: ["province"] })
      .parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query<{ id: string }>(`select fn_create_deal($1, $2, $3, $4, $5, $6, $7) as id`, [
        c.req.param("ws"),
        body.name,
        body.assetType,
        body.location,
        body.currency,
        body.country,
        body.province,
      ]),
    );
    return c.json({ id: r!.id });
  });

  app.get("/api/deals/:id", async (c) => c.json(await as(c, (tx) => dealOverview(tx, c.req.param("id")))));

  // ---- Documents --------------------------------------------------------------------
  app.get("/api/deals/:id/documents", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(
        `select d.id, d.name, d.kind, d.size_bytes, d.stage, d.stage_detail, d.page_count, d.number_format, d.needs_ocr, d.candidate_count,
                d.created_at, d.updated_at, u.name as uploaded_by,
                (select count(*)::int from candidates c where c.document_id = d.id and c.field_key is null) as other_count
         from documents d left join users u on u.id = d.uploaded_by
         where d.deal_id = $1 and d.retired_at is null order by d.created_at, d.name`,
        [c.req.param("id")],
      ),
    );
    return c.json(rows);
  });

  app.put("/api/deals/:id/documents", async (c) => {
    const name = (c.req.query("name") ?? "").trim();
    const kind = kindOf(name);
    if (!name || !kind) return c.json({ error: "Upload a PDF, Excel (.xlsx), CSV, Word (.docx) or text file." }, 415);
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: "The file is larger than 75 MB." }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "The file is empty." }, 422);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: "The file is larger than 75 MB." }, 413);
    const put = await store.put(bytes);
    const [r] = await as(c, (tx) =>
      tx.query<{ document_id: string; duplicate: boolean }>(`select * from fn_register_document($1, $2, $3, $4, $5, $6)`, [
        c.req.param("id"),
        name.slice(0, 200),
        kind,
        bytes.byteLength,
        put.sha256,
        put.key,
      ]),
    );
    return c.json({ id: r!.document_id, duplicate: r!.duplicate });
  });

  app.post("/api/documents/:id/retire", async (c) => {
    await as(c, (tx) => tx.query(`select fn_retire_document($1)`, [c.req.param("id")]));
    return c.json({ ok: true });
  });

  app.post("/api/documents/:id/retry", async (c) => {
    await as(c, (tx) => tx.query(`select fn_retry_document($1)`, [c.req.param("id")]));
    return c.json({ ok: true });
  });

  app.get("/api/documents/:id/file", async (c) => {
    const [d] = await as(c, (tx) => tx.query<{ name: string; storage_key: string; kind: string }>(`select name, storage_key, kind from documents where id = $1`, [c.req.param("id")]));
    if (!d) return c.json({ error: "Document not found" }, 404);
    const bytes = await store.get(d.storage_key);
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${encodeURIComponent(d.name)}"` },
    });
  });

  app.get("/api/documents/:id/candidates", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(`select field_key, item_key, value, raw, unit_seen, location, context, rule, note from candidates where document_id = $1 order by location`, [c.req.param("id")]),
    );
    return c.json(rows);
  });

  // ---- Review -----------------------------------------------------------------------
  app.get("/api/deals/:id/review", async (c) => c.json(await as(c, (tx) => reviewView(tx, c.req.param("id")))));

  app.post("/api/assumptions/:id/review", async (c) => {
    const body = z
      .object({
        action: z.enum(["approve", "resolve", "modify", "second_approve", "reject", "reopen"]),
        value: z.number().finite().nullable().optional(),
        reason: z.string().max(2000).nullable().optional(),
        version: z.number().int().nullable().optional(),
      })
      .parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query(`select (a).status, (a).version from (select fn_review($1, $2, $3, $4, $5) a) x`, [
        c.req.param("id"),
        body.action,
        body.value ?? null,
        body.reason ?? null,
        body.version ?? null,
      ]),
    );
    return c.json(r);
  });

  app.post("/api/deals/:id/values", async (c) => {
    const body = z
      .object({ fieldKey: z.string(), itemKey: z.string().max(60).nullable().optional(), value: z.number().finite(), reason: z.string().max(2000) })
      .parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query(`select (a).status from (select fn_enter_value($1, $2, $3, $4, $5) a) x`, [c.req.param("id"), body.fieldKey, body.itemKey ?? null, body.value, body.reason]),
    );
    return c.json(r);
  });

  app.post("/api/deals/:id/defaults", async (c) => {
    const { fields } = z.object({ fields: z.array(z.string()).min(1) }).parse(await c.req.json());
    const [r] = await as(c, (tx) => tx.query<{ n: number }>(`select fn_accept_defaults($1, $2) as n`, [c.req.param("id"), fields]));
    return c.json({ accepted: r!.n });
  });

  // ---- Runs --------------------------------------------------------------------------
  app.post("/api/deals/:id/runs", async (c) => {
    const id = await as(c, (tx) => createRun(tx, c.req.param("id")));
    return c.json({ id });
  });

  app.get("/api/deals/:id/runs", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(
        `select r.id, r.run_number, r.verdict_code, r.created_at, r.engine_version, r.policy_version, u.name as created_by
         from runs r left join users u on u.id = r.created_by where r.deal_id = $1 order by r.run_number desc`,
        [c.req.param("id")],
      ),
    );
    return c.json(rows);
  });

  app.get("/api/runs/:id", async (c) => c.json(await as(c, (tx) => runView(tx, c.req.param("id")))));

  app.post("/api/runs/:id/decision", async (c) => {
    const body = z
      .object({
        decision: z.enum(["approve", "approve_with_conditions", "reject", "return_to_underwriting"]),
        rationale: z.string().min(10, "Give the committee's reasoning (at least 10 characters)").max(5000),
        conditions: z.string().max(5000).nullable().optional(),
        overrideReason: z.string().max(2000).nullable().optional(),
      })
      .parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query<{ id: string }>(`select fn_record_decision($1, $2, $3, $4, $5) as id`, [
        c.req.param("id"),
        body.decision,
        body.rationale,
        body.conditions ?? null,
        body.overrideReason ?? null,
      ]),
    );
    return c.json({ id: r!.id });
  });

  // ---- Sensitivity (scratch mode) ------------------------------------------------
  // Re-runs of the engine on a shocked copy of a stored run's input. Read-only:
  // nothing is written, signed or audited, and none of it can be exported.
  const shockSchema = z.object(Object.fromEntries(DRIVERS.map((d) => [d.key, z.number().finite().min(d.min).max(d.max).optional()]))) as z.ZodType<Shock>;
  const driverKey = z.enum(DRIVERS.map((d) => d.key as string) as [string, ...string[]]).transform((k) => k as DriverKey);
  const metricKey = z.enum(METRICS.map((m) => m.key) as [string, ...string[]]);
  const runInput = async (c: Context<Env>): Promise<EngineInput> => {
    const [r] = await as(c, (tx) => tx.query<{ input_snapshot: { input: EngineInput } }>(`select input_snapshot from runs where id = $1`, [c.req.param("id")]));
    if (!r) throw new HttpError(404, "Run not found");
    return r.input_snapshot.input;
  };
  app.get("/api/sensitivity/drivers", (c) => c.json(DRIVERS));
  app.post("/api/runs/:id/explore", async (c) => {
    const { shock } = z.object({ shock: shockSchema }).parse(await c.req.json());
    return c.json({ scratch: true, ...explore(await runInput(c), POLICY_V1, shock) });
  });
  app.post("/api/runs/:id/tornado", async (c) => {
    const { metric } = z.object({ metric: metricKey }).parse(await c.req.json());
    return c.json({ scratch: true, metric, ...tornado(await runInput(c), metric) });
  });
  app.post("/api/runs/:id/grid", async (c) => {
    const b = z.object({ metric: metricKey, x: driverKey, y: driverKey, steps: z.number().int().min(3).max(9).default(5) }).parse(await c.req.json());
    if (b.x === b.y) throw new HttpError(422, "Choose two different drivers.");
    return c.json({ scratch: true, metric: b.metric, ...grid(await runInput(c), b.metric, b.x, b.y, b.steps) });
  });

  app.get("/api/runs/:id/audit-package", async (c) => {
    const pkg = await as(c, (tx) => auditPackage(tx, c.req.param("id")));
    return new Response(JSON.stringify(pkg, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="agir-audit-package-run-${pkg.manifest.run.number}.json"` },
    });
  });

  // ---- Artifacts ------------------------------------------------------------------------
  app.post("/api/runs/:id/artifacts", async (c) => {
    const body = z.object({ kind: z.enum(["ic_memo", "lender_package", "model_export"]), format: z.enum(["pdf", "docx", "xlsx"]) }).parse(await c.req.json());
    if (body.kind === "model_export" && body.format !== "xlsx") return c.json({ error: "The model export is an Excel file." }, 422);
    if (body.kind !== "model_export" && body.format === "xlsx") return c.json({ error: "Memos and lender packages are PDF or Word." }, 422);
    const [r] = await as(c, (tx) => tx.query<{ id: string }>(`select fn_request_artifact($1, $2, $3) as id`, [c.req.param("id"), body.kind, body.format]));
    return c.json({ id: r!.id });
  });

  app.get("/api/deals/:id/artifacts", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(
        `select a.id, a.kind, a.format, a.status, a.error, a.sha256, a.created_at, a.run_id, r.run_number,
                (a.provenance->>'entries')::int as provenance_entries
         from artifacts a join runs r on r.id = a.run_id where a.deal_id = $1 order by a.created_at desc`,
        [c.req.param("id")],
      ),
    );
    return c.json(rows);
  });

  app.get("/api/artifacts/:id/file", async (c) => {
    const [a] = await as(c, (tx) =>
      tx.query<{ kind: string; format: string; status: string; storage_key: string | null; run_number: number; deal: string }>(
        `select a.kind, a.format, a.status, a.storage_key, r.run_number, d.name as deal from artifacts a join runs r on r.id = a.run_id join deals d on d.id = a.deal_id where a.id = $1`,
        [c.req.param("id")],
      ),
    );
    if (!a || a.status !== "ready" || !a.storage_key) return c.json({ error: "This file is not ready." }, 404);
    const bytes = await store.get(a.storage_key);
    const mime = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }[a.format] ?? "application/octet-stream";
    const label = { ic_memo: "IC memo", lender_package: "Lender package", model_export: "Model" }[a.kind] ?? a.kind;
    const inline = c.req.query("inline") === "1" && a.format === "pdf";
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": mime, "content-disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(`${a.deal} - ${label} - Run ${a.run_number}.${a.format}`)}"` },
    });
  });

  // ---- Audit ------------------------------------------------------------------------------
  app.get("/api/deals/:id/audit", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(
        `select e.seq, e.action, e.entity, e.entity_id, e.payload, e.hash, e.created_at, u.name as actor
         from audit_events e left join users u on u.id = e.actor where e.deal_id = $1 order by e.seq desc limit 500`,
        [c.req.param("id")],
      ),
    );
    return c.json(rows);
  });

  return app;
}
