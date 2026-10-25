import { beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/services.ts";

// Card R5: a link is shown once, so "Make a new link" withdraws an open invitation and makes a new one for the same deal.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
const errors = vi.spyOn(console, "error");

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
  return { status: res.status, json, text };
}
async function signup(email: string, name: string, invite?: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery", ...(invite ? { invite } : {}) }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

let alice: Session, bob: Session, dan: Session, eve: Session, zed: Session;
let ws: string, deal: string;
const secrets: string[] = [];
const gone = { error: "This invitation is not available. It may have been used, revoked or expired." };

const invite = async (s: Session = alice) => {
  const made = await call(s, "POST", `/api/deals/${deal}/invites`);
  expect(made.status).toBe(200);
  const secret = (made.json.url as string).slice(3);
  secrets.push(secret);
  return { id: made.json.id as string, secret };
};
const invitesOfDeal = async () => (await db.query<{ n: number }>(`select count(*)::int as n from client_invites where deal_id = $1`, [deal]))[0]!.n;
const openOfDeal = () => db.query<{ id: string }>(`select id from client_invites where deal_id = $1 and used_at is null and revoked_at is null`, [deal]);
const auditOf = (action: string, id: string) =>
  db.query(`select 1 from audit_events where action = $1 and entity = 'client_invite' and entity_id = $2`, [action, id]);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Owner");
  bob = await signup("bob@example.com", "Bob Admin");
  dan = await signup("dan@example.com", "Dan Analyst");
  eve = await signup("eve@example.com", "Eve Viewer");
  zed = await signup("zed@example.com", "Zed Outsider");
  ws = (await call(alice, "GET", "/api/me")).json.workspaces[0].id;
  for (const [email, role] of [["bob@example.com", "admin"], ["dan@example.com", "analyst"], ["eve@example.com", "viewer"]]) {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email, role })).status).toBe(200);
  }
  deal = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Cedar Court", assetType: "Multifamily", location: "Victoria", province: "BC" })).json.id;
});

describe("making a new link for an open invitation", () => {
  test("an admin replaces an open invitation: the old link stops working, the new one opens, and both steps are audited", async () => {
    const old = await invite();
    expect((await call(null, "GET", `/api/invite/${old.secret}`)).status).toBe(200);
    const made = await call(bob, "POST", `/api/invites/${old.id}/replace`);
    expect(made.status).toBe(200);
    expect(Object.keys(made.json).sort()).toEqual(["id", "url"]);
    expect(made.json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(made.json.id).not.toBe(old.id);
    expect(made.json.url).toMatch(/^\/i\/[A-Za-z0-9_-]{43}$/);
    const fresh = (made.json.url as string).slice(3);
    secrets.push(fresh);
    expect(fresh).not.toBe(old.secret);

    expect(await call(null, "GET", `/api/invite/${old.secret}`)).toMatchObject({ status: 404, json: gone });
    expect(await call(null, "GET", `/api/invite/${fresh}`)).toMatchObject({ status: 200, json: { deal: "Cedar Court" } });
    expect((await openOfDeal()).map((r) => r.id)).toEqual([made.json.id]);
    expect(await auditOf("invite.revoked", old.id)).toHaveLength(1);
    expect(await auditOf("invite.created", made.json.id)).toHaveLength(1);

    for (const s of [old.secret, fresh]) {
      expect(made.text).not.toContain(sha256(s));
    }
    expect(made.text).not.toContain(old.secret);
  });

  test("the owner can make a new link too, and the new link signs a client up to the same deal", async () => {
    const old = await invite(bob);
    const made = await call(alice, "POST", `/api/invites/${old.id}/replace`);
    expect(made.status).toBe(200);
    const fresh = (made.json.url as string).slice(3);
    secrets.push(fresh);
    const ida = await signup("ida.client@example.com", "Ida Client", fresh);
    expect((await call(ida, "GET", `/api/workspaces/${ws}/deals`)).json.map((d: any) => d.deal.id)).toEqual([deal]);
  });

  test("a used or a withdrawn invitation answers 422 and no new invitation is made", async () => {
    const used = await invite();
    await signup("jo.client@example.com", "Jo Client", used.secret);
    const withdrawn = await invite();
    expect((await call(alice, "POST", `/api/invites/${withdrawn.id}/revoke`)).status).toBe(200);
    for (const { id } of [used, withdrawn]) {
      const before = await invitesOfDeal();
      const refused = await call(alice, "POST", `/api/invites/${id}/replace`);
      expect(refused.status).toBe(422);
      expect(refused.json).not.toHaveProperty("url");
      expect(await invitesOfDeal()).toBe(before);
    }
  });

  test("an analyst, a viewer and a person from another workspace get 404, and nothing changes", async () => {
    const open = await invite();
    const before = await invitesOfDeal();
    for (const s of [dan, eve, zed]) {
      const r = await call(s, "POST", `/api/invites/${open.id}/replace`);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "This invitation is not there any more." });
    }
    expect(await invitesOfDeal()).toBe(before);
    expect(await call(null, "GET", `/api/invite/${open.secret}`)).toMatchObject({ status: 200 });
    expect((await call(null, "POST", `/api/invites/${open.id}/replace`)).status).toBe(401);
  });

  test("an unknown or malformed id answers 404", async () => {
    expect((await call(alice, "POST", `/api/invites/00000000-0000-4000-8000-000000000000/replace`)).status).toBe(404);
    expect((await call(alice, "POST", `/api/invites/not-an-id/replace`)).status).toBe(404);
  });

  test("no secret or its hash reaches an audit payload or a log line", async () => {
    const payloads = (await db.query<{ p: string }>(`select payload::text as p from audit_events`)).map((r) => r.p).join("\n");
    const logs = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(secrets.length).toBeGreaterThan(5);
    for (const s of secrets) {
      expect(payloads).not.toContain(s);
      expect(payloads).not.toContain(sha256(s));
      expect(logs).not.toContain(s);
      expect(logs).not.toContain(sha256(s));
    }
  });
});
