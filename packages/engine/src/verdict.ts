import type { Check, Gate, GateStatus, Metric, Policy, ScenarioResult, Verdict, VerdictCode } from "@agir/contracts";

function find(scenarios: ScenarioResult[], scenario: string, key: string): Metric | undefined {
  return scenarios.find((s) => s.key === scenario)?.metrics.find((m) => m.key === key);
}

/** A gate's pass rule, read from one place: the verdict, and anything that asks what would make a gate pass, use this. */
export function gateStatusOf(metric: Metric | undefined, threshold: number): GateStatus {
  if (!metric) return "not_evaluated";
  if (metric.status === "NOT_APPLICABLE") return "not_applicable";
  if (metric.status !== "VALID" || metric.value === null) return "not_evaluated";
  return metric.value >= threshold ? "passed" : "failed";
}

export type GateSpec = { key: string; label: string; scenario: string; metricKey: string; threshold: number };

/** Every gate any policy can use: where it reads, and the name of its threshold in the policy. */
const GATE_CATALOG: Record<string, Omit<GateSpec, "threshold"> & { threshold: string }> = {
  profit_on_cost_for_sale: { key: "profit_on_cost_for_sale", label: "Profit on cost, units sold", scenario: "base", metricKey: "profit_on_cost_for_sale", threshold: "profitOnCostForSaleMinPct" },
  margin_on_revenue: { key: "margin_on_revenue", label: "Margin on sales revenue", scenario: "base", metricKey: "margin_on_revenue", threshold: "marginOnRevenueMinPct" },
  stressed_profit_on_cost_for_sale: { key: "stressed_profit_on_cost_for_sale", label: "Profit on cost, units sold, combined stress", scenario: "combined", metricKey: "profit_on_cost_for_sale", threshold: "stressedProfitOnCostForSaleMinPct" },
  equity_multiple: { key: "equity_multiple", label: "Equity multiple", scenario: "base", metricKey: "equity_multiple", threshold: "equityMultipleMin" },
  profit_on_cost: { key: "profit_on_cost", label: "Profit on cost", scenario: "base", metricKey: "profit_on_cost", threshold: "profitOnCostMinPct" },
  development_spread: { key: "development_spread", label: "Development spread", scenario: "base", metricKey: "development_spread", threshold: "developmentSpreadMinBps" },
  stressed_sizing_dscr: { key: "stressed_sizing_dscr", label: "Sizing DSCR, combined stress", scenario: "combined", metricKey: "sizing_dscr", threshold: "stressedSizingDscrMin" },
  stressed_equity_multiple: { key: "stressed_equity_multiple", label: "Equity multiple, combined stress", scenario: "combined", metricKey: "equity_multiple", threshold: "stressedEquityMultipleMin" },
  dcr_after_refinance: { key: "dcr_after_refinance", label: "Coverage after refinance (DCR)", scenario: "base", metricKey: "dcr_after_refinance", threshold: "dcrAfterRefinanceMin" },
  stressed_unrealized_equity_multiple: { key: "stressed_unrealized_equity_multiple", label: "Equity multiple (unrealized, not a sale), combined stress", scenario: "combined", metricKey: "unrealized_equity_multiple", threshold: "stressedUnrealizedMultipleMin" },
};
const V1_GATE_KEYS = ["equity_multiple", "profit_on_cost", "development_spread", "stressed_sizing_dscr", "stressed_equity_multiple"];

/** The gate list, once: each gate's scenario, metric and threshold, from the policy it is given. */
export function gateSpecs(policy: Policy): GateSpec[] {
  return (policy.gateKeys ?? V1_GATE_KEYS).map((key) => {
    const def = GATE_CATALOG[key];
    const threshold = def && policy.gates[def.threshold];
    if (!def || threshold === undefined) throw new Error(`Policy ${policy.version} has no threshold for gate "${key}"`);
    return { ...def, threshold };
  });
}

/** "five" and "four" are spelled out; a v1 verdict's other counts stay digits, so its stored text never changes. */
const countWord = (n: number, total: number) => (n === 5 ? "five" : n === 4 && total === 4 ? "four" : String(n));

function gate(scenarios: ScenarioResult[], spec: GateSpec): Gate {
  const metric = find(scenarios, spec.scenario, spec.metricKey);
  return {
    key: spec.key,
    label: spec.label,
    metricKey: spec.metricKey,
    scenario: spec.scenario,
    threshold: spec.threshold,
    unit: metric?.unit ?? "x",
    actual: metric && metric.status === "VALID" ? metric.value : null,
    status: gateStatusOf(metric, spec.threshold),
  };
}

/** The verdict, computed once per run from its own scenarios. Readers never recompute it. */
export function computeVerdict(scenarios: ScenarioResult[], checks: Check[], policy: Policy): Verdict {
  const gates: Gate[] = gateSpecs(policy).map((spec) => gate(scenarios, spec));
  const errors = checks.filter((c) => c.severity === "error");
  const hardFailReasons = errors.map((c) => c.message);
  const failed = gates.filter((x) => x.status === "failed");
  const notEvaluated = gates.filter((x) => x.status === "not_evaluated");

  let code: VerdictCode;
  if (hardFailReasons.length > 0) code = "REJECT";
  else if (notEvaluated.length > 0) code = "NOT_EVALUATED";
  else if (failed.length > policy.maxFailedGatesForConditions) code = "REJECT";
  else if (failed.length === 0) code = "APPROVE";
  else code = "APPROVE_WITH_CONDITIONS";

  const measured = gates.filter((x) => x.status !== "not_applicable").length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  let headline: string;
  let explanation: string;
  switch (code) {
    case "APPROVE":
      headline = measured === gates.length ? `All ${countWord(measured, gates.length)} gates pass.` : `All ${measured} applicable gates pass.`;
      explanation = "The deal clears every return hurdle and holds its coverage under combined stress.";
      break;
    case "APPROVE_WITH_CONDITIONS":
      headline = `${plural(failed.length, "gate fails", "gates fail")}. The committee sets conditions.`;
      explanation = `Failing: ${failed.map((x) => x.label).join("; ")}.`;
      break;
    case "NOT_EVALUATED":
      headline = "Not evaluated. Nothing was decided.";
      explanation = `These gates could not be measured: ${notEvaluated.map((x) => x.label).join("; ")}.`;
      break;
    default:
      if (hardFailReasons.length > 0) {
        headline = errors.length === 1 ? "The deal fails a check that no gate can offset." : `The deal fails ${errors.length} checks that no gate can offset.`;
        explanation = hardFailReasons.join(" ");
      } else {
        headline = failed.length === measured ? `All ${countWord(measured, gates.length)} gates fail.` : `${failed.length} of ${measured} gates fail.`;
        explanation = `Failing: ${failed.map((x) => x.label).join("; ")}.`;
      }
  }
  return { code, gates, hardFailReasons, headline, explanation };
}
