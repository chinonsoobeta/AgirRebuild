import { beforeAll, describe, expect, test } from "vitest";
import { asUser, migrate, openPglite, type Db } from "../src/index.ts";

// Card F: closing a workspace, purging it after the retention period, and deleting an account (migration 0039).
let db: Db;
const id = {} as Record<"alice" | "bob" | "carl" | "dave" | "zed" | "ws" | "live" | "deal" | "liveDeal" | "run" | "artifact", string>;
const hex = (c: string) => c.repeat(64);
const SHARED_KEY = `aa/${hex("a")}`;
const OWN_KEY = `bb/${hex("b")}`;
const REPORT_KEY = `cc/${hex("c")}`;

async function user(email: string) {
  const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $1, 'x') returning id`, [email]);
  return u!.id;
}
const one = async <T>(who: string, sql: string, params: unknown[] = []) => (await asUser(db, who, (tx) => tx.query<T & Record<string, unknown>>(sql, params)))[0]!;
const count = async (sql: string, params: unknown[]) => (await db.query<{ n: number }>(`select count(*)::int as n from ${sql}`, params))[0]!.n;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  for (const who of ["alice", "bob", "carl", "dave", "zed"] as const) id[who] = await user(`${who}@example.com`);
  id.ws = (await one<{ id: string }>(id.alice, `select fn_create_workspace('Closing') as id`)).id;
  await asUser(db, id.alice, async (tx) => {
    await tx.query(`select fn_add_member($1, 'bob@example.com', 'admin')`, [id.ws]);
    await tx.query(`select fn_add_member($1, 'carl@example.com', 'analyst')`, [id.ws]);
  });
  id.deal = (await one<{ id: string }>(id.alice, `select fn_create_deal($1, 'Maple', 'Multifamily', '', 'CAD', 'CA', 'BC') as id`, [id.ws])).id;
  // Two files: one only this workspace holds, one whose bytes a live workspace also holds.
  await asUser(db, id.alice, (tx) => tx.query(`select * from fn_register_document($1, 'a.pdf', 'pdf', 10, $2, $3)`, [id.deal, hex("a"), SHARED_KEY]));
  await asUser(db, id.carl, (tx) => tx.query(`select * from fn_register_document($1, 'b.pdf', 'pdf', 10, $2, $3)`, [id.deal, hex("b"), OWN_KEY]));
  // A run, a decision on it, a finished report and a live share link of it.
  const [{ h }] = (await db.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [id.deal])) as [{ h: string }];
  const payload = { engine_version: "1.0.0", policy_version: "policy-v1", policy_hash: "p", input_snapshot: {}, input_hash: "i1",
    assumptions_hash: h, result: {}, result_hash: "r", verdict_code: "REJECT", signature: "s",
    metrics: [{ scenario: "base", key: "equity_irr", value: null, status: "NOT_MEANINGFUL", unit: "%" }], gates: [], checks: [] };
  id.run = (await one<{ id: string }>(id.alice, `select fn_persist_run($1, $2) as id`, [id.deal, JSON.stringify(payload)])).id;
  await asUser(db, id.alice, (tx) => tx.query(`select fn_record_decision($1, 'reject', 'Coverage is too thin', null, null)`, [id.run]));
  id.artifact = (await one<{ id: string }>(id.alice, `select fn_request_artifact($1, 'ic_memo', 'pdf', 'en') as id`, [id.run])).id;
  await db.query(`update artifacts set status = 'ready', storage_key = $2, sha256 = $3 where id = $1`, [id.artifact, REPORT_KEY, hex("c")]);
  await asUser(db, id.alice, (tx) => tx.query(`select fn_create_share_link($1, '7d', 'link-hash')`, [id.artifact]));

  id.live = (await one<{ id: string }>(id.dave, `select fn_create_workspace('Live') as id`)).id;
  id.liveDeal = (await one<{ id: string }>(id.dave, `select fn_create_deal($1, 'Oak', 'Multifamily', '', 'CAD', 'CA', 'BC') as id`, [id.live])).id;
  await asUser(db, id.dave, (tx) => tx.query(`select * from fn_register_document($1, 'a.pdf', 'pdf', 10, $2, $3)`, [id.liveDeal, hex("a"), SHARED_KEY]));
});

describe("closing a workspace", () => {
  test("only the owner closes it", async () => {
    for (const who of [id.bob, id.carl, id.zed])
      await expect(asUser(db, who, (tx) => tx.query(`select fn_close_workspace($1, 'We are winding the firm down')`, [id.ws]))).rejects.toThrow(/role/);
    expect(await count(`workspaces where id = $1 and closed_at is null`, [id.ws])).toBe(1);
  });

  test("a reason is required", async () => {
    await expect(asUser(db, id.alice, (tx) => tx.query(`select fn_close_workspace($1, '  short ')`, [id.ws]))).rejects.toThrow(/Say why/);
  });

  test("closing ends every share link, removes everyone but the owner and records it", async () => {
    await asUser(db, id.alice, (tx) => tx.query(`select fn_close_workspace($1, 'We are winding the firm down')`, [id.ws]));
    expect(await count(`workspaces where id = $1 and closed_at is not null`, [id.ws])).toBe(1);
    expect(await count(`share_links where workspace_id = $1 and revoked_at is null`, [id.ws])).toBe(0);
    expect(await db.query(`select user_id, role from workspace_members where workspace_id = $1`, [id.ws])).toEqual([{ user_id: id.alice, role: "owner" }]);
    const [closed] = await db.query<{ actor: string; payload: any }>(`select actor, payload from audit_events where action = 'workspace.closed' and workspace_id = $1`, [id.ws]);
    expect(closed).toEqual({ actor: id.alice, payload: { reason: "We are winding the firm down", members_removed: 2, links_ended: 1 } });
    expect(await count(`audit_events where action = 'member.removed' and workspace_id = $1`, [id.ws])).toBe(2);
    expect(await count(`audit_events where action = 'share.revoked' and workspace_id = $1`, [id.ws])).toBe(1);
  });

  test("a closed workspace is read-only, even for its owner, and can still be read", async () => {
    for (const [sql, params] of [
      [`select fn_create_deal($1, 'New', 'Multifamily', '', 'CAD', 'CA', 'BC')`, [id.ws]],
      [`select fn_rename_workspace($1, 'Renamed')`, [id.ws]],
      [`select fn_add_member($1, 'zed@example.com', 'viewer')`, [id.ws]],
      [`select * from fn_register_document($1, 'c.pdf', 'pdf', 10, $2, 'dd/x')`, [id.deal, hex("d")]],
      [`select fn_request_artifact($1, 'lender_package', 'pdf', 'en')`, [id.run]],
      [`select fn_create_share_link($1, '7d', 'another-hash')`, [id.artifact]],
      [`select fn_close_workspace($1, 'Closing it a second time')`, [id.ws]],
    ] as const)
      await expect(asUser(db, id.alice, (tx) => tx.query(sql, [...params])), sql).rejects.toThrow(/^This workspace is closed\.$/);
    expect(await asUser(db, id.alice, (tx) => tx.query(`select name from deals where workspace_id = $1`, [id.ws]))).toEqual([{ name: "Maple" }]);
    // A removed member sees nothing, and is refused as before (no word about the workspace being closed).
    expect(await asUser(db, id.bob, (tx) => tx.query(`select id from deals where workspace_id = $1`, [id.ws]))).toEqual([]);
    await expect(asUser(db, id.bob, (tx) => tx.query(`select fn_rename_workspace($1, 'x')`, [id.ws]))).rejects.toThrow(/role/);
  });

  test("the app role cannot purge, and the append-only tables stay append-only outside a purge", async () => {
    await expect(asUser(db, id.alice, (tx) => tx.query(`select * from fn_purge_closed_workspaces(interval '1 day')`))).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from runs where id = $1`, [id.run])).rejects.toThrow(/append-only/);
    // The flag that lets the purge delete runs never lets anything delete the audit trail.
    await expect(db.transaction(async (tx) => {
      await tx.query(`select set_config('agir.purging', 'on', true)`);
      await tx.query(`delete from audit_events where workspace_id = $1`, [id.ws]);
    })).rejects.toThrow(/append-only/);
  });
});

describe("purging closed workspaces", () => {
  test("a retention period under one day is refused", async () => {
    await expect(db.query(`select * from fn_purge_closed_workspaces(interval '1 hour')`)).rejects.toThrow(/at least one day/);
    await expect(db.query(`select * from fn_purge_closed_workspaces(null)`)).rejects.toThrow(/at least one day/);
  });

  test("a workspace closed for less than the period is kept", async () => {
    expect(await db.query(`select * from fn_purge_closed_workspaces(interval '30 days')`)).toEqual([]);
    expect(await count(`deals where workspace_id = $1`, [id.ws])).toBe(1);
  });

  test("after the period, its data goes, its audit events stay, and a file a live workspace shares is kept", async () => {
    const eventsBefore = await count(`audit_events where workspace_id = $1`, [id.ws]);
    await db.query(`update workspaces set closed_at = now() - interval '31 days' where id = $1`, [id.ws]);
    const keys = (await db.query<{ storage_key: string }>(`select * from fn_purge_closed_workspaces(interval '30 days')`)).map((r) => r.storage_key).sort();
    expect(keys).toEqual([OWN_KEY, REPORT_KEY]);
    expect(await count(`workspaces where id = $1`, [id.ws])).toBe(0);
    for (const table of ["deals", "documents", "assumption_events", "runs", "decisions", "artifacts", "share_links", "workspace_members", "client_invites", "ai_readings", "deal_metrics"])
      expect(await count(`${table} where workspace_id = $1`, [id.ws]), table).toBe(0);
    for (const table of ["run_metrics", "run_gates", "run_checks"]) expect(await count(`${table} where run_id = $1`, [id.run]), table).toBe(0);
    expect(await count(`jobs where payload->>'deal_id' = $1 or payload->>'artifact_id' = $2`, [id.deal, id.artifact])).toBe(0);
    // Audit events are the record that it existed; one more says it was purged, and the chain still holds.
    expect(await count(`audit_events where workspace_id = $1`, [id.ws])).toBe(eventsBefore + 1);
    expect(await count(`audit_events where action = 'workspace.purged' and workspace_id = $1 and actor is null`, [id.ws])).toBe(1);
    expect((await db.query<{ ok: boolean }>(`select ok from fn_verify_audit_chain($1)`, [id.ws]))[0]!.ok).toBe(true);
    // The live workspace and its file are untouched.
    expect(await count(`documents where workspace_id = $1 and storage_key = $2`, [id.live, SHARED_KEY])).toBe(1);
    expect(await db.query(`select * from fn_purge_closed_workspaces(interval '30 days')`)).toEqual([]);
  });
});

describe("deleting an account", () => {
  test("someone who owns an open workspace must close it first", async () => {
    await expect(asUser(db, id.dave, (tx) => tx.query(`select fn_delete_my_account()`))).rejects.toThrow(/^Close the workspaces you own before deleting your account\.$/);
    expect(await count(`users where id = $1 and deleted_at is null`, [id.dave])).toBe(1);
  });

  test("the account becomes a tombstone that cannot sign in, and its audit events remain", async () => {
    await asUser(db, id.dave, (tx) => tx.query(`select fn_add_member($1, 'carl@example.com', 'viewer')`, [id.live]));
    await db.query(`insert into sessions (token_hash, user_id, expires_at) values ('carl-session', $1, now() + interval '1 day')`, [id.carl]);
    await db.query(`insert into email_tokens (user_id, kind, token_hash, expires_at) values ($1, 'verify_email', 'carl-token', now() + interval '1 hour')`, [id.carl]);
    const recorded = await count(`audit_events where actor = $1`, [id.carl]);
    expect(recorded).toBeGreaterThan(0);
    await asUser(db, id.carl, (tx) => tx.query(`select fn_delete_my_account()`));
    const [u] = await db.query<Record<string, unknown>>(`select name, email, password_hash, deleted_at is not null as deleted from users where id = $1`, [id.carl]);
    expect(u).toEqual({ name: "Deleted account", email: `deleted-${id.carl}@invalid`, password_hash: "deleted", deleted: true });
    for (const table of ["sessions", "email_tokens", "workspace_members", "deal_clients"]) expect(await count(`${table} where user_id = $1`, [id.carl]), table).toBe(0);
    expect(await count(`audit_events where actor = $1 and action <> 'user.deleted'`, [id.carl])).toBe(recorded);
    expect(await count(`audit_events where action = 'user.deleted' and entity_id = $1 and workspace_id = $2`, [id.carl, id.live])).toBe(1);
  });

  test("the owner of a closed workspace may delete their account", async () => {
    await asUser(db, id.dave, (tx) => tx.query(`select fn_close_workspace($1, 'Dave is retiring from development')`, [id.live]));
    await asUser(db, id.dave, (tx) => tx.query(`select fn_delete_my_account()`));
    expect(await count(`users where id = $1 and deleted_at is not null`, [id.dave])).toBe(1);
  });
});
