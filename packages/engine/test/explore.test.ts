import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as engine from "../src/index.ts";
import { policyFor, POLICY_V1 } from "@agir/contracts";
import type { EngineInput, Gate } from "@agir/contracts";
import { breakeven, canonicalJson, DRIVERS, explore, gateSpecs, grid, shockInput, solveBreakeven, tornado, underwrite } from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const em = (r: { scenarios: { metrics: { key: string; value: number | null }[] }[] }) => r.scenarios[0]!.metrics.find((m) => m.key === "equity_multiple")!.value!;

describe("interactive sensitivity", () => {
  test("no shock reproduces the run exactly", () => {
    const run = underwrite(developmentDeal(), POLICY_V1);
    const x = explore(developmentDeal(), POLICY_V1, {});
    expect(canonicalJson(x.scenarios)).toBe(canonicalJson(run.scenarios));
    expect(x.verdict).toEqual(run.verdict);
  });
  test("each driver moves returns the way its direction says", () => {
    const base = em(explore(developmentDeal(), POLICY_V1, {}));
    for (const d of DRIVERS) {
      const up = em(explore(developmentDeal(), POLICY_V1, { [d.key]: d.swing }));
      if (d.direction === 1) expect(up, d.key).toBeGreaterThan(base);
      else expect(up, d.key).toBeLessThan(base);
    }
  });
  test("shocks are clamped to each driver's range", () => {
    const i = shockInput(developmentDeal(), { exitCapBps: 10_000, constructionMonths: -500 });
    expect(i.exitCapPct).toBeCloseTo(5 + 2, 9);
    expect(i.constructionMonths).toBe(12);
  });
  test("the tornado covers every driver, widest swing first", () => {
    const t = tornado(developmentDeal(), "equity_multiple");
    expect(t.rows.length).toBe(DRIVERS.length);
    const spreads = t.rows.map((r) => Math.abs(r.high! - r.low!));
    expect([...spreads].sort((a, b) => b - a)).toEqual(spreads);
  });
  test("the grid is steps by steps and centred on the base case", () => {
    const g = grid(developmentDeal(), "equity_multiple", "exitCapBps", "rentPct", 5);
    expect(g.cells.length).toBe(5);
    expect(g.cells[2]![2]).toBeCloseTo(em(explore(developmentDeal(), POLICY_V1, {})), 9);
  });
});

describe("breakeven: what would make each failing gate pass (scratch mode)", () => {
  const deal = developmentDeal;
  const rentsBy = (i: EngineInput, pct: number): EngineInput => ({ ...i, revenue: i.revenue.map((c) => ({ ...c, rentMonthly: c.rentMonthly! * (1 + pct / 100) })) });
  const gateOf = (r: ReturnType<typeof underwrite>, key: string): Gate => r.verdict.gates.find((x) => x.key === key)!;
  const row = (rows: ReturnType<typeof breakeven>["rows"], gate: string, driver: string) => rows.find((r) => r.gate === gate && r.driver === driver)!;

  test("a rent breakeven for profit on cost passes the gate when fed back, and one step less fails it", () => {
    const { rows } = breakeven(deal(), POLICY_V1);
    const r = row(rows, "profit_on_cost", "rentPct");
    expect(r.state).toBe("value");
    const pct = r.shock!;
    expect(pct).toBeGreaterThan(0);
    expect(Math.round(pct * 10) / 10).toBeCloseTo(pct, 9); // on the 0.1% grid
    expect(gateOf(underwrite(rentsBy(deal(), pct), POLICY_V1), "profit_on_cost").status).toBe("passed");
    expect(gateOf(underwrite(rentsBy(deal(), pct - 0.1), POLICY_V1), "profit_on_cost").status).toBe("failed");
    // The reported figure is the gate's own value at that point, and the rents echoed are the shocked ones.
    expect(r.actual).toBeCloseTo(underwrite(rentsBy(deal(), pct), POLICY_V1).verdict.gates.find((g) => g.key === "profit_on_cost")!.actual!, 9);
    const oneBed = r.to.find((e) => e.key === "rent" && e.item === "1BR")!;
    expect(oneBed).toMatchObject({ from: 2_200, unit: "$/unit/mo" });
    expect(oneBed.to).toBeCloseTo(2_200 * (1 + pct / 100), 6);
  });

  test("only failing gates get rows", () => {
    const run = underwrite(deal(), POLICY_V1);
    const failing = run.verdict.gates.filter((g) => g.status === "failed").map((g) => g.key);
    // Task 39: with the lease-up months now carrying fixed costs this deal also misses the base equity multiple, so every failing gate gets rows.
    expect(failing).toContain("equity_multiple");
    const { rows } = breakeven(deal(), POLICY_V1);
    expect([...new Set(rows.map((r) => r.gate))].sort()).toEqual([...failing].sort());
    expect(rows.length).toBe(failing.length * 5);
    expect([...new Set(rows.map((r) => r.driver))].sort()).toEqual(["costPct", "exitCapBps", "occupancyPts", "rateBps", "rentPct"]);
  });

  test("the stressed sizing coverage gate: exit cap has no effect, and rents are verified on the combined scenario", () => {
    const { rows } = breakeven(deal(), POLICY_V1);
    expect(row(rows, "stressed_sizing_dscr", "exitCapBps")).toMatchObject({ state: "no_effect", shock: null });
    const r = row(rows, "stressed_sizing_dscr", "rentPct");
    expect(r.state).toBe("value");
    const combined = (pct: number) => underwrite(rentsBy(deal(), pct), POLICY_V1).scenarios.find((s) => s.key === "combined")!.metrics.find((m) => m.key === "sizing_dscr")!.value!;
    expect(combined(r.shock!)).toBeGreaterThanOrEqual(1.2);
    expect(combined(r.shock! - 0.1)).toBeLessThan(1.2);
    expect(r.actual).toBeCloseTo(combined(r.shock!), 9);
  });

  test("a deal no rent increase within +100% saves reports out_of_range, with no number", () => {
    const d = deal();
    const big: EngineInput = { ...d, budget: { land: d.budget.land * 3, hard: d.budget.hard * 3, soft: d.budget.soft * 3, contingency: d.budget.contingency * 3, other: 0 }, senior: { ...d.senior, amount: d.senior.amount * 3 } };
    const r = row(breakeven(big, POLICY_V1).rows, "profit_on_cost", "rentPct");
    expect(r).toMatchObject({ state: "out_of_range", shock: null, actual: null, limit: 100 });
    expect(r.reason).toBe("Not within +100%");
    expect(r.to).toEqual([]);
  });

  test("search limits are wider than the chart ranges, and the chart clamps are untouched", () => {
    expect(DRIVERS.find((x) => x.key === "rentPct")!.max).toBe(20);
    expect(shockInput(deal(), { rentPct: 100 }).revenue[0]!.rentMonthly).toBeCloseTo(2_200 * 1.2, 9);
    const { rows } = breakeven(deal(), POLICY_V1);
    expect(rows.filter((r) => r.driver === "rentPct").every((r) => r.limit === 100)).toBe(true);
    expect(rows.filter((r) => r.driver === "costPct").every((r) => r.limit === -50)).toBe(true);
    expect(rows.filter((r) => r.driver === "exitCapBps").every((r) => r.limit === -300)).toBe(true);
    expect(rows.filter((r) => r.driver === "rateBps").every((r) => r.limit === -600)).toBe(true);
    expect(rows.filter((r) => r.driver === "occupancyPts").every((r) => r.limit === 5)).toBe(true);
  });

  test("a gate that does not move steadily with the input reports not_monotonic, with no number", () => {
    // Passes only in a middle band: pass at 4 to 6 of 10, fail at the end.
    const band = (n: number) => ({ pass: n >= 4 && n <= 6, value: n });
    expect(solveBreakeven(band, 10)).toEqual({ state: "not_monotonic" });
    // Monotonic: the first passing step is found exactly, and nothing else is reported.
    expect(solveBreakeven((n) => ({ pass: n >= 137, value: n }), 1000)).toEqual({ state: "value", n: 137 });
    expect(solveBreakeven((n) => ({ pass: false, value: n }), 1000)).toEqual({ state: "out_of_range" });
    expect(solveBreakeven((n) => ({ pass: false, value: 1.5 }), 1000)).toEqual({ state: "no_effect" });
  });

  test("an error-severity check is reported, because passing gates alone would not change the verdict", () => {
    const d = deal();
    const over: EngineInput = { ...d, senior: { ...d.senior, amount: 60_000_000 } };
    const { hardFails, rows } = breakeven(over, POLICY_V1);
    expect(hardFails.length).toBeGreaterThan(0);
    expect(hardFails.join(" ")).toMatch(/debt/i);
    expect(rows.length).toBeGreaterThan(0);
    expect(breakeven(deal(), POLICY_V1).hardFails).toEqual([]);
  });

  test("the gate list has one source: a gate added to it gets rows with no change to breakeven", () => {
    const specs = [...gateSpecs(POLICY_V1), { key: "yield_floor", label: "Yield floor", scenario: "base", metricKey: "yield_on_cost", threshold: 7 }];
    const { rows } = breakeven(deal(), POLICY_V1, specs);
    expect(rows.filter((r) => r.gate === "yield_floor").length).toBe(5);
    expect(row(rows, "yield_floor", "rentPct").state).toBe("value");
    // The verdict's own gates are the same list.
    expect(underwrite(deal(), POLICY_V1).verdict.gates.map((g) => g.key)).toEqual(gateSpecs(POLICY_V1).map((s) => s.key));
  });

  test("nothing is changed or kept: the input is untouched and a run is the same before and after", () => {
    const before = canonicalJson(underwrite(deal(), POLICY_V1));
    const input = deal();
    const snapshot = canonicalJson(input);
    breakeven(input, POLICY_V1);
    expect(canonicalJson(input)).toBe(snapshot);
    expect(canonicalJson(underwrite(deal(), POLICY_V1))).toBe(before);
  });
});

type OracleInputs = { unit_types: { name: string; units: number; price: number }[]; land: number; hard: number; soft: number; contingency: number; construction_months: number; presold_units_pct: number; deposit_pct: number; absorption_units_per_month: number; sales_commission_pct: number; closing_lag_months: number; unsold_carry_monthly: number; senior_commitment: number; senior_rate_pct: number; mezz_commitment: number; mezz_rate_pct: number; senior_presale_threshold_pct: number };
const fromOracle = (d: OracleInputs): EngineInput => ({
  ...allEquityDeal(), budget: { land: d.land, hard: d.hard, soft: d.soft, contingency: d.contingency, other: 0 },
  revenue: [], constructionMonths: d.construction_months, leaseUpMonths: 0, exit: "for_sale",
  senior: { amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 },
  ...(d.mezz_commitment > 0 ? { mezzanine: { amount: d.mezz_commitment, ratePct: d.mezz_rate_pct, amortYears: 30, ioMonths: 0 } } : {}),
  forSale: { units: d.unit_types.map((u, i) => ({ key: String(i), label: u.name, units: u.units, price: u.price })),
    presoldPct: d.presold_units_pct, depositPct: d.deposit_pct, absorptionPerMonth: d.absorption_units_per_month,
    commissionPct: d.sales_commission_pct, closingLagMonths: d.closing_lag_months, carryMonthly: d.unsold_carry_monthly,
    presaleThresholdPct: d.senior_presale_threshold_pct },
});


const saleOracle = (slug: string) => fromOracle(JSON.parse(readFileSync(new URL(`../../../oracles/for-sale/${slug}.outcome.json`, import.meta.url), "utf8")).inputs);
const heldExplore: EngineInput = { ...developmentDeal(), exit: "refinance_hold",
  refinance: { month: 36, amount: 29_000_000, ratePct: 5, amortYears: 30, ioMonths: 0 } };

describe("trying changes on a deal that sells its units (task 82)", () => {
  const kestrel = saleOracle("kestrel-row-townhomes");
  const alder = saleOracle("alder-court-condo");
  test("selects six sale drivers and preserves the rental list and shared objects", () => {
    for (const input of [kestrel, alder]) expect(engine.driversFor(input)).toBe(engine.SALE_DRIVERS);
    for (const input of [developmentDeal(), heldExplore]) expect(engine.driversFor(input)).toBe(DRIVERS);
    expect(engine.SALE_DRIVERS).toEqual([
      { key: "pricePct", label: "Sale prices", unit: "%", min: -20, max: 20, step: 2.5, swing: 10, direction: 1 },
      { key: "absorptionPct", label: "Sales pace", unit: "%", min: -50, max: 50, step: 5, swing: 30, direction: 1 },
      { key: "presalesPts", label: "Presales", unit: "pts", min: -30, max: 30, step: 5, swing: 15, direction: 1 },
      ...["costPct", "rateBps", "constructionMonths"].map((k) => DRIVERS.find((d) => d.key === k)),
    ]);
    for (const key of ["costPct", "rateBps", "constructionMonths"]) {
      expect(engine.SALE_DRIVERS.find((d) => d.key === key)).toBe(DRIVERS.find((d) => d.key === key));
    }
  });
  test("changes only sale prices for a price shock and never mutates stored input", () => {
    const before = canonicalJson(kestrel);
    expect(shockInput(kestrel, { pricePct: 10 })).toEqual({ ...kestrel, forSale: { ...kestrel.forSale!,
      units: kestrel.forSale!.units.map((u) => ({ ...u, price: u.price * 1.1 })) } });
    expect(canonicalJson(kestrel)).toBe(before);
  });
  test("clamps presales and ignores drivers from the other mode", () => {
    expect(shockInput(alder, { presalesPts: 30 }).forSale!.presoldPct).toBe(Math.min(100, alder.forSale!.presoldPct + 30));
    expect(shockInput({ ...alder, forSale: { ...alder.forSale!, presoldPct: 90 } }, { presalesPts: 30 }).forSale!.presoldPct).toBe(100);
    expect(shockInput(kestrel, { exitCapBps: 100, leaseUpMonths: 6 })).toEqual(kestrel);
    expect(shockInput(developmentDeal(), { pricePct: 10 })).toEqual(shockInput(developmentDeal(), {}));
    expect(() => grid(kestrel, "profit_on_cost_for_sale", "rateBps", "rentPct")).toThrow("This driver does not apply to this deal.");
  });
  test("explores the stored sale and reproduces the prices stress", () => {
    const policy = policyFor(kestrel);
    const { ledger: _l, equityFlows: _e, ...stored } = underwrite(kestrel, policy);
    expect(explore(kestrel, policy, {})).toEqual(stored);
    const stress = policy.stresses.find((s) => s.pricePct === -10)!;
    expect(stress).toBeDefined();
    expect(explore(kestrel, policy, { pricePct: -10 }).scenarios[0]!.metrics)
      .toEqual(stored.scenarios.find((s) => s.key === stress.key)!.metrics);
  });
  test("computes each tornado end from a hand-shocked sale input", () => {
    const t = tornado(kestrel, "profit_on_cost_for_sale");
    expect(t.rows).toHaveLength(6);
    for (const row of t.rows) for (const end of ["low", "high"] as const) {
      const n = row[end === "low" ? "lowShock" : "highShock"];
      const input = structuredClone(kestrel);
      switch (row.driver) {
        case "pricePct": input.forSale!.units.forEach((u) => { u.price *= 1 + n / 100; }); break;
        case "absorptionPct": input.forSale!.absorptionPerMonth *= 1 + n / 100; break;
        case "presalesPts": input.forSale!.presoldPct = Math.min(100, Math.max(0, input.forSale!.presoldPct + n)); break;
        case "costPct": for (const k of ["land", "hard", "soft", "contingency", "other"] as const) input.budget[k] *= 1 + n / 100; break;
        case "rateBps": input.senior.ratePct = Math.max(0, input.senior.ratePct + n / 100); if (input.mezzanine) input.mezzanine.ratePct = Math.max(0, input.mezzanine.ratePct + n / 100); break;
        case "constructionMonths": input.constructionMonths = Math.min(120, Math.max(0, input.constructionMonths + n)); break;
        default: throw new Error("Unexpected sale driver");
      }
      const metric = engine.forSaleMetrics(input, engine.buildForSaleLedger(input)).metrics.find((m) => m.key === "profit_on_cost_for_sale")!;
      expect(row[end], row.driver).toBe(metric.status === "VALID" ? metric.value : null);
    }
    expect(grid(kestrel, "profit_on_cost_for_sale", "rateBps", "pricePct").cells[2]![2]).toBe(t.base);
  });
  test("finds Alder's first passing price step and echoes each new price", () => {
    const policy = policyFor(alder);
    const result = breakeven(alder, policy);
    const gate = underwrite(alder, policy).verdict.gates.find((g) => g.scenario === "base" && g.metricKey === "profit_on_cost_for_sale")!;
    const row = result.rows.find((r) => r.gate === gate.key && r.driver === "pricePct")!;
    expect(row.state).toBe("value");
    const at = (n: number) => underwrite(engine.applyStress(alder, { key: "probe", label: "Probe", pricePct: n }), policy).verdict.gates.find((g) => g.key === gate.key)!;
    expect(at(row.shock!).status).toBe("passed");
    expect(at(row.shock! - 0.1).status).toBe("failed");
    expect(row.actual).toBe(at(row.shock!).actual);
    expect(row.to).toEqual(alder.forSale!.units.map((u) => ({ key: "price", item: u.label, from: u.price, to: u.price * (1 + row.shock! / 100), unit: "$" })));
    expect(result.hardFails).toEqual(underwrite(alder, policy).checks.filter((c) => c.severity === "error").map((c) => c.message));
    for (const r of result.rows) {
      expect(["value", "out_of_range", "no_effect", "not_monotonic"]).toContain(r.state);
      expect(["pricePct", "absorptionPct", "presalesPts", "costPct", "rateBps"]).toContain(r.driver);
    }
  });
  test("preserves every pinned rental and held output and the driver list", () => {
    const pins = JSON.parse(readFileSync(new URL("./sale-explore-pins.json", import.meta.url), "utf8"));
    expect(DRIVERS).toEqual(pins.drivers);
    for (const [name, input] of [["rental", developmentDeal()], ["held", heldExplore]] as const) {
      const got = { shock: shockInput(input, { rentPct: -10, rateBps: 100, constructionMonths: 3 }),
        exploration: explore(input, policyFor(input), {}), tornado: tornado(input, "equity_multiple"),
        grid: grid(input, "sizing_dscr", "rateBps", "rentPct"), breakeven: breakeven(input, policyFor(input)) };
      expect(JSON.parse(canonicalJson(got)), name).toEqual(pins[name]);
    }
  });
});
