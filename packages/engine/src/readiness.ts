// Readiness and assembly: the only road from review to the engine.
//
// The engine reads approved and default-accepted rows and nothing else. A
// required field that has no readable row is missing; a field with more than
// one readable value, or an unresolved conflict, is conflicting; a value
// awaiting review or a second approver is pending. Any of these blocks the
// run and is named.

import {
  ENGINE_READABLE_STATUSES,
  FIELDS,
  FIELD_BY_KEY,
  type AssumptionStatus,
  type EngineInput,
  type FieldDef,
  type Readiness,
  type ReadinessItem,
  type RevenueComponent,
} from "@agir/contracts";
import { EngineInputError, validateInput } from "./validate.ts";

export type AssumptionRow = {
  fieldKey: string;
  itemKey: string | null;
  status: AssumptionStatus;
  valueNumeric: number | null;
};

const readable = (r: AssumptionRow) => ENGINE_READABLE_STATUSES.includes(r.status) && r.valueNumeric !== null;

function impossibleReason(def: FieldDef, v: number): string | null {
  if (!Number.isFinite(v)) return "not a number";
  if (def.min !== undefined && v < def.min) return `below the minimum of ${def.min}`;
  if (def.max !== undefined && v > def.max) return `above the maximum of ${def.max}`;
  if (def.integer && !Number.isInteger(v)) return "must be a whole number";
  return null;
}

function labelFor(def: FieldDef, itemKey?: string | null) {
  return itemKey ? `${def.label} (${itemKey})` : def.label;
}

// The cross-field rules live in validateInput and are not repeated here. Its sentences are shown as they are; this only
// names the field a person should look at, when the sentence is about one.
const PROBLEM_FIELD: [RegExp, string][] = [
  [/^refinance month /, "refinance_month"],
  [/^give the refinance /, "refinance_amount"],
  [/^A deal that is kept and refinanced /, "refinance_month"],
];

export function assemble(rows: readonly AssumptionRow[]): { readiness: Readiness; input: EngineInput | null } {
  const missing: ReadinessItem[] = [];
  const conflicting: ReadinessItem[] = [];
  const pending: ReadinessItem[] = [];
  const impossible: ReadinessItem[] = [];
  const values = new Map<string, number>(); // "field" or "field|item" -> value

  const groups = new Map<string, AssumptionRow[]>();
  for (const r of rows) {
    if (r.status === "rejected") continue;
    const k = r.itemKey ? `${r.fieldKey}|${r.itemKey}` : r.fieldKey;
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  for (const [k, list] of groups) {
    const [fieldKey, itemKey] = k.split("|") as [string, string | undefined];
    const def = FIELD_BY_KEY.get(fieldKey);
    if (!def) continue;
    const item = { fieldKey, ...(itemKey ? { itemKey } : {}), label: labelFor(def, itemKey) };
    const good = list.filter(readable);
    const distinct = new Set(good.map((r) => r.valueNumeric));
    if (list.some((r) => r.status === "conflicting") || distinct.size > 1) {
      conflicting.push(item);
      continue;
    }
    if (good.length === 0) {
      if (list.some((r) => r.status === "needs_review" || r.status === "awaiting_second_approval")) {
        pending.push({
          ...item,
          detail: list.some((r) => r.status === "awaiting_second_approval") ? "Waiting for a second approver" : "Needs review",
        });
      }
      continue;
    }
    const v = good[0]!.valueNumeric!;
    const why = impossibleReason(def, v);
    if (why) {
      impossible.push({ ...item, detail: why });
      continue;
    }
    values.set(k, v);
  }

  const has = (key: string) => values.has(key);
  const isBlockedKey = (key: string) =>
    conflicting.some((c) => c.fieldKey === key && !c.itemKey) ||
    pending.some((c) => c.fieldKey === key && !c.itemKey) ||
    impossible.some((c) => c.fieldKey === key && !c.itemKey);

  // Component occupancy, when every component states one, stands in for the
  // deal-level stabilized occupancy.
  const itemsWithRows = new Set(rows.filter((r) => r.itemKey && r.status !== "rejected").map((r) => r.itemKey!));
  const everyItemHasOccupancy =
    itemsWithRows.size > 0 &&
    [...itemsWithRows].every((i) => rows.some((r) => r.fieldKey === "item_occupancy_pct" && r.itemKey === i && r.status !== "rejected"));

  for (const def of FIELDS) {
    if (def.itemized || has(def.key) || isBlockedKey(def.key)) continue;
    if (def.key === "stabilized_occupancy_pct" && everyItemHasOccupancy) continue;
    let required = false;
    if (def.required === true) required = true;
    else if (typeof def.required === "string") {
      if (def.required.startsWith("!")) required = !has(def.required.slice(1)) && !isBlockedKey(def.required.slice(1));
      else required = (values.get(def.required) ?? 0) > 0;
    }
    if (required) missing.push({ fieldKey: def.key, label: def.label });
  }

  // ---- Revenue components -----------------------------------------------------
  const itemKeys = new Set<string>();
  for (const r of rows) if (r.itemKey && r.status !== "rejected") itemKeys.add(r.itemKey);
  const revenue: RevenueComponent[] = [];
  if (itemKeys.size === 0) {
    missing.push({ fieldKey: "unit_count", label: "Revenue program (at least one unit type or space)" });
  }
  for (const item of [...itemKeys].sort()) {
    const get = (f: string) => values.get(`${f}|${item}`);
    const blocked = (f: string) =>
      [...conflicting, ...pending, ...impossible].some((c) => c.fieldKey === f && c.itemKey === item);
    const rentMonthly = get("unit_rent_monthly");
    const psf = get("rent_psf_annual");
    const area = get("rentable_area_sf");
    const units = get("unit_count");
    const occ = get("item_occupancy_pct");
    const anyBlocked = ["unit_count", "unit_rent_monthly", "rent_psf_annual", "rentable_area_sf", "item_occupancy_pct"].some(blocked);
    if (anyBlocked) continue;
    if (rentMonthly !== undefined) {
      if (units === undefined) missing.push({ fieldKey: "unit_count", itemKey: item, label: `Units (${item})` });
      else revenue.push({ key: item, label: item, basis: "per_unit", units, rentMonthly, ...(occ !== undefined ? { occupancyPct: occ } : {}) });
    } else if (psf !== undefined || area !== undefined) {
      if (area === undefined) missing.push({ fieldKey: "rentable_area_sf", itemKey: item, label: `Rentable area (${item})` });
      else if (psf === undefined) missing.push({ fieldKey: "rent_psf_annual", itemKey: item, label: `Rent per SF (${item})` });
      else revenue.push({ key: item, label: item, basis: "per_sf", units: units ?? 0, areaSf: area, rentPsfAnnual: psf, ...(occ !== undefined ? { occupancyPct: occ } : {}) });
    } else {
      missing.push({ fieldKey: "unit_rent_monthly", itemKey: item, label: `Rent (${item})` });
    }
  }

  // ---- Not found: an optional line no document gave. Shown, never counted as a value ----
  const positive = (key: string) => (values.get(key) ?? 0) > 0;
  const parentAbsent: Record<string, boolean> = {
    refinance_amount: !has("refinance_month"),
    refinance_ltv_pct: !has("refinance_month"),
    refinance_io_months: !has("refinance_month"),
    refinance_insurance_premium_pct: !has("refinance_month"),
    mezz_io_months: !positive("mezz_loan_amount"),
    senior_io_months: !positive("senior_loan_amount"),
    // Stand-ins for a present alternative.
    fixed_opex_annual: has("expense_ratio_pct"),
  };
  if (has("refinance_ltv_pct")) parentAbsent.refinance_amount = true;
  if (has("refinance_amount")) parentAbsent.refinance_ltv_pct = true;
  const notFound: ReadinessItem[] = FIELDS.filter(
    (d) => !d.itemized && d.extractable && d.required === false && d.absentMeans && !has(d.key) && !isBlockedKey(d.key) && !parentAbsent[d.key],
  ).map((d) => ({ fieldKey: d.key, label: d.label, detail: d.absentMeans! }));
  // Choices: the same test for the fields no document is ever read for. Only a person states them.
  const choices: ReadinessItem[] = FIELDS.filter(
    (d) => !d.itemized && !d.extractable && d.required === false && d.absentMeans && !has(d.key) && !isBlockedKey(d.key) && !parentAbsent[d.key],
  ).map((d) => ({ fieldKey: d.key, label: d.label, detail: d.absentMeans! }));

  const defaultable = missing.map((m) => m.fieldKey).filter((k) => FIELD_BY_KEY.get(k)?.default !== undefined);
  const blocked = missing.length + conflicting.length + pending.length + impossible.length > 0;
  const readiness: Readiness = { status: blocked ? "blocked" : "ready", missing, conflicting, pending, impossible, notFound, choices, defaultable };
  if (blocked) return { readiness, input: null };

  const v = (k: string) => values.get(k);
  const n = (k: string, fallback = 0) => values.get(k) ?? fallback;
  const input: EngineInput = {
    budget: { land: n("land_cost"), hard: n("hard_cost"), soft: n("soft_cost"), contingency: n("contingency"), other: n("other_cost"),
      // The entered cost lines are set only when stated, so an input that states none hashes as it always did.
      ...(has("development_charges") ? { developmentCharges: n("development_charges") } : {}),
      ...(has("land_transfer_tax") ? { landTransferTax: n("land_transfer_tax") } : {}),
      ...(has("gst_hst_net") ? { gstHstNet: n("gst_hst_net") } : {}),
    },
    revenue,
    otherIncomeAnnual: n("other_income_annual"),
    constructionMonths: n("construction_months"),
    leaseUpMonths: n("lease_up_months"),
    holdYears: n("hold_years"),
    stabilizedOccupancyPct: has("stabilized_occupancy_pct")
      ? n("stabilized_occupancy_pct")
      : Math.min(...revenue.map((c) => c.occupancyPct ?? 100)),
    ...(has("fixed_opex_annual")
      ? { fixedOpexAnnual: n("fixed_opex_annual") }
      : { expenseRatioPct: n("expense_ratio_pct") }),
    ...(has("property_tax_annual") ? { propertyTaxAnnual: n("property_tax_annual") } : {}),
    ...(has("variable_expense_pct") ? { variableExpensePct: n("variable_expense_pct") } : {}),
    rentGrowthPct: n("rent_growth_pct"),
    expenseGrowthPct: n("expense_growth_pct"),
    leaseUpRamp: n("lease_up_ramp") === 1,
    sCurveDraws: n("s_curve_draws") === 1,
    exitCapPct: n("exit_cap_rate_pct"),
    sellingCostsPct: n("selling_costs_pct"),
    senior: {
      amount: n("senior_loan_amount"),
      ratePct: n("senior_rate_pct"),
      amortYears: n("senior_amort_years", 30),
      ioMonths: n("senior_io_months"),
    },
    ...(n("mezz_loan_amount") > 0
      ? { mezzanine: { amount: n("mezz_loan_amount"), ratePct: n("mezz_rate_pct"), amortYears: n("mezz_amort_years", 30), ioMonths: n("mezz_io_months") } }
      : {}),
    ...(has("refinance_month")
      ? {
          refinance: {
            month: n("refinance_month"),
            ...(has("refinance_amount") ? { amount: n("refinance_amount") } : {}),
            ...(has("refinance_ltv_pct") ? { ltvPct: n("refinance_ltv_pct") } : {}),
            ratePct: n("refinance_rate_pct"),
            amortYears: n("refinance_amort_years", 30),
            ioMonths: n("refinance_io_months"),
            ...(has("refinance_insurance_premium_pct") ? { insurancePremiumPct: n("refinance_insurance_premium_pct") } : {}),
          },
        }
      : {}),
    ...(n("refinance_and_hold") === 1 ? { exit: "refinance_hold" as const } : {}),
    ...(has("lp_share_pct")
      ? { waterfall: { lpSharePct: n("lp_share_pct"), preferredReturnPct: n("preferred_return_pct"), gpPromotePct: n("gp_promote_pct") } }
      : {}),
    stated: {
      ...(v("equity_amount") !== undefined ? { equity: n("equity_amount") } : {}),
      ...(v("stated_total_cost") !== undefined ? { totalCost: n("stated_total_cost") } : {}),
      ...(v("stated_ltc_pct") !== undefined ? { ltcPct: n("stated_ltc_pct") } : {}),
      ...(v("stated_interest_reserve") !== undefined ? { interestReserve: n("stated_interest_reserve") } : {}),
      ...(v("min_dscr_covenant") !== undefined ? { minDscrCovenant: n("min_dscr_covenant") } : {}),
    },
  };
  // "Ready" means the engine will accept this input: run its own checks, and name whatever it would refuse.
  try {
    validateInput(input);
  } catch (e) {
    if (!(e instanceof EngineInputError)) throw e;
    const problems = e.problems.map((label): ReadinessItem => ({ fieldKey: PROBLEM_FIELD.find(([re]) => re.test(label))?.[1] ?? "input", label }));
    return { readiness: { ...readiness, status: "blocked", impossible: problems }, input: null };
  }
  return { readiness, input };
}
