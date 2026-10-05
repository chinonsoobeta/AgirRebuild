import { describe, expect, it } from "vitest";
import type { EngineInput, ReadinessItem } from "@agir/contracts";
import { assemble, validateInput, EngineInputError } from "../../../packages/engine/src/index.ts";
import validateSource from "../../../packages/engine/src/validate.ts?raw";
import { allEquityDeal } from "../../../packages/engine/test/fixtures.ts";
import { FIELDS } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { reviewWaiting } from "../src/components/ui.tsx";
import { enteredInUnit, foreignIn } from "../src/routes/review.tsx";
import { build, checkText, translateMessage, verdictText, type Key } from "../src/i18n.tsx";

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
    ["LP share", (d) => { d.waterfall = { lpSharePct: 0, preferredReturnPct: 8, gpPromotePct: 20 }; }],
    ["preferred return", (d) => { d.waterfall = { lpSharePct: 90, preferredReturnPct: -1, gpPromotePct: 20 }; }],
    ["GP promote", (d) => { d.waterfall = { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 101 }; }],
  ];
  const EXTRA: [string, (d: EngineInput) => void][] = [
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
