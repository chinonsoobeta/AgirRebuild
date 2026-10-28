/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type Assumption, type Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// QA run 2, card D2 (breaker #21 and N7): rejecting a value a document states asks why in the page, and the value is listed
// as rejected on Review, not as not found. Mocks follow ui-review-c2 and the hook driver of ui-decision-reports.
const s = vi.hoisted(() => ({ lang: "en" as Lang, review: undefined as unknown, interactive: false, hooks: [] as unknown[], index: 0,
  nodes: [] as { tag: string; props: Record<string, any> }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "review" ? { data: s.review } : {}),
  useMutation: (o: { mutationFn: (b: any) => Promise<any>; onSuccess?: (d: any) => unknown }) => ({
    mutate: async (b: unknown) => { const d = await o.mutationFn(b); await o.onSuccess?.(d); }, isPending: false, reset: () => {}, error: null, variables: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as string), useNavigate: () => () => {}, useBlocker: () => ({ status: "idle" }) };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { deal: { currency: "CAD", location: "Burnaby, BC", province: "BC" }, updating: false, run: null, documents: { total: 2, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: true, role: "owner", workspaceId: "ws", me: { user: { id: "me-id", name: "Morgan" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async () => undefined), post: vi.fn(async () => ({})) } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const real = react.useState(initial);
    if (!s.interactive) return real;
    const n = s.index++;
    if (!(n in s.hooks)) s.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [s.hooks[n], (v: unknown) => { s.hooks[n] = typeof v === "function" ? (v as (x: unknown) => unknown)(s.hooks[n]) : v; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "form", "input"].includes(args[0])) s.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

import { Review } from "../src/routes/review.tsx";

const src = { document_id: "d1", document_name: "budget.pdf", value: 38000, raw: "$38,000", context: "Property tax $38,000", location: "page 1, line 9" };
const row = (over: Partial<Assumption>): Assumption => ({
  id: "x", fieldKey: "land_cost", itemKey: null, label: "", group: "budget", groupLabel: "Budget", unit: "$", material: false, conservative: null, status: "needs_review",
  value: 1, pendingValue: null, sourceKind: "document", sources: [], conflictValues: null, reason: null, decidedBy: null, decidedById: null, decidedAt: null,
  secondApprover: null, confirmedByReview: false, secondApprovedAt: null, sponsorStated: false, clientConfirmedBy: null, clientConfirmedById: null, clientConfirmedAt: null, version: 3, ...over,
} as Assumption);
const payload = (assumptions: Assumption[], notFound: string[] = []): ReviewData => ({
  assumptions, missing: [], choices: [], regions: [], tableNotices: [], aiReading: null, proposals: [], other: [],
  notFound: notFound.map((fieldKey) => ({ fieldKey, label: fieldKey, unit: "$", material: false, default: null, help: null, groupLabel: "Operations", likely: [] })) as unknown as ReviewData["notFound"],
  readiness: { status: "ready", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
  todo: { blocking: 0, items: assumptions.filter((a) => a.status === "needs_review").map((a) => ({ kind: "needs_review" as const, fieldKey: a.fieldKey, itemKey: null, assumptionId: a.id, blocking: true })) },
} as unknown as ReviewData);
const render = () => { s.index = 0; s.nodes = []; return renderToStaticMarkup(createElement(Review, { dealId: "deal-1" })).replaceAll("&#x27;", "'"); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const button = (label: string) => s.nodes.find((n) => n.tag === "button" && text(String([n.props.children].flat().join(""))) === label)!;

beforeEach(() => { s.lang = "en"; s.interactive = false; s.hooks = []; vi.clearAllMocks(); });

describe("rejecting a value a document states (card D2)", () => {
  it("asks for a written reason in the page before anything is sent, and sends it as the action's reason", async () => {
    s.review = payload([row({ id: "p1", fieldKey: "property_tax_annual", value: 38000, sources: [src] })]);
    s.interactive = true;
    render();
    button("Reject").props.onClick();
    expect(api.post).not.toHaveBeenCalled();
    const html = render();
    expect(text(html)).toContain("A document states this value. Say why you reject it");
    const input = s.nodes.find((n) => n.tag === "input" && n.props.id === "x-p1")!;
    expect(input.props.name).toBe("reason");
    const form = s.nodes.filter((n) => n.tag === "form").find((f) => String(f.props.className).includes("rv-confirm"))!;
    const send = (reason: string) => {
      const target = { get: () => reason };
      vi.stubGlobal("FormData", class { get() { return target.get(); } });
      return form.props.onSubmit({ preventDefault: () => {}, currentTarget: {} });
    };
    send("   too short ");
    expect(api.post).not.toHaveBeenCalled();
    expect(text(render())).toContain("Say why you reject this value (at least 10 characters).");
    await send("  The budget's tax line is the 2024 figure  ");
    expect(api.post).toHaveBeenCalledWith("/assumptions/p1/review", { id: "p1", action: "reject", reason: "The budget's tax line is the 2024 figure", version: 3 });
    vi.unstubAllGlobals();
  });
  it("rejects a value no document states at once, as before", async () => {
    s.review = payload([row({ id: "p2", fieldKey: "other_income_annual", value: 9600, sourceKind: "analyst", sources: [] })]);
    s.interactive = true;
    render();
    await button("Reject").props.onClick();
    expect(api.post).toHaveBeenCalledWith("/assumptions/p2/review", expect.objectContaining({ action: "reject", reason: "Rejected in review" }));
  });
});

describe("a rejected stated value on Review (card D2)", () => {
  it("is listed under Rejected on Review with its reason and a replacement action, not under Not found", () => {
    s.review = payload([row({ id: "r1", fieldKey: "property_tax_annual", status: "rejected", value: 38000, sources: [src], reason: "The budget's tax line is the 2024 figure", decidedBy: "Morgan" })],
      ["property_tax_annual", "other_cost"]);
    const words = text(render());
    expect(words).toContain("Rejected on Review");
    expect(words).toContain("Property tax (per year): $38,000 in budget.pdf, rejected by Morgan. The run treats this as: included in operating costs or none.");
    expect(words).toContain("Reason: The budget's tax line is the 2024 figure");
    expect(words).toContain("Enter a replacement");
    const notFound = words.slice(words.indexOf("Not in the documents (optional)"), words.indexOf("Approved 0"));
    expect(notFound).toContain("Other costs");
    expect(notFound).not.toContain("Property tax");
  });
  it("leaves a field with no rejected stated value under Not found, in French too", () => {
    s.lang = "fr";
    s.review = payload([], ["property_tax_annual"]);
    const words = text(render());
    expect(words).toContain("Absent des documents (facultatif)");
    expect(words).not.toContain("Rejetées à l'examen");
  });
});
