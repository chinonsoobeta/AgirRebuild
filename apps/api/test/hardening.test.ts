import { beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp, type AppDeps } from "../src/app.ts";
import { alerter, log, type LogFields } from "../src/log.ts";
import { memoryMailer, unsentMailer } from "../src/mailer.ts";

// Card B: the scoped chain check, invite-only sign-up, structured logs and alerts, honest mail answers.
let db: Db;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

type Session = { cookie: string };
type App = ReturnType<typeof createApp>;
async function call(app: App, s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function signup(app: App, email: string, extra: Record<string, unknown> = {}) {
  const r = await call(app, null, "POST", "/api/auth/signup", { email, name: "Pat Person", password: "correct horse battery", ...extra });
  return { ...r, session: r.status === 200 ? { cookie: r.headers.get("set-cookie")!.split(";")[0]! } : null };
}
/** An app whose log lines and alerts are kept, so a test can read them. */
function recording(deps: Partial<AppDeps> = {}) {
  const lines: ({ event: string } & LogFields)[] = [];
  const alerts: ({ event: string } & LogFields)[] = [];
  const app = createApp({ db, store, secureCookies: false, log: (event, fields = {}) => lines.push({ event, ...fields }),
    alert: (event, fields = {}) => alerts.push({ event, ...fields }), ...deps });
  return { app, lines, alerts };
}
const wsOf = async (app: App, s: Session) => (await call(app, s, "GET", "/api/me")).json.workspaces[0].id as string;
const eventsOf = async (ws: string) => (await db.query<{ n: number }>(`select count(*)::int as n from audit_events where workspace_id = $1`, [ws]))[0]!.n;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
});

describe("the chain check is scoped to the caller's workspace", () => {
  let app: App, ann: Session, ben: Session, wsAnn: string, wsBen: string;
  beforeAll(async () => {
    app = createApp({ db, store, secureCookies: false });
    ann = (await signup(app, "ann-chain@example.com")).session!;
    ben = (await signup(app, "ben-chain@example.com")).session!;
    wsAnn = await wsOf(app, ann);
    wsBen = await wsOf(app, ben);
    // Two workspaces with different numbers of events.
    for (const name of ["One", "Two", "Three"]) {
      expect((await call(app, ann, "POST", `/api/workspaces/${wsAnn}/deals`, { name, assetType: "Multifamily", province: "BC" })).status).toBe(200);
    }
  });

  test("a member gets ok and the count of this workspace's events only", async () => {
    const all = (await db.query<{ n: number }>(`select count(*)::int as n from audit_events`))[0]!.n;
    const a = await call(app, ann, "GET", `/api/workspaces/${wsAnn}/audit/verify`);
    expect(a.status).toBe(200);
    expect(a.json).toEqual({ ok: true, events: await eventsOf(wsAnn), broken: false });
    const b = await call(app, ben, "GET", `/api/workspaces/${wsBen}/audit/verify`);
    expect(b.json).toEqual({ ok: true, events: await eventsOf(wsBen), broken: false });
    expect(a.json.events).not.toBe(b.json.events);
    expect(a.json.events).toBeLessThan(all);
  });

  test("a signed-in non-member gets 403 and learns nothing; a missing workspace answers the same", async () => {
    const r = await call(app, ben, "GET", `/api/workspaces/${wsAnn}/audit/verify`);
    expect(r.status).toBe(403);
    expect(Object.keys(r.json)).toEqual(["error"]);
    const missing = await call(app, ben, "GET", `/api/workspaces/00000000-0000-4000-8000-000000000000/audit/verify`);
    expect(missing).toMatchObject({ status: 403, json: r.json });
    expect((await call(app, ben, "GET", `/api/workspaces/not-a-uuid/audit/verify`)).status).toBe(422);
    expect((await call(app, null, "GET", `/api/workspaces/${wsAnn}/audit/verify`)).status).toBe(401);
  });

  test("a broken row is reported as this workspace's or not, never by its seq", async () => {
    // Break the chain at one of Ann's events, in a copy of the database's state: a transaction that is rolled back.
    await db.transaction(async (tx) => {
      await tx.query(`alter table audit_events disable trigger audit_events_append_only`);
      await tx.query(`update audit_events set payload = '{"tampered": true}' where seq = (select max(seq) from audit_events where workspace_id = $1)`, [wsAnn]);
      const idOf = async (email: string) => (await tx.query<{ id: string }>(`select id from users where email = $1`, [email]))[0]!.id;
      const check = async (email: string, ws: string) => {
        await tx.query(`select set_config('agir.user_id', $1, true)`, [await idOf(email)]);
        return (await tx.query(`select * from fn_verify_audit_chain_for($1)`, [ws]))[0];
      };
      const seenByAnn = await check("ann-chain@example.com", wsAnn);
      const seenByBen = await check("ben-chain@example.com", wsBen);
      expect(seenByAnn).toMatchObject({ ok: false, broken: true });
      expect(seenByBen).toMatchObject({ ok: false, broken: false });
      throw new Error("roll back");
    }).catch((e: Error) => { if (e.message !== "roll back") throw e; });
  });
});

describe("invite-only sign-up", () => {
  let open: App, invite: App, owner: Session, deal: string;
  beforeAll(async () => {
    open = createApp({ db, store, secureCookies: false });
    invite = createApp({ db, store, secureCookies: false, signup: "invite" });
    owner = (await signup(open, "owner-invite@example.com")).session!;
    const ws = await wsOf(open, owner);
    deal = (await call(open, owner, "POST", `/api/workspaces/${ws}/deals`, { name: "Cedar Court", assetType: "Multifamily", province: "BC" })).json.id;
  });

  test("GET /api/auth/signup says whether sign-up is open, signed out", async () => {
    expect(await call(open, null, "GET", "/api/auth/signup")).toMatchObject({ status: 200, json: { open: true } });
    expect(await call(invite, null, "GET", "/api/auth/signup")).toMatchObject({ status: 200, json: { open: false } });
  });

  test("without an invitation, sign-up is refused 403 with the pilot sentence, and no account is made", async () => {
    const r = await signup(invite, "stranger@example.com");
    expect(r.status).toBe(403);
    expect(r.json).toEqual({ error: "Agir is by invitation during the pilot." });
    expect(await db.query(`select 1 from users where email = 'stranger@example.com'`)).toHaveLength(0);
  });

  test("through a client invitation, sign-up still works", async () => {
    const made = await call(open, owner, "POST", `/api/deals/${deal}/invites`);
    expect(made.status).toBe(200);
    const secret = (made.json.url as string).slice(3);
    const r = await signup(invite, "client-invite@example.com", { invite: secret });
    expect(r.status).toBe(200);
    // A client of the deal, with no workspace of its own.
    const me = await call(invite, r.session, "GET", "/api/me");
    expect(me.json.workspaces.map((w: { role: string }) => w.role)).toEqual(["client"]);
  });

  test("open sign-up is unchanged", async () => {
    expect((await signup(open, "anyone-open@example.com")).status).toBe(200);
  });
});

describe("structured logs", () => {
  test("log writes one JSON line with at, event and the fields", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      log("job.done", { id: "j1", ms: 12, ok: true, user: null });
      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0]![0]);
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trim().split("\n")).toHaveLength(1);
      const parsed = JSON.parse(line);
      expect(parsed).toMatchObject({ event: "job.done", id: "j1", ms: 12, ok: true, user: null });
      expect(new Date(parsed.at).toISOString()).toBe(parsed.at);
    } finally {
      write.mockRestore();
    }
  });

  test("each request is logged by its route pattern, with status, duration, an id and the user; no query, body or email", async () => {
    const { app, lines } = recording();
    const s = (await signup(app, "logged-person@example.com")).session!;
    const ws = await wsOf(app, s);
    lines.length = 0;
    await call(app, s, "GET", `/api/workspaces/${ws}/deals?secret=abc`);
    const [line] = lines.filter((l) => l.event === "api.request");
    expect(line).toMatchObject({ method: "GET", route: "/api/workspaces/:ws/deals", status: 200 });
    expect(typeof line!.ms).toBe("number");
    expect(line!.request).toMatch(/^[0-9a-f-]{36}$/);
    expect(line!.user).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(lines)).not.toMatch(/secret=|abc|logged-person/);
    // Signed out: no user.
    lines.length = 0;
    await call(app, null, "GET", "/api/health");
    expect(lines.find((l) => l.event === "api.request")).toMatchObject({ route: "/api/health", status: 200, user: null });
  });

  test("a path that carries a secret is logged by its pattern only", async () => {
    const { app, lines } = recording();
    await call(app, null, "GET", "/api/share/the-secret-part");
    await call(app, null, "GET", "/api/share/the-secret-part/file?artifact=x");
    await call(app, null, "GET", "/api/invite/another-secret");
    const routes = lines.filter((l) => l.event === "api.request").map((l) => l.route);
    expect(routes).toEqual(["/api/share/:secret", "/api/share/:secret/file", "/api/invite/:secret"]);
    expect(JSON.stringify(lines)).not.toMatch(/the-secret-part|another-secret/);
  });

  test("pages outside the API are logged by pattern where a secret may follow", async () => {
    const { app, lines } = recording();
    app.get("*", (c) => c.text("page"));
    for (const path of ["/verify", "/reset", "/email/confirm", "/email/undo", "/deals"]) await app.request(path);
    expect(lines.filter((l) => l.event === "api.request").map((l) => l.route)).toEqual(["/verify", "/reset", "/email/*", "/email/*", "/deals"]);
  });

  test("an unhandled error is logged as api.error with the request id and alerted, without its message in the alert", async () => {
    const { app, lines, alerts } = recording();
    app.get("/api/auth/boom", () => { throw new Error("detail that stays in the log"); });
    const r = await call(app, null, "GET", "/api/auth/boom");
    expect(r.status).toBe(500);
    const error = lines.find((l) => l.event === "api.error")!;
    expect(error).toMatchObject({ route: "/api/auth/boom" });
    expect(error.request).toBe(lines.find((l) => l.event === "api.request")!.request);
    expect(alerts).toEqual([{ event: "api.error", route: "/api/auth/boom", request: error.request }]);
  });

  test("an error on a shared link keeps its generic sentence in the log", async () => {
    const { app, lines } = recording();
    app.get("/api/share/:secret/boom", () => { throw new Error("detail"); });
    await call(app, null, "GET", "/api/share/hidden-value/boom");
    const error = lines.find((l) => l.event === "api.error")!;
    expect(error).toMatchObject({ route: "/api/share/:secret/boom", error: "Shared link request failed" });
    expect(JSON.stringify(lines)).not.toMatch(/hidden-value|detail/);
  });

  test("health says whether the embedded worker is on and how many migrations are applied", async () => {
    const applied = (await db.query<{ n: number }>(`select count(*)::int as n from schema_migrations`))[0]!.n;
    const on = createApp({ db, store, secureCookies: false, worker: true });
    expect((await call(on, null, "GET", "/api/health")).json).toMatchObject({ ok: true, worker: true, migrations: applied });
    expect((await call(createApp({ db, store, secureCookies: false }), null, "GET", "/api/health")).json).toMatchObject({ worker: false, migrations: applied });
  });
});

describe("the alert hook", () => {
  test("without a URL, alerts do nothing", () => {
    const fetch = vi.fn();
    alerter(undefined, fetch)("api.error", { route: "/x" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("posts one JSON body with a 5 second timeout, without waiting for it", async () => {
    let finish!: (r: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const result = alerter("https://alerts.example.test/hook", fetch)("mail.failed", { kind: "verify_email" });
    expect(result).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://alerts.example.test/hook");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toMatchObject({ event: "mail.failed", kind: "verify_email" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    finish(new Response(null, { status: 204 }));
  });

  test("a failure never throws and is logged once as alert.failed", async () => {
    const lines: { event: string }[] = [];
    const record = (event: string, fields?: LogFields) => { lines.push({ event, ...fields }); };
    const rejecting = vi.fn(async () => { throw new Error("down"); });
    expect(() => alerter("https://alerts.example.test/hook", rejecting, record)("api.error", {})).not.toThrow();
    const throwing = vi.fn(() => { throw new Error("sync"); });
    expect(() => alerter("https://alerts.example.test/hook", throwing as never, record)("api.error", {})).not.toThrow();
    const refusing = vi.fn(async () => new Response(null, { status: 500 }));
    alerter("https://alerts.example.test/hook", refusing, record)("api.error", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(lines).toEqual([
      { event: "alert.failed", alert: "api.error" },
      { event: "alert.failed", alert: "api.error" },
      { event: "alert.failed", alert: "api.error" },
    ]);
  });

  test("a mail that fails to send is logged and alerted with its kind only", async () => {
    const failing = { configured: true, send: async () => { throw new Error("smtp down"); } };
    const { app, lines, alerts } = recording({ mailer: failing });
    expect((await signup(app, "mail-fails@example.com")).status).toBe(200);
    expect(lines.find((l) => l.event === "mail.failed")).toEqual({ event: "mail.failed", kind: "verify_email" });
    expect(alerts).toEqual([{ event: "mail.failed", kind: "verify_email" }]);
  });
});

describe("with no mail provider, nothing claims a send", () => {
  let app: App, s: Session;
  const unsent = unsentMailer(() => {});
  beforeAll(async () => {
    app = createApp({ db, store, secureCookies: false, mailer: unsent });
    s = (await signup(app, "no-mail@example.com")).session!;
  });

  test("the mailers say whether they deliver", () => {
    expect(unsent.configured).toBe(false);
    expect(memoryMailer().configured).toBe(true);
  });

  test("sign-up, verify/send and reset/send answer sent: false; the token is still made", async () => {
    expect((await signup(app, "no-mail-2@example.com")).json).toEqual({ ok: true, sent: false });
    expect(await call(app, s, "POST", "/api/auth/verify/send", {})).toMatchObject({ status: 200, json: { ok: true, sent: false } });
    expect(await call(app, null, "POST", "/api/auth/reset/send", { email: "no-mail@example.com" })).toMatchObject({ json: { ok: true, sent: false } });
    // The same answer for an address with no account.
    expect(await call(app, null, "POST", "/api/auth/reset/send", { email: "nobody-here@example.com" })).toMatchObject({ json: { ok: true, sent: false } });
    const kinds = await db.query<{ kind: string }>(`select kind from email_tokens t join users u on u.id = t.user_id where u.email = 'no-mail@example.com' order by kind`);
    expect(kinds.map((k) => k.kind)).toEqual(["reset_password", "verify_email"]);
  });

  test("changing an unconfirmed address answers changed with sent: false", async () => {
    const r = await call(app, s, "POST", "/api/me/email", { email: "no-mail-new@example.com", password: "correct horse battery" });
    expect(r.json).toEqual({ changed: true, sent: false });
  });

  test("GET /api/me says whether mail can be sent", async () => {
    expect((await call(app, s, "GET", "/api/me")).json.mail).toBe(false);
    const withMail = createApp({ db, store, secureCookies: false, mailer: memoryMailer() });
    expect((await call(withMail, s, "GET", "/api/me")).json.mail).toBe(true);
  });

  test("with a mail provider, the answers are as before", async () => {
    const mailed = createApp({ db, store, secureCookies: false, mailer: memoryMailer() });
    expect((await signup(mailed, "with-mail@example.com")).json).toEqual({ ok: true });
    expect((await call(mailed, null, "POST", "/api/auth/reset/send", { email: "with-mail@example.com" })).json).toEqual({ ok: true });
  });
});
