// The second pass over surviving mutants. Expected values come from hand arithmetic in a comment, a rule in the
// specification or in a source comment, a boundary built on purpose, or a relation between two runs. None is pasted from engine output.
import { describe, expect, test } from "vitest";
import { POLICY_V1, FOR_SALE_DRAFT, RENTAL_HOLD_DRAFT, RENTAL_HOLD_INSURED_DRAFT, type Check, type EngineInput, type EquityFlow, type RunResult } from "@agir/contracts";
import { assemble, buildForSaleLedger, buildLedger, EngineInputError, forSaleMetrics, irrRoots, underwrite, validateInput, type AssumptionRow } from "../src/index.ts";
import { baseMetrics, breakeven, grid, shockInput, solveBreakeven, tornado } from "../src/explore.ts";
import { levelPayment } from "../src/math.ts";
import { m } from "../src/metrics.ts";
import { computeVerdict, type GateSpec } from "../src/verdict.ts";
import { allEquityDeal } from "./fixtures.ts";

const flat = (over: Partial<EngineInput> = {}): EngineInput => ({ ...allEquityDeal(), ...over });
const metric = (r: RunResult, key: string) => r.scenarios.find((s) => s.key === "base")!.metrics.find((x) => x.key === key)!;
const checkOf = (r: RunResult, key: string): Check | undefined => r.checks.find((c) => c.key === key);
const land = (amount: number) => ({ land: amount, hard: 0, soft: 0, contingency: 0, other: 0 });
const loan = (amount: number, ratePct = 0, amortYears = 30, ioMonths = 0) => ({ amount, ratePct, amortYears, ioMonths });
const noCost = land(0);

describe("insured refinance limits", () => {
  // NOI 120,000 at a 10% cap: value 1,200,000. No points: Standard, 85% of value, 100% of cost, 40 years, 5 units.
  const held = (refi: object, over: Partial<EngineInput> = {}) => flat({ holdYears: 2, exit: "refinance_hold", refinance: { month: 0, amount: 100_000, ratePct: 0, amortYears: 30, ioMonths: 0, insurancePremiumPct: 1, ...refi } as EngineInput["refinance"], ...over });
  const run = (d: EngineInput) => underwrite(d, RENTAL_HOLD_INSURED_DRAFT);
  test("a policy with limits reads a deal with no refinance without failing", () => {
    expect(() => underwrite(flat(), RENTAL_HOLD_INSURED_DRAFT)).not.toThrow();
  });
  test("each limit is an error of kind bound and names its limit", () => {
    const few = checkOf(run(held({}, { revenue: [{ key: "A", label: "A", basis: "per_unit", units: 3, rentMonthly: 4000 }] })), "insured_min_units")!;
    expect([few.kind, few.severity, few.expected, few.actual]).toEqual(["bound", "error", 5, 3]);
    expect(few.message).toContain("at least 5 units");
    const ltv = checkOf(run(held({ amount: 1_100_000 })), "refinance_ltv_limit")!;
    expect([ltv.kind, ltv.severity]).toEqual(["bound", "error"]);
    expect(ltv.message).toContain("85%");
    const ltc = checkOf(run(held({ amount: 1_010_000 })), "refinance_ltc_limit")!;
    expect([ltc.kind, ltc.severity]).toEqual(["bound", "error"]);
    const amort = checkOf(run(held({ amortYears: 45 })), "refinance_amort_limit")!;
    expect([amort.kind, amort.severity, amort.expected, amort.actual]).toEqual(["bound", "error", 40, 45]);
    expect(amort.message).toContain("40-year");
    expect(checkOf(run(held({ amortYears: 40 })), "refinance_amort_limit")).toBeUndefined();
    expect(run(held({ amortYears: 45 })).verdict.code).toBe("REJECT");
  });
  test("half a cent over a limit is the allowance: at the allowance there is no check, past it there is", () => {
    // 85% of 1,200,000 = 1,020,000; the cost is raised so only value binds.
    const dear = { budget: land(2_000_000) };
    expect(checkOf(run(held({ amount: 1_020_000.005 }, dear)), "refinance_ltv_limit")).toBeUndefined();
    expect(checkOf(run(held({ amount: 1_020_000.01 }, dear)), "refinance_ltv_limit")).toBeDefined();
    expect(checkOf(run(held({ amount: 1_000_000.005 })), "refinance_ltc_limit")).toBeUndefined();
    expect(checkOf(run(held({ amount: 1_000_000.01 })), "refinance_ltc_limit")).toBeDefined();
  });
});

describe("checks at zero, at their edges and in their words", () => {
  test("no debt and no cost is not a stack that cannot exist, and no ceiling row appears", () => {
    const r = underwrite(flat({ budget: noCost }), POLICY_V1);
    expect(checkOf(r, "debt_exceeds_cost")).toBeUndefined();
    expect(checkOf(r, "ltc_ceiling")).toBeUndefined();
  });
  test("debt on no cost: the stack fails, and the ceiling never reports an infinite ratio", () => {
    const r = underwrite(flat({ budget: noCost, senior: loan(100) }), POLICY_V1);
    const stack = checkOf(r, "debt_exceeds_cost")!;
    expect([stack.kind, stack.severity]).toEqual(["bound", "error"]);
    expect(Number.isFinite(checkOf(r, "ltc_ceiling")!.actual)).toBe(true);
  });
  test("bounds are bounds", () => {
    const over = checkOf(underwrite(flat({ senior: loan(860_000) }), POLICY_V1), "ltc_ceiling")!;
    expect(over.kind).toBe("bound");
    expect(over.message).toBe("Loan to cost of 86.0% is above the policy ceiling of 85%.");
    const noi = checkOf(underwrite(flat({ expenseRatioPct: 100 }), POLICY_V1), "noi_not_positive")!;
    expect(noi.kind).toBe("bound");
    expect(noi.message).toContain("Stabilized NOI is $0.");
    const mezz = checkOf(underwrite(flat({ constructionMonths: 2, mezzanine: loan(100_000, 12) }), POLICY_V1), "mezz_interest_accrued")!;
    expect([mezz.kind, mezz.severity]).toEqual(["bound", "warning"]);
  });
  test("a kept deal under water reports its stated value against the debt", () => {
    // Value 1,200,000. Refinance 2,000,000, interest only at 0%, so 2,000,000 is owed at the end.
    const d = flat({ budget: land(3_000_000), holdYears: 2, exit: "refinance_hold", refinance: { month: 6, amount: 2_000_000, ratePct: 0, amortYears: 30, ioMonths: 24 } });
    const c = checkOf(underwrite(d, RENTAL_HOLD_DRAFT), "equity_wipeout")!;
    expect([c.kind, c.severity, c.expected]).toEqual(["bound", "error", 2_000_000]);
    expect(c.actual).toBeCloseTo(1_200_000, 6);
  });
  test("stated value equal to the debt is not a wipeout", () => {
    const d = flat({ budget: land(2_000_000), holdYears: 2, exit: "refinance_hold", refinance: { month: 6, amount: 1_200_000, ratePct: 0, amortYears: 30, ioMonths: 24 } });
    const L = buildLedger(d);
    expect(L.statedValue).toBe(L.payoffAtSale);
    expect(L.wipeout).toBe(false);
  });
  test("stated equity exactly at the tolerance agrees, from either side", () => {
    // Land 1,000,000, no debt, tolerance 2%: 20,000 either way is the edge.
    const tol = { ...POLICY_V1, agreementTolerancePct: 2 };
    const sev = (equity: number) => checkOf(underwrite(flat({ stated: { equity } }), tol), "sources_cover_uses")!;
    expect(sev(980_000).severity).toBe("pass");
    expect(sev(1_020_000).severity).toBe("pass");
    expect(sev(979_999).severity).toBe("error");
    expect(sev(1_020_001).severity).toBe("warning");
    expect(sev(1_020_001).kind).toBe("agreement");
  });
  test("a stated loan to cost: within a point it matches and says so, past it it names both figures", () => {
    const row = (ltcPct: number) => checkOf(underwrite(flat({ senior: loan(500_000), stated: { ltcPct } }), POLICY_V1), "stated_ltc")!;
    expect(row(50).severity).toBe("pass");
    expect(row(51).severity).toBe("pass");
    expect(row(51).message).toBe("The stated loan to cost of 51.0% matches the model.");
    expect(row(52).message).toBe("The documents state a loan to cost of 52.0%; the model computes 50.0%.");
  });
  test("an interest reserve equal to the model's interest covers it", () => {
    // Rate 0: the model's interest is 0, and a stated reserve of 0 is not under it.
    expect(checkOf(underwrite(flat({ senior: loan(500_000), stated: { interestReserve: 0 } }), POLICY_V1), "interest_reserve")?.severity).toBe("pass");
  });
});

describe("the base sizing floor", () => {
  test("at the floor there is no warning, a hair above the metric there is", () => {
    // 120,000 over 12,000 is 10.00x (see the covenant test in mutation-gaps).
    const d = flat({ senior: loan(360_000) });
    const sizing = metric(underwrite(d, POLICY_V1), "sizing_dscr").value!;
    expect(sizing).toBeCloseTo(10, 9);
    expect(checkOf(underwrite(d, { ...POLICY_V1, baseSizingDscrFloor: sizing }), "base_sizing_dscr")).toBeUndefined();
    const under = checkOf(underwrite(d, { ...POLICY_V1, baseSizingDscrFloor: sizing + 1e-9 }), "base_sizing_dscr")!;
    expect([under.kind, under.severity]).toEqual(["bound", "warning"]);
  });
  test("no debt has no floor to fall under", () => {
    expect(checkOf(underwrite(flat(), { ...POLICY_V1, baseSizingDscrFloor: 100 }), "base_sizing_dscr")).toBeUndefined();
  });
});

describe("metrics: Unknown stays Unknown, with its own reason", () => {
  test("m refuses to call a bad number VALID, even when told to", () => {
    expect(m("total_debt", NaN, "VALID").status).toBe("NOT_MEANINGFUL");
    expect(m("total_debt", null, "VALID").status).toBe("NOT_MEANINGFUL");
  });
  test("no cost: the spread is not read as 0 minus the cap", () => {
    const r = underwrite(flat({ budget: noCost }), POLICY_V1);
    expect(metric(r, "development_spread").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "loan_to_cost").reason).toBe("Total development cost is zero.");
  });
  test("no capitalized value: every figure built on it gives that reason, and there are no roots", () => {
    const r = underwrite(flat({ expenseRatioPct: 120 }), POLICY_V1);
    for (const k of ["exit_value", "net_sale_proceeds", "development_profit", "profit_on_cost"]) expect(metric(r, k).reason, k).toBe("Final-year NOI is not positive, so the asset has no capitalized value.");
    expect(r.irrRoots).toEqual([]);
  });
  test("a mezzanine of 0 is no mezzanine; debt with no senior has no senior coverage", () => {
    expect(metric(underwrite(flat({ mezzanine: loan(0) }), POLICY_V1), "mezz_interest_accrued").status).toBe("NOT_APPLICABLE");
    const only = underwrite(flat({ mezzanine: loan(100_000, 0) }), POLICY_V1);
    expect(metric(only, "senior_dscr_year1").status).toBe("NOT_APPLICABLE");
    expect(metric(only, "mezz_dscr_year1").status).toBe("VALID");
  });
  test("a year with no debt service is skipped, not read as 0x coverage", () => {
    // 360,000 at 0%: interest only through month 11 pays nothing. Year 2: 12,000 on 120,000 of NOI is 10x.
    const d = flat({ holdYears: 2, senior: loan(360_000, 0, 30, 12) });
    expect(metric(underwrite(d, POLICY_V1), "contractual_dscr").value).toBeCloseTo(10, 9);
    // With NOI of 0 the same year is still skipped: not 0/0, so the paying year's 0x stands.
    const none = metric(underwrite({ ...d, expenseRatioPct: 100 }, POLICY_V1), "contractual_dscr");
    expect([none.status, none.value]).toEqual(["VALID", 0]);
  });
  test("debt at no interest: the reason says so; no equity: the reason says so", () => {
    const r = underwrite(flat({ senior: loan(100_000) }), POLICY_V1);
    expect(metric(r, "io_dscr_year1").reason).toBe("No interest is due on the debt at stabilization.");
    const all = underwrite(flat({ senior: loan(2_000_000) }), POLICY_V1);
    expect(metric(all, "cash_on_cash_year1").reason).toBe("No equity is contributed.");
  });
  // Land 400,000, NOI 120,000 at a 100% cap, refinance 1,560,000 at 0% over one year: flows with two roots (mutation-gaps has the arithmetic).
  const twoRoots = flat({ budget: land(400_000), exitCapPct: 100, holdYears: 2, refinance: { month: 12, amount: 1_560_000, ratePct: 0, amortYears: 1, ioMonths: 0 } });
  test("a partner whose flows have several roots has no IRR, for LP and GP", () => {
    // Pro rata with no preferred return and no promote, each partner's flows are the deal's scaled, so they have its two roots.
    const r = underwrite({ ...twoRoots, waterfall: { lpSharePct: 50, preferredReturnPct: 0, gpPromotePct: 0 } }, POLICY_V1);
    expect(irrRoots(r.equityFlows)).toHaveLength(2);
    expect(metric(r, "lp_irr").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "gp_irr").status).toBe("NOT_MEANINGFUL");
  });
});

describe("a kept deal's metrics", () => {
  const kept = (over: Partial<EngineInput> = {}, refi: object = {}) => flat({ holdYears: 2, exit: "refinance_hold", refinance: { month: 6, amount: 500_000, ratePct: 0, amortYears: 30, ioMonths: 0, ...refi } as EngineInput["refinance"], ...over });
  const run = (d: EngineInput) => underwrite(d, RENTAL_HOLD_DRAFT);
  test("all equity returned to the dollar: nothing left to earn on", () => {
    // Equity 1,000,000, no senior, refinance nets 1,000,000: 0 left.
    const r = run(kept({}, { amount: 1_000_000 }));
    expect(metric(r, "cash_left_in_deal").value).toBe(0);
    expect(metric(r, "cash_on_cash_after_refinance").reason).toBe("Cash left in the deal is 0 or below, so all of the equity has come back and there is nothing left to earn on.");
  });
  test("coverage after a refinance is on the level payment, even when no payment is yet due", () => {
    const r = run(kept({}, { amount: 100_000, ratePct: 0, ioMonths: 24, amortYears: 30 }));
    // 120,000 / (100,000 / 30).
    expect(metric(r, "dcr_after_refinance").value).toBeCloseTo(120_000 / (100_000 / 30), 6);
  });
  test("a refinance of nothing leaves no debt in force, and no coverage", () => {
    const r = run(kept({}, { amount: 0 }));
    expect(metric(r, "dcr_after_refinance").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "dcr_after_refinance").reason).toBe("No debt is in force after the refinance.");
  });
  test("no capitalized value: the stated value and returns give the reason, and there are no roots", () => {
    const r = run(kept({ expenseRatioPct: 120 }));
    const reason = "Final-year NOI is not positive, so the asset has no capitalized value.";
    expect(metric(r, "stated_value").reason).toBe(reason);
    expect(metric(r, "unrealized_equity_multiple").reason).toBe(reason);
    expect(r.irrRoots).toEqual([]);
  });
  test("no equity: the multiple and the IRR each say so", () => {
    const r = run(kept({ senior: loan(2_000_000, 0, 30, 24) }, { amount: 2_000_000, ioMonths: 24 }));
    expect(metric(r, "unrealized_equity_multiple").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "unrealized_equity_multiple").reason).toBe("No equity is contributed, so there is nothing to multiply.");
    expect(metric(r, "unrealized_equity_irr").reason).toBe("No equity is contributed.");
  });
  test("under water with nothing paid out: no rate of return, in those words", () => {
    // Land 1,000,000, 500,000 of senior repaid by a smaller refinance of 400,000, NOI of 120 a year: nothing ever comes back.
    const d = flat({ budget: land(1_000_000), senior: loan(500_000, 0, 30, 0), expenseRatioPct: 99.9, holdYears: 2, exit: "refinance_hold",
      refinance: { month: 6, amount: 400_000, ratePct: 0, amortYears: 30, ioMonths: 0 } });
    // Value is 120 / 10% = 1,200, far under the debt, so the unrealized leg is 0. Cash flow is negative, and the refinance costs cash: no positive flow.
    const r = run(d);
    expect(r.equityFlows.every((f) => f.amount <= 0)).toBe(true);
    expect(metric(r, "unrealized_equity_irr").reason).toBe("The equity cash flows have no rate of return (no sign change).");
  });
});

describe("selling units: flows and Unknown", () => {
  const sale = (over: Partial<EngineInput> = {}, f: object = {}): EngineInput => flat({
    budget: land(100), revenue: [], exit: "for_sale", senior: { amount: 0, ratePct: 0, ioMonths: 0 },
    forSale: { units: [{ key: "A", label: "A", units: 2, price: 10 }], presoldPct: 0, depositPct: 0, absorptionPerMonth: 0.5, commissionPct: 0, closingLagMonths: 0, carryMonthly: 10, ...f },
    ...over,
  });
  test("a date whose flows net to 0 has no sign: it does not count as a change", () => {
    // Half a unit a month, price 10, carry 10 on each unsold. Month 0: -120. Month 1: -20, a closing paid at 2.
    // Month 2: -10 and that +10 net to 0. Month 3: -10, a closing paid at 4: -, -, 0, -, + is one change.
    const L = buildForSaleLedger(sale());
    expect(L.values.flow_sign_changes).toBe(1);
  });
  test("the same for a partner's flows", () => {
    const d = sale({ waterfall: { lpSharePct: 50, preferredReturnPct: 0, gpPromotePct: 0 } });
    const flows: EquityFlow[] = [
      { month: 0, t: 0, amount: -100, kind: "contribution" },
      { month: 1, t: 1 / 12, amount: -50, kind: "contribution" }, { month: 0, t: 1 / 12, amount: 50, kind: "sale" },
      { month: 2, t: 2 / 12, amount: -10, kind: "contribution" },
      { month: 2, t: 3 / 12, amount: 120, kind: "sale" },
    ];
    const r = forSaleMetrics(d, { ...buildForSaleLedger(d), equityFlows: flows });
    expect(r.metrics.find((x) => x.key === "lp_irr")!.status).toBe("VALID");
  });
  test("reconciliation fails when debt is left, by the debt left", () => {
    // Land 2,000 with 1,000 of debt at 0%; 2 units at 10 pay 20: 980 is left. Profit 20 - 2,000 = -1,980; put in 1,000 + 0 carry; got out 0: 0 - 1,000 + 1,980 = 980.
    const L = buildForSaleLedger(sale({ budget: land(2_000), senior: { amount: 1_000, ratePct: 0, ioMonths: 0 } }, { carryMonthly: 0, absorptionPerMonth: 1 }));
    expect(L.values.profit_reconciliation_difference).toBe(980);
    expect(L.values.profit_reconciliation_pass).toBe(0);
  });
  test("half a cent of debt left is the allowance", () => {
    const left = underwrite(sale({ budget: land(1), senior: { amount: 0.005, ratePct: 0, ioMonths: 0 } }, { units: [{ key: "A", label: "A", units: 2, price: 0 }], carryMonthly: 0, absorptionPerMonth: 1 }), FOR_SALE_DRAFT);
    expect(checkOf(left, "for_sale_debt_unpaid")).toBeUndefined();
  });
  test("no cost and no revenue: profit ratios are Unknown, not 0, with the plain reason", () => {
    const free = underwrite(sale({ budget: noCost }, { carryMonthly: 0, absorptionPerMonth: 1 }), FOR_SALE_DRAFT);
    expect(metric(free, "profit_on_cost_for_sale").status).toBe("NOT_MEANINGFUL");
    expect(metric(free, "profit_on_cost_for_sale").value).toBeNull();
    expect(metric(free, "profit_on_cost_for_sale").reason).toBe("The inputs do not give this a meaningful value.");
    const unpriced = underwrite(sale({}, { units: [{ key: "A", label: "A", units: 2, price: 0 }], carryMonthly: 0, absorptionPerMonth: 1 }), FOR_SALE_DRAFT);
    expect(metric(unpriced, "margin_on_revenue").status).toBe("NOT_MEANINGFUL");
    expect(metric(unpriced, "margin_on_revenue").value).toBeNull();
  });
  test("no equity put in: the partners' figures are all Unknown", () => {
    const r = underwrite(sale({ senior: { amount: 100, ratePct: 0, ioMonths: 0 }, waterfall: { lpSharePct: 50, preferredReturnPct: 0, gpPromotePct: 0 } }, { units: [{ key: "A", label: "A", units: 2, price: 100 }], carryMonthly: 0, absorptionPerMonth: 1 }), FOR_SALE_DRAFT);
    for (const k of ["lp_irr", "gp_irr", "gp_promote"]) expect(metric(r, k).reason, k).toBe("Deal returns are not meaningful.");
  });
  test("a presale shortfall is a bound", () => {
    const r = underwrite(sale({}, { presaleThresholdPct: 50 }), FOR_SALE_DRAFT);
    const c = checkOf(r, "presale_threshold_unmet")!;
    expect([c.kind, c.severity, c.expected, c.actual]).toEqual(["bound", "error", 50, 0]);
    expect(checkOf(underwrite(sale({}, { presoldPct: 50, presaleThresholdPct: 50 }), FOR_SALE_DRAFT), "presale_threshold_unmet")).toBeUndefined();
  });
});

describe("irr: roots closer than 1e-6, relative, are one root", () => {
  // -A, A(x1 + x2), -A x1 x2 has roots at growth factors x1 and x2. Large A so bisection reaches them, and they straddle a grid point.
  const pair = (r: number, half: number) => {
    const [a, b] = [1 + r - half, 1 + r + half];
    return [{ t: 0, amount: -1e6 }, { t: 1, amount: 1e6 * (a + b) }, { t: 2, amount: -1e6 * a * b }];
  };
  test("below 100%: 4e-7 apart is within 1e-6, one root", () => {
    const roots = irrRoots(pair(0.1, 2e-7));
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBeCloseTo(0.1, 5);
  });
  test("above 100% the allowance grows with the root: 1.6e-6 apart at 200% is within 2e-6, one root", () => {
    expect(irrRoots(pair(2, 8e-7))).toHaveLength(1);
  });
  test("well apart, two", () => {
    expect(irrRoots(pair(0.1, 1e-3))).toHaveLength(2);
  });
});

describe("small branches", () => {
  test("a zero principal pays nothing whatever the term", () => {
    expect(levelPayment(0, 5, 0)).toBe(0);
  });
  test("a credit is checked against the whole budget, contingency included", () => {
    // Contingency 50, credit 10: total 40 is above 0, and 50 - 10 is not below 0.
    expect(() => validateInput(flat({ budget: { land: 0, hard: 0, soft: 0, contingency: 50, other: -10 } }))).not.toThrow();
  });
  test("every problem is named, separated, and the error says what it is", () => {
    try {
      validateInput(flat({ exitCapPct: 0, sellingCostsPct: 100 }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EngineInputError);
      expect((e as Error).name).toBe("EngineInputError");
      expect((e as Error).message).toContain("; ");
      expect((e as EngineInputError).problems).toHaveLength(2);
    }
  });
  test("with one gate not applicable, all failing says how many were measured, not four", () => {
    const scen = [
      { key: "base", label: "b", metrics: [m("development_spread", 1), m("dcr_after_refinance", 0.1)] },
      { key: "combined", label: "c", metrics: [m("sizing_dscr", null, "NOT_APPLICABLE", "n"), m("unrealized_equity_multiple", 0.1)] },
    ];
    const v = computeVerdict(scen, [], { ...RENTAL_HOLD_DRAFT, maxFailedGatesForConditions: 0 });
    expect(v.headline).toBe("All 3 gates fail.");
  });
});

describe("the ledger", () => {
  test("debt equal to the cost still needs equity for its interest", () => {
    // Land 1,000,000, 1,000,000 at 12%, 3 months. All debt at month 0 leaves nothing for interest, so the solve brings equity in.
    // D x 1.01^2 = 1,000,000: D = 980,296.05 and equity 19,703.95.
    const L = buildLedger(flat({ constructionMonths: 3, senior: loan(1_000_000, 12) }));
    expect(L.requiredEquity).toBeCloseTo(19_703.95, 1);
    expect(L.drawnDebtAtS).toBeCloseTo(1_000_000, 1);
    expect(L.converged).toBe(true);
  });
  test("a senior with no amortization and interest-only past the end is still refused: sizing needs a term", () => {
    const r = underwrite(flat({ senior: { amount: 500_000, ratePct: 5, ioMonths: 24 } }), POLICY_V1);
    expect(checkOf(r, "senior_amortization_missing")?.severity).toBe("error");
  });
  test("a senior with nothing drawn needs no amortization", () => {
    const r = underwrite(flat({ budget: noCost, senior: { amount: 500_000, ratePct: 5, ioMonths: 0 } }), POLICY_V1);
    expect(checkOf(r, "senior_amortization_missing")).toBeUndefined();
  });
  test("a loan repaid in full stops counting towards sizing", () => {
    // 12,000 at 0% over one year: 12,000 of sizing in year 1, nothing in year 2.
    expect(buildLedger(flat({ holdYears: 2, senior: loan(12_000, 0, 1) })).sizingDsByYear).toEqual([12_000, 0]);
  });
  test("half a cent from a refinance is not a flow", () => {
    const L = buildLedger(flat({ holdYears: 2, refinance: { month: 6, amount: 0.005, ratePct: 0, amortYears: 30, ioMonths: 0 } }));
    expect(L.refinance!.net).toBe(0.005);
    expect(L.equityFlows.some((f) => f.kind === "refinance")).toBe(false);
  });
});

describe("explore: shocks", () => {
  test("a rate cut stops at 0 on the mezzanine, in both modes", () => {
    expect(shockInput(flat({ mezzanine: loan(100, 1) }), { rateBps: -200 }).mezzanine!.ratePct).toBe(0);
    const sale = flat({ revenue: [], exit: "for_sale", senior: { amount: 0, ratePct: 0, ioMonths: 0 }, mezzanine: loan(100, 1), forSale: { units: [{ key: "A", label: "A", units: 2, price: 200 }], presoldPct: 0, depositPct: 0, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 0 } });
    expect(shockInput(sale, { rateBps: -200 }).mezzanine!.ratePct).toBe(0);
  });
  test("a refinance with no timeline shock stays where it is, after a lease-up", () => {
    // S = 12, T = 35: month 20 is allowed.
    const d = flat({ leaseUpMonths: 12, holdYears: 2, refinance: { month: 20, amount: 100, ratePct: 5, amortYears: 25, ioMonths: 0 } });
    expect(shockInput(d, { costPct: 0 }).refinance!.month).toBe(20);
  });
  test("unknown metrics and equal drivers are refused in words; a grid's unknown metric is empty", () => {
    expect(() => tornado(flat(), "nope")).toThrow('Unknown metric "nope"');
    expect(() => grid(flat(), "yield_on_cost", "rentPct", "rentPct")).toThrow("Choose two different drivers");
    expect(grid(flat(), "nope", "rentPct", "costPct", 3).cells.flat()).toEqual(Array(9).fill(null));
  });
  test("only the missing amortization is forgiven: another failure surfaces", () => {
    expect(() => tornado(flat({ senior: loan(100, 5, 0) }), "yield_on_cost")).toThrow("months must be positive");
  });
});

describe("solveBreakeven", () => {
  const at = (first: number) => (n: number) => ({ pass: n >= first, value: n });
  test("no range at all has no effect", () => {
    expect(solveBreakeven(at(0), 0).state).toBe("no_effect");
  });
  test("a range of one step can be the answer", () => {
    expect(solveBreakeven(at(1), 1)).toEqual({ state: "value", n: 1 });
  });
  test("passing at the start is not an answer", () => {
    expect(solveBreakeven(at(0), 8).state).toBe("not_monotonic");
  });
  test("the answer is checked once found: a probe that changes its mind is not steady", () => {
    // 16 steps: nine samples, then 3, then the two checks, so call 11 is the check of the answer and call 12 of one step short.
    let calls = 0;
    const flaky = (n: number) => { calls++; return { pass: calls <= 10 ? n >= 3 : false, value: n }; };
    expect(solveBreakeven(flaky, 16).state).toBe("not_monotonic");
    let more = 0;
    const late = (n: number) => { more++; return { pass: more <= 11 ? n >= 3 : true, value: n }; };
    expect(solveBreakeven(late, 16).state).toBe("not_monotonic");
  });
});

describe("breakeven, by relation", () => {
  const spec = (metricKey: string, threshold: number, scenario = "base"): GateSpec => ({ key: "g", label: "g", scenario, metricKey, threshold });
  const value = (d: EngineInput, key: string) => baseMetrics(d).find((x) => x.key === key)!.value!;
  const row = (d: EngineInput, s: GateSpec, driver: string, p = POLICY_V1 as Parameters<typeof breakeven>[1]) => breakeven(d, p, [s]).rows.find((r) => r.driver === driver)!;
  test("the answer passes its gate and one step short fails", () => {
    // Yield 12% on 1,000,000. For 12.5% cost must fall to 960,000: -4%.
    const d = flat();
    const r = row(d, spec("yield_on_cost", 12.5), "costPct");
    expect(r.state).toBe("value");
    expect(r.shock!).toBeCloseTo(-4, 0);
    expect(r.actual!).toBeGreaterThanOrEqual(12.5);
    expect(value(shockInput(d, { costPct: r.shock! + 0.1 }), "yield_on_cost")).toBeLessThan(12.5);
  });
  test("a cost echo adds every line of the budget", () => {
    // 100 + 200 + 300 + 400 + 50 + 10 + 20 + 30 = 1,110.
    const d = flat({ budget: { land: 100, hard: 200, soft: 300, contingency: 400, other: 50, developmentCharges: 10, landTransferTax: 20, gstHstNet: 30 } });
    const s = spec("yield_on_cost", value(d, "yield_on_cost") * 1.05);
    const r = row(d, s, "costPct");
    expect(r.to[0]!.from).toBe(1110);
    expect(r.to[0]!.to).toBeCloseTo(1110 * (1 + r.shock! / 100), 6);
  });
  test("a rent echo gives each line in its own terms", () => {
    const d = flat({ revenue: [{ key: "A", label: "Flats", basis: "per_unit", units: 10, rentMonthly: 1000 }, { key: "S", label: "Shop", basis: "per_sf", units: 0, areaSf: 1000, rentPsfAnnual: 20 }] });
    const r = row(d, spec("yield_on_cost", value(d, "yield_on_cost") * 1.05), "rentPct");
    expect(r.state).toBe("value");
    const factor = 1 + r.shock! / 100;
    expect(r.to).toHaveLength(2);
    expect(r.to[0]).toMatchObject({ key: "rent", item: "Flats", from: 1000, unit: "$/unit/mo" });
    expect(r.to[1]).toMatchObject({ key: "rent", item: "Shop", from: 20, unit: "$/sf/yr" });
    expect(r.to[1]!.to).toBeCloseTo(20 * factor, 6);
  });
  test("a rate echo names only the loans that exist; a senior with no amount has no rate to move", () => {
    // 100,000 of mezzanine at 8%: lower rates raise coverage. The unused senior's 9% is neither moved nor reached for.
    const d = flat({ senior: { amount: 0, ratePct: 9, amortYears: 30, ioMonths: 0 }, mezzanine: loan(100_000, 8) });
    const r = row(d, spec("contractual_dscr", value(d, "contractual_dscr") * 1.02), "rateBps");
    expect(r.state).toBe("value");
    expect(r.limit).toBe(-800);
    expect(r.to).toHaveLength(1);
    expect(r.to[0]).toMatchObject({ key: "mezzanine_rate", from: 8, unit: "%" });
    expect(r.to[0]!.to).toBeCloseTo(8 + r.shock! / 100, 9);
  });
  test("no loans: the rate driver has no reach, whatever an unused rate says", () => {
    const d = flat({ senior: { amount: 0, ratePct: 9, amortYears: 30, ioMonths: 0 } });
    const r = row(d, spec("yield_on_cost", 50), "rateBps");
    expect(r.state).toBe("no_effect");
    expect(Math.abs(r.limit)).toBe(0);
  });
  test("exit cap: it may fall to 0.25%, so 1.25% has 100 bps", () => {
    const r = row(flat({ exitCapPct: 1.25 }), spec("yield_on_cost", 50), "exitCapBps");
    expect(r.state).toBe("no_effect");
    expect(r.limit).toBe(-100);
    expect(r.reason).toBe("Within -100 bps, this input does not change the gate's figure.");
  });
  test("what cannot be reached, and what has no effect, say so with a plus when the move is up", () => {
    const d = flat({ revenue: [{ key: "A", label: "A", basis: "per_unit", units: 1, rentMonthly: 0 }], otherIncomeAnnual: 120_000 });
    const none = row(d, spec("yield_on_cost", 50), "rentPct");
    expect(none.state).toBe("no_effect");
    expect(none.reason).toBe("Within +100%, this input does not change the gate's figure.");
    const far = row(flat(), spec("yield_on_cost", 500), "rentPct");
    expect(far.state).toBe("out_of_range");
    expect(far.reason).toBe("Not within +100%");
  });
  test("a gate in a scenario the policy does not have is not measured, so it gets no rows", () => {
    expect(breakeven(flat(), POLICY_V1, [spec("yield_on_cost", 50, "no_such_stress")]).rows).toEqual([]);
  });
  test("an input the engine refuses is refused here", () => {
    expect(() => breakeven(flat({ exitCapPct: 0 }), POLICY_V1, [])).toThrow(EngineInputError);
  });
  describe("selling", () => {
    const d = flat({ budget: land(100), revenue: [], exit: "for_sale", senior: { amount: 0, ratePct: 0, ioMonths: 0 },
      forSale: { units: [{ key: "A", label: "A", units: 10, price: 100 }], presoldPct: 30, depositPct: 0, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 1 } });
    // Faster sales and more presales cut the carry, so profit on cost rises.
    const s = spec("profit_on_cost_for_sale", value(d, "profit_on_cost_for_sale") + 1);
    test("sales pace echoes units a month", () => {
      const r = breakeven(d, FOR_SALE_DRAFT, [s]).rows.find((x) => x.driver === "absorptionPct")!;
      expect(r.state).toBe("value");
      expect(r.to).toHaveLength(1);
      expect(r.to[0]).toMatchObject({ key: "absorption", from: 1, unit: "units" });
      expect(r.to[0]!.to).toBeCloseTo(1 + r.shock! / 100, 9);
    });
    test("presales echo points, up to 100% and no further", () => {
      const r = breakeven(d, FOR_SALE_DRAFT, [s]).rows.find((x) => x.driver === "presalesPts")!;
      expect(r.limit).toBe(70);
      expect(r.state).toBe("value");
      expect(r.to[0]).toMatchObject({ key: "presales", from: 30, unit: "%" });
      expect(r.to[0]!.to).toBeCloseTo(30 + r.shock!, 9);
    });
  });
});

// The rules at the top of readiness.ts, and the sentence in its table: a person is sent to the field the problem is about.
describe("readiness: who is named, and who is not", () => {
  type St = AssumptionRow["status"];
  const row = (fieldKey: string, valueNumeric: number | null, itemKey: string | null = null, status: St = "approved"): AssumptionRow => ({ fieldKey, itemKey, valueNumeric, status });
  const rental = (): AssumptionRow[] => [row("land_cost", 1_000_000), row("hard_cost", 0), row("soft_cost", 0), row("contingency", 0), row("construction_months", 0),
    row("lease_up_months", 0), row("hold_years", 1), row("stabilized_occupancy_pct", 100), row("expense_ratio_pct", 0), row("exit_cap_rate_pct", 10),
    row("selling_costs_pct", 0), row("senior_loan_amount", 0), row("unit_count", 10, "A"), row("unit_rent_monthly", 1_000, "A")];
  const sale = (): AssumptionRow[] => [row("sell_units", 1), row("land_cost", 1_000), row("hard_cost", 0), row("soft_cost", 0), row("contingency", 0), row("construction_months", 0),
    row("senior_loan_amount", 0), row("presold_units_pct", 0), row("deposit_pct", 0), row("absorption_units_per_month", 1), row("sales_commission_pct", 0),
    row("closing_lag_months", 0), row("unsold_carry_monthly", 0), row("unit_count", 2, "Row"), row("unit_sale_price", 2_000, "Row")];
  const without = (rows: AssumptionRow[], ...keys: string[]) => rows.filter((r) => !keys.includes(r.fieldKey));
  const keys = (xs: { fieldKey: string }[]) => xs.map((x) => x.fieldKey);
  const R = (rows: AssumptionRow[]) => assemble(rows).readiness;

  test.each([["presold_units_pct", 101], ["deposit_pct", 101], ["sales_commission_pct", 101], ["senior_presale_threshold_pct", 101], ["absorption_units_per_month", 0], ["closing_lag_months", -1], ["unsold_carry_monthly", -1]] as [string, number][])(
    "a bad %s sends the person to that field", (key, bad) => {
      const r = R([...without(sale(), key), row(key, bad)]);
      expect(keys(r.impossible)).toEqual([key]);
      expect(r.status).toBe("blocked");
    });
  test("a bad sale price sends the person to that item's price", () => {
    const i = R([...without(sale(), "unit_sale_price"), row("unit_sale_price", -1, "Row")]).impossible;
    expect(i).toHaveLength(1);
    expect([i[0]!.fieldKey, i[0]!.itemKey]).toEqual(["unit_sale_price", "Row"]);
  });
  test("one item two ways: named in sorted order however the rows came, and its rows are not read at all", () => {
    const base = without(rental(), "unit_count", "unit_rent_monthly");
    const r = R([...base, row("unit_count", 1, "shop"), row("unit_count", 9, "shop", "needs_review"), row("unit_count", 2, "Shop"), row("unit_count", 3, "Shop"), row("unit_rent_monthly", 5, "Shop", "needs_review")]);
    expect(r.impossible[0]!.label).toBe("Shop and shop are one item written two ways");
    expect(r.conflicting).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.missing.filter((x) => x.itemKey)).toEqual([]);
  });
  test("review beside a value with no number is still pending", () => {
    const r = R([...without(rental(), "land_cost"), row("land_cost", 5, null, "needs_review"), row("land_cost", null)]);
    expect(keys(r.pending)).toEqual(["land_cost"]);
  });
  describe("a value from the other mode", () => {
    test("is named when any row of it is readable", () => {
      expect(keys(R([...rental(), row("presold_units_pct", 5), row("presold_units_pct", 5, null, "needs_review")]).impossible)).toEqual(["presold_units_pct"]);
    });
    test("is not also named if it conflicts", () => {
      const r = R([...rental(), row("presold_units_pct", 5), row("presold_units_pct", 6)]);
      expect(keys(r.conflicting)).toEqual(["presold_units_pct"]);
      expect(r.impossible).toEqual([]);
    });
    test("per item: a conflict on one item leaves the other item named", () => {
      const r = R([...rental(), row("unit_sale_price", 5, "A"), row("unit_sale_price", 6, "A"), row("unit_sale_price", 7, "B")]);
      expect(r.conflicting.map((x) => x.itemKey)).toEqual(["A"]);
      expect(r.impossible.filter((x) => x.fieldKey === "unit_sale_price").map((x) => x.itemKey)).toEqual(["B"]);
    });
    test("replaces only its own bounds complaint", () => {
      const r = R([...without(rental(), "land_cost"), row("land_cost", -1), row("presold_units_pct", 500), row("unit_sale_price", -1, "A"), row("unit_sale_price", -1, "B")]);
      expect(r.impossible.map((x) => [x.fieldKey, x.itemKey ?? null])).toEqual(expect.arrayContaining([["land_cost", null], ["presold_units_pct", null], ["unit_sale_price", "A"], ["unit_sale_price", "B"]]));
      expect(r.impossible.filter((x) => x.fieldKey === "presold_units_pct")).toHaveLength(1);
      expect(r.impossible.find((x) => x.itemKey === "A")!.label).toBe("Sale price per unit applies only when the units are sold");
    });
    test("with both modes chosen, only refinance_and_hold is left out", () => {
      const r = R([...sale(), row("refinance_and_hold", 1), row("hold_years", 3)]);
      expect(keys(r.impossible)).toEqual(expect.arrayContaining(["sell_units", "hold_years"]));
      expect(keys(r.impossible)).not.toContain("refinance_and_hold");
    });
  });
  test("a blocked field excuses itself only", () => {
    for (const status of ["conflicting", "needs_review"] as St[]) {
      const r = R([...without(rental(), "land_cost", "hard_cost"), row("land_cost", 1, null, status)]);
      expect(keys(r.missing), status).toEqual(["hard_cost"]);
    }
    // A blocked item's line does not excuse the deal's field of the same name.
    const item = R([...without(rental(), "land_cost"), row("unit_count", 11, "A")]);
    expect(keys(item.missing)).toEqual(["land_cost"]);
    const pendingItem = R([...without(rental(), "land_cost"), row("unit_count", 1, "B", "needs_review")]);
    expect(keys(pendingItem.missing)).toEqual(["land_cost"]);
    const wrong = R([...without(rental(), "land_cost"), row("land_cost", null), row("hard_cost", -1)]);
    expect(keys(wrong.missing)).toEqual(["land_cost"]);
  });
  test("occupancy stands in only with items, and a rejected item does not count against it", () => {
    const base = without(rental(), "stabilized_occupancy_pct", "unit_count", "unit_rent_monthly");
    expect(keys(R(base).missing)).toContain("stabilized_occupancy_pct");
    const r = assemble([...without(rental(), "stabilized_occupancy_pct"), row("item_occupancy_pct", 90, "A"), row("unit_count", 1, "B", "rejected"), row("unit_rent_monthly", 1, "B", "rejected")]);
    expect(r.readiness.status).toBe("ready");
    expect(r.input!.stabilizedOccupancyPct).toBe(90);
  });
  const heldRows = (...more: AssumptionRow[]) => [...without(rental(), "hold_years"), row("hold_years", 2), row("refinance_and_hold", 1), row("refinance_month", 6), row("refinance_rate_pct", 5), row("refinance_amort_years", 30), ...more];
  test("the held senior's excuse is for its amortization only", () => {
    const rows = heldRows(row("refinance_amount", 100), row("senior_io_months", 12));
    const r = R([...without(rows, "senior_loan_amount", "land_cost"), row("senior_loan_amount", 100), row("senior_rate_pct", 5)]);
    expect(keys(r.missing)).toEqual(["land_cost"]);
  });
  test("a sale's other item does not excuse this one", () => {
    const r = R([...without(sale(), "unit_count", "unit_sale_price"), row("unit_sale_price", 5, "Row", "needs_review")]);
    expect(r.missing).toEqual([{ fieldKey: "unit_count", itemKey: "Row", label: "Units (Row)" }]);
  });
  test("a rental's blocked item holds only that item, and only on its own lines", () => {
    const r = R([...rental(), row("unit_rent_monthly", 5, "B", "needs_review"), row("unit_count", 2, "C")]);
    expect(r.missing).toEqual([{ fieldKey: "unit_rent_monthly", itemKey: "C", label: "Rent (C)" }]);
    const land = R([...rental(), row("land_cost", 5), row("unit_count", 2, "C")]);
    expect(land.missing).toEqual([{ fieldKey: "unit_rent_monthly", itemKey: "C", label: "Rent (C)" }]);
  });
  test("a per-SF line with no occupancy has no occupancy key", () => {
    const { input } = assemble([...without(rental(), "unit_count", "unit_rent_monthly"), row("rentable_area_sf", 100, "S"), row("rent_psf_annual", 20, "S")]);
    expect(Object.hasOwn(input!.revenue[0]!, "occupancyPct")).toBe(false);
  });
  test("insured under 50 points: a term is required from 7 units, and a stated one is taken", () => {
    const insured = (units: number, ...more: AssumptionRow[]) => [...without(heldRows(row("refinance_amount", 100), row("refinance_insurance_premium_pct", 4)), "unit_count"), row("unit_count", units, "A"), ...more];
    expect(keys(R(insured(7)).missing)).toEqual(["refinance_term_years"]);
    expect(keys(R(insured(6)).missing)).toEqual([]);
    expect(R(insured(7, row("refinance_term_years", 10))).status).toBe("ready");
    expect(assemble(insured(6)).readiness.notFound.concat(assemble(insured(6)).readiness.choices).map((x) => x.fieldKey)).toContain("refinance_term_years");
    expect(assemble(insured(6)).readiness.notFound.concat(assemble(insured(6)).readiness.choices).map((x) => x.fieldKey)).toContain("refinance_premium_tax_pct");
  });
  test("a refinance with neither loan size lists both as not found", () => {
    const shown = (rows: AssumptionRow[]) => { const r = R(rows); return [...r.notFound, ...r.choices].map((x) => x.fieldKey); };
    const none = shown(heldRows());
    expect(none).toEqual(expect.arrayContaining(["refinance_amount", "refinance_ltv_pct"]));
    expect(shown(heldRows(row("refinance_amount", 100)))).not.toContain("refinance_ltv_pct");
    expect(shown(heldRows(row("refinance_ltv_pct", 50)))).not.toContain("refinance_amount");
  });
  test("a sale's stated total cost keeps its number", () => {
    expect(assemble([...sale(), row("stated_total_cost", 5)]).input!.stated.totalCost).toBe(5);
  });
});

