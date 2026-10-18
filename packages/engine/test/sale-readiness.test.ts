import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import * as contracts from "@agir/contracts";
import { FIELDS, FIELD_BY_KEY, TEMPLATES, policyFor, type EngineInput } from "@agir/contracts";
import { assemble, underwrite, type AssumptionRow } from "../src/index.ts";
import { allEquityDeal } from "./fixtures.ts";

type OracleInputs = { unit_types: { name: string; units: number; price: number }[]; land: number; hard: number; soft: number; contingency: number; construction_months: number; presold_units_pct: number; deposit_pct: number; absorption_units_per_month: number; sales_commission_pct: number; closing_lag_months: number; unsold_carry_monthly: number; senior_commitment: number; senior_rate_pct: number; mezz_commitment: number; mezz_rate_pct: number; senior_presale_threshold_pct: number };
const fromOracle = (d: OracleInputs): EngineInput => ({
  ...allEquityDeal(), budget: { land: d.land, hard: d.hard, soft: d.soft, contingency: d.contingency, other: 0 },
  revenue: [], constructionMonths: d.construction_months, leaseUpMonths: 0, exit: "for_sale",
  senior: { amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 },
  ...(d.mezz_commitment > 0 ? { mezzanine: { amount: d.mezz_commitment, ratePct: d.mezz_rate_pct, amortYears: 30, ioMonths: 0 } } : {}),
  forSale: { units: d.unit_types.map((u, i) => ({ key: String(i), label: u.name, units: u.units, price: u.price })),
    presoldPct: d.presold_units_pct, depositPct: d.deposit_pct, absorptionPerMonth: d.absorption_units_per_month,
    commissionPct: d.sales_commission_pct, closingLagMonths: d.closing_lag_months, carryMonthly: d.unsold_carry_monthly,
    presaleThresholdPct: d.senior_presale_threshold_pct },
});

const rentalOnly = [
  "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual", "item_occupancy_pct", "lease_up_months", "hold_years",
  "stabilized_occupancy_pct", "expense_ratio_pct", "fixed_opex_annual", "property_tax_annual", "variable_expense_pct",
  "other_income_annual", "rent_growth_pct", "expense_growth_pct", "lease_up_ramp", "exit_cap_rate_pct", "selling_costs_pct",
  "min_dscr_covenant", "refinance_month", "refinance_amount", "refinance_ltv_pct", "refinance_rate_pct", "refinance_amort_years",
  "refinance_io_months", "refinance_insurance_premium_pct", "refinance_and_hold", "lp_share_pct", "preferred_return_pct", "gp_promote_pct",
  "senior_amort_years", "senior_io_months", "mezz_amort_years", "mezz_io_months",
  "equity_amount", "stated_total_cost", "stated_ltc_pct", "stated_interest_reserve",
];
const requiredSale = ["presold_units_pct", "deposit_pct", "absorption_units_per_month", "sales_commission_pct", "closing_lag_months", "unsold_carry_monthly"];
const saleFields = ["sell_units", "unit_sale_price", ...requiredSale, "senior_presale_threshold_pct"];
const row = (fieldKey: string, valueNumeric: number, itemKey: string | null = null): AssumptionRow => ({ fieldKey, itemKey, valueNumeric, status: "approved" });
const oracle = (slug = "kestrel-row-townhomes") => JSON.parse(readFileSync(new URL(`../../../oracles/for-sale/${slug}.outcome.json`, import.meta.url), "utf8")) as { inputs: OracleInputs };
const rowsFor = (d = oracle().inputs): AssumptionRow[] => [
  row("sell_units", 1), row("land_cost", d.land), row("hard_cost", d.hard), row("soft_cost", d.soft), row("contingency", d.contingency),
  row("construction_months", d.construction_months), row("senior_loan_amount", d.senior_commitment), row("senior_rate_pct", d.senior_rate_pct),
  ...(d.mezz_commitment > 0 ? [row("mezz_loan_amount", d.mezz_commitment), row("mezz_rate_pct", d.mezz_rate_pct)] : []),
  ...[...requiredSale, "senior_presale_threshold_pct"].map((key) => row(key, d[key as keyof OracleInputs] as number)),
  ...d.unit_types.flatMap((u) => [row("unit_count", u.units, u.name), row("unit_sale_price", u.price, u.name)]),
];
const rentalRows = () => [row("land_cost", 1_000_000), row("hard_cost", 0), row("soft_cost", 0), row("contingency", 0), row("construction_months", 0),
  row("lease_up_months", 0), row("hold_years", 1), row("stabilized_occupancy_pct", 100), row("expense_ratio_pct", 0), row("exit_cap_rate_pct", 10),
  row("selling_costs_pct", 0), row("senior_loan_amount", 0), row("unit_count", 10, "A"), row("unit_rent_monthly", 1_000, "A")];

describe("setting up a deal that sells its units (task 78)", () => {
  test("the excluded fields match the sale engine and shared construction readers", () => {
    expect((contracts as Record<string, unknown>).RENTAL_ONLY_FIELDS).toEqual(rentalOnly);
  });
  test.each(["kestrel-row-townhomes", "alder-court-condo"])("%s assembles and matches fromOracle in every scenario", (slug) => {
    const d = oracle(slug).inputs;
    const { readiness, input } = assemble(rowsFor(d));
    expect(readiness).toMatchObject({ status: "ready", missing: [], impossible: [], conflicting: [], pending: [] });
    expect(input).not.toBeNull();
    expect(policyFor(input!).version).toBe("for-sale-draft");
    const got = underwrite(input!, policyFor(input!));
    const reference = fromOracle(d);
    const expected = underwrite(reference, policyFor(reference));
    expect(got.verdict).toEqual(expected.verdict);
    expect(got.scenarios.map((s) => s.metrics)).toEqual(expected.scenarios.map((s) => s.metrics));
    expect(input!.forSale!.units.map((u) => u.key)).toEqual(d.unit_types.map((u) => u.name).sort());
    expect(input!.senior).toEqual({ amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 });
    expect(input).toMatchObject({ revenue: [], leaseUpMonths: 0, holdYears: 0, stabilizedOccupancyPct: 0, expenseRatioPct: 0, exitCapPct: 0,
      sellingCostsPct: 0, rentGrowthPct: 0, expenseGrowthPct: 0, leaseUpRamp: false, sCurveDraws: false, otherIncomeAnnual: 0, stated: {} });
    expect(JSON.stringify(input)).not.toMatch(/null/);
  });
  test.each(requiredSale)("requires only the missing sale field: %s", (key) => {
    expect(assemble(rowsFor().filter((r) => r.fieldKey !== key)).readiness.missing.map((m) => m.fieldKey)).toEqual([key]);
  });
  test("both modes give one named impossible item", () => {
    expect(assemble([...rowsFor(), row("refinance_and_hold", 1)]).readiness.impossible).toEqual([
      { fieldKey: "sell_units", label: "Sell the units and keep and refinance cannot both be chosen" },
    ]);
  });
  test.each(rentalOnly)("a readable rental field blocks a sale: %s", (key) => {
    const def = FIELD_BY_KEY.get(key)!;
    const { readiness, input } = assemble([...rowsFor(), row(key, Math.max(def.min ?? 0, 1), def.itemized ? oracle().inputs.unit_types[0]!.name : null)]);
    expect(input).toBeNull();
    expect(readiness.impossible).toContainEqual(expect.objectContaining({ fieldKey: key, label: key === "refinance_and_hold"
      ? "Sell the units and keep and refinance cannot both be chosen" : `${def.label} does not apply when the units are sold` }));
  });
  test.each(saleFields.filter((key) => key !== "sell_units"))("a readable sale field blocks a rental: %s", (key) => {
    const def = FIELD_BY_KEY.get(key)!;
    expect(assemble([...rentalRows(), row(key, Math.max(def.min ?? 0, 1), def.itemized ? "A" : null)]).readiness.impossible)
      .toContainEqual(expect.objectContaining({ fieldKey: key, label: `${def.label} applies only when the units are sold` }));
  });
  test.each(["needs_review", "awaiting_second_approval", "conflicting", "rejected"] as const)("rental rows retain their review rules: %s", (status) => {
    const { readiness } = assemble([...rowsFor(), { ...row("property_tax_annual", 0), status }]);
    expect(readiness.impossible).toEqual([]);
    expect(readiness.pending.length).toBe(status === "needs_review" || status === "awaiting_second_approval" ? 1 : 0);
    expect(readiness.conflicting.length).toBe(status === "conflicting" ? 1 : 0);
    expect(readiness.status).toBe(status === "rejected" ? "ready" : "blocked");
  });
  test("disclosures contain only fields for the selected mode; rental input stays the same", () => {
    const rental = assemble(rentalRows());
    expect(rental.input).toEqual({ ...allEquityDeal(), senior: { amount: 0, ratePct: 0, ioMonths: 0 } });
    expect([...rental.readiness.notFound, ...rental.readiness.choices].some((x) => saleFields.includes(x.fieldKey))).toBe(false);
    const sale = assemble(rowsFor());
    expect([...sale.readiness.notFound, ...sale.readiness.choices].some((x) => rentalOnly.includes(x.fieldKey))).toBe(false);
  });
  test("names a missing price and missing unit types", () => {
    const item = oracle().inputs.unit_types[0]!.name;
    expect(assemble(rowsFor().filter((r) => !(r.fieldKey === "unit_sale_price" && r.itemKey === item))).readiness.missing)
      .toEqual([{ fieldKey: "unit_sale_price", itemKey: item, label: `Sale price per unit (${item})` }]);
    expect(assemble(rowsFor().filter((r) => !r.itemKey)).readiness.missing)
      .toEqual([{ fieldKey: "unit_count", label: "Unit types (at least one, with a count and a sale price)" }]);
    expect(assemble(rowsFor().filter((r) => !(r.fieldKey === "unit_count" && r.itemKey === item))).readiness.missing)
      .toEqual([{ fieldKey: "unit_count", itemKey: item, label: `Units (${item})` }]);
  });
  test("validation names a unit count that is zero", () => {
    const rows = rowsFor().map((r) => r.fieldKey === "unit_count" ? { ...r, valueNumeric: 0 } : r);
    expect(assemble(rows).readiness.impossible.every((x) => x.fieldKey === "unit_count")).toBe(true);
    expect(assemble(rows).readiness.impossible).toHaveLength(2);
  });
  test("the sale catalog has no extraction or defaults and permits a fractional sales pace", () => {
    for (const key of saleFields) expect(FIELD_BY_KEY.get(key), key).toMatchObject({ extractable: false, aliases: [] });
    expect(FIELDS.filter((f) => saleFields.includes(f.key)).every((f) => f.default === undefined)).toBe(true);
    expect(assemble(rowsFor().map((r) => r.fieldKey === "absorption_units_per_month" ? { ...r, valueNumeric: 0.5 } : r)).readiness.status).toBe("ready");
  });
  test.each([3_300_000, 0])("townhomes questions assemble and reach a verdict with loan %s", (loan) => {
    const t = TEMPLATES.find((x) => String(x.key) === "townhomes")!;
    expect(t).toBeDefined();
    expect(t).toMatchObject({ sells: true, minUnits: 2, maxUnits: 30, defaults: [] });
    const skipped = loan === 0 ? t.questions.find((q) => q.field === "senior_loan_amount")!.skipsIfZero! : [];
    const answers = [...rowsFor().filter((r) => t.questions.some((q) => q.field === r.fieldKey) && !skipped.includes(r.fieldKey))
      .map((r) => r.fieldKey === "senior_loan_amount" ? { ...r, valueNumeric: loan } : r), row("development_charges", 0), row("sell_units", 1)];
    expect(answers.some((r) => rentalOnly.includes(r.fieldKey))).toBe(false);
    for (const q of t.questions) {
      expect(FIELD_BY_KEY.has(q.field), q.field).toBe(true);
      expect(rentalOnly.includes(q.field), q.field).toBe(false);
    }
    expect(t.questions.find((q) => q.field === "development_charges")).toMatchObject({ zeroAllowed: true });
    expect(t.questions.map((q) => q.field)).toEqual(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost", "development_charges", "land_transfer_tax", "gst_hst_net",
      "construction_months", "unit_count", "unit_sale_price", ...requiredSale, "senior_loan_amount", "senior_rate_pct", "senior_presale_threshold_pct"]);
    const { readiness, input } = assemble(answers);
    expect(readiness.status).toBe("ready");
    expect(underwrite(input!, policyFor(input!)).verdict.code).toMatch(/^(APPROVE|APPROVE_WITH_CONDITIONS|REJECT)$/);
  });
});
