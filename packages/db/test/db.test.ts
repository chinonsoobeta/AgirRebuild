import { beforeAll, describe, expect, test } from "vitest";
import { asUser, migrate, openPglite, type Db } from "../src/index.ts";

let db: Db;
const ids = {} as Record<"alice" | "bob" | "mallory" | "ws" | "deal" | "malloryWs" | "run", string>;

async function user(email: string) {
  const [u] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ($1, $1, 'x') returning id`, [email]);
  return u!.id;
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  ids.alice = await user("alice@example.com");
  ids.bob = await user("bob@example.com");
  ids.mallory = await user("mallory@example.com");
  ids.ws = (await asUser(db, ids.alice, (tx) => tx.query<{ id: string }>(`select fn_create_workspace('Alpha') as id`)))[0]!.id;
  await asUser(db, ids.alice, (tx) => tx.query(`select fn_add_member($1, 'bob@example.com', 'admin')`, [ids.ws]));
  ids.deal = (await asUser(db, ids.alice, (tx) => tx.query<{ id: string }>(`select fn_create_deal($1, 'Maple', 'Multifamily', '') as id`, [ids.ws])))[0]!.id;
  const malloryWs = (await asUser(db, ids.mallory, (tx) => tx.query<{ id: string }>(`select fn_create_workspace('Other') as id`)))[0]!.id;
  ids.malloryWs = malloryWs;
});

describe("isolation", () => {
  test("a user sees only their workspaces' deals", async () => {
    const mine = await asUser(db, ids.alice, (tx) => tx.query(`select id from deals`));
    const theirs = await asUser(db, ids.mallory, (tx) => tx.query(`select id from deals`));
    expect(mine.length).toBe(1);
    expect(theirs.length).toBe(0);
  });
  test("a user cannot create a deal in someone else's workspace", async () => {
    await expect(asUser(db, ids.mallory, (tx) => tx.query(`select fn_create_deal($1, 'x', 'Office', '')`, [ids.ws]))).rejects.toThrow(/role/);
  });
  test("the app role cannot write a governed table directly", async () => {
    await expect(asUser(db, ids.alice, (tx) => tx.query(`insert into deals (workspace_id, name) values ($1, 'x')`, [ids.ws]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ids.alice, (tx) => tx.query(`update assumptions set status = 'approved'`))).rejects.toThrow(/permission denied/);
  });
  test("internal helpers are not callable, so the audit chain cannot be forged", async () => {
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select agir_audit($1, null, 'forged', 'x', null, '{}')`, [ids.ws]))).rejects.toThrow(/permission denied/);
  });
  test("credentials are never readable", async () => {
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select password_hash from users`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select * from sessions`))).rejects.toThrow(/permission denied/);
  });
});

describe("review", () => {
  test("a material override waits for a different second approver", async () => {
    await db.query(`insert into assumptions (deal_id, workspace_id, field_key, status, value, source_kind) values ($1, $2, 'exit_cap_rate_pct', 'needs_review', 5.25, 'document')`, [ids.deal, ids.ws]);
    const [a] = await db.query<{ id: string; version: number }>(`select id, version from assumptions where field_key = 'exit_cap_rate_pct'`);
    const [m] = await asUser(db, ids.alice, (tx) => tx.query<{ status: string }>(`select (fn_review($1, 'modify', 6.0, 'Appraisal update received by email', $2)).status`, [a!.id, a!.version]));
    expect(m!.status).toBe("awaiting_second_approval");
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select fn_review($1, 'second_approve', null, null, null)`, [a!.id]))).rejects.toThrow(/different person/);
    const [s] = await asUser(db, ids.bob, (tx) => tx.query<{ status: string; value: number }>(`select (r).status, (r).value from (select fn_review($1, 'second_approve', null, null, null) r) x`, [a!.id]));
    expect(s).toEqual({ status: "approved", value: 6 });
  });
  test("a conflict resolves only to a documented value", async () => {
    await db.query(`insert into assumptions (deal_id, workspace_id, field_key, status, source_kind, conflict_values) values ($1, $2, 'senior_loan_amount', 'conflicting', 'document', '[{"value": 54500000}, {"value": 58000000}]')`, [ids.deal, ids.ws]);
    const [a] = await db.query<{ id: string }>(`select id from assumptions where field_key = 'senior_loan_amount'`);
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select fn_review($1, 'resolve', 56000000, null, null)`, [a!.id]))).rejects.toThrow(/documented values/);
    const [r] = await asUser(db, ids.alice, (tx) => tx.query<{ status: string }>(`select (fn_review($1, 'resolve', 54500000, null, null)).status`, [a!.id]));
    expect(r!.status).toBe("approved");
  });
  test("bounds from the field catalog are enforced in the database", async () => {
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select fn_enter_value($1, 'stabilized_occupancy_pct', null, 140, 'Typed from the sponsor call')`, [ids.deal]))).rejects.toThrow(/above/);
  });
  test("a stale version is refused", async () => {
    const [a] = await db.query<{ id: string }>(`select id from assumptions where field_key = 'exit_cap_rate_pct'`);
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select fn_review($1, 'reject', null, null, 1)`, [a!.id]))).rejects.toThrow(/changed/);
  });
});

describe("runs and decisions", () => {
  test("a run is bound to the inputs approved right now", async () => {
    const payload = (hash: string) => ({
      engine_version: "1.0.0", policy_version: "policy-v1", policy_hash: "p", input_snapshot: {}, input_hash: "i1",
      assumptions_hash: hash, result: {}, result_hash: "r", verdict_code: "REJECT", signature: "s", metrics: [
        { scenario: "base", key: "equity_irr", value: null, status: "NOT_MEANINGFUL", unit: "%" },
      ], gates: [], checks: [],
    });
    await expect(asUser(db, ids.alice, (tx) => tx.query(`select fn_persist_run($1, $2)`, [ids.deal, JSON.stringify(payload("stale"))]))).rejects.toThrow(/changed/);
    const [{ h }] = (await db.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [ids.deal])) as [{ h: string }];
    const [{ id }] = (await asUser(db, ids.alice, (tx) => tx.query<{ id: string }>(`select fn_persist_run($1, $2) as id`, [ids.deal, JSON.stringify(payload(h))]))) as [{ id: string }];
    ids.run = id;
    const [again] = await asUser(db, ids.alice, (tx) => tx.query<{ id: string }>(`select fn_persist_run($1, $2) as id`, [ids.deal, JSON.stringify(payload(h))]));
    expect(again!.id).toBe(id);
  });
  test("a VALID metric without a value cannot be stored", async () => {
    await expect(db.query(`insert into run_metrics (run_id, scenario, metric_key, value, status, unit) values ($1, 'base', 'x', null, 'VALID', '%')`, [ids.run])).rejects.toThrow(/check/);
  });
  test("runs are append-only", async () => {
    await expect(db.query(`update runs set verdict_code = 'APPROVE' where id = $1`, [ids.run])).rejects.toThrow(/append-only/);
  });
  test("approving against a REJECT needs a written reason, and only an admin decides", async () => {
    await expect(asUser(db, ids.bob, (tx) => tx.query(`select fn_record_decision($1, 'approve', 'Strong sponsor and location', null, null)`, [ids.run]))).rejects.toThrow(/written reason/);
    const [d] = await asUser(db, ids.bob, (tx) => tx.query<{ id: string }>(`select fn_record_decision($1, 'approve', 'Strong sponsor and location', null, 'Committee accepts the thin spread for a strategic site') as id`, [ids.run]));
    expect(d!.id).toBeTruthy();
  });
  test("a decision on a run whose inputs changed is refused", async () => {
    await asUser(db, ids.alice, (tx) => tx.query(`select fn_enter_value($1, 'selling_costs_pct', null, 2.5, 'Broker quote for disposition')`, [ids.deal]));
    await expect(asUser(db, ids.bob, (tx) => tx.query(`select fn_record_decision($1, 'reject', 'Returns are too thin for the risk', null, null)`, [ids.run]))).rejects.toThrow(/inputs changed/);
  });
});

describe("audit", () => {
  test("every governed action left a link in an intact chain", async () => {
    const [v] = await db.query<{ ok: boolean; events: number }>(`select * from fn_verify_audit_chain()`);
    expect(v!.ok).toBe(true);
    expect(Number(v!.events)).toBeGreaterThan(8);
  });
  test("the audit log cannot be edited, and a tampered row is detected", async () => {
    await expect(db.query(`delete from audit_events`)).rejects.toThrow(/append-only/);
    await db.query(`alter table audit_events disable trigger audit_events_append_only`);
    await db.query(`update audit_events set payload = '{"tampered": true}' where seq = 2`);
    await db.query(`alter table audit_events enable trigger audit_events_append_only`);
    const [v] = await db.query<{ ok: boolean; broken_at: number }>(`select * from fn_verify_audit_chain()`);
    expect(v!.ok).toBe(false);
    expect(Number(v!.broken_at)).toBe(2);
  });
  test("an edited migration is refused on the next start", async () => {
    await db.query(`update schema_migrations set sha256 = 'edited' where name = '0001_schema.sql'`);
    await expect(migrate(db)).rejects.toThrow(/edited after it was applied/);
  });
});
