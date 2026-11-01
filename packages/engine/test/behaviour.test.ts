// Behaviour rules (plan E18): relations that must hold whatever the numbers are.
// No expected value here comes from the engine's output: each is a relation between two
// runs, a bound from the specification, or arithmetic shown in a comment.
// The seed is fixed so a failure is the same failure on every machine.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FOR_SALE_DRAFT, POLICY_V1, RENTAL_HOLD_DRAFT, type EngineInput, type Metric, type Policy, type RunResult, type StressPreset } from "@agir/contracts";
import { assemble, buildForSaleLedger, buildLedger, canonicalJson, EngineInputError, underwrite, validateInput } from "../src/index.ts";
import { placeConstructionCosts } from "../src/ledger.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const SEED = 20261031;
// The mutation run repeats these tests on thousands of changed copies of the engine, so it asks for a tenth of the cases.
// With this seed they are the first cases of the full run. The release gate always runs the full count.
const RUNS_SCALE = Number(process.env.BEHAVIOUR_RUNS_SCALE ?? 1);
const check = <T>(arb: fc.Arbitrary<T>, numRuns: number, body: (x: T) => void) =>
  fc.assert(fc.property(arb, body), { numRuns: Math.max(5, Math.round(numRuns * RUNS_SCALE)), seed: SEED, endOnFailure: true });

const money = (min: number, max: number) => fc.integer({ min, max });

// ---- Generated deals, around the shapes in fixtures.ts ------------------------------------------

const rentalDeal: fc.Arbitrary<EngineInput> = fc
  .record({
    land: money(1_000_000, 10_000_000),
    hard: money(5_000_000, 40_000_000),
    softPct: fc.integer({ min: 5, max: 20 }),
    contPct: fc.integer({ min: 0, max: 10 }),
    otherCost: fc.oneof(fc.constant(0), money(1, 500_000), money(-500_000, -1)),
    named: fc.option(fc.record({ dc: money(0, 500_000), ltt: money(0, 200_000), gst: money(0, 800_000) }), { nil: undefined }),
    lines: fc.array(fc.record({ units: fc.integer({ min: 2, max: 120 }), rent: money(1_200, 4_000) }), { minLength: 1, maxLength: 3 }),
    otherIncome: money(0, 200_000),
    c: fc.integer({ min: 0, max: 30 }),
    l: fc.integer({ min: 0, max: 18 }),
    h: fc.integer({ min: 1, max: 8 }),
    occ: fc.integer({ min: 80, max: 100 }),
    opex: fc.oneof(
      fc.record({ expenseRatioPct: fc.integer({ min: 20, max: 60 }) }),
      fc.record({ fixedOpexAnnual: money(100_000, 2_000_000), variableExpensePct: fc.integer({ min: 0, max: 15 }) }),
    ),
    tax: fc.option(money(0, 300_000), { nil: undefined }),
    rentGrowth: fc.integer({ min: 0, max: 4 }),
    expGrowth: fc.integer({ min: 0, max: 4 }),
    ramp: fc.boolean(),
    sCurve: fc.boolean(),
    cap: fc.integer({ min: 40, max: 80 }),
    selling: fc.integer({ min: 0, max: 5 }),
    loanPct: fc.integer({ min: 0, max: 70 }),
    rate: fc.integer({ min: 0, max: 10 }),
    amort: fc.integer({ min: 20, max: 40 }),
    io: fc.integer({ min: 0, max: 48 }),
    mezzPct: fc.option(fc.integer({ min: 2, max: 12 }), { nil: undefined }),
    mezzRate: fc.integer({ min: 8, max: 14 }),
    waterfall: fc.option(fc.record({ lpSharePct: fc.integer({ min: 50, max: 95 }), preferredReturnPct: fc.integer({ min: 0, max: 12 }), gpPromotePct: fc.integer({ min: 0, max: 30 }) }), { nil: undefined }),
  })
  .map((p) => {
    const soft = Math.round((p.hard * p.softPct) / 100);
    const contingency = Math.round((p.hard * p.contPct) / 100);
    const base = p.land + p.hard + soft + contingency;
    const deal: EngineInput = {
      budget: {
        land: p.land, hard: p.hard, soft, contingency, other: p.otherCost,
        ...(p.named ? { developmentCharges: p.named.dc, landTransferTax: p.named.ltt, gstHstNet: p.named.gst } : {}),
      },
      revenue: p.lines.map((x, i) => ({ key: `U${i}`, label: `U${i}`, basis: "per_unit" as const, units: x.units, rentMonthly: x.rent })),
      otherIncomeAnnual: p.otherIncome,
      constructionMonths: p.c,
      leaseUpMonths: p.l,
      holdYears: p.h,
      stabilizedOccupancyPct: p.occ,
      ...p.opex,
      ...(p.tax !== undefined ? { propertyTaxAnnual: p.tax } : {}),
      rentGrowthPct: p.rentGrowth,
      expenseGrowthPct: p.expGrowth,
      leaseUpRamp: p.ramp,
      sCurveDraws: p.sCurve,
      exitCapPct: p.cap / 10,
      sellingCostsPct: p.selling,
      senior: { amount: Math.round((base * p.loanPct) / 100), ratePct: p.rate, amortYears: p.amort, ioMonths: p.io },
      ...(p.mezzPct !== undefined ? { mezzanine: { amount: Math.round((base * p.mezzPct) / 100), ratePct: p.mezzRate, amortYears: 30, ioMonths: 0 } } : {}),
      ...(p.waterfall ? { waterfall: p.waterfall } : {}),
      stated: {},
    };
    return deal;
  });

/** A rental deal that is kept and refinanced, sized by amount or by loan-to-value. */
const holdDeal: fc.Arbitrary<EngineInput> = fc
  .record({
    deal: rentalDeal,
    at: fc.double({ min: 0, max: 0.999, noNaN: true }),
    sizing: fc.oneof(fc.record({ amountPct: fc.integer({ min: 40, max: 80 }) }), fc.record({ ltvPct: fc.integer({ min: 50, max: 80 }) })),
    rate: fc.integer({ min: 3, max: 8 }),
    amort: fc.integer({ min: 25, max: 40 }),
    io: fc.integer({ min: 0, max: 24 }),
    premium: fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
  })
  .map(({ deal, at, sizing, rate, amort, io, premium }) => {
    const S = deal.constructionMonths + deal.leaseUpMonths;
    const T = S + 12 * deal.holdYears - 1;
    const b = deal.budget;
    const cost = b.land + b.hard + b.soft + b.contingency;
    const { waterfall: _w, ...rest } = deal;
    return {
      ...rest,
      exit: "refinance_hold" as const,
      refinance: {
        month: S + Math.floor(at * (T - S)),
        ...("amountPct" in sizing ? { amount: Math.round((cost * sizing.amountPct) / 100) } : { ltvPct: sizing.ltvPct }),
        ratePct: rate, amortYears: amort, ioMonths: io,
        ...(premium !== undefined ? { insurancePremiumPct: premium } : {}),
      },
    };
  });

const saleDeal: fc.Arbitrary<EngineInput> = fc
  .record({
    land: money(200_000, 3_000_000),
    hard: money(1_000_000, 12_000_000),
    soft: money(0, 1_000_000),
    contingency: money(0, 500_000),
    c: fc.integer({ min: 0, max: 24 }),
    lines: fc.array(fc.record({ units: fc.integer({ min: 1, max: 30 }), price: money(300_000, 900_000) }), { minLength: 1, maxLength: 3 }),
    presold: fc.integer({ min: 0, max: 100 }),
    deposit: fc.integer({ min: 0, max: 20 }),
    absorption: fc.integer({ min: 5, max: 60 }),
    commission: fc.integer({ min: 0, max: 6 }),
    lag: fc.integer({ min: 0, max: 6 }),
    carry: money(0, 2_000),
    loanPct: fc.integer({ min: 0, max: 70 }),
    rate: fc.integer({ min: 0, max: 10 }),
    mezzPct: fc.option(fc.integer({ min: 2, max: 12 }), { nil: undefined }),
    mezzRate: fc.integer({ min: 8, max: 14 }),
    waterfall: fc.option(fc.record({ lpSharePct: fc.integer({ min: 50, max: 95 }), preferredReturnPct: fc.integer({ min: 0, max: 12 }), gpPromotePct: fc.integer({ min: 0, max: 30 }) }), { nil: undefined }),
  })
  .map((p) => {
    const base = p.land + p.hard + p.soft + p.contingency;
    const deal: EngineInput = {
      ...allEquityDeal(),
      budget: { land: p.land, hard: p.hard, soft: p.soft, contingency: p.contingency, other: 0 },
      revenue: [],
      exit: "for_sale",
      constructionMonths: p.c,
      leaseUpMonths: 0,
      senior: { amount: Math.round((base * p.loanPct) / 100), ratePct: p.rate, ioMonths: 0 },
      ...(p.mezzPct !== undefined ? { mezzanine: { amount: Math.round((base * p.mezzPct) / 100), ratePct: p.mezzRate, amortYears: 30, ioMonths: 0 } } : {}),
      ...(p.waterfall ? { waterfall: p.waterfall } : {}),
      forSale: {
        units: p.lines.map((x, i) => ({ key: `T${i}`, label: `T${i}`, units: x.units, price: x.price })),
        presoldPct: p.presold, depositPct: p.deposit, absorptionPerMonth: p.absorption / 10,
        commissionPct: p.commission, closingLagMonths: p.lag, carryMonthly: p.carry,
      },
    };
    return deal;
  });

const policyOf = (d: EngineInput): Policy => (d.exit === "for_sale" ? FOR_SALE_DRAFT : d.exit === "refinance_hold" ? RENTAL_HOLD_DRAFT : POLICY_V1);
const metric = (r: RunResult, key: string, scenario = "base"): Metric => r.scenarios.find((s) => s.key === scenario)!.metrics.find((x) => x.key === key)!;
const CENT = 0.01;

// ---- Rule 1 and 2: sources equal uses, and signs ---------------------------------------------------

describe("rule 1: sources equal uses at stabilization, within a cent per line", () => {
  const rental = (d: EngineInput) => {
    const L = buildLedger(d);
    // Uses = costs + lease-up operating costs + interest (spec: total development cost). Sources = equity + debt at S.
    expect(Math.abs(L.tdc - (L.costsBeforeFinancing + L.leaseupOperatingCost + L.capitalizedInterest))).toBeLessThanOrEqual(CENT);
    expect(Math.abs(L.requiredEquity + L.drawnDebtAtS - L.tdc)).toBeLessThanOrEqual(CENT);
    // Spec: at S, unused commitment is zero unless equity is zero.
    if (L.converged && L.requiredEquity > CENT) expect(L.drawnDebtAtS).toBeGreaterThanOrEqual(L.commitments - CENT);
    if (L.S > 0) {
      const before = L.rows.slice(0, L.S);
      const total = (k: "costDraw" | "equityDraw" | "debtDraw" | "capitalizedInterest") => before.reduce((a, r) => a + r[k], 0);
      expect(Math.abs(total("costDraw") - (L.costsBeforeFinancing + L.leaseupOperatingCost))).toBeLessThanOrEqual(CENT);
      expect(Math.abs(total("equityDraw") - L.requiredEquity)).toBeLessThanOrEqual(CENT);
      expect(Math.abs(total("debtDraw") + total("capitalizedInterest") - L.drawnDebtAtS)).toBeLessThanOrEqual(CENT);
    }
  };
  test("a sale deal", () => check(rentalDeal, 300, rental));
  test("a deal kept and refinanced", () => check(holdDeal, 150, rental));
  test("a deal that sells its units, before and after completion", () =>
    check(saleDeal, 200, (d) => {
      const { values: v } = buildForSaleLedger(d);
      // At completion: uses = total development cost; sources = equity before carry + both debt balances.
      const equityBeforeCarry = v.equity_contributed! - v.carry_total!;
      expect(Math.abs(equityBeforeCarry + v.senior_balance_at_completion! + v.mezz_balance_at_completion! - v.total_development_cost!)).toBeLessThanOrEqual(CENT);
      // Every unit closes exactly once (spec Q3, Q4).
      expect(v.closing_units_check).toBe(0);
      // With the debt repaid, cash out less cash in is the spec's profit: net sales - TDC - carry - interest after completion.
      if (v.ending_senior_balance! + v.ending_mezz_balance! <= 0.005) {
        expect(Math.abs(v.equity_distributed! - v.equity_contributed! - v.development_profit_for_sale!)).toBeLessThanOrEqual(CENT);
      }
    }));
});

describe("rule 2: sign conventions", () => {
  const rows = (rs: readonly { costDraw: number; equityDraw: number; debtDraw: number; capitalizedInterest: number; debtService: number; debtBalance: number; saleNet: number }[]) => {
    for (const r of rs) {
      // A credit is limited to hard + soft + contingency, so no month's construction spend goes negative (spec, Credits).
      for (const k of ["costDraw", "equityDraw", "debtDraw", "capitalizedInterest", "debtService", "saleNet"] as const) expect(r[k], k).toBeGreaterThanOrEqual(0);
      expect(r.debtBalance).toBeGreaterThanOrEqual(-1e-6);
    }
  };
  const flows = (fs: readonly { kind: string; amount: number }[]) => {
    for (const f of fs) {
      if (f.kind === "contribution") expect(f.amount).toBeLessThan(0);
      if (f.kind === "sale") expect(f.amount).toBeGreaterThan(0);
      if (f.kind === "unrealized") expect(f.amount).toBeGreaterThanOrEqual(0);
    }
  };
  test("rental modes: rows and flows carry their signs", () =>
    check(fc.oneof(rentalDeal, holdDeal), 300, (d) => {
      const L = buildLedger(d);
      rows(L.rows);
      flows(L.equityFlows);
      expect(L.capitalizedInterest).toBeGreaterThanOrEqual(0);
    }));
  test("for-sale mode: rows and flows carry their signs", () =>
    check(saleDeal, 200, (d) => {
      const L = buildForSaleLedger(d);
      rows(L.rows);
      flows(L.equityFlows);
      expect(L.values.interest_after_completion).toBeGreaterThanOrEqual(0);
      expect(L.values.carry_total).toBeGreaterThanOrEqual(0);
    }));
  test("adding to any cost line never lowers total cost; only a credit does, by its own amount", () =>
    check(fc.record({ d: rentalDeal, extra: money(1, 1_000_000), line: fc.constantFrom("land", "hard", "soft", "contingency") as fc.Arbitrary<"land" | "hard" | "soft" | "contingency"> }), 150, ({ d, extra, line }) => {
      const up = { ...d, budget: { ...d.budget, [line]: d.budget[line] + extra } };
      expect(buildLedger(up).tdc).toBeGreaterThanOrEqual(buildLedger(d).tdc);
      // The credit lowers costs before financing by exactly its amount.
      const none = buildLedger({ ...d, budget: { ...d.budget, other: 0 } });
      expect(buildLedger(d).costsBeforeFinancing - none.costsBeforeFinancing).toBeCloseTo(d.budget.other, 6);
    }));
});

// ---- Rule 3: every adverse shock worsens the result ----------------------------------------------

/** A VALID value never rises; a shock that ends in a non-VALID state holds no value, never 0. */
function neverRaised(base: Metric, shocked: Metric, why: string) {
  if (shocked.status !== "VALID") {
    expect(shocked.value, why).toBeNull();
    return;
  }
  if (base.status === "VALID") expect(shocked.value!, why).toBeLessThanOrEqual(base.value! + 1e-9);
}

const rentalShocks = fc.record({
  exitCapBps: fc.integer({ min: 10, max: 300 }),
  costPct: fc.integer({ min: 1, max: 30 }),
  rateBps: fc.integer({ min: 10, max: 400 }),
  rentPct: fc.integer({ min: -30, max: -1 }),
  occupancyPts: fc.integer({ min: -30, max: -1 }),
  expensePts: fc.integer({ min: 1, max: 20 }),
});
const single = (p: Record<string, number>): StressPreset[] => Object.entries(p).map(([k, v]) => ({ key: k, label: k, [k]: v }));

describe("rule 3: an adverse shock, on its own, never raises the result", () => {
  test("a rental sold at the end: equity multiple and profit on cost", () =>
    check(fc.record({ d: rentalDeal, s: rentalShocks }), 60, ({ d, s }) => {
      const stresses = single(s);
      const r = underwrite(d, { ...POLICY_V1, stresses });
      for (const { key } of stresses) {
        neverRaised(metric(r, "equity_multiple"), metric(r, "equity_multiple", key), `multiple ${key}`);
        neverRaised(metric(r, "profit_on_cost"), metric(r, "profit_on_cost", key), `profit on cost ${key}`);
      }
    }));
  test("a held deal: unrealized multiple (profit on cost does not apply, the deal is not sold)", () =>
    check(fc.record({ d: holdDeal.filter((d) => d.refinance!.amount !== undefined), s: rentalShocks }), 60, ({ d, s }) => {
      const stresses = single(s);
      const r = underwrite(d, { ...RENTAL_HOLD_DRAFT, stresses });
      for (const { key } of stresses) neverRaised(metric(r, "unrealized_equity_multiple"), metric(r, "unrealized_equity_multiple", key), key);
    }));
  test("a held deal sized by loan-to-value: the exit-cap shock also moves the refinance loan", () =>
    check(fc.record({ d: holdDeal.filter((d) => d.refinance!.ltvPct !== undefined), s: rentalShocks }), 60, ({ d, s }) => {
      const stresses = single(s);
      const r = underwrite(d, { ...RENTAL_HOLD_DRAFT, stresses });
      for (const { key } of stresses) neverRaised(metric(r, "unrealized_equity_multiple"), metric(r, "unrealized_equity_multiple", key), key);
    }));
  // Weakened for one case, on purpose. A longer build with a mezzanine loan can raise the multiple while profit falls:
  // past its commitment, mezzanine interest is paid in kind (owner decision 2026-10-05), so more of it can replace equity.
  // One more month took the mezzanine balance from 988,970 to 1,000,508 and equity down 6,800, and distributions down
  // 11,809: 11,809 / 43.6M is a smaller share than 6,800 / 10.2M. The multiple rose from 4.2664 to 4.2681 and
  // profit on cost still fell. So the delay shock with a mezzanine loan is held to profit on cost only.
  test("selling units: multiple and profit on cost under the sale's own shocks", () =>
    check(
      fc.record({
        d: saleDeal,
        s: fc.record({
          pricePct: fc.integer({ min: -30, max: -1 }),
          absorptionPct: fc.integer({ min: -60, max: -5 }),
          costPct: fc.integer({ min: 1, max: 30 }),
          rateBps: fc.integer({ min: 10, max: 400 }),
          constructionMonths: fc.integer({ min: 1, max: 12 }),
          presalesPts: fc.integer({ min: -40, max: -1 }),
        }),
      }),
      100,
      ({ d, s }) => {
        const stresses = single(s);
        const r = underwrite(d, { ...FOR_SALE_DRAFT, stresses });
        for (const { key } of stresses) {
          if (!(key === "constructionMonths" && d.mezzanine)) neverRaised(metric(r, "equity_multiple"), metric(r, "equity_multiple", key), `multiple ${key}`);
          neverRaised(metric(r, "profit_on_cost_for_sale"), metric(r, "profit_on_cost_for_sale", key), `profit on cost ${key}`);
        }
      },
    ));
});

// ---- Rule 4: Unknown is never 0 ---------------------------------------------------------------------

function clean(r: RunResult) {
  const finite = (x: unknown, what: string) => expect(Number.isFinite(x), what).toBe(true);
  for (const s of r.scenarios) {
    for (const x of s.metrics) {
      if (x.status === "VALID") finite(x.value, x.key);
      else {
        expect(x.value, x.key).toBeNull();
        expect(x.reason, x.key).toBeTruthy();
      }
    }
  }
  for (const g of r.verdict.gates) {
    const source = r.scenarios.find((s) => s.key === g.scenario)?.metrics.find((x) => x.key === g.metricKey);
    if (source?.status !== "VALID") {
      expect(g.actual, g.key).toBeNull();
      expect(["not_evaluated", "not_applicable"], g.key).toContain(g.status);
    } else finite(g.actual, g.key);
  }
  if (r.verdict.gates.some((g) => g.status === "not_evaluated")) expect(["NOT_EVALUATED", "REJECT"]).toContain(r.verdict.code);
  for (const row of r.ledger) for (const [k, v] of Object.entries(row)) if (typeof v === "number") finite(v, `ledger ${k}`);
  for (const row of r.annual) for (const [k, v] of Object.entries(row)) if (typeof v === "number") finite(v, `annual ${k}`);
  for (const f of r.equityFlows) finite(f.amount, "flow");
  // canonicalJson refuses a non-finite number anywhere in the result.
  expect(() => canonicalJson(r)).not.toThrow();
}

describe("rule 4: Unknown is never 0", () => {
  test("no NaN or Infinity reaches a metric, a ledger row or a gate, in any mode", () =>
    check(fc.oneof(rentalDeal, holdDeal, saleDeal), 80, (d) => clean(underwrite(d, policyOf(d)))));

  // Expenses at 120% of income: NOI = 0.2 x income below zero, whatever the income, so nothing can be capitalized (spec, Exit).
  const lossMaking = (d: EngineInput): EngineInput => {
    const { fixedOpexAnnual: _f, variableExpensePct: _v, ...rest } = d;
    return { ...rest, expenseRatioPct: 120 };
  };
  test("a deal that cannot be capitalized stays not meaningful through the whole result", () =>
    check(rentalDeal, 40, (d) => {
      const r = underwrite(lossMaking(d), POLICY_V1);
      clean(r);
      for (const key of ["exit_value", "net_sale_proceeds", "development_profit", "profit_on_cost", "equity_multiple", "equity_irr"]) {
        expect(metric(r, key).status, key).toBe("NOT_MEANINGFUL");
      }
      const gate = (key: string) => r.verdict.gates.find((g) => g.key === key)!;
      expect(gate("equity_multiple").status).toBe("not_evaluated");
      expect(gate("profit_on_cost").status).toBe("not_evaluated");
      expect(["NOT_EVALUATED", "REJECT"]).toContain(r.verdict.code);
    }));
  test("a held deal's sale metrics are not applicable, never 0, and its stated value is not meaningful at a loss", () =>
    check(holdDeal, 40, (d) => {
      const r = underwrite(d, RENTAL_HOLD_DRAFT);
      for (const key of ["exit_value", "net_sale_proceeds", "development_profit", "profit_on_cost", "equity_multiple", "equity_irr", "sale_month", "lp_irr", "gp_irr", "gp_promote"]) {
        expect(metric(r, key).status, key).toBe("NOT_APPLICABLE");
        expect(metric(r, key).value, key).toBeNull();
      }
      const lost = underwrite(lossMaking(d), RENTAL_HOLD_DRAFT);
      clean(lost);
      expect(metric(lost, "stated_value").status).toBe("NOT_MEANINGFUL");
      expect(metric(lost, "unrealized_equity_multiple").status).toBe("NOT_MEANINGFUL");
      expect(lost.equityFlows.some((f) => f.kind === "unrealized")).toBe(false);
    }));
  test("a sale's rental metrics are not applicable, never 0", () =>
    check(saleDeal, 40, (d) => {
      const r = underwrite(d, FOR_SALE_DRAFT);
      for (const key of ["stabilized_noi", "gross_potential_rent", "sizing_dscr", "exit_value", "development_spread", "yield_on_cost", "break_even_occupancy"]) {
        expect(metric(r, key).status, key).toBe("NOT_APPLICABLE");
        expect(metric(r, key).value, key).toBeNull();
      }
    }));

  const without = <T extends object>(o: T, k: string): T => {
    const copy = { ...o } as Record<string, unknown>;
    delete copy[k];
    return copy as T;
  };
  const dev = developmentDeal();
  const refused: [string, EngineInput][] = [
    ...(["land", "hard", "soft", "contingency", "other"] as const).flatMap((k): [string, EngineInput][] => [
      [`budget.${k} NaN`, { ...dev, budget: { ...dev.budget, [k]: NaN } }],
      [`budget.${k} missing`, { ...dev, budget: without(dev.budget, k) }],
      [`budget.${k} infinite`, { ...dev, budget: { ...dev.budget, [k]: Infinity } }],
    ]),
    ["no revenue at all", { ...dev, revenue: [] }],
    ["no expense figure", without(dev, "expenseRatioPct")],
    ["rent missing", { ...dev, revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10 }] }],
    ["units missing", { ...dev, revenue: [{ key: "A", label: "A", basis: "per_unit", rentMonthly: 1000 } as never] }],
    ["exit cap missing", without(dev, "exitCapPct")],
    ["exit cap zero", { ...dev, exitCapPct: 0 }],
    ["selling costs missing", without(dev, "sellingCostsPct")],
    ["occupancy NaN", { ...dev, stabilizedOccupancyPct: NaN }],
    ["senior rate NaN", { ...dev, senior: { ...dev.senior, ratePct: NaN } }],
    ["construction months missing", without(dev, "constructionMonths")],
    ["hold years missing", without(dev, "holdYears")],
    ["a held deal with no refinance", { ...dev, exit: "refinance_hold" }],
    ["a sale with no sale details", { ...dev, revenue: [], leaseUpMonths: 0, exit: "for_sale" }],
  ];
  test.each(refused)("a missing required input is refused, not computed as 0: %s", (_n, input) => {
    expect(() => validateInput(input)).toThrow(EngineInputError);
    expect(() => underwrite(input, policyOf(input))).toThrow(EngineInputError);
  });
  test("readiness names a missing required field and gives no input", () => {
    const { readiness, input } = assemble([{ fieldKey: "land_cost", itemKey: null, status: "approved", valueNumeric: 1_000_000 }]);
    expect(input).toBeNull();
    expect(readiness.status).toBe("blocked");
    expect(readiness.missing.map((x) => x.fieldKey)).toContain("exit_cap_rate_pct");
  });
});

// ---- Rule 5: one dollar in, one dollar through --------------------------------------------------------

describe("rule 5: one dollar in, one dollar through", () => {
  test("a dollar of hard cost is a dollar of cost before financing", () =>
    check(fc.oneof(rentalDeal, holdDeal), 150, (d) => {
      const up = { ...d, budget: { ...d.budget, hard: d.budget.hard + 1 } };
      expect(buildLedger(up).costsBeforeFinancing - buildLedger(d).costsBeforeFinancing).toBe(1);
    }));
  test("the same on a deal that sells its units: a dollar of cost is a dollar less profit before any new interest", () =>
    check(saleDeal.filter((d) => d.senior.amount === 0 && d.mezzanine === undefined), 80, (d) => {
      // With no debt there is no interest, so profit falls by exactly the dollar.
      const up = { ...d, budget: { ...d.budget, hard: d.budget.hard + 1 } };
      const a = buildForSaleLedger(d).values.development_profit_for_sale!;
      const b = buildForSaleLedger(up).values.development_profit_for_sale!;
      expect(a - b).toBeCloseTo(1, 6);
    }));
  test("each month's allocation totals the line, to the cent", () =>
    check(fc.oneof(rentalDeal, saleDeal), 300, (d) => {
      const S = d.constructionMonths + d.leaseUpMonths;
      const { costByMonth, costsBeforeFinancing } = placeConstructionCosts(d, S);
      const total = costByMonth.reduce((a, b) => a + b, 0);
      expect(Math.abs(total - costsBeforeFinancing)).toBeLessThanOrEqual(CENT);
      for (const x of costByMonth) expect(Math.round(x * 100) / 100).toBeCloseTo(x, 6);
    }));
  // Spec, Time: month m covers [m, m+1), land is paid at month 0, and every metric is a projection of the ledger.
  // The sale ledger places these at month 0 when there is no build (forsale.ts, "With no build").
  // The rental ledger writes `m < S ? ... : 0`, so with C = L = 0 no row shows the cost or the equity.
  // Smallest input: allEquityDeal, land 1,000,000: rows[0].costDraw is 0, and the equity flow is -1,000,000.
  test.fails("FINDING: a deal with no build still shows its cost and equity in the ledger rows", () => {
    const L = buildLedger(allEquityDeal());
    expect(L.rows[0]!.costDraw).toBe(1_000_000);
    expect(L.rows[0]!.equityDraw).toBe(1_000_000);
  });
});

// ---- Rule 6: splitting and order do not matter ------------------------------------------------------

const SKIP_TEXT = new Set(["message", "reason", "explanation", "headline", "hardFailReasons", "label", "formula"]);
/** Same shape, same words apart from prose, numbers within `abs + rel x size`. */
function same(a: unknown, b: unknown, abs: number, rel: number, path = "result"): void {
  if (typeof a === "number" && typeof b === "number") {
    expect(Math.abs(a - b), `${path}: ${a} vs ${b}`).toBeLessThanOrEqual(abs + rel * Math.abs(a));
    return;
  }
  if (a === null || typeof a !== "object") {
    expect(b, path).toEqual(a);
    return;
  }
  if (Array.isArray(a)) {
    expect((b as unknown[]).length, path).toBe(a.length);
    a.forEach((x, i) => same(x, (b as unknown[])[i], abs, rel, `${path}[${i}]`));
    return;
  }
  for (const k of Object.keys(a)) {
    if (!SKIP_TEXT.has(k)) same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], abs, rel, `${path}.${k}`);
  }
}
const permuted = <T,>(xs: readonly T[], keys: readonly number[]): T[] =>
  xs.map((x, i) => ({ x, k: keys[i % keys.length]! })).sort((p, q) => p.k - q.k).map((p) => p.x);
const keys = fc.array(fc.integer(), { minLength: 1, maxLength: 5 });
// Summing lines in another order moves the last bits of a double; rounding allows no more than this.
const [ABS, REL] = [1e-4, 1e-9];


describe("rule 6: splitting and order do not matter", () => {
  const split = (d: EngineInput): EngineInput => {
    const [first, ...others] = d.revenue;
    const half = Math.floor(first!.units / 2);
    return { ...d, revenue: [{ ...first!, key: "x1", label: "x1", units: half }, { ...first!, key: "x2", label: "x2", units: first!.units - half }, ...others] };
  };
  test("two unit lines of one type and rent are one combined line", () =>
    check(fc.oneof(rentalDeal, holdDeal), 30, (d) => same(underwrite(d, policyOf(d)), underwrite(split(d), policyOf(d)), ABS, REL)));
  test("shuffling unit lines changes nothing", () =>
    check(fc.record({ d: fc.oneof(rentalDeal, holdDeal), k: keys }), 30, ({ d, k }) =>
      same(underwrite(d, policyOf(d)), underwrite({ ...d, revenue: permuted(d.revenue, k) }, policyOf(d)), ABS, REL)));
  test("moving money among hard, soft and contingency changes nothing: they are spread together", () =>
    check(rentalDeal, 30, (d) => {
      const b = d.budget;
      same(underwrite(d, POLICY_V1), underwrite({ ...d, budget: { ...b, hard: b.contingency, soft: b.hard, contingency: b.soft } }, POLICY_V1), ABS, REL);
    }));
  test("a sale: splitting a unit type and shuffling types changes nothing (Q2, the average price)", () =>
    check(fc.record({ d: saleDeal, k: keys }), 30, ({ d, k }) => {
      const f = d.forSale!;
      const [first, ...others] = f.units;
      const parts = first!.units > 1
        ? [{ ...first!, key: "x1", units: 1 }, { ...first!, key: "x2", units: first!.units - 1 }, ...others]
        : f.units;
      same(underwrite(d, FOR_SALE_DRAFT), underwrite({ ...d, forSale: { ...f, units: permuted(parts, k) } }, FOR_SALE_DRAFT), ABS, REL);
    }));
});

// ---- Rule 7: scale --------------------------------------------------------------------------------

/**
 * The bound. Costs are spread to the cent, so a doubled deal's month can differ from twice the
 * original by about 1 cent, and the equity solve stops within half a cent (spec). A misplacement of a
 * few cents a month for up to 30 months, at up to 14%, moves interest by far under $1. Against equity
 * of at least about $150,000 (a $1M+ deal at most 85% debt), $2 is at most about 1.3e-5 of the multiple.
 * So: money within $2 + 1e-9 relative, multiples within 1e-4, percents within 0.01, bps within 1.
 */
function scaled(a: RunResult, b: RunResult) {
  for (const s of a.scenarios) {
    for (const x of s.metrics) {
      const y = metric(b, x.key, s.key);
      expect(y.status, `${s.key}.${x.key}`).toBe(x.status);
      if (x.value === null) continue;
      const why = `${s.key}.${x.key}: ${x.value} then ${y.value}`;
      if (x.unit === "$") expect(Math.abs(y.value! - 2 * x.value), why).toBeLessThanOrEqual(2 + 1e-9 * Math.abs(x.value));
      else if (x.unit === "x") expect(Math.abs(y.value! - x.value), why).toBeLessThanOrEqual(1e-4);
      else if (x.unit === "%") expect(Math.abs(y.value! - x.value), why).toBeLessThanOrEqual(0.01);
      else if (x.unit === "bps") expect(Math.abs(y.value! - x.value), why).toBeLessThanOrEqual(1);
      else expect(y.value, why).toBe(x.value);
    }
  }
  expect(b.verdict.gates.map((g) => g.status)).toEqual(a.verdict.gates.map((g) => g.status));
}
const twice = (d: EngineInput): EngineInput => {
  const b = d.budget;
  const dbl = (x: number | undefined) => (x === undefined ? {} : x * 2);
  const named = (k: "developmentCharges" | "landTransferTax" | "gstHstNet") => (b[k] === undefined ? {} : { [k]: dbl(b[k]) });
  return {
    ...d,
    budget: { land: b.land * 2, hard: b.hard * 2, soft: b.soft * 2, contingency: b.contingency * 2, other: b.other * 2, ...named("developmentCharges"), ...named("landTransferTax"), ...named("gstHstNet") },
    revenue: d.revenue.map((c) => ({ ...c, rentMonthly: c.rentMonthly! * 2 })),
    otherIncomeAnnual: d.otherIncomeAnnual * 2,
    ...(d.fixedOpexAnnual !== undefined ? { fixedOpexAnnual: d.fixedOpexAnnual * 2 } : {}),
    ...(d.propertyTaxAnnual !== undefined ? { propertyTaxAnnual: d.propertyTaxAnnual * 2 } : {}),
    senior: { ...d.senior, amount: d.senior.amount * 2 },
    ...(d.mezzanine ? { mezzanine: { ...d.mezzanine, amount: d.mezzanine.amount * 2 } } : {}),
    ...(d.refinance ? { refinance: { ...d.refinance, ...(d.refinance.amount !== undefined ? { amount: d.refinance.amount * 2 } : {}) } } : {}),
    ...(d.forSale ? { forSale: { ...d.forSale, carryMonthly: d.forSale.carryMonthly * 2, units: d.forSale.units.map((u) => ({ ...u, price: u.price * 2 })) } } : {}),
  };
};

describe("rule 7: doubling every money input doubles money and leaves ratios alone", () => {
  test("a rental sold at the end", () => check(rentalDeal, 30, (d) => scaled(underwrite(d, POLICY_V1), underwrite(twice(d), POLICY_V1))));
  test("a held deal", () => check(holdDeal, 30, (d) => scaled(underwrite(d, RENTAL_HOLD_DRAFT), underwrite(twice(d), RENTAL_HOLD_DRAFT))));
  test("a sale", () => check(saleDeal, 30, (d) => scaled(underwrite(d, FOR_SALE_DRAFT), underwrite(twice(d), FOR_SALE_DRAFT))));
});

// ---- Rule 8: determinism --------------------------------------------------------------------------

function shuffleKeys(value: unknown, next: () => number): unknown {
  if (Array.isArray(value)) return value.map((x) => shuffleKeys(x, next));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  return Object.fromEntries(entries.map(([k, v]) => [k, shuffleKeys(v, next)]));
}

describe("rule 8: determinism", () => {
  test("two calls, and a shuffled key order in the input, give byte-identical output", () =>
    check(fc.record({ d: fc.oneof(rentalDeal, holdDeal, saleDeal), seed: fc.integer({ min: 1, max: 2 ** 30 }) }), 25, ({ d, seed }) => {
      const once = canonicalJson(underwrite(d, policyOf(d)));
      expect(canonicalJson(underwrite(d, policyOf(d)))).toBe(once);
      let s = seed;
      const next = () => (s = (s * 48271) % 2147483647);
      const shuffled = shuffleKeys(d, next) as EngineInput;
      expect(canonicalJson(shuffled)).toBe(canonicalJson(d));
      expect(canonicalJson(underwrite(shuffled, policyOf(d)))).toBe(once);
    }));
});

// ---- Rule 9: which rules reach which mode ------------------------------------------------------------
// Rental sale: all rules. Held: all rules, with the unrealized multiple in rule 3; profit on cost does not apply.
// For sale: rule 3 uses its own six shocks; rent, occupancy, expense and exit cap do not exist there; rule 6 is on unit
// types and rule 7 leaves the sales pace alone (units, not money). These are the mode-only facts left to state.
describe("rule 9: what belongs to one mode", () => {
  test("a held deal has one unrealized flow, at the end, and no sale", () =>
    check(holdDeal, 100, (d) => {
      const L = buildLedger(d);
      expect(L.rows.every((r) => r.saleNet === 0)).toBe(true);
      expect(L.equityFlows.some((f) => f.kind === "sale")).toBe(false);
      const unrealized = L.equityFlows.filter((f) => f.kind === "unrealized");
      if (L.statedValue === null) expect(unrealized).toEqual([]);
      else {
        expect(unrealized).toHaveLength(1);
        expect(unrealized[0]!.t).toBe((L.T + 1) / 12);
        expect(unrealized[0]!.amount).toBeCloseTo(Math.max(0, L.statedValue - L.payoffAtSale), 6);
      }
    }));
  test("a sale deal's result carries no held or sale-mode metric keys it should not", () =>
    check(rentalDeal, 20, (d) => {
      const keysOf = underwrite(d, POLICY_V1).scenarios[0]!.metrics.map((x) => x.key);
      for (const k of ["stated_value", "cash_left_in_deal", "unrealized_equity_multiple", "gross_sales_revenue", "margin_on_revenue"]) expect(keysOf).not.toContain(k);
    }));
  test("a deal that sells: deposits are reported and move no cash (decision 1)", () =>
    check(fc.record({ d: saleDeal, other: fc.integer({ min: 0, max: 20 }) }), 40, ({ d, other }) => {
      const moved = { ...d, forSale: { ...d.forSale!, depositPct: other } };
      expect(buildForSaleLedger(moved).equityFlows).toEqual(buildForSaleLedger(d).equityFlows);
    }));
});
