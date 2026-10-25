/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import * as runScreen from "../src/routes/run.tsx";
import { build } from "../src/i18n.tsx";

type Row = { id: string; run_number: number; verdict_code: string; created_at: string; created_by: string };
const state = vi.hoisted(() => ({ runs: [] as Row[], byId: {} as Record<string, unknown>, review: undefined as unknown,
  pending: false, submittedAt: 0, hasRun: true }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const [key, id] = options.queryKey;
    return key === "run" ? { data: state.byId[id as string] } : key === "runs" ? { data: state.runs } : key === "review" ? { data: state.review } : {};
  },
  useMutation: () => ({ mutate: () => {}, isPending: state.pending, error: null, reset: () => {}, submittedAt: state.submittedAt }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: state.hasRun ? { id: "run-2", number: 2 } : null, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: "owner", me: { user: { id: "u", email: "u@example.test", name: "Invented starter" }, workspaces: [] } }),
  };
});
vi.mock("../src/components/thresholds", async (original) => {
  const real = await original<typeof import("../src/components/thresholds")>();
  const { createElement } = await import("react");
  return { ...real, Thresholds: () => createElement("div", null, "Thresholds editor marker") };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build("en", () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, to, hash }: { children: unknown; to?: string; hash?: string }) => createElement("a", { "data-to": to, "data-hash": hash }, children as string) };
});

const en = build("en", () => {});
const heldInput: EngineInput = { ...developmentDeal(), exit: "refinance_hold", refinance: { month: 36, amount: 29_000_000, ratePct: 5, amortYears: 30, ioMonths: 0 } };
const held = underwrite(heldInput, policyFor(heldInput));
const rentalInput = developmentDeal();
const rental = underwrite(rentalInput, policyFor(rentalInput));
const input = (fieldKey: string, value: number, itemKey: string | null = null) => ({ fieldKey, itemKey, label: fieldKey, value, sourceKind: "document", source: "Invented source",
  sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null });
const heldInputs = [input("exit_cap_rate_pct", 5.5), input("stabilized_occupancy_pct", 97), input("hold_years", 10), input("property_tax_annual", 7200)];
const view = (id: string, number: number, result: unknown, extra: object = {}) => ({ id, number, result, fresh: true, staleReasons: [], inputs: heldInputs, isLatest: number === 2,
  policyVersion: "invented-policy", policyDraft: true, engineVersion: "invented-engine", createdAt: "2026-10-24T15:58:00Z", createdBy: "Invented author",
  inputHash: "a".repeat(64), resultHash: "b".repeat(64), signed: "development key", decisions: [], ...extra });
const assumption = (fieldKey: string, value: number, unit: string, itemKey: string | null = null) => ({ id: `${fieldKey}-${itemKey}`, fieldKey, itemKey, label: fieldKey, unit,
  status: "approved", value });
const render = (props: { run?: string } = {}) => renderToStaticMarkup(createElement(runScreen.Run, { dealId: "deal", ...props }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const figures = (html: string) => text(html.slice(html.indexOf('<dl class="figs">'), html.indexOf("</dl>", html.indexOf('<dl class="figs">'))));
const withMetric = (result: typeof held, key: string, patch: object) => ({ ...result, scenarios: result.scenarios.map((s, n) => n > 0 ? s
  : { ...s, metrics: s.metrics.map((m) => m.key === key ? { ...m, ...patch } : m) }) });

describe("the run screen with figures in context, history status and a run in the address (card X3)", () => {
  beforeEach(() => {
    state.pending = false; state.submittedAt = 0; state.hasRun = true; state.review = undefined;
    state.runs = [{ id: "run-2", run_number: 2, verdict_code: "APPROVE", created_at: "2026-10-24T15:58:00Z", created_by: "Invented author" },
      { id: "run-1", run_number: 1, verdict_code: "APPROVE", created_at: "2026-10-22T10:00:00Z", created_by: "Invented author" }];
    state.byId = { "run-2": view("run-2", 2, held),
      "run-1": view("run-1", 1, held, { fresh: false, staleReasons: ["An approved input changed after this run."] }) };
  });

  it("gives a held run's key figures their context lines, in the board's order", () => {
    const html = render();
    const words = figures(html);
    const metric = (k: string) => held.scenarios[0]!.metrics.find((m) => m.key === k)!;
    expect(words).toContain(`${en.f.value(metric("cost_per_unit").value, "$")} a unit`);
    expect(words).toContain(`Loan to cost ${en.f.value(metric("loan_to_cost").value, "%")}`);
    expect(words).toContain(`from ${en.f.value(metric("effective_gross_income").value, "$")} of income`);
    expect(words).toContain(`against a ${en.f.value(5.5, "%")} cap rate`);
    expect(words).toContain(`${en.f.value(metric("cash_left_in_deal").value, "$")} stays in the deal`);
    expect(words).toContain(`${en.f.value(metric("cash_on_cash_year1").value, "%")} in year 1, before the refinance`);
    expect(words).toContain(`underwritten at ${en.f.value(97, "%")}`);
    expect(words).toContain("Not a sale: the value is stated, not realized");
    expect(words).toContain("a year, over the 10-year hold");
    const lead = ["total_development_cost", "required_equity", "stabilized_noi", "yield_on_cost", "development_spread", "dcr_after_refinance",
      "refinance_cash_returned", "cash_on_cash_after_refinance", "break_even_occupancy", "unrealized_equity_multiple", "unrealized_equity_irr"];
    const at = lead.map((k) => words.indexOf(en.L.metric(k)));
    expect(at.every((p, n) => p >= 0 && (n === 0 || p > at[n - 1]!))).toBe(true);
    // Nothing that showed before disappears.
    for (const k of runScreen.layoutFor(held.scenarios[0]!.metrics).headline) expect(words).toContain(en.L.metric(k));
  });

  it("leaves a sub-line out when its value is not valid or its input is absent, never showing 0", () => {
    state.byId["run-2"] = view("run-2", 2, withMetric(withMetric(held, "cost_per_unit", { status: "NOT_MEANINGFUL", value: null }), "cash_left_in_deal",
      { status: "NOT_APPLICABLE", value: null }), { inputs: [] });
    const words = figures(render());
    expect(words).not.toContain("a unit");
    expect(words).not.toContain("stays in the deal");
    expect(words).not.toContain("cap rate");
    expect(words).not.toContain("underwritten at");
    expect(words).not.toContain("-year hold");
    expect(words).not.toMatch(/\$0 /);
  });

  it("shows income, cost and spread first in the stress table", () => {
    const html = render();
    const start = html.indexOf(en.t("run.underStress"));
    const table = html.slice(start, html.indexOf("</thead>", start));
    const cols = [...table.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(cols.slice(1, 4)).toEqual([en.L.metric("stabilized_noi"), en.L.metric("total_development_cost"), en.L.metric("development_spread")]);
    for (const k of runScreen.layoutFor(held.scenarios[0]!.metrics).stressKeys) expect(cols).toContain(en.L.metric(k));
    expect(html).toContain('class="card scroll run-stress"');
  });

  it("keeps the rental stress columns after income, cost and spread", () => {
    state.byId["run-2"] = view("run-2", 2, rental);
    const html = render();
    const start = html.indexOf(en.t("run.underStress"));
    const cols = [...html.slice(start, html.indexOf("</thead>", start)).matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(cols.slice(1)).toEqual(["stabilized_noi", "total_development_cost", "development_spread", "sizing_dscr", "equity_multiple", "profit_on_cost"].map((k) => en.L.metric(k)));
  });

  it("sends the thresholds to Review instead of editing them on Run", () => {
    const html = render();
    expect(html).not.toContain("Thresholds editor marker");
    expect(text(html)).toContain(en.t("run.thresholdsLine"));
    expect(html).toMatch(new RegExp(`<a data-to="/deals/\\$dealId/review" data-hash="thresholds">${en.t("run.thresholdsLink")}</a>`));
  });

  it("gives every run in the history its status, and says why an older run is out of date", () => {
    const html = render();
    const history = text(html.slice(html.indexOf('class="table run-history"')));
    expect(history).toContain(en.t("run.historyCol.status"));
    expect(history).toContain(en.t("run.historyCurrent"));
    expect(history).toContain(en.t("run.staleLine", { reasons: en.t("run.stale.inputs") }));
  });

  it("asks each run's own status only for the ten newest runs", () => {
    state.runs = Array.from({ length: 12 }, (_, n) => ({ id: n === 0 ? "run-2" : `old-${n}`, run_number: 12 - n, verdict_code: "APPROVE", created_at: "2026-10-01T00:00:00Z", created_by: "x" }));
    const history = text(render());
    expect(history.split(en.t("run.historyOpen")).length - 1).toBe(2);
  });

  it("names the approved inputs that changed after the shown run, with both values", () => {
    state.review = { assumptions: [assumption("exit_cap_rate_pct", 5.5, "%"), assumption("stabilized_occupancy_pct", 97, "%"), assumption("hold_years", 10, "years"),
      assumption("property_tax_annual", 8000, "$"), { ...assumption("land_transfer_tax", 1, "$"), status: "needs_review" }] };
    const words = text(render({ run: "run-1" }));
    expect(words).toContain(en.t("run.outOfDate", { n: 1 }));
    expect(words).toContain(en.t("run.changed.value", { label: en.L.field("property_tax_annual", null), now: "$8,000", was: "$7,200" }));
    expect(en.t("run.changed.value", { label: "Property tax", now: "$8,000", was: "$7,200" })).toBe("Property tax was approved at $8,000 after this run, replacing $7,200.");
    // French avoids agreeing a participle with a label of either gender.
    const frT = build("fr", () => {}).t;
    expect(frT("run.changed.value", { label: "Durée de détention", now: "7 ans", was: "5 ans" })).toBe("Durée de détention a reçu la valeur 7 ans après cette analyse, au lieu de 5 ans.");
    expect(frT("run.changed.added", { label: "Taxe foncière", now: "8 000 $" })).toBe("Taxe foncière a reçu la valeur 8 000 $ après cette analyse, qui ne l'utilisait pas.");
    expect(frT("run.changed.removed", { label: "Taxe foncière", was: "8 000 $" })).toBe("Taxe foncière n'a plus de valeur approuvée\u00a0; cette analyse utilisait 8 000 $.");
    expect(words).not.toContain(en.L.field("land_transfer_tax", null));
  });

  it("names inputs approved or withdrawn since the run, five at most", () => {
    state.review = { assumptions: [assumption("property_tax_annual", 8000, "$"), assumption("land_transfer_tax", 1000, "$"), assumption("exit_cap_rate_pct", 6, "%"),
      assumption("stabilized_occupancy_pct", 95, "%"), assumption("hold_years", 7, "years"), assumption("expense_ratio_pct", 30, "%")] };
    const words = text(render({ run: "run-1" }));
    expect(words).toContain(en.t("run.changed.added", { label: en.L.field("land_transfer_tax", null), now: "$1,000" }));
    expect(words).toContain(en.t("run.changed.more", { n: 1 }));
    state.review = { assumptions: [assumption("exit_cap_rate_pct", 5.5, "%"), assumption("stabilized_occupancy_pct", 97, "%"), assumption("hold_years", 10, "years")] };
    expect(text(render({ run: "run-1" }))).toContain(en.t("run.changed.removed", { label: en.L.field("property_tax_annual", null), was: "$7,200" }));
  });

  it("says when the run started and who started it while it is in progress", () => {
    state.pending = true; state.submittedAt = Date.parse("2026-10-24T15:58:00Z");
    const words = text(render());
    expect(words).toContain("Invented starter");
    expect(words).toMatch(/Started \d{1,2}:\d{2}.* by Invented starter/);
  });

  it("starts with the run named in the address selected", () => {
    const html = render({ run: "run-1" });
    expect(text(html)).toContain(en.t("run.verdictLine", { n: 1, policy: "invented-policy", draft: true }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>Run 1</);
  });
});
