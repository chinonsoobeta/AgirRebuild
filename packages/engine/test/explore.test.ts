import { describe, expect, test } from "vitest";
import { POLICY_V1 } from "@agir/contracts";
import type { EngineInput, Gate } from "@agir/contracts";
import { breakeven, canonicalJson, DRIVERS, explore, gateSpecs, grid, shockInput, solveBreakeven, tornado, underwrite } from "../src/index.ts";
import { developmentDeal } from "./fixtures.ts";

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
    expect(failing).not.toContain("equity_multiple");
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
