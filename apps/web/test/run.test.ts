import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { allEquityDeal, developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import * as runScreen from "../src/routes/run.tsx";
import { Explore } from "../src/routes/explore.tsx";
import { build } from "../src/i18n.tsx";

const queryState = vi.hoisted(() => ({ run: undefined as unknown, options: [] as { queryKey: unknown[]; enabled?: boolean }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    queryState.options.push(options);
    return options.queryKey[0] === "run" ? { data: queryState.run } : {};
  },
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealHeader: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: { id: "sale-run", number: 1 }, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build("en", () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});

const saleInput: EngineInput = { ...allEquityDeal(), revenue: [], exit: "for_sale",
  forSale: { units: [{ key: "TH", label: "Townhome", units: 2, price: 800_000 }], presoldPct: 50, depositPct: 10,
    absorptionPerMonth: 1, commissionPct: 4, closingLagMonths: 0, carryMonthly: 100 } };
const sale = underwrite(saleInput, policyFor(saleInput));
const rentalInput = developmentDeal();
const rental = underwrite(rentalInput, policyFor(rentalInput));
const heldInput: EngineInput = { ...developmentDeal(), exit: "refinance_hold", refinance: { month: 36, amount: 29_000_000, ratePct: 5, amortYears: 30, ioMonths: 0 } };
const held = underwrite(heldInput, policyFor(heldInput));

describe("the run screen for a deal that sells its units (task 79)", () => {
  beforeEach(() => { queryState.options = []; queryState.run = undefined; });
  it("selects the sale layout before the held layout, even with stated_value present", () => {
    expect(sale.scenarios[0]!.metrics.some((m) => m.key === "stated_value")).toBe(true);
    expect(runScreen.layoutFor(sale.scenarios[0]!.metrics)).toEqual({ sale: true,
      headline: ["total_development_cost", "interest_before_completion", "gross_sales_revenue", "net_sales_revenue", "carry_total", "interest_after_completion",
        "development_profit_for_sale", "profit_on_cost_for_sale", "margin_on_revenue", "loan_to_cost", "required_equity", "peak_equity", "equity_multiple",
        "equity_irr", "deposits_held_at_completion", "completion_month", "sellout_month", "cost_per_unit"],
      stressKeys: ["profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple"],
    });
  });
  it("keeps the rental key figures and stress columns", () => {
    expect(runScreen.layoutFor(rental.scenarios[0]!.metrics)).toEqual({ sale: false,
      headline: ["total_development_cost", "capitalized_interest", "stabilized_noi", "yield_on_cost", "development_spread", "exit_value", "development_profit",
        "profit_on_cost", "loan_to_cost", "required_equity", "debt_yield", "sizing_dscr", "contractual_dscr", "equity_multiple", "equity_irr", "cost_per_unit"],
      stressKeys: ["sizing_dscr", "equity_multiple", "profit_on_cost"],
    });
  });
  it("keeps the held key figures and stress columns", () => {
    expect(runScreen.layoutFor(held.scenarios[0]!.metrics)).toEqual({ sale: false,
      headline: ["total_development_cost", "capitalized_interest", "stabilized_noi", "yield_on_cost", "development_spread", "refinance_cash_returned", "cash_left_in_deal",
        "dcr_after_refinance", "cash_on_cash_after_refinance", "stated_value", "unrealized_equity_multiple", "unrealized_equity_irr",
        "loan_to_cost", "required_equity", "debt_yield", "sizing_dscr", "contractual_dscr", "cost_per_unit"],
      stressKeys: ["sizing_dscr", "dcr_after_refinance", "unrealized_equity_multiple"],
    });
  });
  it.each([["sale", sale], ["rental", rental], ["held", held]] as const)("%s keeps the appropriate annual section and explore link", (mode, result) => {
    queryState.run = { id: "sale-run", number: 1, result, fresh: true, staleReasons: [], inputs: [],
      policyVersion: result.policyVersion, policyDraft: true, engineVersion: result.engineVersion,
      createdAt: "2026-10-18T00:00:00Z", createdBy: null, inputHash: "input-hash", resultHash: "result-hash", signed: "development key" };
    const html = renderToStaticMarkup(createElement(runScreen.Run, { dealId: mode }));
    const i = build("en", () => {});
    expect(html.includes(i.t("run.annual"))).toBe(mode !== "sale");
    expect(html.includes(`<a>${i.t("run.explore")}</a>`)).toBe(mode !== "sale");
    expect(html.includes("A deal that sells its units has no years of operations.")).toBe(mode === "sale");
  });
  it("a sale's explore route renders only its header and explanation and disables every sensitivity query", () => {
    queryState.run = { result: sale };
    const html = renderToStaticMarkup(createElement(Explore, { dealId: "sale" }));
    expect(html).toBe('<header>Deal header</header><p class="muted">Trying changes is not yet available for a deal that sells its units.</p>');
    const sensitivity = queryState.options.filter((q) => q.queryKey[0] !== "run");
    expect(sensitivity.map((q) => q.queryKey[0])).toEqual(["drivers", "explore", "tornado", "breakeven", "grid"]);
    expect(sensitivity.every((q) => q.enabled === false)).toBe(true);
  });
  it("does not start sensitivity requests before the run's mode is known", () => {
    renderToStaticMarkup(createElement(Explore, { dealId: "sale" }));
    expect(queryState.options.filter((q) => q.queryKey[0] !== "run").every((q) => q.enabled === false)).toBe(true);
  });
});
