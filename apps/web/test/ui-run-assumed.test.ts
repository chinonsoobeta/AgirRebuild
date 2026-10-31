/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import { costParts, layoutFor, meaning, Run } from "../src/routes/run.tsx";
import { build, type Lang } from "../src/i18n.tsx";
import "../src/strings/landing";

// Card C5: the run screen says what the run assumed, counts its stresses as the engine does, and on a phone shows
// one card per scenario and per year. Mocks follow apps/web/test/ui-policy-names.test.ts.
const s = vi.hoisted(() => ({ lang: "en" as Lang, run: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => (o.queryKey[0] === "run" ? { data: s.run } : o.queryKey[0] === "runs" ? { data: [] } : {}),
  useQueries: (o: { queries: unknown[] }) => o.queries.map(() => ({})),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return { ...ui, DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { run: { id: "run-2", number: 2, fresh: true }, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: "owner", me: { user: { id: "u", email: "u@example.test", name: "Invented starter" }, workspaces: [] } }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});

const input = developmentDeal() as EngineInput;
const result = underwrite(input, policyFor(input));
const base = result.scenarios[0]!.metrics;
const tdc = base.find((m) => m.key === "total_development_cost")!.value!;
const stated = tdc - 1_250_000;
const withGap = { ...result, checks: [...result.checks, { key: "stated_total_cost", kind: "agreement", severity: "warning",
  message: "The documents state a total cost; the model computes another.", expected: tdc, actual: stated }] };
const run = (over: object = {}) => ({ id: "run-2", number: 2, result: withGap, fresh: true, staleReasons: [], isLatest: true, decisions: [],
  policyVersion: "rental-hold-draft", policyDraft: true, engineVersion: "invented-engine", createdAt: "2026-10-24T15:58:00Z", createdBy: "Invented author",
  inputHash: "a".repeat(64), resultHash: "b".repeat(64), signed: "development key",
  inputs: [
    { fieldKey: "exit_cap_rate_pct", itemKey: null, label: "Exit cap rate", value: 5.25, sourceKind: "analyst", source: "Entered by an analyst", sponsorStated: true, confirmedBy: null, confirmedByReview: false, confirmedAt: null },
    { fieldKey: "selling_costs_pct", itemKey: null, label: "Selling costs", value: 2, sourceKind: "default", source: "Named default", sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null },
    { fieldKey: "hard_cost", itemKey: null, label: "Hard cost", value: 1000, sourceKind: "document", source: "Budget.pdf", sponsorStated: false, confirmedBy: "Invented author", confirmedByReview: false, confirmedAt: null },
  ],
  notFound: [{ fieldKey: "other_income_annual", label: "Other income", detail: "no other income" }],
  ...over });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/[\u00a0\u202f]/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replace(/\s+/g, " ");
/** Any space as a plain one, as text() leaves the page. */
const sp = (x: string) => x.replace(/[\u00a0\u202f]/g, " ");
const render = () => renderToStaticMarkup(createElement(Run, { dealId: "deal" }));

beforeEach(() => { s.lang = "en"; s.run = run(); });

describe("what this run assumed (card C5)", () => {
  it.each(["en", "fr"] as const)("lists stated values, named defaults, values not found, the policy and the key, in %s", (lang) => {
    s.lang = lang;
    const i = build(lang, () => {});
    const words = text(render());
    const box = words.slice(words.indexOf(i.t("run.assumedTitle")), words.indexOf(i.t("run.keyFigures")));
    for (const key of ["run.assumed.stated", "run.assumed.defaults", "run.assumed.notFound", "run.assumed.policy", "run.assumed.policyWhy", "run.assumed.devKey", "run.assumed.devKeyWhy"] as const) {
      expect(box).toContain(sp(i.t(key)));
    }
    expect(box).toContain(sp(i.L.field("exit_cap_rate_pct", null)));
    expect(box).toContain(sp(i.f.value(5.25, "%")));
    expect(box).toContain(sp(i.L.field("selling_costs_pct", null)));
    // A value read from a document and confirmed is not an assumption.
    expect(box).not.toContain(sp(i.L.field("hard_cost", null)));
    expect(box).toContain(sp(i.t("run.assumed.instead", { what: i.L.absent("other_income_annual") })));
  });

  it("names the parts of the model's total cost when the documents state another", () => {
    const i = build("en", () => {});
    const words = text(render());
    expect(words).toContain(sp(i.t("run.costGap")));
    expect(words).toContain(sp(i.t("run.costGapLine", { stated: i.f.value(stated, "$"), model: i.f.value(tdc, "$"), diff: i.f.value(1_250_000, "$"), more: true })));
    const parts = costParts(base, tdc)!;
    expect(parts.map((p) => p.key)).toContain(sp("hard_and_soft_cost"));
    expect(parts.map((p) => p.key)).toContain(sp("capitalized_interest"));
    for (const p of parts) expect(words).toContain(sp(`${i.L.metric(p.key)} ${i.f.value(p.value, "$")}`));
    // Parts that do not add up to the model's total are not shown.
    expect(costParts(base, tdc + 10)).toBe(null);
  });

  it("says nothing was assumed when every value came from a confirmed document on a signed policy", () => {
    s.run = run({ result, inputs: [], notFound: [], policyVersion: "policy-v1", policyDraft: false, signed: "production key" });
    const i = build("en", () => {});
    const words = text(render());
    expect(i.t("run.verdictLine", { n: 2, policy: "x", draft: false, unsigned: false })).toBe("Run 2 · x");
    // policy-v1 is not signed by credit, so that line still shows; the key line does not.
    expect(words).toContain(sp(i.t("run.assumed.policyWhyUnsigned")));
    expect(words).not.toContain(sp(i.t("run.assumed.devKey")));
  });

  it("counts six stresses and a combined stress, seven in all, as the engine runs them", () => {
    const stresses = result.scenarios.filter((x) => x.key !== result.scenarios[0]!.key && x.key !== "combined").length;
    expect(stresses).toBe(6);
    for (const lang of ["en", "fr"] as const) {
      s.lang = lang;
      const i = build(lang, () => {});
      const words = text(render());
      expect(words).toContain(sp(i.t("run.underStressLead", { n: stresses })));
      expect(i.t("run.underStressLead", { n: stresses })).toContain(sp(lang === "en" ? "six stresses and a combined stress (seven in all)" : "six stress et un stress combiné (sept en tout)"));
    }
  });

  it("names the reports screen as the place to go, not a memo to make", () => {
    const i = build("en", () => {});
    expect(i.t("run.memoAction")).toBe("Go to reports");
    expect(text(render())).toContain(sp("Go to reports"));
  });
});

describe("the wide tables on a phone (card C5)", () => {
  it("adds one card per scenario and one per year, hidden on a wide screen", () => {
    const html = render();
    const cards = html.split('class="run-phone-cards"');
    // Card D4: the gates come first, then the scenarios and the years.
    expect(cards.length).toBe(4);
    const gates = cards[1]!.split("</ul>")[0]!;
    expect(gates.match(/<li /g)!.length).toBe(result.verdict.gates.length);
    const scenarios = cards[2]!.split("</ul>")[0]!;
    expect(scenarios.match(/<li /g)!.length).toBe(result.scenarios.length);
    const years = cards[3]!.split("</ul>")[0]!;
    expect(years.match(/<li /g)!.length).toBe(Math.min(result.annual.length, 6));
    const css = readFileSync(new URL("../src/styles/run.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(max-width:600px\)\{[^}]*\.run-stress,\.run-annual\{display:none\}/);
  });
});

describe("the run screen for a first-time reader (card D4)", () => {
  const css = readFileSync(new URL("../src/styles/run.css", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width:600px)"));

  it.each(["en", "fr"] as const)("gives every key figure one plain sentence, and the two coverages one name each, in %s", (lang) => {
    s.lang = lang;
    const i = build(lang, () => {});
    const html = render();
    const words = text(html);
    const figures = layoutFor(base).headline.filter((k) => base.some((m) => m.key === k));
    expect(figures).toEqual(expect.arrayContaining(["sizing_dscr", "contractual_dscr", "debt_yield", "capitalized_interest", "equity_irr"]));
    for (const k of figures) {
      const plain = meaning(i, k);
      expect(plain, k).toBeTruthy();
      expect(words, k).toContain(sp(plain!));
    }
    expect(html.match(/class="run-fig-meaning"/g)!.length).toBe(figures.length);
    expect(i.L.metric("sizing_dscr")).toBe(lang === "en" ? "Coverage, full payment (weakest year)" : "Couverture, paiement complet (pire année)");
    expect(i.L.metric("contractual_dscr")).toBe(lang === "en" ? "Coverage, payments due (weakest year)" : "Couverture, paiements dus (pire année)");
    // The second says how it differs during an interest-only period.
    expect(meaning(i, "contractual_dscr")).toContain(lang === "en" ? "interest only during an interest-only period" : "intérêts seulement");
    // Reused, not rewritten: the full-payment coverage reads as the glossary's own entry.
    expect(meaning(i, "sizing_dscr")).toBe(i.t("terms.gloss.dcr")[1]);
  });

  it("says why an equity return is not meaningful in plain words", () => {
    const i = build("en", () => {});
    const nm = { ...withGap, scenarios: withGap.scenarios.map((x, n) => n ? x : { ...x, metrics: x.metrics.map((m) => m.key === "equity_irr"
      ? { ...m, status: "NOT_MEANINGFUL", value: null, reason: "The equity cash flows have no rate of return (no sign change)." } : m) }) };
    s.run = run({ result: nm });
    expect(text(render())).toContain(sp(i.t("run.meaning.noSignChange")));
  });

  it.each(["en", "fr"] as const)("has one Explore changes button with its hint, and the not-advice line, in %s", (lang) => {
    s.lang = lang;
    const i = build(lang, () => {});
    const words = text(render());
    expect(words.split(sp(i.t("run.explore"))).length - 1).toBe(1);
    expect(words).toContain(sp(i.t("run.exploreHint")));
    expect(words).toContain(sp(i.t("run.notAdvice")));
    expect(i.t("run.notAdvice")).toBe(i.t("landing.footNote"));
  });

  it("states the loan's compounding beside the run's setup when there is a senior loan", () => {
    const i = build("en", () => {});
    expect(text(render())).not.toContain(sp(i.t("run.assumed.loanWhy")));
    s.run = run({ inputs: [...(run() as { inputs: object[] }).inputs, { fieldKey: "senior_loan_amount", itemKey: null, label: "Senior loan", value: 3_900_000,
      sourceKind: "document", source: "Term sheet", sponsorStated: false, confirmedBy: "Invented author", confirmedByReview: false, confirmedAt: null }] });
    const words = text(render());
    expect(words).toContain(sp(i.t("run.assumed.loan")));
    expect(words).toContain("Interest compounds monthly. Canadian lenders often quote rates compounded semi-annually");
  });

  it("on a phone shows gates as cards, keeps figures on one line inside the card, and puts the verdict before the steps", () => {
    const html = render();
    expect(html).toContain('class="card scroll run-gates"');
    expect(phone).toMatch(/\.run-gates\{display:none\}/);
    expect(phone).toMatch(/\.run-phone-cards \.kv\{grid-template-columns:minmax\(0,1fr\) auto\}/);
    expect(phone).toMatch(/\.run-phone-cards \.kv dd\{white-space:nowrap\}/);
    // The verdict sits in the body's first block, lifted above the path on a phone.
    expect(html.indexOf('class="stack run-top"')).toBeLessThan(html.indexOf('aria-label="Verdict"'));
    expect(html.indexOf('aria-label="Verdict"')).toBeLessThan(html.indexOf(i18nTitle()));
    expect(phone).toMatch(/\.run-page > \.run-body\{display:contents\}/);
    expect(phone).toMatch(/\.run-page > \.run-body > \.run-top\{order:1\}/);
    expect(phone).toMatch(/\.run-page > \.path\{order:2;margin:0\}/);
  });
});

/** The title of the box that follows the verdict on every screen size. */
const i18nTitle = () => build("en", () => {}).t("run.assumedTitle");

describe("the reports buttons on a touch screen (card D4)", () => {
  it("are at least 44 px tall", () => {
    const css = readFileSync(new URL("../src/styles/reports.css", import.meta.url), "utf8");
    expect(css).toMatch(/@media \(pointer:coarse\)\{\s*\.rep-acts \.btn,\.rep-other \.btn\{min-height:44px\}/);
  });
});

describe("the run screen of a deal that sells its units (card F2)", () => {
  const d = JSON.parse(readFileSync(new URL("../../../oracles/for-sale/kestrel-row-townhomes.outcome.json", import.meta.url), "utf8")).inputs;
  const kestrel: EngineInput = { ...developmentDeal(), revenue: [], leaseUpMonths: 0, exit: "for_sale", mezzanine: undefined,
    budget: { land: d.land, hard: d.hard, soft: d.soft, contingency: d.contingency, other: 0 }, constructionMonths: d.construction_months,
    senior: { amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 },
    forSale: { units: d.unit_types.map((u: { name: string; units: number; price: number }, n: number) => ({ key: String(n), label: u.name, units: u.units, price: u.price })),
      presoldPct: d.presold_units_pct, depositPct: d.deposit_pct, absorptionPerMonth: d.absorption_units_per_month, commissionPct: d.sales_commission_pct,
      closingLagMonths: d.closing_lag_months, carryMonthly: d.unsold_carry_monthly, presaleThresholdPct: d.senior_presale_threshold_pct } } as EngineInput;
  const sale = underwrite(kestrel, policyFor(kestrel));
  const saleBase = sale.scenarios[0]!.metrics;
  const STRESS_NAMES = {
    en: ["Prices -10%", "Sales pace × 0.70", "Costs +10%", "Interest rates +1 point", "Construction +6 months", "Presales -15 points"],
    fr: ["Prix -10 %", "Rythme de vente × 0,70", "Coûts +10 %", "Taux d'intérêt +1 point", "Construction +6 mois", "Préventes -15 points"],
  } as const;

  it.each(["en", "fr"] as const)("gives every sale key figure one plain sentence in sale words, in %s", (lang) => {
    s.lang = lang;
    s.run = run({ result: sale, policyVersion: "for-sale-draft" });
    const i = build(lang, () => {});
    const html = render();
    const words = text(html);
    const layout = layoutFor(saleBase);
    const figures = layout.headline.filter((k) => saleBase.some((m) => m.key === k));
    expect(figures).toEqual(expect.arrayContaining(["profit_on_cost_for_sale", "margin_on_revenue", "peak_equity", "sellout_month", "equity_multiple"]));
    for (const k of figures) {
      const plain = meaning(i, k, layout.sale);
      expect(plain, k).toBeTruthy();
      expect(words, k).toContain(sp(plain!));
    }
    expect(html.match(/class="run-fig-meaning"/g)!.length).toBe(figures.length);
    // The total cost of a sale stops at completion; nothing is leased up.
    expect(meaning(i, "total_development_cost", true)).toBe(i.t("run.meaning.total_development_cost_sale"));
    expect(words).not.toContain(sp(i.t("run.meaning.total_development_cost")));
    expect(meaning(i, "total_development_cost")).toBe(i.t("run.meaning.total_development_cost"));
    expect(i.t("run.meaning.total_development_cost_sale")).not.toMatch(/lease|location/i);
    expect(i.t("run.meaning.sellout_month")).toBe(lang === "en" ? "The month the last unit closes." : "Le mois où la vente du dernier logement est conclue.");
  });

  it.each(["en", "fr"] as const)("names every sale stress in plain words, in %s", (lang) => {
    s.lang = lang;
    s.run = run({ result: sale, policyVersion: "for-sale-draft" });
    const words = text(render());
    for (const name of STRESS_NAMES[lang]) expect(words).toContain(sp(name));
    expect(words).not.toMatch(/Absorption -30|-15 pts|\+100 bps|\+100 pb/);
  });
});
