import { beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { canonicalJson } from "@agir/engine";
import { createApp } from "../src/app.ts";

// Card S8: an audit package that stands on its own. Its events carry every field their hash covers, it holds the
// workspace's chain, and scripts/verify-audit-package.mjs checks it with Node alone.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
const SCRIPT = resolve(import.meta.dirname, "../../../scripts/verify-audit-package.mjs");
type Verifier = { canonicalJson: (v: unknown) => string; eventHash: (prev: string, e: unknown) => string };
let verifier: Verifier;

type Session = { cookie: string };
async function call(s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
async function signup(email: string, name: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery" }) });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
/** Runs the verifier on a package, as someone holding only the file would. */
function verify(pkg: unknown) {
  const file = join(mkdtempSync(join(tmpdir(), "agir-package-")), "package.json");
  writeFileSync(file, JSON.stringify(pkg, null, 2));
  const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** Breaks one event's payload as only the database superuser can, runs `fn`, then puts it back. */
async function withTampered<T>(seq: number, fn: () => Promise<T>): Promise<T> {
  const [{ payload }] = (await db.query<{ payload: unknown }>(`select payload from audit_events where seq = $1`, [seq])) as [{ payload: unknown }];
  const set = (p: unknown) => db.transaction(async (tx) => {
    await tx.query(`alter table audit_events disable trigger audit_events_append_only`);
    await tx.query(`update audit_events set payload = $2 where seq = $1`, [seq, JSON.stringify(p)]);
    await tx.query(`alter table audit_events enable trigger audit_events_append_only`);
  });
  await set({ tampered: true });
  try { return await fn(); } finally { await set(payload); }
}

let alice: Session, hana: Session, ivan: Session, outsider: Session;
let ws: string, d: string, run: string, hanaId: string;
const fields: [string, number, string?][] = [
  ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
  ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
  ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
];

beforeAll(async () => {
  verifier = (await import(pathToFileURL(SCRIPT).href)) as Verifier;
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice-s8@example.com", "Alice Analyst");
  hana = await signup("hana-s8@example.com", "Hana Client");
  ivan = await signup("ivan-s8@example.com", "Ivan Client");
  outsider = await signup("olga-s8@example.com", "Olga Outsider");
  hanaId = (await call(hana, "GET", "/api/me")).json.user.id;
  ws = (await call(alice, "POST", "/api/workspaces", { name: "Chain test", reviewMode: "solo" })).json.id;
  // Another workspace's events interleave with this one's; they are in neither its chain nor its package.
  const other = (await call(outsider, "GET", "/api/me")).json.workspaces[0].id;
  d = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Chain deal", assetType: "Multifamily" })).json.id;
  expect((await call(outsider, "POST", `/api/workspaces/${other}/deals`, { name: "Elsewhere", assetType: "Multifamily" })).status).toBe(200);
  for (const [fieldKey, value, itemKey] of fields) expect((await call(alice, "POST", `/api/deals/${d}/values`,
    { fieldKey, value, reason: "Chain test value", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);
  // Two clients: what one did is hidden from the other.
  expect((await call(alice, "POST", `/api/deals/${d}/clients`, { email: "ivan-s8@example.com" })).status).toBe(200);
  const invite = await call(alice, "POST", `/api/deals/${d}/invites`);
  expect((await call(hana, "POST", `/api/invite/${(invite.json.url as string).slice(3)}/accept`)).status).toBe(200);
  const a = (await call(hana, "GET", `/api/deals/${d}/review`)).json.assumptions.find((x: any) => x.sponsorStated && x.fieldKey === "exit_cap_rate_pct");
  expect((await call(hana, "POST", `/api/assumptions/${a.id}/client-confirm`, { version: a.version })).status).toBe(200);
  const made = await call(alice, "POST", `/api/deals/${d}/runs`);
  expect(made.status).toBe(200);
  run = made.json.id;
}, 120_000);

describe("the audit package", () => {
  test("each event carries every field its hash covers, exactly as the database hashed them", async () => {
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    const rows = await db.query<Record<string, unknown>>(`select seq, workspace_id, deal_id, actor, action, entity, entity_id, payload::text as payload_text,
      extract(epoch from created_at)::text as created_at_epoch, prev_hash, hash from audit_events where deal_id = $1 order by seq`, [d]);
    expect(pkg.auditEvents.length).toBe(rows.length);
    pkg.auditEvents.forEach((e: any, i: number) => {
      expect(Object.keys(e).sort()).toEqual(["action", "actor", "created_at", "created_at_epoch", "deal_id", "entity", "entity_id", "hash", "payload",
        "payload_text", "prev_hash", "seq", "workspace_id"]);
      expect(e).toMatchObject(rows[i]!);
      expect(verifier.eventHash(e.prev_hash, e)).toBe(e.hash);
    });
    expect(pkg.auditEvents.some((e: any) => e.actor === hanaId)).toBe(true);
  });

  test("holds the workspace's whole chain and its recipe, and checks the deal's events against it", async () => {
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    expect(pkg.auditChain.workspace_id).toBe(ws);
    expect(pkg.auditChain.recipe).toContain("prev_hash|workspace_id|action|entity|entity_id|actor|deal_id|payload_text|created_at_epoch");
    expect(pkg.auditChain.links).toEqual(await db.query(`select seq, prev_hash, hash from audit_events where workspace_id = $1 order by seq`, [ws]));
    expect(pkg.auditChain.links[0].prev_hash).toBe("genesis");
    expect(pkg.validation.status).toBe("passed");
    expect(pkg.validation.checks.map((c: any) => c.name)).toEqual(["input_hash", "result_hash", "signature", "replay", "decisions_bound", "audit_chain", "deal_events_in_chain"]);
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from audit_events where workspace_id = $1`, [ws]))[0]!.n;
    expect(pkg.validation.checks.find((c: any) => c.name === "audit_chain")).toEqual({ name: "audit_chain", status: "passed", message: `The workspace's audit chain is intact (${n} events).` });
    expect(pkg.validation.checks.find((c: any) => c.name === "deal_events_in_chain")).toEqual({ name: "deal_events_in_chain", status: "passed",
      message: `All ${pkg.auditEvents.length} of this deal's events are in the workspace's chain, and each hash recomputes from its fields.` });
  });

  test("for a client, hidden events are not checked and never reported as passed", async () => {
    const pkg = (await call(ivan, "GET", `/api/runs/${run}/audit-package`)).json;
    expect(JSON.stringify(pkg)).not.toContain(hanaId);
    const hidden = pkg.auditEvents.filter((e: any) => e.redacted);
    expect(hidden.length).toBeGreaterThan(0);
    for (const e of hidden) expect(e.payload_text).toBeUndefined();
    for (const e of pkg.auditEvents.filter((x: any) => !x.redacted)) expect(verifier.eventHash(e.prev_hash, e)).toBe(e.hash);
    const check = pkg.validation.checks.find((c: any) => c.name === "deal_events_in_chain");
    expect(check.status).toBe("incomplete");
    expect(check.message).toBe(`All ${pkg.auditEvents.length} of this deal's events are in the workspace's chain; ${pkg.auditEvents.length - hidden.length} recompute from their fields. Not checked for ${hidden.length} hidden ${hidden.length === 1 ? "event" : "events"}.`);
    expect(pkg.validation.status).toBe("incomplete");
  });

  test("a tampered event fails both checks, which name it", async () => {
    const seq = (await db.query<{ seq: number }>(`select max(seq)::int as seq from audit_events where deal_id = $1`, [d]))[0]!.seq;
    const pkg = await withTampered(seq, async () => (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json);
    expect(pkg.validation.status).toBe("failed");
    expect(pkg.validation.checks.find((c: any) => c.name === "audit_chain")).toMatchObject({ status: "failed", message: `The workspace's audit chain breaks at event ${seq}.` });
    expect(pkg.validation.checks.find((c: any) => c.name === "deal_events_in_chain")).toMatchObject({ status: "failed", message: `Event ${seq}'s hash does not recompute from its fields.` });
  });
});

describe("scripts/verify-audit-package.mjs", () => {
  test("its canonical JSON agrees with the engine's on nested, reordered keys and unicode", () => {
    const a = { z: [{ b: 2, a: "é" }, null, 1.5], "ü": { y: "日本", x: { d: true, c: -0.000123 } }, a: "line\nbreak   \"quoted\"", e: undefined };
    const b = { a: "line\nbreak   \"quoted\"", "ü": { x: { c: -0.000123, d: true }, y: "日本" }, z: [{ a: "é", b: 2 }, null, 1.5] };
    expect(verifier.canonicalJson(a)).toBe(canonicalJson(a));
    expect(verifier.canonicalJson(b)).toBe(canonicalJson(a));
    expect(() => verifier.canonicalJson({ x: Infinity })).toThrow();
  });

  test("passes a real package, and fails a tampered copy naming what broke", async () => {
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    const ok = verify(pkg);
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain("pass        The stored input hashes to the recorded input hash.");
    expect(ok.out).toContain(`pass        All ${pkg.auditEvents.length} of this deal's events are in the workspace's chain.`);
    expect(ok.out).toContain("Every check passed. 2 items were not checked (listed above).");
    expect(ok.out).not.toMatch(/^fail/m);

    const copy = () => structuredClone(pkg);
    const payload = copy();
    payload.auditEvents[0].payload = { tampered: true };
    expect(verify(payload)).toMatchObject({ code: 1, out: expect.stringContaining(`fail        Event ${pkg.auditEvents[0].seq}'s hash does not recompute from its fields.`) });
    const both = copy();
    both.auditEvents[1].payload = { tampered: true };
    both.auditEvents[1].payload_text = '{"tampered": true}';
    expect(verify(both).out).toContain(`fail        Event ${pkg.auditEvents[1].seq}'s hash does not recompute from its fields.`);
    const result = copy();
    result.result = { ...result.result, tampered: true };
    expect(verify(result)).toMatchObject({ code: 1, out: expect.stringContaining("fail        The stored result hashes to the recorded result hash.") });
    const links = copy();
    links.auditChain.links.splice(1, 1);
    expect(verify(links).out).toContain(`fail        The workspace's chain breaks at event ${pkg.auditChain.links[2].seq}.`);
  });

  test("a client's package passes what it can and says what it did not check", async () => {
    const pkg = (await call(ivan, "GET", `/api/runs/${run}/audit-package`)).json;
    const hidden = pkg.auditEvents.filter((e: any) => e.redacted).length;
    const r = verify(pkg);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`not checked Not checked for ${hidden} hidden ${hidden === 1 ? "event" : "events"}`);
  });
});

describe("GET /api/workspaces/:ws/audit/verify", () => {
  test("a member gets their workspace's count; a non-member gets 403; a break is named by its event", async () => {
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from audit_events where workspace_id = $1`, [ws]))[0]!.n;
    expect(await call(alice, "GET", `/api/workspaces/${ws}/audit/verify`)).toEqual({ status: 200, json: { ok: true, events: n, brokenAt: null } });
    expect((await call(outsider, "GET", `/api/workspaces/${ws}/audit/verify`)).status).toBe(403);
    const seq = (await db.query<{ seq: number }>(`select min(seq)::int as seq from audit_events where deal_id = $1`, [d]))[0]!.seq;
    const broken = await withTampered(seq, () => call(alice, "GET", `/api/workspaces/${ws}/audit/verify`));
    expect(broken).toEqual({ status: 200, json: { ok: false, events: n, brokenAt: seq } });
    // Another workspace's chain does not move.
    const other = (await call(outsider, "GET", "/api/me")).json.workspaces[0].id;
    expect((await withTampered(seq, () => call(outsider, "GET", `/api/workspaces/${other}/audit/verify`))).json).toMatchObject({ ok: true, brokenAt: null });
  });
});
