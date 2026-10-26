import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Assumption, Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card W7: the review screen in the board's layout. Mocks follow apps/web/test/clients.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, role: "owner", solo: true, review: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "review" ? { data: state.review } : {}),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null, variables: undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as string), useNavigate: () => () => {} };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { deal: { currency: "CAD" }, updating: false, run: null, documents: { total: 2, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: state.solo, role: state.role, workspaceId: "ws", me: { user: { id: "me-id", name: "Morgan" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

import { Review } from "../src/routes/review.tsx";

const src = (value: number, raw: string, context: string, document_name = "budget.txt") => ({ document_id: document_name, document_name, value, raw, context, location: "line 3" });
const row = (over: Partial<Assumption>): Assumption => ({
  id: "x", fieldKey: "land_cost", itemKey: null, label: "", group: "budget", groupLabel: "Budget", unit: "$", material: false, conservative: null, status: "approved",
  value: 1, pendingValue: null, sourceKind: "document", sources: [], conflictValues: null, reason: null, decidedBy: "Dana", decidedById: "dana", decidedAt: "2026-10-21T12:00:00Z",
  secondApprover: null, confirmedByReview: false, secondApprovedAt: null, sponsorStated: false, clientConfirmedBy: null, clientConfirmedById: null, clientConfirmedAt: null, version: 1, ...over,
});
const approved = ["unit_count", "unit_rent_monthly", "stabilized_occupancy_pct", "exit_cap_rate_pct", "contingency", "other_cost"].map((fieldKey, i) =>
  row({ id: `ok-${i}`, fieldKey, value: 100 + i, sources: [src(100 + i, String(100 + i), `Line ${100 + i}`, "rent roll.txt")] }));
const payload = (): ReviewData => ({
  assumptions: [
    row({ id: "c1", fieldKey: "hard_cost", status: "conflicting", material: true, conservative: "max", value: null,
      conflictValues: [{ value: 4120000, documents: ["budget.txt"] }, { value: 4310000, documents: ["summary.txt"] }],
      sources: [src(4120000, "4,120,000", "Total hard costs 4,120,000"), src(4310000, "$4,310,000", "Construction (hard) $4,310,000", "summary.txt")] }),
    row({ id: "p1", fieldKey: "land_cost", status: "needs_review", value: 1150000, sources: [src(1150000, "$1,150,000", "Land acquisition $1,150,000", "summary.txt")] }),
    row({ id: "p2", fieldKey: "soft_cost", status: "needs_review", value: 390000, sources: [src(390000, "390,000", "Soft costs 390,000")] }),
    ...approved,
    row({ id: "d1", fieldKey: "expense_ratio_pct", status: "default_accepted", sourceKind: "default", value: 4, sources: [] }),
  ],
  missing: [{ fieldKey: "development_charges", label: "Development charges", unit: "$", material: true, default: null, help: null, groupLabel: "Budget", likely: [] }],
  notFound: [], choices: [], regions: [], proposals: [], tableNotices: [], aiReading: null,
  readiness: { status: "blocked", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
  todo: { blocking: 4, items: [
    { kind: "conflict", fieldKey: "hard_cost", itemKey: null, assumptionId: "c1", blocking: true },
    { kind: "missing", fieldKey: "development_charges", itemKey: null, assumptionId: null, blocking: true },
    { kind: "needs_review", fieldKey: "land_cost", itemKey: null, assumptionId: "p1", blocking: true },
    { kind: "needs_review", fieldKey: "soft_cost", itemKey: null, assumptionId: "p2", blocking: true },
  ] },
  other: [{ documentId: "doc", document_name: "summary.txt", raw: "$212,000", value: 212000, location: "line 9", context: "Projected NOI $212,000", note: null, figureId: "f1", label: null, suggestions: [] }],
});

const render = () => renderToStaticMarkup(createElement(Review, { dealId: "deal-1" }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!));

beforeEach(() => { state.lang = "en"; state.role = "owner"; state.solo = true; state.review = payload(); });

describe("card W7 the review screen", () => {
  it("says how many things stand before the run and lists them with their detail", () => {
    const words = text(render());
    expect(words).toContain("Blocked");
    expect(words).toContain("3 things before this deal can run");
    expect(words).toContain("Choose a value for 1 input where the documents disagree.");
    expect(words).toContain("Enter 1 required input that no document states.");
    expect(words).toContain("Look over 2 values Agir read and approve them.");
    expect(words).toContain("1 conflicting · 1 missing · 2 to review · 7 approved");
  });
  it("shows each candidate value of a conflict as a choice card with its quoted line", () => {
    const html = render();
    const conflicts = html.slice(html.indexOf('id="conflicts"'), html.indexOf('id="missing"'));
    expect(text(conflicts)).toContain("Where the documents disagree");
    expect(conflicts.match(/class="choice[^"]*"/g)).toHaveLength(2);
    expect(conflicts).toContain("<mark>4,120,000</mark>");
    expect(conflicts).toContain("<mark>$4,310,000</mark>");
    expect(text(conflicts)).toContain("the conservative value");
    expect(buttonLabels(conflicts)).toEqual(expect.arrayContaining(["Choose a value", "Enter a different value"]));
  });
  it("gives a missing value its form with a labelled reason field", () => {
    const html = render();
    const missing = html.slice(html.indexOf('id="missing"'), html.indexOf('id="pending"'));
    expect(text(missing)).toContain("Development charges");
    expect(missing).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Where does this value come from\?<\/label>/);
    const id = /<label[^>]*for="([^"]+)"[^>]*>Where does this value come from\?/.exec(missing)![1];
    expect(missing).toMatch(new RegExp(`<input[^>]*name="reason"[^>]*id="${id}"|<input[^>]*id="${id}"[^>]*name="reason"`));
    expect(buttonLabels(missing)).toContain("Save value");
  });
  it("lists the values waiting for approval in a table with Approve, Edit and Reject on each row", () => {
    const html = render();
    const pending = html.slice(html.indexOf('id="pending"'), html.indexOf('id="approved"'));
    expect(text(pending)).toContain("Read from your documents, waiting for your approval");
    expect(pending).toContain('<table class="table">');
    const labels = buttonLabels(pending);
    for (const action of ["Approve", "Edit", "Reject"]) expect(labels.filter((l) => l === action)).toHaveLength(2);
    expect(labels).toContain("Approve all 2");
    expect(pending).toContain("<mark>$1,150,000</mark>");
  });
  it("shows the first approved values and a disclosure for all of them, with the accepted default ticked", () => {
    const html = render();
    const words = text(html.slice(html.indexOf('id="approved"')));
    expect(words).toContain("Show all 7");
    expect(words).toContain("Default accepted");
    expect(words).toContain("Approved by Dana");
  });
  it("puts the deal's thresholds, the review mode and the audit sentence in the aside", () => {
    const html = render();
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(aside).toMatch(/<h2[^>]*>Thresholds<\/h2>/);
    expect(text(aside)).toContain("You review on your own.");
    expect(text(aside)).toContain("Every action is recorded");
    expect(aside).toContain('href="/settings/review-access"');
    expect(text(html)).toContain("1 figure in your documents was not used");
  });
  it("tells a team how it reviews, and gives no reviewer link to anyone but the owner", () => {
    state.solo = false; state.role = "analyst";
    const aside = render().split("<aside")[1]!;
    expect(text(aside)).toContain("You review as a team.");
    expect(aside).not.toContain('href="/settings/review-access"');
  });
  it("gives a viewer no action buttons", () => {
    state.role = "viewer";
    const html = render();
    const labels = buttonLabels(html);
    for (const action of ["Approve", "Edit", "Reject", "Approve all 2", "Enter a different value", "Choose a value", "Save value", "Reopen", "Use as…", "Add a unit type or space"]) expect(labels).not.toContain(action);
    expect(html).not.toContain('type="submit"');
    expect(text(html)).toContain("3 things before this deal can run");
  });
  it("says it all in French too", () => {
    state.lang = "fr";
    const words = text(render());
    expect(words).toContain("3 points à régler avant de pouvoir lancer ce projet");
    expect(words).toContain("Là où les documents divergent");
    expect(words).not.toContain("Where the documents disagree");
  });
});
