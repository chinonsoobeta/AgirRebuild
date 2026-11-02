// Figures stated in public documents, put through the engine. The inputs were read from the documents by hand, and every
// expected value is the document's own number, so none comes from the engine. The documents are real but stay out of this
// repository, so each case is described and not named: 14 broker schedules from British Columbia, two Ontario packages, and
// feasibility, appraisal and financing papers. They check operating income and loan arithmetic. No public document gives a
// development pro forma whose return reconciles, so returns and the waterfall are checked only by the reference workbooks.
import { describe, expect, test } from "vitest";
import { POLICY_V1, type EngineInput } from "@agir/contracts";
import { buildLedger, underwrite } from "../src/index.ts";

type Case = { rent: number; other?: number; occ?: number; fixed?: number; variable?: number; land?: number; hard?: number; soft?: number; otherCost?: number; hold?: number; rentGrowth?: number; expenseGrowth?: number; cap?: number; loan?: [amount: number, rate: number, years: number] };
const input = (a: Case): EngineInput => ({
  budget: { land: a.land ?? 1_000_000, hard: a.hard ?? 0, soft: a.soft ?? 0, contingency: 0, other: a.otherCost ?? 0 },
  revenue: [{ key: "A", label: "A", basis: "per_unit", units: 1, rentMonthly: a.rent / 12 }],
  otherIncomeAnnual: a.other ?? 0, constructionMonths: 0, leaseUpMonths: 0, holdYears: a.hold ?? 1, stabilizedOccupancyPct: a.occ ?? 100,
  fixedOpexAnnual: a.fixed ?? 0, ...(a.variable !== undefined ? { variableExpensePct: a.variable } : {}),
  rentGrowthPct: a.rentGrowth ?? 0, expenseGrowthPct: a.expenseGrowth ?? 0, leaseUpRamp: false, sCurveDraws: false, exitCapPct: a.cap ?? 5, sellingCostsPct: 0,
  senior: a.loan ? { amount: a.loan[0], ratePct: a.loan[1], amortYears: a.loan[2], ioMonths: 0 } : { amount: 0, ratePct: 0, amortYears: 30, ioMonths: 0 },
  stated: {},
});
const metric = (a: Case, key: string) => underwrite(input(a), POLICY_V1).scenarios.find(s => s.key === "base")!.metrics.find(m => m.key === key)!.value!;
const years = (a: Case) => buildLedger(input(a)).annual.filter(y => y.year >= 1);
/** The year's payment on a loan: the land is set above the loan, because a loan larger than the cost is drawn only up to the cost. */
const payment = (amount: number, rate: number, term: number) => years({ rent: 1_000_000, land: amount * 2, loan: [amount, rate, term] })[0]!.sizingDebtService;

// Rent, other income, vacancy %, total expenses, then the document's effective gross income and net operating income.
const SCHEDULES: [number, number, number, number, number, number][] = [
  [202824, 0, 0.5, 32881, 201810, 168929],
  [313776, 3169, 0.5, 105526, 315360, 209834],
  [279072, 3170, 0.5, 89967, 280831, 190864],
  [242070, 2400, 0.5, 85633, 243248, 157615],
  [274188, 1560, 0.5, 81056, 274369, 193314],
  [304224, 2846, 0.5, 103956, 305535, 201579],
  [215940, 3355, 0.5, 69786, 218199, 148413],
  [295423, 7860, 0.5, 96196, 301767, 205571],
  [467352, 12444, 0.5, 164037, 477397, 313360],
  [678876, 21000, 1.0, 284784, 692877, 408093],
  [204360, 2400, 0.5, 51274, 205726, 154452],
  [213084, 900, 0.5, 59094, 212914, 153821],
  [288180, 2093, 1.0, 93725, 287370, 193645],
  [158400, 0, 0.5, 54262, 157608, 103346],
];
// Rent and other income together, vacancy %, total expenses, management as a % of effective income, the document's management line, its net operating income.
const MANAGED: [number, number, number, number, number, number][] = [
  [316945, 0.5, 105526, 3.0, 9461, 209834],
  [282242, 0.5, 89967, 3.25, 9127, 190864],
  [244470, 0.5, 85633, 3.5, 8514, 157615],
  [307070, 0.5, 103956, 3.25, 9930, 201579],
  [303283, 0.5, 96196, 3.0, 9053, 205571],
  [479796, 0.5, 164037, 3.25, 15515, 313360],
  [699876, 1.0, 284784, 3.0, 20786, 408093],
  [290273, 1.0, 93725, 3.0, 8621, 193645],
];

describe("a broker's operating schedule", () => {
  test.each(SCHEDULES)("rent %d, other income %d: the document's income once vacancy also covers other income", (rent, other, vacancy, expenses, egi, noi) => {
    const a = { rent: rent + other, occ: 100 - vacancy, fixed: expenses };
    expect(Math.abs(metric(a, "effective_gross_income") - egi)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - noi)).toBeLessThanOrEqual(1);
  });
  // A known difference in practice. These schedules take vacancy on rent and other income. The engine takes it on rent only,
  // as do the appraisal and insured-loan papers below. The engine's income is higher by exactly vacancy times other income.
  test.each(SCHEDULES)("rent %d, other income %d: the engine takes vacancy on rent only", (rent, other, vacancy, expenses, _egi, noi) => {
    const engine = metric({ rent, other, occ: 100 - vacancy, fixed: expenses }, "stabilized_noi");
    expect(Math.abs(engine - noi - (vacancy / 100) * other)).toBeLessThanOrEqual(1);
  });
  test.each(MANAGED)("income %d: management as a share of effective income", (income, vacancy, expenses, pct, line, noi) => {
    const a = { rent: income, occ: 100 - vacancy, fixed: expenses - line, variable: pct };
    expect(Math.abs((pct / 100) * metric(a, "effective_gross_income") - line)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - noi)).toBeLessThanOrEqual(1);
  });
});

describe("a loan payment stated with its amount, rate and amortization", () => {
  test.each([
    [12_161_190, 5, 30, 783_407, 1],
    [662_587, 7.25, 30, 54_240, 1],
    // The document prints the rate rounded to two decimals, and rounds the next two loans down from their sizing tests.
    [12_404_528, 2.74, 40, 510_983, 0.0005 * 510_983],
    [3_670_000, 6.5, 40, 258_343, 0.0025 * 258_343],
    [4_790_000, 6.5, 40, 336_879, 0.0025 * 336_879],
  ])("%d at %d%% over %d years", (amount, rate, term, stated, within) => {
    expect(Math.abs(payment(amount, rate, term) - stated)).toBeLessThanOrEqual(within);
  });
  // Recorded, not settled. Two Ontario packages state a payment and five years of principal. The principal grows 4.04% a year,
  // which is 4% compounded twice a year (1.02^2), and 40.00 years then solves exactly. Spec: interest is the annual rate over 12,
  // an owner reading of 2026-10-24, so on these two the engine's payment is 0.49% above the document's. The owner decides.
  test.each([
    [2_366_163, 118_089],
    [3_947_699, 197_018],
  ])("a loan of %d: the document compounds twice a year, the engine monthly", (amount, stated) => {
    const level = (i: number) => (amount * i) / (1 - (1 + i) ** -480) * 12;
    expect(Math.abs(level(1.02 ** (1 / 6) - 1) - stated)).toBeLessThanOrEqual(1);
    expect(Math.abs(payment(amount, 4, 40) - level(0.04 / 12))).toBeLessThanOrEqual(0.5);
    expect(payment(amount, 4, 40) / stated).toBeCloseTo(1.0049, 3);
  });
});

describe("whole statements read by hand", () => {
  test("a tax-credit application: income, and total cost from its nine lines", () => {
    const a = { rent: 735_228, occ: 93, fixed: 373_750, land: 522_000, soft: 460_250 + 698_000 + 2_540_000 + 293_350 + 315_793, hard: 1_585_000 + 12_056_189, otherCost: 1_092_906, loan: [3_670_000, 6.5, 40] as [number, number, number] };
    expect(Math.abs(metric(a, "effective_gross_income") - 683_762)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - 310_012)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "total_development_cost") - 19_563_488)).toBeLessThanOrEqual(1);
    // Its loan is the largest at 1.20 on the first year, rounded down.
    expect(metric(a, "sizing_dscr_year1")).toBeCloseTo(1.2, 2);
  });
  test("a financing evaluation: 10% vacancy on rent, the rest of the income as stated", () => {
    const a = { rent: 2_210_322, other: 111_459 + 207_600 + 30_217 + 427_894 - 79_765, occ: 90, fixed: 1_555_284 };
    expect(Math.abs(metric(a, "effective_gross_income") - 2_686_695)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - 1_131_411)).toBeLessThanOrEqual(1);
  });
  test("an insured-loan paper: 3% vacancy on rent only", () => {
    const a = { rent: 97_308, other: 2_600, occ: 97, fixed: 6_500 + 2_000 + 10_733 + 3_996 + 2_500 + 12_000 + 4_905 - 4_243 };
    expect(Math.abs(metric(a, "effective_gross_income") - 96_989)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - 58_597)).toBeLessThanOrEqual(1);
  });
  test("an appraisal: 2% vacancy on rent only, and value at its 5% rate", () => {
    const a = { rent: 1_853_231, other: 71_000, occ: 98, fixed: 674_633, cap: 5 };
    expect(Math.abs(metric(a, "effective_gross_income") - 1_887_166)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - 1_212_534)).toBeLessThanOrEqual(1);
    // The appraiser rounds to the nearest 10,000, and 1,212,533 / 0.05 is 24,250,660.
    expect(Math.abs(metric(a, "stabilized_noi") / 0.05 - 24_250_000)).toBeLessThanOrEqual(5_000);
  });
  test("a brochure: income, and its rate on the asking price printed to one decimal", () => {
    const a = { rent: 595_677, occ: 100 - (5_477 / 595_677) * 100, fixed: 206_452, land: 8_850_000 };
    expect(Math.abs(metric(a, "effective_gross_income") - 590_200)).toBeLessThanOrEqual(1);
    expect(Math.abs(metric(a, "stabilized_noi") - 383_748)).toBeLessThanOrEqual(1);
    expect(metric(a, "yield_on_cost").toFixed(1)).toBe("4.3");
  });
});

describe("twenty years of rising rents and costs", () => {
  // Rents up 2.5% and costs up 3.5% a year. Both documents hold their reserves flat, so reserves leave the growing costs and are taken off after.
  const check = (income: number, costs: number, reserves: number, stated: number[]) => {
    const rows = years({ rent: income, fixed: costs, rentGrowth: 2.5, expenseGrowth: 3.5, hold: stated.length });
    stated.forEach((noi, i) => expect(Math.abs(rows[i]!.noi - reserves - noi), `year ${i + 1}`).toBeLessThanOrEqual(1.1));
  };
  test("a financing evaluation, 17 years from its year 4", () => {
    check(2_880_617, 1_682_906, 37_400, [1160311, 1173425, 1186277, 1198842, 1211089, 1222990, 1234512, 1245622, 1256287, 1266468, 1276128, 1285228, 1293723, 1301572, 1308726, 1315138, 1320757]);
  });
  test("an affordable-housing application, 20 years", () => {
    check(1_538_790, 923_760, 27_400, [587630, 593769, 599737, 605520, 611101, 616463, 621588, 626458, 631051, 635348, 639327, 642965, 646237, 649120, 651585, 653607, 655156, 656202, 656714, 656658]);
  });
});
