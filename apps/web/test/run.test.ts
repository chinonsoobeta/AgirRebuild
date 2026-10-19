/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { api, ApiError } from "../src/api";
import { Audit } from "../src/routes/audit";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { allEquityDeal, developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import * as runScreen from "../src/routes/run.tsx";
import * as exploreScreen from "../src/routes/explore.tsx";
import { Reports } from "../src/routes/reports.tsx";
import { Explore } from "../src/routes/explore.tsx";
import { build, type Lang } from "../src/i18n.tsx";

const queryState = vi.hoisted(() => ({ run: undefined as unknown, lang: "en" as Lang, role: "owner", options: [] as { queryKey: unknown[]; enabled?: boolean; queryFn?: () => Promise<unknown> }[],
  artifacts: [] as unknown[], links: [] as unknown[], events: [] as unknown[], shared: undefined as unknown, shareError: null as unknown,
  interactive: false, hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], secret: "", invalidate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean; queryFn?: () => Promise<unknown> }) => {
    queryState.options.push(options);
    const key = options.queryKey[0];
    return key === "run" ? { data: queryState.run } : key === "artifacts" ? { data: queryState.artifacts }
      : key === "share-links" ? { data: queryState.links } : key === "share" ? { data: queryState.shared, error: queryState.shareError }
      : key === "audit" ? { data: queryState.events } : {};
  },
  useMutation: (options: { mutationFn: (body: any) => Promise<any>; onSuccess?: (data: any) => unknown }) => ({
    mutate: async (body: unknown) => { const data = await options.mutationFn(body); await options.onSuccess?.(data); },
    isPending: false, reset: () => {},
  }),
  useQueryClient: () => ({ invalidateQueries: queryState.invalidate }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealHeader: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: { id: "sale-run", number: 1 }, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: queryState.role }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(queryState.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});

vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api,
    get: vi.fn(async () => queryState.shared),
    post: vi.fn(async (path: string) => path.endsWith("/revoke") ? { ok: true } : { id: "new-link", url: `/s/${queryState.secret}`, expiresAt: null }),
  } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const originalState = react.useState(initial);
    if (!queryState.interactive) return originalState;
    const n = queryState.index++;
    if (!(n in queryState.hooks)) queryState.hooks[n] = initial;
    return [queryState.hooks[n], (value: unknown) => { queryState.hooks[n] = value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (queryState.interactive && typeof args[0] === "string" && ["button", "select", "input", "a"].includes(args[0])) {
      queryState.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    }
    return runtime.jsxDEV(...args);
  } };
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
    expect(html.includes(`<a>${i.t("run.explore")}</a>`)).toBe(true);
    expect(html.includes("A deal that sells its units has no years of operations.")).toBe(mode === "sale");
  });
  it("a sale's explore route renders the screen and enables every sensitivity query", () => {
    queryState.run = { result: sale };
    const html = renderToStaticMarkup(createElement(Explore, { dealId: "sale" }));
    expect(html).toContain("Deal header");
    expect(html).toContain(build("en", () => {}).L.metric("profit_on_cost_for_sale"));
    expect(queryState.options.find((q) => q.queryKey[0] === "tornado")!.queryKey).toEqual(["tornado", "sale-run", "profit_on_cost_for_sale"]);
    expect(queryState.options.find((q) => q.queryKey[0] === "grid")!.queryKey).toEqual(["grid", "sale-run", { metric: "profit_on_cost_for_sale", x: "rateBps", y: "pricePct" }]);
    expect(queryState.options.find((q) => q.queryKey[0] === "drivers")!.queryKey).toEqual(["drivers", "sale-run"]);
    const sensitivity = queryState.options.filter((q) => q.queryKey[0] !== "run");
    expect(sensitivity.map((q) => q.queryKey[0])).toEqual(["drivers", "explore", "tornado", "breakeven", "grid"]);
    expect(sensitivity.every((q) => q.enabled === true)).toBe(true);
  });
  it("does not start sensitivity requests before the run's mode is known", () => {
    renderToStaticMarkup(createElement(Explore, { dealId: "sale" }));
    expect(queryState.options.filter((q) => q.queryKey[0] !== "run").every((q) => q.enabled === false)).toBe(true);
  });
});

describe("sale exploration layouts (task 82)", () => {
  it("selects the exact sale metrics and defaults", () => {
    expect(exploreScreen.exploreLayoutFor(true)).toEqual({
      compare: ["profit_on_cost_for_sale", "margin_on_revenue", "development_profit_for_sale", "equity_multiple", "equity_irr", "total_development_cost", "required_equity", "peak_equity", "loan_to_cost"],
      chartMetrics: ["profit_on_cost_for_sale", "margin_on_revenue", "development_profit_for_sale", "equity_multiple", "equity_irr"],
      tornadoMetric: "profit_on_cost_for_sale", grid: { metric: "profit_on_cost_for_sale", x: "rateBps", y: "pricePct" },
    });
  });
  it("keeps the rental metrics and defaults", () => {
    expect(exploreScreen.exploreLayoutFor(false)).toEqual({
      compare: ["yield_on_cost", "development_spread", "profit_on_cost", "equity_multiple", "equity_irr", "sizing_dscr", "contractual_dscr", "total_development_cost", "required_equity", "exit_value"],
      chartMetrics: ["equity_multiple", "equity_irr", "profit_on_cost", "sizing_dscr", "yield_on_cost", "development_spread", "development_profit"],
      tornadoMetric: "equity_multiple", grid: { metric: "sizing_dscr", x: "rateBps", y: "rentPct" },
    });
  });
});

describe("offering the partner memo (task 84d)", () => {
  it.each([
    ["sale with split", { ...saleInput, waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } }, true],
    ["rental sale with split", { ...rentalInput, waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } }, true],
    ["no split", rentalInput, false],
    ["held with split", { ...heldInput, waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } }, false],
  ] as const)("%s", (_name, input, offered) => {
    queryState.run = { result: underwrite(input, policyFor(input)) };
    const html = renderToStaticMarkup(createElement(Reports, { dealId: "partners" }));
    expect(html.includes("Partner memo")).toBe(offered);
  });
});


describe("the run screen shows the partners (task 85d)", () => {
  const split = { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 };
  const d = JSON.parse(readFileSync(new URL("../../../oracles/for-sale/kestrel-row-townhomes.outcome.json", import.meta.url), "utf8")).inputs;
  // Use the existing fromOracle shape; neutral rental-only values come from allEquityDeal.
  const kestrel: EngineInput = { ...allEquityDeal(),
    budget: { land: d.land, hard: d.hard, soft: d.soft, contingency: d.contingency, other: 0 },
    revenue: [], constructionMonths: d.construction_months, leaseUpMonths: 0, exit: "for_sale",
    senior: { amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 },
    forSale: { units: d.unit_types.map((u: { name: string; units: number; price: number }, n: number) => ({ key: String(n), label: u.name, units: u.units, price: u.price })),
      presoldPct: d.presold_units_pct, depositPct: d.deposit_pct, absorptionPerMonth: d.absorption_units_per_month,
      commissionPct: d.sales_commission_pct, closingLagMonths: d.closing_lag_months, carryMonthly: d.unsold_carry_monthly,
      presaleThresholdPct: d.senior_presale_threshold_pct },
  };
  const rentalWithSplit = underwrite({ ...rentalInput, waterfall: split }, policyFor(rentalInput));
  const saleWithSplit = underwrite({ ...kestrel, waterfall: split }, policyFor(kestrel));
  const saleWithoutSplit = underwrite(kestrel, policyFor(kestrel));
  const heldWithSplit = underwrite({ ...heldInput, waterfall: split }, policyFor(heldInput));
  const partners = ["lp_irr", "gp_irr", "gp_promote"];
  beforeEach(() => { queryState.lang = "en"; queryState.options = []; queryState.run = undefined; });
  it.each([
    ["rental split", rentalWithSplit, rental, true], ["sale split", saleWithSplit, saleWithoutSplit, true],
    ["rental no split", rental, rental, false], ["sale no split", saleWithoutSplit, saleWithoutSplit, false],
    ["held", heldWithSplit, held, false],
  ] as const)("%s has the prescribed headline list and unchanged stress columns", (_name, result, plain, hasPartners) => {
    const before = runScreen.layoutFor(plain.scenarios[0]!.metrics);
    const expected = before.headline.flatMap((key) => hasPartners && key === "equity_irr" ? [key, ...partners] : [key]);
    expect(runScreen.layoutFor(result.scenarios[0]!.metrics)).toEqual({ ...before, headline: expected });
  });
  it.each([true, false])("the sale screen renders partner labels and values only with split=%s", (withSplit) => {
    const result = withSplit ? saleWithSplit : saleWithoutSplit;
    queryState.run = { id: "sale-run", number: 1, result, fresh: true, staleReasons: [], inputs: [],
      policyVersion: result.policyVersion, policyDraft: true, engineVersion: result.engineVersion,
      createdAt: "2026-10-19T00:00:00Z", createdBy: null, inputHash: "input-hash", resultHash: "result-hash", signed: "development key" };
    const html = renderToStaticMarkup(createElement(runScreen.Run, { dealId: "partners" }));
    const i = build("en", () => {});
    for (const key of partners) {
      expect(html.includes(i.L.metric(key))).toBe(withSplit);
      if (withSplit) {
        const metric = result.scenarios[0]!.metrics.find((m) => m.key === key)!;
        expect(html).toContain(i.f.value(metric.value, metric.unit));
      }
    }
  });
  it("the French sale screen uses the existing French partner labels, formulas and values", () => {
    queryState.lang = "fr";
    const result = saleWithSplit;
    queryState.run = { id: "sale-run", number: 1, result, fresh: true, staleReasons: [], inputs: [],
      policyVersion: result.policyVersion, policyDraft: true, engineVersion: result.engineVersion,
      createdAt: "2026-10-19T00:00:00Z", createdBy: null, inputHash: "input-hash", resultHash: "result-hash", signed: "development key" };
    const text = renderToStaticMarkup(createElement(runScreen.Run, { dealId: "partners" })).replace(/<[^>]*>/g, " ");
    const fr = build("fr", () => {}), en = build("en", () => {});
    for (const key of partners) {
      expect(text).toContain(fr.L.metric(key));
      expect(fr.L.formula(key).length).toBeGreaterThan(10);
      expect(fr.L.formula(key)).not.toBe(en.L.formula(key));
      const metric = result.scenarios[0]!.metrics.find((m) => m.key === key)!;
      expect(text).toContain(fr.f.value(metric.value, metric.unit));
    }
    expect(text).not.toMatch(/\b(LP|GP|IRR|promote|waterfall|equity|yield|debt|loan|rent|cash|gate|stated)\b/i);
    queryState.lang = "en";
  });
});


describe("share links on the web (task 86b)", () => {
  const artifact = (id: string, status: string) => ({ id, kind: "ic_memo", format: "pdf", status, error: null, sha256: null,
    created_at: "2026-10-19T12:00:00Z", run_id: "run", run_number: 1, provenance_entries: null });
  const link = (id: string, expires_at: string | null, revoked_at: string | null = null) => ({ id, artifact_id: "ready", kind: "ic_memo", format: "pdf",
    run_number: 1, term: expires_at ? "7d" : "none", expires_at, created_at: "2026-10-19T12:00:00Z", created_by: "Alice Analyst",
    revoked_at, revoked_by: revoked_at ? "Bob Approver" : null, openings: 3, last_opened_at: "2026-10-19T13:00:00Z" });
  const render = (element: Parameters<typeof renderToStaticMarkup>[0] = createElement(Reports, { dealId: "links" })) => {
    queryState.index = 0; queryState.nodes = [];
    return renderToStaticMarkup(element).replaceAll(queryState.secret, "[redacted]");
  };
  const button = (label: string) => queryState.nodes.find((n) => n.tag === "button" && n.props.children === label)!;
  const sharePage = async () => {
    const { Share } = await vi.importActual<{ Share: (p: { secret: string }) => ReturnType<typeof createElement> }>("../src/routes/share.tsx");
    return render(createElement(Share, { secret: queryState.secret }));
  };
  beforeEach(() => {
    queryState.interactive = true; queryState.hooks = []; queryState.lang = "en"; queryState.role = "owner";
    queryState.artifacts = [artifact("ready", "ready"), artifact("queued", "queued"), artifact("failed", "failed")];
    queryState.links = []; queryState.events = []; queryState.options = []; queryState.shareError = null;
    queryState.shared = { deal: "Shared reference", kind: "ic_memo", format: "pdf", runNumber: 7, expiresAt: "2099-10-19T12:00:00Z" };
    queryState.secret = randomBytes(32).toString("base64url");
    vi.clearAllMocks();
    vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  });
  afterEach(() => { queryState.interactive = false; queryState.artifacts = []; queryState.links = []; queryState.lang = "en"; vi.unstubAllGlobals(); });
  it.each(["owner", "analyst", "viewer"])("%s can share only the ready report", (role) => {
    queryState.role = role; render();
    const buttons = queryState.nodes.filter((n) => n.tag === "button" && n.props.children === "Share");
    expect(buttons.length).toBe(1);
    expect(Boolean(buttons[0]!.props.disabled)).toBe(false);
  });
  it("offers four terms, makes a link and shows its once-only copy field after success", async () => {
    render(); await button("Share").props.onClick();
    const choices = render();
    for (const term of ["24 hours", "7 days", "30 days", "No expiry"]) expect(choices).toContain(term);
    queryState.nodes.find((n) => n.tag === "select")!.props.onChange({ target: { value: "24h" } });
    render(); await button("Make link").props.onClick();
    const made = render();
    expect(made).toContain("Copy this link now. It is not shown again.");
    const input = queryState.nodes.find((n) => n.tag === "input" && n.props.readOnly)!;
    expect(Boolean(input)).toBe(true);
    expect(input.props.value === `https://agir.test/s/${queryState.secret}`).toBe(true);
    expect(vi.mocked(api.post).mock.calls.some(([path, body]) => path === "/artifacts/ready/share-links" && (body as { term: string }).term === "24h")).toBe(true);
    await button("Copy").props.onClick();
    const copy = vi.mocked(navigator.clipboard.writeText);
    expect(copy.mock.calls.length).toBe(1);
    expect(copy.mock.calls[0]![0] === input.props.value).toBe(true);
    expect(queryState.invalidate.mock.calls.length).toBeGreaterThan(0);
  });
  it("renders active, expired and revoked links and revokes only active rows after confirmation", async () => {
    queryState.links = [link("active", null), link("expired", "2000-01-01T00:00:00Z"), link("revoked", "2099-01-01T00:00:00Z", "2026-10-19T12:00:00Z")];
    const html = render();
    for (const text of ["Shared links", "Report", "Made by", "Made on", "Expires", "Openings", "Last opened", "Status", "Active", "Expired", "Revoked", "No expiry"]) expect(html).toContain(text);
    expect(queryState.nodes.filter((n) => n.tag === "button" && n.props.children === "Revoke").length).toBe(1);
    await button("Revoke").props.onClick();
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe("Revoke this link? Anyone holding it will no longer be able to open it.");
    expect(vi.mocked(api.post).mock.calls.some(([path]) => path === "/share-links/active/revoke")).toBe(true);
    expect(queryState.invalidate.mock.calls.length).toBeGreaterThan(0);
  });
  it("hides the Shared links table when there are no links", () => { expect(render()).not.toContain("Shared links"); });
  it.each(["pdf", "docx"])("the public %s page has its metadata, downloads and appropriate Open button, without requesting me", async (format) => {
    queryState.shared = { ...queryState.shared as object, format };
    const html = await sharePage();
    for (const text of ["Shared reference", "IC memo", "Run 7", "This link expires on", "Download", "Download the audit package", "Shared from Agir. Read-only."]) expect(html).toContain(text);
    expect(html).not.toMatch(/m\.\./); // the date's "a.m." / "p.m." ends the sentence once
    expect(queryState.nodes.some((n) => n.tag === "a" && n.props.children === "Open")).toBe(format === "pdf");
    const fileLinks = queryState.nodes.filter((n) => n.tag === "a" && String(n.props.href).includes("/file"));
    expect(fileLinks.length).toBe(format === "pdf" ? 2 : 1);
    expect(queryState.nodes.some((n) => n.tag === "a" && String(n.props.href).endsWith("/audit-package"))).toBe(true);
    const query = queryState.options.find((q) => q.queryKey[0] === "share")!;
    await query.queryFn!();
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path === "/me")).toBe(false);
    expect(queryState.options.some((q) => q.queryKey[0] === "me")).toBe(false);
  });
  it("the public page prints no expiry when appropriate", async () => {
    queryState.shared = { ...queryState.shared as object, expiresAt: null };
    expect(await sharePage()).toContain("This link does not expire.");
  });
  it("a public 404 shows only the API sentence", async () => {
    queryState.shared = undefined;
    queryState.shareError = new ApiError(404, "This link is not available. It may have expired or been revoked.");
    const text = (await sharePage()).replace(/<[^>]*>/g, "").trim();
    expect(text).toBe("This link is not available. It may have expired or been revoked.");
  });
  it.each(["en", "fr"] as const)("an anonymous opening uses the link-holder actor label in %s", (lang) => {
    queryState.lang = lang;
    queryState.events = [{ seq: 1, action: "share.opened", actor: null, entity: "share_link", entity_id: "link-id", payload: { what: "page" }, hash: "a".repeat(64), created_at: "2026-10-19T12:00:00Z" }];
    const html = render(createElement(Audit, { dealId: "links" }));
    expect(html).toContain(lang === "en" ? "Someone with the link" : "Une personne ayant le lien");
    expect(html).not.toContain(build(lang, () => {}).t("audit.worker"));
  });
});
