// The metric catalog: every figure the engine reports, declared once. Each
// metric is a projection of the one monthly ledger; nothing else computes it.

export type MetricUnit = "$" | "%" | "x" | "bps" | "count" | "months";

export type MetricDef = {
  key: string;
  label: string;
  unit: MetricUnit;
  formula: string;
  /** Shown on the results screen's key-figure table, in this order. */
  headline?: number;
};

export const METRICS: readonly MetricDef[] = [
  { key: "total_development_cost", label: "Total development cost", unit: "$", formula: "land + hard + soft + contingency + other + capitalized interest", headline: 1 },
  { key: "capitalized_interest", label: "Capitalized interest", unit: "$", formula: "interest accrued on drawn debt before stabilization" },
  { key: "hard_and_soft_cost", label: "Costs before financing", unit: "$", formula: "land + hard + soft + contingency + other" },
  { key: "gross_potential_rent", label: "Gross potential rent (year 1)", unit: "$", formula: "sum of component rent over the first stabilized year" },
  { key: "effective_gross_income", label: "Effective gross income (year 1)", unit: "$", formula: "rent x occupancy + other income, first stabilized year" },
  { key: "operating_expenses", label: "Operating expenses (year 1)", unit: "$", formula: "fixed + variable share of EGI, first stabilized year" },
  { key: "stabilized_noi", label: "Stabilized NOI", unit: "$", formula: "EGI - operating expenses, first stabilized year", headline: 2 },
  { key: "yield_on_cost", label: "Yield on cost", unit: "%", formula: "stabilized NOI / total development cost", headline: 3 },
  { key: "development_spread", label: "Development spread", unit: "bps", formula: "(yield on cost - exit cap rate) x 100", headline: 5 },
  { key: "exit_value", label: "Exit value", unit: "$", formula: "final hold-year NOI / exit cap rate", headline: 6 },
  { key: "net_sale_proceeds", label: "Net sale proceeds", unit: "$", formula: "exit value x (1 - selling costs)" },
  { key: "development_profit", label: "Development profit", unit: "$", formula: "net sale proceeds - total development cost", headline: 7 },
  { key: "profit_on_cost", label: "Profit on cost", unit: "%", formula: "development profit / total development cost" },
  { key: "total_debt", label: "Total debt at stabilization", unit: "$", formula: "senior + mezzanine balances, including capitalized interest" },
  { key: "loan_to_cost", label: "Loan to cost", unit: "%", formula: "debt commitments / total development cost", headline: 8 },
  { key: "required_equity", label: "Required equity", unit: "$", formula: "total development cost - debt commitments", headline: 9 },
  { key: "debt_yield", label: "Debt yield", unit: "%", formula: "stabilized NOI / total debt at stabilization", headline: 10 },
  { key: "sizing_dscr", label: "Sizing DSCR (weakest year)", unit: "x", formula: "min over hold years of NOI / amortizing debt service on the debt in force", headline: 11 },
  { key: "sizing_dscr_year1", label: "Sizing DSCR (year 1)", unit: "x", formula: "year-1 NOI / amortizing debt service on the debt in force" },
  { key: "contractual_dscr", label: "Contractual DSCR (weakest year)", unit: "x", formula: "min over hold years of NOI / debt service actually due", headline: 12 },
  { key: "senior_dscr_year1", label: "Senior DSCR (year 1)", unit: "x", formula: "year-1 NOI / senior amortizing debt service" },
  { key: "mezz_dscr_year1", label: "All-in DSCR with mezzanine (year 1)", unit: "x", formula: "year-1 NOI / senior + mezzanine amortizing debt service" },
  { key: "break_even_occupancy", label: "Break-even occupancy (year 1)", unit: "%", formula: "(fixed costs + debt service) / (rent x (1 - variable share))" },
  { key: "cash_on_cash_year1", label: "Cash-on-cash (year 1)", unit: "%", formula: "year-1 cash flow after debt service / required equity" },
  { key: "equity_multiple", label: "Equity multiple", unit: "x", formula: "total distributions / total contributions", headline: 13 },
  { key: "equity_irr", label: "Equity IRR", unit: "%", formula: "rate that sets the dated equity cash flows' NPV to zero", headline: 14 },
  { key: "peak_equity", label: "Peak equity outstanding", unit: "$", formula: "largest cumulative net contribution" },
  { key: "refinance_net_proceeds", label: "Refinance net proceeds", unit: "$", formula: "new loan - payoff of the senior balance" },
  { key: "cost_per_unit", label: "Cost per unit", unit: "$", formula: "total development cost / units", headline: 15 },
  { key: "lp_irr", label: "LP IRR", unit: "%", formula: "IRR of the LP's share after the waterfall" },
  { key: "gp_irr", label: "GP IRR", unit: "%", formula: "IRR of the GP's share after the waterfall" },
  { key: "gp_promote", label: "GP promote", unit: "$", formula: "GP distributions above its pro-rata share" },
  { key: "stabilization_month", label: "Stabilization month", unit: "months", formula: "construction + lease-up" },
  { key: "sale_month", label: "Sale month", unit: "months", formula: "stabilization + 12 x hold years - 1" },
];

export const METRIC_BY_KEY: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));

export function metricDef(key: string): MetricDef {
  const def = METRIC_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown metric "${key}"`);
  return def;
}
