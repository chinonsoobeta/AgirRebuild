import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { validateThreshold, COUNTRIES, CURRENCIES, FIELDS, FIELD_GROUP_LABELS, METRICS, POLICIES, POLICY_V1, PROVINCE_CODES, REVIEW_MODES, runPolicy, type EngineInput, type Policy } from "@agir/contracts";
import { asUser, type BlobStore, type Db } from "@agir/db";
import { breakeven, DRIVERS, driversFor, SALE_DRIVERS, EngineInputError, explore, grid, tornado, type DriverKey, type Shock } from "@agir/engine";
import { canonicalItem, itemFold, kindOf } from "@agir/extraction";
import { MAX_UPLOAD_BYTES } from "@agir/worker";
import { checkPassword, createSession, endSession, hashPassword, rateLimiter, SESSION_DAYS, userForSession } from "./auth.ts";
import { thresholdsView, auditPackage, clientViewer, createRun, dealOverview, hideClientEvents, HttpError, labelRefusal, reviewView, runView, sha256 } from "./services.ts";

export type AppDeps = { db: Db; store: BlobStore; secureCookies: boolean; demoSignIn?: boolean; trustProxy?: boolean; now?: () => Date };
type Env = { Variables: { user: { id: string; email: string; name: string } } };

const COOKIE = "agir_session";
// A new workspace starts in team review; asking for solo goes through fn_set_review_mode, so the change is audited.
async function createWorkspace(tx: Db, name: string, reviewMode?: string): Promise<string> {
  const [r] = await tx.query<{ id: string }>(`select fn_create_workspace($1) as id`, [name]);
  if (reviewMode === "solo") await tx.query(`select fn_set_review_mode($1, $2)`, [r!.id, reviewMode]);
  return r!.id;
}

const INVITE_GONE = "This invitation is not available. It may have been used, revoked or expired.";

const PG_STATUS: Record<string, number> = { "42501": 403, "28000": 401, P0002: 404, "22023": 422, "23505": 409, "40001": 409, "23514": 422, "22P02": 404 };

export function createApp({ db, store, secureCookies, demoSignIn = false, trustProxy = false, now = () => new Date() }: AppDeps) {
  const app = new Hono<Env>();
  const clientKey = (c: Context<Env>): string => {
    if (trustProxy) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (forwarded) return forwarded;
    }
    try { return getConnInfo(c).remote.address || "local"; }
    catch { return "local"; }
  };
  const authLimit = rateLimiter(20, 60_000);
  const shareLimit = rateLimiter(60, 60_000);
  const inviteLimit = rateLimiter(60, 60_000);
  const fileResponse = async (a: { kind: string; format: string; storage_key: string | null; run_number: number; deal: string; lang?: "en" | "fr" }, inline: boolean) => {
    const bytes = await store.get(a.storage_key!);
    const mime = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }[a.format] ?? "application/octet-stream";
    const label = { ic_memo: "IC memo", lender_package: "Lender package", build_decision: "Build decision", partner_memo: "Partner memo", model_export: "Model" }[a.kind] ?? a.kind;
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": mime, "content-disposition": `${inline && a.format === "pdf" ? "inline" : "attachment"}; filename="${encodeURIComponent(`${a.deal} - ${label} - Run ${a.run_number}${a.lang === "fr" ? "-fr" : ""}.${a.format}`)}"` },
    });
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message, ...(err.body ? { detail: err.body } : {}) }, err.status as 400);
    if (err instanceof EngineInputError) return c.json({ error: err.message, problems: err.problems }, 422);
    if (err instanceof z.ZodError) return c.json({ error: "Some fields are missing or not valid.", issues: err.issues }, 422);
    const code = (err as { code?: string }).code;
    if (code && PG_STATUS[code]) return c.json({ error: code === "22P02" ? "Not found." : err.message }, PG_STATUS[code] as 400);
    const shared = c.req.path.startsWith("/api/share/") || c.req.path.startsWith("/api/invite/");
    console.error(JSON.stringify({ at: new Date().toISOString(), event: "api.error", path: shared ? "/api/share/…" : c.req.path, error: shared ? "Shared link request failed" : err.message }));
    return c.json({ error: "Something went wrong on our side. It has been logged." }, 500);
  });

  // Shared links and invitations carry a secret in the path: rate-limited, never cached, never sent on as a referrer.
  for (const [prefix, limit] of [["/api/share/*", shareLimit], ["/api/invite/*", inviteLimit]] as const) {
    app.use(prefix, async (c, next) => {
      if (limit(clientKey(c))) await next();
      else c.res = c.json({ error: "Too many requests. Wait a minute." }, 429);
      c.header("cache-control", "no-store");
      c.header("referrer-policy", "no-referrer");
      c.header("x-robots-tag", "noindex");
    });
  }

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
    if (!authLimit(clientKey(c))) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = z
      .object({ email: z.string().email(), name: z.string().min(1).max(120), password: z.string().min(10, "Use at least 10 characters").max(200), reviewMode: z.enum(REVIEW_MODES).optional(),
        invite: z.string().min(1).max(200).optional() })
      .parse(await c.req.json());
    const email = body.email.toLowerCase();
    const [exists] = await db.query(`select 1 from users where email = $1`, [email]);
    if (exists) return c.json({ error: "An account with that email already exists." }, 409);
    // Through an invitation (card 89): a client of one deal, with no workspace of its own, in one transaction.
    if (body.invite) {
      const hash = sha256(body.invite);
      const [live] = await db.query(`select * from fn_peek_client_invite($1)`, [hash]);
      if (!live) return c.json({ error: INVITE_GONE }, 404);
      const passwordHash = await hashPassword(body.password);
      const userId = await db.transaction(async (tx) => {
        const [u] = await tx.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [email, body.name, passwordHash]);
        const [used] = await tx.query<{ deal: string | null }>(`select fn_use_client_invite($1, $2) as deal`, [hash, u!.id]);
        if (!used?.deal) throw new HttpError(404, INVITE_GONE);
        return u!.id;
      });
      setCookie(c, COOKIE, await createSession(db, userId), cookieOpts);
      return c.json({ ok: true });
    }
    const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [
      email,
      body.name,
      await hashPassword(body.password),
    ]);
    await asUser(db, u!.id, (tx) => createWorkspace(tx, `${body.name.split(" ")[0]}'s workspace`, body.reviewMode));
    setCookie(c, COOKIE, await createSession(db, u!.id), cookieOpts);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    if (!authLimit(clientKey(c))) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
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

  for (const [suffix, what] of [["", "page"], ["/file", "file"], ["/audit-package", "audit_package"]] as const) {
    app.get(`/api/share/:secret${suffix}`, async (c) => {
      const [link] = await db.query<{ link_id: string; artifact_id: string; run_id: string; created_by: string; kind: string; format: string;
        storage_key: string | null; run_number: number; deal_name: string; expires_at: string | null }>(
        `select * from fn_open_share_link($1, $2)`, [sha256(c.req.param("secret")!), what]);
      if (!link) return c.json({ error: "This link is not available. It may have expired or been revoked." }, 404);
      if (what === "page") {
        const [run] = await db.query<{ result: import("@agir/contracts").RunResult; input_snapshot: { policy?: Policy; standardPolicy?: Policy; policyChanges?: import("@agir/contracts").PolicyChange[] } }>(`select result,input_snapshot from runs where id=$1`, [link.run_id]);
        let standardFailures: { en: string[]; fr: string[] } | undefined;
        if (run?.input_snapshot.policy?.custom) {
          const { Formatter, customThresholdBlocks } = await import("@agir/artifacts");
          const x = { ...run.input_snapshot, policy: run.input_snapshot.policy, result: run.result };
          const failures = (lang: "en" | "fr") => customThresholdBlocks(new Formatter(run.result,lang,x.policy.maxLtcPct),x).flatMap((block) => block.type === "checks" ? block.items.filter((item) => item.lenderCited).map((item) => item.text) : []);
          standardFailures = { en: failures("en"), fr: failures("fr") };
        }
        return c.json({ deal: link.deal_name, kind: link.kind, format: link.format, runNumber: link.run_number, expiresAt: link.expires_at, ...(standardFailures ? { standardFailures } : {}) });
      }
      if (what === "file") {
        const [artifact] = await db.query<{ lang: "en" | "fr" }>(`select lang from artifacts where id = $1`, [link.artifact_id]);
        return fileResponse({ ...link, deal: link.deal_name, lang: artifact?.lang }, c.req.query("inline") === "1");
      }
      const pkg = await asUser(db, link.created_by, (tx) => auditPackage(tx, link.run_id));
      return new Response(JSON.stringify(pkg, null, 2), {
        headers: { "content-type": "application/json", "content-disposition": `attachment; filename="agir-audit-package-run-${pkg.manifest.run.number}.json"` },
      });
    });
  }

  app.get("/api/invite/:secret", async (c) => {
    const [live] = await db.query<{ workspace: string; deal: string }>(`select * from fn_peek_client_invite($1)`, [sha256(c.req.param("secret"))]);
    return live ? c.json(live) : c.json({ error: INVITE_GONE }, 404);
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
        `select w.id, w.name, w.review_mode, w.label_suggestions, w.logo_key is not null as has_logo, m.role from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = agir_uid() order by w.created_at`,
      ),
    );
    return c.json({ user: c.get("user"), workspaces });
  });

  app.get("/api/catalog", (c) =>
    c.json({ fields: FIELDS, groups: FIELD_GROUP_LABELS, metrics: METRICS, policy: POLICY_V1, policies: POLICIES }),
  );

  // ---- Workspaces -----------------------------------------------------------------
  app.post("/api/workspaces", async (c) => {
    const { name, reviewMode } = z.object({ name: z.string().min(1).max(120), reviewMode: z.enum(REVIEW_MODES).optional() }).parse(await c.req.json());
    return c.json({ id: await as(c, (tx) => createWorkspace(tx, name, reviewMode)) });
  });

  // ---- The broker's logo (card 89d): the owner sets it; it is printed on the lender package only. ----------------
  app.post("/api/workspaces/:ws/logo", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const [m] = await as(c, (tx) => tx.query<{ role: string }>(`select role from workspace_members where workspace_id = $1 and user_id = agir_uid()`, [ws]));
    if (m?.role !== "owner") return c.json({ error: "Only the workspace owner can change its logo." }, 403);
    if (Number(c.req.header("content-length") ?? 0) > LOGO_MAX_BYTES) return c.json({ error: "The image is larger than 500 KB." }, 413);
    const bytes = await readCapped(c.req.raw.body, LOGO_MAX_BYTES);
    if (!bytes) return c.json({ error: "The image is larger than 500 KB." }, 413);
    const image = imageInfo(bytes);
    if (image === "unknown") return c.json({ error: "Upload a PNG or JPEG image." }, 415);
    if (image === "unreadable") return c.json({ error: "The image could not be read: its width and height are missing or the file is incomplete." }, 422);
    if (image.width > LOGO_MAX_SIDE || image.height > LOGO_MAX_SIDE) return c.json({ error: "The image is larger than 4,096 pixels on a side." }, 422);
    const put = await store.put(bytes);
    await as(c, (tx) => tx.query(`select fn_set_logo($1, $2, $3, $4, $5)`, [ws, put.key, image.mime, image.width, image.height]));
    return c.json(image);
  });

  app.get("/api/workspaces/:ws/logo", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const [w] = await as(c, (tx) => tx.query<{ logo_key: string | null; logo_mime: string | null }>(`select logo_key, logo_mime from workspaces where id = $1`, [ws]));
    if (!w?.logo_key) return c.json({ error: "This workspace has no logo." }, 404);
    return new Response(new Uint8Array(await store.get(w.logo_key)), {
      headers: { "content-type": w.logo_mime!, "x-content-type-options": "nosniff", "cache-control": "private, no-cache" },
    });
  });

  app.delete("/api/workspaces/:ws/logo", async (c) => {
    await as(c, (tx) => tx.query(`select fn_clear_logo($1)`, [z.string().uuid().parse(c.req.param("ws"))]));
    return c.json({ ok: true });
  });

  for (const [route, scope, param] of [["/api/workspaces/:ws/thresholds", "workspace", "ws"], ["/api/deals/:id/thresholds", "deal", "id"]] as const) {
    app.get(route, async (c) => c.json(await as(c, (tx) => thresholdsView(tx,scope,c.req.param(param)!))));
    app.post(route, async (c) => {
      const id = z.string().uuid().parse(c.req.param(param));
      const body = z.object({ policyVersion: z.string(), path: z.string(), value: z.number().nullable(), reason: z.string() }).parse(await c.req.json());
      await as(c, async (tx) => {
        const [member] = await tx.query<{ role: string }>(`select m.role from workspace_members m ${scope === "deal" ? "join deals d on d.workspace_id=m.workspace_id" : ""} where ${scope === "workspace" ? "m.workspace_id" : "d.id"}=$1 and m.user_id=agir_uid()`, [id]);
        if (member?.role !== "owner") throw new HttpError(403,"Your role in this workspace does not allow this action");
        // Clearing is always allowed, so a value a later draft edit no longer accepts can still be removed.
        const error = body.value === null ? null : validateThreshold(body.policyVersion,body.path,body.value);
        if (error) throw new HttpError(422,error.en,{fr:error.fr});
        await tx.query(`select fn_set_policy_value($1,$2,$3,$4,$5,$6)`, [scope,id,body.policyVersion,body.path,body.value,body.reason]);
      });
      return c.json({ ok: true });
    });
  }

  app.post("/api/workspaces/:ws/review-mode", async (c) => {
    const { mode } = z.object({ mode: z.enum(REVIEW_MODES) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_review_mode($1, $2)`, [c.req.param("ws"), mode]));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:ws/label-suggestions", async (c) => {
    const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_label_suggestions($1, $2)`, [c.req.param("ws"), on]));
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

  // A variant: a copy in exactly the state of its source, which a person then changes (card 62).
  app.post("/api/deals/:id/copy", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(160) }).parse(await c.req.json());
    const [r] = await as(c, (tx) => tx.query<{ id: string }>(`select fn_copy_deal($1, $2) as id`, [c.req.param("id"), name]));
    return c.json({ id: r!.id });
  });

  app.get("/api/deals/:id", async (c) => c.json(await as(c, (tx) => dealOverview(tx, c.req.param("id")))));

  // ---- Clients (card 89): a broker's client sees the deals assigned to it and confirms the values the broker stated.
  app.get("/api/deals/:id/clients", async (c) => {
    const rows = await as(c, async (tx) => {
      const [d] = await tx.query<{ staff: boolean }>(`select agir_is_staff(workspace_id) as staff from deals where id = $1`, [c.req.param("id")]);
      if (!d) throw new HttpError(404, "Deal not found");
      if (!d.staff) throw new HttpError(403, "Your role in this workspace does not allow this action");
      return tx.query(`select u.id, u.name, u.email, dc.created_at as assigned_at from deal_clients dc join users u on u.id = dc.user_id
        where dc.deal_id = $1 order by u.name`, [c.req.param("id")]);
    });
    return c.json(rows);
  });

  app.post("/api/deals/:id/clients", async (c) => {
    const { email } = z.object({ email: z.string().email() }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_assign_client($1, $2)`, [c.req.param("id"), email]));
    return c.json({ ok: true });
  });

  app.delete("/api/deals/:id/clients/:userId", async (c) => {
    const userId = z.string().uuid().parse(c.req.param("userId"));
    await as(c, (tx) => tx.query(`select fn_unassign_client($1, $2)`, [c.req.param("id"), userId]));
    return c.json({ ok: true });
  });

  app.post("/api/assumptions/:id/client-confirm", async (c) => {
    const { version } = z.object({ version: z.number().int().nullable().optional() }).parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query(`select (a).status, (a).version from (select fn_client_confirm($1, $2) a) x`, [c.req.param("id"), version ?? null]));
    return c.json(r);
  });

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
  // A person labels a figure Agir did not use. The worker applies it at the next reconcile; the boundary re-checks unit, bounds and item.
  const figureTarget = z.object({ documentId: z.string().uuid(), figureId: z.string().min(1).max(2000) });
  const ownFigure = async (tx: Db, dealId: string, documentId: string) => {
    if (!(await tx.query(`select 1 from documents where id = $1 and deal_id = $2`, [documentId, dealId])).length) throw new HttpError(404, "Document not found");
  };
  app.post("/api/deals/:id/figure-labels", async (c) => {
    const b = figureTarget
      .extend({ fieldKey: z.string().refine((k) => FIELDS.some((f) => f.key === k && f.extractable), "Not a field that is read from documents"), itemKey: z.string().max(120).optional() })
      .parse(await c.req.json());
    if (FIELDS.find((f) => f.key === b.fieldKey)!.itemized && !b.itemKey?.trim()) throw new HttpError(422, "This field needs an item name");
    await as(c, async (tx) => {
      await ownFigure(tx, c.req.param("id"), b.documentId);
      const why = await labelRefusal(tx, b.documentId, { id: b.figureId, fieldKey: b.fieldKey, itemKey: b.itemKey });
      if (why) throw new HttpError(422, why);
      await tx.query(`select fn_label_figure($1, $2, $3, $4)`, [b.documentId, b.figureId, b.fieldKey, b.itemKey ?? ""]);
    });
    return c.json({ ok: true });
  });
  app.delete("/api/deals/:id/figure-labels", async (c) => {
    const b = figureTarget.parse(await c.req.json());
    await as(c, async (tx) => {
      await ownFigure(tx, c.req.param("id"), b.documentId);
      await tx.query(`select fn_unlabel_figure($1, $2)`, [b.documentId, b.figureId]);
    });
    return c.json({ ok: true });
  });

  app.get("/api/deals/:id/review", async (c) => c.json(await as(c, (tx) => reviewView(tx, c.req.param("id"), now().toISOString().slice(0, 10)))));

  app.post("/api/assumptions/:id/review", async (c) => {
    const body = z
      .object({
        action: z.enum(["approve", "resolve", "modify", "second_approve", "use_as_stated", "reject", "reopen"]),
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

  app.post("/api/deals/:id/proposals/accept", async c => {
    const body=z.object({fieldKey:z.string(),tableId:z.string(),optionKey:z.string()}).parse(await c.req.json());
    const result=await as(c,async tx=>{
      // Recompute from the currently approved inputs under the current clock.
      const view=await reviewView(tx,c.req.param("id"),now().toISOString().slice(0,10));
      const proposal=[...view.proposals,...view.tableNotices].find(p=>p.fieldKey === body.fieldKey && p.tableId === body.tableId);
      const option=proposal?.options.find(o=>o.key === body.optionKey);
      if (!proposal || proposal.unavailable || !option) throw new HttpError(422,"This table option is not available. Review the current proposals.");
      const fields=body.fieldKey === "land_transfer_tax" ? ["land_cost"] : body.fieldKey === "refinance_insurance_premium_pct" ? ["refinance_ltv_pct","refinance_amort_years",...(view.assumptions.some(a=>a.fieldKey === "refinance_mli_select_points" && a.status === "approved") ? ["refinance_mli_select_points"] : [])] : ["unit_count"];
      const source=JSON.stringify({tableId:proposal.tableId,optionKey:option.key,publisher:proposal.publisher,title:proposal.title,effective:proposal.effective,fields});
      const [row]=await tx.query(`select (a).status from (select fn_enter_table_value($1,$2,null,$3,$4,$5) a) x`,[c.req.param("id"),body.fieldKey,option.value,option.reason,source]);
      return row;
    });
    return c.json(result);
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

  // A unit type or space no document states: every stated value goes through fn_enter_value in one transaction, so it is added whole or not at all.
  app.post("/api/deals/:id/items", async (c) => {
    const num = z.number().finite().optional();
    const b = z
      .object({
        name: z.string().trim().min(1, "Name the unit type or space").max(60).refine((n) => !n.includes("|"), "A name cannot contain \"|\""),
        unitCount: num,
        rentMonthly: num,
        areaSf: num,
        rentPsfAnnual: num,
        occupancyPct: num,
        reason: z.string().max(2000),
      })
      .refine((x) => (x.unitCount !== undefined && x.rentMonthly !== undefined && x.areaSf === undefined && x.rentPsfAnnual === undefined)
        || (x.areaSf !== undefined && x.rentPsfAnnual !== undefined && x.unitCount === undefined && x.rentMonthly === undefined), "Give either a count and a monthly rent, or an area and an annual rent per square foot")
      .parse(await c.req.json());
    // One space between words, as the reader writes names; a type written in another case is the same type.
    const name = canonicalItem(b.name.replace(/\s+/g, " "));
    const values: [string, number | undefined][] = [["unit_count", b.unitCount], ["unit_rent_monthly", b.rentMonthly], ["rentable_area_sf", b.areaSf], ["rent_psf_annual", b.rentPsfAnnual], ["item_occupancy_pct", b.occupancyPct]];
    await as(c, async (tx) => {
      const keys = await tx.query<{ item_key: string }>(`select distinct item_key from assumptions where deal_id = $1 and item_key <> '' and status <> 'rejected' order by item_key`, [c.req.param("id")]);
      const has = keys.find((k) => itemFold(k.item_key) === itemFold(name));
      if (has) throw new HttpError(409, `This deal already has ${has.item_key}; change its values instead.`);
      for (const [fieldKey, value] of values) {
        if (value !== undefined) await tx.query(`select fn_enter_value($1, $2, $3, $4, $5)`, [c.req.param("id"), fieldKey, name, value, b.reason]);
      }
    });
    return c.json({ itemKey: name });
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
  const allDrivers = [...new Map([...DRIVERS, ...SALE_DRIVERS].map((d) => [d.key, d])).values()];
  const shockSchema = z.object(Object.fromEntries(allDrivers.map((d) => [d.key, z.number().finite().min(d.min).max(d.max).optional()]))) as z.ZodType<Shock>;
  const driverKey = z.string().transform((k) => k as DriverKey);
  const metricKey = z.enum(METRICS.map((m) => m.key) as [string, ...string[]]);
  /** A stored run's input, and the policy that run was made under. */
  const runInputAndPolicy = async (c: Context<Env>): Promise<{ input: EngineInput; policy: Policy }> => {
    const [r] = await as(c, (tx) => tx.query<{ input_snapshot: { input: EngineInput; policy?: Policy }; policy_version: string }>(`select input_snapshot, policy_version from runs where id = $1`, [c.req.param("id")]));
    if (!r) throw new HttpError(404, "Run not found");
    const policy = runPolicy(r.input_snapshot, r.policy_version);
    if (!policy) throw new HttpError(409, `This run was made under policy ${r.policy_version}, which this build does not have.`);
    return { input: r.input_snapshot.input, policy };
  };
  app.get("/api/sensitivity/drivers", (c) => c.json(DRIVERS));
  app.get("/api/runs/:id/drivers", async (c) => {
    const { input } = await runInputAndPolicy(c);
    return c.json(driversFor(input));
  });
  app.post("/api/runs/:id/explore", async (c) => {
    const { shock: raw } = z.object({ shock: z.object({}).passthrough() }).parse(await c.req.json());
    const { input, policy } = await runInputAndPolicy(c);
    if (Object.keys(raw).some((key) => !driversFor(input).some((d) => d.key === key))) throw new HttpError(422, "This driver does not apply to this deal.");
    const shock = shockSchema.parse(raw);
    return c.json({ scratch: true, ...explore(input, policy, shock) });
  });
  app.post("/api/runs/:id/tornado", async (c) => {
    const { metric } = z.object({ metric: metricKey }).parse(await c.req.json());
    const { input } = await runInputAndPolicy(c);
    return c.json({ scratch: true, metric, ...tornado(input, metric) });
  });
  app.post("/api/runs/:id/breakeven", async (c) => {
    const { input, policy } = await runInputAndPolicy(c);
    return c.json({ scratch: true, ...breakeven(input, policy) });
  });
  app.post("/api/runs/:id/grid", async (c) => {
    const b = z.object({ metric: metricKey, x: driverKey, y: driverKey, steps: z.number().int().min(3).max(9).default(5) }).parse(await c.req.json());
    if (b.x === b.y) throw new HttpError(422, "Choose two different drivers.");
    const { input } = await runInputAndPolicy(c);
    if (![b.x, b.y].every((key) => driversFor(input).some((d) => d.key === key))) throw new HttpError(422, "This driver does not apply to this deal.");
    return c.json({ scratch: true, metric: b.metric, ...grid(input, b.metric, b.x, b.y, b.steps) });
  });

  app.get("/api/runs/:id/audit-package", async (c) => {
    const pkg = await as(c, (tx) => auditPackage(tx, c.req.param("id")));
    return new Response(JSON.stringify(pkg, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": `attachment; filename="agir-audit-package-run-${pkg.manifest.run.number}.json"` },
    });
  });

  // ---- Artifacts ------------------------------------------------------------------------
  app.post("/api/runs/:id/artifacts", async (c) => {
    const body = z.object({ kind: z.enum(["ic_memo", "lender_package", "build_decision", "partner_memo", "model_export"]), format: z.enum(["pdf", "docx", "xlsx"]), lang: z.enum(["en", "fr"]).default("en") }).parse(await c.req.json());
    if (body.kind === "model_export" && body.lang === "fr") return c.json({ error: "The model export is in English only for now." }, 422);
    if (body.kind === "model_export" && body.format !== "xlsx") return c.json({ error: "The model export is an Excel file." }, 422);
    if (body.kind !== "model_export" && body.format === "xlsx") return c.json({ error: "Memos, lender packages and build decision reports are PDF or Word." }, 422);
    const [r] = await as(c, async (tx) => {
      if (body.kind === "partner_memo") {
        const [run] = await tx.query<{ result: { scenarios: { key: string; metrics: { key: string; status: string }[] }[] }; input_snapshot: { input: EngineInput } }>(
          `select result, input_snapshot from runs where id = $1`, [c.req.param("id")]);
        if (!run) throw new HttpError(404, "Run not found");
        const lp = run.result.scenarios.find((s) => s.key === "base")?.metrics.find((m) => m.key === "lp_irr");
        const heldSplit = run.input_snapshot.input.exit === "refinance_hold" && run.input_snapshot.input.waterfall !== undefined;
        if (!heldSplit && (!lp || lp.status === "NOT_APPLICABLE")) throw new HttpError(422, "This deal has no LP/GP split, so it has no partner memo.");
      }
      return tx.query<{ id: string }>(`select fn_request_artifact($1, $2, $3, $4) as id`, [c.req.param("id"), body.kind, body.format, body.lang]);
    });
    return c.json({ id: r!.id });
  });

  app.get("/api/deals/:id/artifacts", async (c) => {
    const rows = await as(c, (tx) =>
      tx.query(
        `select a.id, a.kind, a.format, a.lang, a.status, a.error, a.sha256, a.created_at, a.run_id, r.run_number,
                (a.provenance->>'entries')::int as provenance_entries
         from artifacts a join runs r on r.id = a.run_id where a.deal_id = $1 order by a.created_at desc`,
        [c.req.param("id")],
      ),
    );
    return c.json(rows);
  });

  app.get("/api/artifacts/:id/file", async (c) => {
    const [a] = await as(c, (tx) =>
      tx.query<{ kind: string; format: string; status: string; storage_key: string | null; run_number: number; deal: string; lang: "en" | "fr" }>(
        `select a.kind, a.format, a.lang, a.status, a.storage_key, r.run_number, d.name as deal from artifacts a join runs r on r.id = a.run_id join deals d on d.id = a.deal_id where a.id = $1`,
        [c.req.param("id")],
      ),
    );
    if (!a || a.status !== "ready" || !a.storage_key) return c.json({ error: "This file is not ready." }, 404);
    return fileResponse(a, c.req.query("inline") === "1");
  });

  app.post("/api/artifacts/:id/share-links", async (c) => {
    const { term } = z.object({ term: z.enum(["24h", "7d", "30d", "none"]) }).parse(await c.req.json());
    const secret = randomBytes(32).toString("base64url");
    const link = await as(c, async (tx) => {
      const [made] = await tx.query<{ id: string }>(`select fn_create_share_link($1, $2, $3) as id`, [c.req.param("id"), term, sha256(secret)]);
      const [row] = await tx.query<{ id: string; expires_at: string | null }>(`select id, expires_at from share_links where id = $1`, [made!.id]);
      return row!;
    });
    return c.json({ id: link.id, url: `/s/${secret}`, expiresAt: link.expires_at });
  });

  app.get("/api/deals/:id/share-links", async (c) => c.json(await as(c, (tx) => tx.query(
    `select l.id, l.artifact_id, a.kind, a.format, r.run_number, l.term, l.expires_at, l.created_at, maker.name as created_by,
      l.revoked_at, revoker.name as revoked_by, count(e.seq)::int as openings, max(e.created_at) as last_opened_at
      from share_links l join artifacts a on a.id = l.artifact_id join runs r on r.id = a.run_id
      left join users maker on maker.id = l.created_by left join users revoker on revoker.id = l.revoked_by
      left join audit_events e on e.entity = 'share_link' and e.entity_id = l.id::text and e.action = 'share.opened'
      where l.deal_id = $1 group by l.id, a.kind, a.format, r.run_number, maker.name, revoker.name order by l.created_at desc`, [c.req.param("id")]))));

  app.post("/api/share-links/:id/revoke", async (c) => {
    await as(c, (tx) => tx.query(`select fn_revoke_share_link($1)`, [c.req.param("id")]));
    return c.json({ ok: true });
  });

  // ---- Client invitations (card 89): the link is shown once; only its hash is stored. ----------------
  app.post("/api/deals/:id/invites", async (c) => {
    const secret = randomBytes(32).toString("base64url");
    const [made] = await as(c, (tx) => tx.query<{ id: string }>(`select fn_create_client_invite($1, $2) as id`, [c.req.param("id"), sha256(secret)]));
    return c.json({ id: made!.id, url: `/i/${secret}` });
  });

  app.get("/api/deals/:id/invites", async (c) => c.json(await as(c, (tx) => tx.query(
    `select i.id, i.created_at, i.expires_at, maker.name as created_by, i.used_at, client.name as used_by, i.revoked_at, revoker.name as revoked_by
      from client_invites i left join users maker on maker.id = i.created_by left join users client on client.id = i.used_by
      left join users revoker on revoker.id = i.revoked_by where i.deal_id = $1 order by i.created_at desc`, [c.req.param("id")]))));

  app.post("/api/invites/:id/revoke", async (c) => {
    await as(c, (tx) => tx.query(`select fn_revoke_client_invite($1)`, [c.req.param("id")]));
    return c.json({ ok: true });
  });

  // A signed-in person joins through an invitation; staff of that workspace are refused (409).
  app.post("/api/invite/:secret/accept", async (c) => {
    const [used] = await db.transaction((tx) =>
      tx.query<{ deal: string | null }>(`select fn_use_client_invite($1, $2) as deal`, [sha256(c.req.param("secret")), c.get("user").id]));
    return used?.deal ? c.json({ ok: true, dealId: used.deal }) : c.json({ error: INVITE_GONE }, 404);
  });

  // ---- Audit ------------------------------------------------------------------------------
  app.get("/api/deals/:id/audit", async (c) => {
    const rows = await as(c, async (tx) =>
      hideClientEvents(await clientViewer(tx, c.req.param("id")), await tx.query<{ entity_id: string | null; payload: unknown }>(
        `select e.seq, e.action, e.entity, e.entity_id, e.payload, e.hash, e.created_at, u.name as actor
         from audit_events e left join users u on u.id = e.actor where e.deal_id = $1 order by e.seq desc limit 500`,
        [c.req.param("id")],
      )),
    );
    return c.json(rows);
  });

  return app;
}

const LOGO_MAX_BYTES = 500 * 1024;
const LOGO_MAX_SIDE = 4096;
const PNG_IEND = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** Reads a request body up to `max` bytes; past that it stops reading and cancels the rest (null). */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * A logo's type from its first bytes (never its name), and its size from the PNG IHDR chunk or the JPEG start-of-frame marker.
 * The file must also end as its format does (the PNG IEND chunk, the JPEG end-of-image marker), so a header alone is refused.
 * This is not a decoder: a whole file with damaged image data still passes.
 */
export function imageInfo(b: Uint8Array): { mime: "image/png" | "image/jpeg"; width: number; height: number } | "unknown" | "unreadable" {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sized = (mime: "image/png" | "image/jpeg", width: number, height: number) => (width > 0 && height > 0 ? { mime, width, height } : "unreadable" as const);
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) {
    if (b.length < 45 || dv.getUint32(8) !== 13 || String.fromCharCode(...b.slice(12, 16)) !== "IHDR") return "unreadable";
    if (!PNG_IEND.every((x, i) => b[b.length - 12 + i] === x)) return "unreadable";
    return sized("image/png", dv.getUint32(16), dv.getUint32(20));
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return "unreadable";
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return "unreadable";
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return "unreadable"; // the image data starts before any frame header
      const length = dv.getUint16(i + 2);
      if (length < 2) return "unreadable";
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return i + 9 <= b.length ? sized("image/jpeg", dv.getUint16(i + 7), dv.getUint16(i + 5)) : "unreadable";
      }
      i += 2 + length;
    }
    return "unreadable";
  }
  return "unknown";
}
