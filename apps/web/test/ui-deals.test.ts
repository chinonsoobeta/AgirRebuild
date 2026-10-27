import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DealOverview } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ deals: [] as unknown[], role: "owner", lang: "en" as Lang, solo: true, name: "Chinonso Obeta", queries: [] as { queryKey: unknown[] }[] }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => { state.queries.push(options); return { data: state.deals, isLoading: false }; },
  useMutation: () => ({ mutate: () => {}, isPending: false, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  const href = (to: string, params?: Record<string, string>) => to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "");
  return {
    Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) => createElement("a", { href: href(to, params), className }, children as string),
    useNavigate: () => () => {},
  };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  return { ...ui, useSession: () => ({ me: { user: { id: "u1", email: "a@b.c", name: state.name }, workspaces: [] }, workspaceId: "w1", role: state.role, solo: state.solo, setWorkspace: () => {} }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

const { Deals } = await import("../src/routes/deals.tsx");
const { NewDeal } = await import("../src/routes/newdeal.tsx");

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();

const review = { approved: 10, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "ready" as const };
function deal(id: string, name: string, over: Partial<DealOverview>): DealOverview {
  return {
    deal: { id, workspace_id: "w1", name, asset_type: "Multifamily", location: "Halifax", currency: "CAD", country: "CA", province: "NS", created_at: "2026-10-01T00:00:00Z" },
    copiedFrom: null, step: "documents", status: { tone: "neutral", text: "" }, next: "", documents: { total: 3, processing: 0, failed: 0 }, updating: false,
    review, run: null, decision: null, reports: 0, units: null, exit: null, ...over,
  };
}
const MIXED = [
  deal("d1", "Harbour Lane", { step: "review", documents: { total: 6, processing: 0, failed: 0 }, review: { ...review, conflicting: 2, missing: 1, status: "blocked" } }),
  deal("d2", "Tamarack Six", { step: "decision", run: { id: "r2", number: 2, verdict: "APPROVE", fresh: true, createdAt: "2026-10-20T00:00:00Z" } }),
  deal("d3", "Fireweed Fourplex", { step: "run", run: { id: "r3", number: 2, verdict: "APPROVE", fresh: false, createdAt: "2026-10-20T00:00:00Z" } }),
  deal("d4", "Birchmount Lane", { step: "documents", documents: { total: 3, processing: 3, failed: 0 } }),
  deal("d5", "Larch Court", { step: "reports", run: { id: "r5", number: 3, verdict: "APPROVE", fresh: true, createdAt: "2026-10-19T00:00:00Z" }, decision: { decision: "approve", created_at: "2026-10-19T00:00:00Z" }, reports: 2 }),
];

beforeEach(() => {
  state.deals = [];
  state.role = "owner";
  state.lang = "en";
  state.solo = true;
  state.name = "Chinonso Obeta";
  state.queries = [];
});

describe("the deals list", () => {
  it("shows one row per deal with its tag, sentence and next-step button", () => {
    state.deals = MIXED;
    const html = renderToStaticMarkup(createElement(Deals));
    expect(html.match(/<article class="deal"/g)?.length).toBe(5);
    const rows = html.split('<article class="deal"').slice(1);
    const blocked = text(rows[0]!);
    expect(blocked).toContain("Harbour Lane");
    expect(blocked).toContain("Blocked");
    expect(blocked).toContain("2 conflicts, 1 missing");
    expect(blocked).toContain("6 documents");
    expect(rows[0]).toMatch(/<a href="\/deals\/d1\/review" class="btn quiet">[^]*Resolve 2 conflicts/);
    expect(rows[0]).toContain('class="deal-name sm"');
    expect(text(rows[1]!)).toContain("Ready to decide");
    expect(rows[1]).toMatch(/<a href="\/deals\/d2\/decision" class="btn quiet">[^]*Record your decision/);
    expect(text(rows[2]!)).toContain("Out of date");
    expect(rows[2]).toMatch(/<a href="\/deals\/d3\/run" class="btn quiet">[^]*Run underwriting/);
    expect(text(rows[3]!)).toContain("Reading 3 documents");
    expect(text(rows[4]!)).toContain("Decided");
    expect(rows[4]).toMatch(/<a href="\/deals\/d5\/reports" class="btn quiet">[^]*Share the reports/);
  });

  it("offers to open the deal to someone who cannot take its next step", () => {
    state.deals = MIXED;
    const rows = () => renderToStaticMarkup(createElement(Deals)).split('<article class="deal"').slice(1);
    state.role = "viewer";
    let r = rows();
    expect(r[0]).toMatch(/<a href="\/deals\/d1\/review" class="btn quiet">[^]*Open the deal/);
    expect(r[0]).not.toContain("Resolve 2 conflicts");
    expect(r[1]).toMatch(/class="btn quiet">[^]*Open the deal/);
    expect(r[2]).toMatch(/class="btn quiet">[^]*Open the deal/);
    // A viewer can share a report by link; a client cannot.
    expect(r[4]).toMatch(/class="btn quiet">[^]*Share the reports/);
    state.role = "client";
    expect(rows()[4]).toMatch(/class="btn quiet">[^]*Open the deal/);
    // An analyst works the deal but does not record the decision.
    state.role = "analyst";
    state.solo = false;
    r = rows();
    expect(r[0]).toMatch(/class="btn quiet">[^]*Resolve 2 conflicts/);
    expect(r[1]).toMatch(/class="btn quiet">[^]*Open the deal/);
    expect(r[1]).not.toContain("Record the decision");
    state.role = "viewer";
    state.lang = "fr";
    expect(text(rows()[0]!)).toContain("Ouvrir le projet");
  });

  it("labels the filter chips with their counts", () => {
    state.deals = MIXED;
    const t = text(renderToStaticMarkup(createElement(Deals)));
    for (const chip of ["All 5", "Blocked 1", "Ready to decide 1", "In progress 2", "Decided 1", "Out of date 1"]) expect(t).toContain(chip);
  });

  it("says where the deals stand in one lead sentence, in English and French", () => {
    state.deals = MIXED.filter((d) => d.deal.id !== "d3").concat([deal("d6", "Sixth", { step: "documents", documents: { total: 0, processing: 0, failed: 0 }, review: { ...review, approved: 0 } })]);
    expect(text(renderToStaticMarkup(createElement(Deals)))).toContain("One deal is blocked and one is ready for your decision. Two are in progress and one is decided.");
    state.lang = "fr";
    expect(text(renderToStaticMarkup(createElement(Deals)))).toContain("Un projet est bloqué et un est prêt pour votre décision. Deux sont en cours et un est décidé.");
  });

  it("says something different when every deal is in one state", () => {
    state.deals = [MIXED[0]!, deal("d7", "Other", { step: "review", review: { ...review, needsReview: 4, status: "blocked" } })];
    expect(text(renderToStaticMarkup(createElement(Deals)))).toContain("Both deals are blocked.");
  });

  it("keeps polling while documents are processing", () => {
    state.deals = MIXED;
    renderToStaticMarkup(createElement(Deals));
    const q = state.queries.find((o) => o.queryKey[0] === "deals") as unknown as { refetchInterval: (q: { state: { data?: DealOverview[] } }) => number | false };
    expect(q.refetchInterval({ state: { data: MIXED } })).toBe(2000);
    expect(q.refetchInterval({ state: { data: [MIXED[0]!] } })).toBe(false);
  });

  it("keeps the footnote about where status comes from", () => {
    state.deals = MIXED;
    expect(text(renderToStaticMarkup(createElement(Deals)))).toContain("Nobody sets it by hand.");
  });
});

describe("the first visit", () => {
  it("welcomes an editor by first name and offers one way in, the new-deal page (QA #22)", () => {
    const html = renderToStaticMarkup(createElement(Deals));
    const t = text(html);
    expect(t).toContain("Welcome, Chinonso.");
    expect(t).toContain("New deal");
    expect(t).toContain("Name your project, then type your numbers or upload documents.");
    expect(t).not.toContain("Quick start");
    expect(html.match(/href="\/deals\/new"/g)?.length).toBe(1);
    expect(t.toLowerCase()).not.toContain("sample");
  });

  it("gives a viewer one plain sentence", () => {
    state.role = "viewer";
    const html = renderToStaticMarkup(createElement(Deals));
    expect(text(html)).toContain("There are no deals you can see yet.");
    expect(html).not.toContain('href="/deals/new"');
    expect(text(html)).not.toContain("Name your project");
  });
});

describe("the new-deal page", () => {
  it("has every field, the currency note and the two actions", () => {
    const html = renderToStaticMarkup(createElement(NewDeal));
    const t = text(html);
    expect(html).toContain("<form");
    for (const name of ["name", "assetType", "province", "location"]) expect(html).toContain(`name="${name}"`);
    for (const id of ["nd-name", "nd-type", "nd-country", "nd-prov", "nd-loc", "nd-cur"]) expect(html).toContain(`for="${id}"`);
    expect(t).toContain("What kind of project is it?");
    expect(t).toContain("Shown on every report.");
    expect(t).toContain("The city. Outside Canada, add the state.");
    expect(t).toContain("Every amount in this deal is in this currency. It is set now and cannot be changed later.");
    expect(html).toContain('value="Multifamily"');
    expect(t).toContain("Create deal");
    expect(html).toMatch(/<a href="\/deals"[^>]*>Cancel<\/a>/);
  });

  it("shows a viewer a sentence and a way back, and no form", () => {
    state.role = "viewer";
    const html = renderToStaticMarkup(createElement(NewDeal));
    expect(html).not.toContain("<form");
    expect(text(html)).toContain("cannot create deals");
    expect(html).toContain('href="/deals"');
  });
});
