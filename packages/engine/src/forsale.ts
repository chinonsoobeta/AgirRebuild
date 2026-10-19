// Selling units: the shared construction solve, followed by inventory carry and dated closings.
import { METRICS, type Check, type EngineInput, type EquityFlow, type LedgerRow, type Policy, type RunResult, type ScenarioResult } from "@agir/contracts";
import { fundConstruction, placeConstructionCosts } from "./ledger.ts";
import { m } from "./metrics.ts";
import { irrRoots } from "./irr.ts";
import { ratio, sum } from "./math.ts";
import { applyStress } from "./stress.ts";
import { computeVerdict } from "./verdict.ts";
import { runStatedChecks } from "./checks.ts";

export type ForSaleLedger = {
  rows: LedgerRow[];
  equityFlows: EquityFlow[];
  closings: number[];
  values: Record<string, number>;
  converged: boolean;
  construction: { equityContributed: number; debt: number };
};

export function buildForSaleLedger(input: EngineInput): ForSaleLedger {
  const f = input.forSale!;
  const C = input.constructionMonths;
  const units = sum(f.units.map((u) => u.units));
  const gross = sum(f.units.map((u) => u.units * u.price));
  const price = gross / units;
  const presold = Math.floor(units * f.presoldPct / 100);
  const unsold = units - presold;
  const E = C + f.closingLagMonths + Math.max(0, Math.ceil((unsold - 1e-9) / f.absorptionPerMonth) - 1);
  const { costByMonth, costsBeforeFinancing } = placeConstructionCosts(input, C);
  const funding = fundConstruction(input, C, costByMonth, costsBeforeFinancing);
  const { sim } = funding;
  const rows: LedgerRow[] = [];
  const equityFlows: EquityFlow[] = [];
  const closings = new Array<number>(E + 1).fill(0);
  let running = 0;
  for (let month = 0; month < C; month++) {
    running += sim.debtDraw[month]! + sim.capitalizedInterest[month]!;
    const eq = sim.equityDraw[month]!;
    rows.push({ month, phase: "construction", costDraw: costByMonth[month]!, equityDraw: eq, debtDraw: sim.debtDraw[month]!,
      capitalizedInterest: sim.capitalizedInterest[month]!, egi: 0, opex: 0, noi: 0, debtService: 0, debtBalance: running, refinanceNet: 0, saleNet: 0 });
    if (eq > 0) equityFlows.push({ month, t: month / 12, amount: -eq, kind: "contribution" });
  }
  let senior = sim.balances.senior;
  let mezzanine = sim.balances.mezzanine;
  let closed = 0;
  let carryTotal = 0;
  let interestAfter = 0;
  let distributed = 0;
  for (let month = C; month <= E; month++) {
    const interest = senior * input.senior.ratePct / 100 / 12 + mezzanine * (input.mezzanine?.ratePct ?? 0) / 100 / 12;
    senior += senior * input.senior.ratePct / 100 / 12;
    mezzanine += mezzanine * (input.mezzanine?.ratePct ?? 0) / 100 / 12;
    interestAfter += interest;
    const carry = (units - closed) * f.carryMonthly;
    carryTotal += carry;
    const elapsed = month - f.closingLagMonths - C + 1;
    const cumulative = (n: number) => n > 0 ? Math.min(unsold, Math.floor(f.absorptionPerMonth * n + 1e-9)) : 0;
    const closing = cumulative(elapsed) - cumulative(elapsed - 1) + (month === C + f.closingLagMonths ? presold : 0);
    closings[month] = closing;
    closed += closing;
    const net = closing * price * (1 - f.commissionPct / 100);
    const seniorRepaid = Math.min(net, senior);
    const mezzRepaid = Math.min(Math.max(0, net - seniorRepaid), mezzanine);
    senior -= seniorRepaid;
    mezzanine -= mezzRepaid;
    const distribution = Math.max(0, net - seniorRepaid - mezzRepaid);
    distributed += distribution;
    // With no build, the existing funding convention places the initial cost and funding at month 0.
    const initial = C === 0 && month === 0;
    const contribution = carry + (initial ? sim.equityDraw[0]! : 0);
    // "hold" here is completed inventory awaiting closing, with no rental operations or NOI.
    rows.push({ month, phase: "hold", costDraw: carry + (initial ? costByMonth[0]! : 0), equityDraw: contribution,
      debtDraw: initial ? sim.debtDraw[0]! : 0, capitalizedInterest: interest + (initial ? sim.capitalizedInterest[0]! : 0),
      egi: 0, opex: 0, noi: 0, debtService: seniorRepaid + mezzRepaid, debtBalance: senior + mezzanine, refinanceNet: 0, saleNet: distribution });
    if (contribution > 0) equityFlows.push({ month, t: month / 12, amount: -contribution, kind: "contribution" });
    if (distribution > 0) equityFlows.push({ month, t: (month + 1) / 12, amount: distribution, kind: "sale" });
  }
  equityFlows.sort((a, b) => a.t - b.t);
  // Net flows on the same date before measuring signs and peak equity, as in the workbook's flow grid.
  const dated = new Map<number, number>();
  for (const flow of equityFlows) {
    const date = flow.kind === "sale" ? flow.month + 1 : flow.month;
    dated.set(date, (dated.get(date) ?? 0) + flow.amount);
  }
  let cumulativeContribution = 0;
  let peak = 0;
  let lastSign = 0;
  let signChanges = 0;
  for (const [, amount] of [...dated].sort(([a], [b]) => a - b)) {
    cumulativeContribution -= amount;
    peak = Math.max(peak, cumulativeContribution);
    const sign = Math.sign(amount);
    if (sign !== 0) {
      if (lastSign !== 0 && sign !== lastSign) signChanges++;
      lastSign = sign;
    }
  }
  const contributed = funding.equityContributed + carryTotal;
  const netSales = gross * (1 - f.commissionPct / 100);
  const profit = netSales - funding.tdc - carryTotal - interestAfter;
  const reconciliation = distributed - contributed - profit;
  return { rows, equityFlows, closings, converged: funding.converged,
    construction: { equityContributed: funding.equityContributed, debt: funding.commitments + sim.mezzAccruedBeyondCommitment },
    values: {
    gross_sales_revenue: gross, net_sales_revenue: netSales, total_development_cost: funding.tdc,
    interest_before_completion: funding.capitalizedInterest, interest_after_completion: interestAfter, carry_total: carryTotal,
    development_profit_for_sale: profit, equity_contributed: contributed, equity_distributed: distributed, peak_equity: peak,
    completion_month: C, sellout_month: E, sellout_years: (E + 1) / 12,
    deposits_held_at_completion: presold * price * f.depositPct / 100,
    senior_balance_at_completion: sim.balances.senior, mezz_balance_at_completion: sim.balances.mezzanine,
    unused_commitment_at_completion: sim.unusedCommitment, equity_overrun: sim.equityOverrun,
    required_equity_budget: funding.equityBudget, iteration_delta: funding.iterationDelta, funding_converged: Number(funding.converged),
    profit_reconciliation_difference: reconciliation, profit_reconciliation_pass: Number(Math.abs(reconciliation) <= 0.01),
    flow_sign_changes: signChanges, ending_senior_balance: senior, ending_mezz_balance: mezzanine,
    closing_units_check: closed - units, cost_allocation_check: sum(costByMonth) - costsBeforeFinancing,
  } };
}

export function forSaleMetrics(input: EngineInput, L: ForSaleLedger) {
  const v: Record<string, number | null> = { ...L.values };
  const commitments = input.senior.amount + (input.mezzanine?.amount ?? 0);
  const units = sum(input.forSale!.units.map((u) => u.units));
  const ltc = ratio(commitments, v.total_development_cost!);
  v.loan_to_cost = ltc === null ? null : ltc * 100;
  v.required_equity = v.total_development_cost! - commitments;
  v.cost_per_unit = units > 0 ? v.total_development_cost! / units : null;
  const cost = v.total_development_cost! + v.carry_total! + v.interest_after_completion!;
  const poc = ratio(v.development_profit_for_sale!, cost);
  const margin = ratio(v.development_profit_for_sale!, v.net_sales_revenue!);
  v.profit_on_cost_for_sale = poc === null ? null : poc * 100;
  v.margin_on_revenue = margin === null ? null : margin * 100;
  v.equity_multiple = ratio(v.equity_distributed!, v.equity_contributed!);
  const roots = irrRoots(L.equityFlows);
  v.equity_irr = v.flow_sign_changes === 1 && roots.length === 1 ? roots[0]! * 100 : null;
  const metrics = METRICS.map((def) => {
    if (!Object.hasOwn(v, def.key)) return m(def.key, null, "NOT_APPLICABLE", "The units are sold; there is no rental income.");
    if (def.key === "loan_to_cost" && ltc === null) return m(def.key, null, "NOT_MEANINGFUL", "Total development cost is zero.");
    if (def.key === "cost_per_unit" && units <= 0) return m(def.key, null, "NOT_APPLICABLE", "The program has no dwelling units.");
    return m(def.key, v[def.key]!, undefined, def.key === "equity_irr" ? `The dated net equity flows have ${v.flow_sign_changes} sign changes and ${roots.length} IRR roots; exactly one of each is required.` : undefined);
  });
  return { metrics, roots };
}

/** Checks read the base case only, as for rental deals; a stress shows in its metrics and gates. */
export function underwriteForSale(input: EngineInput, policy: Policy, engineVersion: string): RunResult {
  const base = buildForSaleLedger(input);
  const baseMetrics = forSaleMetrics(input, base);
  const scenarios: ScenarioResult[] = [{ key: "base", label: "Base case", metrics: baseMetrics.metrics }];
  const checks: Check[] = [];
  const checkLedger = (L: ForSaleLedger, label: string) => {
    if (!L.converged) checks.push({ key: "funding_not_converged", kind: "bound", severity: "error", message: `${label}: required equity could not be solved; the funding plan is inconsistent.` });
    const unpaid = L.values.ending_senior_balance! + L.values.ending_mezz_balance!;
    if (unpaid > 0.005) checks.push({ key: "for_sale_debt_unpaid", kind: "bound", severity: "error", message: `${label}: $${unpaid.toFixed(2)} of debt remains after the last closing.`, actual: unpaid });
  };
  checkLedger(base, "Base case");
  for (const stress of policy.stresses) {
    const stressed = applyStress(input, stress);
    const L = buildForSaleLedger(stressed);
    scenarios.push({ key: stress.key, label: stress.label, metrics: forSaleMetrics(stressed, L).metrics });
  }
  const f = input.forSale!;
  if (f.presaleThresholdPct !== undefined && f.presoldPct < f.presaleThresholdPct) checks.push({ key: "presale_threshold_unmet", kind: "bound", severity: "error",
    message: `The construction loan needs ${f.presaleThresholdPct}% presold; ${f.presoldPct}% is stated.`, expected: f.presaleThresholdPct, actual: f.presoldPct });
  checks.push(...runStatedChecks(input.stated, policy.agreementTolerancePct, {
    totalCost: base.values.total_development_cost!,
    equity: base.construction.equityContributed,
    debt: base.construction.debt,
    // As in rental checks, a zero-cost deal compares stated LTC against zero.
    loanToCost: baseMetrics.metrics.find((m) => m.key === "loan_to_cost")!.value ?? 0,
    interest: base.values.interest_before_completion!,
  }, true));
  return { engineVersion, policyVersion: policy.version, scenarios, checks, verdict: computeVerdict(scenarios, checks, policy),
    annual: [], equityFlows: base.equityFlows, ledger: base.rows, irrRoots: baseMetrics.roots, warnings: [] };
}
