import { beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asUser, fileStore, migrate, openPglite, type Db } from "@agir/db";
import { purgeClosedWorkspaces, retentionDays } from "@agir/worker";
import { createApp } from "../src/app.ts";

// Card F: the close and delete routes behind AGIR_ACCOUNT_CLOSURE, and the purge with the retention period as a parameter.
let db: Db;
const blobs = mkdtempSync(join(tmpdir(), "agir-blobs-"));
const store = fileStore(blobs);
const PASSWORD = "correct horse battery";
let on: ReturnType<typeof createApp>;
let off: ReturnType<typeof createApp>;

type Session = { cookie: string };
async function call(app: ReturnType<typeof createApp>, s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}
async function signup(email: string, name: string): Promise<Session> {
  const res = await on.request("/api/auth/signup", {
    method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email, name, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
const me = (app: ReturnType<typeof createApp>, s: Session) => call(app, s, "GET", "/api/me");

let alice: Session, bob: Session;
let aliceId: string, ws: string;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  on = createApp({ db, store, secureCookies: false, closure: true });
  off = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Owner");
  bob = await signup("bob@example.com", "Bob Admin");
  aliceId = (await me(on, alice)).json.user.id;
  ws = (await me(on, alice)).json.workspaces[0].id;
  expect((await call(on, alice, "POST", `/api/workspaces/${ws}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
});

describe("with the setting off (the default)", () => {
  test("the routes do not exist and /api/me says so", async () => {
    expect((await me(off, alice)).json.closure).toBe(false);
    expect((await call(off, alice, "POST", `/api/workspaces/${ws}/close`, { reason: "We are winding the firm down" })).status).toBe(404);
    expect((await call(off, alice, "POST", "/api/auth/delete-account", { password: PASSWORD })).status).toBe(404);
    expect((await db.query(`select closed_at from workspaces where id = $1`, [ws]))[0]).toEqual({ closed_at: null });
  });
});

describe("with the setting on", () => {
  test("/api/me says so and gives each workspace's closed_at", async () => {
    const r = (await me(on, alice)).json;
    expect(r.closure).toBe(true);
    expect(r.workspaces[0].closed_at).toBeNull();
  });

  test("only the owner closes a workspace, with a reason", async () => {
    expect((await call(on, bob, "POST", `/api/workspaces/${ws}/close`, { reason: "We are winding the firm down" })).status).toBe(403);
    expect((await call(on, alice, "POST", `/api/workspaces/${ws}/close`, { reason: "no" })).status).toBe(422);
    expect((await call(on, alice, "POST", `/api/workspaces/${ws}/close`, { reason: "We are winding the firm down" })).status).toBe(200);
    expect((await me(on, alice)).json.workspaces[0].closed_at).not.toBeNull();
    // Bob was removed with everyone but the owner.
    expect((await me(on, bob)).json.workspaces.map((w: { id: string }) => w.id)).not.toContain(ws);
  });

  test("a closed workspace answers every change with 409 and the sentence the screen translates", async () => {
    const renamed = await call(on, alice, "POST", `/api/workspaces/${ws}/name`, { name: "Renamed" });
    expect(renamed).toMatchObject({ status: 409, json: { error: "This workspace is closed." } });
    expect((await call(on, alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "solo" })).status).toBe(409);
    expect((await call(on, alice, "GET", `/api/workspaces/${ws}/members`)).status).toBe(200);
  });

  test("deleting an account asks for the password again and refuses while an open workspace is owned", async () => {
    expect((await call(on, null, "POST", "/api/auth/delete-account", { password: PASSWORD })).status).toBe(401);
    expect((await call(on, bob, "POST", "/api/auth/delete-account", { password: "not the password" })).status).toBe(403);
    // Bob still owns the workspace sign-up gave him.
    const refused = await call(on, bob, "POST", "/api/auth/delete-account", { password: PASSWORD });
    expect(refused).toMatchObject({ status: 422, json: { error: "Close the workspaces you own before deleting your account." } });
  });

  test("a deleted account is signed out, cannot sign in again, and its audit events remain", async () => {
    const recorded = (await db.query(`select seq from audit_events where actor = $1`, [aliceId])).length;
    const deleted = await call(on, alice, "POST", "/api/auth/delete-account", { password: PASSWORD });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("set-cookie")).toMatch(/agir_session=;/);
    expect((await me(on, alice)).status).toBe(401);
    const login = await call(on, null, "POST", "/api/auth/login", { email: "alice@example.com", password: PASSWORD });
    expect(login.status).toBe(401);
    expect((await db.query(`select seq from audit_events where actor = $1 and action <> 'user.deleted'`, [aliceId])).length).toBe(recorded);
    // The address is free again, for a new account.
    await signup("alice@example.com", "Alice Again");
  });
});

describe("the purge", () => {
  test("the retention period is a whole number of days, and unset means never", () => {
    expect(retentionDays(undefined)).toBeNull();
    expect(retentionDays("")).toBeNull();
    expect(retentionDays("30")).toBe(30);
    for (const bad of ["0", "-1", "1.5", "30d", "abc"]) expect(() => retentionDays(bad), bad).toThrow(/whole number of days/);
  });

  test("it deletes the files of a workspace closed past the period, keeping one a live workspace shares", async () => {
    const carl = (await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ('carl@example.com', 'Carl', 'x') returning id`))[0]!.id;
    const make = async (name: string) => {
      const w = (await asUser(db, carl, (tx) => tx.query<{ id: string }>(`select fn_create_workspace($1) as id`, [name])))[0]!.id;
      const d = (await asUser(db, carl, (tx) => tx.query<{ id: string }>(`select fn_create_deal($1, 'Deal', 'Multifamily', '', 'CAD', 'CA', 'BC') as id`, [w])))[0]!.id;
      return { w, d };
    };
    const closing = await make("Closing");
    const live = await make("Live");
    const shared = await store.put(new TextEncoder().encode("bytes both workspaces hold"));
    const own = await store.put(new TextEncoder().encode("bytes only the closing workspace holds"));
    const register = (d: string, name: string, put: { key: string; sha256: string; size: number }) =>
      asUser(db, carl, (tx) => tx.query(`select * from fn_register_document($1, $2, 'txt', $3, $4, $5)`, [d, name, put.size, put.sha256, put.key]));
    await register(closing.d, "a.txt", shared);
    await register(closing.d, "b.txt", own);
    await register(live.d, "a.txt", shared);
    await asUser(db, carl, (tx) => tx.query(`select fn_close_workspace($1, 'This deal fell through for good')`, [closing.w]));

    const logs: Record<string, unknown>[] = [];
    const deps = { db, store, log: (e: Record<string, unknown>) => logs.push(e) };
    expect(await purgeClosedWorkspaces(deps, 30)).toEqual({ workspaces: 0, files: 0 });
    await db.query(`update workspaces set closed_at = now() - interval '31 days' where id = $1`, [closing.w]);
    expect(await purgeClosedWorkspaces(deps, 30)).toEqual({ workspaces: 1, files: 1 });
    expect(existsSync(join(blobs, own.key))).toBe(false);
    expect(existsSync(join(blobs, shared.key))).toBe(true);
    expect(logs.at(-1)).toEqual({ event: "purge.done", workspaces: 1, files: 1 });
    // A file already gone is not an error.
    await expect(store.delete(own.key)).resolves.toBeUndefined();
    await expect(store.delete("../escape")).rejects.toThrow(/Invalid storage key/);
  });
});
