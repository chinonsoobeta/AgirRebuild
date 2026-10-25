import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as contracts from "@agir/contracts";
import type { EngineInput } from "@agir/contracts";
import * as engine from "../src/index.ts";

// SHA-256 of the signed source exports, computed once on 2026-10-24.
// Sources: /Users/chinonsoobeta/Documents/Codex/2026-10-24/rental-workbooks/<slug>/<slug>.outcome.json
const sourceHashes = {
  "fireweed-fourplex": "5f11ce3d5c3ef8498b80d4c0ffffcba26a12954bb6faa9511f0771167a4770df",
  "harbour-lane": "4852272c1a784f8998f8891284f6ca19f9e331c22500066ee2b677595b53a63b",
} as const;
type Inputs = Record<string, number> & { cost_curve?: string };
type Oracle = {
  inputs: Inputs; policy: string; verdict: string;
  base: Record<string, number | "NOT_APPLICABLE">;
  stresses: Record<string, Record<string, number | "NOT_APPLICABLE">>;
  gates: { key: string; scenario: string; threshold: number; value: number; pass: boolean }[];
  checks: { severity: string; fired: boolean }[];
  tolerance: { money: number; percent: number; multiple: number };
};
const toInput = (d: Inputs): EngineInput => ({
  budget: { land: d.land_cost, hard: d.hard_cost, soft: d.soft_cost, contingency: d.contingency, other: 0, developmentCharges: d.development_charges, landTransferTax: d.land_transfer_tax, gstHstNet: d.gst_hst_net },
  revenue: (["1bed", "2bed", "3bed"] as const).filter((b) => d[`units_${b}`]).map((b) => ({ key: b, label: b, basis: "per_unit", units: d[`units_${b}`]!, rentMonthly: d[`rent_${b}_monthly`]! })),
  otherIncomeAnnual: d.other_income_annual ?? 0, constructionMonths: d.construction_months, leaseUpMonths: d.lease_up_months, holdYears: d.hold_years,
  stabilizedOccupancyPct: d.stabilized_occupancy_pct, expenseRatioPct: d.expense_ratio_pct, propertyTaxAnnual: d.property_tax_annual, rentGrowthPct: d.rent_growth_pct, expenseGrowthPct: d.expense_growth_pct,
  leaseUpRamp: !!(d.lease_up_ramp ?? d.leaseup_income_credited), sCurveDraws: d.cost_curve ? d.cost_curve !== "straight-line" : true, exitCapPct: d.exit_cap_rate_pct, sellingCostsPct: 0,
  senior: { amount: d.senior_loan_amount, ratePct: d.senior_rate_pct, ioMonths: d.senior_io_months },
  refinance: { month: d.refinance_month, ltvPct: d.refinance_ltv_pct, ratePct: d.refinance_rate_pct, amortYears: d.refinance_amort_years, ioMonths: 0, ...(d.refinance_insurance_premium_pct ? { insurancePremiumPct: d.refinance_insurance_premium_pct, mliSelectPoints: d.refinance_mli_select_points } : {}) },
  exit: "refinance_hold", stated: {},
});

test.each(["fireweed-fourplex", "harbour-lane"] as const)("matches every signed rental workbook result: %s", (slug) => {
  const bytes = readFileSync(new URL(`../../../oracles/rental-hold/${slug}.outcome.json`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sourceHashes[slug]);
  const oracle = JSON.parse(bytes.toString("utf8")) as Oracle;
  const input = toInput(oracle.inputs);
  const result = engine.underwrite(input, contracts.policyFor(input));
  const tolerance = (unit: string) => unit === "$" ? oracle.tolerance.money : unit === "%" || unit === "bps" ? oracle.tolerance.percent : unit === "x" ? oracle.tolerance.multiple : 1e-6;
  expect(result.verdict.code).toBe(oracle.verdict);
  expect(result.policyVersion).toBe(oracle.policy);
  for (const [scenario, expected] of Object.entries({ base: oracle.base, ...oracle.stresses })) {
    const actual = result.scenarios.find((s) => s.key === scenario)!;
    expect(actual, `${slug} ${scenario}`).toBeDefined();
    for (const [key, wanted] of Object.entries(expected)) {
      const got = actual.metrics.find((m) => m.key === key)!;
      const label = `${slug} ${scenario} ${key}: engine ${got?.value}, file ${wanted}`;
      expect(got, label).toBeDefined();
      if (wanted === "NOT_APPLICABLE") {
        expect(got.value, label).toBeNull();
        expect(got.status, label).not.toBe("VALID");
      } else {
        expect(got.status, label).toBe("VALID");
        expect(got.value, label).not.toBeNull();
        expect(Math.abs(got.value! - wanted), label).toBeLessThanOrEqual(tolerance(got.unit));
      }
    }
  }
  expect(result.verdict.gates).toHaveLength(oracle.gates.length);
  for (const [i, gate] of oracle.gates.entries()) {
    const key = gate.scenario === "combined" ? `stressed_${gate.key}` : gate.key;
    const actual = result.verdict.gates[i]!;
    expect(actual).toMatchObject({ key, scenario: gate.scenario, threshold: gate.threshold, status: gate.pass ? "passed" : "failed" });
    const unit = result.scenarios.find((s) => s.key === gate.scenario)!.metrics.find((m) => m.key === gate.key)!.unit;
    expect(actual.actual).not.toBeNull();
    expect(Math.abs(actual.actual! - gate.value), `${slug} gate ${key}`).toBeLessThanOrEqual(tolerance(unit));
  }
  expect(oracle.checks.filter((c) => c.severity === "error" && c.fired)).toEqual([]);
  expect(result.checks.filter((c) => c.severity === "error")).toEqual([]);
});
