import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { type EngineInput } from "@agir/contracts";
import { buildLedger } from "@agir/engine";
import { createApp } from "../src/app.ts";

// Card R3: the refinance loan on a run's view, and the Canadian table cards for a deal outside Canada.
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
async function signup(email: string, name: string, reviewMode?: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery", ...(reviewMode ? { reviewMode } : {}) }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

let hal: Session, ws: string;
const put = async (d: string, fieldKey: string, value: number, itemKey?: string) =>
  expect((await call(hal, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Card R3 setup", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);
// A fictional fourplex: build, lease-up, and (when kept) a refinance at month 24.
const BASE: [string, number, string?][] = [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
  ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
  ["senior_rate_pct", 6], ["senior_amort_years", 30]];
const REFINANCE: [string, number][] = [["refinance_month", 24], ["refinance_rate_pct", 5], ["refinance_amort_years", 30], ["refinance_and_hold", 1]];
const newDeal = async (name: string, where: Record<string, string>) =>
  (await call(hal, "POST", `/api/workspaces/${ws}/deals`, { name, assetType: "Multifamily", location: "Fictional Township", ...where })).json.id as string;
const runDeal = async (d: string) => {
  expect((await call(hal, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
  const r = await call(hal, "POST", `/api/deals/${d}/runs`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.id as string;
};
const storedInput = async (runId: string) => (await db.query<{ input: EngineInput }>(`select input_snapshot->'input' as input from runs where id = $1`, [runId]))[0]!.input;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  hal = await signup("r3-hal@example.com", "Hal Fictional", "solo");
  ws = (await call(hal, "GET", "/api/me")).json.workspaces[0].id;
});

describe("the refinance loan on a run's view", () => {
  let held: string, stated: string;
  beforeAll(async () => {
    const d = await newDeal("Fictional Kept Fourplex", { province: "AB" });
    for (const [f, v, i] of BASE) await put(d, f, v, i);
    for (const [f, v] of REFINANCE) await put(d, f, v);
    await put(d, "refinance_ltv_pct", 65);
    held = await runDeal(d);
    const s = await newDeal("Fictional Stated Fourplex", { province: "AB" });
    for (const [f, v, i] of BASE) await put(s, f, v, i);
    for (const [f, v] of REFINANCE) await put(s, f, v);
    await put(s, "refinance_amount", 1500000);
    stated = await runDeal(s);
  }, 120_000);

  test("a held run has the engine's own refinance, worked out on its stored input", async () => {
    const view = (await call(hal, "GET", `/api/runs/${held}`)).json;
    const r = buildLedger(await storedInput(held)).refinance!;
    expect(r).not.toBeNull();
    expect(view.refinance).toEqual({ loan: r.newAmount, value: r.value, month: r.month, ltvPct: 65, stated: false });
    expect(view.refinance.month).toBe(24);
  });

  test("a stated amount is the loan, and says so", async () => {
    const view = (await call(hal, "GET", `/api/runs/${stated}`)).json;
    const r = buildLedger(await storedInput(stated)).refinance!;
    expect(view.refinance).toEqual({ loan: 1500000, value: r.value, month: 24, ltvPct: null, stated: true });
  });

  test("a sold deal's run has none", async () => {
    const d = await newDeal("Fictional Sold Fourplex", { province: "AB" });
    for (const [f, v, i] of BASE) await put(d, f, v, i);
    const view = (await call(hal, "GET", `/api/runs/${await runDeal(d)}`)).json;
    expect(view.result.scenarios[0].metrics.some((m: any) => m.key === "stated_value")).toBe(false);
    expect(view).not.toHaveProperty("refinance");
  }, 60_000);

  test("a run recorded by another engine version has none", async () => {
    await db.query(`alter table runs disable trigger runs_append_only`);
    try {
      await db.query(`update runs set engine_version = '0.0.1-older' where id = $1`, [held]);
      const view = (await call(hal, "GET", `/api/runs/${held}`)).json;
      expect(view.engineVersion).toBe("0.0.1-older");
      expect(view).not.toHaveProperty("refinance");
    } finally {
      await db.query(`alter table runs enable trigger runs_append_only`);
    }
  });
});

describe("the Canadian table cards for a deal outside Canada", () => {
  const OUTSIDE = "these tables are for deals in Canada; enter the amount yourself";
  const setup = async (where: Record<string, string>) => {
    const d = await newDeal("Fictional table rental", where);
    for (const [fieldKey, value, itemKey] of [["refinance_and_hold", 1], ["refinance_month", 24], ["unit_count", 12, "Residential"], ["land_cost", 750000],
      ["refinance_ltv_pct", 85], ["refinance_amort_years", 40], ["refinance_mli_select_points", 50]] as [string, number, string?][]) await put(d, fieldKey, value, itemKey);
    return (await call(hal, "GET", `/api/deals/${d}/review`)).json;
  };

  test("a deal in the United States is told the tables are for deals in Canada, on every card", async () => {
    const r = await setup({ country: "US", currency: "USD" });
    expect(r.proposals.length).toBeGreaterThanOrEqual(3);
    for (const p of r.proposals) {
      expect(p.options).toEqual([]);
      expect(p.unavailable).toBe(OUTSIDE);
    }
  });

  test("a Canadian deal with no province keeps the sentence it had", async () => {
    const d = await newDeal("Fictional no-province rental", {});
    expect((await call(hal, "GET", `/api/deals/${d}`)).json.deal).toMatchObject({ country: "CA", province: null });
    for (const [fieldKey, value, itemKey] of [["refinance_and_hold", 1], ["refinance_month", 24], ["unit_count", 12, "Residential"], ["land_cost", 750000],
      ["refinance_ltv_pct", 85], ["refinance_amort_years", 40], ["refinance_mli_select_points", 50]] as [string, number, string?][]) await put(d, fieldKey, value, itemKey);
    const r = (await call(hal, "GET", `/api/deals/${d}/review`)).json;
    expect(r.proposals.length).toBeGreaterThanOrEqual(3);
    for (const p of r.proposals) {
      expect(p.options).toEqual([]);
      expect(p.unavailable).toBe("the deal has no province");
    }
  });
});
