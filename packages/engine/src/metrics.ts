import { METRIC_BY_KEY, type EngineInput, type Metric, type MetricStatus } from "@agir/contracts";
import type { Ledger } from "./ledger.ts";
import { irrRoots } from "./irr.ts";
import { ratio, sum } from "./math.ts";
import { runWaterfall } from "./waterfall.ts";

export function m(key: string, value: number | null, status?: MetricStatus, reason?: string): Metric {
  const def = METRIC_BY_KEY.get(key);
  if (!def) throw new Error(`metric "${key}" is not in the catalog`);
  const valid = value !== null && Number.isFinite(value) && (status === undefined || status === "VALID");
  return {
    key,
    label: def.label,
    unit: def.unit,
    value: valid ? value : null,
    status: valid ? "VALID" : status && status !== "VALID" ? status : "NOT_MEANINGFUL",
    ...(valid ? {} : { reason: reason ?? "The inputs do not give this a meaningful value." }),
    formula: def.formula,
  };
}

const na = (key: string, reason: string) => m(key, null, "NOT_APPLICABLE", reason);
const nm = (key: string, reason: string) => m(key, null, "NOT_MEANINGFUL", reason);
const NOT_SOLD = "The deal is kept and refinanced, not sold.";

export type ScenarioMetrics = { metrics: Metric[]; irrRoots: number[] };

/** Every catalog metric for one scenario, each a projection of its ledger. */
export function computeMetrics(input: EngineInput, L: Ledger): ScenarioMetrics {
  const out: Metric[] = [];
  const hold = input.exit === "refinance_hold";
  const hasDebt = L.drawnDebtAtS > 0;
  const tdc = L.tdc;
  const y1 = L.year1;
  const noi = y1.noi;

  out.push(m("total_development_cost", tdc));
  out.push(m("capitalized_interest", L.capitalizedInterest));
  out.push(
    input.leaseUpMonths === 0
      ? na("leaseup_operating_cost", "The deal has no lease-up period.")
      : input.leaseUpRamp
        ? na("leaseup_operating_cost", "Lease-up income is credited, so fixed costs are netted against it, not added to total development cost.")
        : m("leaseup_operating_cost", L.leaseupOperatingCost),
  );
  out.push(m("hard_and_soft_cost", L.costsBeforeFinancing));
  out.push(m("gross_potential_rent", y1.gpr));
  out.push(m("effective_gross_income", y1.egi));
  out.push(m("operating_expenses", y1.opex));
  out.push(m("stabilized_noi", noi));

  const yoc = ratio(noi, tdc);
  out.push(yoc === null ? nm("yield_on_cost", "Total development cost is zero.") : m("yield_on_cost", yoc * 100));
  out.push(
    noi <= 0 || yoc === null
      ? nm("development_spread", "Stabilized NOI is not positive, so the deal cannot be capitalized.")
      : m("development_spread", (yoc * 100 - input.exitCapPct) * 100),
  );

  const exitReason = "Final-year NOI is not positive, so the asset has no capitalized value.";
  if (hold) {
    // A held deal has no sale: these keep their place in the result, as not applicable, never 0.
    for (const k of ["exit_value", "net_sale_proceeds", "development_profit", "profit_on_cost"]) out.push(na(k, NOT_SOLD));
  } else {
    out.push(L.exitValue === null ? nm("exit_value", exitReason) : m("exit_value", L.exitValue));
    out.push(L.netSale === null ? nm("net_sale_proceeds", exitReason) : m("net_sale_proceeds", L.netSale));
    const profit = L.netSale === null ? null : L.netSale - tdc;
    out.push(profit === null ? nm("development_profit", exitReason) : m("development_profit", profit));
    const poc = profit === null ? null : ratio(profit, tdc);
    out.push(poc === null ? nm("profit_on_cost", exitReason) : m("profit_on_cost", poc * 100));
  }

  out.push(hasDebt ? m("total_debt", L.drawnDebtAtS) : na("total_debt", "The deal has no debt."));
  out.push(
    input.mezzanine && input.mezzanine.amount > 0
      ? m("mezz_interest_accrued", L.mezzAccruedBeyondCommitment)
      : na("mezz_interest_accrued", "The deal has no mezzanine loan."),
  );
  const ltc = ratio(L.commitments, tdc);
  out.push(ltc === null ? nm("loan_to_cost", "Total development cost is zero.") : m("loan_to_cost", ltc * 100));
  out.push(m("required_equity", L.requiredEquity));
  const dy = ratio(noi, L.drawnDebtAtS);
  out.push(!hasDebt ? na("debt_yield", "The deal has no debt.") : dy === null ? nm("debt_yield", "No debt at stabilization.") : m("debt_yield", dy * 100));

  // Sizing and contractual coverage, per hold year, weakest year governs.
  const noiByYear = L.annual.slice(1).map((r) => r.noi);
  const coverage = (ds: number[]) => {
    const vals = ds.map((d, i) => (d > 0 ? (noiByYear[i] ?? 0) / d : null)).filter((v): v is number => v !== null);
    return vals.length ? Math.min(...vals) : null;
  };
  if (!hasDebt) {
    out.push(na("sizing_dscr", "The deal has no debt."));
    out.push(na("sizing_dscr_year1", "The deal has no debt."));
    out.push(na("contractual_dscr", "The deal has no debt."));
    out.push(na("senior_dscr_year1", "The deal has no debt."));
  } else {
    out.push(m("sizing_dscr", coverage(L.sizingDsByYear)));
    out.push(m("sizing_dscr_year1", ratio(noiByYear[0] ?? 0, L.sizingDsByYear[0] ?? 0)));
    out.push(m("contractual_dscr", coverage(L.contractualDsByYear)));
    out.push(
      L.seniorSizingYear1 > 0
        ? m("senior_dscr_year1", ratio(noi, L.seniorSizingYear1))
        : na("senior_dscr_year1", "No senior loan is in force in year 1."),
    );
  }
  if (!hasDebt) out.push(na("io_dscr_year1", "The deal has no debt."));
  else {
    const io = ratio(noi, L.ioDebtServiceAtS);
    out.push(io === null ? nm("io_dscr_year1", "No interest is due on the debt at stabilization.") : m("io_dscr_year1", io));
  }
  out.push(
    L.mezzSizingYear1 > 0
      ? m("mezz_dscr_year1", ratio(noi, L.seniorSizingYear1 + L.mezzSizingYear1))
      : na("mezz_dscr_year1", "No mezzanine loan."),
  );

  const y1Row = L.annual[1]!;
  const beDenominator = y1.gpr * 12 === 0 ? 0 : y1Row.gpr * (1 - y1.variableShare);
  const beo = ratio(y1.fixedOpex + y1Row.debtService, beDenominator);
  out.push(beo === null ? nm("break_even_occupancy", "No rent to cover costs with.") : m("break_even_occupancy", beo * 100));
  const coc = ratio(y1Row.cashFlow, L.requiredEquity);
  out.push(coc === null ? nm("cash_on_cash_year1", "No equity is contributed.") : m("cash_on_cash_year1", coc * 100));

  out.push(m("cumulative_cash_shortfall", L.cumulativeCashShortfall));

  const contributions = -sum(L.equityFlows.filter((f) => f.amount < 0).map((f) => f.amount));
  const distributions = sum(L.equityFlows.filter((f) => f.amount > 0).map((f) => f.amount));
  let roots: number[] = [];
  if (hold) {
    out.push(na("equity_multiple", NOT_SOLD));
    out.push(na("equity_irr", NOT_SOLD));
  } else if (L.exitValue === null) {
    out.push(nm("equity_multiple", exitReason));
    out.push(nm("equity_irr", exitReason));
  } else if (contributions <= 0) {
    out.push(nm("equity_multiple", "No equity is contributed, so there is nothing to multiply."));
    out.push(nm("equity_irr", "No equity is contributed."));
  } else {
    out.push(m("equity_multiple", distributions / contributions));
    roots = irrRoots(L.equityFlows);
    if (roots.length === 1) out.push(m("equity_irr", roots[0]! * 100));
    else if (roots.length === 0) out.push(nm("equity_irr", "The equity cash flows have no rate of return (no sign change)."));
    else
      out.push(
        nm(
          "equity_irr",
          `The equity cash flows have ${roots.length} IRRs (${roots.map((r) => (r * 100).toFixed(2) + "%").join(", ")}), so no single IRR is meaningful.`,
        ),
      );
  }

  let cum = 0;
  let peak = 0;
  for (const f of L.equityFlows) {
    cum -= f.amount;
    peak = Math.max(peak, cum);
  }
  out.push(m("peak_equity", peak));
  out.push(L.refinance ? m("refinance_net_proceeds", L.refinance.net) : na("refinance_net_proceeds", "No refinance."));
  // Added only when a premium is stated, so a result that has none is what it always was.
  if (L.refinance && input.refinance?.insurancePremiumPct !== undefined) out.push(m("refinance_premium_added", L.refinance.premium));
  out.push(L.units > 0 ? m("cost_per_unit", tdc / L.units) : na("cost_per_unit", "The program has no dwelling units."));

  if (hold) {
    for (const k of ["lp_irr", "gp_irr", "gp_promote"]) out.push(na(k, NOT_SOLD));
  } else if (!input.waterfall) {
    out.push(na("lp_irr", "No LP/GP split."));
    out.push(na("gp_irr", "No LP/GP split."));
    out.push(na("gp_promote", "No LP/GP split."));
  } else if (L.exitValue === null || contributions <= 0) {
    out.push(nm("lp_irr", "Deal returns are not meaningful."));
    out.push(nm("gp_irr", "Deal returns are not meaningful."));
    out.push(nm("gp_promote", "Deal returns are not meaningful."));
  } else {
    const w = runWaterfall(L.equityFlows, input.waterfall);
    const lp = irrRoots(w.lp);
    const gp = irrRoots(w.gp);
    out.push(lp.length === 1 ? m("lp_irr", lp[0]! * 100) : nm("lp_irr", "The LP cash flows have no single IRR."));
    out.push(gp.length === 1 ? m("gp_irr", gp[0]! * 100) : nm("gp_irr", "The GP cash flows have no single IRR."));
    out.push(m("gp_promote", w.promote));
  }
  out.push(m("stabilization_month", L.S));
  out.push(hold ? na("sale_month", NOT_SOLD) : m("sale_month", L.T));
  if (hold) {
    const held = holdMetrics(L, contributions, distributions);
    out.push(...held.metrics);
    roots = held.roots;
  }
  return { metrics: out, irrRoots: roots };
}

/** The twelve months from the refinance month are scaled to a year when the hold ends first; the reason says so. */
function withScaleNote(metric: Metric, months: number): Metric {
  return metric.status === "VALID" && months < 12
    ? { ...metric, reason: `Only ${months} months remain before the end of the hold, so this uses them, scaled to a year.` }
    : metric;
}

/** The metrics of a deal that is kept and refinanced, in catalog order. Computed in hold mode only. */
function holdMetrics(L: Ledger, contributions: number, distributions: number): { metrics: Metric[]; roots: number[] } {
  const out: Metric[] = [];
  const r = L.refinance!;
  const w = L.afterRefinance!;
  out.push(m("refinance_cash_returned", r.net));
  const left = L.requiredEquity - r.net;
  out.push(m("cash_left_in_deal", left));
  const scale = w.months > 0 ? 12 / w.months : 0;
  const dcr = ratio(w.noi, w.sizingDebtService);
  out.push(dcr === null ? nm("dcr_after_refinance", "No debt is in force after the refinance.") : withScaleNote(m("dcr_after_refinance", dcr), w.months));
  out.push(
    left <= 0
      ? nm("cash_on_cash_after_refinance", "Cash left in the deal is 0 or below, so all of the equity has come back and there is nothing left to earn on.")
      : withScaleNote(m("cash_on_cash_after_refinance", (((w.noi - w.debtService) * scale) / left) * 100), w.months),
  );
  const reason = "Final-year NOI is not positive, so the asset has no capitalized value.";
  out.push(L.statedValue === null ? nm("stated_value", reason) : m("stated_value", L.statedValue));
  let roots: number[] = [];
  if (L.statedValue === null) {
    out.push(nm("unrealized_equity_multiple", reason));
    out.push(nm("unrealized_equity_irr", reason));
  } else if (contributions <= 0) {
    out.push(nm("unrealized_equity_multiple", "No equity is contributed, so there is nothing to multiply."));
    out.push(nm("unrealized_equity_irr", "No equity is contributed."));
  } else {
    out.push(m("unrealized_equity_multiple", distributions / contributions));
    roots = irrRoots(L.equityFlows);
    if (roots.length === 1) out.push(m("unrealized_equity_irr", roots[0]! * 100));
    else if (roots.length === 0) out.push(nm("unrealized_equity_irr", "The equity cash flows have no rate of return (no sign change)."));
    else
      out.push(
        nm(
          "unrealized_equity_irr",
          `The equity cash flows have ${roots.length} IRRs (${roots.map((x) => (x * 100).toFixed(2) + "%").join(", ")}), so no single IRR is meaningful.`,
        ),
      );
  }
  return { metrics: out, roots };
}
