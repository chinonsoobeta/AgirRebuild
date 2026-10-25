import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";
import { fileMailer, memoryMailer } from "../src/mailer.ts";

const ORIGIN = "https://agir.test";
const PASSWORD = "correct horse battery";
let db: Db;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

type Session = { cookie: string };
type App = ReturnType<typeof createApp>;

// Every group gets its own app, so the in-memory rate limiters never leak between tests.
function fresh() {
  const mail = memoryMailer();
  const app = createApp({ db, store, secureCookies: false, mailer: mail, publicOrigin: ORIGIN });
  return { app, mail };
}

async function call(app: App, s: Session | null, method: string, path: string, body?: unknown, ip?: string) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }, ip ? { incoming: { socket: { remoteAddress: ip } } } : undefined);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  const setCookie = res.headers.get("set-cookie");
  return { status: res.status, json, cookie: setCookie ? setCookie.split(";")[0]! : null };
}

async function signup(app: App, email: string): Promise<Session> {
  const r = await call(app, null, "POST", "/api/auth/signup", { email, name: "Test Person", password: PASSWORD });
  expect(r.status).toBe(200);
  return { cookie: r.cookie! };
}
const login = (app: App, email: string, password: string) => call(app, null, "POST", "/api/auth/login", { email, password });
const tokenIn = (text: string, page: "verify" | "reset") => new RegExp(`${ORIGIN}/${page}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];
const codeIn = (text: string) => /code in Agir: (\d{6})\n/.exec(text)?.[1];
const me = async (app: App, s: Session) => (await call(app, s, "GET", "/api/me")).json;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
});

describe("verifying an email address", () => {
  test("signup sends a verification email with a link and a code; the account starts unverified", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "Dana@Example.com");
    expect(mail.sent).toHaveLength(1);
    const [m] = mail.sent;
    expect(m!.to).toBe("dana@example.com");
    expect(tokenIn(m!.text, "verify")).toBeTruthy();
    expect(codeIn(m!.text)).toMatch(/^\d{6}$/);
    expect((await me(app, s)).user).toMatchObject({ email: "dana@example.com", email_verified: false });
    // Tokens and codes are stored hashed, never as sent.
    const rows = await db.query<{ token_hash: string; code_hash: string }>(`select token_hash, code_hash from email_tokens t join users u on u.id = t.user_id where u.email = 'dana@example.com'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(tokenIn(m!.text, "verify"));
    expect(rows[0]!.code_hash).not.toBe(codeIn(m!.text));
  });

  test("the link verifies the address while signed out, and only once", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "erin@example.com");
    const token = tokenIn(mail.sent[0]!.text, "verify")!;
    expect((await call(app, null, "POST", "/api/auth/verify", { token })).status).toBe(200);
    expect((await me(app, s)).user.email_verified).toBe(true);
    const again = await call(app, null, "POST", "/api/auth/verify", { token });
    expect(again.status).toBe(400);
    expect(typeof again.json.error).toBe("string");
  });

  test("the code verifies the address for the signed-in person, and needs a session", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "finn@example.com");
    const code = codeIn(mail.sent[0]!.text)!;
    expect((await call(app, null, "POST", "/api/auth/verify", { code })).status).toBe(401);
    const wrong = code === "000000" ? "000001" : "000000";
    expect((await call(app, s, "POST", "/api/auth/verify", { code: wrong })).status).toBe(400);
    expect((await me(app, s)).user.email_verified).toBe(false);
    expect((await call(app, s, "POST", "/api/auth/verify", { code })).status).toBe(200);
    expect((await me(app, s)).user.email_verified).toBe(true);
    expect((await call(app, s, "POST", "/api/auth/verify", { code })).status).toBe(400);
  });

  test("another person's code does not verify me", async () => {
    const { app, mail } = fresh();
    await signup(app, "gail@example.com");
    const h = await signup(app, "hugo@example.com");
    const gailCode = codeIn(mail.sent[0]!.text)!;
    const hugoCode = codeIn(mail.sent[1]!.text)!;
    if (gailCode !== hugoCode) expect((await call(app, h, "POST", "/api/auth/verify", { code: gailCode })).status).toBe(400);
    expect((await me(app, h)).user.email_verified).toBe(false);
  });

  test("an expired or unknown token is refused", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "ivy@example.com");
    const token = tokenIn(mail.sent[0]!.text, "verify")!;
    await db.query(`update email_tokens set expires_at = now() - interval '1 minute' where user_id = (select id from users where email = 'ivy@example.com')`);
    expect((await call(app, null, "POST", "/api/auth/verify", { token })).status).toBe(400);
    expect((await call(app, s, "POST", "/api/auth/verify", { code: codeIn(mail.sent[0]!.text)! })).status).toBe(400);
    expect((await call(app, null, "POST", "/api/auth/verify", { token: "not-a-real-token" })).status).toBe(400);
    expect((await me(app, s)).user.email_verified).toBe(false);
  });

  test("sending again needs a session, replaces the earlier token, and is rate-limited per person", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "jo@example.com");
    expect((await call(app, null, "POST", "/api/auth/verify/send")).status).toBe(401);
    const first = tokenIn(mail.sent[0]!.text, "verify")!;
    expect((await call(app, s, "POST", "/api/auth/verify/send")).status).toBe(200);
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[1]!.to).toBe("jo@example.com");
    expect((await call(app, null, "POST", "/api/auth/verify", { token: first })).status).toBe(400);
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) limited = (await call(app, s, "POST", "/api/auth/verify/send")).status === 429;
    expect(limited).toBe(true);
    const latest = tokenIn(mail.sent.at(-1)!.text, "verify")!;
    expect((await call(app, null, "POST", "/api/auth/verify", { token: latest })).status).toBe(200);
  });
});

describe("resetting a password", () => {
  test("asking for an unknown email answers the same and sends nothing", async () => {
    const { app, mail } = fresh();
    await signup(app, "kim@example.com");
    mail.sent.length = 0;
    const known = await call(app, null, "POST", "/api/auth/reset/send", { email: "KIM@example.com" });
    const unknown = await call(app, null, "POST", "/api/auth/reset/send", { email: "nobody@example.com" });
    expect(unknown.status).toBe(known.status);
    expect(unknown.json).toEqual(known.json);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("kim@example.com");
    expect(tokenIn(mail.sent[0]!.text, "reset")).toBeTruthy();
  });

  test("a reset changes the password, works once, and signs the person in", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "lee@example.com");
    await call(app, null, "POST", "/api/auth/reset/send", { email: "lee@example.com" });
    const token = tokenIn(mail.sent.at(-1)!.text, "reset")!;
    expect((await call(app, null, "POST", "/api/auth/reset", { token, password: "short", signOutOthers: false })).status).toBe(422);
    const r = await call(app, null, "POST", "/api/auth/reset", { token, password: "a brand new passphrase", signOutOthers: false });
    expect(r.status).toBe(200);
    expect(r.cookie).toMatch(/^agir_session=/);
    expect((await me(app, { cookie: r.cookie! })).user.email).toBe("lee@example.com");
    expect((await login(app, "lee@example.com", PASSWORD)).status).toBe(401);
    expect((await login(app, "lee@example.com", "a brand new passphrase")).status).toBe(200);
    // Without signOutOthers the earlier session stays.
    expect((await call(app, s, "GET", "/api/me")).status).toBe(200);
    expect((await call(app, null, "POST", "/api/auth/reset", { token, password: "yet another passphrase", signOutOthers: false })).status).toBe(400);
    expect((await login(app, "lee@example.com", "yet another passphrase")).status).toBe(401);
  });

  test("signOutOthers ends every other session; the person ends up signed in", async () => {
    const { app, mail } = fresh();
    const a = await signup(app, "max@example.com");
    const b = { cookie: (await login(app, "max@example.com", PASSWORD)).cookie! };
    await call(app, null, "POST", "/api/auth/reset/send", { email: "max@example.com" });
    const token = tokenIn(mail.sent.at(-1)!.text, "reset")!;
    const r = await call(app, null, "POST", "/api/auth/reset", { token, password: "a brand new passphrase", signOutOthers: true });
    expect(r.status).toBe(200);
    expect((await call(app, a, "GET", "/api/me")).status).toBe(401);
    expect((await call(app, b, "GET", "/api/me")).status).toBe(401);
    expect((await call(app, { cookie: r.cookie! }, "GET", "/api/me")).status).toBe(200);
  });

  test("an expired, superseded or unknown reset token is refused", async () => {
    const { app, mail } = fresh();
    await signup(app, "nia@example.com");
    await call(app, null, "POST", "/api/auth/reset/send", { email: "nia@example.com" });
    const first = tokenIn(mail.sent.at(-1)!.text, "reset")!;
    await call(app, null, "POST", "/api/auth/reset/send", { email: "nia@example.com" });
    const second = tokenIn(mail.sent.at(-1)!.text, "reset")!;
    const body = (token: string) => ({ token, password: "a brand new passphrase", signOutOthers: false });
    expect((await call(app, null, "POST", "/api/auth/reset", body(first))).status).toBe(400);
    await db.query(`update email_tokens set expires_at = now() - interval '1 minute' where kind = 'reset_password' and user_id = (select id from users where email = 'nia@example.com')`);
    expect((await call(app, null, "POST", "/api/auth/reset", body(second))).status).toBe(400);
    expect((await call(app, null, "POST", "/api/auth/reset", body("not-a-real-token"))).status).toBe(400);
    // A verification token cannot reset a password.
    const verifyToken = tokenIn(mail.sent[0]!.text, "verify")!;
    expect((await call(app, null, "POST", "/api/auth/reset", body(verifyToken))).status).toBe(400);
    expect((await login(app, "nia@example.com", PASSWORD)).status).toBe(200);
  });

  test("asking for resets is rate-limited per email and per address", async () => {
    const { app, mail } = fresh();
    await signup(app, "oto@example.com");
    mail.sent.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(app, null, "POST", "/api/auth/reset/send", { email: "oto@example.com" }, `10.0.0.${i + 1}`)).status);
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    expect(mail.sent).toHaveLength(3);
    // The per-email limit answers the same for an email with no account.
    const ghost: number[] = [];
    for (let i = 0; i < 4; i++) ghost.push((await call(app, null, "POST", "/api/auth/reset/send", { email: "ghost@example.com" }, `10.0.1.${i + 1}`)).status);
    expect(ghost).toEqual([200, 200, 200, 429]);
    // One address asking for many emails is limited too.
    const one: number[] = [];
    for (let i = 0; i < 12; i++) one.push((await call(app, null, "POST", "/api/auth/reset/send", { email: `p${i}@example.com` }, "10.0.2.1")).status);
    expect(one.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("the development mailer", () => {
  test("writes each message to a file in its folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agir-mail-"));
    const lines: string[] = [];
    const m = fileMailer(dir, (line) => lines.push(line));
    await m.send({ to: "q@example.com", subject: "Hello", text: "Body" });
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), "utf8")).toContain("Body");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(dir);
    expect(lines[0]).not.toContain("Body");
  });
});
