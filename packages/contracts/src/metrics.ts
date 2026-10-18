// The metric catalog: every figure the engine reports, declared once. Each
// metric is a projection of the one monthly ledger; nothing else computes it.

export type MetricUnit = "$" | "%" | "x" | "bps" | "count" | "months" | "years";

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
  { key: "leaseup_operating_cost", label: "Operating costs during lease-up", unit: "$", formula: "fixed operating costs at year-1 levels for each lease-up month, charged to total development cost when lease-up income is not credited" },
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
  { key: "mezz_interest_accrued", label: "Mezzanine interest accrued above commitment", unit: "$", formula: "mezzanine interest before stabilization beyond its commitment, added to the mezzanine balance" },
  { key: "loan_to_cost", label: "Loan to cost", unit: "%", formula: "debt commitments / total development cost", headline: 8 },
  { key: "required_equity", label: "Required equity", unit: "$", formula: "total development cost - debt commitments", headline: 9 },
  { key: "debt_yield", label: "Debt yield", unit: "%", formula: "stabilized NOI / total debt at stabilization", headline: 10 },
  { key: "sizing_dscr", label: "Sizing DSCR (weakest year)", unit: "x", formula: "min over hold years of NOI / amortizing debt service on the debt in force", headline: 11 },
  { key: "sizing_dscr_year1", label: "Sizing DSCR (year 1)", unit: "x", formula: "year-1 NOI / amortizing debt service on the debt in force" },
  { key: "contractual_dscr", label: "Contractual DSCR (weakest year)", unit: "x", formula: "min over hold years of NOI / debt service actually due", headline: 12 },
  { key: "senior_dscr_year1", label: "Senior DSCR (year 1)", unit: "x", formula: "year-1 NOI / senior amortizing debt service" },
  { key: "mezz_dscr_year1", label: "All-in DSCR with mezzanine (year 1)", unit: "x", formula: "year-1 NOI / senior + mezzanine amortizing debt service" },
  { key: "io_dscr_year1", label: "Interest-only DSCR (year 1)", unit: "x", formula: "year-1 NOI / interest-only debt service on the senior and mezzanine balances at stabilization" },
  { key: "break_even_occupancy", label: "Break-even occupancy (year 1)", unit: "%", formula: "(fixed costs + debt service) / (rent x (1 - variable share))" },
  { key: "cash_on_cash_year1", label: "Cash-on-cash (year 1)", unit: "%", formula: "year-1 cash flow after debt service / required equity" },
  { key: "cumulative_cash_shortfall", label: "Cumulative cash shortfall after stabilization", unit: "$", formula: "sum over the hold of the negative monthly cash flow after debt service, as a positive amount" },
  { key: "equity_multiple", label: "Equity multiple", unit: "x", formula: "total distributions / total contributions", headline: 13 },
  { key: "equity_irr", label: "Equity IRR", unit: "%", formula: "rate that sets the dated equity cash flows' NPV to zero", headline: 14 },
  { key: "peak_equity", label: "Peak equity outstanding", unit: "$", formula: "largest cumulative net contribution" },
  { key: "refinance_net_proceeds", label: "Refinance net proceeds", unit: "$", formula: "new loan - payoff of the senior balance" },
  // Only when a premium is stated (card 61): never added to a result that has none.
  { key: "refinance_premium_added", label: "Mortgage insurance premium added to the refinance loan", unit: "$", formula: "refinance loan amount x premium %" },
  { key: "cost_per_unit", label: "Cost per unit", unit: "$", formula: "total development cost / units", headline: 15 },
  { key: "lp_irr", label: "LP IRR", unit: "%", formula: "IRR of the LP's share after the waterfall" },
  { key: "gp_irr", label: "GP IRR", unit: "%", formula: "IRR of the GP's share after the waterfall" },
  { key: "gp_promote", label: "GP promote", unit: "$", formula: "GP distributions above its pro-rata share" },
  { key: "stabilization_month", label: "Stabilization month", unit: "months", formula: "construction + lease-up" },
  { key: "sale_month", label: "Sale month", unit: "months", formula: "stabilization + 12 x hold years - 1" },
  // Selling units only (card 77): computed only in for-sale mode, never in a rental result.
  { key: "gross_sales_revenue", label: "Gross sales revenue", unit: "$", formula: "Total units times weighted average price." },
  { key: "net_sales_revenue", label: "Net sales revenue", unit: "$", formula: "Gross sales less commission." },
  { key: "interest_before_completion", label: "Interest before completion", unit: "$", formula: "Mezzanine and senior opening-balance interest for months 0 through C-1, including equity-paid interest." },
  { key: "interest_after_completion", label: "Interest after completion", unit: "$", formula: "Mezzanine and senior opening-balance interest for months C through E." },
  { key: "carry_total", label: "Carry total", unit: "$", formula: "Sum of carry paid by equity." },
  { key: "development_profit_for_sale", label: "Development profit for sale", unit: "$", formula: "Net sales - TDC - carry - interest after completion." },
  { key: "profit_on_cost_for_sale", label: "Profit on cost for sale", unit: "%", formula: "Profit / (TDC + carry + interest after completion) times 100. Percent units." },
  { key: "margin_on_revenue", label: "Margin on revenue", unit: "%", formula: "Profit / net sales times 100. Percent units." },
  { key: "equity_contributed", label: "Equity contributed", unit: "$", formula: "Sum of equity cost draws + senior interest paid by equity + overruns + carry." },
  { key: "equity_distributed", label: "Equity distributed", unit: "$", formula: "Sum of closing proceeds after senior and mezzanine repayments." },
  { key: "completion_month", label: "Completion month", unit: "months", formula: "Construction period C." },
  { key: "sellout_month", label: "Sellout month", unit: "months", formula: "Last closing month E." },
  { key: "sellout_years", label: "Sellout years", unit: "years", formula: "(E + 1) / 12." },
  { key: "deposits_held_at_completion", label: "Deposits held at completion", unit: "$", formula: "Presold whole units times average price times deposit percentage / 100. Trust only; no cash-flow effect." },
  { key: "senior_balance_at_completion", label: "Senior balance at completion", unit: "$", formula: "Senior opening balance in month C." },
  { key: "mezz_balance_at_completion", label: "Mezz balance at completion", unit: "$", formula: "Mezzanine opening balance in month C." },
  // Held deals only (card 60): added to a result when the deal is kept and refinanced, never to a sale.
  { key: "refinance_cash_returned", label: "Cash returned at refinance", unit: "$", formula: "new loan - payoff of the senior balance; negative means cash was put in" },
  { key: "cash_left_in_deal", label: "Cash left in the deal", unit: "$", formula: "required equity - cash returned at refinance; 0 or below means all the equity came back" },
  { key: "dcr_after_refinance", label: "Coverage after refinance (DCR)", unit: "x", formula: "NOI over the 12 months from the refinance month / amortizing debt service on all debt in force in those months" },
  { key: "cash_on_cash_after_refinance", label: "Cash-on-cash after refinance", unit: "%", formula: "(NOI - debt service actually due) over the 12 months from the refinance month / cash left in the deal" },
  { key: "stated_value", label: "Stated value (unrealized, not a sale)", unit: "$", formula: "final hold-year NOI / exit cap rate, no selling costs" },
  { key: "unrealized_equity_multiple", label: "Equity multiple (unrealized, not a sale)", unit: "x", formula: "(operating + refinance + unrealized distributions) / contributions" },
  { key: "unrealized_equity_irr", label: "Equity IRR (unrealized, not a sale)", unit: "%", formula: "rate that sets the dated equity cash flows' NPV to zero, with the unrealized flow" },
];

export const METRIC_BY_KEY: ReadonlyMap<string, MetricDef> = new Map(METRICS.map((m) => [m.key, m]));

export function metricDef(key: string): MetricDef {
  const def = METRIC_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown metric "${key}"`);
  return def;
}
