import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuditEvent, RunView } from "../src/api";
import { Audit, categoryOf } from "../src/routes/audit.tsx";
import { Compare, diffRuns, compareSummary } from "../src/routes/compare.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card W11: the audit trail and the comparison of two runs. Mocks follow apps/web/test/ui-settings.test.ts:
// hooks are replaced so a render can be clicked and re-rendered.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, events: [] as unknown[], verify: undefined as unknown, runs: [] as unknown[], byId: {} as Record<string, unknown>,
  refetch: vi.fn(), hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
  overview: { run: { id: "r2", number: 2 } } as Record<string, unknown>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const [key, id] = options.queryKey as [string, string];
    if (key === "audit") return { data: state.events };
    if (key === "audit-verify") return { data: state.verify, refetch: state.refetch, isFetching: false };
    if (key === "runs") return { data: state.runs };
    if (key === "run") return { data: state.byId[id] };
    return {};
  },
  useQueries: (options: { queries: unknown[] }) => options.queries.map(() => ({})),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { deal: { id: "d1", name: "Test deal" }, ...state.overview } }),
    useSession: () => ({ solo: true, role: "owner", workspaceId: "ws" }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, to, params, search, className }: { children: unknown; to: string; params?: { dealId?: string }; search?: Record<string, string>; className?: string }) =>
    createElement("a", { href: `${to.replace("$dealId", params?.dealId ?? "")}${search ? `?${new URLSearchParams(search)}` : ""}`, className }, children as string) };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = typeof value === "function" ? (value as (v: unknown) => unknown)(state.hooks[n]) : value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "input", "a", "select"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  state.index = 0;
  state.nodes = [];
  return renderToStaticMarkup(el).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const button = (label: string) => state.nodes.find((n) => n.tag === "button" && text(renderToStaticMarkup(createElement("b", null, n.props.children))).trim() === label);

const event = (seq: number, action: string, payload: Record<string, unknown> = {}): AuditEvent =>
  ({ seq, action, entity: "x", entity_id: null, payload, hash: `${seq.toString(16).padStart(4, "0")}abcdef0123456789`, created_at: "2026-10-20T12:00:00Z", actor: "Morgan Owner" });

beforeEach(() => {
  state.lang = "en";
  state.hooks = [];
  state.events = [];
  state.verify = undefined;
  state.overview = { run: { id: "r2", number: 2 } };
  state.refetch.mockClear();
});

describe("the audit trail", () => {
  it("tags the chain from the verify result and says exactly what was checked", () => {
    state.verify = { ok: true, events: 212, broken_at: null };
    const html = render(createElement(Audit, { dealId: "d1" }));
    expect(html).toContain('class="tag pass"');
    expect(text(html)).toContain("Chain intact · 212 events");
    expect(text(html)).toMatch(/every workspace/);
    button("Verify the chain again")!.props.onClick();
    expect(state.refetch).toHaveBeenCalled();
  });

  it("tags a broken chain with the event where it broke, in both languages", () => {
    state.verify = { ok: false, events: 40, broken_at: 40 };
    expect(text(render(createElement(Audit, { dealId: "d1" })))).toContain("Chain broken at event 40");
    state.lang = "fr";
    state.hooks = [];
    expect(text(render(createElement(Audit, { dealId: "d1" })))).toContain("Chaîne rompue à l'événement 40");
  });

  it("maps actions to categories, leaving unknown ones under Everything only", () => {
    expect(categoryOf("assumption.approve")).toBe("values");
    expect(categoryOf("document.uploaded")).toBe("documents");
    expect(categoryOf("run.completed")).toBe("runs");
    expect(categoryOf("artifact.ready")).toBe("reports");
    expect(categoryOf("decision.recorded")).toBe("reports");
    expect(categoryOf("share.opened")).toBe("sharing");
    expect(categoryOf("something.new")).toBeNull();
  });

  it("filters by chip", () => {
    state.events = [event(3, "run.completed", { run_number: 1, verdict: "APPROVE" }), event(2, "document.uploaded", { name: "budget.pdf" }), event(1, "deal.created")];
    let html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Uploaded budget.pdf");
    expect(html).toContain("Created the deal");
    button("Documents")!.props.onClick();
    html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Uploaded budget.pdf");
    expect(html).not.toContain("Ran underwriting");
    expect(html).not.toContain("Created the deal");
    expect(state.nodes.find((n) => n.tag === "button" && n.props["aria-pressed"] === true)).toBeTruthy();
  });

  it("shows the newest 50, then older events from what was loaded", () => {
    state.events = Array.from({ length: 120 }, (_, k) => event(120 - k, "deal.created"));
    let html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Showing the latest 50 of 120 events loaded");
    expect(html).not.toContain("212");
    button("Show older events")!.props.onClick();
    html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Showing the latest 100 of 120 events loaded");
    state.events = state.events.slice(0, 50);
    state.hooks = [];
    render(createElement(Audit, { dealId: "d1" }));
    expect(button("Show older events")).toBeUndefined();
  });

  it("offers the audit package of the current run only when there is one", () => {
    render(createElement(Audit, { dealId: "d1" }));
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/api/runs/r2/audit-package")).toBe(true);
    state.overview = { run: null };
    render(createElement(Audit, { dealId: "d1" }));
    expect(state.nodes.some((n) => n.tag === "a" && String(n.props.href).endsWith("/audit-package"))).toBe(false);
  });
});

const metric = (key: string, value: number, unit = "$") => ({ key, label: key, unit, value, status: "VALID", formula: "" });
const runView = (id: string, number: number, tax: number, noi: number): RunView => ({
  id, dealId: "d1", number, createdAt: `2026-10-2${number}T12:00:00Z`, createdBy: "Morgan Owner", engineVersion: "2.3.0", policyVersion: "rental-v1", policyDraft: false,
  inputHash: "i", resultHash: "r", signed: "development key", fresh: number === 2, staleReasons: [], isLatest: number === 2,
  result: {
    scenarios: [{ key: "base", label: "Base", metrics: [metric("stabilized_noi", noi), metric("total_development_cost", 1_667_571)] }],
    verdict: { code: "APPROVE", headline: "", explanation: "", hardFailReasons: [], gates: [{ key: "g", label: "g", scenario: "base", metricKey: "x", threshold: 1, unit: "x", actual: 2, status: "passed" }] },
    checks: [{ key: "c", kind: "k", severity: "pass", message: "" }], annual: [], warnings: [],
  },
  inputs: [
    { fieldKey: "property_tax", itemKey: null, label: "Property tax", value: tax, sourceKind: "document", source: number === 2 ? "assessment notice 2026.pdf, page 1" : "budget.pdf, page 2", sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null },
    { fieldKey: "hard_cost", itemKey: null, label: "Hard cost", value: 1_100_000, sourceKind: "document", source: "budget.pdf, page 1", sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null },
  ],
  decisions: [],
});

describe("comparing two runs", () => {
  const one = runView("r1", 1, 7200, 115_020);
  const two = runView("r2", 2, 8000, 114_220);

  it("diffs the inputs, the base metrics, the gates and the checks", () => {
    const d = diffRuns(two, one);
    expect(d.inputs.changed).toHaveLength(1);
    expect(d.inputs.changed[0]!.from.value).toBe(7200);
    expect(d.inputs.changed[0]!.to.value).toBe(8000);
    expect(d.inputs.changed[0]!.to.source).toContain("assessment notice");
    expect(d.inputs.added).toHaveLength(0);
    expect(d.inputs.removed).toHaveLength(0);
    expect(d.moved.map((m) => m.key)).toEqual(["stabilized_noi"]);
    expect(d.still.map((m) => m.key)).toEqual(["total_development_cost"]);
    expect(d.gates).toEqual({ from: { passed: 1, total: 1 }, to: { passed: 1, total: 1 } });
    expect(d.checks).toEqual({ from: { fired: 0, total: 1 }, to: { fired: 0, total: 1 } });
  });

  it("says what changed in one sentence, or that nothing did", () => {
    const en = build("en", () => {});
    expect(compareSummary(en, diffRuns(two, one), two, one).title).toBe("One input changed between these runs.");
    expect(compareSummary(en, diffRuns(two, one), two, one).body).toContain("The verdict is Approve in both.");
    expect(compareSummary(en, diffRuns(one, one), one, one).title).toMatch(/^Nothing changed/);
    expect(compareSummary(build("fr", () => {}), diffRuns(two, one), two, one).title).toBe("Une donnée a changé entre ces analyses.");
  });

  it("renders the changed input with its source and the unchanged metric under did not move", () => {
    state.runs = [{ id: "r2", run_number: 2, verdict_code: "APPROVE", created_at: two.createdAt }, { id: "r1", run_number: 1, verdict_code: "APPROVE", created_at: one.createdAt }];
    state.byId = { r1: one, r2: two };
    const html = render(createElement(Compare, { dealId: "d1" }));
    const t = text(html);
    expect(t).toContain("One input changed between these runs.");
    expect(t).toContain("assessment notice 2026.pdf, page 1");
    const still = t.indexOf("What did not move");
    expect(still).toBeGreaterThan(t.indexOf("What it moved"));
    expect(t.indexOf("Total development cost", still)).toBeGreaterThan(still);
    expect(state.nodes.filter((n) => n.tag === "select")).toHaveLength(2);
    expect(t).toContain("Open run 2");
    expect(t).not.toContain("Download this comparison");
  });
});
