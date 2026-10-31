import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { asUser, migrate, migrationFiles, openPglite, splitSql, type Db } from "../src/index.ts";

// Card S8: one audit chain per workspace (migration 0040), its checks, and the re-hash of the events written before it.

type Event = { seq: number; workspace_id: string | null; deal_id: string | null; actor: string | null; action: string; entity: string;
  entity_id: string | null; payload_text: string; created_at_epoch: string; created_at: string; prev_hash: string; hash: string };
const EVENTS = `select seq, workspace_id, deal_id, actor, action, entity, entity_id, payload::text as payload_text,
  extract(epoch from created_at)::text as created_at_epoch, created_at::text as created_at, prev_hash, hash from audit_events order by seq`;

/** The recipe 0040 documents, written again in Node so the database and an outside reader agree on it. */
const recipe = (prev: string, e: Event) => createHash("sha256").update([prev, e.workspace_id ?? "", e.action, e.entity, e.entity_id ?? "",
  e.actor ?? "", e.deal_id ?? "", e.payload_text, e.created_at_epoch].join("|"), "utf8").digest("hex");

/** Every event links to the one before it in its own workspace, and each hash recomputes in Node. */
function expectPerWorkspaceChains(events: Event[]) {
  const last = new Map<string | null, string>();
  for (const e of events) {
    const prev = last.get(e.workspace_id) ?? "genesis";
    expect(e.prev_hash, `seq ${e.seq}`).toBe(prev);
    expect(e.hash, `seq ${e.seq}`).toBe(recipe(prev, e));
    last.set(e.workspace_id, e.hash);
  }
}

async function user(db: Db, email: string) {
  return (await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $1, 'x') returning id`, [email]))[0]!.id;
}
const workspace = (db: Db, u: string, name: string) =>
  asUser(db, u, async (tx) => (await tx.query<{ id: string }>(`select fn_create_workspace($1) as id`, [name]))[0]!.id);
const deal = (db: Db, u: string, ws: string, name: string) =>
  asUser(db, u, (tx) => tx.query(`select fn_create_deal($1, $2, 'Multifamily', '')`, [ws, name]));

/** Two people, each with a workspace, whose events interleave: A, B, A, B, A. */
async function interleaved(db: Db) {
  const ann = await user(db, `ann-${Math.random()}@example.com`);
  const ben = await user(db, `ben-${Math.random()}@example.com`);
  const a = await workspace(db, ann, "Ann's");
  const b = await workspace(db, ben, "Ben's");
  await deal(db, ann, a, "Maple");
  await deal(db, ben, b, "Cedar");
  await deal(db, ann, a, "Birch");
  return { ann, ben, a, b };
}

/** Breaks one event's payload as the superuser can (the append-only trigger off), inside `fn`'s transaction only. */
async function tampered<T>(db: Db, seq: number, fn: (tx: Db) => Promise<T>): Promise<T> {
  let out!: T;
  await db.transaction(async (tx) => {
    await tx.query(`alter table audit_events disable trigger audit_events_append_only`);
    await tx.query(`update audit_events set payload = '{"tampered": true}' where seq = $1`, [seq]);
    out = await fn(tx);
    throw new Error("roll back");
  }).catch((e: Error) => { if (e.message !== "roll back") throw e; });
  return out;
}

describe("one chain per workspace", () => {
  test("interleaved workspaces each start at genesis and link only to their own events", async () => {
    const db = await openPglite();
    await migrate(db);
    const { a, b } = await interleaved(db);
    const events = await db.query<Event>(EVENTS);
    expect(events.map((e) => e.workspace_id)).toEqual([a, b, a, b, a]);
    expect(events.filter((e) => e.prev_hash === "genesis").map((e) => e.workspace_id)).toEqual([a, b]);
    expectPerWorkspaceChains(events);
    expect(await db.query(`select * from fn_verify_audit_chain($1)`, [a])).toEqual([{ ok: true, events: 3, broken_at: null }]);
    expect(await db.query(`select * from fn_verify_audit_chain($1)`, [b])).toEqual([{ ok: true, events: 2, broken_at: null }]);
    const all = await db.query(`select * from fn_verify_audit_chains()`);
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([{ workspace_id: a, ok: true, events: 3, broken_at: null }, { workspace_id: b, ok: true, events: 2, broken_at: null }]));
    await db.close();
  });

  test("a tampered event breaks only its own workspace's check, which names it", async () => {
    const db = await openPglite();
    await migrate(db);
    const { ann, ben, a, b } = await interleaved(db);
    const target = (await db.query<{ seq: number }>(`select seq from audit_events where workspace_id = $1 order by seq offset 1 limit 1`, [a]))[0]!.seq;
    const seen = await tampered(db, target, async (tx) => ({
      a: (await tx.query(`select * from fn_verify_audit_chain($1)`, [a]))[0],
      b: (await tx.query(`select * from fn_verify_audit_chain($1)`, [b]))[0],
      all: await tx.query(`select workspace_id, ok, broken_at from fn_verify_audit_chains()`),
      // What a member reads through the application role.
      ann: await (async () => {
        await tx.query(`select set_config('agir.user_id', $1, true)`, [ann]);
        await tx.query(`set local role agir_app`);
        const r = (await tx.query(`select * from fn_verify_audit_chain_for($1)`, [a]))[0];
        await tx.query(`reset role`);
        return r;
      })(),
      ben: await (async () => {
        await tx.query(`select set_config('agir.user_id', $1, true)`, [ben]);
        await tx.query(`set local role agir_app`);
        const r = (await tx.query(`select * from fn_verify_audit_chain_for($1)`, [b]))[0];
        await tx.query(`reset role`);
        return r;
      })(),
    }));
    expect(seen.a).toEqual({ ok: false, events: 2, broken_at: target });
    expect(seen.b).toEqual({ ok: true, events: 2, broken_at: null });
    expect(seen.all).toEqual(expect.arrayContaining([{ workspace_id: a, ok: false, broken_at: target }, { workspace_id: b, ok: true, broken_at: null }]));
    expect(seen.ann).toEqual({ ok: false, events: 3, broken_at: target });
    expect(seen.ben).toEqual({ ok: true, events: 2, broken_at: null });
    await db.close();
  });

  test("members check their own workspace only; the walks of one or every workspace are for operators", async () => {
    const db = await openPglite();
    await migrate(db);
    const { ann, a, b } = await interleaved(db);
    expect(await asUser(db, ann, (tx) => tx.query(`select * from fn_verify_audit_chain_for($1)`, [a]))).toEqual([{ ok: true, events: 3, broken_at: null }]);
    await expect(asUser(db, ann, (tx) => tx.query(`select * from fn_verify_audit_chain_for($1)`, [b]))).rejects.toThrow(/does not allow/);
    await expect(asUser(db, ann, (tx) => tx.query(`select * from fn_verify_audit_chain($1)`, [a]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ann, (tx) => tx.query(`select * from fn_verify_audit_chains()`))).rejects.toThrow(/permission denied/);
    // The links of a workspace's chain, for the audit package: a member's own only, and never an event's contents.
    const links = await asUser(db, ann, (tx) => tx.query(`select * from fn_audit_chain_links($1)`, [a]));
    expect(links).toEqual((await db.query(`select seq, prev_hash, hash from audit_events where workspace_id = $1 order by seq`, [a])));
    await expect(asUser(db, ann, (tx) => tx.query(`select * from fn_audit_chain_links($1)`, [b]))).rejects.toThrow(/does not allow/);
    // ADR 0002 section 7: the application role can read events, never change or remove one, by grant.
    expect(await db.query(`select privilege_type from information_schema.role_table_grants where grantee = 'agir_app' and table_name = 'audit_events'`)).toEqual([{ privilege_type: "SELECT" }]);
    // Events with no workspace (an account deleted with no workspace left) form one chain of their own.
    await db.query(`select agir_audit(null, null, 'user.deleted', 'user', 'x', '{}'::jsonb)`);
    await db.query(`select agir_audit(null, null, 'user.deleted', 'user', 'y', '{}'::jsonb)`);
    expectPerWorkspaceChains(await db.query<Event>(EVENTS));
    expect(await db.query(`select ok, events from fn_verify_audit_chain(null)`)).toEqual([{ ok: true, events: 2 }]);
    expect(await db.query(`select workspace_id, ok from fn_verify_audit_chains() where workspace_id is null`)).toEqual([{ workspace_id: null, ok: true }]);
    await db.close();
  });
});

describe("migration 0040 re-hashes the events written before it", () => {
  test("events chained the old way verify per workspace afterwards, with their seq, time and contents unchanged", async () => {
    const db = await openPglite();
    // The runner applies every migration; this applies those before 0040 the same way, then lets migrate() add the rest.
    await db.query(`create table if not exists schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
    for (const m of migrationFiles().filter((f) => f.name < "0040")) {
      await db.transaction(async (tx) => {
        for (const stmt of splitSql(m.sql)) await tx.query(stmt);
        await tx.query(`insert into schema_migrations (name, sha256) values ($1, $2)`, [m.name, m.sha256]);
      });
    }
    const { a, b } = await interleaved(db);
    const before = await db.query<Event>(EVENTS);
    // The old chain: one chain through both workspaces, so the second workspace's first event follows the first's.
    expect(before.filter((e) => e.prev_hash === "genesis")).toHaveLength(1);
    expect(before[1]!.prev_hash).toBe(before[0]!.hash);
    const { applied } = await migrate(db);
    expect(applied[0]).toBe("0040_audit_chain_per_workspace.sql");
    const after = await db.query<Event>(EVENTS);
    const keep = ({ prev_hash: _p, hash: _h, ...rest }: Event) => rest;
    expect(after.map(keep)).toEqual(before.map(keep));
    expectPerWorkspaceChains(after);
    expect((await db.query(`select ok, events from fn_verify_audit_chain($1)`, [a]))).toEqual([{ ok: true, events: 3 }]);
    expect((await db.query(`select ok, events from fn_verify_audit_chain($1)`, [b]))).toEqual([{ ok: true, events: 2 }]);
    // The table is append-only again, and the chain carries on from the re-hashed events.
    await expect(db.query(`update audit_events set payload = '{}' where seq = 1`)).rejects.toThrow(/append-only/);
    await interleaved(db);
    expectPerWorkspaceChains(await db.query<Event>(EVENTS));
    await db.close();
  });
});
