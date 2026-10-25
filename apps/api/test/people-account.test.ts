import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

type Session = { cookie: string };
async function call(s: Session | null, method: string, path: string, body?: unknown) {
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
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery" }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
async function login(email: string): Promise<Session> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery" }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
const idOf = async (s: Session): Promise<string> => (await call(s, "GET", "/api/me")).json.user.id;
const roleOf = async (workspace: string, user: string) =>
  (await db.query<{ role: string }>(`select role from workspace_members where workspace_id = $1 and user_id = $2`, [workspace, user]))[0]?.role ?? null;
const events = (action: string, workspace?: string) =>
  db.query<{ workspace_id: string; entity_id: string; payload: any; actor: string }>(
    `select workspace_id, entity_id, payload, actor from audit_events where action = $1 ${workspace ? "and workspace_id = $2" : ""} order by seq`,
    workspace ? [action, workspace] : [action],
  );

let alice: Session, bob: Session, dan: Session, eve: Session, rowan: Session, cleo: Session, zed: Session;
let ids: Record<string, string>;
let ws: string, deal: string;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Owner");
  bob = await signup("bob@example.com", "Bob Admin");
  dan = await signup("dan@example.com", "Dan Analyst");
  eve = await signup("eve@example.com", "Eve Viewer");
  rowan = await signup("rowan@example.com", "Rowan Reviewer");
  cleo = await signup("cleo@example.com", "Cleo Client");
  zed = await signup("zed@example.com", "Zed Outsider");
  ids = {};
  for (const [k, s] of Object.entries({ alice, bob, dan, eve, rowan, cleo, zed })) ids[k] = await idOf(s);
  ws = (await call(alice, "GET", "/api/me")).json.workspaces[0].id;
  for (const [email, role] of [["bob@example.com", "admin"], ["dan@example.com", "analyst"], ["eve@example.com", "viewer"]]) {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email, role })).status).toBe(200);
  }
  deal = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Cedar Court", assetType: "Multifamily", location: "Victoria", province: "BC" })).json.id;
  expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant`, { email: "rowan@example.com", days: 7 })).status).toBe(200);
  expect((await call(alice, "POST", `/api/deals/${deal}/clients`, { email: "cleo@example.com" })).status).toBe(200);
});

describe("the owner's role cannot be changed", () => {
  test("an admin cannot turn the owner into a viewer, and the owner's row is unchanged", async () => {
    const before = await db.query(`select * from workspace_members where workspace_id = $1 and user_id = $2`, [ws, ids.alice]);
    const r = await call(bob, "POST", `/api/workspaces/${ws}/members`, { email: "alice@example.com", role: "viewer" });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("The owner's role cannot be changed");
    expect(await db.query(`select * from workspace_members where workspace_id = $1 and user_id = $2`, [ws, ids.alice])).toEqual(before);
  });

  test("the owner cannot demote themselves either", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email: "alice@example.com", role: "admin" })).status).toBe(403);
    expect(await roleOf(ws, ids.alice)).toBe("owner");
  });

  test("other members' roles still change as before", async () => {
    expect((await call(bob, "POST", `/api/workspaces/${ws}/members`, { email: "eve@example.com", role: "analyst" })).status).toBe(200);
    expect(await roleOf(ws, ids.eve)).toBe("analyst");
    expect((await call(bob, "POST", `/api/workspaces/${ws}/members`, { email: "eve@example.com", role: "viewer" })).status).toBe(200);
    expect(await roleOf(ws, ids.eve)).toBe("viewer");
  });
});

describe("removing a member", () => {
  test("an analyst or a viewer cannot remove anyone", async () => {
    expect((await call(dan, "DELETE", `/api/workspaces/${ws}/members/${ids.eve}`)).status).toBe(403);
    expect((await call(eve, "DELETE", `/api/workspaces/${ws}/members/${ids.dan}`)).status).toBe(403);
    expect((await call(zed, "DELETE", `/api/workspaces/${ws}/members/${ids.dan}`)).status).toBe(403);
    expect(await roleOf(ws, ids.eve)).toBe("viewer");
    expect(await roleOf(ws, ids.dan)).toBe("analyst");
  });

  test("the owner cannot be removed", async () => {
    expect((await call(bob, "DELETE", `/api/workspaces/${ws}/members/${ids.alice}`)).status).toBe(403);
    expect((await call(alice, "DELETE", `/api/workspaces/${ws}/members/${ids.alice}`)).status).toBe(403);
    expect(await roleOf(ws, ids.alice)).toBe("owner");
  });

  test("a reviewer's access is ended instead, and a client is removed from the deal", async () => {
    expect((await call(alice, "DELETE", `/api/workspaces/${ws}/members/${ids.rowan}`)).status).toBe(422);
    expect(await roleOf(ws, ids.rowan)).toBe("reviewer");
    expect((await call(alice, "DELETE", `/api/workspaces/${ws}/members/${ids.cleo}`)).status).toBe(422);
    expect(await roleOf(ws, ids.cleo)).toBe("client");
  });

  test("someone who is not a member is not found", async () => {
    expect((await call(alice, "DELETE", `/api/workspaces/${ws}/members/${ids.zed}`)).status).toBe(404);
  });

  test("an admin removes a viewer; the membership is gone and the removal is audited with the role", async () => {
    const r = await call(bob, "DELETE", `/api/workspaces/${ws}/members/${ids.eve}`);
    expect(r.status).toBe(200);
    expect(await roleOf(ws, ids.eve)).toBeNull();
    const ev = await events("member.removed", ws);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entity_id: ids.eve, payload: { role: "viewer" }, actor: ids.bob });
    // The removed person no longer sees the workspace or its deal.
    expect((await call(eve, "GET", "/api/me")).json.workspaces.map((w: any) => w.id)).not.toContain(ws);
    expect([403, 404]).toContain((await call(eve, "GET", `/api/deals/${deal}`)).status);
    // Removing again finds no member.
    expect((await call(bob, "DELETE", `/api/workspaces/${ws}/members/${ids.eve}`)).status).toBe(404);
  });
});

describe("renaming the workspace", () => {
  test("only the owner renames it", async () => {
    expect((await call(bob, "POST", `/api/workspaces/${ws}/name`, { name: "Bob's idea" })).status).toBe(403);
    expect((await call(dan, "POST", `/api/workspaces/${ws}/name`, { name: "Dan's idea" })).status).toBe(403);
  });

  test("the name is trimmed and between 1 and 120 characters", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/name`, { name: "   " })).status).toBe(422);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/name`, { name: "" })).status).toBe(422);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/name`, { name: "x".repeat(121) })).status).toBe(422);
    expect(await events("workspace.renamed", ws)).toHaveLength(0);
  });

  test("the owner renames it, and the change is audited from and to", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/name`, { name: "  Harbour Capital  " })).status).toBe(200);
    const me = (await call(alice, "GET", "/api/me")).json;
    expect(me.workspaces.find((w: any) => w.id === ws).name).toBe("Harbour Capital");
    const ev = await events("workspace.renamed", ws);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ from: "Alice's workspace", to: "Harbour Capital" });
  });
});

describe("ending a reviewer's access now", () => {
  test("only the owner ends it", async () => {
    expect((await call(bob, "POST", `/api/workspaces/${ws}/review-grant/${ids.rowan}/end`)).status).toBe(403);
  });

  test("someone who is not a reviewer is not found", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant/${ids.bob}/end`)).status).toBe(404);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant/${ids.zed}/end`)).status).toBe(404);
    expect(await roleOf(ws, ids.bob)).toBe("admin");
  });

  test("the reviewer loses access at once, the end is audited, and a later grant opens it again", async () => {
    expect((await call(rowan, "GET", `/api/deals/${deal}`)).status).toBe(200);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant/${ids.rowan}/end`)).status).toBe(200);
    expect([403, 404]).toContain((await call(rowan, "GET", `/api/deals/${deal}`)).status);
    const ev = await events("review.ended", ws);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entity_id: ids.rowan, actor: ids.alice });
    // Access that has ended cannot be ended again.
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant/${ids.rowan}/end`)).status).toBe(404);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant`, { email: "rowan@example.com", days: 3 })).status).toBe(200);
    expect((await call(rowan, "GET", `/api/deals/${deal}`)).status).toBe(200);
  });
});

describe("changing your own name", () => {
  test("the name is trimmed and between 1 and 120 characters", async () => {
    expect((await call(dan, "POST", "/api/me/name", { name: "  " })).status).toBe(422);
    expect((await call(dan, "POST", "/api/me/name", { name: "d".repeat(121) })).status).toBe(422);
    expect((await call(null, "POST", "/api/me/name", { name: "Nobody" })).status).toBe(401);
  });

  test("GET /api/me shows the new name, and each workspace gets an audit event with no name in it", async () => {
    expect((await call(dan, "POST", "/api/me/name", { name: "  Daniel Analyst " })).status).toBe(200);
    expect((await call(dan, "GET", "/api/me")).json.user.name).toBe("Daniel Analyst");
    const ev = await events("user.renamed");
    const own = (await call(dan, "GET", "/api/me")).json.workspaces.map((w: any) => w.id);
    expect(own).toHaveLength(2);
    expect(ev.map((e) => e.workspace_id).sort()).toEqual([...own].sort());
    for (const e of ev) expect(e).toMatchObject({ entity_id: ids.dan, actor: ids.dan, payload: {} });
    expect(JSON.stringify(ev)).not.toMatch(/Dan/);
  });
});

describe("your sessions", () => {
  test("count the live ones and end the others", async () => {
    const first = await signup("sam@example.com", "Sam Twice");
    const second = await login("sam@example.com");
    const sam = await idOf(first);
    // A session that has already expired is not counted.
    await db.query(`insert into sessions (token_hash, user_id, expires_at) values ('expired-test-hash', $1, now() - interval '1 day')`, [sam]);
    expect((await call(first, "GET", "/api/me/sessions")).json).toEqual({ count: 2 });
    expect((await call(alice, "GET", "/api/me/sessions")).json).toEqual({ count: 1 });
    const r = await call(first, "POST", "/api/me/sessions/end-others");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ended: 1 });
    expect((await call(second, "GET", "/api/me")).status).toBe(401);
    expect((await call(first, "GET", "/api/me")).status).toBe(200);
    expect((await call(first, "GET", "/api/me/sessions")).json).toEqual({ count: 1 });
    // Other people's sessions are untouched.
    expect((await call(alice, "GET", "/api/me")).status).toBe(200);
    expect((await call(null, "GET", "/api/me/sessions")).status).toBe(401);
  });
});

describe("archived deals in the production counts", () => {
  test("totals.archived_deals counts this workspace's archived deals; totals.deals is unchanged", async () => {
    const other = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Birch Row", assetType: "Office", location: "Kelowna", province: "BC" })).json.id;
    const before = (await call(alice, "GET", `/api/workspaces/${ws}/deal-metrics`)).json.totals;
    expect(before.archived_deals).toBe(0);
    await db.query(`update deals set archived_at = now() where id = $1`, [other]);
    // A deal archived in someone else's workspace is not counted here.
    const zedWs = (await call(zed, "GET", "/api/me")).json.workspaces[0].id;
    const zedDeal = (await call(zed, "POST", `/api/workspaces/${zedWs}/deals`, { name: "Elsewhere", assetType: "Office", location: "Regina" })).json.id;
    await db.query(`update deals set archived_at = now() where id = $1`, [zedDeal]);
    const after = (await call(alice, "GET", `/api/workspaces/${ws}/deal-metrics`)).json.totals;
    expect(after.archived_deals).toBe(1);
    expect(after.deals).toBe(before.deals);
  });
});
