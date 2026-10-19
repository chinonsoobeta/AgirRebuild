import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as contracts from "@agir/contracts";
import { FIELDS, FIELD_BY_KEY, TEMPLATES, policyFor, type EngineInput } from "@agir/contracts";
import { irrRoots, runWaterfall, validateInput, assemble, canonicalJson, underwrite, type AssumptionRow } from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";
import { fundConstruction, placeConstructionCosts } from "../src/ledger.ts";

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
  "refinance_io_months", "refinance_insurance_premium_pct", "refinance_and_hold",
  "senior_amort_years", "senior_io_months", "mezz_amort_years", "mezz_io_months",
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
  test.each(contracts.RENTAL_ONLY_FIELDS)("a readable rental field blocks a sale: %s", (key) => {
    const def = FIELD_BY_KEY.get(key)!;
    const { readiness, input } = assemble([...rowsFor(), row(key, key === "refinance_and_hold" ? 0 : Math.max(def.min ?? 0, 1), def.itemized ? oracle().inputs.unit_types[0]!.name : null)]);
    expect(input).toBeNull();
    expect(readiness.impossible).toContainEqual(expect.objectContaining({ fieldKey: key, label: `${def.label} does not apply when the units are sold` }));
  });
  test.each(saleFields.filter((key) => key !== "sell_units"))("a readable sale field blocks a rental: %s", (key) => {
    const def = FIELD_BY_KEY.get(key)!;
    expect(assemble([...rentalRows(), row(key, Math.max(def.min ?? 0, 1), def.itemized ? "A" : null)]).readiness.impossible)
      .toContainEqual(expect.objectContaining({ fieldKey: key, label: `${def.label} applies only when the units are sold` }));
  });
  test("an out-of-mode readable value names its mode problem even outside its bounds", () => {
    expect(assemble([...rowsFor(), row("property_tax_annual", -1)]).readiness.impossible)
      .toEqual([{ fieldKey: "property_tax_annual", label: "Property tax (per year) does not apply when the units are sold" }]);
    expect(assemble([...rentalRows(), row("deposit_pct", 101)]).readiness.impossible)
      .toEqual([{ fieldKey: "deposit_pct", label: "Buyer deposit applies only when the units are sold" }]);
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
  test("optional cost lines are retained, while the absent presale condition is omitted", () => {
    const rows = rowsFor().filter((r) => r.fieldKey !== "senior_presale_threshold_pct");
    const { readiness, input } = assemble([...rows, row("development_charges", 100), row("land_transfer_tax", 200), row("gst_hst_net", 300)]);
    expect(readiness.status).toBe("ready");
    expect(input!.budget).toMatchObject({ developmentCharges: 100, landTransferTax: 200, gstHstNet: 300 });
    expect(input!.forSale).not.toHaveProperty("presaleThresholdPct");
  });
  test("a stated S-curve reaches the sale input, because construction draws are shared", () => {
    const { readiness, input } = assemble([...rowsFor(), row("s_curve_draws", 1)]);
    expect(readiness.status).toBe("ready");
    expect(input!.sCurveDraws).toBe(true);
    expect(assemble(rowsFor()).input!.sCurveDraws).toBe(false);
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
      "construction_months", "unit_count", "unit_sale_price", ...requiredSale, "senior_loan_amount", "senior_rate_pct", "senior_presale_threshold_pct", "lp_share_pct", "preferred_return_pct", "gp_promote_pct"]);
    const { readiness, input } = assemble(answers);
    expect(readiness.status).toBe("ready");
    expect(underwrite(input!, policyFor(input!)).verdict.code).toMatch(/^(APPROVE|APPROVE_WITH_CONDITIONS|REJECT)$/);
  });
});

const checkFixture = (held = false): EngineInput => ({ ...developmentDeal(),
  stated: { equity: 10_000_000, totalCost: 40_000_000, ltcPct: 70, interestReserve: 1_000_000, minDscrCovenant: 1.2 },
  ...(held ? { exit: "refinance_hold", refinance: { month: 36, amount: 29_000_000, ratePct: 5, amortYears: 30, ioMonths: 0 } } : {}),
});

const constructionFigures = (input: EngineInput) => {
  const C = input.constructionMonths;
  const cost = placeConstructionCosts(input, C);
  const funding = fundConstruction(input, C, cost.costByMonth, cost.costsBeforeFinancing);
  const result = underwrite(input, policyFor(input));
  return { totalCost: funding.tdc, equity: funding.equityContributed, debt: funding.commitments + funding.sim.mezzAccruedBeyondCommitment,
    loanToCost: result.scenarios[0]!.metrics.find((m) => m.key === "loan_to_cost")!.value!, interest: funding.capitalizedInterest };
};
const statedRun = (stated: EngineInput["stated"] = {}, slug = "kestrel-row-townhomes") => {
  const input = { ...fromOracle(oracle(slug).inputs), stated };
  return underwrite(input, policyFor(input));
};
const check = (result: ReturnType<typeof underwrite>, key: string) => result.checks.find((c) => c.key === key);
const CHECK_PINS = {
  "rental": [
    {
      "key": "ltc_ceiling",
      "kind": "bound",
      "severity": "pass",
      "message": "Loan to cost of 59.6% is within the policy ceiling of 85%.",
      "actual": 59.566001596862165
    },
    {
      "key": "sources_cover_uses",
      "kind": "agreement",
      "severity": "error",
      "message": "Stated equity of $10,000,000 plus debt of $27,000,000 falls $8,327,870 short of the $45,327,870 total cost.",
      "expected": 18327870.389444295,
      "actual": 10000000
    },
    {
      "key": "stated_total_cost",
      "kind": "agreement",
      "severity": "warning",
      "message": "The documents state a total cost of $40,000,000; the model computes $45,327,870.",
      "expected": 45327870.3894443,
      "actual": 40000000
    },
    {
      "key": "stated_ltc",
      "kind": "agreement",
      "severity": "warning",
      "message": "The documents state a loan to cost of 70.0%; the model computes 59.6%.",
      "expected": 59.566001596862165,
      "actual": 70
    },
    {
      "key": "interest_reserve",
      "kind": "agreement",
      "severity": "warning",
      "message": "The budget states a $1,000,000 interest reserve; the model calculates $2,233,810 of interest before stabilization. The reserve looks underfunded by $1,233,810.",
      "expected": 2233810.3894442962,
      "actual": 1000000
    },
    {
      "key": "dscr_covenant",
      "kind": "agreement",
      "severity": "warning",
      "message": "Contractual DSCR falls to 1.18x, under the 1.20x covenant.",
      "expected": 1.2,
      "actual": 1.1788854470752164
    },
    {
      "key": "base_sizing_dscr",
      "kind": "bound",
      "severity": "warning",
      "message": "Base-case sizing DSCR of 1.14x is under the 1.20x floor.",
      "expected": 1.2,
      "actual": 1.1415650511715316
    }
  ],
  "held": [
    {
      "key": "ltc_ceiling",
      "kind": "bound",
      "severity": "pass",
      "message": "Loan to cost of 59.6% is within the policy ceiling of 85%.",
      "actual": 59.566001596862165
    },
    {
      "key": "sources_cover_uses",
      "kind": "agreement",
      "severity": "error",
      "message": "Stated equity of $10,000,000 plus debt of $27,000,000 falls $8,327,870 short of the $45,327,870 total cost.",
      "expected": 18327870.389444295,
      "actual": 10000000
    },
    {
      "key": "stated_total_cost",
      "kind": "agreement",
      "severity": "warning",
      "message": "The documents state a total cost of $40,000,000; the model computes $45,327,870.",
      "expected": 45327870.3894443,
      "actual": 40000000
    },
    {
      "key": "stated_ltc",
      "kind": "agreement",
      "severity": "warning",
      "message": "The documents state a loan to cost of 70.0%; the model computes 59.6%.",
      "expected": 59.566001596862165,
      "actual": 70
    },
    {
      "key": "interest_reserve",
      "kind": "agreement",
      "severity": "warning",
      "message": "The budget states a $1,000,000 interest reserve; the model calculates $2,233,810 of interest before stabilization. The reserve looks underfunded by $1,233,810.",
      "expected": 2233810.3894442962,
      "actual": 1000000
    },
    {
      "key": "dscr_covenant",
      "kind": "agreement",
      "severity": "pass",
      "message": "Contractual DSCR of 1.23x meets the 1.20x covenant in every hold year.",
      "expected": 1.2,
      "actual": 1.2258382250417657
    }
  ]
};

describe("a sale checks the figures a person states (task 81)", () => {
  test("an unstated Kestrel input retains its pre-change hash", () => {
    const { input } = assemble(rowsFor());
    expect(input!.stated).toEqual({});
    expect(createHash("sha256").update(canonicalJson(input)).digest("hex")).toBe("6da97ac4e573322f49634e2a7bd90236f7ba07554f9e40ff452118009c13c1b2");
  });
  test.each([["equity_amount", "equity", 1_583_889], ["stated_total_cost", "totalCost", 4_883_889], ["stated_ltc_pct", "ltcPct", 67.6], ["stated_interest_reserve", "interestReserve", 103_889]] as const)("%s is readable for a sale and reaches stated.%s", (field, key, value) => {
    const { input, readiness } = assemble([...rowsFor(), row(field, value)]);
    expect(readiness).toMatchObject({ status: "ready", missing: [], impossible: [], conflicting: [], pending: [] });
    expect(input!.stated).toEqual({ [key]: value });
  });
  test("without stated equity the sale has the rental pass line", () => {
    expect(check(statedRun(), "sources_cover_uses")).toEqual({ key: "sources_cover_uses", kind: "agreement", severity: "pass", message: "No equity amount is stated, so equity is the $1,583,889 the debt does not fund." });
    for (const key of ["stated_total_cost", "stated_ltc", "interest_reserve_before_completion"]) expect(check(statedRun(), key)).toBeUndefined();
  });
  test.each([-2, -0.5, 0, 2])("stated construction equity respects the tolerance: %s times tolerance", (factor) => {
    const input = fromOracle(oracle().inputs);
    const figures = constructionFigures(input);
    const stated = figures.equity + factor * figures.totalCost * policyFor(input).agreementTolerancePct / 100;
    const result = statedRun({ equity: stated });
    const severity = factor < -1 ? "error" : factor > 1 ? "warning" : "pass";
    expect(check(result, "sources_cover_uses")).toMatchObject({ severity, actual: stated });
    expect(result.verdict.code).toBe(severity === "error" ? "REJECT" : statedRun().verdict.code);
    if (factor === 0) expect(check(result, "sources_cover_uses")!.message).toBe("Sources equal uses at $4,883,889.");
    if (severity !== "pass") expect(check(result, "sources_cover_uses")!.expected).toBe(figures.equity);
  });
  test.each([1, 1.1])("stated total cost at %s times the model agrees or warns", (factor) => {
    const figures = constructionFigures(fromOracle(oracle().inputs));
    const c = check(statedRun({ totalCost: figures.totalCost * factor }), "stated_total_cost")!;
    expect(c).toMatchObject({ severity: factor === 1 ? "pass" : "warning", expected: figures.totalCost, actual: figures.totalCost * factor });
    expect(c.message).toBe(factor === 1 ? "The stated total cost of $4,883,889 matches the model." : "The documents state a total cost of $5,372,278; the model computes $4,883,889.");
  });
  test.each([1, 2])("stated loan to cost %s points above the model", (points) => {
    const figures = constructionFigures(fromOracle(oracle().inputs));
    expect(check(statedRun({ ltcPct: figures.loanToCost + points }), "stated_ltc"))
      .toMatchObject({ severity: points === 1 ? "pass" : "warning", expected: figures.loanToCost, actual: figures.loanToCost + points });
  });
  test.each([0, 1, 2])("reserve at %s times construction interest has the sale key and exact wording", (factor) => {
    const figures = constructionFigures(fromOracle(oracle().inputs));
    const reserve = figures.interest * factor;
    const amount = "$" + Math.round(reserve).toLocaleString("en-US");
    expect(check(statedRun({ interestReserve: reserve }), "interest_reserve_before_completion")).toEqual({
      key: "interest_reserve_before_completion", kind: "agreement", severity: factor === 0 ? "warning" : "pass",
      expected: figures.interest, actual: reserve,
      message: factor === 0 ? "The budget states a $0 interest reserve; the model calculates $103,889 of interest during construction. The reserve looks underfunded by $103,889."
        : `The stated interest reserve of ${amount} covers the $103,889 of interest during construction the model calculates.`,
    });
    expect(check(statedRun({ interestReserve: reserve }), "interest_reserve")).toBeUndefined();
  });
  test("a sale still refuses the rental DSCR covenant", () => {
    expect(assemble([...rowsFor(), row("min_dscr_covenant", 1.2)]).readiness.impossible)
      .toEqual([{ fieldKey: "min_dscr_covenant", label: "Minimum DSCR covenant does not apply when the units are sold" }]);
  });
  test.each(["kestrel-row-townhomes", "alder-court-condo"])("%s keeps every metric and gate when stated figures agree", (slug) => {
    const figures = constructionFigures(fromOracle(oracle(slug).inputs));
    const base = statedRun({}, slug);
    const agreed = statedRun({ equity: figures.equity, totalCost: figures.totalCost, ltcPct: figures.loanToCost, interestReserve: figures.interest }, slug);
    expect(agreed.scenarios).toEqual(base.scenarios);
    expect(agreed.verdict.gates).toEqual(base.verdict.gates);
    expect(agreed.verdict.code).toBe(base.verdict.code);
    expect(agreed.checks.filter((c) => c.kind === "agreement").map((c) => [c.key, c.severity]))
      .toEqual([["sources_cover_uses", "pass"], ["stated_total_cost", "pass"], ["stated_ltc", "pass"], ["interest_reserve_before_completion", "pass"]]);
  });
  test("Alder's equity-shortfall message includes mezzanine interest above commitment in debt", () => {
    const input = fromOracle(oracle("alder-court-condo").inputs);
    const figures = constructionFigures(input);
    expect(figures.debt).toBeGreaterThan(input.senior.amount + input.mezzanine!.amount);
    const c = check(statedRun({ equity: 0 }, "alder-court-condo"), "sources_cover_uses")!;
    expect(c).toMatchObject({ severity: "error", expected: figures.equity });
    expect(c.message).toContain(`plus debt of $${Math.round(figures.debt).toLocaleString("en-US")}`);
  });
  test.each([false, true])("the populated rental/held fixture keeps its exact checks array: held=%s", (held) => {
    const input = checkFixture(held);
    expect(underwrite(input, policyFor(input)).checks).toEqual(held ? CHECK_PINS.held : CHECK_PINS.rental);
  });
});

describe("a deal that sells its units can have partners (task 84c)", () => {
  const split = { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 };
  const sha = (x: unknown) => createHash("sha256").update(canonicalJson(x)).digest("hex");
  const totals = (flows: { amount: number }[]) => ({
    contributed: -flows.filter((f) => f.amount < 0).reduce((n, f) => n + f.amount, 0),
    distributed: flows.filter((f) => f.amount > 0).reduce((n, f) => n + f.amount, 0),
  });
  test("Kestrel reads the three stated partner fields exactly as the rental path", () => {
    const { input, readiness } = assemble([...rowsFor(), row("lp_share_pct", 90), row("preferred_return_pct", 8), row("gp_promote_pct", 20)]);
    expect(readiness.status).toBe("ready");
    expect(input!.waterfall).toEqual(split);
  });
  test("unstated Kestrel retains its input hash and has no waterfall key", () => {
    const { input } = assemble(rowsFor());
    expect(input).not.toHaveProperty("waterfall");
    expect(sha(input)).toBe("6da97ac4e573322f49634e2a7bd90236f7ba07554f9e40ff452118009c13c1b2");
  });
  test.each(["kestrel-row-townhomes", "alder-court-condo"])("%s uses the same hand waterfall and conserves contributed and distributed cash", (slug) => {
    const input = { ...fromOracle(oracle(slug).inputs), waterfall: split };
    const result = underwrite(input, policyFor(input));
    const w = runWaterfall(result.equityFlows, split);
    const metric = (key: string) => result.scenarios[0]!.metrics.find((m) => m.key === key)!;
    expect(metric("lp_irr")).toMatchObject({ status: "VALID", value: irrRoots(w.lp)[0]! * 100 });
    expect(metric("gp_irr")).toMatchObject({ status: "VALID", value: irrRoots(w.gp)[0]! * 100 });
    expect(metric("gp_promote")).toMatchObject({ status: "VALID", value: w.promote });
    const lp = totals(w.lp), gp = totals(w.gp), deal = totals(result.equityFlows);
    expect(Math.abs(lp.contributed + gp.contributed - deal.contributed)).toBeLessThanOrEqual(1);
    expect(Math.abs(lp.distributed + gp.distributed - deal.distributed)).toBeLessThanOrEqual(1);
    for (const stress of policyFor(input).stresses) {
      const scenario = result.scenarios.find((s) => s.key === stress.key)!;
      expect(scenario.metrics.find((m) => m.key === "lp_irr")!.status).not.toBe("NOT_APPLICABLE");
    }
  });
  test("with no promote or preferred return partners match each other and every meaningful equity IRR", () => {
    const input = { ...fromOracle(oracle().inputs), waterfall: { ...split, preferredReturnPct: 0, gpPromotePct: 0 } };
    const result = underwrite(input, policyFor(input));
    expect(result.scenarios[0]!.metrics.find((m) => m.key === "equity_irr")!.status).toBe("VALID");
    for (const scenario of result.scenarios) {
      const metric = (key: string) => scenario.metrics.find((m) => m.key === key)!;
      expect(Math.abs(metric("lp_irr").value! - metric("gp_irr").value!)).toBeLessThanOrEqual(1e-9);
      if (metric("equity_irr").status === "VALID") {
        expect(Math.abs(metric("lp_irr").value! - metric("equity_irr").value!)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(metric("gp_irr").value! - metric("equity_irr").value!)).toBeLessThanOrEqual(1e-9);
      }
    }
  });
  test.each(["kestrel-row-townhomes", "alder-court-condo"] as const)("%s preserves its unstated result hash and every non-partner metric and gate", (slug) => {
    const input = fromOracle(oracle(slug).inputs);
    const base = underwrite(input, policyFor(input));
    expect(sha(base)).toBe({"kestrel-row-townhomes": "c134f47403e76744613c5afd7b3aca6860e7026021a8c4e2a3079091d1ddf60b", "alder-court-condo": "ddee2c68ac11fd646230ca70c21f8a8efda35f0914bc664a89118c4dff296df4"}[slug]);
    const result = underwrite({ ...input, waterfall: split }, policyFor(input));
    const rest = (r: typeof result) => r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => !["lp_irr", "gp_irr", "gp_promote"].includes(m.key)) }));
    expect(rest(result)).toEqual(rest(base));
    expect(result.verdict.gates).toEqual(base.verdict.gates);
  });
  test("an invalid sale LP share is refused with the unchanged rental message", () => {
    const waterfall = { ...split, lpSharePct: 101 };
    expect(() => validateInput({ ...fromOracle(oracle().inputs), waterfall })).toThrow("LP share must be above 0 and below 100");
    expect(() => validateInput({ ...developmentDeal(), waterfall })).toThrow("LP share must be above 0 and below 100");
  });
  test("no contributions gives the rental not-meaningful reason for all partner metrics", () => {
    const input: EngineInput = { ...fromOracle(oracle().inputs), waterfall: split, constructionMonths: 0,
      budget: { land: 0, hard: 0, soft: 0, contingency: 0, other: 0 }, senior: { amount: 0, ratePct: 0, ioMonths: 0 },
      forSale: { ...fromOracle(oracle().inputs).forSale!, carryMonthly: 0 } };
    const result = underwrite(input, policyFor(input));
    for (const key of ["lp_irr", "gp_irr", "gp_promote"]) expect(result.scenarios[0]!.metrics.find((m) => m.key === key))
      .toMatchObject({ status: "NOT_MEANINGFUL", value: null, reason: "Deal returns are not meaningful." });
  });
  test("partner flows with no single IRR say why, in the sale's wording", () => {
    const input = { ...fromOracle(oracle().inputs), waterfall: split };
    input.forSale = { ...input.forSale!, units: input.forSale!.units.map((u) => ({ ...u, price: 0 })) };
    const result = underwrite(input, policyFor(input));
    for (const [key, who] of [["lp_irr", "LP"], ["gp_irr", "GP"]]) {
      expect(result.scenarios[0]!.metrics.find((m) => m.key === key)).toMatchObject({ status: "NOT_MEANINGFUL", value: null,
        reason: `The ${who}'s dated cash flows have 0 sign changes and 0 IRR roots; exactly one of each is required.` });
    }
  });
  test("a partner IRR follows the sale's rule: one sign change and one root, as equity IRR does (audit)", () => {
    for (const slug of ["kestrel-row-townhomes", "alder-court-condo"]) {
      const result = underwrite({ ...fromOracle(oracle(slug).inputs), waterfall: split }, policyFor(fromOracle(oracle(slug).inputs)));
      for (const s of result.scenarios) {
        const get = (k: string) => s.metrics.find((m) => m.key === k)!;
        if (get("equity_irr").status === "NOT_MEANINGFUL") {
          for (const k of ["lp_irr", "gp_irr"]) {
            expect(get(k).status, `${slug} ${s.key} ${k}`).toBe("NOT_MEANINGFUL");
            expect(get(k).reason, `${slug} ${s.key} ${k}`).toMatch(/^The (LP|GP)'s dated cash flows have \d+ sign changes and \d+ IRR roots; exactly one of each is required\.$/);
          }
        }
      }
    }
    const kestrel = underwrite({ ...fromOracle(oracle("kestrel-row-townhomes").inputs), waterfall: split }, policyFor(fromOracle(oracle("kestrel-row-townhomes").inputs)));
    const absorption = kestrel.scenarios.find((s) => s.key === "absorption")!.metrics.find((m) => m.key === "lp_irr")!;
    expect(absorption.status).toBe("NOT_MEANINGFUL");
    expect(kestrel.scenarios[0]!.metrics.find((m) => m.key === "lp_irr")!.value).toBeCloseTo(33.94010121379986, 9);
  });
});
