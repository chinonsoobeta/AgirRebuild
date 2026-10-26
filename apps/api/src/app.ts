import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { stream } from "hono/streaming";
import { z } from "zod";
import { FIELD_BY_KEY, outsideWindow, windowMessage, validateThreshold, COUNTRIES, CURRENCIES, FIELDS, FIELD_GROUP_LABELS, METRICS, POLICIES, POLICY_V1, PROVINCE_CODES, REVIEW_MODES, runPolicy, type EngineInput, type Policy } from "@agir/contracts";
import { asUser, type BlobStore, type Db } from "@agir/db";
import { breakeven, DRIVERS, driversFor, SALE_DRIVERS, EngineInputError, explore, grid, tornado, type DriverKey, type Shock } from "@agir/engine";
import { canonicalItem, itemFold, kindOf } from "@agir/extraction";
import { MAX_UPLOAD_BYTES } from "@agir/worker";
import { checkPassword, countSessions, createSession, deviceLabel, endOtherSessions, endSession, hashPassword, listSessions, PASSWORD_RULE, rateLimiter, SESSION_DAYS, userForSession } from "./auth.ts";
import { addressTaken, emailAuth } from "./email-auth.ts";
import type { Mailer } from "./mailer.ts";
import { thresholdsView, auditPackage, clientViewer, createRun, dealOverview, hideClientEvents, HttpError, labelRefusal, regionGroups, reviewView, runView, sha256 } from "./services.ts";

export type AppDeps = { db: Db; store: BlobStore; secureCookies: boolean; demoSignIn?: boolean; trustProxy?: boolean; now?: () => Date;
  /** Sends verification and reset emails. Without one, nothing is sent. */ mailer?: Mailer;
  /** The web app's origin, for links in emails. Configured, never read from a request. */ publicOrigin?: string;
  /** Tests only: awaited after each progress line of a streamed run, so a test can hold a run at a stage. */
  progressHook?: (stage: string) => Promise<void> | void };
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

/** The status and body an error is answered with; shared by the error handler and a streamed run's error line. */
function errorAnswer(err: unknown, path: string): { status: number; body: { error: string; [k: string]: unknown } } {
  if (err instanceof HttpError && err.body && typeof err.body === "object" && "code" in err.body && err.body.code === "outside_window") return { status: 422, body: { error: err.message, ...err.body } };
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message, ...(err.body ? { detail: err.body } : {}) } };
  if (err instanceof EngineInputError) return { status: 422, body: { error: err.message, problems: err.problems } };
  if (err instanceof z.ZodError) return { status: 422, body: { error: "Some fields are missing or not valid.", issues: err.issues } };
  const code = (err as { code?: string }).code;
  if (code && PG_STATUS[code]) return { status: PG_STATUS[code]!, body: { error: code === "22P02" ? "Not found." : (err as Error).message } };
  const shared = path.startsWith("/api/share/") || path.startsWith("/api/invite/");
  console.error(JSON.stringify({ at: new Date().toISOString(), event: "api.error", path: shared ? "/api/share/…" : path, error: shared ? "Shared link request failed" : (err as Error).message }));
  return { status: 500, body: { error: "Something went wrong on our side. It has been logged." } };
}

/** A run token: 32 random bytes the starting browser makes, in base64url (card R1). */
const RUN_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** Thrown by a streamed run's progress check when a stop was asked for; it rolls the run's transaction back. */
class RunStopped extends Error {}

// Keep the existing database functions responsible for saving values and their audit reasons.
function windowReason(fieldKey: string, value: number, reason: string | null | undefined, confirmed?: boolean, requiresReason = true): string | null | undefined {
  const field = FIELD_BY_KEY.get(fieldKey);
  if (!field || !outsideWindow(field, value)) return reason;
  if (!confirmed) throw new HttpError(422, `${windowMessage(field)}. Please check before using this value.`, {code: "outside_window", fieldKey, window: field.window});
  // Preserve the existing requirement for a person's reason; the suffix cannot supply it.
  if (requiresReason && (!reason || reason.trim().length < 10)) throw new HttpError(422, "Say why you are entering a different value (at least 10 characters)");
  return `${reason ?? ""} (confirmed outside the usual range ${field.window!.min}–${field.window!.max})`;
}

export function createApp({ db, store, secureCookies, demoSignIn = false, trustProxy = false, now = () => new Date(),
  mailer = { send: async () => {} }, publicOrigin = "http://127.0.0.1:8787", progressHook }: AppDeps) {
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
  const stopLimit = rateLimiter(60, 60_000);
  // Streamed runs in progress, by run token (card R1). This map lives in this one API process: with several
  // API processes, a stop could reach a process that is not running the run, so the map would need to be in the database.
  const runsInProgress = new Map<string, { userId: string; dealId: string; stopRequested: boolean }>();
  const fileResponse = async (a: { kind: string; format: string; storage_key: string | null; run_number: number; deal: string; lang?: "en" | "fr" }, inline: boolean) => {
    const bytes = await store.get(a.storage_key!);
    const mime = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }[a.format] ?? "application/octet-stream";
    const label = { ic_memo: "IC memo", lender_package: "Lender package", build_decision: "Build decision", partner_memo: "Partner memo", model_export: "Model" }[a.kind] ?? a.kind;
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": mime, "content-disposition": `${inline && a.format === "pdf" ? "inline" : "attachment"}; filename="${encodeURIComponent(`${a.deal} - ${label} - Run ${a.run_number}${a.lang === "fr" ? "-fr" : ""}.${a.format}`)}"` },
    });
  };

  app.onError((err, c) => {
    const { status, body } = errorAnswer(err, c.req.path);
    return c.json(body, status as 400);
  });

  // Shared links and invitations carry a secret in the path: rate-limited, never cached, never sent on as a referrer.
  for (const [prefix, limit] of [["/api/share/*", shareLimit], ["/api/invite/*", inviteLimit], ["/api/runs/stop", stopLimit]] as const) {
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
  const emailFlows = emailAuth({ db, mailer, publicOrigin, cookie: COOKIE, cookieOpts, clientKey });

  app.post("/api/auth/signup", async (c) => {
    if (!authLimit(clientKey(c))) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = z
      .object({ email: z.string().email(), name: z.string().min(1).max(120), password: PASSWORD_RULE, reviewMode: z.enum(REVIEW_MODES).optional(),
        invite: z.string().min(1).max(200).optional() })
      .parse(await c.req.json());
    const email = body.email.toLowerCase();
    // Also refused while another account's undo link holds the address (card R6).
    if (await addressTaken(db, email)) return c.json({ error: "An account with that email already exists." }, 409);
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
      await emailFlows.sendVerification({ id: userId, email });
      setCookie(c, COOKIE, await createSession(db, userId, deviceLabel(c.req.header("user-agent"))), cookieOpts);
      return c.json({ ok: true });
    }
    const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $2, $3) returning id`, [
      email,
      body.name,
      await hashPassword(body.password),
    ]);
    await asUser(db, u!.id, (tx) => createWorkspace(tx, `${body.name.split(" ")[0]}'s workspace`, body.reviewMode));
    await emailFlows.sendVerification({ id: u!.id, email });
    setCookie(c, COOKIE, await createSession(db, u!.id, deviceLabel(c.req.header("user-agent"))), cookieOpts);
    return c.json({ ok: true });
  });

  app.post("/api/auth/login", async (c) => {
    if (!authLimit(clientKey(c))) return c.json({ error: "Too many attempts. Wait a minute." }, 429);
    const body = z.object({ email: z.string(), password: z.string() }).parse(await c.req.json());
    const [u] = await db.query<{ id: string; password_hash: string }>(`select id, password_hash from users where email = $1`, [body.email.toLowerCase()]);
    if (!u || !(await checkPassword(body.password, u.password_hash))) return c.json({ error: "That email and password do not match." }, 401);
    setCookie(c, COOKIE, await createSession(db, u.id, deviceLabel(c.req.header("user-agent"))), cookieOpts);
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
      setCookie(c, COOKIE, await createSession(db, u.id, deviceLabel(c.req.header("user-agent"))), cookieOpts);
      return c.json({ ok: true });
    });
  }

  emailFlows.register(app);

  app.post("/api/auth/logout", async (c) => {
    await endSession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  for (const [suffix, what] of [["", "page"], ["/file", "file"], ["/audit-package", "audit_package"]] as const) {
    app.get(`/api/share/:secret${suffix}`, async (c) => {
      // A file is named by ?artifact=; one that is not a uuid is not one of the link's files.
      const artifact = what === "file" ? c.req.query("artifact") : undefined;
      if (artifact !== undefined && !UUID.test(artifact)) return c.json({ error: SHARE_GONE }, 404);
      const rows = await db.query<SharedFileRow>(`select * from fn_open_share_link($1, $2, $3)`, [sha256(c.req.param("secret")!), what, artifact ?? null]);
      const link = rows[0];
      if (!link) return c.json({ error: SHARE_GONE }, 404);
      if (what === "page") return c.json(await sharedPage(db, rows));
      if (what === "file") return fileResponse({ ...link, deal: link.deal_name }, c.req.query("inline") === "1");
      const pkg = await asUser(db, link.created_by, (tx) => auditPackage(tx, link.run_id));
      return new Response(JSON.stringify(pkg, null, 2), {
        headers: { "content-type": "application/json", "content-disposition": `attachment; filename="agir-audit-package-run-${pkg.manifest.run.number}.json"` },
      });
    });
  }

  app.get("/api/invite/:secret", async (c) => {
    const [live] = await db.query<{ workspace: string; deal: string; expires_at: string }>(`select * from fn_peek_client_invite($1)`, [sha256(c.req.param("secret"))]);
    return live ? c.json({ workspace: live.workspace, deal: live.deal, expiresAt: live.expires_at }) : c.json({ error: INVITE_GONE }, 404);
  });

  // Stopping a streamed run (card R1). The run token is the authority: only the browser that started the run holds it.
  // No session check and no database: in local development the run's open transaction would make either wait until the run ends.
  app.post("/api/runs/stop", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const token = body && typeof body === "object" && "token" in body && typeof body.token === "string" ? body.token : "";
    const run = runsInProgress.get(token);
    if (!run) return c.json({ error: "This run is not in progress. It may have finished." }, 404);
    run.stopRequested = true;
    return c.json({ stopping: true });
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

  /**
   * Card R1e: the email to a person who left a streamed run's page before it ended, once the run is recorded. It names the
   * deal and the run's number and links to the run; it carries no figure. A failure to send is logged without detail and
   * never undoes the run.
   */
  const mailRunDone = async (c: Context<Env>, dealId: string, runId: string) => {
    try {
      const [r] = await as(c, (tx) => tx.query<{ run_number: number; name: string }>(
        `select r.run_number, d.name from runs r join deals d on d.id = r.deal_id where r.id = $1`, [runId]));
      if (!r) return;
      const deal = r.name.replace(/\s+/g, " ").trim();
      const link = `${publicOrigin.replace(/\/+$/, "")}/deals/${dealId}/run?run=${runId}`;
      await mailer.send({
        to: c.get("user").email,
        subject: `Run ${r.run_number} of ${deal} is done / L’analyse ${r.run_number} de ${deal} est terminée`,
        text: [
          `Run ${r.run_number} of ${deal} is done. To see it, open this link:`,
          link,
          "You are getting this email because you started the run and left its page before it finished.",
          "",
          `L’analyse ${r.run_number} de ${deal} est terminée. Pour la voir, ouvrez ce lien\u00a0:`,
          link,
          "Vous recevez ce courriel parce que vous avez lancé l’analyse et quitté sa page avant la fin.",
        ].join("\n"),
      });
    } catch {
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "mail.failed", kind: "run_done" }));
    }
  };

  app.get("/api/me", async (c) => {
    const workspaces = await as(c, (tx) =>
      tx.query(
        `select w.id, w.name, w.review_mode, w.label_suggestions, w.ai_reading, w.logo_key is not null as has_logo, m.role from workspaces w join workspace_members m on m.workspace_id = w.id and m.user_id = agir_uid() order by w.created_at`,
      ),
    );
    const [v] = await db.query<{ verified: boolean }>(`select email_verified_at is not null as verified from users where id = $1`, [c.get("user").id]);
    return c.json({ user: { ...c.get("user"), email_verified: v?.verified ?? false }, workspaces });
  });

  app.post("/api/me/name", async (c) => {
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_my_name($1)`, [name]));
    return c.json({ ok: true });
  });

  // Sessions are read and ended with the service principal, as sign-out does; the session middleware checked this one.
  app.get("/api/me/sessions", async (c) => {
    const id = c.get("user").id;
    return c.json({ count: await countSessions(db, id), devices: await listSessions(db, id, getCookie(c, COOKIE)) });
  });

  app.post("/api/me/sessions/end-others", async (c) => {
    const ended = await endOtherSessions(db, c.get("user").id, getCookie(c, COOKIE)!);
    return c.json({ ended });
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

  // Card C: the owner may stop Agir sending deal text to the model for this workspace.
  app.put("/api/workspaces/:ws/ai-reading", async (c) => {
    const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_ai_reading($1, $2)`, [c.req.param("ws"), on]));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:ws/review-grant", async (c) => {
    const body = z.object({ email: z.string().email(), days: z.number().int().min(1).max(90) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_grant_review($1, $2, $3)`, [c.req.param("ws"), body.email, body.days]));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:ws/name", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const { name } = z.object({ name: z.string().min(1).max(120) }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_rename_workspace($1, $2)`, [ws, name]));
    return c.json({ ok: true });
  });

  app.post("/api/workspaces/:ws/review-grant/:userId/end", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const userId = z.string().uuid().parse(c.req.param("userId"));
    await as(c, (tx) => tx.query(`select fn_end_review($1, $2)`, [ws, userId]));
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

  app.delete("/api/workspaces/:ws/members/:userId", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const userId = z.string().uuid().parse(c.req.param("userId"));
    await as(c, (tx) => tx.query(`select fn_remove_member($1, $2)`, [ws, userId]));
    return c.json({ ok: true });
  });

  app.get("/api/workspaces/:ws/audit/verify", async (c) => {
    const [r] = await as(c, (tx) => tx.query(`select * from fn_verify_audit_chain()`));
    return c.json(r);
  });

  // ---- Production counts (card 155): counts and durations per deal, never content; the owner only. ----------
  app.get("/api/workspaces/:ws/deal-metrics", async (c) => {
    const ws = z.string().uuid().parse(c.req.param("ws"));
    const { deals, archived, runCounts } = await as(c, async (tx) => {
      const [m] = await tx.query<{ role: string }>(`select role from workspace_members where workspace_id = $1 and user_id = agir_uid()`, [ws]);
      if (m?.role !== "owner") throw new HttpError(403, "Only the workspace owner can see production counts.");
      const deals = await tx.query<Record<string, unknown>>(`select m.*, d.name from deal_metrics m join deals d on d.id = m.deal_id where m.workspace_id = $1 order by d.created_at`, [ws]);
      const [a] = await tx.query<{ n: number }>(`select count(*)::int as n from deals where workspace_id = $1 and archived_at is not null`, [ws]);
      // Card R4, for the deals that are not archived: every run and when the first one was made; the ready files of
      // each deal's latest run (the deals list's rule); and how many of those files have been shared by a link,
      // revoked or not, counting each file once however many links share it (card R2's share_link_files). That counts
      // files shared, not how often a link was opened.
      const [r] = await tx.query<{ n: number; first: string | Date | null }>(
        `select count(*)::int as n, min(r.created_at) as first from runs r join deals d on d.id = r.deal_id where d.workspace_id = $1 and d.archived_at is null`,
        [ws],
      );
      const [f] = await tx.query<{ n: number; shared: number }>(
        `select count(*)::int as n, count(*) filter (where exists (select 1 from share_link_files l where l.artifact_id = a.id))::int as shared
         from latest_runs lr join deals d on d.id = lr.deal_id join artifacts a on a.run_id = lr.id and a.status = 'ready'
         where d.workspace_id = $1 and d.archived_at is null`,
        [ws],
      );
      const runCounts = { runs: r?.n ?? 0, first_run_at: r?.first ? new Date(r.first).toISOString() : null, reports: f?.n ?? 0, reports_shared: f?.shared ?? 0 };
      return { deals, archived: a?.n ?? 0, runCounts };
    });
    const summed = ["docs_pdf", "docs_xlsx", "docs_csv", "docs_docx", "docs_txt", "docs_deal_source", "docs_evidence", "docs_context", "docs_no_candidates", "figures_read", "figures_confirmed_from_suggestion", "figures_typed", "actions_until_runnable"];
    const totals: Record<string, number | string | null> = { deals: deals.length, archived_deals: archived };
    for (const k of summed) totals[k] = deals.reduce((n, d) => n + Number(d[k] ?? 0), 0);
    return c.json({ deals, totals: { ...totals, ...runCounts } });
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
      // A confirmation stands until its value changes (0018's trigger clears it), so these count only the ones that still stand.
      return tx.query(`select u.id, u.name, u.email, dc.created_at as assigned_at,
          (select count(*)::int from assumptions a where a.deal_id = dc.deal_id and a.client_confirmed_by = dc.user_id) as confirmed,
          (select max(a.client_confirmed_at) from assumptions a where a.deal_id = dc.deal_id and a.client_confirmed_by = dc.user_id) as last_confirmed_at
        from deal_clients dc join users u on u.id = dc.user_id
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
        `select d.id, d.name, d.kind, d.role_set, d.read_role, d.size_bytes, d.stage, d.stage_detail, d.page_count, d.number_format, d.needs_ocr, d.candidate_count,
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
    const role = z.enum(["deal_source", "evidence", "context"]).nullable().parse(c.req.query("role") ?? null);
    const name = (c.req.query("name") ?? "").trim();
    const kind = kindOf(name);
    if (!name || !kind) return c.json({ error: "Upload a PDF, Excel (.xlsx), CSV, Word (.docx) or text file." }, 415);
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_UPLOAD_BYTES) return c.json({ error: "The file is larger than 75 MB." }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: "The file is empty." }, 422);
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return c.json({ error: "The file is larger than 75 MB." }, 413);
    const put = await store.put(bytes);
    const r = await as(c, async (tx) => {
      const [registered] = await tx.query<{ document_id: string; duplicate: boolean }>(`select * from fn_register_document($1, $2, $3, $4, $5, $6)`, [
        c.req.param("id"),
        name.slice(0, 200),
        kind,
        bytes.byteLength,
        put.sha256,
        put.key,
      ]);
      if (!registered!.duplicate && role !== null) await tx.query(`select fn_set_document_role($1, $2)`, [registered!.document_id, role]);
      return registered!;
    });
    return c.json({ id: r.document_id, duplicate: r.duplicate });
  });

  app.post("/api/documents/:id/role", async (c) => {
    const { role } = z.object({ role: z.enum(["deal_source", "evidence", "context"]).nullable() }).parse(await c.req.json());
    await as(c, (tx) => tx.query(`select fn_set_document_role($1, $2)`, [c.req.param("id"), role]));
    return c.json({ ok: true });
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
      const { why, phrase, unit } = await labelRefusal(tx, b.documentId, { id: b.figureId, fieldKey: b.fieldKey, itemKey: b.itemKey });
      if (why) throw new HttpError(422, why);
      await tx.query(`select fn_label_figure($1, $2, $3, $4, $5, $6)`, [b.documentId, b.figureId, b.fieldKey, b.itemKey ?? "", phrase, unit]);
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

  app.post("/api/deals/:id/regions/confirm", async (c) => {
    const body = z.object({ documentId: z.string().uuid(), source: z.enum(["table", "sheet", "text table"]), table: z.string().min(1).max(1000) }).parse(await c.req.json());
    return c.json(await as(c, async (tx) => {
      // Serialize region confirmations for this deal; fn_review locks each row and checks its version.
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [c.req.param("id")]);
      const rows = await tx.query<{ id: string; version: number }>(`select id, version from assumptions where deal_id = $1 order by id`, [c.req.param("id")]);
      const group = (await regionGroups(tx, c.req.param("id"))).find(g => g.documentId === body.documentId && g.source === body.source && g.table === body.table);
      if (!group) throw new HttpError(409, "This table no longer has two values to confirm. Reload and try again.");
      let approved = 0, awaitingSecond = 0;
      for (const id of group.ids) {
        const [result] = await tx.query<{ status: string }>(`select (a).status from (select fn_review($1, 'approve', null, $2, $3) a) x`, [id, `Confirmed with the table ${group.table} in ${group.documentName}`, rows.find(a => a.id === id)!.version]);
        if (result!.status === "approved") approved++;
        else if (result!.status === "awaiting_second_approval") awaitingSecond++;
      }
      return { approved, awaitingSecond, leftOut: group.leftOut };
    }));
  });

  app.post("/api/assumptions/:id/review", async (c) => {
    const body = z
      .object({
        confirmOutsideWindow: z.boolean().optional(),
        action: z.enum(["approve", "resolve", "modify", "second_approve", "use_as_stated", "reject", "reopen"]),
        value: z.number().finite().nullable().optional(),
        reason: z.string().max(2000).nullable().optional(),
        version: z.number().int().nullable().optional(),
      })
      .parse(await c.req.json());
    const [r] = await as(c, async (tx) => {
      let reason = body.reason;
      if ((body.action === "modify" || body.action === "resolve") && body.value != null) {
        const [a] = await tx.query<{field_key: string}>(`select field_key from assumptions where id=$1`, [c.req.param("id")]);
        if (!a) throw new HttpError(404, "Assumption not found");
        reason = windowReason(a.field_key, body.value, reason, body.confirmOutsideWindow, body.action === "modify");
      }
      return tx.query(`select (a).status, (a).version from (select fn_review($1, $2, $3, $4, $5) a) x`, [
        c.req.param("id"), body.action, body.value ?? null, reason ?? null, body.version ?? null,
      ]);
    });
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
      const fields=body.fieldKey === "land_transfer_tax" ? ["land_cost"] : body.fieldKey === "refinance_insurance_premium_pct" ? ["refinance_ltv_pct","refinance_amort_years",...(view.assumptions.some(a=>a.fieldKey === "refinance_mli_select_points" && a.status === "approved") ? ["refinance_mli_select_points"] : [])] : body.fieldKey === "refinance_premium_tax_pct" ? [] : ["unit_count"];
      const source=JSON.stringify({tableId:proposal.tableId,optionKey:option.key,publisher:proposal.publisher,title:proposal.title,effective:proposal.effective,recheckBy:proposal.recheckBy,readOn:proposal.readOn,signedOn:proposal.signedOn,fields});
      const [row]=await tx.query(`select (a).status from (select fn_enter_table_value($1,$2,null,$3,$4,$5) a) x`,[c.req.param("id"),body.fieldKey,option.value,option.reason,source]);
      return row;
    });
    return c.json(result);
  });

  app.post("/api/deals/:id/values", async (c) => {
    const body = z
      .object({ confirmOutsideWindow: z.boolean().optional(), fieldKey: z.string(), itemKey: z.string().max(60).nullable().optional(), value: z.number().finite(), reason: z.string().max(2000) })
      .parse(await c.req.json());
    const [r] = await as(c, (tx) =>
      tx.query(`select (a).status from (select fn_enter_value($1, $2, $3, $4, $5) a) x`, [c.req.param("id"), body.fieldKey, body.itemKey ?? null, body.value, windowReason(body.fieldKey, body.value, body.reason, body.confirmOutsideWindow)]),
    );
    return c.json(r);
  });

  // A unit type or space no document states: every stated value goes through fn_enter_value in one transaction, so it is added whole or not at all.
  app.post("/api/deals/:id/items", async (c) => {
    const num = z.number().finite().optional();
    const b = z
      .object({
        name: z.string().trim().min(1, "Name the unit type or space").max(60).refine((n) => !n.includes("|"), "A name cannot contain \"|\""),
        confirmOutsideWindow: z.boolean().optional(),
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
    const reasons = new Map(values.filter((entry): entry is [string, number] => entry[1] !== undefined).map(([key, value]) => [key, windowReason(key, value, b.reason, b.confirmOutsideWindow)]));
    await as(c, async (tx) => {
      const keys = await tx.query<{ item_key: string }>(`select distinct item_key from assumptions where deal_id = $1 and item_key <> '' and status <> 'rejected' order by item_key`, [c.req.param("id")]);
      const has = keys.find((k) => itemFold(k.item_key) === itemFold(name));
      if (has) throw new HttpError(409, `This deal already has ${has.item_key}; change its values instead.`);
      for (const [fieldKey, value] of values) {
        if (value !== undefined) await tx.query(`select fn_enter_value($1, $2, $3, $4, $5)`, [c.req.param("id"), fieldKey, name, value, reasons.get(fieldKey)]);
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
    if (c.req.query("progress") !== "1") {
      const id = await as(c, (tx) => createRun(tx, c.req.param("id"), now().toISOString().slice(0,10)));
      return c.json({ id });
    }
    // With progress=1 (card R1): the same run, answered as one JSON line a stage, then done, stopped or error.
    const dealId = c.req.param("id"), asOf = now().toISOString().slice(0,10);
    const token = c.req.header("x-run-token") ?? "";
    if (!RUN_TOKEN.test(token)) return c.json({ error: "This run needs a valid run token." }, 422);
    if (runsInProgress.has(token)) return c.json({ error: "A run with this token is already in progress." }, 409);
    const run = { userId: c.get("user").id, dealId, stopRequested: false };
    runsInProgress.set(token, run);
    c.header("content-type", "application/x-ndjson");
    c.header("cache-control", "no-store");
    return stream(c, async (s) => {
      // Not awaited, and never thrown: a browser that stops reading or goes away neither holds up nor fails the run.
      const send = (line: object) => { try { void s.write(`${JSON.stringify(line)}\n`).catch(() => {}); } catch { /* the browser has gone */ } };
      try {
        const id = await as(c, (tx) => createRun(tx, dealId, asOf, {
          stage: async (key, at, facts) => { send({ stage: key, at: at.toISOString(), ...(facts ? { facts } : {}) }); await progressHook?.(key); },
          check: () => { if (run.stopRequested) throw new RunStopped(); },
        }));
        // The browser went away before the end (card R1e): the person who started the run hears that it is done by email.
        if (s.aborted) await mailRunDone(c, dealId, id);
        send({ stage: "record", at: new Date().toISOString() });
        await progressHook?.("record");
        send({ done: { id } });
      } catch (err) {
        if (err instanceof RunStopped) send({ stopped: true });
        else {
          const { status, body: { error, ...rest } } = errorAnswer(err, c.req.path);
          send({ error: { status, message: error, ...rest } });
        }
      } finally {
        runsInProgress.delete(token);
      }
    });
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

  // A run's files shared together (card R2). The secret is shown once and never stored.
  app.post("/api/runs/:id/share-links", async (c) => {
    const { term, artifacts } = z.object({ term: z.enum(["24h", "7d", "30d", "none"]), artifacts: z.array(z.string().uuid()).min(1).max(20) }).parse(await c.req.json());
    const secret = randomBytes(32).toString("base64url");
    const link = await as(c, async (tx) => {
      const [made] = await tx.query<{ id: string }>(`select fn_create_run_share_link($1, $2::uuid[], $3, $4) as id`, [c.req.param("id"), artifacts, term, sha256(secret)]);
      const [row] = await tx.query<{ id: string; expires_at: string | null }>(`select id, expires_at from share_links where id = $1`, [made!.id]);
      return row!;
    });
    return c.json({ id: link.id, url: `/s/${secret}`, expiresAt: link.expires_at });
  });

  // `kind` and `format` are the first file's, in the shared page's order; `files` lists them all.
  app.get("/api/deals/:id/share-links", async (c) => c.json(await as(c, (tx) => tx.query(
    `select l.id, l.artifact_id, l.run_id, x.files->0->>'kind' as kind, x.files->0->>'format' as format, r.run_number, x.files,
      l.term, l.expires_at, l.created_at, maker.name as created_by, l.revoked_at, revoker.name as revoked_by, o.openings, o.last_opened_at
      from share_links l join runs r on r.id = l.run_id
      left join users maker on maker.id = l.created_by left join users revoker on revoker.id = l.revoked_by
      cross join lateral (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'format', a.format, 'lang', a.lang) order by ${FILE_ORDER_SQL}), '[]'::jsonb) as files
        from share_link_files f join artifacts a on a.id = f.artifact_id where f.link_id = l.id) x
      cross join lateral (select count(e.seq)::int as openings, max(e.created_at) as last_opened_at from audit_events e
        where e.entity = 'share_link' and e.entity_id = l.id::text and e.action = 'share.opened') o
      where l.deal_id = $1 order by l.created_at desc`, [c.req.param("id")]))));

  // What the person given an active link sees, for the deal's staff (card R2). Built by the page's own code;
  // it writes no share.opened event, so it is not counted. A client cannot read share_links, so gets a 404.
  app.get("/api/share-links/:id/preview", async (c) => {
    const body = await as(c, async (tx) => {
      const rows = await tx.query<SharedFileRow>(
        `select l.id as link_id, l.run_id, l.created_by, r.run_number, d.name as deal_name, l.expires_at,
           a.id as artifact_id, a.kind, a.format, a.lang, a.storage_key, (a.provenance->>'entries')::int as provenance_entries
         from share_links l join runs r on r.id = l.run_id join deals d on d.id = l.deal_id
           join share_link_files f on f.link_id = l.id join artifacts a on a.id = f.artifact_id
         where l.id = $1 and l.revoked_at is null and (l.expires_at is null or l.expires_at > now())
           and exists (select 1 from workspace_members m where m.workspace_id = l.workspace_id and m.user_id = l.created_by
             and (m.expires_at is null or m.expires_at > now()))
           and not exists (select 1 from share_link_files g join artifacts b on b.id = g.artifact_id where g.link_id = l.id and b.status <> 'ready')`,
        [c.req.param("id")]);
      return rows.length ? sharedPage(tx, rows) : null;
    });
    return body ? c.json(body) : c.json({ error: "This link is not active, so there is nothing to preview." }, 404);
  });

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

  // Card R5: a link is shown once, so sending it again means a new one. In one transaction the old invitation is
  // withdrawn (refused with 422 if it was used or withdrawn already) and a new one is made for the same deal.
  app.post("/api/invites/:id/replace", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    const secret = randomBytes(32).toString("base64url");
    const made = await as(c, async (tx) => {
      // RLS shows the row only to the workspace's owners and admins; everyone else gets the same 404.
      const [old] = id.success ? await tx.query<{ deal_id: string }>(`select deal_id from client_invites where id = $1`, [id.data]) : [];
      if (!old) throw new HttpError(404, "This invitation is not there any more.");
      await tx.query(`select fn_revoke_client_invite($1)`, [id.data]);
      const [row] = await tx.query<{ id: string }>(`select fn_create_client_invite($1, $2) as id`, [old.deal_id, sha256(secret)]);
      return row!;
    });
    return c.json({ id: made.id, url: `/i/${secret}` });
  });

  // A signed-in person joins through an invitation; staff of that workspace are refused (409).
  app.post("/api/invite/:secret/accept", async (c) => {
    const [used] = await db.transaction((tx) =>
      tx.query<{ deal: string | null }>(`select fn_use_client_invite($1, $2) as deal`, [sha256(c.req.param("secret")), c.get("user").id]));
    return used?.deal ? c.json({ ok: true, dealId: used.deal }) : c.json({ error: INVITE_GONE }, 404);
  });

  // ---- Audit ------------------------------------------------------------------------------
  // The newest 500 events; ?before=<seq> reads the 500 before that one. An empty array means there is nothing older.
  app.get("/api/deals/:id/audit", async (c) => {
    const { before } = z.object({ before: z.string().regex(/^[1-9][0-9]{0,14}$/).transform(Number).optional() }).parse(c.req.query());
    const rows = await as(c, async (tx) =>
      hideClientEvents(await clientViewer(tx, c.req.param("id")), await tx.query<{ entity_id: string | null; payload: unknown }>(
        `select e.seq, e.action, e.entity, e.entity_id, e.payload, e.hash, e.created_at, u.name as actor
         from audit_events e left join users u on u.id = e.actor where e.deal_id = $1 and ($2::bigint is null or e.seq < $2::bigint)
         order by e.seq desc limit 500`,
        [c.req.param("id"), before ?? null],
      )),
    );
    return c.json(rows);
  });

  return app;
}

// The base-case figures a share page shows, in this order (card Y2).
// A sold run has no rental measures; its profit figures are its own (forsale.ts), so both sets are listed.
const SHARED_FIGURES = ["total_development_cost", "cost_per_unit", "required_equity", "loan_to_cost", "dcr_after_refinance", "sizing_dscr",
  "development_spread", "yield_on_cost", "profit_on_cost", "profit_on_cost_for_sale", "margin_on_revenue"] as const;

/**
 * What a share page adds about its run, read from what the run stored and never recomputed: everything here is
 * already printed in the shared file. Units are counted from the stored input, as the report counts them.
 */
function sharedRunFacts(run: { result: import("@agir/contracts").RunResult; input_snapshot: { input: EngineInput; policy?: Policy; standardPolicy?: Policy };
  policy_version: string; created_at: string; location: string; province: string | null; currency: string | null; workspace: string }) {
  const { input } = run.input_snapshot;
  const { code, gates, hardFailReasons, headline, explanation } = run.result.verdict;
  const metrics = run.result.scenarios[0]?.metrics ?? [];
  const items: readonly { units: number }[] = input.forSale ? input.forSale.units : input.revenue;
  return {
    workspace: run.workspace,
    location: run.location,
    province: run.province,
    currency: run.currency,
    runAt: run.created_at,
    units: items.reduce((n, item) => n + item.units, 0),
    exit: input.exit ?? "sale",
    policyDraft: runPolicy(run.input_snapshot, run.policy_version)?.draft === true,
    verdict: { code, gates, hardFailReasons, headline, explanation },
    errorChecks: run.result.checks.filter((check) => check.severity === "error").length,
    figures: SHARED_FIGURES.flatMap((key) => metrics.filter((m) => m.key === key).map((m) => ({ key: m.key, unit: m.unit, value: m.value, status: m.status, reason: m.reason }))),
    ...(input.forSale ? {} : { exitCapPct: input.exitCapPct }),
  };
}

const SHARE_GONE = "This link is not available. It may have expired or been revoked.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One file of a shared link, as fn_open_share_link and the preview read it. */
type SharedFileRow = { link_id: string; run_id: string; created_by: string; run_number: number; deal_name: string; expires_at: string | null;
  artifact_id: string; kind: string; format: string; lang: "en" | "fr"; storage_key: string | null; provenance_entries: number | null };
/** The order a link's files are listed in: by report, then PDF before Word, then English before French. */
const FILE_KINDS = ["build_decision", "lender_package", "partner_memo", "ic_memo", "model_export"];
const FILE_FORMATS = ["pdf", "docx", "xlsx"];
const FILE_ORDER_SQL = `array_position(array['${FILE_KINDS.join("','")}'], a.kind), array_position(array['${FILE_FORMATS.join("','")}'], a.format), a.lang = 'fr', a.id`;
const fileOrder = (a: SharedFileRow, b: SharedFileRow) =>
  FILE_KINDS.indexOf(a.kind) - FILE_KINDS.indexOf(b.kind) || FILE_FORMATS.indexOf(a.format) - FILE_FORMATS.indexOf(b.format)
  || Number(a.lang === "fr") - Number(b.lang === "fr") || (a.artifact_id < b.artifact_id ? -1 : a.artifact_id > b.artifact_id ? 1 : 0);

/**
 * The body of a shared link's page, for the public page and the preview alike (card R2), so the two cannot differ.
 * `kind` and `format` are the first file's, as a one-file link always had them.
 */
async function sharedPage(q: Db, rows: SharedFileRow[]) {
  const files = [...rows].sort(fileOrder);
  const link = files[0]!;
  const [run] = await q.query<{ result: import("@agir/contracts").RunResult; input_snapshot: { input: EngineInput; policy?: Policy; standardPolicy?: Policy; policyChanges?: import("@agir/contracts").PolicyChange[] };
    policy_version: string; created_at: string; location: string; province: string | null; currency: string | null; workspace: string }>(
    `select r.result, r.input_snapshot, r.policy_version, r.created_at, d.location, d.province, d.currency, w.name as workspace
     from runs r join deals d on d.id = r.deal_id join workspaces w on w.id = d.workspace_id where r.id = $1`, [link.run_id]);
  let standardFailures: { en: string[]; fr: string[] } | undefined;
  if (run?.input_snapshot.policy?.custom) {
    const { Formatter, customThresholdBlocks } = await import("@agir/artifacts");
    const x = { ...run.input_snapshot, policy: run.input_snapshot.policy, result: run.result };
    const failures = (lang: "en" | "fr") => customThresholdBlocks(new Formatter(run.result,lang,x.policy.maxLtcPct),x).flatMap((block) => block.type === "checks" ? block.items.filter((item) => item.lenderCited).map((item) => item.text) : []);
    standardFailures = { en: failures("en"), fr: failures("fr") };
  }
  return { deal: link.deal_name, kind: link.kind, format: link.format, runNumber: link.run_number, expiresAt: link.expires_at,
    files: files.map((f) => ({ id: f.artifact_id, kind: f.kind, format: f.format, lang: f.lang, traced: f.provenance_entries ?? null })),
    ...(run ? sharedRunFacts(run) : {}), ...(standardFailures ? { standardFailures } : {}) };
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
