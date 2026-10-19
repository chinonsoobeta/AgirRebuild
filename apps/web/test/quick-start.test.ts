/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { FIELD_BY_KEY, TEMPLATES } from "@agir/contracts";
import { assemble, type AssumptionRow } from "../../../packages/engine/src/index.ts";
import { QuickStart } from "../src/components/QuickStart.tsx";
import { build, type Lang } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ template: "multiplex", lang: "en", error: null as unknown,
  held: false, booleanIndex: 0, submit: undefined as undefined | ((e: { preventDefault: () => void; currentTarget: unknown }) => void), mutate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { assumptions: [] } }), useQueryClient: () => ({}), useMutation: () => ({ mutate: state.mutate }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: string }) => createElement("a", null, children) };
});
vi.mock("../src/i18n", async (original) => {
  const i = await original<typeof import("../src/i18n")>();
  return { ...i, useI18n: () => i.build(state.lang as Lang, () => {}) };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const [value, set] = react.useState(initial);
    if (initial === "multiplex") return [state.template, set];
    if (initial === false && state.booleanIndex++ === 0) return [state.held, set];
    if (initial === null) return [value, (error: unknown) => { state.error = error; }];
    return [value, set];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (args[0] === "form") state.submit = (args[1] as { onSubmit?: typeof state.submit }).onSubmit;
    return runtime.jsxDEV(...args);
  } };
});

const render = () => { state.booleanIndex = 0; return renderToStaticMarkup(createElement(QuickStart, { dealId: "condo" })); };
const submitAnswers = (template: string, count: number, loan = 3_300_000, extra: Record<string, number> = {}) => {
  state.template = template;
  render();
  // The same oracle answers used by the townhomes quick-start sale-readiness test.
  const d = JSON.parse(readFileSync(new URL("../../../oracles/for-sale/kestrel-row-townhomes.outcome.json", import.meta.url), "utf8")).inputs;
  const values: Record<string, string | number> = { reason: "Quick start answer", "name-0": "Condo",
    land_cost: d.land, hard_cost: d.hard, soft_cost: d.soft, contingency: d.contingency, development_charges: 0,
    construction_months: d.construction_months, "unit_count-0": count, "unit_sale_price-0": d.unit_types[0].price,
    presold_units_pct: d.presold_units_pct, deposit_pct: d.deposit_pct, absorption_units_per_month: d.absorption_units_per_month,
    sales_commission_pct: d.sales_commission_pct, closing_lag_months: d.closing_lag_months, unsold_carry_monthly: d.unsold_carry_monthly,
    senior_loan_amount: loan, senior_rate_pct: d.senior_rate_pct, senior_presale_threshold_pct: d.senior_presale_threshold_pct };
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...values, ...extra })) fd.set(key, String(value));
  vi.stubGlobal("FormData", function () { return fd; });
  state.submit!({ preventDefault: () => {}, currentTarget: {} });
};

describe("small condo quick start (task 84b)", () => {
  beforeEach(() => { state.template = "multiplex"; state.lang = "en"; state.error = null; state.submit = undefined; state.mutate.mockClear(); });
  afterEach(() => vi.unstubAllGlobals());
  it("lists the four templates in order with condo bounds", () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(["multiplex", "apartment", "townhomes", "condo"]);
    expect(TEMPLATES.find((t) => String(t.key) === "condo")).toMatchObject({ sells: true, minUnits: 4, maxUnits: 60, defaults: [] });
  });
  it("shares the unchanged townhomes questions and defaults", () => {
    const townhomes = TEMPLATES.find((t) => t.key === "townhomes")!;
    const condo = TEMPLATES.find((t) => String(t.key) === "condo")!;
    expect(condo.questions).toEqual(townhomes.questions);
    expect(condo.questions).toBe(townhomes.questions);
    expect(condo.defaults).toEqual(townhomes.defaults);
  });
  it.each(["en", "fr"] as const)("renders the condo option in %s", (lang) => {
    state.lang = lang;
    const label = lang === "en" ? "Small condo for sale (4–60 units)" : "Petit immeuble en copropriété à vendre (4 à 60 logements)";
    expect(render()).toContain('<option value="condo">' + label + "</option>");
  });
  it.each([3_300_000, 0])("four condo units assemble a ready sale with loan %s", (loan) => {
    submitAnswers("condo", 4, loan);
    expect(state.error).toBeNull();
    expect(state.mutate).toHaveBeenCalledOnce();
    const entries = state.mutate.mock.calls[0]![0].entries as { fieldKey: string; itemKey: string | null; value: number }[];
    const rows: AssumptionRow[] = entries.map((e) => ({ fieldKey: e.fieldKey, itemKey: e.itemKey, valueNumeric: e.value, status: "approved" }));
    const { input, readiness } = assemble(rows);
    expect(readiness.status).toBe("ready");
    expect(input).toMatchObject({ exit: "for_sale", revenue: [], forSale: { units: [{ units: 4 }] } });
  });
  it.each([["condo", 3, 4, 60], ["townhomes", 1, 2, 30]] as const)("%s refuses %s units through the existing bound check", (template, units, min, max) => {
    submitAnswers(template, units);
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).message).toBe(build("en", () => {}).t("qs.errUnits", { min, max }));
  });
});


describe("the quick start asks for the partner split (task 85c)", () => {
  const fields = ["lp_share_pct", "preferred_return_pct", "gp_promote_pct"];
  beforeEach(() => { state.template = "multiplex"; state.held = false; state.lang = "en"; state.error = null; state.submit = undefined; state.mutate.mockClear(); });
  afterEach(() => { state.held = false; vi.unstubAllGlobals(); });
  it.each(TEMPLATES.map((t) => t.key))("%s ends with the shared optional partner questions", (key) => {
    const questions = TEMPLATES.find((t) => t.key === key)!.questions.slice(-3);
    expect(questions).toEqual(fields.map((field) => ({ field, optional: true })));
    const shared = TEMPLATES[0]!.questions.slice(-3);
    questions.forEach((q, n) => expect(q).toBe(shared[n]));
  });
  it.each(TEMPLATES.map((t) => t.key))("%s shows partner questions for a sale exit", (key) => {
    state.template = key;
    const html = render();
    for (const field of fields) expect(html).toContain(`name="${field}"`);
    const positions = fields.map((field) => html.indexOf(`name="${field}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
  it("a kept multiplex shows the partner questions, in order, and lists none as hidden (task 87b)", () => {
    state.held = true;
    const html = render();
    for (const field of fields) expect(html).toContain(`name="${field}"`);
    const positions = fields.map((field) => html.indexOf(`name="${field}"`));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const field of fields) expect(html).not.toContain(`Not asked: ${build("en", () => {}).L.field(field)}`);
  });
  const submitKept = (extra: Record<string, number>) => {
    state.template = "multiplex";
    state.held = true;
    render();
    const values: Record<string, string | number> = { reason: "Quick start answer", accept: 1, refinance_and_hold: 1,
      land_cost: 400_000, hard_cost: 1_200_000, soft_cost: 150_000, contingency: 60_000, development_charges: 20_000, property_tax_annual: 9_000,
      construction_months: 12, lease_up_months: 3, unit_count: 4, unit_rent_monthly: 2_400, stabilized_occupancy_pct: 96, exit_cap_rate_pct: 5,
      senior_loan_amount: 1_200_000, senior_rate_pct: 6, senior_amort_years: 30, senior_io_months: 0,
      refinance_month: 24, refinance_amount: 1_300_000, refinance_rate_pct: 5, refinance_amort_years: 30 };
    const fd = new FormData();
    for (const [key, value] of Object.entries({ ...values, ...extra })) fd.set(key, String(value));
    vi.stubGlobal("FormData", function () { return fd; });
    state.submit!({ preventDefault: () => {}, currentTarget: {} });
  };
  it("a kept multiplex with all three answers reaches a ready held input with the split (task 87b)", () => {
    submitKept({ lp_share_pct: 90, preferred_return_pct: 8, gp_promote_pct: 20 });
    expect(state.error).toBeNull();
    expect(state.mutate).toHaveBeenCalledOnce();
    const entries = state.mutate.mock.calls[0]![0].entries as { fieldKey: string; itemKey: string | null; value: number }[];
    expect(entries.slice(-3)).toEqual(fields.map((fieldKey, n) => ({ fieldKey, itemKey: null, value: [90, 8, 20][n] })));
    const defaults = ["hold_years", "selling_costs_pct", "expense_ratio_pct"].map((fieldKey) => ({ fieldKey, itemKey: null, value: FIELD_BY_KEY.get(fieldKey)!.default! }));
    const { input, readiness } = assemble([...entries, ...defaults].map((e) => ({ fieldKey: e.fieldKey, itemKey: e.itemKey, valueNumeric: e.value, status: "approved" })));
    expect(readiness.status).toBe("ready");
    expect(input!.exit).toBe("refinance_hold");
    expect(input!.waterfall).toEqual({ lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 });
  });
  it.each(["en", "fr"] as const)("a kept multiplex with only the LP share refuses before sending in %s (task 87b)", (lang) => {
    state.lang = lang;
    submitKept({ lp_share_pct: 90 });
    expect(state.mutate).not.toHaveBeenCalled();
    expect((state.error as Error).message).toBe(lang === "en"
      ? "Enter the LP share, the preferred return and the promote together, or leave all three blank."
      : "Saisissez la part des commanditaires, le rendement privilégié et la prime ensemble, ou laissez les trois vides.");
  });
  it("all three condo answers reach a ready sale input", () => {
    submitAnswers("condo", 4, 3_300_000, { lp_share_pct: 90, preferred_return_pct: 8, gp_promote_pct: 20 });
    expect(state.error).toBeNull();
    expect(state.mutate).toHaveBeenCalledOnce();
    const entries = state.mutate.mock.calls[0]![0].entries as { fieldKey: string; itemKey: string | null; value: number }[];
    expect(entries.slice(-3)).toEqual(fields.map((fieldKey, n) => ({ fieldKey, itemKey: null, value: [90, 8, 20][n] })));
    const { input, readiness } = assemble(entries.map((e) => ({ fieldKey: e.fieldKey, itemKey: e.itemKey, valueNumeric: e.value, status: "approved" })));
    expect(readiness.status).toBe("ready");
    expect(input!.waterfall).toEqual({ lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 });
  });
  it.each(["en", "fr"] as const)("a partial split refuses before sending in %s", (lang) => {
    state.lang = lang;
    submitAnswers("condo", 4, 3_300_000, { lp_share_pct: 90 });
    expect(state.mutate).not.toHaveBeenCalled();
    expect(state.error).toBeInstanceOf(Error);
    expect((state.error as Error).message).toBe(lang === "en"
      ? "Enter the LP share, the preferred return and the promote together, or leave all three blank."
      : "Saisissez la part des commanditaires, le rendement privilégié et la prime ensemble, ou laissez les trois vides.");
  });
  it("blank partner answers preserve the exact 84b entries", () => {
    submitAnswers("condo", 4);
    expect(state.error).toBeNull();
    const d = JSON.parse(readFileSync(new URL("../../../oracles/for-sale/kestrel-row-townhomes.outcome.json", import.meta.url), "utf8")).inputs;
    const pairs: [string, number, string | null][] = [
      ["sell_units", 1, null], ["land_cost", d.land, null], ["hard_cost", d.hard, null], ["soft_cost", d.soft, null],
      ["contingency", d.contingency, null], ["development_charges", 0, null], ["construction_months", d.construction_months, null],
      ["unit_count", 4, "Condo"], ["unit_sale_price", d.unit_types[0].price, "Condo"],
      ["presold_units_pct", d.presold_units_pct, null], ["deposit_pct", d.deposit_pct, null],
      ["absorption_units_per_month", d.absorption_units_per_month, null], ["sales_commission_pct", d.sales_commission_pct, null],
      ["closing_lag_months", d.closing_lag_months, null], ["unsold_carry_monthly", d.unsold_carry_monthly, null],
      ["senior_loan_amount", 3_300_000, null], ["senior_rate_pct", d.senior_rate_pct, null], ["senior_presale_threshold_pct", d.senior_presale_threshold_pct, null],
    ];
    expect(state.mutate.mock.calls[0]![0].entries).toEqual(pairs.map(([fieldKey, value, itemKey]) => ({ fieldKey, itemKey, value })));
  });
});
