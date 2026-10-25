import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DealOverview, Me, RunView } from "../src/api";
import { Compare } from "../src/routes/compare.tsx";
import { DealFrame, SessionGate } from "../src/components/ui.tsx";
import { type Lang } from "../src/i18n.tsx";

// Card X6: compare against a variant's runs, current or out of date in each option, and when the Compare button shows.
// Mocks follow apps/web/test/ui-audit-compare.test.ts.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, me: undefined as unknown, deals: undefined as unknown, runsOf: {} as Record<string, unknown>, byId: {} as Record<string, unknown>,
  realFrame: false, overview: {} as Record<string, unknown>, nodes: [] as { tag: string; props: Record<string, any> }[],
}));
const lookup = (queryKey: unknown[]) => {
  const [key, id] = queryKey as [string, string];
  if (key === "me") return { data: state.me, isLoading: false, error: null };
  if (key === "deals") return { data: state.deals };
  if (key === "runs") return { data: state.runsOf[id] };
  if (key === "run") return { data: state.byId[id] };
  return {};
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => lookup(options.queryKey),
  useQueries: (options: { queries: { queryKey: unknown[] }[] }) => options.queries.map((q) => lookup(q.queryKey)),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: (props: Parameters<typeof ui.DealFrame>[0]) => (state.realFrame ? createElement(ui.DealFrame, props) : createElement("header", null, "Deal header")),
    useDeal: () => ({ data: { deal: { id: "d1", name: "Tamarack Six" }, copiedFrom: null, ...state.overview } }),
    useSession: () => ({ solo: true, role: "owner", workspaceId: "ws" }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ children, to, params, className }: { children: unknown; to: string; params?: { dealId?: string }; className?: string }) =>
      createElement("a", { href: to.replace("$dealId", params?.dealId ?? ""), className }, children as string),
    useNavigate: () => () => {},
    useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/deals/d1/run" } }),
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["option", "optgroup", "select"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  state.nodes = [];
  return renderToStaticMarkup(el).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const metric = (key: string, value: number) => ({ key, label: key, unit: "$", value, status: "VALID", formula: "" });
const runView = (id: string, dealId: string, number: number, fresh: boolean, tax: number): RunView => ({
  id, dealId, number, createdAt: `2026-10-2${number}T12:00:00Z`, createdBy: "Morgan Owner", engineVersion: "2.3.0", policyVersion: "rental-v1", policyDraft: false,
  inputHash: "i", resultHash: "r", signed: "development key", fresh, staleReasons: fresh ? [] : ["An approved input changed after this run."], isLatest: true,
  result: {
    scenarios: [{ key: "base", label: "Base", metrics: [metric("stabilized_noi", 100_000 - tax)] }],
    verdict: { code: "APPROVE", headline: "", explanation: "", hardFailReasons: [], gates: [] },
    checks: [], annual: [], warnings: [],
  },
  inputs: [{ fieldKey: "property_tax", itemKey: null, label: "Property tax", value: tax, sourceKind: "document", source: "budget.pdf, page 2", sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null }],
  decisions: [],
});
const row = (r: RunView) => ({ id: r.id, run_number: r.number, verdict_code: "APPROVE", created_at: r.createdAt });

const overview = (id: string, name: string, run: number | null, copiedFrom: { id: string; name: string } | null = null): DealOverview => ({
  deal: { id, workspace_id: "w1", name, asset_type: "multifamily", location: "Edmonton", currency: "CAD", country: "CA", province: "AB", created_at: "2026-10-01" },
  copiedFrom, step: "run", status: { tone: "neutral", text: "" }, next: "",
  documents: { total: 3, processing: 0, failed: 0 }, updating: false,
  review: { approved: 9, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "ready" },
  run: run === null ? null : { id: `${id}-r${run}`, number: run, verdict: "APPROVE", fresh: true, createdAt: "2026-10-22" }, decision: null, reports: 0,
});

const mine = runView("r1", "d1", 1, false, 7200);
const theirs = runView("v1", "d2", 3, true, 8000);

beforeEach(() => {
  state.lang = "en";
  state.realFrame = false;
  state.overview = {};
  state.me = undefined;
  state.deals = [overview("d1", "Tamarack Six", 1), overview("d2", "60% refinance", 1, { id: "d1", name: "Tamarack Six" }), overview("d3", "Unrelated", 4)];
  state.runsOf = { d1: [row(mine)], d2: [row(theirs)], d3: [] };
  state.byId = { r1: mine, v1: theirs };
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

describe("comparing against a variant", () => {
  it("offers the variant's runs in their own group, named after the variant", () => {
    const t = text(render(createElement(Compare, { dealId: "d1" })));
    const groups = state.nodes.filter((n) => n.tag === "optgroup").map((n) => n.props.label as string);
    expect(groups.some((g) => g.includes("60% refinance"))).toBe(true);
    expect(groups.some((g) => g.includes("Unrelated"))).toBe(false);
    expect(t).toContain("Variant “60% refinance” · run 3 · ");
    const variantOption = state.nodes.find((n) => n.tag === "option" && n.props.value === "v1");
    expect(variantOption).toBeTruthy();
    // With one run here, the default compares it with the variant's run, and the column heads name each deal.
    expect(t).toContain("One input changed between these runs.");
    expect(t).toMatch(/Tamarack Six[^·]*· run 1/);
    expect(t).not.toContain("Comparing needs two runs");
  });

  it("offers the original's runs on a variant", () => {
    state.overview = { deal: { id: "d2", name: "60% refinance" }, copiedFrom: { id: "d1", name: "Tamarack Six" } };
    const t = text(render(createElement(Compare, { dealId: "d2" })));
    expect(t).toContain("Original “Tamarack Six” · run 1 · ");
  });

  it("says current or out of date in each option, and above the table", () => {
    const t = text(render(createElement(Compare, { dealId: "d1" })));
    const label = (id: string) => text(renderToStaticMarkup(createElement("b", null, state.nodes.find((n) => n.tag === "option" && n.props.value === id)!.props.children)));
    expect(label("r1")).toContain("out of date");
    expect(label("v1")).toContain("current");
    expect(label("v1")).not.toContain("out of date");
    expect(t).toMatch(/is out of date/);
  });

  it("shows no word until the run answers", () => {
    state.byId = { v1: theirs };
    render(createElement(Compare, { dealId: "d1" }));
    const option = state.nodes.find((n) => n.tag === "option" && n.props.value === "r1")!;
    const label = text(renderToStaticMarkup(createElement("b", null, option.props.children)));
    expect(label).not.toMatch(/current|out of date/);
  });

  it("still needs two runs when no variant has run", () => {
    state.runsOf = { d1: [row(mine)], d2: [] };
    expect(text(render(createElement(Compare, { dealId: "d1" })))).toContain("Comparing needs two runs");
  });
});

describe("the Compare button", () => {
  const me: Me = { user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace" }, workspaces: [{ id: "w1", name: "First", review_mode: "team", label_suggestions: false, has_logo: false, role: "owner" }] };
  const frame = (o: DealOverview) => {
    state.me = me;
    state.realFrame = true;
    return render(createElement(SessionGate, null, createElement(DealFrame, { o, active: "run" })));
  };

  it("shows for a deal with one run whose variant has one run", () => {
    expect(frame(overview("d1", "Tamarack Six", 1))).toContain(">Compare runs</a>");
  });

  it("shows on a variant with one run whose original has one run", () => {
    expect(frame(overview("d2", "60% refinance", 1, { id: "d1", name: "Tamarack Six" }))).toContain(">Compare runs</a>");
  });

  it("hides when neither has a second run", () => {
    state.deals = [overview("d1", "Tamarack Six", 1), overview("d2", "60% refinance", null, { id: "d1", name: "Tamarack Six" }), overview("d3", "Unrelated", 4)];
    expect(frame(overview("d1", "Tamarack Six", 1))).not.toContain("Compare runs");
  });

  it("stays out of the way while the deals load, unless this deal has two runs", () => {
    state.deals = undefined;
    expect(frame(overview("d1", "Tamarack Six", 1))).not.toContain("Compare runs");
    expect(frame(overview("d1", "Tamarack Six", 2))).toContain(">Compare runs</a>");
  });
});
