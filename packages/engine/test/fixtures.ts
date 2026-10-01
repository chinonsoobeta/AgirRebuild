import type { EngineInput } from "@agir/contracts";

/** A plain stabilized deal: no build, no debt, one year. Every number is checkable by hand. */
export function allEquityDeal(): EngineInput {
  return {
    budget: { land: 1_000_000, hard: 0, soft: 0, contingency: 0, other: 0 },
    revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 1_000 }],
    otherIncomeAnnual: 0,
    constructionMonths: 0,
    leaseUpMonths: 0,
    holdYears: 1,
    stabilizedOccupancyPct: 100,
    expenseRatioPct: 0,
    rentGrowthPct: 0,
    expenseGrowthPct: 0,
    leaseUpRamp: false,
    sCurveDraws: false,
    exitCapPct: 10,
    sellingCostsPct: 0,
    senior: { amount: 0, ratePct: 0, amortYears: 30, ioMonths: 0 },
    stated: {},
  };
}

/** A development deal with a build, a lease-up, a senior loan and growth. */
export function developmentDeal(): EngineInput {
  return {
    budget: { land: 8_500_000, hard: 28_000_000, soft: 4_000_000, contingency: 1_400_000, other: 0 },
    revenue: [
      { key: "1BR", label: "1BR", basis: "per_unit", units: 60, rentMonthly: 2_200 },
      { key: "2BR", label: "2BR", basis: "per_unit", units: 50, rentMonthly: 2_600 },
      { key: "3BR", label: "3BR", basis: "per_unit", units: 10, rentMonthly: 3_200 },
    ],
    otherIncomeAnnual: 60_000,
    constructionMonths: 18,
    leaseUpMonths: 12,
    holdYears: 5,
    stabilizedOccupancyPct: 95,
    expenseRatioPct: 35,
    rentGrowthPct: 3,
    expenseGrowthPct: 2.5,
    leaseUpRamp: false,
    sCurveDraws: false,
    exitCapPct: 5,
    sellingCostsPct: 2,
    senior: { amount: 27_000_000, ratePct: 6, amortYears: 30, ioMonths: 36 },
    stated: {},
  };
}
