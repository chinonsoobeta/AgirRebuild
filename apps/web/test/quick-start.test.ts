/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { TEMPLATES } from "@agir/contracts";
import { assemble, type AssumptionRow } from "../../../packages/engine/src/index.ts";
import { QuickStart } from "../src/components/QuickStart.tsx";
import { build, type Lang } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ template: "multiplex", lang: "en", error: null as unknown,
  submit: undefined as undefined | ((e: { preventDefault: () => void; currentTarget: unknown }) => void), mutate: vi.fn() }));
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

const render = () => renderToStaticMarkup(createElement(QuickStart, { dealId: "condo" }));
const submitAnswers = (template: string, count: number, loan = 3_300_000) => {
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
  for (const [key, value] of Object.entries(values)) fd.set(key, String(value));
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
