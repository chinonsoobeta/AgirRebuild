import type { EngineInput, Policy, RunResult, ScenarioResult } from "@agir/contracts";
import { buildLedger } from "./ledger.ts";
import { computeMetrics } from "./metrics.ts";
import { runChecks } from "./checks.ts";
import { computeVerdict } from "./verdict.ts";
import { applyStress } from "./stress.ts";
import { validateInput } from "./validate.ts";

export const ENGINE_VERSION = "1.0.0";

/**
 * The whole underwriting run: pure, deterministic, complete. Given the same
 * input and policy it returns the same result, byte for byte. It reads no
 * clock, no database and no model; it writes nothing.
 */
export function underwrite(input: EngineInput, policy: Policy): RunResult {
  validateInput(input);
  const base = buildLedger(input);
  const baseMetrics = computeMetrics(input, base);
  const scenarios: ScenarioResult[] = [{ key: "base", label: "Base case", metrics: baseMetrics.metrics }];
  for (const s of policy.stresses) {
    const stressed = applyStress(input, s);
    const ledger = buildLedger(stressed);
    scenarios.push({ key: s.key, label: s.label, metrics: computeMetrics(stressed, ledger).metrics });
  }
  const contractual = baseMetrics.metrics.find((m) => m.key === "contractual_dscr");
  const checks = runChecks(input, base, policy, contractual?.status === "VALID" ? contractual.value : null);
  const baseSizing = baseMetrics.metrics.find((m) => m.key === "sizing_dscr");
  if (baseSizing?.status === "VALID" && baseSizing.value !== null && baseSizing.value < policy.baseSizingDscrFloor) {
    checks.push({
      key: "base_sizing_dscr",
      kind: "bound",
      severity: "warning",
      message: `Base-case sizing DSCR of ${baseSizing.value.toFixed(2)}x is under the ${policy.baseSizingDscrFloor.toFixed(2)}x floor.`,
      expected: policy.baseSizingDscrFloor,
      actual: baseSizing.value,
    });
  }
  const verdict = computeVerdict(scenarios, checks, policy);
  const warnings: RunResult["warnings"] = [];
  if (input.sCurveDraws && input.constructionMonths === 0) {
    warnings.push({ key: "s_curve_inert", message: "S-curve draws have no effect without a construction period." });
  }
  return {
    engineVersion: ENGINE_VERSION,
    policyVersion: policy.version,
    scenarios,
    verdict,
    checks,
    annual: base.annual,
    equityFlows: base.equityFlows,
    ledger: base.rows,
    irrRoots: baseMetrics.irrRoots,
    warnings,
  };
}

/** Engine versions this build can replay. A new version is added, never replaced. */
export const ENGINES: Record<string, (input: EngineInput, policy: Policy) => RunResult> = {
  [ENGINE_VERSION]: underwrite,
};

export function replay(engineVersion: string, input: EngineInput, policy: Policy): RunResult {
  const engine = ENGINES[engineVersion];
  if (!engine) throw new Error(`Engine ${engineVersion} is not available in this build.`);
  return engine(input, policy);
}
