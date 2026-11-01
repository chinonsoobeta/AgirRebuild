// Tests that close surviving mutants. Each states the behaviour it pins and where the number comes from:
// the specification or arithmetic on small round inputs, written out. None is copied from the engine's output.
import { describe, expect, test } from "vitest";
import { FOR_SALE_DRAFT, POLICY_V1, RENTAL_HOLD_DRAFT, RENTAL_HOLD_INSURED_DRAFT, type Check, type EngineInput, type EquityFlow, type RunResult } from "@agir/contracts";
import { applyStress, buildForSaleLedger, buildLedger, canonicalJson, heldPartnerReturns, irrRoots, replay, runWaterfall, underwrite, validateInput, ENGINE_VERSION } from "../src/index.ts";
import { allocate, cents, drawShares, levelPayment, ratio } from "../src/math.ts";
import { m } from "../src/metrics.ts";
import { computeVerdict, gateStatusOf } from "../src/verdict.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const metric = (r: RunResult, key: string, scenario = "base") => r.scenarios.find((s) => s.key === scenario)!.metrics.find((x) => x.key === key)!;
const checkOf = (r: RunResult, key: string): Check | undefined => r.checks.find((c) => c.key === key);
const flat = (over: Partial<EngineInput> = {}): EngineInput => ({ ...allEquityDeal(), ...over });

describe("math", () => {
  test("cents rounds half away from zero", () => {
    expect(cents(1.234)).toBe(1.23);
    expect(cents(-1.236)).toBe(-1.24);
    expect(cents(2.5)).toBe(2.5);
    expect(cents(0)).toBe(0);
  });
  test("allocate gives each leftover cent to the largest remainder, ties to the earliest", () => {
    expect(allocate(1, [])).toEqual([]);
    // 100 cents over three: 33.33 each, one left, tie, so the first.
    expect(allocate(1, [1, 1, 1])).toEqual([0.34, 0.33, 0.33]);
    // 2 cents at 11:9: 1.1 and 0.9, floors 1 and 0, one left goes to the 0.9.
    expect(allocate(0.02, [11, 9])).toEqual([0.01, 0.01]);
    // 3 cents at 1:4:5: 0.3, 1.2, 1.5, floors 0, 1, 1, one left goes to the 0.5.
    expect(allocate(0.03, [1, 4, 5])).toEqual([0, 0.01, 0.02]);
    expect(() => allocate(1, [0, 0])).toThrow("weights must sum");
  });
  test("levelPayment", () => {
    expect(levelPayment(0, 5, 12)).toBe(0);
    expect(levelPayment(-5, 5, 12)).toBe(0);
    expect(() => levelPayment(100, 5, 0)).toThrow("months must be positive");
    expect(() => levelPayment(100, 5, -1)).toThrow("months must be positive");
    expect(levelPayment(1200, 0, 12)).toBe(100);
  });
  test("a straight-line draw over 4 months is a quarter each, and no build is one share", () => {
    expect(drawShares(4, false)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(drawShares(0, true)).toEqual([1]);
  });
  test("a ratio of anything not finite, or over zero, is not meaningful", () => {
    expect(ratio(NaN, 1)).toBeNull();
    expect(ratio(Infinity, 1)).toBeNull();
    expect(ratio(1, NaN)).toBeNull();
    expect(ratio(1, Infinity)).toBeNull();
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(6, 3)).toBe(2);
  });
});

describe("irr: every root in range, once", () => {
  const f = (...a: [number, number][]) => a.map(([t, amount]) => ({ t, amount }));
  test("a root below -50%: pay 100, get 10 a year later, is -90%", () => {
    const r = irrRoots(f([0, -100], [1, 10]));
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(-0.9, 6);
  });
  test("a root above 100%: pay 100, get 500 a year later, is 400%", () => {
    const r = irrRoots(f([0, -100], [1, 500]));
    expect(r).toHaveLength(1);
    expect(r[0]).toBeCloseTo(4, 6);
  });
  test("a root exactly on the grid is counted once: pay 100, get 200 is exactly 100%", () => {
    expect(irrRoots(f([0, -100], [1, 200]))).toEqual([1]);
  });
  test("two roots: -100, +230, -132 solves 100x^2 - 230x + 132 = 0, so x = 1.1 and 1.2", () => {
    const r = irrRoots(f([0, -100], [1, 230], [2, -132]));
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 6);
    expect(r[1]).toBeCloseTo(0.2, 6);
  });
  test("no sign change has no root, and a zero flow is ignored", () => {
    expect(irrRoots(f([0, 100], [1, 100]))).toEqual([]);
    expect(irrRoots(f([0, -100], [1, -100]))).toEqual([]);
    expect(irrRoots(f([0, 0], [1, 0]))).toEqual([]);
    expect(irrRoots(f([0, -100], [0.5, 0], [1, 110]))[0]).toBeCloseTo(0.1, 6);
  });
});

describe("waterfall, by hand", () => {
  const flows: EquityFlow[] = [
    { month: 11, t: 1, amount: 300, kind: "sale" },
    { month: 0, t: 0, amount: -100, kind: "contribution" },
  ];
  // LP 80%, 10% preferred, 20% promote. Contribution: LP -80, GP -20; hurdle 80, compounds to 88 at t = 1.
  // Tier 1 needs 88 / 0.8 = 110: LP 88, GP 22. Left 190: promote 38, rest 152: LP 121.6, GP 30.4 + 38.
  // Promote above pro rata: 38 + 30.4 - 190 x 0.2 = 30.4.
  const w = runWaterfall(flows, { lpSharePct: 80, preferredReturnPct: 10, gpPromotePct: 20 });
  const total = (xs: { amount: number }[]) => xs.reduce((a, x) => a + x.amount, 0);
  test("each partner's money and the promote; the flows are read in date order", () => {
    expect(total(w.lp)).toBeCloseTo(-80 + 88 + 121.6, 6);
    expect(total(w.gp)).toBeCloseTo(-20 + 22 + 68.4, 6);
    expect(w.promote).toBeCloseTo(30.4, 6);
  });
  test("a held deal's partners: an IRR with no root is null, and paid leaves out the unrealized flow", () => {
    const held: EquityFlow[] = [
      { month: 0, t: 0, amount: -100, kind: "contribution" },
      { month: 11, t: 1, amount: 50, kind: "operating" },
      { month: 11, t: 1, amount: 200, kind: "unrealized" },
    ];
    const terms = { lpSharePct: 50, preferredReturnPct: 0, gpPromotePct: 0 };
    const r = heldPartnerReturns(held, terms);
    // Pro rata at 50%: each puts in 50, gets 125: 150% for both.
    expect(r.withValue.lpIrr).toBeCloseTo(150, 4);
    expect(r.withValue.gpIrr).toBeCloseTo(150, 4);
    expect(total(r.paid.lp)).toBeCloseTo(-50 + 25, 6);
    const none = heldPartnerReturns([{ month: 0, t: 0, amount: 100, kind: "operating" }], terms);
    expect(none.withValue.lpIrr).toBeNull();
    expect(none.withValue.gpIrr).toBeNull();
  });
  test("the metrics carry the waterfall: all-equity deal, LP 80%, no preferred, 20% promote", () => {
    // Land 1,000,000, NOI 120,000, value 1,200,000, all at t = 1 and 0 before: LP -800,000, GP -200,000.
    // Operating 120,000 (hurdle 800,000, needs 1,000,000): LP 96,000, GP 24,000; hurdle 704,000.
    // Sale 1,200,000: tier 1 needs 880,000: LP 704,000, GP 176,000. Left 320,000: promote 64,000, rest 256,000: LP 204,800, GP 51,200 + 64,000.
    // LP gets 1,004,800 on 800,000 = 25.6%. GP gets 315,200 on 200,000 = 57.6%. Promote above pro rata: 320,000 x 0.2 x 0.8 = 51,200.
    const r = underwrite(flat({ waterfall: { lpSharePct: 80, preferredReturnPct: 0, gpPromotePct: 20 } }), POLICY_V1);
    expect(metric(r, "lp_irr").value).toBeCloseTo(25.6, 4);
    expect(metric(r, "gp_irr").value).toBeCloseTo(57.6, 4);
    expect(metric(r, "gp_promote").value).toBeCloseTo(51_200, 4);
    expect(metric(underwrite(flat(), POLICY_V1), "lp_irr").status).toBe("NOT_APPLICABLE");
  });
  test("a waterfall on a deal with no capitalized value, or no equity, is not meaningful", () => {
    const w2 = { lpSharePct: 80, preferredReturnPct: 0, gpPromotePct: 20 };
    const lost = underwrite(flat({ waterfall: w2, expenseRatioPct: 120 }), POLICY_V1);
    const noEquity = underwrite(flat({ waterfall: w2, senior: { amount: 2_000_000, ratePct: 0, amortYears: 30, ioMonths: 0 } }), POLICY_V1);
    for (const r of [lost, noEquity]) for (const k of ["lp_irr", "gp_irr", "gp_promote"]) {
      expect(metric(r, k).status, k).toBe("NOT_MEANINGFUL");
      expect(metric(r, k).reason).toBe("Deal returns are not meaningful.");
    }
  });
});

describe("canonical json", () => {
  test("keys sort, undefined is dropped from objects and null elsewhere, and non-finite is refused", () => {
    expect(canonicalJson({ b: 1, a: [2, undefined, null], c: undefined })).toBe('{"a":[2,null,null],"b":1}');
    expect(canonicalJson(undefined)).toBe("null");
    expect(() => canonicalJson(NaN)).toThrow("non-finite");
    expect(() => canonicalJson({ a: [Infinity] })).toThrow("non-finite");
  });
});

describe("stress: what each shock touches", () => {
  const p = (o: object) => ({ key: "x", label: "x", ...o });
  test("a cost shock scales every positive line; a credit shrinks in a fall and does not grow in an overrun", () => {
    const d = flat({ budget: { land: 100, hard: 200, soft: 300, contingency: 400, other: -50, developmentCharges: 10, landTransferTax: 20, gstHstNet: 30 } });
    const up = applyStress(d, p({ costPct: 10 })).budget;
    expect(up.land).toBeCloseTo(110, 9);
    expect(up.hard).toBeCloseTo(220, 9);
    expect(up.soft).toBeCloseTo(330, 9);
    expect(up.contingency).toBeCloseTo(440, 9);
    expect(up.other).toBe(-50);
    expect(up.developmentCharges).toBeCloseTo(11, 9);
    expect(up.landTransferTax).toBeCloseTo(22, 9);
    expect(up.gstHstNet).toBeCloseTo(33, 9);
    expect(applyStress(d, p({ costPct: -10 })).budget.other).toBeCloseTo(-45, 9);
    expect(applyStress(flat({ budget: { ...d.budget, other: 100 } }), p({ costPct: 10 })).budget.other).toBeCloseTo(110, 9);
  });
  test("a rent shock leaves a per-SF line without a monthly rent, and a rate shock skips a senior with no amount", () => {
    const d = flat({ revenue: [{ key: "S", label: "S", basis: "per_sf", units: 0, areaSf: 100, rentPsfAnnual: 20 }] });
    const c = applyStress(d, p({ rentPct: -10 })).revenue[0]!;
    expect(Object.hasOwn(c, "rentMonthly")).toBe(false);
    expect(c.rentPsfAnnual).toBeCloseTo(18, 9);
    expect(applyStress(flat(), p({ rateBps: 150 })).senior.ratePct).toBe(0);
    const { expenseRatioPct: _e, ...rest } = flat();
    expect(Object.hasOwn(applyStress({ ...rest, fixedOpexAnnual: 10 }, p({ rentPct: -10 })), "variableExpensePct")).toBe(false);
  });
});

describe("funding", () => {
  test("the solve, by hand: 100,000 at 12%, land at month 0, three months", () => {
    // Debt drawn at month 0 grows at 1% for two months and must reach 100,000: 100,000 / 1.0201 = 98,029.605.
    // So equity is 1,000,000 - 98,029.605 = 901,970.395 and interest is 1,970.395.
    const L = buildLedger(flat({ constructionMonths: 3, senior: { amount: 100_000, ratePct: 12, amortYears: 30, ioMonths: 0 } }));
    expect(L.requiredEquity).toBeCloseTo(901_970.395, 1);
    expect(L.capitalizedInterest).toBeCloseTo(1_970.395, 1);
    expect(L.converged).toBe(true);
  });
  test("debt that covers everything converges with no equity and no contribution", () => {
    const L = buildLedger(flat({ senior: { amount: 2_000_000, ratePct: 0, amortYears: 30, ioMonths: 0 } }));
    expect(L.converged).toBe(true);
    expect(L.requiredEquity).toBe(0);
    expect(L.drawnDebtAtS).toBe(1_000_000);
    expect(L.equityFlows.some((f) => f.kind === "contribution")).toBe(false);
  });
  test("mezzanine interest past its commitment is paid in kind", () => {
    // Equity 900,000 and mezzanine 100,000 at month 0; month 1's interest is 100,000 x 12% / 12 = 1,000, with no commitment left.
    const L = buildLedger(flat({ constructionMonths: 2, mezzanine: { amount: 100_000, ratePct: 12, amortYears: 30, ioMonths: 0 } }));
    expect(L.mezzAccruedBeyondCommitment).toBeCloseTo(1_000, 6);
    expect(L.balancesAtS.mezzanine).toBeCloseTo(101_000, 6);
    expect(L.requiredEquity).toBeCloseTo(900_000, 6);
    expect(L.tdc).toBeCloseTo(1_001_000, 6);
  });
});

describe("a refinance, by hand", () => {
  // S = 0, T = 23. Equity 400,000, mezzanine 100,000 at 0% over 10 years = 833.33 a month, senior 500,000 at 12% = 5,000 interest.
  const held = (): EngineInput => flat({
    holdYears: 2,
    exit: "refinance_hold",
    senior: { amount: 500_000, ratePct: 12, amortYears: 30, ioMonths: 12 },
    mezzanine: { amount: 100_000, ratePct: 0, amortYears: 10, ioMonths: 0 },
    refinance: { month: 6, amount: 500_000, ratePct: 0, amortYears: 10, ioMonths: 0 },
  });
  test("it pays off the senior, not the mezzanine, and only the senior is sized on interest", () => {
    const L = buildLedger(held());
    expect(L.refinance!.payoff).toBe(500_000);
    // 12 x 833.33 = 10,000.
    expect(L.mezzSizingYear1).toBeCloseTo(10_000, 6);
    // 6 x 5,000 interest, then 6 x 500,000 / 120 = 25,000.
    expect(L.seniorSizingYear1).toBeCloseTo(55_000, 6);
  });
  test("with no senior it adds a loan and keeps the mezzanine", () => {
    const d = flat({
      holdYears: 2,
      mezzanine: { amount: 100_000, ratePct: 0, amortYears: 10, ioMonths: 0 },
      refinance: { month: 6, amount: 120_000, ratePct: 0, amortYears: 10, ioMonths: 0 },
    });
    const L = buildLedger(d);
    expect(L.refinance!.payoff).toBe(0);
    expect(L.refinance!.net).toBe(120_000);
    // 833.33 mezzanine + 120,000 / 120 = 1,000.
    expect(L.rows[6]!.debtService).toBeCloseTo(1_833.333333, 4);
    const alone = buildLedger(flat({ holdYears: 2, refinance: { month: 6, amount: 120_000, ratePct: 0, amortYears: 10, ioMonths: 0 } }));
    expect(alone.rows[6]!.debtService).toBe(1_000);
  });
  test("its interest-only months count from the refinance", () => {
    // 120,000 at 12% is 1,200 a month, interest only for months 6 to 11.
    const L = buildLedger(flat({ holdYears: 2, refinance: { month: 6, amount: 120_000, ratePct: 12, amortYears: 10, ioMonths: 6 } }));
    expect(L.rows[6]!.debtService).toBeCloseTo(1_200, 6);
    expect(L.rows[11]!.debtService).toBeCloseTo(1_200, 6);
    expect(L.rows[12]!.debtService).toBeGreaterThan(1_200);
  });
  test("a refinance that only repays leaves no refinance flow, and flows are in date order", () => {
    const even = buildLedger(flat({ holdYears: 2, senior: { amount: 500_000, ratePct: 12, amortYears: 30, ioMonths: 12 }, refinance: { month: 6, amount: 500_000, ratePct: 12, amortYears: 30, ioMonths: 0 } }));
    expect(even.equityFlows.some((f) => f.kind === "refinance")).toBe(false);
    const later = buildLedger(flat({ holdYears: 3, refinance: { month: 18, amount: 100_000, ratePct: 0, amortYears: 10, ioMonths: 0 } }));
    const ts = later.equityFlows.map((f) => f.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(later.equityFlows.some((f) => f.kind === "refinance")).toBe(true);
  });
  test("a forward NOI that is not positive gives a value of 0 and a loan of 0, never a negative loan", () => {
    const L = buildLedger(flat({ expenseRatioPct: 120, holdYears: 2, refinance: { month: 6, ltvPct: 70, ratePct: 5, amortYears: 25, ioMonths: 0 } }));
    expect(L.refinance!.value).toBe(0);
    expect(L.refinance!.newAmount).toBe(0);
  });
  test("two sets of roots in the flows reach the IRR as not meaningful, in a sale and in a hold", () => {
    // Land 400,000. NOI 120,000 a year at a 100% cap: value 120,000. Refinance 1,560,000 at 0% over 1 year at month 12.
    // t=0: -400,000. t=1: 120,000 + 1,560,000. t=2: 120,000 - 1,560,000 + 120,000 = -1,320,000.
    // x^2 - 4.2x + 3.3 = 0: x = 1.04643 and 3.15357, so 4.64% and 215.36%.
    const d = flat({ budget: { land: 400_000, hard: 0, soft: 0, contingency: 0, other: 0 }, exitCapPct: 100, holdYears: 2, refinance: { month: 12, amount: 1_560_000, ratePct: 0, amortYears: 1, ioMonths: 0 } });
    const sale = metric(underwrite(d, POLICY_V1), "equity_irr");
    expect(sale.status).toBe("NOT_MEANINGFUL");
    expect(sale.reason).toContain("2 IRRs (4.64%, 215.36%)");
    const kept = metric(underwrite({ ...d, exit: "refinance_hold" }, RENTAL_HOLD_DRAFT), "unrealized_equity_irr");
    expect(kept.status).toBe("NOT_MEANINGFUL");
    expect(kept.reason).toContain("2 IRRs (4.64%, 215.36%)");
  });
});

describe("the edge of value", () => {
  test("NOI of exactly 0 is not positive: no value, no spread, and a warning", () => {
    const r = underwrite(flat({ expenseRatioPct: 100 }), POLICY_V1);
    expect(metric(r, "exit_value").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "development_spread").status).toBe("NOT_MEANINGFUL");
    expect(checkOf(r, "noi_not_positive")?.severity).toBe("warning");
    expect(r.equityFlows.some((f) => f.kind === "operating")).toBe(false);
    expect(checkOf(underwrite(flat(), POLICY_V1), "noi_not_positive")).toBeUndefined();
  });
  test("a value that is not meaningful is not read as 0 against the debt: no wipeout", () => {
    const loan = { amount: 500_000, ratePct: 0, amortYears: 30, ioMonths: 0 };
    expect(checkOf(underwrite(flat({ expenseRatioPct: 120, senior: loan }), POLICY_V1), "equity_wipeout")).toBeUndefined();
    const kept = flat({ expenseRatioPct: 120, senior: loan, holdYears: 2, exit: "refinance_hold", refinance: { month: 6, amount: 500_000, ratePct: 0, amortYears: 30, ioMonths: 0 } });
    expect(checkOf(underwrite(kept, RENTAL_HOLD_DRAFT), "equity_wipeout")).toBeUndefined();
  });
  test("a sale that exactly repays the debt is not a wipeout", () => {
    // Value 120,000 / 10% = 1,200,000; 1,200,000 interest-only at 0%.
    const L = buildLedger(flat({ budget: { land: 2_000_000, hard: 0, soft: 0, contingency: 0, other: 0 }, senior: { amount: 1_200_000, ratePct: 0, amortYears: 30, ioMonths: 12 } }));
    expect(L.netSale).toBe(L.payoffAtSale);
    expect(L.wipeout).toBe(false);
  });
  test("no equity at all: multiple and IRR say so", () => {
    const r = underwrite(flat({ senior: { amount: 2_000_000, ratePct: 0, amortYears: 30, ioMonths: 0 } }), POLICY_V1);
    expect(metric(r, "equity_multiple").reason).toBe("No equity is contributed, so there is nothing to multiply.");
    expect(metric(r, "equity_irr").reason).toBe("No equity is contributed.");
    expect(metric(r, "equity_multiple").value).toBeNull();
  });
  test("zero total cost: yield and loan to cost are not meaningful, not 0", () => {
    const r = underwrite(flat({ budget: { land: 0, hard: 0, soft: 0, contingency: 0, other: 0 } }), POLICY_V1);
    expect(metric(r, "yield_on_cost").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "yield_on_cost").reason).toBe("Total development cost is zero.");
    expect(metric(r, "loan_to_cost").status).toBe("NOT_MEANINGFUL");
  });
  test("no rent: break-even occupancy is not meaningful", () => {
    const r = underwrite(flat({ revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 0 }] }), POLICY_V1);
    expect(metric(r, "break_even_occupancy").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "break_even_occupancy").reason).toBe("No rent to cover costs with.");
  });
  test("only dwelling lines count as units: cost per unit", () => {
    const L = buildLedger(flat({ revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 1000 }, { key: "S", label: "S", basis: "per_sf", units: 5, areaSf: 100, rentPsfAnnual: 20 }] }));
    expect(L.units).toBe(10);
  });
  test("a metric refuses an unknown key, and holds no value unless it is valid", () => {
    expect(() => m("not_a_metric", 1)).toThrow('metric "not_a_metric" is not in the catalog');
    const nan = m("total_debt", NaN);
    expect([nan.status, nan.value, nan.reason]).toEqual(["NOT_MEANINGFUL", null, "The inputs do not give this a meaningful value."]);
    expect(m("total_debt", null).status).toBe("NOT_MEANINGFUL");
    expect(m("total_debt", 5, "NOT_APPLICABLE").value).toBeNull();
    expect(m("total_debt", 5, "NOT_APPLICABLE").status).toBe("NOT_APPLICABLE");
    expect(m("total_debt", 5, "VALID").value).toBe(5);
    expect(m("total_debt", 0).value).toBe(0);
  });
});

describe("checks, at their edges", () => {
  const withLoan = (amount: number, over: Partial<EngineInput> = {}) => flat({ senior: { amount, ratePct: 0, amortYears: 30, ioMonths: 0 }, ...over });
  test("loan to cost: 85% of 1,000,000 is within the ceiling, 86% is an error that rejects", () => {
    expect(checkOf(underwrite(withLoan(850_000), POLICY_V1), "ltc_ceiling")?.severity).toBe("pass");
    const r = underwrite(withLoan(860_000), POLICY_V1);
    const c = checkOf(r, "ltc_ceiling")!;
    expect([c.severity, c.expected, c.actual]).toEqual(["error", 85, 86]);
    expect(r.verdict.code).toBe("REJECT");
    expect(checkOf(underwrite(flat(), POLICY_V1), "ltc_ceiling")).toBeUndefined();
  });
  test("debt equal to cost cannot exist; a dollar less can", () => {
    expect(checkOf(underwrite(withLoan(1_000_000), POLICY_V1), "debt_exceeds_cost")?.severity).toBe("error");
    expect(checkOf(underwrite(withLoan(999_999), POLICY_V1), "debt_exceeds_cost")).toBeUndefined();
    expect(checkOf(underwrite(flat(), POLICY_V1), "debt_exceeds_cost")).toBeUndefined();
  });
  // Equity 900,000, mezzanine 101,000 with its paid-in-kind interest, total 1,001,000 (see "funding"). At a 2% tolerance: 20,020.
  const pik = (equity: number) => flat({ constructionMonths: 2, mezzanine: { amount: 100_000, ratePct: 12, amortYears: 30, ioMonths: 0 }, stated: { equity } });
  const tol2 = { ...POLICY_V1, agreementTolerancePct: 2 };
  test("stated equity against the model", () => {
    const short = checkOf(underwrite(pik(1), tol2), "sources_cover_uses")!;
    expect(short.severity).toBe("error");
    expect(short.message).toBe("Stated equity of $1 plus debt of $101,000 falls $899,999 short of the $1,001,000 total cost.");
    const over = checkOf(underwrite(pik(1_000_000), tol2), "sources_cover_uses")!;
    expect(over.severity).toBe("warning");
    expect(over.message).toContain("is $100,000 more than the deal needs");
    // 15,000 either way is inside 20,020.
    expect(checkOf(underwrite(pik(885_000), tol2), "sources_cover_uses")?.severity).toBe("pass");
    expect(checkOf(underwrite(pik(915_000), tol2), "sources_cover_uses")?.severity).toBe("pass");
    expect(checkOf(underwrite(pik(900_000), POLICY_V1), "mezz_interest_accrued")?.actual).toBeCloseTo(1_000, 6);
  });
  test("stated total cost: within tolerance of the model; a model of 0 agrees only with 0", () => {
    const stated = (totalCost: number, land = 1_000_000) => checkOf(underwrite(flat({ budget: { land, hard: 0, soft: 0, contingency: 0, other: 0 }, stated: { totalCost } }), POLICY_V1), "stated_total_cost")!.severity;
    expect(stated(1_010_000)).toBe("pass");
    expect(stated(1_020_000)).toBe("warning");
    expect(stated(0, 0)).toBe("pass");
    expect(stated(5, 0)).toBe("warning");
  });
  test("stated loan to cost: within one point of the model", () => {
    const stated = (ltcPct: number) => checkOf(underwrite(withLoan(500_000, { stated: { ltcPct } }), POLICY_V1), "stated_ltc")!.severity;
    expect(stated(51)).toBe("pass");
    expect(stated(49)).toBe("pass");
    expect(stated(52)).toBe("warning");
    expect(stated(48)).toBe("warning");
  });
  test("a covenant: met at equality, and not read at all with no debt", () => {
    // 120,000 NOI over 360,000 / 360 x 12 = 12,000 is 10.00x.
    expect(checkOf(underwrite(withLoan(360_000, { stated: { minDscrCovenant: 10 } }), POLICY_V1), "dscr_covenant")?.severity).toBe("pass");
    expect(checkOf(underwrite(withLoan(360_000, { stated: { minDscrCovenant: 10.5 } }), POLICY_V1), "dscr_covenant")?.severity).toBe("warning");
    expect(checkOf(underwrite(flat({ stated: { minDscrCovenant: 10 } }), POLICY_V1), "dscr_covenant")).toBeUndefined();
  });
  describe("insured limits", () => {
    // NOI 120,000 at a 10% cap: value 1,200,000. Cost 1,000,000. No points: Standard, 85% of value, 100% of cost.
    const insured = (amount: number, over: Partial<EngineInput> = {}, premium = 1) => flat({ holdYears: 2, exit: "refinance_hold", refinance: { month: 0, amount, ratePct: 0, amortYears: 30, ioMonths: 0, insurancePremiumPct: premium }, ...over });
    const run = (d: EngineInput) => underwrite(d, RENTAL_HOLD_INSURED_DRAFT);
    test("loan-to-value and loan-to-cost, at and over the limit", () => {
      const at = run(insured(1_020_000));
      expect(checkOf(at, "refinance_ltv_limit")).toBeUndefined();
      const ltc = checkOf(at, "refinance_ltc_limit")!;
      expect([ltc.severity, ltc.expected]).toEqual(["error", 100]);
      expect(ltc.actual).toBeCloseTo(102, 9);
      const ltv = checkOf(run(insured(1_100_000)), "refinance_ltv_limit")!;
      expect(ltv.expected).toBe(85);
      expect(ltv.actual).toBeCloseTo((1_100_000 / 1_200_000) * 100, 9);
      expect(checkOf(run(insured(1_000_000)), "refinance_ltc_limit")).toBeUndefined();
    });
    test("no premium, no limits", () => {
      const r = run(insured(1_100_000, {}, 0));
      expect(checkOf(r, "refinance_ltv_limit")).toBeUndefined();
      expect(checkOf(r, "refinance_ltc_limit")).toBeUndefined();
    });
    test("a limit over a value or cost of 0 gives no ratio, not Infinity", () => {
      const noValue = checkOf(run(insured(100_000, { expenseRatioPct: 120 })), "refinance_ltv_limit")!;
      expect(noValue.actual).toBeUndefined();
      const noCost = checkOf(run(insured(100_000, { budget: { land: 0, hard: 0, soft: 0, contingency: 0, other: 0 } })), "refinance_ltc_limit")!;
      expect(noCost.actual).toBeUndefined();
    });
  });
});

describe("underwrite", () => {
  test("missing senior amortization: an error check and REJECT, with no figures", () => {
    const r = underwrite(flat({ senior: { amount: 500_000, ratePct: 5, ioMonths: 0 } }), POLICY_V1);
    const c = checkOf(r, "senior_amortization_missing")!;
    expect([c.kind, c.severity]).toEqual(["bound", "error"]);
    expect(r.verdict.code).toBe("REJECT");
    expect(r.scenarios).toEqual([{ key: "base", label: "Base case", metrics: [] }]);
    expect([r.annual, r.equityFlows, r.ledger, r.irrRoots, r.warnings]).toEqual([[], [], [], [], []]);
  });
  test("an S-curve with no build warns; with a build, or a straight line, it does not", () => {
    expect(underwrite(flat({ sCurveDraws: true }), POLICY_V1).warnings).toEqual([{ key: "s_curve_inert", message: "S-curve draws have no effect without a construction period." }]);
    expect(underwrite(flat({ sCurveDraws: true, constructionMonths: 2 }), POLICY_V1).warnings).toEqual([]);
    expect(underwrite(flat(), POLICY_V1).warnings).toEqual([]);
  });
  test("replay needs an engine this build has", () => {
    expect(() => replay("0.0.0", flat(), POLICY_V1)).toThrow("Engine 0.0.0 is not available in this build.");
    expect(canonicalJson(replay(ENGINE_VERSION, flat(), POLICY_V1))).toBe(canonicalJson(underwrite(flat(), POLICY_V1)));
  });
});

describe("selling units with no build, by hand", () => {
  // Land 100, 2 units at 200, none presold, one sold a month, no lag, carry 10 a unit, no debt.
  // Month 0: carry 2 x 10 = 20, plus 100 of cost: contribution 120, closes one: 200 at t = 1/12.
  // Month 1: carry 10: contribution 10, closes one: 200 at t = 2/12.
  const d = flat({
    budget: { land: 100, hard: 0, soft: 0, contingency: 0, other: 0 }, revenue: [], exit: "for_sale",
    senior: { amount: 0, ratePct: 0, ioMonths: 0 },
    forSale: { units: [{ key: "A", label: "A", units: 2, price: 200 }], presoldPct: 0, depositPct: 0, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 10 },
  });
  test("the first month carries the cost, and only the first", () => {
    const L = buildForSaleLedger(d);
    expect([L.rows[0]!.costDraw, L.rows[0]!.equityDraw]).toEqual([120, 120]);
    expect([L.rows[1]!.costDraw, L.rows[1]!.equityDraw]).toEqual([10, 10]);
    expect(L.values.equity_contributed).toBe(130);
    expect(L.values.equity_distributed).toBe(400);
    expect(L.equityFlows.filter((f) => f.kind === "contribution").map((f) => f.amount)).toEqual([-120, -10]);
    const ts = L.equityFlows.map((f) => f.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(L.values.profit_reconciliation_pass).toBe(1);
    expect(L.values.flow_sign_changes).toBe(1);
  });
  test("with a build, the first closing month adds no cost of month 0", () => {
    const L = buildForSaleLedger({ ...d, constructionMonths: 1 });
    expect(L.rows[0]!.costDraw).toBe(100);
    expect(L.rows[1]!.costDraw).toBe(20);
  });
  test("no contribution of 0 is written when carry is 0", () => {
    const L = buildForSaleLedger({ ...d, forSale: { ...d.forSale!, carryMonthly: 0 } });
    expect(L.equityFlows.filter((f) => f.kind === "contribution").map((f) => f.amount)).toEqual([-100]);
  });
  test("debt left after the last closing is an error, with its amount", () => {
    // 2 x 10 is nowhere near 1,000 of debt.
    const r = underwrite({ ...d, budget: { ...d.budget, land: 2_000 }, senior: { amount: 1_000, ratePct: 0, ioMonths: 0 }, forSale: { ...d.forSale!, units: [{ key: "A", label: "A", units: 2, price: 10 }] } }, FOR_SALE_DRAFT);
    const c = checkOf(r, "for_sale_debt_unpaid")!;
    expect([c.kind, c.severity]).toEqual(["bound", "error"]);
    expect(c.message).toBe("Base case: $980.00 of debt remains after the last closing.");
    expect(c.actual).toBe(980);
  });
  test("partners: the IRR is one sign change and one root, or not meaningful", () => {
    const w = { lpSharePct: 50, preferredReturnPct: 0, gpPromotePct: 0 };
    const r = underwrite({ ...d, forSale: { ...d.forSale!, absorptionPerMonth: 2 }, waterfall: w }, FOR_SALE_DRAFT);
    // Both units close in month 0: pay 120, receive 400 a month later. Half each.
    const monthly = 400 / 120;
    const annual = (Math.pow(monthly, 12) - 1) * 100;
    expect(annual).toBeGreaterThan(1000);
    // Beyond the 1,000% range the scan covers, so there is no root: not meaningful, for both, never 0.
    expect(metric(r, "lp_irr").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "gp_irr").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "lp_irr").reason).toContain("LP's dated cash flows");
    expect(metric(r, "equity_irr").status).toBe("NOT_MEANINGFUL");
  });
});

describe("verdict words", () => {
  const scen = (values: Record<string, number | "NA">, combined: Record<string, number | "NA">) =>
    ([["base", values], ["combined", combined]] as const).map(([key, vals]) => ({
      key, label: key,
      metrics: Object.entries(vals).map(([k, v]) => (v === "NA" ? m(k, null, "NOT_APPLICABLE", "n/a") : m(k, v))),
    }));
  const v1 = (em: number | "NA", poc: number, spread: number, dscr: number, sem: number) => scen({ equity_multiple: em, profit_on_cost: poc, development_spread: spread }, { sizing_dscr: dscr, equity_multiple: sem });
  const head = (s: ReturnType<typeof scen>, checks: Check[] = [], p = POLICY_V1 as Parameters<typeof computeVerdict>[2]) => computeVerdict(s, checks, p);
  const err = (message: string): Check => ({ key: "k", kind: "bound", severity: "error", message });
  test("gate rule: at the threshold passes; Unknown is not a pass or a fail", () => {
    expect(gateStatusOf(m("equity_multiple", 1.5), 1.5)).toBe("passed");
    expect(gateStatusOf(m("equity_multiple", 1.49), 1.5)).toBe("failed");
    expect(gateStatusOf(undefined, 1.5)).toBe("not_evaluated");
    expect(gateStatusOf(m("equity_multiple", null), 1.5)).toBe("not_evaluated");
    expect(gateStatusOf(m("equity_multiple", null, "NOT_APPLICABLE", "n"), 1.5)).toBe("not_applicable");
  });
  test("every count, in its own words", () => {
    expect(head(v1(2, 20, 200, 2, 2)).headline).toBe("All five gates pass.");
    expect(head(v1("NA", 20, 200, 2, 2)).headline).toBe("All 4 applicable gates pass.");
    expect(head(v1(1, 20, 200, 2, 2)).headline).toBe("1 gate fails. The committee sets conditions.");
    expect(head(v1(1, 1, 200, 2, 2)).headline).toBe("2 gates fail. The committee sets conditions.");
    expect(head(v1(1, 1, 1, 2, 2)).headline).toBe("3 of 5 gates fail.");
    expect(head(v1(1, 1, 1, 1, 0)).headline).toBe("All five gates fail.");
    expect(head(v1("NA", 1, 1, 1, 0)).headline).toBe("All 4 gates fail.");
    expect(head(v1(2, 20, 200, 2, 2)).explanation).toBe("The deal clears every return hurdle and holds its coverage under combined stress.");
  });
  test("a four-gate policy says four", () => {
    const held = scen({ development_spread: 200, dcr_after_refinance: 2 }, { sizing_dscr: 2, unrealized_equity_multiple: 2 });
    expect(head(held, [], RENTAL_HOLD_DRAFT).headline).toBe("All four gates pass.");
  });
  test("errors, one and several", () => {
    expect(head(v1(2, 20, 200, 2, 2), [err("A.")]).headline).toBe("The deal fails a check that no gate can offset.");
    const two = head(v1(2, 20, 200, 2, 2), [err("A."), err("B.")]);
    expect(two.headline).toBe("The deal fails 2 checks that no gate can offset.");
    expect(two.explanation).toBe("A. B.");
  });
  test("a policy naming a gate it has no threshold for is refused", () => {
    expect(() => head(v1(2, 20, 200, 2, 2), [], { ...POLICY_V1, gateKeys: ["nope"] })).toThrow('has no threshold for gate "nope"');
    expect(() => head(v1(2, 20, 200, 2, 2), [], { ...POLICY_V1, gateKeys: ["dcr_after_refinance"] })).toThrow("has no threshold");
  });
});

describe("validate, field by field", () => {
  const dev = developmentDeal();
  const unit = dev.revenue[0]!;
  const sf = { key: "S", label: "Shop", basis: "per_sf" as const, units: 0, areaSf: 100, rentPsfAnnual: 20 };
  const line = (o: object): EngineInput => ({ ...dev, revenue: [{ ...unit, ...o }] });
  const sfLine = (o: object): EngineInput => ({ ...dev, revenue: [{ ...sf, ...o }] });
  const senior = (o: object): EngineInput => ({ ...dev, senior: { ...dev.senior, ...o } });
  const mezz = (o: object): EngineInput => ({ ...dev, mezzanine: { amount: 100, ratePct: 5, amortYears: 30, ioMonths: 0, ...o } });
  const without = (k: keyof EngineInput): EngineInput => { const c = { ...dev }; delete c[k]; return c; };
  // S = 30, T = 89 on the development deal.
  const refi = (o: object): EngineInput => ({ ...dev, refinance: { month: 40, amount: 100, ratePct: 5, amortYears: 25, ioMonths: 0, ...o } });
  const wf = (o: object): EngineInput => ({ ...dev, waterfall: { lpSharePct: 80, preferredReturnPct: 8, gpPromotePct: 20, ...o } });
  const budget = (o: object): EngineInput => ({ ...dev, budget: { ...dev.budget, ...o } });
  const refused: [string, EngineInput, string][] = [
    ["a string is not a number", budget({ land: "5" as unknown as number }), "budget land must be"],
    ["no revenue", { ...dev, revenue: [] }, "at least one revenue component"],
    ["unit: no key label", line({ label: "", rentMonthly: NaN }), 'revenue component "1BR" needs a monthly rent'],
    ["unit: rent below 0", line({ rentMonthly: -1 }), "needs a monthly rent"],
    ["unit: count 0", line({ units: 0 }), "needs a unit count above 0"],
    ["area 0", sfLine({ areaSf: 0 }), "needs a rentable area above 0"],
    ["area NaN", sfLine({ areaSf: NaN }), "needs a rentable area above 0"],
    ["area below 0", sfLine({ areaSf: -1 }), "needs a rentable area above 0"],
    ["psf rent below 0", sfLine({ rentPsfAnnual: -1 }), "needs a rent per SF"],
    ["psf rent NaN", sfLine({ rentPsfAnnual: NaN }), "needs a rent per SF"],
    ["line occupancy low", line({ occupancyPct: -1 }), "occupancy must be between 0 and 100"],
    ["line occupancy high", line({ occupancyPct: 101 }), "occupancy must be between 0 and 100"],
    ["line occupancy NaN", line({ occupancyPct: NaN }), "occupancy must be between 0 and 100"],
    ["build too long", { ...dev, constructionMonths: 121 }, "construction months must be"],
    ["build part month", { ...dev, constructionMonths: 1.5 }, "construction months must be"],
    ["lease-up below 0", { ...dev, leaseUpMonths: -1 }, "lease-up months must be"],
    ["hold 0", { ...dev, holdYears: 0 }, "hold years must be"],
    ["hold 41", { ...dev, holdYears: 41 }, "hold years must be"],
    ["occupancy low", { ...dev, stabilizedOccupancyPct: -1 }, "stabilized occupancy must be"],
    ["occupancy high", { ...dev, stabilizedOccupancyPct: 101 }, "stabilized occupancy must be"],
    ["occupancy NaN", { ...dev, stabilizedOccupancyPct: NaN }, "stabilized occupancy must be"],
    ["no expense", without("expenseRatioPct"), "an expense ratio or fixed operating costs are required"],
    ["both expenses", { ...dev, fixedOpexAnnual: 10 }, "not both"],
    ["property tax below 0", { ...dev, propertyTaxAnnual: -1 }, "property tax must be"],
    ["cap 0", { ...dev, exitCapPct: 0 }, "exit cap rate must be above 0"],
    ["cap below 0", { ...dev, exitCapPct: -1 }, "exit cap rate must be above 0"],
    ["cap NaN", { ...dev, exitCapPct: NaN }, "exit cap rate must be above 0"],
    ["selling low", { ...dev, sellingCostsPct: -1 }, "selling costs must be"],
    ["selling 100", { ...dev, sellingCostsPct: 100 }, "selling costs must be"],
    ["selling NaN", { ...dev, sellingCostsPct: NaN }, "selling costs must be"],
    ["senior below 0", senior({ amount: -1 }), "senior loan amount"],
    ["senior NaN", senior({ amount: NaN }), "senior loan amount"],
    ["senior rate below 0", senior({ ratePct: -1 }), "senior loan rate"],
    ["senior rate NaN", senior({ ratePct: NaN }), "senior loan rate"],
    ["senior amort 51", senior({ amortYears: 51 }), "senior loan amortization"],
    ["senior io below 0", senior({ ioMonths: -1 }), "senior loan interest-only"],
    ["senior io 601", senior({ ioMonths: 601 }), "senior loan interest-only"],
    ["mezz amort missing", mezz({ amortYears: undefined }), "mezzanine loan amortization"],
    ["mezz below 0", mezz({ amount: -1 }), "mezzanine loan amount"],
    ["mezz io", mezz({ ioMonths: -1 }), "mezzanine loan interest-only"],
    ["refi at the sale", refi({ month: 89 }), "refinance month must fall from stabilization (month 30) to before the sale (month 89)"],
    ["refi before S", refi({ month: 29 }), "refinance month must fall"],
    ["refi both", refi({ ltvPct: 50 }), "either a loan amount or a loan-to-value"],
    ["refi neither", refi({ amount: undefined }), "either a loan amount or a loan-to-value"],
    ["refi rate", refi({ ratePct: -1 }), "refinance loan rate"],
    ["refi amort missing", refi({ amortYears: undefined }), "refinance loan amortization"],
    ["points", refi({ mliSelectPoints: 151 }), "MLI Select points"],
    ["term", refi({ termYears: 41 }), "refinance term"],
    ["premium tax high", refi({ premiumTaxPct: 16 }), "premium tax"],
    ["premium tax low", refi({ premiumTaxPct: -1 }), "premium tax"],
    ["premium high", refi({ insurancePremiumPct: 11 }), "insurance premium"],
    ["premium low", refi({ insurancePremiumPct: -1 }), "insurance premium"],
    ["lp 0", wf({ lpSharePct: 0 }), "LP share"],
    ["lp 100", wf({ lpSharePct: 100 }), "LP share"],
    ["lp NaN", wf({ lpSharePct: NaN }), "LP share"],
    ["pref below 0", wf({ preferredReturnPct: -1 }), "preferred return"],
    ["pref NaN", wf({ preferredReturnPct: NaN }), "preferred return"],
    ["promote low", wf({ gpPromotePct: -1 }), "GP promote"],
    ["promote high", wf({ gpPromotePct: 101 }), "GP promote"],
    ["promote NaN", wf({ gpPromotePct: NaN }), "GP promote"],
    ["a sale's details on a rental", { ...dev, forSale: { units: [], presoldPct: 0, depositPct: 0, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 0 } }, "apply only to a deal that sells"],
    ["credit takes total to 0", { ...dev, budget: { land: 0, hard: 40, soft: 30, contingency: 30, other: -100 } }, "cannot take the total budget to 0"],
    ["credit over the spread costs", { ...dev, budget: { land: 500, hard: 40, soft: 30, contingency: 30, other: -101 } }, "cannot be more than hard costs"],
  ];
  test.each(refused)("refused: %s", (_n, input, message) => {
    expect(() => validateInput(input)).toThrow(message);
  });
  const accepted: [string, EngineInput][] = [
    ["rent 0", line({ rentMonthly: 0 })],
    ["psf rent 0", sfLine({ rentPsfAnnual: 0 })],
    ["line occupancy 0", line({ occupancyPct: 0 })],
    ["line occupancy 100", line({ occupancyPct: 100 })],
    ["build 120", { ...dev, constructionMonths: 120 }],
    ["hold 40", { ...dev, holdYears: 40 }],
    ["occupancy 0", { ...dev, stabilizedOccupancyPct: 0 }],
    ["occupancy 100", { ...dev, stabilizedOccupancyPct: 100 }],
    ["selling 0", { ...dev, sellingCostsPct: 0 }],
    ["selling 99.9", { ...dev, sellingCostsPct: 99.9 }],
    ["cap small", { ...dev, exitCapPct: 0.01 }],
    ["no loan, terms not read", senior({ amount: 0, ratePct: -1, amortYears: 99, ioMonths: -1 })],
    ["senior amortization optional", senior({ amortYears: undefined })],
    ["refi last month", refi({ month: 88 })],
    ["refi at S", refi({ month: 30 })],
    ["lp 1", wf({ lpSharePct: 1 })],
    ["lp 99", wf({ lpSharePct: 99 })],
    ["pref 0", wf({ preferredReturnPct: 0 })],
    ["promote 0", wf({ gpPromotePct: 0 })],
    ["promote 100", wf({ gpPromotePct: 100 })],
    // The credit tests add every line: the total and the spread each stay above their limits only if all are added.
    ["credit against land", { ...dev, budget: { land: 50, hard: 50, soft: 0, contingency: 0, other: -40 } }],
    ["credit against soft", { ...dev, budget: { land: 100, hard: 50, soft: 50, contingency: 0, other: -50 } }],
    ["credit against contingency", { ...dev, budget: { land: 100, hard: 50, soft: 0, contingency: 50, other: -50 } }],
  ];
  test.each(accepted)("accepted: %s", (_n, input) => {
    expect(() => validateInput(input)).not.toThrow();
  });

  const sale = (): EngineInput => flat({
    revenue: [], exit: "for_sale",
    senior: { amount: 0, ratePct: 0, ioMonths: 0 },
    forSale: { units: [{ key: "A", label: "Row", units: 2, price: 200 }], presoldPct: 0, depositPct: 0, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 0 },
  });
  const f = (o: object): EngineInput => { const d = sale(); return { ...d, forSale: { ...d.forSale!, ...o } }; };
  const u = (o: object) => f({ units: [{ key: "A", label: "Row", units: 2, price: 200, ...o }] });
  const saleRefused: [string, EngineInput, string][] = [
    ["rents", { ...sale(), revenue: dev.revenue }, "cannot state rents"],
    ["refinance", { ...sale(), refinance: { month: 1, amount: 1, ratePct: 1, amortYears: 1, ioMonths: 0 } }, "cannot have a refinance"],
    ["lease-up", { ...sale(), leaseUpMonths: 1 }, "cannot have a lease-up period"],
    ["build low", { ...sale(), constructionMonths: -1 }, "construction months"],
    ["build high", { ...sale(), constructionMonths: 121 }, "construction months"],
    ["build part", { ...sale(), constructionMonths: 1.5 }, "construction months"],
    ["build NaN", { ...sale(), constructionMonths: NaN }, "construction months"],
    ["senior", { ...sale(), senior: { amount: -1, ratePct: 0, ioMonths: 0 } }, "senior loan amount"],
    ["senior rate", { ...sale(), senior: { amount: 0, ratePct: -1, ioMonths: 0 } }, "senior loan rate"],
    ["mezz", { ...sale(), mezzanine: { amount: -1, ratePct: 0, amortYears: 1, ioMonths: 0 } }, "mezzanine loan amount"],
    ["mezz rate", { ...sale(), mezzanine: { amount: 0, ratePct: NaN, amortYears: 1, ioMonths: 0 } }, "mezzanine loan rate"],
    ["no details", { ...sale(), forSale: undefined as never }, "needs its sale details"],
    ["no types", f({ units: [] }), "at least one unit type"],
    ["not a list", f({ units: "x" }), "at least one unit type"],
    ["part unit", u({ units: 1.5 }), 'unit type "Row" needs a whole unit count'],
    ["no unit, key named", u({ units: 0, label: "" }), 'unit type "A" needs a whole unit count'],
    ["unit NaN", u({ units: NaN }), "needs a whole unit count"],
    ["price low", u({ price: -1 }), 'unit type "Row" needs a sale price'],
    ["price NaN, key named", u({ price: NaN, label: "" }), 'unit type "A" needs a sale price'],
    ["presold low", f({ presoldPct: -1 }), "presold share"],
    ["presold high", f({ presoldPct: 101 }), "presold share"],
    ["deposit NaN", f({ depositPct: NaN }), "deposit must be"],
    ["commission", f({ commissionPct: 101 }), "sales commission"],
    ["threshold", f({ presaleThresholdPct: 101 }), "presale threshold"],
    ["pace 0", f({ absorptionPerMonth: 0 }), "sales pace"],
    ["pace below 0", f({ absorptionPerMonth: -1 }), "sales pace"],
    ["pace NaN", f({ absorptionPerMonth: NaN }), "sales pace"],
    ["lag low", f({ closingLagMonths: -1 }), "months from completion"],
    ["lag part", f({ closingLagMonths: 0.5 }), "months from completion"],
    ["lag NaN", f({ closingLagMonths: NaN }), "months from completion"],
    ["carry low", f({ carryMonthly: -1 }), "carry per unsold unit"],
    ["carry NaN", f({ carryMonthly: NaN }), "carry per unsold unit"],
    ["a sale's waterfall", { ...sale(), waterfall: { lpSharePct: 0, preferredReturnPct: 0, gpPromotePct: 0 } }, "LP share"],
  ];
  test.each(saleRefused)("a sale refused: %s", (_n, input, message) => {
    expect(() => validateInput(input)).toThrow(message);
  });
  test.each([
    ["price 0", u({ price: 0 })], ["presold 0", f({ presoldPct: 0 })], ["presold 100", f({ presoldPct: 100 })],
    ["build 120", { ...sale(), constructionMonths: 120 }], ["lag 0", f({ closingLagMonths: 0 })], ["carry 0", f({ carryMonthly: 0 })],
    ["slow pace", f({ absorptionPerMonth: 0.1 })],
  ] as [string, EngineInput][])("a sale accepted: %s", (_n, input) => {
    expect(() => validateInput(input)).not.toThrow();
  });
});
