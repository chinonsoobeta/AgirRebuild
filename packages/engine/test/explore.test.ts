import { describe, expect, test } from "vitest";
import { POLICY_V1 } from "@agir/contracts";
import { canonicalJson, DRIVERS, explore, grid, shockInput, tornado, underwrite } from "../src/index.ts";
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
