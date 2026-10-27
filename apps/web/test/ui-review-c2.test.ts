/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Assumption, Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card C2: the Review screen after launch QA. Mocks follow apps/web/test/ui-review.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, role: "owner", review: undefined as unknown, location: "Gatineau, QC" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "review" ? { data: state.review } : {}),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null, variables: undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => createElement("a", { href: to, className }, children as string), useNavigate: () => () => {}, useBlocker: () => ({ status: "idle" }) };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { deal: { currency: "CAD", location: state.location, province: "QC" }, updating: false, run: null, documents: { total: 2, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: true, role: state.role, workspaceId: "ws", me: { user: { id: "me-id", name: "Morgan" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

import { Review, TableProposal, decimalComma, hardLimit, landOptions, groupOther, offeredLabels, termOf } from "../src/routes/review.tsx";
import { build } from "../src/i18n.tsx";

const src = (value: number, raw: string, context: string) => ({ document_id: "d1", document_name: "budget.txt", value, raw, context, location: "line 3" });
const row = (over: Partial<Assumption>): Assumption => ({
  id: "x", fieldKey: "land_cost", itemKey: null, label: "", group: "budget", groupLabel: "Budget", unit: "$", material: false, conservative: null, status: "needs_review",
  value: 1, pendingValue: null, sourceKind: "document", sources: [], conflictValues: null, reason: null, decidedBy: null, decidedById: null, decidedAt: null,
  secondApprover: null, confirmedByReview: false, secondApprovedAt: null, sponsorStated: false, clientConfirmedBy: null, clientConfirmedById: null, clientConfirmedAt: null, version: 1, ...over,
} as Assumption);
const payload = (): ReviewData => {
  const assumptions = [
    row({ id: "p1", fieldKey: "land_cost", value: 1150000, sources: [src(1150000, "$1,150,000", "Land $1,150,000")] }),
    row({ id: "p2", fieldKey: "soft_cost", value: 390000, sources: [src(390000, "390,000", "Soft costs 390,000")] }),
    row({ id: "p3", fieldKey: "exit_cap_rate_pct", unit: "%", material: true, value: 5.5, sources: [src(5.5, "5.5%", "Exit cap 5.5%")] }),
    // Held back from Approve all by the double-count check.
    row({ id: "p4", fieldKey: "property_tax_annual", value: 38000, sources: [src(38000, "$38,000", "Property tax $38,000")] }),
  ];
  return {
    assumptions,
    missing: [{ fieldKey: "expense_ratio_pct", label: "Operating expense ratio", unit: "%", material: false, default: 35, help: null, groupLabel: "Operations", likely: [] }] as ReviewData["missing"],
    notFound: [{ fieldKey: "land_transfer_tax", label: "Land transfer tax", unit: "$", material: false, default: null, help: null, groupLabel: "Budget", likely: [] }] as ReviewData["missing"],
    choices: [], regions: [], tableNotices: [], aiReading: null,
    proposals: [{ fieldKey: "land_transfer_tax", tableId: "qc-land-2026", title: "Droits de mutation immobilière — 2026", publisher: "Ville de Québec", url: "https://example.test/qc", effective: "2026-01-01", recheckBy: "2027-01-15", readOn: "2026-10-24", signedOn: "2026-10-24",
      options: [
        { key: "qc", label: "Most municipalities — A municipality may charge up to 3% above $500,000.", value: 6050, reason: "r" },
        { key: "quebec-city", label: "Ville de Québec 2026", value: 6800, reason: "r" },
        { key: "montreal", label: "Montréal 2026", value: 7100, reason: "r" },
      ] }],
    readiness: { status: "blocked", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
    todo: { blocking: 5, items: [
      { kind: "missing", fieldKey: "expense_ratio_pct", itemKey: null, assumptionId: null, blocking: true },
      ...assumptions.map((a) => ({ kind: "needs_review" as const, fieldKey: a.fieldKey, itemKey: null, assumptionId: a.id, blocking: true })),
    ] },
    other: [
      { documentId: "rr", document_name: "rent-roll.pdf", raw: "$1,650", value: 1650, location: "page 1, line 3", context: "8 × One-bedroom $1,650 / month each 4 × Two-bedroom $2,100 / month each", note: "No field matches this label", figureId: "f1", label: null, suggestions: [] },
      { documentId: "rr", document_name: "rent-roll.pdf", raw: "$2,100", value: 2100, location: "page 1, line 3", context: "8 × One-bedroom $1,650 / month each 4 × Two-bedroom $2,100 / month each", note: "No field matches this label", figureId: "f2", label: null, suggestions: [] },
      { documentId: "rr", document_name: "rent-roll.pdf", raw: "$1,650", value: 1650, location: "page 1, line 4", context: "8 × One-bedroom $1,650 / month each 4 × Two-bedroom $2,100 / month each", note: "No field matches this label", figureId: "f3", label: null, suggestions: [] },
      { documentId: "db", document_name: "development-budget.pdf", raw: "12", value: 12, location: "page 1, line 2", context: "Halifax, Nova Scotia · New construction, 12 rental units · Development budget (CAD)", note: "Looks like hard costs, but the number is not written as a dollar amount. Enter it by hand if it is.", figureId: "f4", label: null, suggestions: ["construction_months"] },
    ],
  };
};

const render = () => renderToStaticMarkup(createElement(Review, { dealId: "deal-1" }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!));

beforeEach(() => { state.lang = "en"; state.role = "owner"; state.review = payload(); state.location = "Gatineau, QC"; });

describe("card C2 one count everywhere", () => {
  it("makes the summary and Approve all agree, naming what is held back and why", () => {
    const html = render();
    const words = text(html);
    expect(words).toContain("4 to review");
    const top = html.slice(0, html.indexOf('id="missing"'));
    expect(buttonLabels(top)).toContain("Approve all 3");
    expect(text(top)).toContain("3 can be approved together; 1 needs your eye first:");
    expect(text(top)).toContain("Property tax (per year) — Check this is not already inside your operating costs or expense ratio.");
    // 3 approved together + 1 held back = the 4 to review.
    expect(words.match(/Approve all \d+/g)!.every((m) => m.endsWith(" 3"))).toBe(true);
  });
  it("asks for confirmation in the page, never with the browser's confirm()", () => {
    const source = readFileSync(new URL("../src/routes/review.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/(^|[^.\w])confirm\(/m);
    expect(source).toContain('role="alertdialog"');
  });
});

describe("card C2 the named default is one action", () => {
  it("offers one button with the default's value and says it has no external source", () => {
    const html = render();
    const missing = html.slice(html.indexOf('id="missing"'), html.indexOf('id="pending"'));
    expect(buttonLabels(missing)).toContain("Use the named default (35%)");
    expect(text(missing)).toContain("Agir house assumption, no external source.");
    expect(missing).not.toContain('type="checkbox"');
  });
});

describe("card C2 Go to Run", () => {
  it("is a primary button once review is clear", () => {
    const r = payload();
    r.readiness.status = "ready"; r.todo = { blocking: 0, items: [] }; r.assumptions = []; r.missing = [];
    state.review = r;
    expect(render()).toMatch(/<a href="\/deals\/\$dealId\/run" class="btn primary">Go to Run<\/a>/);
  });
});

describe("card C2 land transfer tax", () => {
  it("gives Gatineau the province-wide rule, never Québec City's, with no empty dashes", () => {
    const html = render();
    const words = text(html);
    expect(words).toContain("Optional: add the province's land transfer tax ($6,050.00)? Skipping it leaves it out of the costs.");
    expect(words).not.toContain("— —");
    expect(html).not.toContain("Ville de Québec 2026");
    expect(buttonLabels(html)).toContain("Add it to the costs");
  });
  it("puts a city's own row first when the location names it", () => {
    const opts = payload().proposals[0]!.options;
    expect(landOptions(opts, "Gatineau, QC").options.map((o) => o.key)).toEqual(["qc"]);
    expect(landOptions(opts, "Québec, QC").options.map((o) => o.key)).toEqual(["quebec-city", "qc"]);
    expect(landOptions(opts, "Montréal").options.map((o) => o.key)).toEqual(["montreal", "qc"]);
    const on = [{ key: "on", label: "Ontario, outside Toronto" }, { key: "on-homes", label: "Ontario, homes" }, { key: "toronto", label: "Toronto" }, { key: "toronto-homes", label: "Toronto, homes" }];
    expect(landOptions(on, "Ottawa, ON").options.map((o) => o.key)).toEqual(["on", "on-homes"]);
    expect(landOptions(on, "Toronto, ON").options.map((o) => o.key)).toEqual(["toronto", "toronto-homes", "on", "on-homes"]);
    const ns = [{ key: "ns-0", label: "Town of Annapolis Royal" }, { key: "ns-1", label: "Halifax Regional Municipality" }];
    expect(landOptions(ns, "Halifax, NS")).toEqual({ options: [ns[1], ns[0]], matched: true });
    expect(landOptions(ns, "Somewhere, NS").matched).toBe(false);
  });
  it("asks to choose, without a dash for the amount, when nothing tells which rule applies", () => {
    const p = { ...payload().proposals[0]!, options: [{ key: "ns-0", label: "Town of Annapolis Royal", value: 1, reason: "r" }, { key: "ns-1", label: "Town of Middleton", value: 2, reason: "r" }] };
    const words = text(renderToStaticMarkup(createElement(TableProposal, { proposal: p, unit: "$", onUse: () => {}, busy: false, location: "Somewhere" })));
    expect(words).toContain("Optional: choose the rule that applies to add the land transfer tax.");
    expect(words).not.toMatch(/—\s*—/);
  });
});

describe("card C2 the value edit form", () => {
  it("reads a decimal comma in a percent or other number field as a decimal point", () => {
    const { f } = build("en", () => {});
    expect(f.parse(decimalComma("12,5", "%"))).toBe(12.5);
    expect(f.parse(decimalComma("12,5 %", "%"))).toBe(12.5);
    expect(f.parse(decimalComma("1,25", "x"))).toBe(1.25);
    expect(f.parse(decimalComma("1,200", "sf"))).toBe(1200);
    expect(f.parse(decimalComma("38,000", "$"))).toBe(38000);
    expect(f.parse(decimalComma("12.5", "%"))).toBe(12.5);
    expect(() => f.parse(decimalComma("😈", "%"))).toThrow("Enter a number.");
  });
  it("checks the contract's hard limits before anything is posted", () => {
    expect(hardLimit("expense_ratio_pct", -5)).toEqual({ kind: "min", bound: 0 });
    expect(hardLimit("expense_ratio_pct", 125)).toEqual({ kind: "max", bound: 100 });
    expect(hardLimit("hold_years", 2.5)).toEqual({ kind: "whole" });
    expect(hardLimit("expense_ratio_pct", 12.5)).toBeNull();
    expect(build("en", () => {}).t("review.errMax", { v: "100.00%" })).toBe("This value cannot be above 100.00%.");
  });
});

describe("card C2 glossary and terms", () => {
  it("uses the page's words, covers the reported terms and links each term to its entry", () => {
    const html = render();
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    const words = text(aside);
    for (const term of ["DCR or DSCR", "Exit cap rate", "EGI", "Amortization", "Interest-only period", "Lease-up period", "Stabilized occupancy", "Covenant", "Mezzanine loan", "bps", "Material", "Hold period"]) expect(words).toContain(term);
    expect(aside.indexOf('id="terms"')).toBeLessThan(aside.indexOf('id="thresholds"'));
    expect(aside).toContain('id="term-capRate"');
    // The exit cap rate row links to its entry; the default's row links EGI.
    expect(html).toContain('href="#term-capRate"');
    expect(html).toContain('href="#term-egi"');
    expect(html).toContain('href="#term-material"');
    expect(termOf("senior_io_months")).toBe("interestOnly");
    expect(termOf("min_dscr_covenant")).toBe("covenant");
  });
  it("names every entry in French too", () => {
    state.lang = "fr";
    const aside = text(render().split("<aside")[1]!);
    expect(aside).toContain("Taux de capitalisation à la sortie");
    expect(aside).toContain("RBE (revenu brut effectif)");
    expect(aside).toContain("Avancé : seuils de réussite");
  });
});

describe("card C2 unused figures", () => {
  it("shows one row per sentence, marks each number and offers no unrelated label for a heading line", () => {
    const html = render();
    const unused = html.slice(html.indexOf('id="unused-figures"'));
    expect(unused.match(/8 × One-bedroom/g)).toHaveLength(1);
    expect(unused).toContain("<mark>$1,650</mark>");
    expect(unused).toContain("<mark>$2,100</mark>");
    expect(unused).toContain("<mark>12</mark>");
    expect(buttonLabels(unused)).not.toContain("Use as Construction period");
    expect(text(html)).toContain("3 figures in your documents were not used");
    const groups = groupOther(payload().other);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
    expect(offeredLabels({ note: "No field matches this label", suggestions: ["hard_cost"] })).toEqual(["hard_cost"]);
  });
});

describe("card C2 phone layout", () => {
  it("stacks the value rows below 600 px with full-width actions and 44 px targets", () => {
    const css = readFileSync(new URL("../src/styles/review.css", import.meta.url), "utf8");
    const phone = css.slice(css.indexOf("@media (max-width:600px)"));
    expect(phone).toContain(".rv-table,.rv-table tbody,.rv-table tr,.rv-table td{display:block;width:100%}");
    expect(phone).toMatch(/\.rv-table \.acts \.btn[^{]*\{width:100%;min-height:44px/);
    expect(phone).toContain("min-height:44px");
  });
});
