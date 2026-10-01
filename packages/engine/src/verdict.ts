import type { Check, Gate, GateStatus, Metric, Policy, ScenarioResult, Verdict, VerdictCode } from "@agir/contracts";

function find(scenarios: ScenarioResult[], scenario: string, key: string): Metric | undefined {
  return scenarios.find((s) => s.key === scenario)?.metrics.find((m) => m.key === key);
}

function gate(
  scenarios: ScenarioResult[],
  key: string,
  label: string,
  scenario: string,
  metricKey: string,
  threshold: number,
): Gate {
  const metric = find(scenarios, scenario, metricKey);
  let status: GateStatus;
  if (!metric) status = "not_evaluated";
  else if (metric.status === "NOT_APPLICABLE") status = "not_applicable";
  else if (metric.status !== "VALID" || metric.value === null) status = "not_evaluated";
  else status = metric.value >= threshold ? "passed" : "failed";
  return {
    key,
    label,
    metricKey,
    scenario,
    threshold,
    unit: metric?.unit ?? "x",
    actual: metric && metric.status === "VALID" ? metric.value : null,
    status,
  };
}

/** The verdict, computed once per run from its own scenarios. Readers never recompute it. */
export function computeVerdict(scenarios: ScenarioResult[], checks: Check[], policy: Policy): Verdict {
  const g = policy.gates;
  const gates: Gate[] = [
    gate(scenarios, "equity_multiple", "Equity multiple", "base", "equity_multiple", g.equityMultipleMin),
    gate(scenarios, "profit_on_cost", "Profit on cost", "base", "profit_on_cost", g.profitOnCostMinPct),
    gate(scenarios, "development_spread", "Development spread", "base", "development_spread", g.developmentSpreadMinBps),
    gate(scenarios, "stressed_sizing_dscr", "Sizing DSCR, combined stress", "combined", "sizing_dscr", g.stressedSizingDscrMin),
    gate(scenarios, "stressed_equity_multiple", "Equity multiple, combined stress", "combined", "equity_multiple", g.stressedEquityMultipleMin),
  ];
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
