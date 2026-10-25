import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db, type Row } from "@agir/db";
import { createApp } from "../src/app.ts";
import { memoryMailer, type Mail, type Mailer } from "../src/mailer.ts";

// Card R6: changing the email address, the undo link sent to the old address, and the 7-day hold on it.
const ORIGIN = "https://agir.test";
const PASSWORD = "correct horse battery";
const TAKEN = "An account with that email already exists.";
const DEAD = "This link does not work any more. It may have been used or expired. Ask for a new one.";
// An undo link cannot be asked for again, so its dead-link sentence does not say to.
const UNDO_DEAD = "This link does not work any more. It may have been used already, or be more than 7 days old.";
let db: Db;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

type Session = { cookie: string };
type App = ReturnType<typeof createApp>;

// Every mail sent in this file, and every line written to the console, so the last test can check that no token,
// code or address reached a log line.
const allMail: Mail[] = [];
const logged: string[] = [];

// Every test gets its own app, so the in-memory rate limiters never leak between tests.
function fresh(mailer?: Mailer) {
  const mail = memoryMailer();
  const recording: Mailer = { async send(m) { allMail.push({ ...m }); await mail.send(m); } };
  const app = createApp({ db, store, secureCookies: false, mailer: mailer ?? recording, publicOrigin: ORIGIN });
  return { app, mail };
}

async function call(app: App, s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
const login = (app: App, email: string, password = PASSWORD) => call(app, null, "POST", "/api/auth/login", { email, password });
const linkIn = (text: string, page: string) => new RegExp(`${ORIGIN}/${page}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];
const codeIn = (text: string) => /code in Agir: (\d{6})\n/.exec(text)?.[1];
const me = async (app: App, s: Session) => (await call(app, s, "GET", "/api/me")).json;
const mailTo = (mail: { sent: Mail[] }, to: string) => mail.sent.filter((m) => m.to === to);
const change = (app: App, s: Session | null, email: string, password = PASSWORD) => call(app, s, "POST", "/api/me/email", { email, password });
const confirmLink = (app: App, token: string) => call(app, null, "POST", "/api/auth/email/confirm", { token });
const undoLink = (app: App, token: string) => call(app, null, "POST", "/api/auth/email/undo", { token });

/** Signs up and confirms the address with the link from the first email. */
async function confirmedAccount(app: App, mail: { sent: Mail[] }, email: string): Promise<Session> {
  const s = await signup(app, email);
  const token = linkIn(mailTo(mail, email)[0]!.text, "verify")!;
  expect((await call(app, null, "POST", "/api/auth/verify", { token })).status).toBe(200);
  return s;
}

/** A confirmed account that has changed its address from `from` to `to`. Returns the session and the undo token. */
async function changed(app: App, mail: { sent: Mail[] }, from: string, to: string, s?: Session) {
  s ??= await confirmedAccount(app, mail, from);
  expect((await change(app, s, to)).json).toEqual({ pending: true });
  const token = linkIn(mailTo(mail, to).at(-1)!.text, "email/confirm")!;
  expect((await confirmLink(app, token)).json).toEqual({ email: to });
  const undo = linkIn(mailTo(mail, from).at(-1)!.text, "email/undo")!;
  expect(undo).toBeTruthy();
  return { s, undo };
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  for (const k of ["log", "error", "warn", "info"] as const) {
    vi.spyOn(console, k).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
  }
});
afterAll(() => { vi.restoreAllMocks(); });

describe("asking to change the address", () => {
  test("without a session: 401", async () => {
    const { app } = fresh();
    expect((await change(app, null, "x@example.com")).status).toBe(401);
  });

  test("a wrong password: 403, nothing sent, nothing changed; not a 401, which the web treats as signed out", async () => {
    const { app, mail } = fresh();
    const s = await confirmedAccount(app, mail, "wp-old@example.com");
    const before = mail.sent.length;
    const r = await change(app, s, "wp-new@example.com", "not the password");
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("That password is not right.");
    expect(mail.sent).toHaveLength(before);
    expect((await me(app, s)).user.email).toBe("wp-old@example.com");
  });

  test("the same address: 422; another account's address: 409 with the sign-up sentence", async () => {
    const { app } = fresh();
    const s = await signup(app, "same@example.com");
    await signup(app, "other@example.com");
    const same = await change(app, s, "SAME@example.com");
    expect(same.status).toBe(422);
    expect(same.json.error).toBe("That is already your email address.");
    const other = await change(app, s, "Other@example.com");
    expect(other.status).toBe(409);
    expect(other.json.error).toBe(TAKEN);
  });

  test("the sixth request in an hour: 429", async () => {
    const { app } = fresh();
    const s = await signup(app, "six@example.com");
    for (let i = 0; i < 5; i++) expect((await change(app, s, "six-new@example.com", "wrong guess")).status).toBe(403);
    const r = await change(app, s, "six-new@example.com");
    expect(r.status).toBe(429);
    expect(r.json.error).toBe("Too many attempts. Wait a while and try again.");
  });
});

describe("an address that is not confirmed changes at once", () => {
  test("the account switches; the new address gets a verification email whose link works; the old gets nothing", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "typo@exampel.com");
    const oldLink = linkIn(mailTo(mail, "typo@exampel.com")[0]!.text, "verify")!;
    const r = await change(app, s, "Fixed@Example.com");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ changed: true });
    expect(mailTo(mail, "typo@exampel.com")).toHaveLength(1); // only the sign-up email
    const [m] = mailTo(mail, "fixed@example.com");
    expect(linkIn(m!.text, "verify")).toBeTruthy();
    expect(codeIn(m!.text)).toMatch(/^\d{6}$/);
    expect((await me(app, s)).user).toMatchObject({ email: "fixed@example.com", email_verified: false });
    expect((await login(app, "fixed@example.com")).status).toBe(200);
    expect((await login(app, "typo@exampel.com")).status).toBe(401);
    // The earlier link stops working; the new one confirms the new address.
    expect((await call(app, null, "POST", "/api/auth/verify", { token: oldLink })).status).toBe(400);
    expect((await call(app, null, "POST", "/api/auth/verify", { token: linkIn(m!.text, "verify") })).status).toBe(200);
    expect((await me(app, s)).user).toMatchObject({ email: "fixed@example.com", email_verified: true });
  });

  test("the earlier code stops working and the new code works", async () => {
    const { app, mail } = fresh();
    const s = await signup(app, "code-old@example.com");
    const oldCode = codeIn(mailTo(mail, "code-old@example.com")[0]!.text)!;
    await change(app, s, "code-new@example.com");
    const newCode = codeIn(mailTo(mail, "code-new@example.com")[0]!.text)!;
    if (oldCode !== newCode) expect((await call(app, s, "POST", "/api/auth/verify", { code: oldCode })).status).toBe(400);
    expect((await call(app, s, "POST", "/api/auth/verify", { code: newCode })).status).toBe(200);
    expect((await me(app, s)).user).toMatchObject({ email: "code-new@example.com", email_verified: true });
  });
});

describe("a confirmed address changes only when the new one confirms", () => {
  test("pending until the link is opened; opened signed out, it switches and confirms; the old address is told", async () => {
    const { app, mail } = fresh();
    const s = await confirmedAccount(app, mail, "conf-old@example.com");
    const r = await change(app, s, "conf-new@example.com");
    expect(r.json).toEqual({ pending: true });
    const [m] = mailTo(mail, "conf-new@example.com");
    const token = linkIn(m!.text, "email/confirm")!;
    expect(token).toBeTruthy();
    expect(m!.text).toContain("60 minutes");
    // Nothing changes until it is opened.
    expect((await me(app, s)).user).toMatchObject({ email: "conf-old@example.com", email_verified: true });
    expect((await login(app, "conf-new@example.com")).status).toBe(401);
    expect(mailTo(mail, "conf-old@example.com")).toHaveLength(1);

    const opened = await confirmLink(app, token);
    expect(opened.status).toBe(200);
    expect(opened.json).toEqual({ email: "conf-new@example.com" });
    // The session still works and shows the new, confirmed address.
    expect((await me(app, s)).user).toMatchObject({ email: "conf-new@example.com", email_verified: true });
    expect((await login(app, "conf-new@example.com")).status).toBe(200);
    expect((await login(app, "conf-old@example.com")).status).toBe(401);
    const notice = mailTo(mail, "conf-old@example.com").at(-1)!;
    expect(notice.text).toContain("conf-new@example.com");
    expect(notice.text).toContain("7 days");
    expect(linkIn(notice.text, "email/undo")).toBeTruthy();
    // The link works once.
    const again = await confirmLink(app, token);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe(DEAD);
  });

  test("a second request makes the first link stop working", async () => {
    const { app, mail } = fresh();
    const s = await confirmedAccount(app, mail, "twice@example.com");
    await change(app, s, "twice-a@example.com");
    await change(app, s, "twice-b@example.com");
    const first = linkIn(mailTo(mail, "twice-a@example.com")[0]!.text, "email/confirm")!;
    const second = linkIn(mailTo(mail, "twice-b@example.com")[0]!.text, "email/confirm")!;
    expect((await confirmLink(app, first)).status).toBe(400);
    expect((await confirmLink(app, second)).json).toEqual({ email: "twice-b@example.com" });
  });

  test("an expired link: 400 and nothing changes", async () => {
    const { app, mail } = fresh();
    const s = await confirmedAccount(app, mail, "late@example.com");
    await change(app, s, "late-new@example.com");
    await db.query(`update email_tokens set expires_at = now() - interval '1 minute' where kind = 'change_email' and email = 'late-new@example.com'`);
    const r = await confirmLink(app, linkIn(mailTo(mail, "late-new@example.com")[0]!.text, "email/confirm")!);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(DEAD);
    expect((await me(app, s)).user.email).toBe("late@example.com");
  });
});

describe("the undo link", () => {
  test("puts the old address back, ends every session, turns the password off and sends a reset link; works once", async () => {
    const { app, mail } = fresh();
    const { s, undo } = await changed(app, mail, "undo-old@example.com", "undo-new@example.com");
    const other = { cookie: (await login(app, "undo-new@example.com")).cookie! };
    const r = await undoLink(app, undo);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ email: "undo-old@example.com" });
    expect((await call(app, s, "GET", "/api/me")).status).toBe(401);
    expect((await call(app, other, "GET", "/api/me")).status).toBe(401);
    expect((await login(app, "undo-old@example.com")).status).toBe(401);
    expect((await login(app, "undo-new@example.com")).status).toBe(401);
    // A reset link goes to the old address, and choosing a new password through it works.
    const reset = linkIn(mailTo(mail, "undo-old@example.com").at(-1)!.text, "reset")!;
    expect(reset).toBeTruthy();
    const chosen = await call(app, null, "POST", "/api/auth/reset", { token: reset, password: "a brand new passphrase", signOutOthers: false });
    expect(chosen.status).toBe(200);
    const back = { cookie: chosen.cookie! };
    expect((await me(app, back)).user).toMatchObject({ email: "undo-old@example.com", email_verified: true });
    expect((await login(app, "undo-old@example.com", "a brand new passphrase")).status).toBe(200);
    const again = await undoLink(app, undo);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe(UNDO_DEAD);
  });
});

describe("the old address is held for the 7 days", () => {
  test("sign-up and another account changing to it get 409; once the undo link has expired, sign-up works", async () => {
    const { app, mail } = fresh();
    await changed(app, mail, "held@example.com", "held-new@example.com");
    const taken = await call(app, null, "POST", "/api/auth/signup", { email: "Held@example.com", name: "Someone Else", password: PASSWORD });
    expect(taken.status).toBe(409);
    expect(taken.json.error).toBe(TAKEN);
    const s = await signup(app, "taker@example.com");
    const r = await change(app, s, "held@example.com");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe(TAKEN);
    const c = await confirmedAccount(app, mail, "taker2@example.com");
    expect((await change(app, c, "held@example.com")).status).toBe(409);
    await db.query(`update email_tokens set expires_at = now() - interval '1 minute' where kind = 'undo_email_change' and email = 'held@example.com'`);
    expect((await call(app, null, "POST", "/api/auth/signup", { email: "held@example.com", name: "Someone Else", password: PASSWORD })).status).toBe(200);
  });

  test("the undo link is stored with the change, so the hold starts with it: when it cannot be stored, nothing changes", async () => {
    const { app, mail } = fresh();
    const s = await confirmedAccount(app, mail, "together-old@example.com");
    await change(app, s, "together-new@example.com");
    const token = linkIn(mailTo(mail, "together-new@example.com")[0]!.text, "email/confirm")!;
    // The same database, except that storing an undo link fails.
    const failing = (q: Db): Db => ({
      query: <T extends Row>(sql: string, params?: unknown[]) =>
        /insert into email_tokens/.test(sql) && params?.includes("undo_email_change") ? Promise.reject(new Error("storage failed")) : q.query<T>(sql, params),
      transaction: (fn) => q.transaction((tx) => fn(failing(tx))),
      close: () => q.close(),
    });
    const broken = createApp({ db: failing(db), store, secureCookies: false, mailer: memoryMailer(), publicOrigin: ORIGIN });
    expect((await confirmLink(broken, token)).status).toBe(500);
    expect((await me(app, s)).user).toMatchObject({ email: "together-old@example.com", email_verified: true });
    // The link was not spent: opened again with storage working, it makes the change and the old address gets its undo link.
    expect((await confirmLink(app, token)).json).toEqual({ email: "together-new@example.com" });
    expect(linkIn(mailTo(mail, "together-old@example.com").at(-1)!.text, "email/undo")).toBeTruthy();
  });
});

describe("two changes, A to B to C", () => {
  test("undoing with B's link, then A's, ends at A", async () => {
    const { app, mail } = fresh();
    const { s, undo: undoA } = await changed(app, mail, "abc1-a@example.com", "abc1-b@example.com");
    const { undo: undoB } = await changed(app, mail, "abc1-b@example.com", "abc1-c@example.com", s);
    expect((await undoLink(app, undoB)).json).toEqual({ email: "abc1-b@example.com" });
    expect((await undoLink(app, undoA)).json).toEqual({ email: "abc1-a@example.com" });
  });

  test("undoing with A's link first makes B's stop working", async () => {
    const { app, mail } = fresh();
    const { s, undo: undoA } = await changed(app, mail, "abc2-a@example.com", "abc2-b@example.com");
    const { undo: undoB } = await changed(app, mail, "abc2-b@example.com", "abc2-c@example.com", s);
    expect((await undoLink(app, undoA)).json).toEqual({ email: "abc2-a@example.com" });
    expect((await undoLink(app, undoB)).status).toBe(400);
    const [u] = await db.query<{ email: string }>(`select email from users where email like 'abc2-%'`);
    expect(u!.email).toBe("abc2-a@example.com");
  });
});

describe("the migration", () => {
  test("an unknown kind is refused; email is required for the two new kinds and refused for the others", async () => {
    const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ('mig@example.com', 'M', 'x') returning id`);
    const add = (kind: string, email: string | null, n: number) => db.query(
      `insert into email_tokens (user_id, kind, token_hash, email, expires_at) values ($1, $2, $3, $4, now())`, [u!.id, kind, `mig-${n}`, email]);
    await expect(add("something_else", null, 1)).rejects.toThrow();
    await expect(add("change_email", null, 2)).rejects.toThrow();
    await expect(add("undo_email_change", null, 3)).rejects.toThrow();
    await expect(add("verify_email", "a@example.com", 4)).rejects.toThrow();
    await expect(add("reset_password", "a@example.com", 5)).rejects.toThrow();
    await expect(add("change_email", "Upper@example.com", 6)).rejects.toThrow();
    await expect(add("change_email", "@example.com", 7)).rejects.toThrow();
    await add("change_email", "a@example.com", 8);
    await add("undo_email_change", "a@example.com", 9);
    await add("verify_email", null, 10);
  });
});

describe("secrets", () => {
  test("tokens are stored only as their sha256 hashes", async () => {
    const { app, mail } = fresh();
    const { s } = await changed(app, mail, "hash-old@example.com", "hash-new@example.com");
    await change(app, s, "hash-third@example.com");
    const tokens = [linkIn(mailTo(mail, "hash-third@example.com")[0]!.text, "email/confirm")!, linkIn(mailTo(mail, "hash-old@example.com").at(-1)!.text, "email/undo")!];
    const rows = JSON.stringify(await db.query(`select * from email_tokens`));
    for (const t of tokens) {
      expect(rows).not.toContain(t);
      expect(rows).toContain(createHash("sha256").update(t).digest("hex"));
    }
  });

  test("a mail failure leaves the change made and logs mail.failed with the kind only", async () => {
    const { app } = fresh({ async send() { throw new Error("smtp down for fail-new@example.com"); } });
    const s = await signup(app, "fail-old@example.com");
    const from = logged.length;
    const r = await change(app, s, "fail-new@example.com");
    expect(r.json).toEqual({ changed: true });
    expect((await me(app, s)).user.email).toBe("fail-new@example.com");
    const lines = logged.slice(from);
    expect(lines.some((l) => l.includes('"event":"mail.failed"') && l.includes('"kind":"verify_email"'))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/@example\.com/);
  });

  test("no token, code or address appeared in any console line during this file", async () => {
    const secrets = new Set<string>();
    for (const m of allMail) {
      secrets.add(m.to);
      for (const [, t] of m.text.matchAll(/token=([A-Za-z0-9_-]+)/g)) secrets.add(t!);
      const code = codeIn(m.text);
      if (code) secrets.add(code);
    }
    for (const { email } of await db.query<{ email: string }>(`select email from users union select email from email_tokens where email is not null`)) secrets.add(email);
    expect(secrets.size).toBeGreaterThan(20);
    const all = logged.join("\n");
    for (const secret of secrets) expect(all.includes(secret), "a secret reached a log line").toBe(false);
  });
});
