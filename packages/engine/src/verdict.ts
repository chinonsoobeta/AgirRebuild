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

/** The gate list, once: each gate's scenario, metric and threshold, from the policy. */
export function gateSpecs(policy: Policy): GateSpec[] {
  const g = policy.gates;
  return [
    { key: "equity_multiple", label: "Equity multiple", scenario: "base", metricKey: "equity_multiple", threshold: g.equityMultipleMin },
    { key: "profit_on_cost", label: "Profit on cost", scenario: "base", metricKey: "profit_on_cost", threshold: g.profitOnCostMinPct },
    { key: "development_spread", label: "Development spread", scenario: "base", metricKey: "development_spread", threshold: g.developmentSpreadMinBps },
    { key: "stressed_sizing_dscr", label: "Sizing DSCR, combined stress", scenario: "combined", metricKey: "sizing_dscr", threshold: g.stressedSizingDscrMin },
    { key: "stressed_equity_multiple", label: "Equity multiple, combined stress", scenario: "combined", metricKey: "equity_multiple", threshold: g.stressedEquityMultipleMin },
  ];
}

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
      headline = measured === gates.length ? "All five gates pass." : `All ${measured} applicable gates pass.`;
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
        headline = failed.length === measured ? `All ${measured === 5 ? "five" : measured} gates fail.` : `${failed.length} of ${measured} gates fail.`;
        explanation = `Failing: ${failed.map((x) => x.label).join("; ")}.`;
      }
  }
  return { code, gates, hardFailReasons, headline, explanation };
}
