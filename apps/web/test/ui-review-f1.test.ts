/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card F1: readings for a field the deal's mode does not use are listed on Review as not needed, with the reason, in English
// and French, and are never among the values to approve. Mocks follow ui-review-d2.
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

const payload = (notNeeded: ReviewData["notNeeded"]): ReviewData => ({
  assumptions: [], missing: [], choices: [], regions: [], tableNotices: [], aiReading: null, proposals: [], other: [], notFound: [], notNeeded,
  readiness: { status: "ready", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
  todo: { blocking: 0, items: [] },
} as unknown as ReviewData);
const render = () => { s.index = 0; s.nodes = []; return renderToStaticMarkup(createElement(Review, { dealId: "deal-1" })).replaceAll("&#x27;", "'"); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&amp;", "&").replaceAll("&nbsp;", "\u00a0").replace(/[ \t\n]+/g, " ").trim();
const rental = payload([
  { fieldKey: "unit_sale_price", itemKey: "End", label: "Sale price per unit", value: 899900, why: "This deal rents its units", sources: [{ document_name: "price-list.xlsx", location: "Price List!C2" }] },
  { fieldKey: "presold_units_pct", itemKey: null, label: "Presold units", value: 50, why: "This deal rents its units", sources: [{ document_name: "brochure.pdf", location: "page 1, line 6" }] },
]);

beforeEach(() => { s.lang = "en"; s.interactive = false; s.hooks = []; vi.clearAllMocks(); });

describe("readings this deal does not need (card F1)", () => {
  it("lists each with its value, its source and why, counted with the unused figures, and offers no Approve", () => {
    s.review = rental;
    const words = text(render());
    expect(words).toContain("2 figures in your documents were not used");
    const section = words.slice(words.indexOf("Not needed for this deal"));
    expect(section).toContain("Read from your documents for a field this deal does not use");
    expect(section).toContain("$899,900");
    expect(section).toContain("price-list.xlsx · Price List!C2");
    expect(section).toContain("50");
    expect(section).toContain("This deal rents its units");
    expect(s.nodes.some((n) => n.tag === "button" && /Approve/.test(String([n.props.children].flat().join(""))))).toBe(false);
  });
  it("says so in French, with the reason for a deal that sells its units", () => {
    s.lang = "fr";
    s.review = payload([{ fieldKey: "unit_rent_monthly", itemKey: "2BR", label: "Rent per unit per month", value: 2100, why: "This deal sells its units", sources: [{ document_name: "note.pdf", location: "page 1, line 4" }] }]);
    const words = text(render());
    expect(words).toContain("Non nécessaires pour ce projet");
    expect(words).toContain("Lus dans vos documents pour un champ que ce projet n’utilise pas\u00a0;");
    expect(words).toContain("Ce projet vend ses logements");
    expect(words).not.toContain("This deal sells its units");
  });
  it("shows nothing when every reading is needed", () => {
    s.review = payload([]);
    expect(text(render())).not.toContain("Not needed for this deal");
  });
});

describe("a table of prices on Review (open-list fix)", () => {
  const region = (fields: string[]) => ({ documentId: "d", documentName: "prices.xlsx", source: "s", table: "Prices", fields, ids: ["a"], leftOut: [] });
  const intro = (fields: string[], selling: boolean) => { s.review = { ...payload([]), selling, regions: [region(fields)] }; return text(render()); };
  it("calls a sale deal's table a price list, in English and French, and a rent table still a rent roll", () => {
    expect(intro(["unit_count", "unit_sale_price"], true)).toContain("looks like your price list");
    expect(intro(["unit_count"], true)).toContain("looks like your price list");
    expect(intro(["unit_count", "unit_rent_monthly"], false)).toContain("looks like your rent roll");
    expect(intro(["unit_count"], false)).toContain("looks like your rent roll");
    s.lang = "fr";
    expect(intro(["unit_count", "unit_sale_price"], true)).toContain("liste de prix");
  });
});
