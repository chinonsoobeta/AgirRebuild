import { describe, expect, it } from "vitest";
import type { EngineInput, ReadinessItem } from "@agir/contracts";
import { assemble, validateInput, EngineInputError } from "../../../packages/engine/src/index.ts";
import validateSource from "../../../packages/engine/src/validate.ts?raw";
import { allEquityDeal } from "../../../packages/engine/test/fixtures.ts";
import { FIELDS } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { reviewWaiting } from "../src/components/ui.tsx";
import { approvable, enteredInUnit, foreignIn, keepsWithReason } from "../src/routes/review.tsx";
import { describeEvent } from "../src/routes/audit.tsx";
import { build, checkText, dealStatus, translateMessage, verdictText, type Key } from "../src/i18n.tsx";

describe("a run's source labels in French", () => {
  it("translates the line a value was read from", () => {
    expect(translateMessage("plans.txt, line 2")).toBe("plans.txt, ligne 2");
    expect(translateMessage("memo.pdf, page 3, line 14")).toBe("memo.pdf, page 3, ligne 14");
  });

  it("says a value was converted from square metres, wherever it was read", () => {
    expect(translateMessage('plans.txt, line 2, converted from square metres ("1,000 m²")'))
      .toBe("plans.txt, ligne 2, converti de mètres carrés (« 1,000 m² »)");
    expect(translateMessage('rent-roll.xlsx, Rent roll!C5, converted from square metres ("84")'))
      .toBe("rent-roll.xlsx, Rent roll!C5, converti de mètres carrés (« 84 »)");
  });
});

describe("a figure in another currency, on review", () => {
  const src = (unit_seen: string | null) => ({ unit_seen }) as Parameters<typeof foreignIn>[0];
  it("the note and the conflict card apply only when the code differs from the deal's currency, or the deal has none", () => {
    expect(foreignIn(src("USD"), "CAD")).toBe("USD");
    expect(foreignIn(src("$/mo USD"), "CAD")).toBe("USD");
    expect(foreignIn(src("CAD"), "CAD")).toBeUndefined();
    expect(foreignIn(src("$/mo CAD"), "CAD")).toBeUndefined();
    expect(foreignIn(src("USD"), null)).toBe("USD");
    expect(foreignIn(src("CAD"), null)).toBe("CAD");
    expect(foreignIn(src("$"), null)).toBeUndefined();
    expect(foreignIn(src(null), "CAD")).toBeUndefined();
  });
  it("the reason for a deal with no stated currency is translated, with one or two codes", () => {
    expect(translateMessage("A document states this in USD; this deal does not state its currency. Enter the amount."))
      .toBe("Un document l'indique en USD ; ce dossier n'indique pas sa devise. Saisissez le montant.");
    expect(translateMessage("A document states this in USD and AUD; this deal does not state its currency. Enter the amount."))
      .toBe("Un document l'indique en USD et AUD ; ce dossier n'indique pas sa devise. Saisissez le montant.");
  });
});

describe("the plain-language layer", () => {
  const en = build("en", () => {});
  const fr = build("fr", () => {});

  it("shows DCR for DSCR, as a whole word only", () => {
    expect(en.msg("Base-case sizing DSCR of 1.05x is under the 1.20x floor.")).toBe("Base-case sizing DCR of 1.05x is under the 1.20x floor.");
    expect(en.msg("DSCRX and ADSCR and min_dscr stay")).toBe("DSCRX and ADSCR and min_dscr stay");
    expect(en.L.metric("sizing_dscr")).toBe("Sizing DCR (weakest year)");
    expect(en.L.gate("stressed_sizing_dscr", "Sizing DSCR, combined stress")).toBe("Sizing DCR, combined stress");
    expect(en.L.stress("x", "DSCR stress")).toBe("DCR stress");
    expect(en.L.field("min_dscr_covenant")).toBe("Minimum DCR covenant");
    const c = { key: "k", kind: "k", severity: "error", message: "The DSCR is low." };
    expect(checkText(en, c)).toBe("The DCR is low.");
    const verdict = { code: "REJECT", hardFailReasons: ["DSCR is under the floor."], gates: [] };
    expect(verdictText(en, verdict, []).explanation).toBe("DCR is under the floor.");
  });

  it("shows CCD for RCSD in French, as a whole word only", () => {
    expect(fr.L.metric("sizing_dscr")).toBe("CCD de dimensionnement (pire année)");
    expect(fr.L.gate("stressed_sizing_dscr", "x")).toBe("CCD de dimensionnement, stress combiné");
    expect(fr.msg("Le RCSD baisse ; RCSDX reste")).toBe("Le CCD baisse ; RCSDX reste");
    const c = { key: "base_sizing_dscr", kind: "k", severity: "error", message: "", expected: 1.2, actual: 1.05 };
    expect(checkText(fr, c)).toContain("Le CCD de dimensionnement");
  });

  it("renders the mezzanine accrual check in French, with the balance at stabilization", () => {
    const c = { key: "mezz_interest_accrued", kind: "bound", severity: "warning", message: "", expected: 5_000_000, actual: 250_000 };
    const text = checkText(fr, c);
    expect(text).toContain("mezzanine");
    expect(text).not.toMatch(/\b(accrues|commitment|stabilization)\b/);
    expect(text).toContain(fr.f.value(250_000, "$"));
    expect(text).toContain(fr.f.value(5_000_000, "$"));
    expect(text).toContain(fr.f.value(5_250_000, "$"));
  });

  it("has French text for the lease-up cost, the cash shortfall and the interest-only coverage", () => {
    for (const k of ["leaseup_operating_cost", "cumulative_cash_shortfall", "io_dscr_year1"]) {
      expect(fr.L.metric(k), k).not.toBe(k);
      expect(fr.L.metric(k), k).not.toBe(en.L.metric(k));
      expect(fr.L.formula(k).length, k).toBeGreaterThan(10);
      expect(fr.L.formula(k), k).not.toBe(en.L.formula(k));
    }
  });

  it("has English and French text for a deal that is kept and refinanced (card 60)", () => {
    for (const k of ["refinance_cash_returned", "cash_left_in_deal", "dcr_after_refinance", "cash_on_cash_after_refinance", "stated_value", "unrealized_equity_multiple", "unrealized_equity_irr"]) {
      expect(fr.L.metric(k), k).not.toBe(k);
      expect(fr.L.metric(k), k).not.toBe(en.L.metric(k));
      expect(fr.L.formula(k).length, k).toBeGreaterThan(10);
      expect(fr.L.formula(k), k).not.toBe(en.L.formula(k));
    }
    expect(en.L.metric("dcr_after_refinance")).toBe("Coverage after refinance (DCR)");
    expect(fr.L.metric("stated_value")).toMatch(/non réalisée/);
    expect(fr.L.field("refinance_and_hold")).not.toBe(en.L.field("refinance_and_hold"));
    expect(fr.L.absent("refinance_and_hold")).not.toBe(en.L.absent("refinance_and_hold"));
    expect(en.t("run.draftPolicy")).toBe("Draft policy, not signed by credit");
    expect(fr.t("run.draftPolicy")).toMatch(/provisoire/);
    for (const g of ["dcr_after_refinance", "stressed_unrealized_equity_multiple"]) expect(fr.L.gate(g, "x"), g).not.toBe("x");
    expect(fr.msg("The deal is kept and refinanced, not sold.")).not.toBe("The deal is kept and refinanced, not sold.");
    const wipe = { key: "equity_wipeout", kind: "bound", severity: "error", message: "The stated value of $200,000 does not cover the $720,000 of debt outstanding. Equity has no value at the end of the hold.", expected: 720_000, actual: 200_000 };
    expect(checkText(en, wipe)).toBe(wipe.message);
    expect(checkText(fr, wipe)).not.toMatch(/does not cover|stated value/);
    expect(checkText(fr, wipe)).toContain(fr.f.value(200_000, "$"));
    const four = { code: "APPROVE", hardFailReasons: [], gates: ["a", "b", "c", "d"].map((key) => ({ key, label: key, status: "passed" })) };
    expect(verdictText(en, four, []).headline).toBe("All four gates pass.");
    expect(verdictText(fr, four, []).headline).toBe("Les quatre seuils sont respectés.");
  });

  it("keeps the institutional term in the glossary", () => {
    expect(en.t("glossary.dcr")[0]).toBe("DCR (debt coverage ratio), called DSCR by many lenders");
    expect(fr.t("glossary.dcr")[0]).toBe("CCD (coefficient de couverture de la dette), appelé RCSD par de nombreux prêteurs");
  });

  it("defines every term in both languages", () => {
    const keys: Key[] = ["glossary.dcr", "glossary.noi", "glossary.capRate", "glossary.yieldOnCost", "glossary.loanToCost", "glossary.equityIrr", "glossary.equityMultiple", "glossary.breakEven"];
    for (const k of keys) for (const i of [en, fr]) expect(i.t(k)[1].length).toBeGreaterThan(20);
  });

  it("calls the decision the owner's own when the review is solo", () => {
    expect(en.t("next.decideSolo")).toBe("Record your decision");
    expect(en.t("decision.titleSolo")).toBe("Your decision");
    expect(en.t("next.decide")).toBe("Record the committee decision");
    expect(fr.t("decision.titleSolo")).toBe("Votre décision");
    const gates = [{ key: "g", label: "G", status: "failed" }];
    expect(verdictText(en, { code: "APPROVE_WITH_CONDITIONS", hardFailReasons: [], gates }, [], true).headline).toBe("1 gate fails. You set the conditions.");
    expect(verdictText(en, { code: "APPROVE_WITH_CONDITIONS", hardFailReasons: [], gates }, []).headline).toBe("1 gate fails. The committee sets conditions.");
  });
});

describe("the quick start's gaps", () => {
  const docs = (total: number, processing = 0) => ({ total, processing, failed: 0 });
  const rev = (o: Partial<{ approved: number; needsReview: number; conflicting: number; awaitingSecond: number }> = {}) =>
    ({ approved: 0, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "blocked" as const, ...o });

  it("waits for documents only when there are none and no values, or while reading", () => {
    expect(reviewWaiting({ documents: docs(0), review: rev() })).toBe(true);
    expect(reviewWaiting({ documents: docs(0), review: rev({ approved: 12 }) })).toBe(false);
    expect(reviewWaiting({ documents: docs(0), review: rev({ awaitingSecond: 1 }) })).toBe(false);
    expect(reviewWaiting({ documents: docs(0), review: rev({ needsReview: 1 }) })).toBe(false);
    expect(reviewWaiting({ documents: docs(2, 1), review: rev({ approved: 12 }) })).toBe(true);
    expect(reviewWaiting({ documents: docs(2), review: rev() })).toBe(false);
  });

  it("has French for what every optional field means when it is not asked", () => {
    const fr = build("fr", () => {});
    for (const d of FIELDS.filter((x) => x.absentMeans)) {
      expect(fr.L.absent(d.key), d.key).not.toBe(d.absentMeans);
      expect(build("en", () => {}).L.absent(d.key)).toBe(d.absentMeans);
    }
    expect(fr.L.absent("rent_growth_pct")).toBe("loyers stables");
  });

  it("says a line was not found, in a sentence with no number, in both languages", () => {
    const line = (lang: "en" | "fr", key: string) => {
      const i = build(lang, () => {});
      return i.t("review.notFoundLine", { field: i.L.field(key), meaning: i.L.absent(key) });
    };
    expect(line("en", "other_income_annual")).toBe("Other income \u2014 not found. The run treats this as: no other income.");
    expect(line("fr", "other_income_annual")).toContain("introuvable");
    expect(line("fr", "other_income_annual")).toContain("aucun autre revenu");
    for (const lang of ["en", "fr"] as const) {
      for (const d of FIELDS.filter((x) => x.absentMeans)) expect(line(lang, d.key), d.key).not.toMatch(/\d/);
    }
    expect(build("en", () => {}).t("review.notFound")).toBe("Not found in the documents");
    expect(build("fr", () => {}).t("review.notFound")).toBe("Introuvable dans les documents");
  });

  it("offers the choices only a person makes, and a flag as yes or no, in both languages", () => {
    const en = build("en", () => {});
    const fr = build("fr", () => {});
    expect(en.t("review.choices")).toBe("Choices only you make");
    expect(fr.t("review.choices")).toBe("Choix qui vous reviennent");
    expect(en.t("review.choicesBody")).toBe("Agir never reads these from documents. If you leave one, the run uses what it says.");
    expect(fr.t("review.choicesBody")).not.toBe(en.t("review.choicesBody"));
    expect(en.t("review.choiceLine", { field: "X", meaning: "Y" })).toBe("X: not stated. The run treats this as: Y.");
    expect(fr.t("review.choiceLine", { field: "X", meaning: "Y" })).toContain("Y");
    expect(fr.t("review.choiceLine", { field: "X", meaning: "Y" })).not.toBe(en.t("review.choiceLine", { field: "X", meaning: "Y" }));
    expect(en.t("review.choiceEnter")).toBe("Make this choice");
    expect(fr.t("review.choiceEnter")).toBe("Faire ce choix");
    expect([en.t("common.yes"), en.t("common.no"), fr.t("common.yes"), fr.t("common.no")]).toEqual(["Yes", "No", "Oui", "Non"]);
    // A flag chosen as yes or no is posted as 1 or 0.
    expect([en.f.parse("1"), en.f.parse("0"), fr.f.parse("1"), fr.f.parse("0")]).toEqual([1, 0, 1, 0]);
    expect(enteredInUnit("flag", false, 1, "because", "en")).toEqual({ value: 1, reason: "because" });
  });

  it("converts an area or a rent entered in square metres, and records it", () => {
    const a = enteredInUnit("sf", true, 870, "from the plans", "en");
    expect(a.value).toBeCloseTo(870 * SF_PER_M2, 9);
    expect(a.reason).toBe("from the plans (entered as 870 m²)");
    const r = enteredInUnit("$/sf/yr", true, 107.64, "broker letter", "fr");
    expect(r.value).toBeCloseTo(107.64 / SF_PER_M2, 9);
    expect(r.reason).toBe("broker letter (saisi en 107,64 $/m²/an)");
    expect(enteredInUnit("sf", false, 870, "from the plans", "en")).toEqual({ value: 870, reason: "from the plans" });
    expect(enteredInUnit("$", true, 5, "x".repeat(10), "en")).toEqual({ value: 5, reason: "x".repeat(10) });
  });
});

// ---- The validator's and readiness's sentences, in French ---------------------------------------
describe("every sentence the engine's checks can produce has a French rendering", () => {
  const problems = (change: (d: EngineInput) => void): string[] => {
    const d = allEquityDeal();
    change(d);
    try {
      validateInput(d);
    } catch (e) {
      if (e instanceof EngineInputError) return e.problems;
      throw e;
    }
    return [];
  };
  const loanDeal = (): EngineInput => {
    const d = allEquityDeal();
    d.senior = { amount: 500_000, ratePct: 5, amortYears: 30, ioMonths: 0 };
    return d;
  };
  const withLoan = (which: "senior" | "mezzanine" | "refinance", bad: Record<string, number>) => (d: EngineInput) => {
    const l = { amount: 500_000, ratePct: 5, amortYears: 30, ioMonths: 0, ...bad };
    if (which === "senior") d.senior = l;
    else if (which === "mezzanine") d.mezzanine = l;
    else { d.holdYears = 5; d.refinance = { month: 12, amount: l.amount, ratePct: l.ratePct, amortYears: l.amortYears, ioMonths: l.ioMonths }; }
  };
  const rev = (c: Partial<EngineInput["revenue"][number]>) => (d: EngineInput) => { d.revenue = [{ ...d.revenue[0]!, ...c }]; };
  const perSf = { basis: "per_sf" as const, areaSf: 1000, rentPsfAnnual: 30 };

  // One entry per `p.push(` in validate.ts, in the order it is written.
  const SITES: [string, (d: EngineInput) => void][] = [
    ["budget", (d) => { d.budget.land = -1; }],
    ["credit takes the total to 0", (d) => { d.budget = { land: 0, hard: 100, soft: 0, contingency: 0, other: -100 }; }],
    ["credit exceeds the construction costs", (d) => { d.budget = { land: 1_000, hard: 100, soft: 0, contingency: 0, other: -200 }; }],
    ["no revenue", (d) => { d.revenue = []; }],
    ["unit count", rev({ units: 0 })],
    ["monthly rent", rev({ rentMonthly: -1 })],
    ["area", rev({ ...perSf, areaSf: 0 })],
    ["rent per SF", rev({ ...perSf, rentPsfAnnual: -1 })],
    ["component occupancy", rev({ occupancyPct: 101 })],
    ["construction months", (d) => { d.constructionMonths = 121; }],
    ["lease-up months", (d) => { d.leaseUpMonths = 1.5; }],
    ["hold years", (d) => { d.holdYears = 0; }],
    ["stabilized occupancy", (d) => { d.stabilizedOccupancyPct = 120; }],
    ["no expense basis", (d) => { delete d.expenseRatioPct; }],
    ["both expense bases", (d) => { d.fixedOpexAnnual = 1; }],
    ["exit cap", (d) => { d.exitCapPct = 0; }],
    ["selling costs", (d) => { d.sellingCostsPct = 100; }],
    ["loan amount", withLoan("senior", { amount: -1 })],
    ["loan rate", withLoan("senior", { ratePct: -1 })],
    ["loan amortization", withLoan("senior", { amortYears: 51 })],
    ["loan interest-only", withLoan("senior", { ioMonths: 601 })],
    ["refinance month", (d) => { d.holdYears = 5; d.refinance = { month: 100, amount: 1, ratePct: 5, amortYears: 30, ioMonths: 0 }; }],
    ["refinance amount or LTV", (d) => { d.holdYears = 5; d.refinance = { month: 12, ratePct: 5, amortYears: 30, ioMonths: 0 }; }],
    ["refinance and hold without a refinance", (d) => { d.exit = "refinance_hold"; }],
    ["LP share", (d) => { d.waterfall = { lpSharePct: 0, preferredReturnPct: 8, gpPromotePct: 20 }; }],
    ["preferred return", (d) => { d.waterfall = { lpSharePct: 90, preferredReturnPct: -1, gpPromotePct: 20 }; }],
    ["GP promote", (d) => { d.waterfall = { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 101 }; }],
    ["property tax", (d) => { d.propertyTaxAnnual = -1; }],
    ["refinance insurance premium", (d) => { d.refinance = { month: 24, amount: 1_000, ratePct: 5, amortYears: 25, ioMonths: 0, insurancePremiumPct: 11 }; }],
  ];
  const EXTRA: [string, (d: EngineInput) => void][] = [
    ["optional budget line", (d) => { d.budget.developmentCharges = -1; }],
    ["mezzanine loan", withLoan("mezzanine", { amount: -1 })],
    ["mezzanine rate", withLoan("mezzanine", { ratePct: -1 })],
    ["refinance loan", withLoan("refinance", { amortYears: 51 })],
    ["refinance loan IO", withLoan("refinance", { ioMonths: 601 })],
    ["component named by key", (d) => { d.revenue = [{ ...d.revenue[0]!, label: "", key: "2BR", units: 0 }]; }],
  ];

  it("the table has a case for every p.push in validate.ts", () => {
    expect(SITES.length).toBe((validateSource.match(/\bp\.push\(/g) ?? []).length);
  });

  it.each([...SITES, ...EXTRA])("%s: each sentence is rendered in French", (_name, change) => {
    const found = problems(change);
    expect(found.length).toBeGreaterThan(0);
    for (const sentence of found) {
      const fr = translateMessage(sentence);
      expect(fr, sentence).not.toBe(sentence);
      expect(fr, sentence).not.toMatch(/\b(must|needs|give|the|and|between|required|from|to|least|above|under|months|years)\b/);
    }
  });

  it("carries the numbers and names over, with French typography", () => {
    expect(translateMessage("refinance month must fall from stabilization (month 32) to before the sale (month 91)"))
      .toBe("Le mois du refinancement doit se situer entre la stabilisation (mois 32) et la vente (mois 91), avant celle-ci");
    expect(translateMessage('revenue component "Studio" needs a monthly rent')).toBe("La composante de revenus « Studio » exige un loyer mensuel");
    expect(translateMessage("stabilized occupancy must be between 0 and 100")).toBe("L'occupation stabilisée doit se situer entre 0\u00a0% et 100\u00a0%");
    expect(translateMessage("senior loan amortization must be 1 to 50 years")).toBe("L'amortissement du prêt principal doit être de 1 à 50 ans");
    expect(translateMessage("below the minimum of 0.5")).toBe("inférieur au minimum de 0,5");
  });
});

describe("the review card in French", () => {
  const fr = build("fr", () => {});
  const en = build("en", () => {});
  const row = (fieldKey: string, itemKey: string | null, valueNumeric: number) => ({ fieldKey, itemKey, status: "approved" as const, valueNumeric });
  const show = (i: ReturnType<typeof build>, item: ReadinessItem): string => i.L.item(item);

  it("shows a missing rent with the French field label and the item in parentheses", () => {
    const { readiness } = assemble([row("unit_count", "Studio", 4)]);
    const rent = readiness.missing.find((m) => m.fieldKey === "unit_rent_monthly")!;
    expect(show(fr, rent)).toBe("Loyer par logement par mois (Studio)");
    expect(show(en, rent)).toBe("Rent (Studio)");
  });

  it("shows an impossible value with the French field label and the reason", () => {
    const { readiness } = assemble([row("hard_cost", null, -5), row("construction_months", null, 1.5)]);
    const hard = readiness.impossible.find((m) => m.fieldKey === "hard_cost")!;
    expect(show(fr, hard)).toBe("Coûts directs\u00a0: inférieur au minimum de 0");
    expect(show(en, hard)).toBe(`${hard.label}: ${hard.detail}`);
    const months = readiness.impossible.find((m) => m.fieldKey === "construction_months")!;
    expect(show(fr, months)).toBe("Durée de construction\u00a0: doit être un nombre entier");
  });

  it("shows a refinance-timing problem in French, and the same sentence in English as before", () => {
    const sentence = "refinance month must fall from stabilization (month 32) to before the sale (month 91)";
    const item: ReadinessItem = { fieldKey: "refinance_month", label: sentence };
    expect(show(fr, item)).toBe("Le mois du refinancement doit se situer entre la stabilisation (mois 32) et la vente (mois 91), avant celle-ci");
    expect(show(en, item)).toBe("Refinance month must fall from stabilization (month 32) to before the sale (month 91)");
  });

  it("audit of task 60d: says in French that one item is written two ways, and what to do", () => {
    const { readiness } = assemble([row("unit_count", "Retail", 2), row("unit_rent_monthly", "Retail", 3000), row("unit_count", "retail", 2), row("unit_rent_monthly", "retail", 3000)]);
    const item = readiness.impossible.find((m) => m.label.endsWith("written two ways"))!;
    expect(show(en, item)).toBe("Retail and retail are one item written two ways: Reject the values of one, or enter them under one name.");
    expect(show(fr, item)).toBe("Retail et retail désignent un même élément écrit de deux façons\u00a0: rejetez les valeurs de l'un, ou saisissez-les sous un seul nom.");
  });

  it("audit of task 60d: counts what cannot be run as values to correct, since not every one is out of range", () => {
    const [enT, frT] = [build("en", () => {}).t, build("fr", () => {}).t];
    expect(enT("review.b.impossible", { n: 1 })).toBe("1 input needs correcting");
    expect(frT("review.b.impossible", { n: 2 })).toBe("2 données doivent être corrigées");
    expect(enT("status.outOfRange", { n: 1 })).toBe("1 to correct");
    expect(frT("status.outOfRange", { n: 1 })).toBe("1 à corriger");
  });
});

describe("breakeven rows in both languages (task 38)", () => {
  const gate = { key: "profit_on_cost", label: "Profit on cost", threshold: 15, unit: "%" };
  const echo = { rentPct: { key: "rent", item: "1BR", from: 2200, to: 2605, unit: "$/unit/mo" }, costPct: { key: "cost", from: 42_000_000, to: 38_000_000, unit: "$" }, exitCapBps: { key: "exit_cap", from: 5, to: 4.2, unit: "%" }, rateBps: { key: "senior_rate", from: 6, to: 4.5, unit: "%" }, occupancyPts: { key: "occupancy", from: 95, to: 99, unit: "%" } } as const;
  const shock = { rentPct: 18.4, costPct: -9.5, exitCapBps: -80, rateBps: -150, occupancyPts: 4 } as const;
  const limit = { rentPct: 100, costPct: -50, exitCapBps: -300, rateBps: -600, occupancyPts: 5 } as const;
  const rowOf = (driver: keyof typeof shock, state: string) => ({
    gate: gate.key, driver, state, shock: state === "value" ? shock[driver] : null, limit: limit[driver], actual: state === "value" ? 15.2 : null, to: state === "value" ? [echo[driver]] : [], reason: state === "value" ? undefined : "x",
  });
  const en = build("en", () => {});
  const fr = build("fr", () => {});

  it("every driver and every state has a sentence, in English and in French", () => {
    for (const d of Object.keys(shock) as (keyof typeof shock)[]) {
      for (const state of ["value", "out_of_range", "no_effect", "not_monotonic"]) {
        const a = en.L.breakeven(rowOf(d, state) as any, gate);
        const b = fr.L.breakeven(rowOf(d, state) as any, gate);
        expect(a, `${d} ${state}`).toBeTruthy();
        expect(b, `${d} ${state}`).toBeTruthy();
        expect(b, `${d} ${state}`).not.toBe(a);
        expect(b, `${d} ${state}`).not.toMatch(/\b(would need|Not within|does not|Other inputs|Rents|Interest rates|Occupancy|Development costs|exit cap)\b/);
      }
    }
  });
  it("the rent sentence says how much, in the deal's own terms, and that other inputs are held", () => {
    const a = en.L.breakeven(rowOf("rentPct", "value") as any, gate);
    expect(a).toBe("Rents would need to be 18.4% higher (1BR: $2,605/mo) for profit on cost to reach 15.00%. Other inputs are held; moves together interact.");
    const b = fr.L.breakeven(rowOf("rentPct", "value") as any, gate);
    expect(b).toContain("18,4\u00a0%");
    expect(b).toContain("2\u00a0605");
    expect(b).toContain("15,00\u00a0%");
    expect(b).toContain("pour que profit sur coût atteigne");
  });
  it("a computed rent shows its cents, and 'no effect' names the range searched (audit)", () => {
    const row = { ...rowOf("rentPct", "value"), to: [{ ...echo.rentPct, to: 3095.2 }] };
    expect(en.L.breakeven(row as any, gate)).toContain("(1BR: $3,095.20/mo)");
    expect(fr.L.breakeven(row as any, gate)).toContain("3\u00a0095,20\u00a0$/mois");
    expect(en.L.breakeven(rowOf("costPct", "no_effect") as any, gate)).toMatch(/^Within -50.*does not change/);
    expect(fr.L.breakeven(rowOf("costPct", "no_effect") as any, gate)).toMatch(/^Dans les limites de -50/);
  });
  it("a gate name keeps its acronym and only loses a leading capital", () => {
    const dcr = { key: "stressed_sizing_dscr", label: "Sizing DSCR, combined stress", threshold: 1.2, unit: "x" };
    expect(en.L.breakeven(rowOf("rentPct", "value") as any, dcr)).toContain("for sizing DCR, combined stress to reach 1.20x");
    expect(fr.L.breakeven(rowOf("rentPct", "value") as any, dcr)).toContain("pour que CCD de dimensionnement");
  });
  it("a state with no number says why, and out of range names the limit", () => {
    expect(en.L.breakeven(rowOf("rentPct", "out_of_range") as any, gate)).toBe("Not within +100%");
    expect(en.L.breakeven(rowOf("rentPct", "not_monotonic") as any, gate)).toBe("The gate does not move steadily with this input; use the grid.");
    expect(fr.L.breakeven(rowOf("rentPct", "out_of_range") as any, gate)).toContain("+100\u00a0%");
  });
  it("the hard-fail notice says the gates alone would not change the verdict", () => {
    expect(en.t("explore.be.hardFail")).toMatch(/passing the gates alone would not change the verdict/i);
    expect(fr.t("explore.be.hardFail")).toMatch(/ne changerait pas le verdict/i);
  });
});

describe("task 60c: adding a unit type or space on review", () => {
  const keys = ["review.addItem", "review.addItemName", "review.addItemPerUnit", "review.addItemPerSf"];
  it("has its strings in both languages, and the French is not the English", () => {
    const en = build("en", () => {});
    const fr = build("fr", () => {});
    for (const k of keys) {
      expect(en.t(k as Key), k).not.toBe(k);
      expect(fr.t(k as Key), k).not.toBe(k);
      expect(fr.t(k as Key), k).not.toBe(en.t(k as Key));
    }
    expect(en.t("review.addItem" as Key)).toBe("Add a unit type or space");
    expect(fr.t("review.addItem" as Key)).toBe("Ajouter un type de logement ou d'espace");
  });
});

describe("audit of task 60c: the refusal of a type the deal has, in French", () => {
  it("is translated, keeping the type's name", () => {
    expect(translateMessage("This deal already has 3BR; change its values instead.")).toBe("Ce projet a déjà 3BR ; modifiez plutôt ses valeurs.");
  });
});

describe("card 61: Canadian cost lines and the insurance premium, in both languages", () => {
  const en = build("en", () => {});
  const fr = build("fr", () => {});
  const KEYS = ["development_charges", "land_transfer_tax", "gst_hst_net", "property_tax_annual", "refinance_insurance_premium_pct"];

  it("has a French label, a French help line and a French meaning for each field", () => {
    for (const k of KEYS) {
      const def = FIELDS.find((f) => f.key === k)!;
      expect(fr.L.field(k), k).not.toBe(en.L.field(k));
      expect(fr.L.field(k), k).not.toBe(k);
      expect(en.L.help(k, def.help ?? null), k).toBe(def.help);
      expect(fr.L.help(k, def.help ?? null), k).toBeTruthy();
      expect(fr.L.help(k, def.help ?? null), k).not.toBe(def.help);
      expect(fr.L.absent(k), k).not.toBe(def.absentMeans);
    }
    expect(fr.L.help("property_tax_annual", null)).toMatch(/ratio des charges/);
    // Audit: "redevances" and "droits" are plural, so the help and the meaning agree with them.
    for (const k of ["development_charges", "land_transfer_tax"]) {
      expect(fr.L.help(k, null), k).toBe("Si vos coûts indirects ou autres coûts les incluent déjà, ne les saisissez pas.");
    }
    expect(fr.L.absent("development_charges")).toBe("aucune redevance déclarée");
    expect(fr.L.absent("land_transfer_tax")).toBe("aucun droit déclaré");
  });

  it("asks the quick-start questions in both languages, with a hint that says 0 is an answer", () => {
    for (const k of ["development_charges", "property_tax_annual", "land_transfer_tax", "gst_hst_net"]) {
      const [q] = en.L.ask(k);
      const [qf, hf] = fr.L.ask(k);
      expect(q, k).not.toBe(en.L.field(k));
      expect(qf, k).not.toBe(q);
      expect(hf, k).toBeTruthy();
    }
    expect(en.L.ask("development_charges")[1]).toMatch(/Enter 0/);
    expect(en.L.ask("property_tax_annual")[1]).toMatch(/Enter 0/);
    expect(fr.L.ask("development_charges")[1]).toMatch(/Saisissez 0/);
  });

  it("states the premium's metric in French", () => {
    expect(fr.L.metric("refinance_premium_added")).not.toBe("refinance_premium_added");
    expect(fr.L.metric("refinance_premium_added")).not.toBe(en.L.metric("refinance_premium_added"));
    expect(fr.L.formula("refinance_premium_added").length).toBeGreaterThan(10);
    expect(fr.L.formula("refinance_premium_added")).not.toBe(en.L.formula("refinance_premium_added"));
  });

  it("renders the engine's new refusals in French", () => {
    expect(translateMessage("budget developmentCharges must be a number of at least 0")).toBe("Le poste « redevances de développement » du budget doit être un nombre positif ou nul");
    expect(translateMessage("budget landTransferTax must be a number of at least 0")).toMatch(/^Le poste « .+ » du budget doit être un nombre positif ou nul$/);
    expect(translateMessage("budget gstHstNet must be a number of at least 0")).toMatch(/^Le poste « .+ » du budget doit être un nombre positif ou nul$/);
    expect(translateMessage("property tax must be a number of at least 0")).toBe("La taxe foncière doit être un nombre positif ou nul");
    expect(translateMessage("refinance insurance premium must be a number from 0 to 10")).toBe("La prime d'assurance du refinancement doit se situer entre 0 % et 10 %");
  });
});

// The server's overview reads a deal with values and no documents from its values (card 59); the web's status line must agree.
describe("a deal's status line when it has values and no documents", () => {
  const [en, fr] = [build("en", () => {}), build("fr", () => {})];
  const overview = (review: Partial<{ approved: number; needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number }>, status = "blocked") => ({
    step: "review",
    documents: { total: 0, processing: 0, failed: 0 },
    review: { approved: 0, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status, ...review },
    run: null,
    decision: null,
    reports: 0,
  });

  it("says what blocks the run, not that there are no documents", () => {
    const st = dealStatus(en, overview({ approved: 4, missing: 13, impossible: 1 }), true);
    expect(st.text).toBe("Blocked · 13 missing, 1 to correct");
    expect(st.next).toBe("Enter 13 missing inputs");
    expect(st.blockedParts).toEqual(["13 missing", "1 to correct"]);
    expect(dealStatus(fr, overview({ approved: 4, missing: 13, impossible: 1 }), true).text).toBe("Bloqué · 13 manquantes, 1 à corriger");
  });

  it("is ready to run when every value is approved", () => {
    expect(dealStatus(en, overview({ approved: 20 }, "ready"), true).text).toBe("Ready to run");
  });

  it("still asks for documents when the deal has neither documents nor values", () => {
    const st = dealStatus(en, overview({ missing: 13 }), true);
    expect(st.text).toBe("No documents yet");
    expect(st.next).toBe("Upload the deal documents");
  });
});

describe("audit of card 58b: the audit trail says which values a reconcile put back", () => {
  const ev = (payload: Record<string, unknown>) => ({ seq: 1, action: "assumptions.reconciled", entity: "deal", entity_id: null, payload, hash: "", created_at: "", actor: null });
  const en = build("en", () => {});
  const fr = build("fr", () => {});
  it("names each value, in both languages", () => {
    const one = ev({ proposals: 1, changed: 1, restored: 1, restored_values: [{ field: "exit_cap_rate_pct", item: "" }] });
    expect(describeEvent(en, one)).toBe("Updated the review queue from the documents. Put back after a label was removed: Exit cap rate");
    expect(describeEvent(fr, one)).toBe("A mis à jour la file d'examen à partir des documents. Rétablie après le retrait d'une étiquette\u00a0: Taux de capitalisation à la sortie");
    const two = ev({ proposals: 2, changed: 2, restored: 2, restored_values: [{ field: "exit_cap_rate_pct", item: "" }, { field: "hold_years", item: "" }] });
    expect(describeEvent(en, two)).toMatch(/^Updated the review queue from the documents\. Put back after a label was removed: Exit cap rate; /);
    expect(describeEvent(fr, two)).toMatch(/Rétablies après le retrait d'une étiquette\u00a0: Taux de capitalisation à la sortie\u00a0; /);
  });
  it("says a document was removed when one reopened the value, and reads an entry without `by` as a label", () => {
    const doc = ev({ proposals: 0, changed: 1, restored: 1, restored_values: [{ field: "exit_cap_rate_pct", item: "", by: "document" }] });
    expect(describeEvent(en, doc)).toBe("Updated the review queue from the documents. Put back after a document was removed: Exit cap rate");
    expect(describeEvent(fr, doc)).toBe("A mis à jour la file d'examen à partir des documents. Rétablie après le retrait d'un document\u00a0: Taux de capitalisation à la sortie");
    const label = ev({ proposals: 0, changed: 1, restored: 1, restored_values: [{ field: "exit_cap_rate_pct", item: "", by: "label" }] });
    expect(describeEvent(en, label)).toBe("Updated the review queue from the documents. Put back after a label was removed: Exit cap rate");
    const both = ev({ proposals: 0, changed: 2, restored: 2, restored_values: [{ field: "exit_cap_rate_pct", item: "", by: "document" }, { field: "hold_years", item: "" }] });
    expect(describeEvent(en, both)).toBe("Updated the review queue from the documents. Put back after a label was removed: Hold period. Put back after a document was removed: Exit cap rate");
  });
  it("is unchanged when nothing was put back", () => {
    expect(describeEvent(en, ev({ proposals: 1, changed: 0 }))).toBe("Updated the review queue from the documents");
    expect(describeEvent(fr, ev({ proposals: 1, changed: 0 }))).toBe("A mis à jour la file d'examen à partir des documents");
  });
});

describe("audit of card 63: a value no document states any more is kept only with a reason", () => {
  const row = (sources: unknown[], sourceKind = "document") => ({ id: "x", status: "needs_review", sourceKind, sources }) as any;
  it("asks for a reason on a document value with no sources, and not otherwise", () => {
    expect(keepsWithReason(row([]))).toBe(true);
    expect(keepsWithReason(row([{ document_name: "notes.txt" }]))).toBe(false);
  });
  it("leaves such a value out of Approve all", () => {
    const rows = [row([]), row([{ document_name: "a.txt" }]), row([{ document_name: "b.txt" }])];
    expect(approvable(rows)).toEqual([rows[1], rows[2]]);
  });
  it("says so in English and French", () => {
    for (const lang of ["en", "fr"] as const) {
      const t = build(lang, () => {}).t;
      for (const k of ["review.keep", "review.keepHint"] as Key[]) expect(typeof t(k), `${lang} ${k}`).toBe("string");
    }
    expect(build("en", () => {}).t("review.keep" as Key)).toBe("Keep…");
    expect(build("fr", () => {}).t("review.keep" as Key)).toBe("Conserver…");
  });
});

describe("card 58c: every audit action has a sentence in both languages", () => {
  const en = build("en", () => {});
  const fr = build("fr", () => {});
  const ev = (action: string, payload: Record<string, unknown> = {}) => ({ seq: 1, action, entity: "x", entity_id: null, payload, hash: "", created_at: "", actor: null });
  const say = (action: string, payload?: Record<string, unknown>) => [describeEvent(en, ev(action, payload)), describeEvent(fr, ev(action, payload))];

  it("says a label, and removing one", () => {
    expect(say("figure.labelled", { field: "exit_cap_rate_pct", item: "" }))
      .toEqual(["Labelled a figure as Exit cap rate", "A étiqueté un chiffre comme Taux de capitalisation à la sortie"]);
    expect(say("figure.unlabelled")).toEqual(["Removed a figure's label", "A retiré l'étiquette d'un chiffre"]);
  });
  it("says a copy, from both ends", () => {
    expect(say("deal.copied", { name: "Fourplex, variant" })).toEqual(["Copied as Fourplex, variant", "A copié comme Fourplex, variant"]);
    expect(say("deal.created_as_copy", { name: "Fourplex" })).toEqual(["Created as a copy of Fourplex", "A créé comme copie de Fourplex"]);
  });
  it("says the old and new setting in words", () => {
    expect(describeEvent(en, ev("workspace.review_mode_changed", { from: "solo", to: "team" }))).toMatch(/Solo review.*Team review/);
    expect(describeEvent(fr, ev("workspace.review_mode_changed", { from: "solo", to: "team" }))).toMatch(/individuel.*équipe/i);
    expect(describeEvent(en, ev("workspace.label_suggestions_changed", { from: false, to: true }))).toMatch(/off.*on/i);
    expect(describeEvent(fr, ev("workspace.label_suggestions_changed", { from: false, to: true }))).toMatch(/désactiv.*activ/i);
  });
  it("says a reviewer was invited, and that a suggestion step failed", () => {
    expect(say("review.granted", { expires_at: "2026-10-20T00:00:00Z" })).not.toContain("review.granted");
    expect(say("document.suggestions_failed", { class: "APIError", status: 529 })).not.toContain("document.suggestions_failed");
  });
  it("says an assumption action as a word, with the colon as each language writes it", () => {
    const p = { field: "exit_cap_rate_pct", item: "", to_value: 5.5, reason: "Broker opinion of value" };
    const words: Record<string, [string, string]> = {
      enter: ["Entered", "Valeur saisie"], approve: ["Approved", "Approuvée"], resolve: ["Resolved", "Conflit résolu"], modify: ["Modified", "Valeur modifiée"],
      second_approve: ["Confirmed by a second approver", "Confirmée par un second approbateur"], reject: ["Rejected", "Rejetée"], reopen: ["Reopened", "Rouverte"],
      accept_default: ["Default accepted", "Valeur par défaut acceptée"], override_pending_second_approval: ["Override waiting for a second approver", "Dérogation en attente"],
      copied: ["Copied", "Copiée"],
    };
    for (const [a, [e, f]] of Object.entries(words)) {
      const [english, french] = say(`assumption.${a}`, p);
      expect(english, a).toMatch(new RegExp(`^${e}: Exit cap rate = `));
      expect(french, a).toMatch(new RegExp(`^${f} : Taux de capitalisation à la sortie = `));
    }
  });
  it("still prints the key of an action it has no sentence for", () => {
    expect(say("something.new")).toEqual(["something.new", "something.new"]);
  });

  // Every action name the code can write: a new one without a sentence fails here.
  const sources = Object.values({
    ...import.meta.glob("../../../packages/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }),
    ...import.meta.glob(["../../../apps/*/src/**/*.{ts,tsx}", "../../../packages/*/src/**/*.ts"], { query: "?raw", import: "default", eager: true }),
  }) as string[];
  const written = (() => {
    const out = new Set<string>();
    for (const text of sources) {
      for (const m of text.matchAll(/agir_audit\(\s*[^,()]+,\s*[^,()]+,\s*'([a-z_.]+)'/g)) out.add(m[1]!);
      for (const m of text.matchAll(/[^_a-zA-Z.]audit\(\s*db,[^,]+,[^,]+,\s*"([a-z_.]+)"/g)) out.add(m[1]!);
      // 'assumption.' || p_action: the action names a review function or the log is given.
      for (const m of text.matchAll(/agir_log_assumption\([^,]+,\s*'([a-z_]+)'/g)) out.add(`assumption.${m[1]}`);
      for (const m of text.matchAll(/p_action = '([a-z_]+)'/g)) out.add(`assumption.${m[1]}`);
    }
    return [...out].sort();
  })();
  it("finds the actions the code writes", () => {
    for (const a of ["deal.created", "figure.labelled", "assumptions.reconciled", "document.suggestions_failed", "document.extracted", "assumption.approve", "assumption.copied", "assumption.enter"]) expect(written, a).toContain(a);
  });
  it("gives each of them a sentence, not the key, in both languages", () => {
    for (const a of written) {
      const [english, french] = say(a, { field: "exit_cap_rate_pct", item: "", name: "x", from: "solo", to: "team", verdict: "go", decision: "proceed", kind: "ic_memo", format: "pdf", run_number: 1, reason: "x", candidates: 1 });
      expect(english, a).not.toBe(a);
      expect(french, a).not.toBe(a);
    }
  });
});
