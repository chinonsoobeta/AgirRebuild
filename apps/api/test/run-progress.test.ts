import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { POLICY_V1, RENTAL_HOLD_DRAFT, FOR_SALE_DRAFT } from "@agir/contracts";
import { createApp } from "../src/app.ts";

// Card R1: a run's progress streamed by stage, and stopping a run with the token only the starting browser holds.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
/** Awaited after each progress line; tests set it to hold a run at a stage. */
let pause: ((stage: string) => Promise<void>) | undefined;

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
async function signup(email: string, name: string, reviewMode?: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery", ...(reviewMode ? { reviewMode } : {}) }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

let alice: Session;
let solo: string;
const BASE: [string, number, string?][] = [
  ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
  ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
  ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
];
const HELD: [string, number, string?][] = [...BASE, ["refinance_and_hold", 1], ["refinance_month", 1], ["refinance_amount", 500_000], ["refinance_rate_pct", 5],
  ["refinance_amort_years", 30]];
const SOLD: [string, number, string?][] = [["sell_units", 1], ["land_cost", 100_000], ["hard_cost", 300_000], ["soft_cost", 20_000], ["contingency", 10_000],
  ["construction_months", 12], ["senior_loan_amount", 0], ["unit_count", 2, "TH"], ["unit_sale_price", 400_000, "TH"],
  ["presold_units_pct", 50], ["deposit_pct", 10], ["absorption_units_per_month", 1], ["sales_commission_pct", 4],
  ["closing_lag_months", 0], ["unsold_carry_monthly", 100]];
const put = async (s: Session, d: string, fieldKey: string, value: number, itemKey?: string) => {
  const r = await call(s, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Run progress test", ...(itemKey ? { itemKey } : {}) });
  expect(r.status, fieldKey).toBe(200);
};
const newDeal = async (s: Session, name: string, values: [string, number, string?][] = []) => {
  const d = (await call(s, "POST", `/api/workspaces/${solo}/deals`, { name, assetType: "Multifamily" })).json.id as string;
  for (const [f, v, i] of values) await put(s, d, f, v, i);
  return d;
};
const token = () => randomBytes(32).toString("base64url");
const streamed = (s: Session, d: string, headers: Record<string, string>) =>
  app.request(`/api/deals/${d}/runs?progress=1`, { method: "POST", headers: { "x-agir": "1", cookie: s.cookie, ...headers } });
const lines = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));
const runsOf = (d: string) => db.query<{ id: string; run_number: number; input_hash: string; engine_version: string }>(
  `select id, run_number, input_hash, engine_version from runs where deal_id = $1 order by run_number`, [d]);
const runEvents = (d: string) => db.query(`select seq from audit_events where deal_id = $1 and action like 'run.%'`, [d]);
const counted = async (d: string, status: string) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from assumptions where deal_id = $1 and status = $2`, [d, status]))[0]!.n);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false, progressHook: (stage) => pause?.(stage) });
  alice = await signup("alice@example.com", "Alice Analyst");
  solo = (await call(alice, "POST", "/api/workspaces", { name: "Progress", reviewMode: "solo" })).json.id;
}, 120_000);
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  pause = undefined;
  vi.restoreAllMocks();
});

describe("the streamed run", () => {
  test("streams the six stages in order with the run's facts, then done with the id of the recorded run", async () => {
    const d = await newDeal(alice, "Streamed sale", BASE);
    const res = await streamed(alice, d, { "x-run-token": token() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const got = lines(await res.text());
    expect(got.map((l) => l.stage ?? Object.keys(l)[0])).toEqual(["inputs", "ledger", "loans", "stresses", "gates", "record", "done"]);
    const [run] = await runsOf(d);
    expect(got.at(-1)).toEqual({ done: { id: run!.id } });
    expect(got[0].facts).toEqual({
      approved: await counted(d, "approved"), defaults: await counted(d, "default_accepted"), policyVersion: POLICY_V1.version, policyDraft: false,
      exit: "sale", constructionMonths: 0, holdYears: 1, stresses: POLICY_V1.stresses.length, inputHash: run!.input_hash, engineVersion: run!.engine_version,
    });
    expect(got[0].facts.approved).toBeGreaterThanOrEqual(BASE.length);
    // The engine's four stages finish together, at the moment it returns.
    const engine = got.slice(1, 5).map((l) => l.at);
    expect(new Set(engine).size).toBe(1);
    const times = got.slice(0, 6).map((l) => Date.parse(l.at));
    expect(times.every((t) => Number.isFinite(t))).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const l of got.slice(1, 6)) expect(Object.keys(l).sort()).toEqual(["at", "stage"]);
  });

  test("names a held deal's exit and draft policy, and leaves out the hold for units sold", async () => {
    const held = await newDeal(alice, "Streamed held", HELD);
    const heldFacts = lines(await (await streamed(alice, held, { "x-run-token": token() })).text())[0].facts;
    expect(heldFacts).toMatchObject({ exit: "refinance_hold", policyVersion: RENTAL_HOLD_DRAFT.version, policyDraft: true, holdYears: 1, constructionMonths: 0 });
    const sold = await newDeal(alice, "Streamed units sold", SOLD);
    const soldLines = lines(await (await streamed(alice, sold, { "x-run-token": token() })).text());
    expect(soldLines.at(-1)).toHaveProperty("done");
    expect(soldLines[0].facts).toMatchObject({ exit: "for_sale", policyVersion: FOR_SALE_DRAFT.version, policyDraft: true, constructionMonths: 12,
      stresses: FOR_SALE_DRAFT.stresses.length });
    expect(soldLines[0].facts).not.toHaveProperty("holdYears");
  });

  test("without progress=1 the answer is the same { id } as before", async () => {
    const d = await newDeal(alice, "Plain run", BASE);
    const r = await call(alice, "POST", `/api/deals/${d}/runs`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(r.json).toEqual({ id: (await runsOf(d))[0]!.id });
  });

  test("refuses a missing or malformed token with 422 before running", async () => {
    const d = await newDeal(alice, "Bad tokens", BASE);
    for (const headers of [{}, { "x-run-token": "short" }, { "x-run-token": `${token().slice(0, 42)}+` }, { "x-run-token": `${token()}A` }]) {
      const res = await streamed(alice, d, headers);
      expect(res.status).toBe(422);
    }
    expect(await runsOf(d)).toEqual([]);
  });

  test("refuses a token already in use with 409", async () => {
    const d = await newDeal(alice, "Token in use", BASE);
    const tok = token();
    let reached!: () => void, release!: () => void;
    const atRecord = new Promise<void>((r) => (reached = r)), held = new Promise<void>((r) => (release = r));
    // Held after the commit, so the second request's session check does not wait on the first run's transaction.
    pause = async (stage) => { if (stage === "record") { reached(); await held; } };
    const first = streamed(alice, d, { "x-run-token": tok });
    await atRecord;
    pause = undefined;
    const second = await streamed(alice, d, { "x-run-token": tok });
    expect(second.status).toBe(409);
    release();
    expect(lines(await (await first).text()).at(-1)).toHaveProperty("done");
    expect(await runsOf(d)).toHaveLength(1);
  });

  test("a blocked deal streams one error line with the plain route's status, sentence and readiness, and records nothing", async () => {
    const d = await newDeal(alice, "Blocked", BASE.slice(0, 3));
    const plain = await call(alice, "POST", `/api/deals/${d}/runs`);
    expect(plain.status).toBe(409);
    const got = lines(await (await streamed(alice, d, { "x-run-token": token() })).text());
    expect(got).toEqual([{ error: { status: 409, message: plain.json.error, detail: plain.json.detail } }]);
    expect(got[0].error.detail).toHaveProperty("readiness");
    expect(await runsOf(d)).toEqual([]);
    expect(await runEvents(d)).toEqual([]);
  });
});

describe("stopping a run", () => {
  test("a stop asked for during the run rolls it back: no run, no run event, and the next run takes its number", async () => {
    const d = await newDeal(alice, "Stopped", BASE);
    const tok = token();
    let reached!: () => void, release!: () => void;
    const atInputs = new Promise<void>((r) => (reached = r)), held = new Promise<void>((r) => (release = r));
    pause = async (stage) => { if (stage === "inputs") { reached(); await held; } };
    const res = streamed(alice, d, { "x-run-token": tok });
    await atInputs;
    // The run's transaction is open: the stop must answer without touching the database.
    const stop = await call(null, "POST", "/api/runs/stop", { token: tok });
    expect(stop).toMatchObject({ status: 200, json: { stopping: true } });
    release();
    const got = lines(await (await res).text());
    expect(got.map((l) => l.stage)).toEqual(["inputs", undefined]);
    expect(got.at(-1)).toEqual({ stopped: true });
    expect(await runsOf(d)).toEqual([]);
    expect(await runEvents(d)).toEqual([]);
    // The token is gone once the run has ended.
    expect((await call(null, "POST", "/api/runs/stop", { token: tok })).status).toBe(404);
    expect((await call(alice, "POST", `/api/deals/${d}/runs`)).status).toBe(200);
    expect((await runsOf(d)).map((r) => r.run_number)).toEqual([1]);
  });

  test("a stop asked for after the commit leaves the run recorded and the stream ends with done", async () => {
    const d = await newDeal(alice, "Stopped too late", BASE);
    const tok = token();
    let reached!: () => void, release!: () => void;
    const atRecord = new Promise<void>((r) => (reached = r)), held = new Promise<void>((r) => (release = r));
    pause = async (stage) => { if (stage === "record") { reached(); await held; } };
    const res = streamed(alice, d, { "x-run-token": tok });
    await atRecord;
    expect((await call(null, "POST", "/api/runs/stop", { token: tok })).status).toBe(200);
    release();
    expect(lines(await (await res).text()).at(-1)).toEqual({ done: { id: (await runsOf(d))[0]!.id } });
  });

  test("an unknown token gives 404 without touching the database", async () => {
    const query = vi.spyOn(db, "query");
    const transaction = vi.spyOn(db, "transaction");
    const r = await call(null, "POST", "/api/runs/stop", { token: token() });
    expect(r).toMatchObject({ status: 404, json: { error: "This run is not in progress. It may have finished." } });
    expect((await call(null, "POST", "/api/runs/stop", {})).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test("the run token never appears in an audit event or a log line", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); });
    }
    const d = await newDeal(alice, "Secret token", BASE);
    const tokens = [token(), token(), token()];
    await (await streamed(alice, d, { "x-run-token": tokens[0]! })).text();
    let reached!: () => void, release!: () => void;
    const atGates = new Promise<void>((r) => (reached = r)), held = new Promise<void>((r) => (release = r));
    pause = async (stage) => { if (stage === "gates") { reached(); await held; } };
    const res = streamed(alice, d, { "x-run-token": tokens[1]! });
    await atGates;
    await call(null, "POST", "/api/runs/stop", { token: tokens[1] });
    release();
    await (await res).text();
    pause = undefined;
    const blocked = await newDeal(alice, "Secret token blocked");
    await (await streamed(alice, blocked, { "x-run-token": tokens[2]! })).text();
    const events = await db.query<{ row: string }>(`select row_to_json(e)::text as row from audit_events e`);
    for (const tok of tokens) {
      expect(events.some((e) => e.row.includes(tok))).toBe(false);
      expect(logged.some((line) => line.includes(tok))).toBe(false);
    }
  });
});
