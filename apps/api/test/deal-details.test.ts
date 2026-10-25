import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asUser, fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain } from "@agir/worker";
import { createApp } from "../src/app.ts";

// Card Y2: older audit events, when an invitation ends, what each client confirmed, units and exit on the deal, and a fuller share page.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
const work = () => drain({ db, store });

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

let alice: Session, bob: Session, dana: Session;
let solo: string, team: string;
const BASE: [string, number, string?][] = [
  ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
  ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
  ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
];
const put = async (s: Session, d: string, fieldKey: string, value: number, itemKey?: string) => {
  const r = await call(s, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Deal details test", ...(itemKey ? { itemKey } : {}) });
  expect(r.status, fieldKey).toBe(200);
  return r.json;
};
const newDeal = async (s: Session, w: string, name: string, extra: object = {}) =>
  (await call(s, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", ...extra })).json.id as string;
const row = async (d: string, fieldKey: string, itemKey = "") =>
  (await db.query<{ id: string; version: number; status: string }>(`select id, version, status from assumptions where deal_id = $1 and field_key = $2 and item_key = $3`, [d, fieldKey, itemKey]))[0]!;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Analyst");
  bob = await signup("bob@example.com", "Bob Approver");
  dana = await signup("dana.client@example.com", "Dana Client");
  solo = (await call(alice, "POST", "/api/workspaces", { name: "Details", reviewMode: "solo" })).json.id;
  team = (await call(alice, "POST", "/api/workspaces", { name: "Details team" })).json.id;
  expect((await call(alice, "POST", `/api/workspaces/${team}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
});
afterAll(async () => {
  await db.close();
});

describe("older audit events", () => {
  let d: string;
  beforeAll(async () => {
    d = await newDeal(alice, solo, "Audit pages");
    for (const [f, v, i] of BASE) await put(alice, d, f, v, i);
  });
  test("before returns the events whose seq is below it, newest first; nothing older is an empty array", async () => {
    const all = (await call(alice, "GET", `/api/deals/${d}/audit`)).json;
    expect(all.length).toBeGreaterThan(5);
    const seqs = all.map((e: any) => Number(e.seq));
    const mid = seqs[Math.floor(seqs.length / 2)]!;
    const older = await call(alice, "GET", `/api/deals/${d}/audit?before=${mid}`);
    expect(older.status).toBe(200);
    expect(older.json).toEqual(all.filter((e: any) => Number(e.seq) < mid));
    expect(older.json.length).toBeGreaterThan(0);
    const oldest = Math.min(...seqs);
    const none = await call(alice, "GET", `/api/deals/${d}/audit?before=${oldest}`);
    expect(none).toMatchObject({ status: 200, json: [] });
  });
  test("before is a positive whole number, or the answer is 422", async () => {
    for (const bad of ["0", "-3", "abc", "1.5", "", "1e3"]) {
      expect((await call(alice, "GET", `/api/deals/${d}/audit?before=${encodeURIComponent(bad)}`)).status, bad).toBe(422);
    }
  });
});

describe("when an invitation ends", () => {
  let d: string;
  const invite = async () => {
    const made = await call(alice, "POST", `/api/deals/${d}/invites`);
    expect(made.status).toBe(200);
    return { id: made.json.id as string, secret: (made.json.url as string).slice(3) };
  };
  const gone = { error: "This invitation is not available. It may have been used, revoked or expired." };
  beforeAll(async () => {
    d = await newDeal(alice, solo, "Invite details");
  });
  test("the signed-out page names the workspace, the deal and when the link ends", async () => {
    const { id, secret } = await invite();
    const page = await call(null, "GET", `/api/invite/${secret}`);
    expect(page.status).toBe(200);
    const [stored] = await db.query<{ expires_at: string }>(`select expires_at from client_invites where id = $1`, [id]);
    expect(Object.keys(page.json).sort()).toEqual(["deal", "expiresAt", "workspace"]);
    expect(page.json).toMatchObject({ workspace: "Details", deal: "Invite details" });
    expect(new Date(page.json.expiresAt).getTime()).toBe(new Date(stored!.expires_at).getTime());
  });
  test("a used or revoked invitation is 404", async () => {
    const used = await invite();
    const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
      body: JSON.stringify({ email: "ivy.client@example.com", name: "Ivy Client", password: "correct horse battery", invite: used.secret }) });
    expect(res.status).toBe(200);
    const revoked = await invite();
    expect((await call(alice, "POST", `/api/invites/${revoked.id}/revoke`)).status).toBe(200);
    for (const { secret } of [used, revoked]) expect(await call(null, "GET", `/api/invite/${secret}`)).toMatchObject({ status: 404, json: gone });
  });
  test("the app role still cannot call the peek function", async () => {
    const me = (await call(alice, "GET", "/api/me")).json.user.id;
    await expect(asUser(db, me, (tx) => tx.query(`select * from fn_peek_client_invite($1)`, ["x"]))).rejects.toThrow(/permission denied/);
  });
});

describe("what each client has confirmed", () => {
  let d: string;
  const clients = async () => {
    const r = await call(alice, "GET", `/api/deals/${d}/clients`);
    expect(r.status).toBe(200);
    return r.json;
  };
  beforeAll(async () => {
    d = await newDeal(alice, solo, "Client confirmations");
    await put(alice, d, "exit_cap_rate_pct", 10);
    expect((await call(alice, "POST", `/api/deals/${d}/clients`, { email: "dana.client@example.com" })).status).toBe(200);
  });
  test("none at first, then the client's confirmation and its time; a changed value takes it away", async () => {
    expect(await clients()).toEqual([expect.objectContaining({ name: "Dana Client", confirmed: 0, last_confirmed_at: null })]);
    const cap = await row(d, "exit_cap_rate_pct");
    expect((await call(dana, "POST", `/api/assumptions/${cap.id}/client-confirm`, { version: cap.version })).status).toBe(200);
    const [stored] = await db.query<{ at: string }>(`select client_confirmed_at as at from assumptions where id = $1`, [cap.id]);
    const [after] = await clients();
    expect(after.confirmed).toBe(1);
    expect(new Date(after.last_confirmed_at).getTime()).toBe(new Date(stored!.at).getTime());
    const now = await row(d, "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${cap.id}/review`, { action: "modify", value: 9, reason: "The broker revised the cap rate", version: now.version })).status).toBe(200);
    expect(await clients()).toEqual([expect.objectContaining({ confirmed: 0, last_confirmed_at: null })]);
  });
});

describe("units and exit on the deal", () => {
  const overview = async (d: string) => {
    const r = await call(alice, "GET", `/api/deals/${d}`);
    expect(r.status).toBe(200);
    return { units: r.json.units, exit: r.json.exit };
  };
  test("null while an item or a flag waits for review, then set", async () => {
    const d = await newDeal(alice, team, "Team units");
    expect(await overview(d)).toEqual({ units: null, exit: "sale" });
    await put(alice, d, "unit_count", 10, "A");
    await put(alice, d, "unit_count", 5, "B");
    expect((await overview(d)).units).toBe(15);
    await db.query(`update assumptions set status = 'needs_review' where deal_id = $1 and field_key = 'unit_count' and item_key = 'B'`, [d]);
    expect((await overview(d)).units).toBeNull();
    const b = await row(d, "unit_count", "B");
    expect((await call(alice, "POST", `/api/assumptions/${b.id}/review`, { action: "approve", version: b.version })).status).toBe(200);
    expect((await overview(d)).units).toBe(15);
    expect((await put(alice, d, "refinance_and_hold", 1)).status).toBe("awaiting_second_approval");
    expect((await overview(d)).exit).toBeNull();
    const h = await row(d, "refinance_and_hold");
    expect((await call(bob, "POST", `/api/assumptions/${h.id}/review`, { action: "second_approve", version: h.version })).status).toBe(200);
    expect(await overview(d)).toEqual({ units: 15, exit: "refinance_hold" });
    await put(alice, d, "sell_units", 1);
    expect((await overview(d)).exit).toBeNull();
    const s = await row(d, "sell_units");
    expect((await call(bob, "POST", `/api/assumptions/${s.id}/review`, { action: "second_approve", version: s.version })).status).toBe(200);
    expect((await overview(d)).exit).toBeNull();
  });
  test("a sold deal is for_sale; a flag at 0 is a sale; a deal with no units is null, never 0", async () => {
    const sold = await newDeal(alice, solo, "Sold units");
    await put(alice, sold, "sell_units", 1);
    expect(await overview(sold)).toEqual({ units: null, exit: "for_sale" });
    const kept = await newDeal(alice, solo, "Not kept");
    await put(alice, kept, "refinance_and_hold", 0);
    await put(alice, kept, "unit_count", 4, "Residential");
    expect(await overview(kept)).toEqual({ units: 4, exit: "sale" });
  });
  test("counts the unit types the run uses: a stated total is not added to them, and one type written two ways is no count", async () => {
    const d = await newDeal(alice, solo, "Total and types");
    await put(alice, d, "unit_count", 12);
    expect((await overview(d)).units).toBeNull();
    await put(alice, d, "unit_count", 8, "1BR");
    await put(alice, d, "unit_count", 4, "2BR");
    expect((await overview(d)).units).toBe(12);
    await put(alice, d, "unit_count", 8, "1 BR");
    expect((await overview(d)).units).toBeNull();
  });
});

describe("a fuller share page", () => {
  let d: string, runId: string, artifact: string;
  const FIGURES = ["total_development_cost", "cost_per_unit", "required_equity", "loan_to_cost", "dcr_after_refinance", "sizing_dscr",
    "development_spread", "yield_on_cost", "profit_on_cost"];
  const share = async () => {
    const made = await call(alice, "POST", `/api/artifacts/${artifact}/share-links`, { term: "7d" });
    expect(made.status).toBe(200);
    return { id: made.json.id as string, secret: String(made.json.url).slice(3), expiresAt: made.json.expiresAt as string };
  };
  beforeAll(async () => {
    d = await newDeal(alice, solo, "Held details", { location: "Burnaby", province: "BC" });
    for (const [f, v, i] of [...BASE, ["refinance_and_hold", 1], ["refinance_month", 1], ["refinance_amount", 500_000], ["refinance_rate_pct", 5],
      ["refinance_amort_years", 30]] as [string, number, string?][]) await put(alice, d, f, v, i);
    const made = await call(alice, "POST", `/api/deals/${d}/runs`);
    expect(made.status).toBe(200);
    runId = made.json.id;
    artifact = (await call(alice, "POST", `/api/runs/${runId}/artifacts`, { kind: "ic_memo", format: "pdf" })).json.id;
    await work();
    expect((await call(alice, "GET", `/api/deals/${d}/artifacts`)).json.find((a: any) => a.id === artifact).status).toBe("ready");
  }, 120_000);

  test("a held run's page carries what the report prints, read from the stored run", async () => {
    const link = await share();
    const page = await call(null, "GET", `/api/share/${link.secret}`);
    expect(page.status).toBe(200);
    const [stored] = await db.query<{ result: any; input_snapshot: any; created_at: string }>(`select result, input_snapshot, created_at from runs where id = $1`, [runId]);
    const [deal] = await db.query<{ location: string; currency: string }>(`select location, currency from deals where id = $1`, [d]);
    const view = (await call(alice, "GET", `/api/runs/${runId}`)).json;
    // Card R2: the page also lists the link's files.
    const { figures, verdict, runAt, files, ...rest } = page.json;
    expect(files).toMatchObject([{ id: artifact, kind: "ic_memo", format: "pdf", lang: "en" }]);
    expect(rest).toEqual({
      deal: "Held details", kind: "ic_memo", format: "pdf", runNumber: 1, expiresAt: link.expiresAt,
      workspace: "Details", location: deal!.location, province: "BC", currency: deal!.currency, units: 10, exit: "refinance_hold",
      policyDraft: view.policyDraft, errorChecks: stored!.result.checks.filter((c: any) => c.severity === "error").length,
      exitCapPct: stored!.input_snapshot.input.exitCapPct,
    });
    expect(rest.exitCapPct).toBe(10);
    expect(new Date(runAt).getTime()).toBe(new Date(stored!.created_at).getTime());
    const v = stored!.result.verdict;
    expect(verdict).toEqual({ code: v.code, gates: v.gates, hardFailReasons: v.hardFailReasons, headline: v.headline, explanation: v.explanation });
    const metrics: any[] = stored!.result.scenarios[0].metrics;
    const expected = FIGURES.flatMap((key) => metrics.filter((m) => m.key === key))
      .map((m) => JSON.parse(JSON.stringify({ key: m.key, unit: m.unit, value: m.value, status: m.status, reason: m.reason })));
    expect(figures).toEqual(expected);
    expect(figures.map((f: any) => f.key)).toEqual(FIGURES.filter((k) => metrics.some((m) => m.key === k)));
    const empty = figures.find((f: any) => f.value === null);
    expect(empty).toBeDefined();
    expect(empty.status).not.toBe("VALID");
    expect(empty.reason).toEqual(expect.any(String));
  });

  test("a sold run's page carries the profit figures of a sale, and no exit cap rate", async () => {
    const sold = await newDeal(alice, solo, "Sold details", { location: "Moncton", province: "NB" });
    for (const [f, v, i] of [["sell_units", 1], ["land_cost", 100_000], ["hard_cost", 300_000], ["soft_cost", 20_000], ["contingency", 10_000],
      ["construction_months", 12], ["senior_loan_amount", 0], ["unit_count", 2, "TH"], ["unit_sale_price", 400_000, "TH"],
      ["presold_units_pct", 50], ["deposit_pct", 10], ["absorption_units_per_month", 1], ["sales_commission_pct", 4],
      ["closing_lag_months", 0], ["unsold_carry_monthly", 100]] as [string, number, string?][]) await put(alice, sold, f, v, i);
    const made = await call(alice, "POST", `/api/deals/${sold}/runs`);
    expect(made.status).toBe(200);
    const memo = (await call(alice, "POST", `/api/runs/${made.json.id}/artifacts`, { kind: "ic_memo", format: "pdf" })).json.id;
    await work();
    const link = await call(alice, "POST", `/api/artifacts/${memo}/share-links`, { term: "7d" });
    expect(link.status).toBe(200);
    const page = await call(null, "GET", `/api/share/${String(link.json.url).slice(3)}`);
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ units: 2, exit: "for_sale" });
    expect(page.json).not.toHaveProperty("exitCapPct");
    const sale = page.json.figures.filter((f: any) => ["profit_on_cost_for_sale", "margin_on_revenue"].includes(f.key));
    expect(sale.map((f: any) => [f.key, f.status])).toEqual([["profit_on_cost_for_sale", "VALID"], ["margin_on_revenue", "VALID"]]);
  }, 120_000);

  test("a revoked link still answers 404 with no fields", async () => {
    const link = await share();
    expect((await call(alice, "POST", `/api/share-links/${link.id}/revoke`)).status).toBe(200);
    const page = await call(null, "GET", `/api/share/${link.secret}`);
    expect(page).toMatchObject({ status: 404, json: { error: "This link is not available. It may have expired or been revoked." } });
    expect(Object.keys(page.json)).toEqual(["error"]);
  });
});
