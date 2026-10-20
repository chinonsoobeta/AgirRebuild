import { describe, expect, test, vi } from "vitest";
import { SF_PER_M2 } from "@agir/numbers";
import { assemble, type AssumptionRow } from "@agir/engine";
import { WAIVED_NOTE, applyLabels, itemFold, applySuggestions, consolidate, extractCandidates, offerable, offeredIds, figureOrder, withoutLabelled, normalizeLabel, parseDocument, scoreExtraction, type Cell, type NormalizedDocument, type SourcedCandidate, type Table } from "../src/index.ts";
import { MAX_PDF_PAGES, pdfPageError, relativeLinks } from "../src/parse.ts";
import { loadOracles, toNormalized } from "./oracle.ts";

const key = (f: string, i: string | null) => (i ? `${f}|${i}` : f);

const contentScopeCases: { name: string; lines: string[]; expected: [string, number][] }[] = [
  { name: "card English insured summary", lines: ["Birchwood Row | insured mortgage summary", "Permanent loan funds at the refinance in month 30 after construction start.", "Sizing loan-to-value: 75% of appraised value.", "Annual interest rate: 4.15%.", "Amortization: 45 years.", "Interest-only period: 0 months; payments start at the refinance."], expected: [["refinance_month", 30], ["refinance_ltv_pct", 75], ["refinance_rate_pct", 4.15], ["refinance_amort_years", 45], ["refinance_io_months", 0]] },
  { name: "card French insured summary", lines: ["Résidences du Ruisseau - sommaire du prêt assuré", "Le refinancement a lieu au mois 30 après le début des travaux.", "Amortissement : 45 ans.", "Période d’intérêt seulement : 0 mois; les versements commencent au refinancement."], expected: [["refinance_amort_years", 45], ["refinance_io_months", 0]] },
  { name: "Cypress payment overview", lines: ["Cypress Steps | financing overview", "Refinance in month 32 after construction start.", "Monthly payments begin at the refinance.", "Interest rate: 5.05%.", "Amortization: 35 years.", "Interest-only period: 2 months.", "Sizing loan-to-value: 70%."], expected: [["refinance_month", 32], ["refinance_rate_pct", 5.05], ["refinance_amort_years", 35], ["refinance_io_months", 2], ["refinance_ltv_pct", 70]] },
  { name: "Hawthorn funding overview", lines: ["Hawthorn Place | lender overview", "The permanent loan funds at the refinance in month 34.", "The refinance starts the payment schedule.", "Interest rate: 4.85%.", "Amortization: 40 years.", "Interest-only period: 3 months."], expected: [["refinance_month", 34], ["refinance_rate_pct", 4.85], ["refinance_amort_years", 40], ["refinance_io_months", 3]] },
  { name: "sommaire des Lilas", lines: ["Les Lilas | aperçu financier", "Le refinancement est prévu au mois 28 après le début des travaux.", "Les versements mensuels débutent au refinancement.", "Taux d'intérêt : 4,35 %.", "Amortissement : 35 ans.", "Période d’intérêt seulement : 1 mois."], expected: [["refinance_rate_pct", 4.35], ["refinance_amort_years", 35], ["refinance_io_months", 1]] },
  { name: "sommaire des Érables", lines: ["Cour des Érables | aperçu du dossier", "Le refinancement aura lieu au mois 33 après le début des travaux.", "Le calendrier des paiements commence au refinancement.", "Taux d'intérêt : 4,60 %.", "Amortissement : 40 ans.", "Période d’intérêt seulement : 3 mois."], expected: [["refinance_rate_pct", 4.6], ["refinance_amort_years", 40], ["refinance_io_months", 3]] },
];

for (const deal of loadOracles()) {
  describe(`reference deal: ${deal.name}`, () => {
    const all: SourcedCandidate[] = [];
    const others: { doc: string; value: number | null; note?: string }[] = [];
    for (const doc of deal.documents) {
      const r = extractCandidates(toNormalized(doc));
      all.push(...r.candidates.map((c) => ({ ...c, documentId: doc.name, documentName: doc.name })));
      others.push(...r.other.map((o) => ({ doc: doc.name, value: o.value, ...(o.note ? { note: o.note } : {}) })));
    }
    const proposals = consolidate(all);
    // An analyst approves every agreed value and leaves conflicts open.
    const rows: AssumptionRow[] = proposals.map((p) => ({
      fieldKey: p.fieldKey,
      itemKey: p.itemKey,
      status: p.status === "conflicting" ? "conflicting" : "approved",
      valueNumeric: p.value,
    }));
    const { readiness, input } = assemble(rows);

    test("conflicts are exactly the documented ones, each with every value", () => {
      const got = proposals
        .filter((p) => p.status === "conflicting")
        .map((p) => ({ key: key(p.fieldKey, p.itemKey), values: p.values.map((v) => v.value) }))
        .sort((a, b) => a.key.localeCompare(b.key));
      expect(got).toEqual([...deal.expect.conflicts].sort((a, b) => a.key.localeCompare(b.key)));
    });

    test("missing inputs are named", () => {
      const missing = readiness.missing.map((m) => key(m.fieldKey, m.itemKey ?? null)).sort();
      expect(missing).toEqual([...deal.expect.missing].sort());
    });

    if (deal.expect.values) {
      test("every expected value is read at the right magnitude", () => {
        const got = Object.fromEntries(proposals.filter((p) => p.value !== null).map((p) => [key(p.fieldKey, p.itemKey), p.value]));
        for (const [k, v] of Object.entries(deal.expect.values!)) expect(got[k], k).toBeCloseTo(v, 6);
      });
    }

    if (deal.expect.neverValues) {
      test("misreadable figures never become candidates", () => {
        for (const [k, vs] of Object.entries(deal.expect.neverValues!)) {
          for (const v of vs) expect(all.some((c) => key(c.fieldKey!, c.itemKey) === k && c.value === v), `${k}=${v}`).toBe(false);
        }
      });
    }

    if (deal.expect.neverInputs) {
      test("output figures never become candidates", () => {
        for (const v of deal.expect.neverInputs!) expect(all.some((c) => c.value === v)).toBe(false);
      });
    }

    if (deal.expect.teaserNeverCandidates) {
      test("nothing in the broker teaser becomes a candidate", () => {
        for (const d of deal.expect.teaserNeverCandidates!) expect(all.filter((c) => c.documentName === d)).toEqual([]);
        expect(others.filter((o) => deal.expect.teaserNeverCandidates!.includes(o.doc)).length).toBeGreaterThanOrEqual(5);
      });
    }

    test(deal.expect.runs ? "is ready to run" : "is blocked", () => {
      expect(readiness.status).toBe(deal.expect.runs ? "ready" : "blocked");
      expect(input === null).toBe(!deal.expect.runs);
    });

    if (deal.expect.values) {
      test("extraction precision and recall against the golden values", () => {
        const golden = Object.entries(deal.expect.values!).map(([k, value]) => {
          const [fieldKey, itemKey] = k.split("|") as [string, string | undefined];
          return { fieldKey, itemKey: itemKey ?? null, value };
        });
        const s = scoreExtraction(all.filter((c) => golden.some((g) => g.fieldKey === c.fieldKey)), golden);
        expect(s.recall).toBe(1);
        expect(s.incorrect).toEqual([]);
      });
    }
  });
}

describe("square metres become square feet at entry (decision 7)", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const only = (r: ReturnType<typeof extractCandidates>, fieldKey: string) => {
    const found = r.candidates.filter((c) => c.fieldKey === fieldKey);
    expect(found, fieldKey).toHaveLength(1);
    return found[0]!;
  };

  test("an area in m² is read as square feet, and the candidate keeps what the document said", () => {
    const c = only(extractCandidates(doc(["Retail area: 1,000 m²"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Retail", raw: "1,000 m²", unitSeen: "m2" });
    expect(c.value).toBeCloseTo(10_763.91, 2);
  });
  test("a rent per m² is read as a rent per square foot", () => {
    const c = only(extractCandidates(doc(["Retail rent: $366/m²"])), "rent_psf_annual");
    expect(c).toMatchObject({ itemKey: "Retail", unitSeen: "$/m2" });
    expect(c.value).toBe(34);
  });
  test("a component named with an area and a rent in m²", () => {
    const c = only(extractCandidates(doc(["Retail: 836 m² at $366/m²"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Retail", unitSeen: "m2" });
    expect(c.value).toBeCloseTo(8_998.63, 2);
  });
  test("a rent roll whose headers are in m² is converted cell by cell", () => {
    const table: Table = {
      name: "Rent roll",
      rows: [
        [{ text: "Unit type", ref: "A1" }, { text: "Area (m²)", ref: "B1" }, { text: "Rent ($/m²/yr)", ref: "C1" }],
        [{ text: "Retail", ref: "A2" }, { text: "836", number: 836, ref: "B2" }, { text: "366", number: 366, unit: "$", ref: "C2" }],
      ],
    };
    const r = extractCandidates(doc([], [table]));
    const area = only(r, "rentable_area_sf");
    const rent = only(r, "rent_psf_annual");
    expect(area).toMatchObject({ itemKey: "Retail", unitSeen: "m2" });
    expect(area.value).toBeCloseTo(8_998.63, 2);
    expect(rent).toMatchObject({ itemKey: "Retail", unitSeen: "$/m2" });
    expect(rent.value).toBeCloseTo(34.0025, 4);
    expect(r.candidates.some((c) => c.fieldKey === "unit_rent_monthly")).toBe(false);
  });
  test("one document in m² and another in square feet are compared in square feet", () => {
    const a = extractCandidates(doc(["Retail area: 1,000 m²"])).candidates.map((c) => ({ ...c, documentId: "a", documentName: "Plans" }));
    const b = extractCandidates(doc(["Retail area: 10,764 SF"])).candidates.map((c) => ({ ...c, documentId: "b", documentName: "Rent roll" }));
    const [p] = consolidate([...a, ...b]);
    expect(p!.status).toBe("conflicting");
    expect(p!.values.map((v) => v.value)).toEqual([expect.closeTo(10_763.91, 2), 10_764]);
  });
  test("pi² in a French document is square feet", () => {
    const c = only(extractCandidates(doc(["Commerce : 9 400 pi² à 34 $/pi²", "Prix demandé : 31 200 000"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Commerce", value: 9_400, unitSeen: "sf" });
  });
});

describe("a figure in another currency is never the value (decision 7)", () => {
  const doc = (lines: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const from = (name: string, lines: string[]): SourcedCandidate[] =>
    extractCandidates(doc(lines)).candidates.map((c) => ({ ...c, documentId: name, documentName: name }));
  const land = (ps: ReturnType<typeof consolidate>) => ps.find((p) => p.fieldKey === "land_cost")!;

  test("the candidate records the currency it was stated in", () => {
    expect(from("a", ["Land cost: US$1,200,000"])[0]).toMatchObject({ fieldKey: "land_cost", value: 1_200_000, unitSeen: "USD" });
    expect(from("a", ["Land cost: $1,200,000"])[0]).toMatchObject({ unitSeen: "$" });
  });
  test("a USD figure in a CAD deal conflicts, stays in sources, and offers no value to choose", () => {
    const p = land(consolidate(from("Budget", ["Land cost: US$1,200,000"]), "CAD"));
    expect(p).toMatchObject({
      status: "conflicting",
      value: null,
      values: [],
      reason: "A document states this in USD; this deal is in CAD. Enter the amount in CAD.",
    });
    expect(p.sources.map((s) => s.value)).toEqual([1_200_000]);
  });
  test("with a CAD figure beside it, only the CAD figure is offered", () => {
    const p = land(consolidate([...from("Budget", ["Land cost: US$1,200,000"]), ...from("Appraisal", ["Land cost: $1,650,000"])], "CAD"));
    expect(p.status).toBe("conflicting");
    expect(p.values.map((v) => v.value)).toEqual([1_650_000]);
    expect(p.sources.map((s) => s.value)).toEqual([1_650_000, 1_200_000]);
  });
  test("a CAD-marked or unmarked figure behaves as before, and so does an unknown deal currency", () => {
    for (const line of ["Land cost: CA$1,200,000", "Land cost: $1,200,000", "Land cost: 1,200,000 CAD"]) {
      expect(land(consolidate(from("a", [line]), "CAD"))).toMatchObject({ status: "needs_review", value: 1_200_000, reason: null });
    }
    expect(land(consolidate(from("a", ["Land cost: $1,200,000"]), null))).toMatchObject({ status: "needs_review", value: 1_200_000 });
    expect(land(consolidate(from("a", ["Land cost: US$1,200,000"]), "USD"))).toMatchObject({ status: "needs_review", value: 1_200_000 });
  });
  test("a deal that states no currency cannot compare a named one: not usable, kept last, enter the amount", () => {
    const reason = "A document states this in USD; this deal does not state its currency. Enter the amount.";
    for (const cur of [null, undefined]) {
      const p = land(consolidate([...from("Budget", ["Land cost: US$1,200,000"]), ...from("Appraisal", ["Land cost: $1,650,000"])], cur));
      expect(p).toMatchObject({ status: "conflicting", value: null, reason });
      expect(p.values.map((v) => v.value)).toEqual([1_650_000]);
      expect(p.sources.map((s) => s.value)).toEqual([1_650_000, 1_200_000]);
    }
    expect(land(consolidate(from("a", ["Land cost: US$1,200,000", "Land cost: A$900,000"])))).toMatchObject({ value: null, reason: "A document states this in USD and AUD; this deal does not state its currency. Enter the amount." });
    expect(land(consolidate(from("a", ["Land cost: $1,200,000"])))).toMatchObject({ status: "needs_review", value: 1_200_000, reason: null });
  });
  test("a currency named in the label applies to a figure with no mark of its own", () => {
    expect(from("a", ["Land cost (USD): 1,200,000"])[0]).toMatchObject({ fieldKey: "land_cost", value: 1_200_000, unitSeen: "USD" });
    expect(from("a", ["Land cost (USD): $1,200,000"])[0]).toMatchObject({ unitSeen: "USD" });
    expect(from("a", ["Coût du terrain ($ US) : 1 200 000"])[0]).toMatchObject({ fieldKey: "land_cost", unitSeen: "USD" });
    expect(from("a", ["Land cost (CAD): 1,200,000"])[0]).toMatchObject({ unitSeen: "CAD" });
    expect(from("a", ["Land cost (dollars): 1,200,000"])[0]).toMatchObject({ unitSeen: "$" });
    expect(from("a", ["Land cost (USD): CA$1,200,000"])[0]).toMatchObject({ unitSeen: "CAD" }); // the figure's own mark wins
    expect(normalizeLabel("Land cost (USD)")).toEqual({ label: "land cost", labelUnit: "$", labelCode: "USD" });
    expect(normalizeLabel("Land cost ($)").labelCode).toBeNull();
    const p = land(consolidate(from("a", ["Land cost (USD): 1,200,000"]), "CAD"));
    expect(p).toMatchObject({ status: "conflicting", value: null });
  });
  test("a budget table row whose label names the currency is read the same way", () => {
    const table: Table = { name: "Budget", rows: [[{ text: "Line item", ref: "A1" }, { text: "Amount", ref: "B1" }], [{ text: "Land acquisition (USD)", ref: "A2" }, { text: "1,000,000", ref: "B2" }]] } as Table;
    expect(extractCandidates({ ...doc([]), tables: [table] }).candidates[0]).toMatchObject({ fieldKey: "land_cost", unitSeen: "USD" });
  });
  test("an Excel cell whose number format names a currency is read as marked; a plain or locale-only dollar names none", () => {
    const cell = (c: Cell) => extractCandidates({ ...doc([]), tables: [{ name: "Budget", rows: [[{ text: "Line item", ref: "A1" }, { text: "Amount", ref: "B1" }], [{ text: "Land acquisition", ref: "A2" }, c]] } as Table] }).candidates[0];
    expect(cell({ text: "1000000", number: 1_000_000, unit: "$", currency: "USD", ref: "B2" })).toMatchObject({ unitSeen: "USD" });
    expect(cell({ text: "1000000", number: 1_000_000, unit: "$", ref: "B2" })).toMatchObject({ unitSeen: "$" });
  });
  describe("card 99: a currency stated for a column, a table or the document applies to figures with no mark of their own", () => {
    const c = (text: string, ref: string, extra: Partial<Cell> = {}): Cell => ({ text, ref, ...extra });
    const num = (n: number, ref: string, extra: Partial<Cell> = {}): Cell => ({ text: String(n), number: n, ref, ...extra });
    const budget = (name: string, header: Cell[], rows: Cell[][]): NormalizedDocument => ({ ...doc([]), kind: "xlsx", tables: [{ name, rows: [header, ...rows] } as Table] });
    const seen = (d: NormalizedDocument, field = "land_cost") => extractCandidates(d).candidates.find((x) => x.fieldKey === field)?.unitSeen;
    const rows = (sheet = "S") => [[c("Land cost", `${sheet}!A2`), num(900_000, `${sheet}!B2`)], [c("Hard cost", `${sheet}!A3`), num(3_200_000, `${sheet}!B3`)]];
    test("a column header names the currency", () => {
      expect(seen(budget("Costs", [c("Item", "A1"), c("Amount (USD)", "B1")], rows()))).toBe("USD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("US$", "B1")], rows()))).toBe("USD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("Amount (CAD)", "B1")], rows()))).toBe("CAD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("Montant ($ US)", "B1")], rows()))).toBe("USD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("Amount", "B1")], rows()))).not.toMatch(/USD|CAD|AUD/);
    });
    test("a sheet name or a whole-table statement names the currency", () => {
      expect(seen(budget("Costs (USD)", [c("Item", "A1"), c("Amount", "B1")], rows()))).toBe("USD");
      const titled: NormalizedDocument = { ...doc([]), kind: "xlsx", tables: [{ name: "Costs", rows: [[c("All figures in US dollars", "A1")], [c("Item", "A2"), c("Amount", "B2")], ...rows()] } as Table] };
      expect(seen(titled)).toBe("USD");
    });
    test("a document statement names the currency of its line figures, in English and French", () => {
      expect(seen(doc(["All amounts in US dollars.", "Land cost: $900,000"]))).toBe("USD");
      expect(seen(doc(["Currency: USD", "Land cost: $900,000"]))).toBe("USD");
      expect(seen(doc(["Tous les montants sont en dollars américains.", "Coût du terrain : 900 000 $"]))).toBe("USD");
      expect(seen(doc(["Devise : USD", "Coût du terrain : 900 000 $"]))).toBe("USD");
      expect(seen(doc(["Montants en $ US", "Coût du terrain : 900 000 $"]))).toBe("USD");
      expect(seen(doc(["Figures in CA$", "Land cost: $900,000"]))).toBe("CAD");
      expect(seen(doc(["All figures are in Australian dollars.", "Land cost: $900,000"]))).toBe("AUD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("C$", "B1")], rows()))).toBe("CAD");
      const summed = extractCandidates(doc(["All amounts in US dollars.", "Division Amount", "Framing $400,000", "Mechanical $200,000", "Total hard cost $650,000"])).candidates.filter((x) => x.fieldKey === "hard_cost");
      expect(summed.map((x) => x.rule)).toEqual(["table:budget-sum", "table:budget-total"]);
      expect(summed.map((x) => x.unitSeen)).toEqual(summed.map(() => "USD"));
    });
    test("the figure's own mark, its number format and a nearer sub-header win", () => {
      expect(seen(budget("Costs", [c("Item", "A1"), c("Amount (USD)", "B1")], [[c("Land cost", "A2"), c("CA$900,000", "B2")]]))).toBe("CAD");
      expect(seen(budget("Costs", [c("Item", "A1"), c("Amount (USD)", "B1")], [[c("Land cost", "A2"), num(900_000, "B2", { unit: "$", currency: "CAD" })]]))).toBe("CAD");
      const split = budget("Costs", [c("Item", "A1"), c("Amount (USD)", "B1")], [[c("Hard cost", "A2"), num(3_200_000, "B2")], [c("Item", "A3"), c("Amount (CAD)", "B3")], [c("Land cost", "A4"), num(900_000, "B4")]]);
      expect(seen(split, "land_cost")).toBe("CAD");
      expect(seen(split, "hard_cost")).toBe("USD");
    });
    test("no single stated currency, no currency: two statements, or a line that holds a number", () => {
      expect(seen(doc(["All amounts in US dollars.", "All amounts in Canadian dollars.", "Land cost: $900,000"]))).toBe("$");
      expect(seen(doc(["Land cost in US dollars converted at 1.36: $1,224,000"]))).not.toBe("USD");
      expect(seen(doc(["All amounts in dollars.", "Land cost: $900,000"]))).toBe("$");
    });
    test("a row label that names a currency beside its own figure, or a long note, is no column header", () => {
      const labelled = budget("Costs", [c("Item", "A1"), c("Amount", "B1"), c("Paid", "C1")], [[c("Deposit", "A2"), c("Soft cost (USD)", "B2"), num(150_000, "C2")], [c("Land cost", "A3"), num(900_000, "B3")]]);
      expect(seen(labelled)).toBe("$");
      const noted = budget("Costs", [c("Item", "A1"), c("Amount", "B1")], [[c("Item", "A2"), c("The vendor was paid in US dollars last year", "B2")], [c("Land cost", "A3"), num(900_000, "B3")]]);
      expect(seen(noted)).toBe("$");
    });
    test("a header-USD figure in a CAD deal conflicts, as any USD figure does", () => {
      const d = budget("Costs", [c("Item", "A1"), c("Amount (USD)", "B1")], rows());
      const p = land(consolidate(extractCandidates(d).candidates.map((x) => ({ ...x, documentId: "b", documentName: "b" })), "CAD"));
      expect(p).toMatchObject({ status: "conflicting", value: null, reason: "A document states this in USD; this deal is in CAD. Enter the amount in CAD." });
    });
  });
  test("parsing a workbook: only an explicit currency in the number format is carried", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Budget");
    const formats = ['[$USD] #,##0', '"US$"#,##0', '"A$"#,##0', '[$CAD] #,##0', '"CA$"#,##0', '[$$-409]#,##0', '"$"#,##0', '$#,##0', '0%'];
    formats.forEach((f, i) => { const c = ws.getCell(i + 1, 1); c.value = 1000; c.numFmt = f; });
    const doc = await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "b.xlsx");
    expect(doc.tables[0]!.rows.map((r) => [r[0]!.unit, r[0]!.currency])).toEqual([
      ["$", "USD"], ["$", "USD"], ["$", "AUD"], ["$", "CAD"], ["$", "CAD"], ["$", undefined], ["$", undefined], ["$", undefined], ["%", undefined],
    ]);
  });
  test("the same amount in two currencies in one document is two candidates, not one", () => {
    expect(from("a", ["Land cost: US$1,200,000", "Land cost: C$1,200,000"])).toHaveLength(2);
  });
  test("a budget table never adds a USD line to a CAD one", () => {
    const table: Table = {
      name: "Budget",
      rows: [
        [{ text: "Line item", ref: "A1" }, { text: "Amount", ref: "B1" }],
        [{ text: "Land acquisition", ref: "A2" }, { text: "$1,000,000", ref: "B2" }],
        [{ text: "Land survey and legal", ref: "A3" }, { text: "US$50,000", ref: "B3" }],
      ],
    } as Table;
    const r = extractCandidates({ ...doc([]), tables: [table] });
    expect(r.candidates.map((c) => [c.fieldKey, c.value, c.unitSeen]).sort()).toEqual(
      [["land_cost", 1_000_000, "$"], ["land_cost", 50_000, "USD"]].sort(),
    );
  });
});

describe("a French Canadian pro forma (fr-CA: comma decimals, space groups, trailing $)", () => {
  const lines = [
    "Coût du terrain : 1 250 000,00 $",
    "Coûts de construction : 8 400 000 $",
    "Honoraires professionnels : 620 000 $",
    "Contingence : 420 000 $",
    "Nombre de logements : 24",
    "Loyer mensuel : 2 100 $/mois",
    "Loyer : 18,75 $/pi²",
    "Superficie locative : 9 400 pi²",
    "Taux d'occupation : 95 %",
    "Dépenses d'exploitation : 35 %",
    "Autres revenus : 36 000 $",
    "Taux de capitalisation à la sortie : 5,25 %",
    "Montant du prêt : 6 500 000 $",
    "Taux d'intérêt : 5,85 %",
    "Période d'amortissement : 25 ans",
    "Durée des travaux : 18 mois",
    "Période de détention : 7 ans",
  ];
  const r = extractCandidates({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const got = r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value, c.unitSeen]);

  test("accents are folded, not dropped; English labels are unchanged", () => {
    expect(normalizeLabel("Coût du terrain").label).toBe("cout du terrain");
    expect(normalizeLabel("Période d'amortissement").label).toBe("periode d amortissement");
    expect(normalizeLabel("Land cost (CAD)")).toEqual({ label: "land cost", labelUnit: "$", labelCode: "CAD" });
    expect(normalizeLabel("Durée (mois)").labelUnit).toBe("months");
  });
  test("every line maps to its field, value and unit", () => {
    expect(got).toEqual([
      ["land_cost", null, 1_250_000, "$"],
      ["hard_cost", null, 8_400_000, "$"],
      ["soft_cost", null, 620_000, "$"],
      ["contingency", null, 420_000, "$"],
      ["unit_count", "All units", 24, "number"],
      ["unit_rent_monthly", "All units", 2_100, "$/mo"],
      ["rent_psf_annual", "All units", 18.75, "$/sf"],
      ["rentable_area_sf", "All units", 9_400, "sf"],
      ["stabilized_occupancy_pct", null, 95, "%"],
      ["expense_ratio_pct", null, 35, "%"],
      ["other_income_annual", null, 36_000, "$"],
      ["exit_cap_rate_pct", null, 5.25, "%"],
      ["senior_loan_amount", null, 6_500_000, "$"],
      ["senior_rate_pct", null, 5.85, "%"],
      ["senior_amort_years", null, 25, "years"],
      ["construction_months", null, 18, "months"],
      ["hold_years", null, 7, "years"],
    ]);
  });
  test("nothing is left unmapped", () => {
    expect(r.other).toEqual([]);
  });
  test("a French label never lets a mezzanine or refinance figure fall to the senior loan", () => {
    const one = (text: string) => extractCandidates({ kind: "pdf", lines: [{ text, location: "l1" }], tables: [], pageCount: 1, needsOcr: false, fullText: text }).candidates[0]?.fieldKey;
    expect(one("Montant du prêt mezzanine : 1 500 000 $")).toBe("mezz_loan_amount");
    expect(one("Taux d'intérêt du prêt mezzanine : 11,5 %")).toBe("mezz_rate_pct");
    expect(one("Montant du prêt de refinancement : 9 000 000 $")).toBe("refinance_amount");
    expect(one("Taux d'intérêt du refinancement : 4,9 %")).toBe("refinance_rate_pct");
    expect(one("Amortissement du prêt mezzanine : 20 ans")).toBe("mezz_amort_years");
    expect(one("Dépenses d'exploitation fixes : 1 310 000 $")).toBe("fixed_opex_annual");
  });

  const text = (...ls: string[]): NormalizedDocument => ({ kind: "pdf", lines: ls.map((t, n) => ({ text: t, location: `l${n + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: ls.join("\n") });
  const fieldOf = (line: string) => extractCandidates(text(line)).candidates[0]?.fieldKey ?? null;

  test("the remaining French field aliases map, and none lets a mezzanine, refinance or going-in line fall to a senior or exit field", () => {
    const cases: [string, string | null][] = [
      ["Autres coûts : 150 000 $", "other_cost"],
      ["Frais de gestion : 4 %", "variable_expense_pct"],
      ["Croissance des loyers : 2,5 %", "rent_growth_pct"],
      ["Croissance annuelle des loyers : 2,5 %", "rent_growth_pct"],
      ["Croissance des dépenses : 3 %", "expense_growth_pct"],
      ["Croissance des dépenses d'exploitation : 3 %", "expense_growth_pct"],
      ["Frais de vente : 2 %", "selling_costs_pct"],
      ["Frais de disposition : 2,5 %", "selling_costs_pct"],
      ["Période d'intérêt seulement : 24 mois", "senior_io_months"],
      ["Intérêts seulement : 18 mois", "senior_io_months"],
      ["Période d'intérêt seulement du prêt mezzanine : 12 mois", "mezz_io_months"],
      ["Période d'intérêts seulement mezzanine : 12 mois", "mezz_io_months"],
      ["Intérêts seulement mezzanine : 12 mois", "mezz_io_months"],
      ["Période d'intérêt seulement du refinancement : 12 mois", "refinance_io_months"],
      ["Intérêts seulement du prêt de refinancement : 12 mois", "refinance_io_months"],
      ["RCD minimal : 1,20 x", "min_dscr_covenant"],
      ["CCD minimal : 1,20 x", "min_dscr_covenant"],
      ["RCSD minimal : 1,20 x", "min_dscr_covenant"],
      ["Ratio de couverture de la dette minimal : 1,20 x", "min_dscr_covenant"],
      ["Coefficient de couverture de la dette minimal : 1,20 x", "min_dscr_covenant"],
      ["Mois du refinancement : 36 mois", "refinance_month"],
      ["Ratio prêt-valeur du refinancement : 65 %", "refinance_ltv_pct"],
      ["Ratio prêt valeur du refinancement : 65 %", "refinance_ltv_pct"],
      ["Fonds propres : 4 000 000 $", "equity_amount"],
      ["Mise de fonds : 4 000 000 $", "equity_amount"],
      ["Part des commanditaires : 90 %", "lp_share_pct"],
      ["Rendement privilégié : 8 %", "preferred_return_pct"],
      ["Prime de performance : 20 %", "gp_promote_pct"],
      // The bare "taux de capitalisation" is ambiguous with the going-in rate, so it maps nowhere.
      ["Taux de capitalisation : 5,25 %", null],
      ["Taux de capitalisation initial : 4,5 %", null],
      ["Taux de capitalisation à la sortie : 5,25 %", "exit_cap_rate_pct"],
      ["Taux de capitalisation de sortie : 5,25 %", "exit_cap_rate_pct"],
      // Existing risks that must stay where they were.
      ["Taux d'intérêt du prêt mezzanine : 11,5 %", "mezz_rate_pct"],
      ["Taux d'intérêt du refinancement : 4,9 %", "refinance_rate_pct"],
    ];
    for (const [line, key] of cases) expect([line, fieldOf(line)]).toEqual([line, key]);
  });
  test("a French output figure is never an input", () => {
    for (const line of ["Revenu net d'exploitation : 2 100 000 $", "RNE projeté : 2 100 000 $", "TRI : 18 %", "Taux de rendement interne : 18 %",
      "Multiple sur capitaux propres : 2,1 x", "Multiple sur fonds propres : 2,1 x", "Rendement sur coût : 6,5 %", "Valeur de sortie : 40 000 000 $", "Valeur à la revente : 40 000 000 $",
      "Valeur marchande : 40 000 000 $", "Rendement en espèces : 9 %"]) {
      const r = extractCandidates(text(line));
      expect([line, r.candidates.length, r.other[0]?.note ?? ""]).toEqual([line, 0, expect.stringContaining("output figure")]);
    }
    expect(fieldOf("Rendement privilégié : 8 %")).toBe("preferred_return_pct");
  });
  test("French table headers: a rent roll and a budget", () => {
    const h = (...t: string[]) => t.map((x, i) => ({ text: x, ref: `${"ABCDEF"[i]}1` }));
    const rowOf = (n: number, ...v: (string | number)[]) => v.map((x, i) => (typeof x === "number" ? { text: String(x), number: x, ref: `${"ABCDEF"[i]}${n}` } : { text: x, ref: `${"ABCDEF"[i]}${n}` }));
    const tab = (...rows: Cell[][]): NormalizedDocument => ({ ...text(), tables: [{ name: "Loyers", rows } as Table] });
    const unitRoll = extractCandidates(tab(h("Type de logement", "Nombre d'unités", "Loyer mensuel", "Taux d'occupation"), rowOf(2, "1 chambre", 10, 1_850, 95))).candidates;
    expect(unitRoll.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "1BR", 10], ["unit_rent_monthly", "1BR", 1_850], ["item_occupancy_pct", "1BR", 95]]);
    const psfRoll = extractCandidates(tab(h("Logement", "Superficie (pi²)", "Loyer au pi²"), rowOf(2, "Commerce", 9_400, 31))).candidates;
    expect(psfRoll.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["rent_psf_annual", "Commerce", 31], ["rentable_area_sf", "Commerce", 9_400]]);
    const m2Roll = extractCandidates(tab(h("Unité", "Superficie (m²)", "Loyer au m²"), rowOf(2, "Commerce", 100, 350))).candidates;
    expect(m2Roll.find((c) => c.fieldKey === "rentable_area_sf")).toMatchObject({ unitSeen: "m2" });
    expect(m2Roll.find((c) => c.fieldKey === "rent_psf_annual")!.value).toBeCloseTo(350 / SF_PER_M2, 6);
    const budget = extractCandidates(tab(h("Poste", "Montant ($)"), rowOf(2, "Coût du terrain", 1_250_000), rowOf(3, "Coûts de construction", 8_400_000), rowOf(4, "Sous-total", 9_650_000))).candidates;
    expect(budget.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_250_000], ["hard_cost", 8_400_000]]);
    const budget2 = extractCandidates(tab(h("Description", "Coût total"), rowOf(2, "Honoraires professionnels", 620_000))).candidates;
    expect(budget2.map((c) => [c.fieldKey, c.value])).toEqual([["soft_cost", 620_000]]);
  });
});

describe("parsers keep a document's structure", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const para = (s: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(s)}</w:t></w:r></w:p>`;
  const table = (rows: string[][]) =>
    `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
  /** A minimal Word file: the body's XML in a zip with the three parts Word needs. */
  async function docx(body: string): Promise<Uint8Array> {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("word/styles.xml", `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  }
  async function workbook(cells: [string, number | string, string?][]): Promise<NormalizedDocument> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet");
    cells.forEach(([label, value, fmt], i) => {
      ws.getCell(i + 1, 1).value = label;
      const c = ws.getCell(i + 1, 2);
      c.value = value;
      if (fmt) c.numFmt = fmt;
    });
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "w.xlsx");
  }

  test("a two-column Word table is read as label and value, and its text is not also a line", async () => {
    const d = await parseDocument(await docx(para("Summary") + table([["Land", "$290,000"], ["Hard costs", "$4,100,000"]]) + para("End")), "t.docx");
    expect(d.tables).toHaveLength(1);
    expect(d.tables[0]).toMatchObject({ name: "Table 1" });
    expect(d.tables[0]!.rows[1]![1]).toEqual({ text: "$4,100,000", ref: "Table 1 R2C2" });
    expect(d.lines.map((l) => l.text)).toEqual(["Summary", "End"]);
    expect(d.fullText).toContain("$290,000");
    const r = extractCandidates(d);
    expect(r.candidates.map((c) => [c.fieldKey, c.value, c.location])).toEqual([["land_cost", 290_000, "Table 1 R1C2"], ["hard_cost", 4_100_000, "Table 1 R2C2"]]);
  });
  test("paragraphs before and after a table keep their order and number only the paragraphs outside tables", async () => {
    const d = await parseDocument(await docx(para("First") + table([["Land", "$1"]]) + para("") + para("Second") + table([["A", "B"]]) + para("Third")), "t.docx");
    expect(d.lines).toEqual([{ text: "First", location: "paragraph 1" }, { text: "Second", location: "paragraph 2" }, { text: "Third", location: "paragraph 3" }]);
    expect(d.tables.map((t) => t.name)).toEqual(["Table 1", "Table 2"]);
  });
  test("a Word rent table is read as a rent roll and a budget table with a total row as a budget", async () => {
    const rent = extractCandidates(await parseDocument(await docx(table([["Unit type", "Units", "Monthly rent"], ["Studio", "4", "$1,450"]])), "r.docx"));
    expect(rent.candidates.map((c) => [c.fieldKey, c.itemKey, c.value, c.location])).toEqual([
      ["unit_count", "Studio", 4, "Table 1 R2C2"],
      ["unit_rent_monthly", "Studio", 1_450, "Table 1 R2C3"],
    ]);
    const budget = extractCandidates(await parseDocument(await docx(table([["Line item", "Amount"], ["Land acquisition", "$1,000,000"], ["Hard costs", "$5,000,000"], ["Total", "$6,000,000"]])), "b.docx"));
    // task 51: the Total that closes two budget lines is the stated total cost
    expect(budget.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000], ["hard_cost", 5_000_000], ["stated_total_cost", 6_000_000]]);
  });
  test("entities decode, and a note in a cell is text that no table finder reads as a figure", async () => {
    const d = await parseDocument(await docx(table([["Fees & levies", "Note: 5% of cost"]])), "t.docx");
    expect(d.tables[0]!.rows[0]![0]!.text).toBe("Fees & levies");
    expect(d.tables[0]!.rows[0]![1]!.number).toBeUndefined();
  });

  test("a quoted literal percent sign is not Excel's percent format, a real one is, and neither carries float noise", async () => {
    const d = await workbook([["Occupancy", 97, '0.0 "%"'], ["Rate", 0.28, "0.0%"]]);
    const cells = d.tables[0]!.rows.map((r) => r[1]!);
    expect(cells[0]).toMatchObject({ number: 97, unit: "%" });
    expect(cells[1]).toMatchObject({ number: 28, unit: "%" });
  });
  test("a quoted literal names the unit the cell is written in", async () => {
    const d = await workbook([["a", 15, '0 "mois"'], ["b", 3, '0 "ans"'], ["c", 2, '0 "years"'], ["d", 1_250_000, '#,##0 "$"'], ["e", 4, '0.0 "x"'], ["f", 900, '0 "pi²"'], ["g", 80, '0 "m²"'], ["h", 7, '0 "Note: 5%"']]);
    expect(d.tables[0]!.rows.map((r) => r[1]!.unit)).toEqual(["months", "years", "years", "$", "x", "sf", "m2", undefined]);
    expect(d.tables[0]!.rows[3]![1]!.currency).toBeUndefined();
  });
  test("a months cell under a French label is read as months", async () => {
    const d = await workbook([["Durée des travaux", 15, '0 "mois"']]);
    expect(extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value])).toEqual([["construction_months", 15]]);
  });
  test("a value cell with no unit followed by a cell holding only a unit word reads that unit; a longer note does not", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["a", 15, "mois"]);
    ws.addRow(["b", 3, "years"]);
    ws.addRow(["c", 80, "%"]);
    ws.addRow(["d", 6, "months, approximately"]);
    const d = await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "u.xlsx");
    expect(d.tables[0]!.rows.map((r) => r[1]!.unit)).toEqual(["months", "years", "%", undefined]);
  });
  test("a take-out loan's rows in a Word table are the refinance, not the senior loan", async () => {
    const d = await parseDocument(await docx(table([["Loan amount", "$2,000,000"], ["Interest rate", "5.85%"]]) + table([["Take-out loan amount", "$2,600,000"], ["Take-out interest rate", "4.55%"], ["Take-out amortization", "40 years"]])), "m.docx");
    expect(extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value])).toEqual([["senior_loan_amount", 2_000_000], ["senior_rate_pct", 5.85], ["refinance_amount", 2_600_000], ["refinance_rate_pct", 4.55], ["refinance_amort_years", 40]]);
  });

  test.each(["Heading1", "Title", "bold"])("a Word %s take-out heading keeps all terms separate from construction", async (style) => {
    const heading = style === "bold"
      ? '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insured take-out commitment</w:t></w:r></w:p>'
      : `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>Insured take-out commitment</w:t></w:r></w:p>`;
    const d = await parseDocument(await docx(heading + para("Interest rate: 4.40% fixed for the loan.") + para("Amortization: 40 years.") + para("Interest-only period: none.")), "permanent.docx");
    expect(d.lines.map((line) => line.text)).toEqual(["Insured take-out commitment", "Interest rate: 4.40% fixed for the loan.", "Amortization: 40 years.", "Interest-only period: none."]);
    const takeout = extractCandidates(d);
    expect(takeout.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["refinance_rate_pct", 4.4], ["refinance_amort_years", 40], ["refinance_io_months", 0]]);
    expect(takeout.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
    const construction = extractCandidates(await parseDocument(await docx(para("Construction term sheet") + para("Interest rate: 6.10%") + para("Amortization: 25 years.") + para("Interest-only period: 18 months.")), "construction.docx"));
    expect(construction.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["senior_rate_pct", 6.1], ["senior_amort_years", 25], ["senior_io_months", 18]]);
    const proposals = consolidate([...takeout.candidates.map((c) => ({ ...c, documentId: "permanent", documentName: "permanent.docx" })), ...construction.candidates.map((c) => ({ ...c, documentId: "construction", documentName: "construction.docx" }))]);
    expect(proposals.filter((p) => p.status === "conflicting")).toEqual([]);
  });

  test.each(contentScopeCases)("card 98 plain Word paragraphs: $name", async ({ lines, expected }) => {
    const d = await parseDocument(await docx(lines.map(para).join("")), "summary.docx");
    expect(d.lines.map((line) => line.text)).toEqual(lines);
    const r = extractCandidates(d);
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual(expect.arrayContaining(expected));
    expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
  });

  // A run of text, struck through when `struck` is true.
  const run = (t: string, struck = false) => `<w:r>${struck ? "<w:rPr><w:strike/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
  const runs = (...r: string[]) => `<w:p>${r.join("")}</w:p>`;
  const read = async (body: string) => extractCandidates(await parseDocument(await docx(body), "s.docx"));
  test("a struck figure is kept as a range on the line, and the line's text is unchanged", async () => {
    const d = await parseDocument(await docx(runs(run("Land was "), run("$900,000", true), run(" and is now $950,000."))), "s.docx");
    expect(d.lines[0]!.text).toBe("Land was $900,000 and is now $950,000.");
    expect(d.lines[0]!.struck).toEqual([[9, 17]]);
  });
  test("a struck figure followed by its replacement reads the replacement only", async () => {
    const r = await read(runs(run("The land cost "), run("$900,000", true), run(" $950,000 after the final survey.")));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 950_000]]);
    expect(r.other.find((o) => o.value === 900_000)?.note).toMatch(/struck through/i);
  });
  test("a struck figure alone in its sentence gives no candidate", async () => {
    const r = await read(runs(run("Land cost: "), run("$900,000", true)));
    expect(r.candidates).toEqual([]);
    expect(r.other.map((o) => [o.value, o.note])).toEqual([[900_000, expect.stringMatching(/struck through/i)]]);
    const prose = await read(runs(run("We will pay "), run("$910,000", true), run(" to buy the lot.")));
    expect(prose.candidates).toEqual([]);
  });
  test("a struck word that is not a number changes nothing", async () => {
    const r = await read(runs(run("The "), run("firm", true), run(" land cost is $900,000.")));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 900_000]]);
  });
  test("a struck figure in a Word table cell is shown, not read", async () => {
    const cell = (...r: string[]) => `<w:tc>${runs(...r)}</w:tc>`;
    const row = (...c: string[]) => `<w:tr>${c.join("")}</w:tr>`;
    const r = await read(`<w:tbl>${row(cell(run("Land")), cell(run("$900,000", true)))}${row(cell(run("Hard costs")), cell(run("$4,100,000")))}</w:tbl>`);
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["hard_cost", 4_100_000]]);
    expect(r.other.find((o) => o.value === 900_000)?.note).toMatch(/struck through/i);
  });
});

describe("tables written as lines of text, and what a table's rows mean", () => {
  const lines = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const grid = (...rows: (string | number)[][]): Table => ({
    name: "Sheet",
    rows: rows.map((r, i) => r.map((x, c) => (typeof x === "number" ? { text: String(x), number: x, ref: `${"ABCDE"[c]}${i + 1}` } : { text: x, ref: `${"ABCDE"[c]}${i + 1}` }))),
  });
  const tableDoc = (t: Table): NormalizedDocument => ({ ...lines(), tables: [t] });
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);

  test("a header line, then one line per unit type, is a rent roll; the area is per unit, so the item's area is count x area", () => {
    const r = extractCandidates(lines("Plan Count Floor area (sf) Rent per month", "Loft 3 480 $1,495", "Penthouse 2 910 $2,240"));
    expect(pick(r)).toEqual([
      ["unit_count", "Loft", 3], ["unit_rent_monthly", "Loft", 1_495], ["rentable_area_sf", "Loft", 1_440],
      ["unit_count", "Penthouse", 2], ["unit_rent_monthly", "Penthouse", 2_240], ["rentable_area_sf", "Penthouse", 1_820],
    ]);
    expect(r.candidates.find((c) => c.fieldKey === "rentable_area_sf")).toMatchObject({ note: "3 × 480 sf", location: "page 1, line 2", rule: "table:rent-roll" });
  });
  test("a total area column is not multiplied by the count, and a count of one leaves the area as it is", () => {
    const total = extractCandidates(lines("Plan Count Total area (sf) Rent per month", "Loft 3 1440 $1,495"));
    expect(pick(total).find((c) => c[0] === "rentable_area_sf")).toEqual(["rentable_area_sf", "Loft", 1_440]);
    const one = extractCandidates(lines("Plan Count Area (sf) Rent per month", "Corner 1 700 $1,900"));
    expect(one.candidates.find((c) => c.fieldKey === "rentable_area_sf")).toMatchObject({ value: 700 });
  });
  describe("a unit-by-unit rent roll is read (task 66)", () => {
    const suites: [string, string, number, string][] = [
      ["101", "1 bed", 620, "$1,450"], ["102", "1 bed", 620, "$1,450"], ["103", "1 bed", 620, "$1,475"], ["104", "1 bed", 620, "$1,475"],
      ["201", "2 bed", 880, "$1,795"], ["202", "2 bed", 880, "$1,795"], ["203", "2 bed", 880, "$1,825"], ["204", "2 bed", 880, "$1,825"],
      ["301", "3 bed", 1040, "$2,150"], ["302", "3 bed", 1040, "$2,150"],
    ];
    const roll = (header: string[], withSize = true) =>
      tableDoc(grid(header, ...suites.map(([u, t, a, r]) => (withSize ? [u, t, a, r] : [u, t, r])), withSize ? ["Total", "", 8080, "$17,390"] : ["Total", "", "$17,390"]));
    const byItem = (r: ReturnType<typeof extractCandidates>, key: string) => r.candidates.filter((c) => c.fieldKey === key).map((c) => [c.itemKey, c.value]);
    const checkMix = (r: ReturnType<typeof extractCandidates>) => {
      expect(byItem(r, "unit_count")).toEqual([["1BR", 4], ["2BR", 4], ["3BR", 2]]);
      expect(r.candidates.filter((c) => c.fieldKey === "unit_count").every((c) => c.rule === "table:rent-roll-suite")).toBe(true);
      expect(byItem(r, "unit_rent_monthly")).toEqual([["3BR", 2150]]);
      expect(r.other.filter((o) => o.note?.includes("different amounts")).map((o) => o.value)).toEqual([1450, 1450, 1475, 1475, 1795, 1795, 1825, 1825]);
    };
    test("suite rows with a size in sq ft are grouped by type: counts, summed areas, one rent only where every suite agrees", () => {
      const r = extractCandidates(roll(["Unit", "Type", "Size (sq ft)", "Projected rent / month"]));
      checkMix(r);
      expect(byItem(r, "rentable_area_sf")).toEqual([["1BR", 2480], ["2BR", 3520], ["3BR", 2080]]);
    });
    test("a roll with no size column is read the same way", () => {
      const r = extractCandidates(roll(["Unit", "Type", "Monthly rent"], false));
      checkMix(r);
      expect(byItem(r, "rentable_area_sf")).toEqual([]);
    });
    test("sq. ft., sqft, pi ca and pieds carres name the area column", () => {
      for (const head of ["Size (sq. ft.)", "Sqft", "Area (square feet)", "Superficie (pi ca)", "Pi²", "Surface (pieds carrés)", "Square foot"]) {
        const r = extractCandidates(tableDoc(grid(["Unit", "Type", head, "Rent per month"], ["101", "1 bed", 620, "$1,450"], ["102", "1 bed", 620, "$1,450"])));
        expect([head, byItem(r, "rentable_area_sf")]).toEqual([head, [["1BR", 1240]]]);
        expect([head, byItem(r, "unit_rent_monthly")]).toEqual([head, [["1BR", 1450]]]);
      }
      // "Size" alone is not an area.
      const plain = extractCandidates(tableDoc(grid(["Unit", "Type", "Size", "Rent per month"], ["101", "1 bed", 620, "$1,450"], ["102", "1 bed", 620, "$1,450"])));
      expect(byItem(plain, "rentable_area_sf")).toEqual([]);
    });
    test("/month, /mo., /mth, per mo, a month and / mois say the rent is monthly; a per-sf or yearly header still wins", () => {
      for (const head of ["Rent/month", "Rent ($/mo.)", "Rent / mth", "Rent per mo", "Rent a month", "Loyer / mois"]) {
        const r = extractCandidates(tableDoc(grid(["Unit", "Type", "Area (sf)", head], ["101", "1 bed", 620, "$1,450"], ["102", "1 bed", 620, "$1,450"])));
        expect([head, byItem(r, "unit_rent_monthly")]).toEqual([head, [["1BR", 1450]]]);
      }
      const psf = extractCandidates(tableDoc(grid(["Unit", "Type", "Area (sf)", "Rent ($/sf/yr)"], ["101", "1 bed", 620, "$24"], ["102", "1 bed", 620, "$24"])));
      expect(byItem(psf, "unit_rent_monthly")).toEqual([]);
      expect(byItem(psf, "rent_psf_annual")).toEqual([["1BR", 24]]);
      const yearly = extractCandidates(tableDoc(grid(["Unit", "Type", "Area (sf)", "Annual rent / unit"], ["101", "1 bed", 620, "$17,400"], ["102", "1 bed", 620, "$17,400"])));
      expect(byItem(yearly, "unit_rent_monthly")).toEqual([["1BR", 1450]]);
    });
    test("Apt, No., Unit # and the French suite columns count as a suite column", () => {
      for (const [suite, type, rent] of [["Apt", "Type", "Monthly rent"], ["No.", "Unit type", "Monthly rent"], ["Unit #", "Type", "Monthly rent"], ["App.", "Type de logement", "Loyer mensuel"], ["Logement", "Type", "Loyer / mois"]]) {
        const r = extractCandidates(tableDoc(grid([suite!, type!, rent!], ["101", "1 bed", "$1,450"], ["102", "1 bed", "$1,450"])));
        expect([suite, byItem(r, "unit_count"), byItem(r, "unit_rent_monthly")]).toEqual([suite, [["1BR", 2]], [["1BR", 1450]]]);
      }
    });
    test("suites named by a letter (Unit A, Unit B) are suites of their type", () => {
      const r = extractCandidates(tableDoc(grid(["Unit", "Type", "Beds", "Monthly rent"], ["Unit A", "1-bed", 1, "$1,950"], ["Unit B", "1-bed", 1, "$1,950"], ["Unit C", "2-bed", 2, "$2,500"])));
      expect(byItem(r, "unit_count")).toEqual([["1BR", 2], ["2BR", 1]]);
      expect(byItem(r, "unit_rent_monthly")).toEqual([["1BR", 1950], ["2BR", 2500]]);
    });
    test("a type and a rent column only is a table of comparable rents, not a roll", () => {
      const r = extractCandidates(tableDoc(grid(["Type", "Asking rent"], ["1 bed", "$1,650"], ["2 bed", "$2,050"], ["3 bed", "$2,450"])));
      expect(byItem(r, "unit_count")).toEqual([]);
    });
    test("audit of card 66: a count column after the type column is not a suite column, so no type is counted one per row", () => {
      for (const [type, count, rent] of [["Type", "No.", "Monthly rent"], ["Unit type", "Unit #", "Rent / month"], ["Type", "Unit", "Monthly rent"]]) {
        const r = extractCandidates(tableDoc(grid([type!, count!, rent!], ["1 bed", 4, "$1,450"], ["2 bed", 6, "$1,850"])));
        expect([count, byItem(r, "unit_count").filter(([, n]) => n === 1)]).toEqual([count, []]);
      }
      // A suite column first is still a roll.
      const r = extractCandidates(tableDoc(grid(["No.", "Type", "Rent per month"], ["1", "1 bed", "$1,450"], ["2", "1 bed", "$1,450"])));
      expect(byItem(r, "unit_count")).toEqual([["1BR", 2]]);
    });
    test("a roll of unit types with counts is read as before", () => {
      const r = extractCandidates(tableDoc(grid(["Type", "Units", "Area (sf)", "Monthly rent"], ["1 bed", 4, 620, "$1,450"], ["2 bed", 4, 880, "$1,795"])));
      expect(pick(r)).toEqual([["unit_count", "1BR", 4], ["unit_rent_monthly", "1BR", 1450], ["rentable_area_sf", "1BR", 2480], ["unit_count", "2BR", 4], ["unit_rent_monthly", "2BR", 1795], ["rentable_area_sf", "2BR", 3520]]);
    });
  });
  test("a per-suite roll is one item per type, ignores the status words after the numbers and skips the total", () => {
    const r = extractCandidates(lines("Suite Type Units Monthly rent Status", "Suite 12 Bachelor 1 $1,100 vacant", "Suite 14 Bachelor 1 $1,125 leased 2026", "Total 2 $2,225"));
    expect(pick(r)).toEqual([["unit_count", "Bachelor", 2]]);
    expect(r.other.filter((o) => o.note?.includes("different amounts")).map((o) => o.value)).toEqual([1_100, 1_125]);
    expect(r.candidates.some((c) => c.itemKey?.startsWith("Total"))).toBe(false);
  });
  test("French header and rows are read the same way", () => {
    const r = extractCandidates(lines("Type de logement Nombre Loyer mensuel", "2 chambres 4 1895 $", "Studio 2 1450 $"));
    expect(pick(r)).toEqual([["unit_count", "2BR", 4], ["unit_rent_monthly", "2BR", 1_895], ["unit_count", "Studio", 2], ["unit_rent_monthly", "Studio", 1_450]]);
  });
  test("an annual rent column is a yearly rent per unit: the monthly rent is that over twelve", () => {
    const r = extractCandidates(lines("Plan Count Annual rent", "One-bed 6 $18,000"));
    expect(pick(r)).toEqual([["unit_count", "1BR", 6], ["unit_rent_monthly", "1BR", 1_500]]);
    expect(r.candidates[1]).toMatchObject({ unitSeen: "$/yr", note: expect.stringContaining("yearly") });
    const fr = extractCandidates(lines("Type de logement Nombre Loyer annuel", "Studio 2 15600 $"));
    expect(pick(fr).find((c) => c[0] === "unit_rent_monthly")).toEqual(["unit_rent_monthly", "Studio", 1_300]);
  });
  test("a rent per square foot header is not divided", () => {
    const r = extractCandidates(lines("Space Area (sf) Annual rent per sf", "Shop 1200 $32"));
    expect(pick(r)).toEqual([["rent_psf_annual", "Shop", 32], ["rentable_area_sf", "Shop", 1_200]]);
  });
  test("a mixed table: notes after it say which rows are per square foot and which are yearly per apartment", () => {
    const r = extractCandidates(lines("Use Count Area (sf) Rent", "Retail 1 2000 $30", "Residential 8 650 $21,600", "Retail rents are net annual per square foot of area.", "Residential rents are annual rent per apartment."));
    expect(pick(r).filter((c) => c[0] === "rent_psf_annual" || c[0] === "unit_rent_monthly")).toEqual([["rent_psf_annual", "Retail", 30], ["unit_rent_monthly", "Residential", 1_800]]);
    expect(pick(r)).toContainEqual(["rentable_area_sf", "Retail", 2_000]);
  });
  test("a note about the whole table settles every row; the same in a spreadsheet's own rows", () => {
    const text = extractCandidates(lines("Type Count Area (sf) Rent", "Studio 4 400 $1,500", "All rents are monthly per unit."));
    expect(pick(text)).toContainEqual(["unit_rent_monthly", "Studio", 1_500]);
    const sheet = extractCandidates(tableDoc(grid(["Unit", "Use", "Count", "Area (sf)", "Rent"], ["A", "Retail", 1, 900, 25], ["B", "Flat", 2, 600, 1_800], ["Flat rents are monthly per unit."], ["Retail rents are per square foot per year."])));
    expect(pick(sheet).filter((c) => c[0] === "unit_rent_monthly" || c[0] === "rent_psf_annual")).toEqual([["rent_psf_annual", "A Retail", 25], ["unit_rent_monthly", "B Flat", 1_800]]);
  });
  test("a bare Rent column beside an area column with no note is not a value: it is shown with the reason", () => {
    const r = extractCandidates(lines("Type Count Area (sf) Rent", "Studio 4 400 $1,500"));
    expect(r.candidates.some((c) => c.fieldKey === "unit_rent_monthly" || c.fieldKey === "rent_psf_annual")).toBe(false);
    expect(pick(r)).toContainEqual(["unit_count", "Studio", 4]);
    expect(r.other.find((o) => o.value === 1_500)).toMatchObject({ note: "The rent's basis (per month, per year or per square foot) is not stated" });
  });
  test("a bare Rent column with no area column is still monthly, as before", () => {
    expect(pick(extractCandidates(lines("Type Count Rent", "Studio 4 $1,500")))).toContainEqual(["unit_rent_monthly", "Studio", 1_500]);
  });
  test("a number in parentheses in a label is part of the label, with or without a colon", () => {
    expect(pick(extractCandidates(lines("Parking income (14 stalls) $8,400 per year")))).toEqual([["other_income_annual", null, 8_400]]);
    expect(pick(extractCandidates(lines("Parking income (14 stalls): $8,400 per year")))).toEqual([["other_income_annual", null, 8_400]]);
    // A line whose only number is in parentheses is unchanged.
    const only = extractCandidates(lines("Parking income (14 stalls)"));
    expect(only.candidates).toEqual([]);
    expect(only.other.map((o) => o.value)).toEqual([14]);
  });
  test("a budget line whose label holds a number in parentheses keeps its amount", () => {
    const r = extractCandidates(lines("Item Amount", "Land (closed, 0.3 ha) $410,000", "Hard costs $1,100,000"));
    expect(pick(r)).toEqual([["land_cost", null, 410_000], ["hard_cost", null, 1_100_000]]);
    expect(r.candidates[0]).toMatchObject({ rule: "table:budget", location: "page 1, line 2" });
    expect(pick(extractCandidates(lines("Poste Montant", "Coût du terrain 310 000 $")))).toEqual([["land_cost", null, 310_000]]);
  });
  test("a bid whose division lines do not add up to its total raises both; one that adds up gives the value once", () => {
    const off = extractCandidates(lines("Division Amount", "Framing $400,000", "Mechanical $200,000", "Interior finishing $150,000", "Total hard cost $800,000"));
    const hard = off.candidates.filter((c) => c.fieldKey === "hard_cost");
    expect(hard.map((c) => [c.value, c.rule])).toEqual([[750_000, "table:budget-sum"], [800_000, "table:budget-total"]]);
    expect(hard[0]!.location).toBe("page 1, line 2, page 1, line 3, page 1, line 4");
    expect(hard[1]!.note).toContain("The printed total does not equal the sum of its lines");
    const same = extractCandidates(lines("Division Amount", "Framing $400,000", "Mechanical $200,000", "Interior finishing $200,000", "Total hard cost $800,000"));
    expect(same.candidates.filter((c) => c.fieldKey === "hard_cost").map((c) => c.value)).toEqual([800_000]);
  });
  test("unmapped lines in a spreadsheet budget are the components of the total below them; with no total they stay in other", () => {
    const t = (rows: (string | number)[][]) => extractCandidates(tableDoc(grid(["Description", "Cost"], ...rows)));
    const r = t([["Framing", 400_000], ["Mechanical", 200_000], ["Total des coûts directs", 650_000]]);
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["hard_cost", 600_000], ["hard_cost", 650_000]]);
    const none = t([["Framing", 400_000], ["Mechanical", 200_000]]);
    // Card 109 audit: framing names hard costs, but beside an unnamed line and no total it may be only part of them.
    expect(none.candidates).toEqual([]);
    expect(none.other.map((o) => o.value).sort()).toEqual([200_000, 400_000]);
    // Within a dollar is the same figure.
    expect(t([["Framing", 400_000], ["Mechanical", 200_000.5], ["Total hard cost", 600_000]]).candidates.map((c) => c.value)).toHaveLength(1);
  });
  test("a total starts a new run of lines: lines before an earlier total are not summed into the next one", () => {
    const r = extractCandidates(tableDoc(grid(["Item", "Amount"], ["Framing", 400_000], ["Total hard cost", 400_000], ["Design fees", 50_000], ["Total soft cost", 50_000])));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["hard_cost", 400_000], ["soft_cost", 50_000]]);
  });

  test("negative: a sentence that merely holds the words item and amount is not a header", () => {
    const r = extractCandidates(lines("The item amount below is only approximate", "Land (closed, 0.3 ha) $410,000"));
    expect(r.candidates.every((c) => c.rule === "line:prose")).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(0);
  });
  test("negative: a header with no rows under it is nothing, and a row with too few numbers is left to the prose reader", () => {
    expect(extractCandidates(lines("Plan Count Rent per month", "Rents follow the lender's schedule.")).candidates).toEqual([]);
    const r = extractCandidates(lines("Plan Count Floor area (sf) Rent per month", "Loft 3 480 $1,495", "Studio 480 $1,100"));
    expect(r.candidates.filter((c) => c.rule === "table:rent-roll").every((c) => c.itemKey === "Loft")).toBe(true);
    expect(r.candidates.some((c) => c.itemKey === "Studio" && c.rule === "table:rent-roll")).toBe(false);
  });
  test("negative: a footer or a figure that is not money does not become a budget line", () => {
    const r = extractCandidates(lines("Item Amount", "Land $410,000", "Prepared for the lender - page 1"));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 410_000]]);
    expect(r.other.some((o) => o.rule === "table:budget")).toBe(false);
  });
});

describe("prose: sentences, labels and refusals", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const others = (r: ReturnType<typeof extractCandidates>) => r.other.map((o) => [o.value, o.note]);

  test("a sentence wrapped across lines is read whole; its location is the line holding the number", () => {
    const r = read("The land is being bought", "for $520,000. Hard costs are", "estimated at $1,450,000.");
    expect(r.candidates.map((c) => [c.fieldKey, c.value, c.location])).toEqual([["land_cost", 520_000, "page 1, line 2"], ["hard_cost", 1_450_000, "page 1, line 3"]]);
    expect(r.candidates[0]!.context).toBe("The land is being bought for $520,000.");
  });
  test("negative: a line that ends a sentence, or a next line that starts a new one, is not joined", () => {
    expect(read("The land is a key item.", "for the lot we pay $500,000").candidates).toEqual([]);
    expect(read("The loan amount is", "Senior terms follow $1,000,000").candidates).toEqual([]);
  });
  test("two sentences on one line keep their own labels", () => {
    expect(pick(read("Hard costs: $1,450,000. We intend to hold for 5 years."))).toEqual([["hard_cost", 1_450_000], ["hold_years", 5]]);
    expect(pick(read("Interest rate: 5.9%. Amortization of 30 years."))).toEqual([["senior_rate_pct", 5.9], ["senior_amort_years", 30]]);
  });
  test("negative: a decimal or an abbreviation does not end a sentence", () => {
    expect(pick(read("Our land cost, per Ltd. Appraisal, is $410,000."))).toEqual([["land_cost", 410_000]]);
    expect(pick(read("The interest rate is 5.25% and the exit cap rate is 6.1%."))).toEqual([["senior_rate_pct", 5.25], ["exit_cap_rate_pct", 6.1]]);
  });
  test("a label that follows its number is used when the words before it name nothing", () => {
    expect(pick(read("We assume 95% stabilized occupancy and 6 months of lease-up."))).toEqual([["stabilized_occupancy_pct", 95], ["lease_up_months", 6]]);
    expect(pick(read("The sponsor expects a three-month lease-up."))).toEqual([["lease_up_months", 3]]);
  });
  test("negative: a number whose own label maps does not also take the words after it", () => {
    expect(pick(read("The hold period is 5 years with a lease-up"))).toEqual([["hold_years", 5]]);
  });
  test("an alias introduced by above or after is a reference; the alias nearest the number is the label", () => {
    expect(pick(read("After the preferred return is paid, the general partner receives a promote of 20%."))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("Promote above the preferred return 20%"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("Preferred return of 8% and promote of 20%"))).toEqual([["preferred_return_pct", 8], ["gp_promote_pct", 20]]);
  });
  test("number words and a three-month adjective are read, in English and French; an item name is not", () => {
    expect(pick(read("The lease-up period is eighteen months."))).toEqual([["lease_up_months", 18]]);
    expect(pick(read("La durée des travaux est de douze mois."))).toEqual([["construction_months", 12]]);
    expect(read("We will build three-bedroom suites.").other).toEqual([]);
  });
  test("an ordinal month is read as months", () => {
    expect(pick(read("We plan to refinance in month 30."))).toEqual([["refinance_month", 30]]);
    expect(pick(read("Refinancement au mois 26."))).toEqual([["refinance_month", 26]]);
  });
  test("times and fois are a multiple; a multiple is not a cost", () => {
    expect(pick(read("The lender requires a minimum DSCR of 1.25 times."))).toEqual([["min_dscr_covenant", 1.25]]);
    expect(pick(read("Le RCD minimal est de 1,15 fois."))).toEqual([["min_dscr_covenant", 1.15]]);
    expect(read("Hard costs are 3 times the land.").candidates).toEqual([]);
  });
  test("a year is never money in prose, but a bare number in a label/value line still is", () => {
    const r = read("Equity was contributed in May 2026.");
    expect(r.candidates).toEqual([]);
    expect(r.other.map((o) => o.value)).toEqual([2_026]);
    expect(read("We will invest equity of 720000.").candidates).toEqual([]);
    expect(pick(read("Equity: 720000"))).toEqual([["equity_amount", 720_000]]);
    expect(pick(read("Equity of $2,026,000 in May."))).toEqual([["equity_amount", 2_026_000]]);
  });
  test("a range is refused, in English and French", () => {
    const en = read("Hard costs are between $1,400,000 and $1,500,000.");
    expect(en.candidates).toEqual([]);
    expect(others(en)).toEqual([[1_400_000, "A range is not a value; enter the figure to use"], [1_500_000, "A range is not a value; enter the figure to use"]]);
    expect(read("Les frais de vente sont de 2 à 3 %.").candidates).toEqual([]);
    expect(read("We assume a hold of 5 - 7 years.").candidates).toEqual([]);
    expect(read("Construction takes from 12 to 14 months.").other.map((o) => o.value)).toEqual([12, 14]);
  });
  test("negative: two figures that are not a range are both read", () => {
    expect(pick(read("The hold period is 5 years and the lease-up period is 6 months."))).toEqual([["hold_years", 5], ["lease_up_months", 6]]);
    expect(pick(read("Hard costs are $1,450,000 - land is separate: $520,000."))).toEqual([["hard_cost", 1_450_000], ["land_cost", 520_000]]);
  });
  test("a hedged figure is refused with the reason; estimated and approximately are not hedges", () => {
    const r = read("I'd guess the expense ratio is 30% or so.");
    expect(r.candidates).toEqual([]);
    expect(r.other[0]!.note).toContain("hedged");
    expect(read("Selling costs are probably 3%.").candidates).toEqual([]);
    expect(read("Le taux de capitalisation à la sortie est à confirmer: 5,5 %.").candidates).toEqual([]);
    expect(pick(read("Selling costs are approximately 3%."))).toEqual([["selling_costs_pct", 3]]);
    expect(pick(read("Hard costs are estimated at $1,450,000."))).toEqual([["hard_cost", 1_450_000]]);
  });
  test("a figure about another property is refused with the reason", () => {
    const r = read("My other building had hard costs of $900,000.");
    expect(r.candidates).toEqual([]);
    expect(r.other[0]!.note).toContain("another property");
    expect(read("The comps show rents near $1,900 per month.").candidates).toEqual([]);
    // A neighbouring building's units and rents are not the deal's, now that a count names its type (task 55 audit).
    expect(read("The adjacent tower has 9 one-bed suites leasing at $2,350 per unit per month.").candidates).toEqual([]);
    expect(read("L'immeuble voisin loue ses 4 ½ à 1 950 $ par mois.").candidates).toEqual([]);
    expect(pick(read("Our hard costs are $1,450,000."))).toEqual([["hard_cost", 1_450_000]]);
  });
  test("a sentence that names an output gives no input for any number in it", () => {
    expect(read("At a 5.0% exit cap rate the indicative value is $12,000,000.").candidates).toEqual([]);
    expect(pick(read("The exit cap rate is 5.5%."))).toEqual([["exit_cap_rate_pct", 5.5]]);
  });
  test("a colon label that names nothing introduces prose; a heading is not an item", () => {
    expect(pick(read("Terms: the hold period is 5 years and the lease-up period is 6 months."))).toEqual([["hold_years", 5], ["lease_up_months", 6]]);
    expect(read("Objet : projet locatif de douze logements.").candidates).toEqual([]);
    expect(read("Purpose: a sixteen-suite rental building.").candidates).toEqual([]);
  });
});

describe("which loan a term belongs to, and the words small developers use", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const sheet = (...rows: (string | number | [number, "$" | "%" | "months" | "years"])[][]): NormalizedDocument => ({
    kind: "xlsx",
    lines: [],
    tables: [
      {
        name: "Sheet1",
        rows: rows.map((r, i) =>
          r.map((v, c): Cell => {
            const ref = `Sheet1!${"ABCD"[c]}${i + 1}`;
            if (Array.isArray(v)) return { text: String(v[0]), number: v[0], unit: v[1], ref };
            return typeof v === "number" ? { text: String(v), number: v, ref } : { text: v, ref };
          }),
        ),
      },
    ],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });

  describe("loan scope", () => {
    test.each([
      { name: "card construction commitment", lines: ["Northgate Capital | Indicative construction terms", "Construction commitment: $3,900,000", "Rate: 6.90%", "Interest-only period: 36 months from construction start", "The facility is repaid in full at the refinance.", "Loan term: 40 months; covers the refinance."], amount: 3900000, rate: 6.9, io: 36 },
      { name: "card engagement de construction", lines: ["Prêteur Nord | Modalités indicatives de construction", "Engagement de construction : 3 900 000 $", "Taux : 6,90 %", "Période d’intérêt seulement : 36 mois après le début de la construction", "Le prêt est remboursé en entier au refinancement.", "Durée : 40 mois; couvre le refinancement."], amount: 3900000, rate: 6.9, io: 36 },
      { name: "Stonebridge construction advance", lines: ["Stonebridge Credit | construction advance overview", "Loan amount: $2,600,000", "Rate: 6.40%", "Interest-only period: 30 months", "The advance ends at the refinance.", "The permanent loan will settle the balance."], amount: 2600000, rate: 6.4, io: 30 },
      { name: "Willow construction lender", lines: ["Willow Lending | construction lender offer", "Construction commitment: $4,200,000", "Rate: 7.10%", "Interest-only period: 24 months", "The refinance pays the balance.", "Repayment is scheduled at the permanent loan closing."], amount: 4200000, rate: 7.1, io: 24 },
      { name: "avance de construction des Pins", lines: ["Crédit des Pins | avance de construction", "Engagement de construction : 2 600 000 $", "Taux : 6,40 %", "Période d’intérêt seulement : 30 mois", "Cette avance prend fin au refinancement.", "Le prêt permanent réglera le solde."], amount: 2600000, rate: 6.4, io: 30 },
      { name: "financement de construction du Parc", lines: ["Banque du Parc | financement de construction", "Engagement de prêt de construction : 4 200 000 $", "Taux : 7,10 %", "Période d’intérêt seulement : 24 mois", "Le solde est payable au refinancement.", "Le prêt permanent permettra le remboursement."], amount: 4200000, rate: 7.1, io: 24 },
    ])("card 98r construction terms stay senior: $name", ({ lines, amount, rate, io }) => {
      const r = read(...lines);
      expect(pick(r)).toEqual([["senior_loan_amount", amount], ["senior_rate_pct", rate], ["senior_io_months", io]]);
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("refinance_"))).toBe(false);
    });
    test.each([
      "construction start", "construction starts", "construction started", "construction begins", "construction completion", "construction completes", "construction completed", "construction commencement", "construction end",
      "le début de la construction", "la fin de la construction", "l’achèvement de la construction",
    ])("card 98r a milestone does not block content scope: %s", (milestone) => {
      const french = /^(le |la |l’)/.test(milestone);
      const r = french
        ? read("Aperçu du financement", `Le refinancement est prévu au mois 30 après ${milestone}.`, "Les versements commencent au refinancement.", "Taux : 4,15 %", "Amortissement : 40 ans", "Période d’intérêt seulement : 0 mois")
        : read("Project funding overview", `Refinance in month 30 after ${milestone}.`, "Payments begin at the refinance.", "Rate: 4.15%", "Amortization: 40 years", "Interest-only period: 0 months");
      expect(pick(r)).toEqual(expect.arrayContaining([["refinance_rate_pct", 4.15], ["refinance_amort_years", 40], ["refinance_io_months", 0]]));
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
    });
    test.each([
      "Construction starts next spring; the construction lender will confirm the date.",
      "Le début de la construction est prévu au printemps; le financement de construction sera confirmé.",
    ])("card 98r a milestone does not hide another construction use: %s", (context) => {
      const r = read("Project funding overview", "Refinance in month 30.", "Payments begin at the refinance.", context, "Rate: 6.30%", "Amortization: 25 years");
      expect(pick(r)).toEqual([["refinance_month", 30], ["senior_rate_pct", 6.3], ["senior_amort_years", 25]]);
    });
    test.each(["Coûts de construction : 3 900 000 $", "Coûts de construction : 2 600 000 $", "Construction costs: $4,200,000"])("card 98r construction costs remain hard costs: %s", (line) => {
      const r = read(line);
      expect(r.candidates).toHaveLength(1);
      expect(r.candidates[0]!.fieldKey).toBe("hard_cost");
    });
    test.each([
      ["Take-out commitment", "Rate: 4.15%.", "Minimum DCR covenant: 1.10x.", 4.15, 1.1],
      ["Permanent mortgage offer", "Rate: 4.45%.", "Minimum DSCR: 1.22x.", 4.45, 1.22],
      ["Take-out financing", "Rate: 4.80%.", "Debt service coverage covenant: 1.18x.", 4.8, 1.18],
      ["Engagement de prêt permanent", "Taux : 4,45 %.", "CCD minimal : 1,22x.", 4.45, 1.22],
      ["Offre de refinancement", "Taux : 4,80 %.", "Ratio de couverture de la dette minimum : 1,18x.", 4.8, 1.18],
    ])("card 98r a take-out covenant remains deal-level: %s", (heading, rateLine, covenantLine, rate, covenant) => {
      expect(pick(read(heading as string, rateLine as string, covenantLine as string))).toEqual([["refinance_rate_pct", rate], ["min_dscr_covenant", covenant]]);
    });
    test.each(contentScopeCases)("card 98r a content-scoped take-out also reads its covenant: $name", ({ lines, expected }) => {
      const french = lines.some((line) => line.includes("refinancement"));
      const r = read(...lines, french ? "CCD minimal : 1,15x" : "CMHC minimum debt coverage covenant: 1.15x");
      expect(pick(r)).toEqual(expect.arrayContaining([...expected, ["min_dscr_covenant", 1.15]]));
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
    });
    test.each([
      ["Mezzanine term sheet", "Minimum DSCR: 1.30x"],
      ["Second mortgage offer", "Minimum DCR covenant: 1.25x"],
      ["Offre de prêt de second rang", "CCD minimal : 1,25x"],
      ["Financement mezzanine", "Ratio de couverture de la dette minimum : 1,30x"],
    ])("card 98r mezzanine still refuses the covenant: %s", (heading, line) => {
      const r = read(heading, line);
      expect(r.candidates.some((c) => c.fieldKey === "min_dscr_covenant")).toBe(false);
      expect(r.other).toHaveLength(1);
      expect(r.other[0]!.note).toContain("mezzanine loan");
    });

    test.each(contentScopeCases)("card 98 content scope: $name", ({ lines, expected }) => {
      const r = read(...lines);
      expect(pick(r)).toEqual(expect.arrayContaining(expected));
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
    });
    test.each([
      { name: "insured construction", lines: ["Ridgeview Commons - CMHC-insured construction loan", "Construction loan amount: $6,400,000.", "Interest rate: 6.10%.", "Interest-only during construction: 24 months."], expected: [["senior_loan_amount", 6400000], ["senior_rate_pct", 6.1], ["senior_io_months", 24]] },
      { name: "one refinance line", lines: ["Maple Court - project summary", "We plan to refinance in month 36 once stabilized.", "Interest rate: 6.50%.", "Amortization: 25 years."], expected: [["refinance_month", 36], ["senior_rate_pct", 6.5], ["senior_amort_years", 25]] },
      { name: "mixed loan sentences", lines: ["Financing summary", "Construction loan: $5,000,000 at 6.10%.", "Refinance in month 30 at 4.15%, amortized over 45 years."], expected: [["senior_loan_amount", 5000000], ["senior_rate_pct", 6.1], ["refinance_month", 30], ["refinance_rate_pct", 4.15], ["refinance_amort_years", 45]] },
      { name: "construction-period interest", lines: ["Oak Lane - financing notes", "Refinance in month 30.", "Payments start at the refinance.", "Interest rate: 6.25% during construction.", "Amortization: 30 years."], expected: [["refinance_month", 30], ["senior_rate_pct", 6.25], ["senior_amort_years", 30]] },
    ])("card 98 baseline pin: $name", ({ lines, expected }) => expect(pick(read(...lines))).toEqual(expected));
    test.each([
      ["Refinance in month 31.", "If the refinance closes late, the payment date may move."],
      ["Payments begin at the refinance.", "Unless the permanent loan funds, we will keep the present schedule."],
      ["Le refinancement est prévu au mois 29.", "Si le refinancement est retardé, le calendrier sera revu."],
      ["Les paiements commencent au refinancement.", "À moins que le prêt permanent soit accordé, le calendrier restera provisoire."],
      ["Refinance in month 31; the refinance begins the payment schedule."],
      ["Le refinancement est prévu au mois 29; les versements commencent au refinancement."],
    ])("card 98 counts distinct unconditional lines: %s", (...lines) => {
      const r = read("Project financing overview", ...lines, "Interest rate: 6.2%.", "Amortization: 25 years.");
      expect(pick(r)).toEqual(expect.arrayContaining([["senior_rate_pct", 6.2], ["senior_amort_years", 25]]));
      expect(r.candidates.some((c) => c.fieldKey === "refinance_rate_pct" || c.fieldKey === "refinance_amort_years")).toBe(false);
    });
    test.each([
      "The construction facility remains available for the project.",
      "A mezzanine loan remains outstanding on this property.",
      "Le prêt de construction demeure disponible pour le projet.",
      "Un prêt de second rang demeure en place pour cet immeuble.",
      "Interest is payable during construction.",
      "The budget includes construction interest.",
      "Construction draws incur interest each month.",
      "Les intérêts sont payables pendant la construction.",
      "Le budget comprend les intérêts de construction.",
    ])("card 98 a competing loan or construction-interest context blocks inference: %s", (context) => {
      const r = read("Project financing overview", "Refinance in month 31.", "Payments begin at the refinance.", context, "Interest rate: 6.2%.", "Amortization: 25 years.");
      expect(pick(r)).toEqual(expect.arrayContaining([["senior_rate_pct", 6.2], ["senior_amort_years", 25]]));
      expect(r.candidates.some((c) => c.fieldKey === "refinance_rate_pct" || c.fieldKey === "refinance_amort_years")).toBe(false);
    });

    test("a mezzanine email's generic labels are the mezzanine loan, and beside a senior term sheet they cause no conflict", () => {
      const mezz = read("Subject: second mortgage offer", "Amount: $450,000", "Rate: 11.5% per annum", "Interest-only: 36 months", "Amortization: 25 years", "Loan-to-value: 75%");
      expect(pick(mezz)).toEqual([["mezz_loan_amount", 450_000], ["mezz_rate_pct", 11.5], ["mezz_io_months", 36], ["mezz_amort_years", 25]]);
      expect(mezz.other.some((o) => o.value === 75)).toBe(true);
      const senior = read("Senior term sheet", "Loan amount: $5,200,000", "Rate: 5.9%", "Amortization: 30 years", "Interest-only: 24 months");
      expect(pick(senior)).toEqual([["senior_loan_amount", 5_200_000], ["senior_rate_pct", 5.9], ["senior_amort_years", 30], ["senior_io_months", 24]]);
      const proposals = consolidate([...mezz.candidates.map((c) => ({ ...c, documentId: "a", documentName: "a" })), ...senior.candidates.map((c) => ({ ...c, documentId: "b", documentName: "b" }))]);
      expect(proposals.filter((p) => p.status === "conflicting")).toEqual([]);
    });
    test("a take-out letter is the refinance, in English and in French", () => {
      const en = read("Re: take-out mortgage", "Loan amount: $3,100,000", "Rate: 4.65%", "Amortization: 40 years", "Loan-to-value: 65%", "Interest-only: 12 months", "Funding: month 28");
      expect(pick(en)).toEqual([["refinance_amount", 3_100_000], ["refinance_rate_pct", 4.65], ["refinance_amort_years", 40], ["refinance_ltv_pct", 65], ["refinance_io_months", 12], ["refinance_month", 28]]);
      const fr = read("Objet : prêt de refinancement", "Montant du prêt : 3 100 000 $", "Taux : 4,65 %", "Amortissement : 40 ans");
      expect(pick(fr)).toEqual([["refinance_amount", 3_100_000], ["refinance_rate_pct", 4.65], ["refinance_amort_years", 40]]);
    });
    test("with no title the loan is the senior loan, and a duration is not a refinance month", () => {
      expect(pick(read("Loan amount: $5,200,000", "Rate: 5.9%", "Loan-to-value: 65%"))).toEqual([["senior_loan_amount", 5_200_000], ["senior_rate_pct", 5.9]]);
      expect(pick(read("Re: take-out mortgage", "Funding: 6 months"))).toEqual([]);
    });
    test("a heading switches scope for the lines under it, in a text document and for a table in a Word file", () => {
      expect(pick(read("Senior loan", "Rate: 5.9%", "Mezzanine loan", "Rate: 11%", "Take-out loan", "Rate: 4.6%"))).toEqual([["senior_rate_pct", 5.9], ["mezz_rate_pct", 11], ["refinance_rate_pct", 4.6]]);
      const word: NormalizedDocument = {
        kind: "docx",
        lines: [{ text: "Financing summary", location: "paragraph 1" }, { text: "Take-out financing", location: "paragraph 2" }],
        tables: [{ name: "Table 1", at: 2, rows: [[{ text: "Rate", ref: "T1R1C1" }, { text: "4.65%", ref: "T1R1C2" }], [{ text: "Amortization", ref: "T1R2C1" }, { text: "40 years", ref: "T1R2C2" }]] }],
        pageCount: null,
        needsOcr: false,
        fullText: "Financing summary\nTake-out financing\nRate\n4.65%\nAmortization\n40 years",
      };
      expect(pick(extractCandidates(word))).toEqual([["refinance_rate_pct", 4.65], ["refinance_amort_years", 40]]);
      expect(pick(extractCandidates({ ...word, tables: [{ ...word.tables[0]!, at: 1 }] }))).toEqual([["senior_rate_pct", 4.65], ["senior_amort_years", 40]]);
    });
    test("a section label row in a sheet sets the scope for the rows under it", () => {
      const r = extractCandidates(sheet(["SENIOR LOAN"], ["Loan amount", [5_200_000, "$"]], ["Rate", [5.9, "%"]], ["Prêt mezzanine"], ["Loan amount", [450_000, "$"]], ["Rate", [11.5, "%"]], ["Take-out loan"], ["Loan amount", [3_100_000, "$"]]));
      expect(pick(r)).toEqual([["senior_loan_amount", 5_200_000], ["senior_rate_pct", 5.9], ["mezz_loan_amount", 450_000], ["mezz_rate_pct", 11.5], ["refinance_amount", 3_100_000]]);
    });
    test("the title may follow a banner line: any of the first three lines names the loan if it is short and has no number", () => {
      expect(pick(read("CONFIDENTIEL - Ne pas diffuser", "Fonds Cèdre S.E.C. - Lettre d'offre, prêt de deuxième rang", "Taux : 11,5 %", "Intérêts seulement : 18 mois"))).toEqual([["mezz_rate_pct", 11.5], ["mezz_io_months", 18]]);
      expect(pick(read("Private and confidential", "Harbour Capital Corp. - Offer letter for a second-position loan", "Rate: 11.5%", "Interest-only: 18 months"))).toEqual([["mezz_rate_pct", 11.5], ["mezz_io_months", 18]]);
      // The fourth line is too late, and a title with a number is not a title.
      expect(pick(read("Banner", "Another banner", "A third line", "Offer of a second mortgage from the lender named in this letter", "Rate: 11.5%"))).toEqual([["senior_rate_pct", 11.5]]);
      expect(pick(read("Second mortgage offer, 14 suites", "Rate: 11.5%"))).toEqual([["senior_rate_pct", 11.5]]);
    });
    test("a forwarded subject names the loan whatever its length or numbers", () => {
      expect(pick(read("Objet : TR : RE : Projet Dupuis - 12 logements + 1 local - demande de prêt permanent", "Amortissement : 40 ans", "Taux : 4,6 %"))).toEqual([["refinance_amort_years", 40], ["refinance_rate_pct", 4.6]]);
      expect(pick(read("Subject: FW: Re: Maple Court - 14 suites + 2 shops - request for take-out financing", "Amortization: 40 years", "Rate: 4.6%"))).toEqual([["refinance_amort_years", 40], ["refinance_rate_pct", 4.6]]);
    });
    test("a take-out or exit section at the end of a lender's letter is the refinance, not the senior loan", () => {
      const en = read("Construction loan", "Amortization: 30 years", "Interest-only: 24 months", "Take-out: Prairie Credit Union permanent loan", "Funding: month 30", "Loan amount: $3,100,000", "Amortization: 40 years", "Interest-only: 12 months", "Rate: 4.65%");
      expect(pick(en)).toEqual([["senior_amort_years", 30], ["senior_io_months", 24], ["refinance_month", 30], ["refinance_amount", 3_100_000], ["refinance_amort_years", 40], ["refinance_io_months", 12], ["refinance_rate_pct", 4.65]]);
      const fr = read("Prêt de construction", "Amortissement : 30 ans", "Intérêts seulement : 24 mois", "Sortie : prêt permanent de la Caisse populaire", "Montant du prêt : 3 100 000 $", "Amortissement : 40 ans", "Intérêts seulement : 12 mois", "Taux : 4,65 %");
      expect(pick(fr)).toEqual([["senior_amort_years", 30], ["senior_io_months", 24], ["refinance_amount", 3_100_000], ["refinance_amort_years", 40], ["refinance_io_months", 12], ["refinance_rate_pct", 4.65]]);
      const heading = read("Construction loan", "Rate: 6.1%", "Exit financing", "Rate: 4.65%", "Permanent financing", "Amortization: 40 years");
      expect(pick(heading)).toEqual([["senior_rate_pct", 6.1], ["refinance_rate_pct", 4.65], ["refinance_amort_years", 40]]);
      expect(pick(read("Prêt de construction", "Taux : 6,1 %", "Financement de sortie", "Taux : 4,65 %"))).toEqual([["senior_rate_pct", 6.1], ["refinance_rate_pct", 4.65]]);
      // Beside a senior-only letter, nothing conflicts.
      const all = consolidate([...en.candidates].map((c) => ({ ...c, documentId: "a", documentName: "a" })));
      expect(all.filter((p) => p.status === "conflicting")).toEqual([]);
    });
    test("an illustrative take-out amount that is not committed is shown, not read", () => {
      const r = read("Construction loan", "Rate: 6.1%", "Take-out: Prairie Credit Union permanent loan", "Illustrative amount, not committed: $1,800,000", "Rate: 4.65%");
      expect(pick(r)).toEqual([["senior_rate_pct", 6.1], ["refinance_rate_pct", 4.65]]);
      expect(r.other.some((o) => o.value === 1_800_000)).toBe(true);
      const fr = read("Prêt de construction", "Taux : 6,1 %", "Sortie : prêt permanent", "Montant indicatif, non engagé : 1 800 000 $");
      expect(pick(fr)).toEqual([["senior_rate_pct", 6.1]]);
      expect(fr.other.some((o) => o.value === 1_800_000)).toBe(true);
    });
    test("negative: an exit cap rate, or a lender's own type, sets no refinance scope", () => {
      expect(pick(read("Deal summary", "Exit cap rate: 5.25%", "Rate: 6.1%"))).toEqual([["exit_cap_rate_pct", 5.25], ["senior_rate_pct", 6.1]]);
      expect(pick(read("Taux de capitalisation de sortie : 5,25 %", "Taux : 6,1 %"))).toEqual([["exit_cap_rate_pct", 5.25], ["senior_rate_pct", 6.1]]);
      expect(pick(read("Construction loan", "Lender: Prairie Credit Union", "Rate: 6.1%"))).toEqual([["senior_rate_pct", 6.1]]);
      // A term sheet's indicative rate is the rate on offer, not a figure set aside.
      expect(read("Prêt de construction", "Taux indicatif : 6,25 %").other.some((o) => o.note === "Marked as not part of this deal")).toBe(false);
    });
    test("a rank row names the loan for the whole table, even for rows above it, and for the document when nothing else names one", () => {
      const lines = (t: string): NormalizedDocument => ({ ...sheet(), lines: [{ text: t, location: "l1" }] });
      const en = { ...lines("Term Sheet"), tables: sheet(["Loan amount", [450_000, "$"]], ["Facility", "Second mortgage, postponed to the bank's first charge"], ["Rate", [11.5, "%"]], ["Interest-only", [12, "months"]]).tables };
      expect(pick(extractCandidates(en))).toEqual([["mezz_loan_amount", 450_000], ["mezz_rate_pct", 11.5], ["mezz_io_months", 12]]);
      const fr = { ...lines("Feuille de modalités"), tables: sheet(["Montant", [450_000, "$"]], ["Rang", "Hypothèque de deuxième rang, subordonnée au prêt de la caisse"], ["Taux", [11.5, "%"]]).tables };
      expect(pick(extractCandidates(fr))).toEqual([["mezz_loan_amount", 450_000], ["mezz_rate_pct", 11.5]]);
      // The same row as a line of text sets the scope of a document with no title.
      expect(pick(read("Ranking: second charge", "Rate: 11.5%"))).toEqual([["mezz_rate_pct", 11.5]]);
      // A section that names its own loan overrides the row.
      expect(pick(read("Ranking: second charge", "Take-out loan", "Rate: 4.6%"))).toEqual([["refinance_rate_pct", 4.6]]);
    });
    test("a loan named at the start of a list item scopes every number on that item, and only that item", () => {
      expect(pick(read("Financing", "1) Rate: 5.9%, amortization 30 years", "2) Take-out: a credit union at 4.4% on a 40-year amortization, funding month 30", "3) Equity: the sponsor contributes $900,000"))).toEqual([["senior_rate_pct", 5.9], ["senior_amort_years", 30], ["refinance_amort_years", 40], ["refinance_month", 30], ["equity_amount", 900_000]]);
      expect(pick(read("Prêt permanent : une caisse à 4,4 % sur 40 ans d'amortissement", "Taux : 5,9 %"))).toEqual([["refinance_amort_years", 40], ["senior_rate_pct", 5.9]]);
    });
    test("postponed or subordinate to another loan names the document's loan as second-ranking, not the other", () => {
      expect(pick(read("Subject: loan subordinated to the senior lender's first mortgage", "Rate: 11%"))).toEqual([["mezz_rate_pct", 11]]);
      expect(pick(read("Objet : hypothèque postposée au premier rang de la banque", "Taux : 11 %"))).toEqual([["mezz_rate_pct", 11]]);
      expect(pick(read("Junior loan", "Rate: 11%"))).toEqual([["mezz_rate_pct", 11]]);
      expect(pick(read("Deuxième hypothèque", "Taux : 11 %"))).toEqual([["mezz_rate_pct", 11]]);
    });
    test("lender type never sets the loan, a senior letter that permits subordinate debt stays senior, and sections keep their own scope", () => {
      expect(pick(read("Mortgage Investment Corporation - Term Sheet", "Rank: first mortgage", "Rate: 9.5%"))).toEqual([["senior_rate_pct", 9.5]]);
      expect(pick(read("Fonds hypothécaire (caisse populaire) - Feuille de modalités", "Taux : 7,5 %"))).toEqual([["senior_rate_pct", 7.5]]);
      expect(pick(read("Private lender offer", "Rate: 9.5%"))).toEqual([["senior_rate_pct", 9.5]]);
      expect(pick(read("Commitment letter - construction loan", "Rate: 5.9%", "Amortization: 30 years", "Subordinate financing behind this loan is permitted with our consent."))).toEqual([["senior_rate_pct", 5.9], ["senior_amort_years", 30]]);
      expect(pick(read("Loan summary", "Construction loan", "Rate: 5.9%", "Mezzanine", "Rate: 11.5%"))).toEqual([["senior_rate_pct", 5.9], ["mezz_rate_pct", 11.5]]);
    });
    test("a body sentence never changes the scope", () => {
      expect(pick(read("Subject: take-out mortgage", "This replaces the first mortgage after completion of the building.", "Rate: 4.65%"))).toEqual([["refinance_rate_pct", 4.65]]);
      expect(pick(read("Subject: take-out mortgage", "A short line about the senior lender.", "Rate: 4.65%"))).toEqual([["refinance_rate_pct", 4.65]]);
    });
    test("a heading that names two scopes sets none; a label that names its tranche keeps its own field", () => {
      expect(pick(read("Senior loan", "Take-out of the construction loan", "Rate: 5.9%"))).toEqual([["senior_rate_pct", 5.9]]);
      expect(pick(read("Mezzanine loan terms", "Senior rate: 5.9%", "Rate: 11%"))).toEqual([["senior_rate_pct", 5.9], ["mezz_rate_pct", 11]]);
      expect(pick(read("Take-out amortization: 40 years", "Mezzanine rate: 11%"))).toEqual([["refinance_amort_years", 40], ["mezz_rate_pct", 11]]);
    });
    test("a repayment month is the refinance month whichever loan the section is about; a bare month number under a month label is read", () => {
      expect(pick(read("Senior term sheet", "The construction loan is to be repaid at month 26."))).toEqual([["refinance_month", 26]]);
      expect(pick(read("Refinance month: 26"))).toEqual([["refinance_month", 26]]);
      expect(read("Construction month: 26").candidates).toEqual([]);
    });
    test("a loose word gives way to a specific alias, and stands only at the end of its label or before a verb phrase", () => {
      expect(pick(read("Imprévus de construction : 150 000 $"))).toEqual([["contingency", 150_000]]);
      expect(pick(read("Construction should take twelve months."))).toEqual([["construction_months", 12]]);
      expect(read("Loan fee: $20,000").candidates).toEqual([]);
      expect(read("The loan officer is paid $20,000.").candidates).toEqual([]);
    });
    test("a covenant the scope's loan has no field for is left in other, not given to the senior loan", () => {
      const r = read("Mezzanine loan terms", "Minimum DSCR: 1.10");
      expect(r.candidates).toEqual([]);
      expect(r.other[0]!.note).toBeTruthy();
      expect(pick(read("Senior term sheet", "Minimum DSCR: 1.20"))).toEqual([["min_dscr_covenant", 1.2]]);
    });
  });

  describe("a loan named before 'of' or 'de' labels the amount after it (task 51)", () => {
    test("a possessive or article before the name, a linking word after it", () => {
      expect(pick(read("Votre prêt de second rang de 380 000 $ comble l'écart avec notre mise de fonds."))).toEqual([["mezz_loan_amount", 380_000]]);
      expect(pick(read("Notre prêt de second rang pour 125 000 $ s'ajoute à nos liquidités."))).toEqual([["mezz_loan_amount", 125_000]]);
      expect(pick(read("Notre prêt de premier rang de 2 100 000 $ est avancé avec nos fonds propres."))).toEqual([["senior_loan_amount", 2_100_000]]);
    });
    test("negative: a loan with a figure of its own, and plain equity, are read as before", () => {
      expect(pick(read("Notre mise de fonds de 380 000 $ complète le prêt."))).toEqual([["equity_amount", 380_000]]);
    });
  });

  describe("the exit cap rate comes from the sentence", () => {
    test("a cap rate in a sentence about a sale is the exit cap rate; alone it stays unread", () => {
      expect(pick(read("We plan to sell at a 5.0% cap rate."))).toEqual([["exit_cap_rate_pct", 5]]);
      expect(pick(read("Cap rate on reversion: 5.25%"))).toEqual([["exit_cap_rate_pct", 5.25]]);
      expect(pick(read("Nous vendrons à un taux de capitalisation de 5,5 %."))).toEqual([["exit_cap_rate_pct", 5.5]]);
      expect(read("The going-in cap rate is 6%.").candidates).toEqual([]);
      expect(read("Cap rate: 5.25%").candidates).toEqual([]);
      expect(read("Le taux de capitalisation est de 5,5 %.").candidates).toEqual([]);
    });
    test("a percentage directly followed by cap, in a sentence about a sale, is the exit cap rate (task 51)", () => {
      expect(pick(read("Disposition at a 6.1% cap after year five."))).toEqual([["exit_cap_rate_pct", 6.1]]);
      expect(pick(read("We expect to sell at a 5.9% cap."))).toEqual([["exit_cap_rate_pct", 5.9]]);
      expect(pick(read("Revente à 5,8 % cap."))).toEqual([["exit_cap_rate_pct", 5.8]]);
      // negative: no sale word keeps the going-in note; "cap of", "cap on" and "capped" are not the rate
      const going = read("Acquired at a 5.2% cap.");
      expect(going.candidates).toEqual([]);
      expect(going.other.map((o) => o.note)).toEqual([expect.stringMatching(/going-in/)]);
      expect(read("The sale price carries a 3% cap on fees.").candidates).toEqual([]);
      expect(read("On the sale, fees are capped at 3%.").candidates).toEqual([]);
      // negative: a sale that already happened is a comparable, whether "cap" or "cap rate" follows
      for (const line of ["We sell at a 5.5% cap; the triplex on Elm sold last fall at a 4.6% cap.", "The corner building traded at a 4.4% cap rate in March."]) {
        const comp = read(line);
        expect(comp.candidates.filter((c) => c.value !== 5.5), line).toEqual([]);
        expect(comp.other.find((o) => o.value === 4.6 || o.value === 4.4)?.note, line).toBe("A completed sale's cap rate, not this deal's exit");
      }
    });
    test("a sentence that names a value is refused", () => {
      expect(read("On a sale, a 4.5% cap rate gives a value of $12,000,000.").candidates).toEqual([]);
      expect(read("A 4.5% cap rate value of $12,000,000.").candidates).toEqual([]);
    });
  });

  describe("vocabulary", () => {
    test("timeline: construction, build, travaux, lease-up and hold phrasings", () => {
      expect(pick(read("Construction 14 months"))).toEqual([["construction_months", 14]]);
      expect(pick(read("Build: 12 months", "Construction schedule: 15 months"))).toEqual([["construction_months", 12], ["construction_months", 15]]);
      expect(pick(read("Travaux : 12 mois"))).toEqual([["construction_months", 12]]);
      expect(pick(read("La construction durera 14 mois."))).toEqual([["construction_months", 14]]);
      expect(pick(read("Lease-up to stabilization: 6 months", "Période de location : 5 mois"))).toEqual([["lease_up_months", 6], ["lease_up_months", 5]]);
      expect(pick(read("Hold after stabilization: 5 years", "Horizon de détention : 7 ans"))).toEqual([["hold_years", 5], ["hold_years", 7]]);
      // negatives: a bare number is not months, a place is not a period
      expect(read("Construction: 14").candidates).toEqual([]);
      expect(read("Location: Moncton, 2 blocks from the river").candidates).toEqual([]);
    });
    test("coûts mous are the soft costs, and the fee words after the figure do not make it a fee (task 51)", () => {
      expect(pick(read("Les coûts mous sont de 312 000 $ avec les honoraires et les permis."))).toEqual([["soft_cost", 312_000]]);
      expect(pick(read("Coûts mous : 312 000 $"))).toEqual([["soft_cost", 312_000]]);
    });
    test("budget: land, building budget, construction and soft costs", () => {
      expect(pick(read("Terrain : 410 000 $", "Lot: $420,000", "Site: $430,000"))).toEqual([["land_cost", 410_000], ["land_cost", 420_000], ["land_cost", 430_000]]);
      expect(pick(read("Building budget: $1,800,000", "Construction: $2,100,000"))).toEqual([["hard_cost", 1_800_000], ["hard_cost", 2_100_000]]);
      expect(pick(read("Frais indirects : 190 000 $, 3 100 000 $"))).toEqual([["soft_cost", 190_000]]);
      // negatives: a lot number is not land, a site area is not land, a construction loan is not hard costs
      expect(read("Lot 7").candidates).toEqual([]);
      expect(read("Lot: 7").candidates).toEqual([]);
      expect(read("Allotment: $400,000").candidates).toEqual([]);
      expect(pick(read("Construction loan: $2,000,000"))).toEqual([["senior_loan_amount", 2_000_000]]);
    });
    test("budget: Other and Autres are other costs in a budget table only", () => {
      const r = extractCandidates(sheet(["Item", "Amount"], ["Land", [410_000, "$"]], ["Other", [25_000, "$"]]));
      expect(pick(r)).toEqual([["land_cost", 410_000], ["other_cost", 25_000]]);
      expect(pick(extractCandidates(sheet(["Item", "Montant"], ["Autres", [25_000, "$"]])))).toEqual([["other_cost", 25_000]]);
      expect(read("Other: $25,000").candidates).toEqual([]);
      expect(pick(read("Other income: $12,000"))).toEqual([["other_income_annual", 12_000]]);
    });
    test("operating costs are fixed dollars, or the ratio with a percent sign; variable costs are the variable share", () => {
      expect(pick(read("Operating costs: $48,000", "Total operating costs: $49,000", "Frais d'exploitation : 50 000 $"))).toEqual([["fixed_opex_annual", 48_000], ["fixed_opex_annual", 49_000], ["fixed_opex_annual", 50_000]]);
      expect(pick(read("Operating costs: 34%", "Dépenses d'exploitation : 35 %"))).toEqual([["expense_ratio_pct", 34], ["expense_ratio_pct", 35]]);
      expect(pick(read("Variable operating costs: 4%", "Frais variables : 5 %"))).toEqual([["variable_expense_pct", 4], ["variable_expense_pct", 5]]);
      expect(read("Operating costs: 34").candidates).toEqual([]);
    });
    test("other income: parking, laundry and storage when the figure is money", () => {
      expect(pick(read("Parking: $14,400", "Laundry: $3,600 per year", "Stationnement : 15 600 $"))).toEqual([["other_income_annual", 14_400], ["other_income_annual", 3_600], ["other_income_annual", 15_600]]);
      expect(pick(read("Parking income: $1,200 per month"))).toEqual([["other_income_annual", 14_400]]);
      expect(read("Parking: 14 stalls").candidates).toEqual([]);
      expect(read("Storage: $75 per month").candidates).toEqual([]);
    });
    test("stabilized occupancy: occupied, occupancy and taux d'occupation", () => {
      expect(pick(read("Occupied: 95%", "Taux d'occupation : 94 %"))).toEqual([["stabilized_occupancy_pct", 95], ["stabilized_occupancy_pct", 94]]);
      expect(read("Occupied: 12 suites").candidates).toEqual([]);
    });
    test("the senior loan: loan, prêt, term loan, facility amount; rate, taux, au taux de; amortizes over", () => {
      expect(pick(read("Loan: $5,200,000", "Term loan: $5,300,000", "Construction/term loan: $5,400,000", "Facility amount: $5,500,000"))).toEqual([["senior_loan_amount", 5_200_000], ["senior_loan_amount", 5_300_000], ["senior_loan_amount", 5_400_000], ["senior_loan_amount", 5_500_000]]);
      expect(pick(read("Prêt : 5 200 000 $", "Taux : 5,9 %"))).toEqual([["senior_loan_amount", 5_200_000], ["senior_rate_pct", 5.9]]);
      expect(pick(read("Le prêt est consenti au taux de 5,9 %, avec un amortissement de 30 ans."))).toEqual([["senior_rate_pct", 5.9], ["senior_amort_years", 30]]);
      expect(pick(read("The loan amortizes over 30 years at a rate of 5.9%."))).toEqual([["senior_amort_years", 30], ["senior_rate_pct", 5.9]]);
    });
    test("generic words lose to a longer alias, respect the unit and never match inside a word", () => {
      expect(pick(read("Rent growth rate: 3%"))).toEqual([["rent_growth_pct", 3]]);
      expect(pick(read("Occupancy rate: 95%"))).toEqual([["stabilized_occupancy_pct", 95]]);
      expect(read("Vacancy rate: 5%").candidates).toEqual([]);
      expect(pick(read("Loan to cost: 70%"))).toEqual([["stated_ltc_pct", 70]]);
      expect(read("Rate: $5,000").candidates).toEqual([]);
      expect(read("Investors: $500,000").candidates).toEqual([]);
      expect(read("Outlot: $400,000").candidates).toEqual([]);
    });
    test("the DSCR covenant in its longer phrasings", () => {
      expect(pick(read("Minimum debt service coverage: 1.20x", "Minimum DCR: 1.15", "DCR covenant: 1.10x", "Minimum debt service coverage ratio: 1.25"))).toEqual([["min_dscr_covenant", 1.2], ["min_dscr_covenant", 1.15], ["min_dscr_covenant", 1.1], ["min_dscr_covenant", 1.25]]);
      expect(pick(read("The lender requires a debt service coverage ratio of at least 1.2 times."))).toEqual([["min_dscr_covenant", 1.2]]);
      expect(pick(read("Ratio de couverture du service de la dette minimal : 1,15"))).toEqual([["min_dscr_covenant", 1.15]]);
      expect(read("Debt service coverage: 1.20x").candidates).toEqual([]);
    });
    test("equity in the words a sponsor uses", () => {
      expect(pick(read("Own money: $700,000", "Cash equity: $710,000", "We will contribute $720,000.", "We are putting in $730,000.", "The sponsor will invest $740,000."))).toEqual([["equity_amount", 700_000], ["equity_amount", 710_000], ["equity_amount", 720_000], ["equity_amount", 730_000], ["equity_amount", 740_000]]);
      expect(pick(read("Apport : 700 000 $", "Le promoteur investira 710 000 $."))).toEqual([["equity_amount", 700_000], ["equity_amount", 710_000]]);
      expect(read("We will invest 50% of the budget.").candidates).toEqual([]);
      expect(read("Contributions are due in month 3.").candidates).toEqual([]);
    });
    test("the waterfall: LP share, promote and preferred return", () => {
      expect(pick(read("The limited partners' share of equity is 90%.", "Limited partners contribute 85%.", "LP share of equity: 80%"))).toEqual([["lp_share_pct", 90], ["lp_share_pct", 85], ["lp_share_pct", 80]]);
      expect(pick(read("A general partner promote of 20%.", "The general partner receives 25%."))).toEqual([["gp_promote_pct", 20], ["gp_promote_pct", 25]]);
      expect(pick(read("A preferred return of 8%."))).toEqual([["preferred_return_pct", 8]]);
      expect(read("The general partner receives a $50,000 fee.").candidates).toEqual([]);
    });
  });

  describe("sheets and tables with several sections", () => {
    test("a header row, or a section label row, ends the section before it", () => {
      const r = extractCandidates(
        sheet(
          ["Item", "Amount"], ["Land", [410_000, "$"]], ["Hard costs", [1_900_000, "$"]],
          ["Unit type", "Units", "Rent per month"], ["Studio", 4, [1_450, "$"]], ["1BR", 6, [1_750, "$"]],
          ["SENIOR LOAN"], ["Loan amount", [5_200_000, "$"]], ["Rate", [5.9, "%"]],
          ["Mezzanine loan"], ["Rate", [11.5, "%"]],
        ),
      );
      expect(r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([
        ["land_cost", null, 410_000], ["hard_cost", null, 1_900_000],
        ["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1_450], ["unit_count", "1BR", 6], ["unit_rent_monthly", "1BR", 1_750],
        ["senior_loan_amount", null, 5_200_000], ["senior_rate_pct", null, 5.9], ["mezz_rate_pct", null, 11.5],
      ]);
    });
    test("French section labels, and rows under a label with no column header, are label and value rows", () => {
      const r = extractCandidates(sheet(["Répartition des logements"], ["Type de logement", "Nombre de logements", "Loyer mensuel"], ["Studio", 3, [1_300, "$"]], ["Revenus"], ["Taux d'occupation stabilisé", [95, "%"]], ["Prêt de construction"], ["Taux", [6.1, "%"]]));
      expect(r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "Studio", 3], ["unit_rent_monthly", "Studio", 1_300], ["stabilized_occupancy_pct", null, 95], ["senior_rate_pct", null, 6.1]]);
    });
    test("negative: a row with a number is not a section label, and a total does not end a budget", () => {
      const r = extractCandidates(sheet(["Item", "Amount"], ["Land", [410_000, "$"]], ["Hard costs", [1_900_000, "$"]], ["Total", [2_310_000, "$"]], ["Contingency", [100_000, "$"]]));
      expect(pick(r)).toEqual([["land_cost", 410_000], ["hard_cost", 1_900_000], ["contingency", 100_000]]);
    });
  });

  describe("French text-table rows with trailing units", () => {
    const fr = (...text: string[]) => read("Financement : 1 250 000 $", ...text);
    test("a value followed by a unit phrase counts as one number in the run", () => {
      const r = fr("Type Nombre Loyer par mois Superficie (pi²)", "Studio 4 1 450 $ par mois 480 pi²", "Deux chambres 6 1 780 $ par mois 720 pi²");
      expect(r.candidates.filter((c) => c.fieldKey !== "senior_loan_amount" && c.fieldKey !== null).map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([
        ["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1_450], ["rentable_area_sf", "Studio", 1_920],
        ["unit_count", "2BR", 6], ["unit_rent_monthly", "2BR", 1_780], ["rentable_area_sf", "2BR", 4_320],
      ]);
    });
    test("a rent per pi² per year, and an annual rent written par année in a middle column", () => {
      const a = fr("Espace Superficie Loyer au pi²", "Café 1 200 pi² 22,50 $/pi²/an", "Boutique 900 pi² 24,00 $/pi²/an");
      expect(a.candidates.filter((c) => c.itemKey).map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([
        ["rent_psf_annual", "Café", 22.5], ["rentable_area_sf", "Café", 1_200], ["rent_psf_annual", "Boutique", 24], ["rentable_area_sf", "Boutique", 900],
      ]);
      const b = fr("Type Loyer annuel Nombre de logements", "Studio 18 500 $ par année 4", "Loft 24 000 $ par année 2");
      expect(b.candidates.filter((c) => c.itemKey).map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([
        ["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 18_500 / 12], ["unit_count", "Loft", 2], ["unit_rent_monthly", "Loft", 2_000],
      ]);
    });
    test("negative: a row that is one number short is not a row", () => {
      const r = fr("Type Nombre Loyer par mois", "Studio 4 1 450 $ par mois", "Merci de confirmer 12");
      expect(r.candidates.filter((c) => c.itemKey)).toHaveLength(2);
    });
  });

  describe("rents and counts stated in prose", () => {
    const items = (r: ReturnType<typeof extractCandidates>) => r.candidates.filter((c) => c.itemKey).map((c) => [c.fieldKey, c.itemKey, c.value]);
    test("a rent takes its item from the unit-type words of its clause", () => {
      expect(items(read("The two-bedroom suites rent for $2,050 a month."))).toEqual([["unit_rent_monthly", "2BR", 2_050]]);
      expect(items(read("Studios will rent at $1,350 per month and lofts at $2,200 monthly."))).toEqual([["unit_rent_monthly", "Studio", 1_350], ["unit_rent_monthly", "Loft", 2_200]]);
    });
    test("a count and a rent in one clause pair to the same item", () => {
      expect(items(read("Six two-bedroom units at $2,010 per month."))).toEqual([["unit_count", "2BR", 6], ["unit_rent_monthly", "2BR", 2_010]]);
      expect(items(read("Trois 3½ à 1 580 $ par mois."))).toEqual([["unit_count", "3½", 3], ["unit_rent_monthly", "3½", 1_580]]);
    });
    test("counts: number words and digits before unit-type words", () => {
      expect(items(read("The building will have four studios and seven one-bedroom suites."))).toEqual([["unit_count", "Studio", 4], ["unit_count", "1BR", 7]]);
      expect(items(read("We will build 4 studios and 7 2-bed units."))).toEqual([["unit_count", "Studio", 4], ["unit_count", "2BR", 7]]);
    });
    test("a list of types with no noun is read per clause, and a total before a colon is no item's count", () => {
      expect(items(read("Eighteen suites: six one-bedroom, eight two-bedroom and four three-bedroom."))).toEqual([["unit_count", "1BR", 6], ["unit_count", "2BR", 8], ["unit_count", "3BR", 4]]);
      expect(items(read("Borrower: Maple Court Inc., 10 units."))).toEqual([]);
    });
    test("negative: no unit-type word, two unit types, or a name that is not a unit type reads nothing", () => {
      expect(items(read("Six units at $2,010 per month."))).toEqual([]);
      expect(items(read("Six one- and two-bedroom suites at $1,900 a month."))).toEqual([]);
      expect(items(read("Subject: the building rents for $1,900 a month."))).toEqual([]);
      expect(items(read("Purpose: Maple Court Inc. seeks $2,000,000."))).toEqual([]);
      expect(items(read("The two-bedroom comps rent for $2,400 a month."))).toEqual([]);
    });
  });
});

describe("reading safety: a figure that may be the wrong one is shown, never used", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: tables.length ? "xlsx" : "pdf",
    lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const items = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);
  const noteOf = (r: ReturnType<typeof extractCandidates>, value: number) => r.other.find((o) => o.value === value)?.note ?? "";
  // A grid: a string is a text cell, a number a bare number, [n, unit] a number whose format names its unit.
  type Cellish = string | number | [number, "$" | "%" | "months" | "years"];
  const grid = (name: string, ...rows: Cellish[][]): Table => ({
    name,
    rows: rows.map((r, i) =>
      r.map((v, c): Cell => {
        const ref = `${name}!${"ABCDE"[c]}${i + 1}`;
        if (Array.isArray(v)) return { text: String(v[0]), number: v[0], unit: v[1], ref };
        return typeof v === "number" ? { text: String(v), number: v, ref } : { text: v, ref };
      }),
    ),
  });
  const sheets = (...tables: Table[]) => extractCandidates({ ...doc([], tables), fullText: tables.flatMap((t) => t.rows.map((r) => r.map((c) => c.text).join(" "))).join("\n") });

  describe("task 53: reads behind the v4 trap files", () => {
    const sheet = (...rows: Cellish[][]) => sheets(grid("Budget", ...rows));
    test("a figure outside what its field can hold is shown, never read, and never flipped", () => {
      const r = read("Land cost: (1,250,000)", "Hard costs: $2,000,000");
      expect(pick(r)).toEqual([["hard_cost", 2_000_000]]);
      expect(noteOf(r, -1_250_000)).toBe("The figure is outside what Land cost can hold");
      expect(pick(read("Land cost: $1,250,000"))).toEqual([["land_cost", 1_250_000]]);
    });
    test("a Line item column labels a budget row; a Description column still does", () => {
      expect(pick(sheet(["Category", "Line item", "Amount"], ["soft", "Hard costs", 410_000]))).toEqual([["hard_cost", 410_000]]);
      expect(pick(sheet(["Groupe", "Poste budgétaire", "Montant"], ["a", "Terrain", 90_000]))).toEqual([["land_cost", 90_000]]);
      expect(pick(sheet(["Division", "Description", "Amount"], ["hard", "Hard costs", 410_000]))).toEqual([["hard_cost", 410_000]]);
    });
    test("a row marked as not an input is not read", () => {
      for (const note of ["not a modeled input", "Not currently modelled", "for reference only", "memo item", "for information only", "pour information seulement", "à titre indicatif"]) {
        const r = sheet(["Item", "Amount", "Note"], ["Other costs", 90_000, note]);
        expect(pick(r)).toEqual([]);
        expect(noteOf(r, 90_000)).toBe("Marked as not part of this deal");
      }
      expect(pick(sheet(["Item", "Amount", "Note"], ["Land", 90_000, "paid at closing"]))).toEqual([["land_cost", 90_000]]);
    });
    test("an interest reserve joined with a fee is not the interest reserve", () => {
      for (const line of ["Lender fees and interest reserve: $410,000", "Interest reserve + financing fees: $410,000", "Financing costs and interest reserve: $410,000", "Réserve d'intérêts et frais de financement : 410 000 $"]) {
        const r = read(line);
        expect(pick(r)).toEqual([]);
        expect(noteOf(r, 410_000)).toBe("A combined figure; the interest reserve is not stated alone");
      }
      expect(pick(read("Interest reserve: $200,000"))).toEqual([["stated_interest_reserve", 200_000]]);
    });
    test("a second field named after a colon's figure labels its own figure", () => {
      expect(pick(read("Rent monthly: $1,400 per unit and a vacancy of 5%."))).toEqual([["unit_rent_monthly", 1_400], ["stabilized_occupancy_pct", 95]]);
      // negative: a part the colon's budget line includes is not read as a line of its own
      const inside = read("Construction cost: $3,100,000, which includes a contingency of $200,000.");
      expect(pick(inside)).toEqual([["hard_cost", 3_100_000]]);
      expect(noteOf(read("Rent monthly: $1,400 and $1,600"), 1_600)).toBe("Another number on this line was used");
    });
  });

  describe("task 54: draw conditions, loan terms, partner rates, unused scenarios and old sheets", () => {
    const COND = "A lender's condition, not the occupancy assumption";
    const TERM_NOTE = "A loan's term, not the build period, hold or amortization";
    const NOT_PART = "Marked as not part of this deal";
    const OLD_NOTE = "An earlier figure, named old or original by its own label; a later figure for the line replaces it";
    test("an occupancy that releases an advance is the lender's condition; stabilized occupancy still reads", () => {
      for (const [line, v] of [
        ["The final tranche is funded once the property is 84% leased.", 84],
        ["Holdback paid upon reaching 78% occupancy.", 78],
        ["La banque autorise le dernier tirage lorsque l'immeuble est loué à 82 %.", 82],
        ["Retenue libérée à 77 % d'occupation.", 77],
      ] as const) {
        const r = read(line);
        expect(pick(r), line).toEqual([]);
        expect(noteOf(r, v), line).toBe(COND);
      }
      expect(pick(read("Stabilized occupancy: 94%"))).toEqual([["stabilized_occupancy_pct", 94]]);
      expect(pick(read("We expect 93% occupancy after a nine-month lease-up.")).filter((p) => p[0] === "stabilized_occupancy_pct")).toEqual([["stabilized_occupancy_pct", 93]]);
      // "Retenue" is a holdback only as "retenue de garantie"; an assumption "retenue" is the sponsor's.
      expect(pick(read("Occupation stabilisée retenue : 95 %"))).toEqual([["stabilized_occupancy_pct", 95]]);
    });
    test("a figure named as the loan's term is never its interest-only period", () => {
      for (const line of ["The 30-month term is separate from the interest-only period.", "Loan term 20 months; interest only for 8 months."]) {
        const r = read(line);
        expect(pick(r).filter((p) => p[0] === "senior_io_months" && (p[1] === 30 || p[1] === 20)), line).toEqual([]);
        expect(noteOf(r, line.startsWith("The") ? 30 : 20), line).toBe(TERM_NOTE);
      }
      expect(pick(read("Loan term 20 months; interest only for 8 months."))).toContainEqual(["senior_io_months", 8]);
      expect(pick(read("12 months IO."))).toContainEqual(["senior_io_months", 12]);
      expect(pick(read("Interest-only term: 15 months"))).toContainEqual(["senior_io_months", 15]);
    });
    test("a partner's rate is never a loan's rate", () => {
      for (const [line, v] of [["Hurdle rate: 9%", 9], ["Priority return rate: 7%", 7]] as const) {
        const r = read(line);
        expect(pick(r).filter((p) => p[0] === "senior_rate_pct"), line).toEqual([]);
        expect(r.other.some((o) => o.value === v) || pick(r).some((p) => p[0] === "preferred_return_pct" && p[1] === v), line).toBe(true);
      }
      expect(pick(read("Preference rate: 7%"))).toEqual([["preferred_return_pct", 7]]);
      expect(pick(read("Promote rate: 20%")).filter((p) => p[0] === "senior_rate_pct")).toEqual([]);
      expect(pick(read("Taux de rendement privilégié : 6 %"))).toEqual([["preferred_return_pct", 6]]);
      expect(pick(read("Interest rate: 6.5%"))).toEqual([["senior_rate_pct", 6.5]]);
      expect(pick(read("Senior loan: 6.4%"))).toEqual([["senior_rate_pct", 6.4]]);
      // "Preferred" naming the lender is no partner's return; preferred equity's rate is no preferred return.
      expect(pick(read("Preferred lender rate: 6.3%"))).toEqual([["senior_rate_pct", 6.3]]);
      expect(pick(read("Preferred equity rate: 12%")).filter((p) => p[0] === "preferred_return_pct" || p[0] === "senior_rate_pct")).toEqual([]);
    });
    test("a line marked as an unused scenario is not part of the deal", () => {
      for (const [line, v] of [
        ["Scenario not pursued: loan $2,900,000 at 7%.", 2_900_000],
        ["Option B (rejected): loan $3,100,000 at 8%.", 3_100_000],
        ["Scénario non retenu : prêt de 3 300 000 $.", 3_300_000],
        ["Option écartée : prêt de 3 400 000 $.", 3_400_000],
        ["The earlier structure is superseded: loan $3,500,000.", 3_500_000],
      ] as const) {
        const r = read(line);
        expect(pick(r), line).toEqual([]);
        expect(noteOf(r, v), line).toBe(NOT_PART);
      }
      expect(pick(read("Scenario not pursued", "Loan amount: $2,900,000", "Rate: 7%", "Current plan", "Loan amount: $3,000,000"))).toEqual([["senior_loan_amount", 3_000_000]]);
      expect(pick(read("Downside scenario: rate 8.5%.")).filter((p) => p[0] === "senior_rate_pct")).toEqual([]);
    });
    test("every figure on a sheet named old or superseded is shown, not read; other sheets read", () => {
      const rows = [["Land", [410_000, "$"]], ["Hard costs", [1_900_000, "$"]]] as Cellish[][];
      for (const name of ["Prior version", "Archive", "Superseded", "Ancien budget", "Original budget"]) {
        const r = sheets(grid(name, ...rows));
        expect(pick(r), name).toEqual([]);
        expect(noteOf(r, 410_000), name).toBe(OLD_NOTE);
      }
      expect(pick(sheets(grid("Inputs", ...rows)))).toEqual([["land_cost", 410_000], ["hard_cost", 1_900_000]]);
      const both = sheets(grid("Original budget", ["Land", [400_000, "$"]]), grid("Budget", ["Land", [410_000, "$"]]));
      expect(pick(both)).toEqual([["land_cost", 410_000]]);
    });
  });

  describe("task 56: permanent and second loans, scenario sheets and in-line corrections", () => {
    const SCENARIO = "A scenario sheet, not the deal's base case";
    const ADJUST = "A rate before an adjustment, not the loan's rate";
    test("a permanent mortgage is the take-out loan; a construction loan stays senior", () => {
      const r = read("Once complete, the lender converts to a permanent mortgage of $2,100,000 at a conversion rate of 5.1%, amortized over 30 years.");
      expect(pick(r).filter((p) => String(p[0]).startsWith("senior_"))).toEqual([]);
      expect(pick(r)).toEqual([["refinance_amount", 2_100_000], ["refinance_rate_pct", 5.1], ["refinance_amort_years", 30]]);
      expect(pick(read("Permanent amortization: 25 years", "Permanent rate: 4.9%"))).toEqual([["refinance_amort_years", 25], ["refinance_rate_pct", 4.9]]);
      expect(pick(read("Hypothèque permanente : 2 000 000 $", "Prêt à terme, taux : 5,2 %"))).toEqual([["refinance_amount", 2_000_000], ["refinance_rate_pct", 5.2]]);
      // an interest-only period is the take-out loan's, never the senior loan's
      expect(pick(read("Permanent IO months: 6"))).toEqual([["refinance_io_months", 6]]);
      expect(pick(read("Construction loan: $1,700,000", "Interest rate: 6.3%"))).toEqual([["senior_loan_amount", 1_700_000], ["senior_rate_pct", 6.3]]);
      expect(pick(read("The office-to-residential conversion costs $750,000.")).filter((p) => String(p[0]).startsWith("refinance_"))).toEqual([]);
    });
    test("a second mortgage or MIC is the mezzanine loan, clause by clause", () => {
      const r = read("First mortgage $1,500,000 at 6.1%; the MIC second is $250,000 at 10.5%.");
      expect(pick(r)).toEqual([["senior_loan_amount", 1_500_000], ["senior_rate_pct", 6.1], ["mezz_loan_amount", 250_000], ["mezz_rate_pct", 10.5]]);
      expect(pick(read("Second: $200,000 at 11% interest only."))).toEqual([["mezz_loan_amount", 200_000]]);
      expect(pick(read("The private second will advance $180,000 at 12%."))).toEqual([["mezz_loan_amount", 180_000], ["mezz_rate_pct", 12]]);
      // a lender's type alone never sets the loan
      expect(pick(read("A mortgage investment corporation will lend $180,000.")).filter((p) => String(p[0]).startsWith("mezz_"))).toEqual([]);
      expect(pick(read("Prêteur privé de second rang : 150 000 $"))).toEqual([["mezz_loan_amount", 150_000]]);
      expect(pick(read("First mortgage: 6.2%"))).toEqual([["senior_rate_pct", 6.2]]);
      for (const line of ["The second floor adds 6 units.", "Second phase hard costs: $400,000", "Interest rate rose 0.5% in the second quarter."]) expect(pick(read(line)).filter((p) => String(p[0]).startsWith("mezz_")), line).toEqual([]);
    });
    test("a rate quoted before an adjustment is not the loan's rate", () => {
      const r = read("The interest rate is 6.1%, which reflects a 6.35% base less a 25 bps buy-down.");
      expect(pick(r).filter((p) => p[1] === 6.35)).toEqual([]);
      expect(noteOf(r, 6.35)).toBe(ADJUST);
      expect(pick(r)).toContainEqual(["senior_rate_pct", 6.1]);
      const b = read("Rate: 5.9% before the rate buy-down");
      expect(pick(b)).toEqual([]);
      expect(noteOf(b, 5.9)).toBe(ADJUST);
      expect(pick(read("Interest rate: 6.1% with a buy-down available"))).toEqual([["senior_rate_pct", 6.1]]);
      expect(pick(read("Rate: 6.1% fixed, less than prime"))).toEqual([["senior_rate_pct", 6.1]]);
    });
    test("a figure on a sheet named for a scenario is shown, not read", () => {
      const rows = [["Land", [410_000, "$"]], ["Hard costs", [1_900_000, "$"]]] as Cellish[][];
      for (const name of ["Downside", "Lender case", "Stress test", "Sensitivity", "What-if", "Worst case", "Cas défavorable", "Scénario 2"]) {
        const r = sheets(grid(name, ...rows));
        expect(pick(r), name).toEqual([]);
        expect(noteOf(r, 410_000), name).toBe(SCENARIO);
      }
      for (const name of ["Base", "Base case", "Inputs", "Budget", "Summary"]) expect(pick(sheets(grid(name, ...rows))), name).toEqual([["land_cost", 410_000], ["hard_cost", 1_900_000]]);
      const both = sheets(grid("Base", ["Land", [400_000, "$"]]), grid("Downside", ["Land", [450_000, "$"]]));
      expect(pick(both)).toEqual([["land_cost", 400_000]]);
    });
    test("a correction later in the line is the same field again, so the conflict is named", () => {
      for (const [line, field, a, b] of [
        ["Hard costs: $980,000 — corrected signed contract $1,030,000.", "hard_cost", 980_000, 1_030_000],
        ["Soft costs $210,000 (revised: $235,000)", "soft_cost", 210_000, 235_000],
        ["Coûts indirects : 210 000 $ (corrigé : 235 000 $)", "soft_cost", 210_000, 235_000],
      ] as const) {
        const r = read(line);
        expect(pick(r), line).toEqual([[field, a], [field, b]]);
      }
      expect(pick(read("Hard costs $980,000, soft costs $210,000"))).toEqual([["hard_cost", 980_000], ["soft_cost", 210_000]]);
      expect(pick(read("Hard costs: $980,000. The new total is $3,000,000 now.")).filter((p) => p[0] === "hard_cost")).toEqual([["hard_cost", 980_000]]);
      // "replaces" keeps its own rule
      expect(pick(read("Hard costs $980,000, which replaces the earlier $900,000."))).toEqual([["hard_cost", 980_000]]);
    });
    test("audit: a second with no loan word, a 'now' that only introduces a figure, and a base-scenario sheet", () => {
      for (const line of ["Phase one site works are $700,000; the second is $640,000.", "We got two bids, the first at $1,310,000 and the second: $1,280,000."]) expect(pick(read(line)).filter((p) => String(p[0]).startsWith("mezz_")), line).toEqual([]);
      // a bare "the second" in its own clause is unsure: shown, never read as the senior loan
      expect(pick(read("Construction loan $1,900,000; the second is $260,000 at 11%."))).toEqual([["senior_loan_amount", 1_900_000]]);
      expect(pick(read("Hard costs $1,750,000, now including the $60,000 demolition.")).filter((p) => p[0] === "hard_cost")).toEqual([["hard_cost", 1_750_000]]);
      expect(pick(read("Hard costs: $1,750,000, now $1,810,000.")).filter((p) => p[0] === "hard_cost")).toEqual([["hard_cost", 1_750_000], ["hard_cost", 1_810_000]]);
      const rows = [["Land", [410_000, "$"]]] as Cellish[][];
      for (const name of ["Base scenario", "Scénario retenu"]) expect(pick(sheets(grid(name, ...rows))), name).toEqual([["land_cost", 410_000]]);
      expect(pick(sheets(grid("Base vs downside", ...rows)))).toEqual([]);
    });
  });

  test("a year in a label line is no amount; a figure with no mark of a year is still read", () => {
    expect(pick(read("Operating costs: the 2028 budget, $48,000"))).toEqual([["fixed_opex_annual", 48_000]]);
    expect(pick(read("Frais d'exploitation : budget 2028, 48 000 $"))).toEqual([["fixed_opex_annual", 48_000]]);
    expect(noteOf(read("Operating costs: since 2026, $48,000"), 2026)).toMatch(/year/i);
    expect(pick(read("Operating costs: 48,250.00 for 2027"))).toEqual([["fixed_opex_annual", 48_250]]);
    // negative: nothing marks 1950 as a year, so it stays a figure
    expect(pick(read("Land cost: 1950"))).toEqual([["land_cost", 1950]]);
  });

  describe("a floating rate's spread is not the rate", () => {
    test("with an all-in figure that figure is the rate, and the note names the index and spread", () => {
      const r = read("Rate: prime + 1.25%, about 6.2% today");
      expect(pick(r)).toEqual([["senior_rate_pct", 6.2]]);
      expect(r.candidates[0]!.note).toMatch(/prime/i);
      expect(r.candidates[0]!.note).toMatch(/1\.25/);
      expect(noteOf(r, 1.25)).toMatch(/spread/i);
      expect(pick(read("Taux : taux préférentiel + 1,25 %, soit 6,2 % aujourd'hui"))).toEqual([["senior_rate_pct", 6.2]]);
      expect(pick(read("The interest rate is CORRA + 2.1%, which is 7.4% currently."))).toEqual([["senior_rate_pct", 7.4]]);
    });
    test("without one nothing is read, and the spread is kept with a plain note", () => {
      for (const line of ["Rate: prime + 1.25%", "Rate: P + 1.25", "Taux : préférentiel majoré de 1,25 %", "Rate: BA + 2.5%, floor 5%"]) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(r.other.some((o) => /spread is not the rate/i.test(o.note ?? "")), line).toBe(true);
      }
    });
    test("negative: a plain rate, and a sheet cell holding a spread", () => {
      expect(pick(read("Rate: 6.2%"))).toEqual([["senior_rate_pct", 6.2]]);
      const r = sheets(grid("S", ["Rate", "prime + 1.25%"]));
      expect(r.candidates).toEqual([]);
      expect(r.other.length).toBeGreaterThan(0);
    });
  });

  test("a parenthesised number is negative only when it is money", () => {
    expect(pick(read("Interest-only: during the build (16 months)"))).toEqual([["senior_io_months", 16]]);
    expect(pick(read("Occupancy: (95%)"))).toEqual([["stabilized_occupancy_pct", 95]]);
    // still negative: money; a contingency cannot be negative, so it is shown and not read (task 53)
    expect(noteOf(read("Contingency: ($50,000)"), -50_000)).toBe("The figure is outside what Contingency can hold");
    expect(noteOf(sheets(grid("S", ["Contingency", "(50,000.50)"])), -50_000.5)).toBe("The figure is outside what Contingency can hold");
  });

  test("a range with a tight or mixed-spacing dash, or a hedge, is refused", () => {
    for (const line of ["Rate: 3-4%", "Rate: 3–4%", "Rate: 3 - 4 %", "Rate: 3 -4%", "Rate: 3% to 4%", "Taux : 3 à 4 %", "The rate is somewhere in the 3-4% range."]) {
      const r = read(line);
      expect(r.candidates, line).toEqual([]);
      expect(r.other.length, line).toBeGreaterThan(0);
    }
    for (const line of ["The rate is around about 5%.", "Rate: 5%, give or take", "Rate: 5% or thereabouts", "Le taux est quelque part à 5 %.", "Le taux est d'environ 5 % ou plus."]) expect(read(line).candidates, line).toEqual([]);
    // negative: a plain approximation, a date and a phone number are no range, and a negative number is not made positive
    expect(pick(read("Rate: approximately 5%"))).toEqual([["senior_rate_pct", 5]]);
    expect(pick(read("Rate: around 5%"))).toEqual([["senior_rate_pct", 5]]);
    expect(pick(read("Rent growth: -3%"))).toEqual([["rent_growth_pct", -3]]);
    expect(read("Closing date: 2026-09-30").other.every((o) => !/range/i.test(o.note ?? ""))).toBe(true);
    expect(read("Contact: 604-555-1234").other.every((o) => !/range/i.test(o.note ?? ""))).toBe(true);
  });

  describe("a subtotal row in a sheet is checked against the lines above it", () => {
    const conflicts = (r: ReturnType<typeof extractCandidates>) => consolidate(r.candidates.map((c) => ({ ...c, documentId: "d", documentName: "d" }))).filter((p) => p.status === "conflicting");
    test("a French sheet whose sous-total is not the sum of its lines conflicts", () => {
      const r = sheets(grid("Budget", ["Excavation", [300_000, "$"]], ["Charpente", [900_000, "$"]], ["Finition", [500_000, "$"]], ["Sous-total coûts directs", [1_900_000, "$"]]));
      expect(r.candidates.map((c) => [c.fieldKey, c.value, c.rule])).toEqual(expect.arrayContaining([["hard_cost", 1_900_000, "table:label-value"], ["hard_cost", 1_700_000, "table:budget-sum"]]));
      expect(conflicts(r).map((p) => [p.fieldKey, p.values.map((v) => v.value)])).toEqual([["hard_cost", [1_700_000, 1_900_000]]]);
    });
    test("an English subtotal counts the lines since the previous total", () => {
      const r = sheets(grid("Budget", ["Framing", [900_000, "$"]], ["Subtotal hard costs", [900_000, "$"]], ["Permits", [40_000, "$"]], ["Design", [60_000, "$"]], ["Total soft costs", [150_000, "$"]]));
      expect(conflicts(r).map((p) => [p.fieldKey, p.values.map((v) => v.value)])).toEqual([["soft_cost", [100_000, 150_000]]]);
    });
    test("negative: a subtotal that equals its lines (within a dollar) is read once, and one with no lines above is just read", () => {
      const ok = sheets(grid("Budget", ["Excavation", [300_000, "$"]], ["Charpente", [900_000, "$"]], ["Sous-total coûts directs", [1_200_000.5, "$"]]));
      expect(conflicts(ok)).toEqual([]);
      expect(pick(sheets(grid("Budget", ["Sous-total coûts directs", [1_200_000, "$"]])))).toEqual([["hard_cost", 1_200_000]]);
    });
  });

  describe("a builder's contract price is the hard cost", () => {
    test("a revised or fixed price is read; the figure it replaces is only shown", () => {
      expect(pick(read("The builder has revised the stipulated price to $2,310,000."))).toEqual([["hard_cost", 2_310_000]]);
      expect(pick(read("Construction contract: $2,200,000"))).toEqual([["hard_cost", 2_200_000]]);
      const r = read("Our revised fixed price is $2,310,000, which replaces the earlier $2,150,000.");
      expect(pick(r)).toEqual([["hard_cost", 2_310_000]]);
      expect(noteOf(r, 2_150_000)).toMatch(/replace/i);
      const fr = read("Le prix forfaitaire révisé est de 2 310 000 $; il remplace le montant précédent de 2 150 000 $.");
      expect(pick(fr)).toEqual([["hard_cost", 2_310_000]]);
      expect(noteOf(fr, 2_150_000)).toMatch(/replace|remplac/i);
      expect(pick(read("Contrat à forfait : 2 200 000 $"))).toEqual([["hard_cost", 2_200_000]]);
    });
    test("negative: an alias in an earlier sentence names nothing, and a price that is not the contract's is not hard cost", () => {
      expect(read("The contract price was discussed. The total is $2,000,000.").candidates).toEqual([]);
      expect(read("The price per door is $2,000.").candidates).toEqual([]);
    });
  });

  describe("occupancy is the stabilized assumption only", () => {
    test("a rent roll's summary row is not an assumption, whether or not a label row precedes it", () => {
      const roll = grid("Roll", ["Type", "Units", "Rent"], ["Studio", 4, [1_450, "$"]], ["1BR", 6, [1_750, "$"]], ["Current occupancy", [94, "%"]], ["Summary"], ["Occupancy", [93, "%"]], ["Total units", 10], ["Stabilized occupancy", [95, "%"]]);
      const r = sheets(roll);
      expect(items(r)).toEqual([["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1_450], ["unit_count", "1BR", 6], ["unit_rent_monthly", "1BR", 1_750], ["stabilized_occupancy_pct", null, 95]]);
      expect(noteOf(r, 93)).toMatch(/summary row is not an assumption/i);
      expect(noteOf(r, 94)).toMatch(/summary row is not an assumption/i);
    });
    test("negative: with no rent roll, a row labelled occupancy is the assumption", () => {
      expect(pick(sheets(grid("Inputs", ["Occupancy", [95, "%"]])))).toEqual([["stabilized_occupancy_pct", 95]]);
    });
    test("in a mixed-use document a commercial space's occupancy is not the deal's (task 51)", () => {
      const mixed = read("Apartment mix: 1BR at $1,800 a month.", "Underwrite the office floor at 88% occupancy.", "Stabilized occupancy for the apartments is 95%.");
      expect(pick(mixed)).toContainEqual(["stabilized_occupancy_pct", 95]);
      expect(pick(mixed)).not.toContainEqual(["stabilized_occupancy_pct", 88]);
      expect(noteOf(mixed, 88)).toBe("An occupancy for the commercial space, not the deal's stabilized occupancy");
      const fr = read("Types de logements : 2 chambres à 1 900 $ par mois.", "Les bureaux sont loués à un taux d'occupation de 85 %.");
      expect(noteOf(fr, 85)).toBe("An occupancy for the commercial space, not the deal's stabilized occupancy");
      // negative: with no residential unit type, an office building's occupancy is the deal's
      expect(pick(read("Underwrite the office floor at 88% occupancy."))).toEqual([["stabilized_occupancy_pct", 88]]);
    });
    test("a lender's condition, or today's occupancy, is shown and not used", () => {
      for (const line of [
        "The lender requires minimum occupancy of 92% before we fund.",
        "Funding is subject to occupancy of at least 92% prior to closing.",
        "Occupancy covenant: 92%",
        "Occupation minimale de 92 % avant le déboursement.",
        "Current occupancy is 94%.",
        "Occupancy today: 94%",
        "Occupancy as of June is 94%.",
        "Taux d'occupation actuel : 94 %",
        "Taux d'occupation en date du 1er juin : 94 %",
      ]) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(r.other.length, line).toBeGreaterThan(0);
      }
      // negative: the stabilized assumption beside a current figure is still read
      expect(pick(read("Stabilized occupancy: 95% (current: 88%)"))).toEqual([["stabilized_occupancy_pct", 95]]);
      expect(pick(read("Occupancy: 95%"))).toEqual([["stabilized_occupancy_pct", 95]]);
    });
  });

  describe("revenue items", () => {
    const suites = (...rows: (string | number)[][]) => grid("Roll", ["Suite", "Type", "Area (sf)", "Rent per month"], ...rows);
    const summary = grid("Summary", ["Type", "Units", "Rent per month"], ["2-bed", 2, [1_800, "$"]], ["1-bed", 1, [1_500, "$"]]);
    test("a per-suite roll beside a type summary gives way to the summary", () => {
      const r = sheets(suites(["204", "2-bed", 720, 1_800], ["205", "2-bed", 720, 1_800], ["301", "1-bed", 500, 1_500]), summary);
      expect(items(r)).toEqual([["unit_count", "2BR", 2], ["unit_rent_monthly", "2BR", 1_800], ["unit_count", "1BR", 1], ["unit_rent_monthly", "1BR", 1_500]]);
      expect(r.other.length).toBeGreaterThanOrEqual(6);
      expect(r.other.every((o) => /summary/i.test(o.note ?? "") || o.note)).toBe(true);
    });
    test("a per-suite roll alone is grouped by type: rows counted, areas summed, rent read only when equal", () => {
      const r = sheets(suites(["204", "2-bed", 700, 1_800], ["205", "2-bed", 700, 1_800], ["101", "1-bed", 500, 1_500], ["102", "1-bed", 520, 1_550]));
      expect(items(r)).toEqual(expect.arrayContaining([["unit_count", "2BR", 2], ["rentable_area_sf", "2BR", 1_400], ["unit_rent_monthly", "2BR", 1_800], ["unit_count", "1BR", 2], ["rentable_area_sf", "1BR", 1_020]]));
      expect(r.candidates.some((c) => c.fieldKey === "unit_rent_monthly" && c.itemKey === "1BR")).toBe(false);
      expect(noteOf(r, 1_500)).toMatch(/different amounts/i);
      expect(r.candidates.every((c) => !/\d{3}/.test(c.itemKey ?? "") || /^\d½$/.test(c.itemKey!))).toBe(true);
    });
    test("codes such as TH-1 to TH-3 are suites of one type", () => {
      const r = sheets(grid("Roll", ["Unit", "Area (sf)", "Rent per month"], ["TH-1", 720, 1_900], ["TH-2", 720, 1_900], ["TH-3", 760, 1_900]));
      expect(items(r)).toEqual([["unit_count", "TH", 3], ["rentable_area_sf", "TH", 2_200], ["unit_rent_monthly", "TH", 1_900]]);
    });
    test("negative: rows that are each a different type are not a per-suite roll", () => {
      const r = sheets(grid("Roll", ["Space", "Area (sf)", "Rent per month"], ["Cafe", 900, 3_000], ["Gym", 1_200, 4_000]));
      expect(r.candidates.map((c) => c.itemKey)).toEqual(expect.arrayContaining(["Cafe", "Gym"]));
    });
    test("a type is one item whichever way it is written, in a sheet or in prose", () => {
      const table = sheets(grid("Types", ["Type", "Units", "Rent per month"], ["One-bed", 2, 1_700], ["1 chambre", 3, 1_650], ["Bachelor", 1, 1_200], ["End units (3 bed)", 2, 2_400], ["three-bedroom", 1, 2_300], ["Studio", 1, 1_300]));
      expect(table.candidates.filter((c) => c.fieldKey === "unit_count").map((c) => [c.itemKey, c.value])).toEqual([["1BR", 2], ["1BR", 3], ["Bachelor", 1], ["3BR", 2], ["3BR", 1], ["Studio", 1]]);
      expect(items(read("The one-bedroom suites rent for $1,800 a month."))).toEqual([["unit_rent_monthly", "1BR", 1_800]]);
      expect(items(sheets(grid("Types", ["Type", "Units", "Rent per month"], ["One-bed", 2, 1_700])))[0]).toEqual(["unit_count", "1BR", 2]);
    });
    test("a number before a street word is an address, not a value", () => {
      expect(pick(read("Units: 1450 Oak Road"))).toEqual([]);
      expect(pick(read("Units: 1450 Oak Rd."))).toEqual([]);
      expect(pick(read("Logements : 12, 1450 rue des Érables"))).toEqual([["unit_count", 12]]);
      expect(pick(read("Units: civic 1450"))).toEqual([]);
      expect(read("Units: 1450 Oak Road").other.some((o) => /address/i.test(o.note ?? ""))).toBe(true);
      // negative: a count that merely precedes a street name, and a real count
      expect(pick(read("Units: 24 on Oak Road"))).toEqual([["unit_count", 24]]);
      expect(pick(read("Units: 1450"))).toEqual([["unit_count", 1450]]);
    });
    test("a deal-wide value beside named items for the same field is only shown", () => {
      const r = read("Studio units: 4", "Units: 10");
      expect(items(r)).toEqual([["unit_count", "Studio", 4]]);
      expect(r.other.some((o) => o.value === 10 && o.note)).toBe(true);
      // negative: alone it is read; and a rent for another field is not affected
      expect(items(read("Units: 10"))).toEqual([["unit_count", "All units", 10]]);
      expect(items(read("Studio units: 4", "Monthly rent: $1,500"))).toEqual([["unit_count", "Studio", 4], ["unit_rent_monthly", "All units", 1_500]]);
    });
    test("a place or heading before a colon is never an item name; the deal-wide count is read", () => {
      expect(items(read("Nanaimo, British Columbia: nine apartments above a pharmacy"))).toEqual([["unit_count", "All units", 9]]);
      expect(items(read("Gatineau (Québec) : huit logements au-dessus d'une boutique"))).toEqual([["unit_count", "All units", 8]]);
      // an area alone under a name that is no unit type is no item (task 47); with its rent it is
      expect(items(read("Retail: 9,000 SF"))).toEqual([]);
      expect(items(read("Retail: 9,000 SF at $24 per SF"))).toEqual([["rentable_area_sf", "Retail", 9_000], ["rent_psf_annual", "Retail", 24]]);
    });
    test("a count and a rent in one colon clause pair to the unit type that clause names", () => {
      expect(items(read("Units: 8 one-bedroom suites at $1,750 per month"))).toEqual([["unit_count", "1BR", 8], ["unit_rent_monthly", "1BR", 1_750]]);
      expect(items(read("Logements : 6 4½ à 1 650 $ par mois"))).toEqual([["unit_count", "4½", 6], ["unit_rent_monthly", "4½", 1_650]]);
      expect(items(read("Rimouski (Québec) : six logements, dont 4 studios à 900 $ par mois"))).toEqual([["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 900]]);
    });
    test("negative: a unit-type label still names the item; a count with no type word stays deal-wide; stalls are no revenue item", () => {
      expect(items(read("Studios: 4 at $1,450 per month"))).toEqual([["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1_450]]);
      expect(items(read("Units: 8"))).toEqual([["unit_count", "All units", 8]]);
      expect(items(read("Parking: 12 stalls at $60 a month"))).toEqual([]);
      // a named item in the same document moves the deal-wide count aside
      expect(items(read("Albany, Prince Edward Island: ten apartments, two studios at $1,000 a month"))).toEqual([["unit_count", "Studio", 2], ["unit_rent_monthly", "Studio", 1_000]]);
    });
  });
});

describe("signs, explanatory parentheses and per-unit prices", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: tables.length ? "xlsx" : "pdf",
    lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const noteOf = (r: ReturnType<typeof extractCandidates>, value: number) => r.other.find((o) => o.value === value)?.note ?? "";
  const textGrid = (...rows: string[][]): Table => ({ name: "Budget", rows: rows.map((r, i) => r.map((text, c): Cell => ({ text, ref: `Budget!${"AB"[c]}${i + 1}` }))) });

  test("list markers in a bulleted email are not minus signs", () => {
    const r = read("Notes from the call:", "- 1.5 years to build", "– 96% occupied at stabilization", "• - $4,100,000 for hard costs", "-- 2% selling costs");
    expect(pick(r)).toEqual([["construction_months", 18], ["stabilized_occupancy_pct", 96], ["hard_cost", 4_100_000], ["selling_costs_pct", 2]]);
    expect(pick(read("- Taux d'occupation stabilisé : – 96 %", "– 1,5 an pour la construction"))).toEqual([["stabilized_occupancy_pct", 96], ["construction_months", 18]]);
  });
  test("negative: a figure attached to its sign stays negative", () => {
    expect(pick(read("Rent growth: -2%"))).toEqual([["rent_growth_pct", -2]]);
    expect(noteOf(read("Contingency: ($50,000)"), -50_000)).toBe("The figure is outside what Contingency can hold");
    expect(pick(read("Selling costs: 2.5%"))).toEqual([["selling_costs_pct", 2.5]]);
  });

  // Task 35: only a figure whose own label says it is a credit may reduce the other costs.
  const CREDIT_NOTE = "A credit: reduces total cost";
  // A lone "25,000" does not say which separator is the decimal one; a second line with a decimal point does.
  const costs = (r: ReturnType<typeof read>) => pick(r).filter(([k]) => k === "other_cost");
  const lines = (line: string) => (/\d,\d{3}/.test(line) ? read(line, "Selling costs: 2.5%") : read(line));
  test("a figure whose label says it is a credit is read as a negative other cost, in English and French", () => {
    const en = lines("Vendor credit on closing (25,000)");
    expect(costs(en)).toEqual([["other_cost", -25_000]]);
    expect(en.candidates[0]!.note).toBe(CREDIT_NOTE);
    const fr = read("Remise du fournisseur -12 000 $");
    expect(pick(fr)).toEqual([["other_cost", -12_000]]);
    expect(fr.candidates[0]!.note).toBe(CREDIT_NOTE);
    for (const [line, value] of [
      ["Rebate: ($8,000)", -8_000],
      ["Refunded deposit: -$4,500", -4_500],
      ["Remboursement du dépôt : (4 500 $)", -4_500],
      ["Ristourne : -3 000 $", -3_000],
      ["Subvention déduite : (10 000 $)", -10_000],
      ["Credit on the land purchase: -$30,000", -30_000],
    ] as const) expect(costs(lines(line)), line).toEqual([["other_cost", value]]);
    // Card 61d: a rebate of a sales tax is a sales tax line, not a credit to other costs (gst_hst_net is already net of rebates).
    const gst = lines("Less: GST rebate (6,200)");
    expect(costs(gst)).toEqual([]);
    expect(gst.other.map((o) => o.note)).toContain("A sales tax line; enter GST/HST net of rebates, or label it");
  });
  test("in a budget table a credit row is a part like any other and subtracts", () => {
    const grid = (...rows: string[][]) => extractCandidates(doc([], [textGrid(["Line item", "Amount"], ...rows)]));
    const mixed = grid(["Land acquisition", "1,000,000.00"], ["Other costs", "40,000.00"], ["Rebate", "($15,000.00)"]);
    expect(mixed.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000], ["other_cost", 25_000]]);
    const only = grid(["Land acquisition", "1,000,000.00"], ["Vendor credit", "($25,000.00)"]);
    expect(only.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000], ["other_cost", -25_000]]);
    expect(only.candidates[1]!.note).toBe(CREDIT_NOTE);
  });
  test("a negative figure that does not say it is a credit is refused, never read as one", () => {
    // "Less" alone does not make a credit: a deposit already paid is not a cost reduction.
    expect(costs(lines("Less: deposit paid -$100,000"))).toEqual([]);
    for (const line of ["Other costs: (12,500)", "Other costs (12,500)", "Other costs: -$12,500", "Autres coûts : -12 500 $"]) {
      const r = lines(line);
      expect(costs(r), line).toEqual([]);
      // In prose a bare number is never money, so that line is not read at all.
      if (!line.includes(":") && !line.includes("-")) continue;
      expect(r.other.some((o) => o.value === -12_500 && /does not say it is a credit/.test(o.note ?? "")), line).toBe(true);
    }
    const table = extractCandidates(doc([], [textGrid(["Line item", "Amount"], ["Land acquisition", "1,000,000.00"], ["Other costs", "($25,000.00)"])]));
    expect(table.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000]]);
    expect(table.other.some((o) => o.value === -25_000 && /does not say it is a credit/.test(o.note ?? ""))).toBe(true);
  });
  test("a credit word that is not a credit, and a credit with no minus sign, reduce nothing", () => {
    for (const line of ["Line of credit: ($500,000)", "Credit facility (1,000,000)", "Marge de crédit : (500 000 $)", "Letter of credit -$250,000", "Vacancy and credit loss: (12,500)"]) {
      expect(costs(lines(line)), line).toEqual([]);
    }
    // never a sign flipped: a positive rebate is not turned into a credit
    for (const line of ["Rebate: $8,000", "Remise du fournisseur : 12 000 $"]) {
      expect(pick(lines(line)).filter(([, v]) => (v as number) < 0), line).toEqual([]);
    }
  });

  test("a sign written in words reads nothing", () => {
    expect(pick(read("Rent growth: minus 2%"))).toEqual([]);
    expect(pick(read("Croissance des loyers : moins 2 %"))).toEqual([]);
    expect(read("Rent growth: minus 2%").other.some((o) => /sign written in words/.test(o.note ?? ""))).toBe(true);
    // "au moins" is a lender's minimum (task 22), shown and not read
    expect(pick(read("Taux d'occupation stabilisé : au moins 90 %"))).toEqual([]);
  });
  test("a percentage of a field names a share: the dollar aside is not that field, and the line's label reads it", () => {
    const r = read("Developer fee: 4% of hard costs ($96,000)");
    expect(pick(r)).toEqual([["other_cost", 96_000]]);
    const fr = read("Honoraires du promoteur : 3 % des coûts directs (96 000 $)");
    expect(pick(fr)).toEqual([["other_cost", 96_000]]);
    expect(pick(read("Contingency: 5% of hard costs ($107,400)"))).toEqual([["contingency", 107_400]]);
    expect(pick(read("Construction loan: 75% of total cost ($6,300,000)"))).toEqual([["senior_loan_amount", 6_300_000]]);
    // a label that names no field leaves the aside in other, with the share note
    const none = read("Cushion: 5% of hard costs ($107,400)");
    expect(none.candidates).toEqual([]);
    expect(noteOf(none, 107_400)).toBe("A share of another figure, not that figure");
    const prose = read("The fee is 4% of hard costs, which is $96,000.");
    expect(prose.candidates.some((c) => c.fieldKey === "hard_cost")).toBe(false);
    expect(noteOf(prose, 96_000)).toBe("A share of another figure, not that figure");
  });
  test("negative: a percentage elsewhere, or after the figure, leaves the figure alone", () => {
    expect(pick(read("Hard costs: $4,100,000, including a 5% contingency"))).toEqual([["hard_cost", 4_100_000]]);
    expect(pick(read("Land cost: $520,000 (12% of the budget)"))).toEqual([["land_cost", 520_000]]);
    expect(pick(read("Contingency: 5% of hard costs")).some(([k]) => k === "hard_cost")).toBe(false);
    expect(pick(read("A 4% fee on the work; hard costs are $4,100,000."))).toEqual([["hard_cost", 4_100_000]]);
  });

  test("a price each is not the total; the total in parentheses is read", () => {
    const r = read("The land is three lots at $160,000 each ($480,000).");
    expect(pick(r)).toEqual([["land_cost", 480_000]]);
    expect(noteOf(r, 160_000)).toBe("A per-door share of a cost, not the line's total; enter the total");
    expect(pick(read("Land: $160,000 per lot, $480,000 total"))).toEqual([["land_cost", 480_000]]);
    expect(pick(read("Land cost: $160,000 per lot, for a total of $480,000"))).toEqual([["land_cost", 480_000]]);
  });
  test("a price each with no total reads nothing for land", () => {
    const r = read("The land is three lots at $160,000 each.");
    expect(pick(r)).toEqual([]);
    expect(noteOf(r, 160_000)).toBe("A per-door share of a cost, not the line's total; enter the total");
    expect(pick(read("Land cost: $160,000 per lot; the deposit is $20,000"))).toEqual([]);
    expect(noteOf(read("Hard costs: $95,000 per door"), 95_000)).toBe("A per-door share of a cost, not the line's total; enter the total");
  });
  test("chacun, chacune and par lot, par porte, par unité in French", () => {
    const r = read("Le terrain compte trois lots à 160 000 $ chacun (480 000 $).");
    expect(pick(r)).toEqual([["land_cost", 480_000]]);
    expect(noteOf(r, 160_000)).toBe("A per-door share of a cost, not the line's total; enter the total");
    expect(pick(read("Coût du terrain : 160 000 $ par lot"))).toEqual([]);
    expect(pick(read("Coûts de construction : 95 000 $ par porte, soit 760 000 $"))).toEqual([["hard_cost", 760_000]]);
    expect(pick(read("Coûts de construction : 95 000 $ par unité"))).toEqual([]);
    expect(pick(read("Les lots valent 160 000 $ chacune"))).toEqual([]);
  });
  test("negative: a rent per unit is still a rent, and a plain amount is still read", () => {
    expect(pick(read("Monthly rent of $1,800 per unit"))).toEqual([["unit_rent_monthly", 1_800]]);
    expect(pick(read("Land cost: $480,000"))).toEqual([["land_cost", 480_000]]);
    expect(pick(read("Land cost: $480,000 for the three lots"))).toEqual([["land_cost", 480_000]]);
  });
});

describe("a lender's limits, terms, fees and conditions are not inputs", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: tables.length ? "docx" : "pdf",
    lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const noteOf = (r: ReturnType<typeof extractCandidates>, value: number) => r.other.find((o) => o.value === value)?.note ?? "";
  const letter = (...rows: string[][]): Table => ({ name: "Terms", rows: rows.map((r, i) => r.map((text, c): Cell => ({ text, ref: `Table 1 R${i + 1}C${c + 1}` }))) });
  const LIMIT = "A lender's limit, not the deal's figure";
  const TERM = "A loan's term, not the build period, hold or amortization";
  const FEE = "A fee or premium, not an input";
  const CONDITION = "A lender's condition, not the occupancy assumption";

  describe("ceilings and minimums", () => {
    test("a number qualified by a limit word is a limit, in a label or in prose, in both languages", () => {
      for (const [line, value] of [
        ["Maximum loan-to-cost: 70%", 70],
        ["Max combined LTC 85%", 85],
        ["Advances will not exceed 75% of total cost.", 75],
        ["Prêt de second rang d'au plus 300 000 $", 300_000],
        ["Ratio prêt-coût maximal de 70 %", 70],
        ["Minimum cash equity of $2,400,000", 2_400_000],
        ["Une mise de fonds d'au moins 900 000 $", 900_000],
        ["Take-out of not less than $6,000,000", 6_000_000],
        // a limit word one place before the alias that names the figure (the alias counts as one word)
        ["d) Maximum loan to cost of 65%; permits in hand before closing.", 65],
        ["e) Maximum loan to value of 72%; the appraisal is ordered by the bank.", 72],
      ] as const) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(noteOf(r, value), line).toBe(LIMIT);
      }
      expect(noteOf(read("The loan will not exceed 75% of total cost."), 75)).toBe(LIMIT);
    });
    test("a limit in a table row is a limit too", () => {
      const r = extractCandidates(doc([], [letter(["Maximum loan-to-cost", "70%"], ["Mise de fonds minimale", "900 000 $"])]));
      expect(r.candidates).toEqual([]);
      expect(noteOf(r, 70)).toBe(LIMIT);
      expect(noteOf(r, 900_000)).toBe(LIMIT);
    });
    test("negative: the minimum DSCR covenant is still read, and so are plain figures", () => {
      expect(pick(read("Minimum DSCR 1.20x"))).toEqual([["min_dscr_covenant", 1.2]]);
      expect(pick(read("The loan requires a minimum debt service coverage ratio of 1.25x."))).toEqual([["min_dscr_covenant", 1.25]]);
      expect(pick(read("RCD minimal : 1,20x"))).toEqual([["min_dscr_covenant", 1.2]]);
      expect(pick(read("Construction period: 16 months"))).toEqual([["construction_months", 16]]);
      expect(pick(read("Hold: 7 years"))).toEqual([["hold_years", 7]]);
      expect(pick(read("Stated LTC 68%"))).toEqual([["stated_ltc_pct", 68]]);
      expect(pick(read("Our stated loan to cost of 68% is the sponsor's own figure."))).toEqual([["stated_ltc_pct", 68]]);
    });
  });

  describe("a loan's term is not a period", () => {
    test("a duration labelled as the term is shown, in a label, a table or prose", () => {
      for (const [line, value] of [
        ["Term: 30 months", 30],
        ["Terme du prêt 24 mois (construction)", 24],
        ["Construction term: 28 months", 28],
        ["Construction term of 36 months from closing", 36],
        ["ÉCHÉANCE : 18 mois", 18],
        ["Renewal term 3 years", 3],
        ["The loan matures 30 months after closing.", 30],
        ["A 5-year term on conversion to a permanent loan.", 5],
        ["Un terme de 10 ans est prévu.", 10],
      ] as const) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(noteOf(r, value), line).toBe(TERM);
      }
    });
    test("a commitment letter laid out as a table keeps the amortization and sets the term aside", () => {
      const r = extractCandidates(doc([], [letter(["Term", "36 months"], ["Amortization", "30 years"], ["Interest rate", "6.45%"])]));
      expect(pick(r)).toEqual([["senior_amort_years", 30], ["senior_rate_pct", 6.45]]);
      expect(noteOf(r, 36)).toBe(TERM);
    });
    test("a label that also says amortization keeps that field", () => {
      const r = read("A 25-year amortization, 5-year term.");
      expect(pick(r)).toEqual([["senior_amort_years", 25]]);
      expect(noteOf(r, 5)).toBe(TERM);
    });
    test("negative: the build period and the hold are still read", () => {
      expect(pick(read("Construction period 16 months"))).toEqual([["construction_months", 16]]);
      expect(pick(read("Construction period: 14 months"))).toEqual([["construction_months", 14]]);
      expect(pick(read("Construction duration: 15 months"))).toEqual([["construction_months", 15]]);
      expect(pick(read("Hold 7 years"))).toEqual([["hold_years", 7]]);
      expect(pick(read("Durée de construction : 14 mois"))).toEqual([["construction_months", 14]]);
    });
  });

  describe("fees and premiums are not rates or costs", () => {
    test("a fee or premium is shown and never read as a rate, an amount or a cost", () => {
      for (const [line, value] of [
        ["Commitment fee: 0.75% of the loan", 0.75],
        ["Frais d'engagement 1,00 %", 1],
        ["FRAIS D'OUVERTURE : 6 500 $", 6_500],
        ["The insurance premium of 3.10% is added to the loan.", 3.1],
        ["Prime d'assurance : 3,10 %", 3.1],
      ] as const) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(noteOf(r, value), line).toBe(FEE);
      }
      const both = read("Lender fee 0.5% ($18,000)");
      expect(both.candidates).toEqual([]);
      expect(noteOf(both, 18_000)).toBe(FEE);
    });
    test("negative: the interest rate beside a fee is still read", () => {
      const r = extractCandidates(doc([], [letter(["Commitment fee", "0.75%"], ["Interest rate", "6.45%"])]));
      expect(pick(r)).toEqual([["senior_rate_pct", 6.45]]);
      expect(noteOf(r, 0.75)).toBe(FEE);
      expect(pick(read("Management fee: 3% of revenue"))).toEqual([["variable_expense_pct", 3]]);
    });
  });

  describe("a lender's condition is not the occupancy assumption", () => {
    test("a leasing or occupancy share with a condition marker is shown, never used", () => {
      for (const [line, value] of [
        ["Minimum 85% of units leased before conversion", 85],
        ["At least 90% occupied for 3 consecutive months", 90],
        ["40% of the retail pre-leased before first advance", 40],
        ["Taux d'occupation minimal de 90 %", 90],
        ["Occupancy of 88% is needed prior to the conversion to the permanent loan.", 88],
      ] as const) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(r.other.some((o) => o.value === value), line).toBe(true);
      }
    });
    test("a table row is a condition when its label says so", () => {
      const r = extractCandidates(doc([], [letter(["Occupancy required before conversion", "85%"], ["Stabilized occupancy", "96%"])]));
      expect(pick(r)).toEqual([["stabilized_occupancy_pct", 96]]);
      expect(noteOf(r, 85)).toMatch(/lender's/);
    });
    test("the lender's underwriting basis is not the deal's assumption, whatever field it names (task 51)", () => {
      const BASIS = "The lender's underwriting basis, not the deal's assumption";
      const r = read("The bank sizes the loan on 94% occupancy and a 5.5% cap rate for lending value.");
      expect(r.candidates).toEqual([]);
      expect(noteOf(r, 94)).toBe(BASIS);
      expect(noteOf(r, 5.5)).toBe(BASIS);
      for (const [line, value] of [
        ["A 93% occupancy is used for credit underwriting.", 93],
        ["The loan is sized on 65% of cost.", 65],
        ["La banque retient un taux d'occupation de 92 %.", 92],
        ["Valeur de prêt établie à un taux de 5,75 %.", 5.75],
      ] as const) {
        const x = read(line);
        expect(x.candidates, line).toEqual([]);
        expect(noteOf(x, value), line).toBe(BASIS);
      }
      // negative: the sponsor's own underwriting is read
      expect(pick(read("We underwrite stabilized occupancy at 95%."))).toEqual([["stabilized_occupancy_pct", 95]]);
      expect(pick(read("Underwrite stabilized occupancy at 95%."))).toEqual([["stabilized_occupancy_pct", 95]]);
      // negative: an amount the cue follows is the loan's, not a basis
      expect(pick(read("The construction loan of $4,200,000 is sized on a 1.25x coverage."))).toEqual([["senior_loan_amount", 4200000]]);
    });
    test("negative: the stabilized occupancy beside a funding condition is still read", () => {
      expect(pick(read("Stabilized occupancy 96%", "Funding is conditional on 90% occupancy."))).toEqual([["stabilized_occupancy_pct", 96]]);
      expect(noteOf(read("Funding is conditional on 90% occupancy."), 90)).toBe(CONDITION);
    });
  });

  describe("an amount per investor is not equity", () => {
    test("money per limited partner, or a minimum investment, is shown and not read", () => {
      for (const [line, value] of [
        ["Minimum investment $25,000 per limited partner", 25_000],
        ["Each investor commits $50,000 per investor.", 50_000],
        ["Souscription de 25 000 $ par commanditaire", 25_000],
        ["Investissement minimal : 10 000 $ par investisseur", 10_000],
      ] as const) {
        const r = read(line);
        expect(r.candidates, line).toEqual([]);
        expect(r.other.some((o) => o.value === value), line).toBe(true);
      }
    });
    test("negative: the sponsor's equity is still read", () => {
      expect(pick(read("Sponsor equity: $2,400,000"))).toEqual([["equity_amount", 2_400_000]]);
      expect(pick(read("Mise de fonds : 900 000 $"))).toEqual([["equity_amount", 900_000]]);
    });
  });
  describe("the rules stay narrow", () => {
    test("a clause that names interest-only keeps its duration for that field", () => {
      expect(pick(read("Interest-only for the full 31-month term."))).toEqual([["senior_io_months", 31]]);
      expect(pick(read("Intérêts seulement pendant toute la durée du terme de 24 mois."))).toEqual([["senior_io_months", 24]]);
      // negative: a bare term is still a loan term
      const r = read("Term: 30 months");
      expect(r.candidates).toEqual([]);
      expect(noteOf(r, 30)).toBe(TERM);
    });
    test("a condition marker elsewhere in the sentence does not set aside a figure that is not about occupancy", () => {
      const r = read("Conditions: 50% of the retail pre-leased before first advance; min DSCR 1.25x at conversion; max loan-to-cost 65% - you're at 65.0% so no room");
      expect(noteOf(r, 50)).toBe(CONDITION);
      expect(r.other.filter((o) => o.value === 65).map((o) => o.note)).toEqual([LIMIT, "No field matches this label"]);
      // negative: a deal's own loan-to-cost beside a condition is still read
      expect(pick(read("Stated LTC 65%; 50% of the retail pre-leased before first advance."))).toEqual([["stated_ltc_pct", 65]]);
      expect(pick(read("Stabilized occupancy is 96%, and funding requires 90% occupancy."))).toEqual([["stabilized_occupancy_pct", 96]]);
    });
    test("a fee listed as a part does not make a cost line a fee", () => {
      expect(pick(read("Soft costs including permits, design, legal and your fees come to $295,000."))).toEqual([["soft_cost", 295_000]]);
      expect(pick(read("Les coûts indirects comprenant les permis, la conception et vos honoraires totalisent 295 000 $."))).toEqual([["soft_cost", 295_000]]);
      // negative: a bare fee line is still a fee
      expect(noteOf(read("Your fees come to $18,000."), 18_000)).toBe(FEE);
    });
  });
});

describe("totals and their parts", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const noteOf = (r: ReturnType<typeof extractCandidates>, value: number) => r.other.find((o) => o.value === value)?.note ?? "";
  const grid = (...rows: (string | number)[][]): Table => ({
    name: "Budget",
    rows: rows.map((r, i) => r.map((x, c) => (typeof x === "number" ? { text: String(x), number: x, ref: `${"ABC"[c]}${i + 1}` } : { text: x, ref: `${"ABC"[c]}${i + 1}` }))),
  });
  const budget = (header: [string, string], ...rows: (string | number)[][]) => extractCandidates(doc([], [grid(header, ...rows)]));
  const SEVERAL = "A total of several costs, not one of them";
  const NOT_SHOWN = "Not shown to add up to the subtotal below it";

  test("a figure followed by what it covers is a total of them, never one of them", () => {
    expect(pick(read("Budget: $4,210,000 (land, construction, soft costs and contingency)"))).toEqual([["stated_total_cost", 4_210_000]]);
    expect(pick(read("The project cost is $6,500,000, including land, hard costs and soft costs."))).toEqual([["stated_total_cost", 6_500_000]]);
    expect(pick(read("Coût du projet : 4 210 000 $ (comprenant terrain, construction, frais indirects et imprévus)"))).toEqual([["stated_total_cost", 4_210_000]]);
    expect(pick(read("Coût total : 3 800 000 $, incluant le terrain, les coûts de construction et les honoraires professionnels."))).toEqual([["stated_total_cost", 3_800_000]]);
  });
  test("a Total that closes a uses table is the stated total cost; other totals stay unread (task 51)", () => {
    const uses = budget(["Use", "Amount"], ["Land", "$600,000"], ["Hard costs", "$2,900,000"], ["Soft costs", "$410,000"], ["Total", "$3,910,000"]);
    expect(pick(uses)).toEqual([["land_cost", 600_000], ["hard_cost", 2_900_000], ["soft_cost", 410_000], ["stated_total_cost", 3_910_000]]);
    expect(pick(budget(["Emplois", "Montant"], ["Terrain", "600 000 $"], ["Coûts de construction", "2 900 000 $"], ["Coûts indirects", "410 000 $"], ["Total des emplois", "3 910 000 $"])).slice(-1)).toEqual([["stated_total_cost", 3_910_000]]);
    // a sheet block with no blank row
    const block = extractCandidates(doc([], [grid(["Land", "$600,000"], ["Hard costs", "$2,900,000"], ["Total des coûts", "$3,500,000"])]));
    expect(pick(block)).toContainEqual(["stated_total_cost", 3_500_000]);
    // never summed: the printed figure is read even when it is not the sum
    expect(pick(budget(["Use", "Amount"], ["Land", "$600,000"], ["Hard costs", "$2,900,000"], ["Total uses", "$3,999,000"]))).toContainEqual(["stated_total_cost", 3_999_000]);
    // negative: rents, sources of funds and one budget field are not a uses table
    const rents = budget(["Type", "Monthly rent"], ["Studio", "$1,400"], ["1BR", "$1,800"], ["Total", "$3,200"]);
    expect(pick(rents).some(([k]) => k === "stated_total_cost")).toBe(false);
    const sources = budget(["Source", "Amount"], ["Senior loan", "$2,000,000"], ["Equity", "$1,000,000"], ["Total", "$3,000,000"]);
    expect(pick(sources).some(([k]) => k === "stated_total_cost")).toBe(false);
    expect(noteOf(sources, 3_000_000)).not.toBe("");
    const one = budget(["Use", "Amount"], ["Hard costs", "$2,900,000"], ["Total", "$2,900,000"]);
    expect(pick(one).some(([k]) => k === "stated_total_cost")).toBe(false);
    // negative: a table that already states its total cost has one
    const stated = budget(["Use", "Amount"], ["Land", "$600,000"], ["Hard costs", "$2,900,000"], ["Total project cost", "$3,910,000"], ["Total", "$3,910,000"]);
    expect(pick(stated).filter(([k]) => k === "stated_total_cost")).toEqual([["stated_total_cost", 3_910_000]]);
  });
  test("a component list after a label that names no cost goes to other costs shown, not read", () => {
    const r = read("Summary: $3,000,000 (land, hard costs and soft costs)");
    expect(r.candidates).toEqual([]);
    expect(noteOf(r, 3_000_000)).toBe(SEVERAL);
    const fr = read("Résumé : 3 000 000 $ (soit terrain, construction et frais indirects)");
    expect(fr.candidates).toEqual([]);
    expect(noteOf(fr, 3_000_000)).toBe(SEVERAL);
  });
  test("negative: a note after a figure that names fewer than two budget fields changes nothing", () => {
    expect(pick(read("Land: $485,000 (closed in March)"))).toEqual([["land_cost", 485_000]]);
    expect(pick(read("Terrain : 485 000 $ (acquis en mars)"))).toEqual([["land_cost", 485_000]]);
    expect(pick(read("Hard costs: $2,000,000 (including contingency)"))).toEqual([["hard_cost", 2_000_000]]);
  });

  test("a subtotal that its unread rows do not add up to is read alone; the rows stay shown", () => {
    const r = budget(["Poste", "Montant ($)"], ["Terrain", 485_000], ["Entrepreneur général", 3_100_000], ["Architecture", 120_000], ["Ingénierie", 180_000], ["Assurances", 155_000], ["Total des coûts indirects", 455_000]);
    expect(pick(r)).toEqual([["land_cost", 485_000], ["hard_cost", 3_100_000], ["soft_cost", 455_000]]);
    // Card 109 names the contractor and architecture; the remaining parts now agree with the soft subtotal.
    for (const v of [180_000, 155_000]) expect(noteOf(r, v)).toBe("No budget line matches this label");
    const en = budget(["Item", "Amount"], ["Land", 100_000], ["General contractor lump sum", 900_000], ["Architecture", 50_000], ["Engineering", 30_000], ["Total soft costs", 80_000]);
    expect(pick(en)).toEqual([["land_cost", 100_000], ["hard_cost", 900_000], ["soft_cost", 80_000]]);
    expect(en.other).toEqual([]);
  });
  test("a table of only unread rows under one total is that total's breakdown: a difference is raised, as before", () => {
    const r = budget(["Item", "Amount"], ["Framing", 400_000], ["Mechanical", 200_000], ["Total hard cost", 650_000]);
    expect(r.candidates.filter((c) => c.fieldKey === "hard_cost").map((c) => c.value)).toEqual([600_000, 650_000]);
    expect(r.other.some((o) => o.note === NOT_SHOWN)).toBe(false);
  });
  test("a row that was read ends the run of parts", () => {
    const r = budget(["Item", "Amount"], ["Mechanical", 700_000], ["Land", 100_000], ["Architecture", 50_000], ["Engineering", 30_000], ["Total soft costs", 80_000]);
    expect(pick(r)).toEqual([["land_cost", 100_000], ["soft_cost", 80_000]]);
    expect(noteOf(r, 700_000)).not.toBe(NOT_SHOWN);
  });
  test("unread rows that do add up to the subtotal are read as before", () => {
    const r = budget(["Item", "Amount"], ["Land", 100_000], ["Architecture", 50_000], ["Engineering", 30_000], ["Insurance", 20_000], ["Total soft costs", 100_000]);
    expect(pick(r)).toEqual([["land_cost", 100_000], ["soft_cost", 100_000]]);
    expect(r.other.some((o) => o.note === NOT_SHOWN)).toBe(false);
    // Rows read as the subtotal's own field still sum and conflict with it.
    const off = budget(["Item", "Amount"], ["Hard costs, building", 400_000], ["Hard cost, site works", 200_000], ["Total hard cost", 650_000]);
    expect(off.candidates.filter((c) => c.fieldKey === "hard_cost").map((c) => c.value)).toEqual([600_000, 650_000]);
  });

  test("a figure said to be included in another is shown, not added as a cost", () => {
    const r = read("Developer fee 3% ($118,500), included in soft costs");
    expect(r.candidates.filter((c) => c.fieldKey === "other_cost")).toEqual([]);
    expect(noteOf(r, 118_500)).toBe("Already counted in Soft costs");
    const paren = read("Permits ($61,000, already in the soft-cost line)");
    expect(paren.candidates).toEqual([]);
    expect(noteOf(paren, 61_000)).toBe("Already counted in Soft costs");
    const fr = read("Frais du promoteur : 61 000 $, compris dans les coûts indirects");
    expect(fr.candidates).toEqual([]);
    expect(noteOf(fr, 61_000)).toBe("Already counted in Soft costs");
  });
  test("a table row whose label says it is included in a field adds nothing", () => {
    const r = budget(["Item", "Amount"], ["Land", 100_000], ["Soft costs", 455_000], ["Developer fee (included in soft costs)", 61_000], ["Other costs", 20_000]);
    expect(pick(r)).toEqual([["land_cost", 100_000], ["soft_cost", 455_000], ["other_cost", 20_000]]);
    expect(noteOf(r, 61_000)).toBe("Already counted in Soft costs");
  });
  test("negative: a figure within or part of something that is no budget field is still read", () => {
    expect(pick(read("Hard costs: $2,000,000, within 10% of the estimate"))).toEqual([["hard_cost", 2_000_000]]);
    expect(pick(read("Land: $485,000, part of the first phase"))).toEqual([["land_cost", 485_000]]);
  });

  test("a total's own cost words do not make a construction or works total the project total", () => {
    expect(pick(read("Coût total des travaux : 3 200 000 $"))).toEqual([]);
    expect(pick(read("Total construction cost: $3,200,000"))).toEqual([["hard_cost", 3_200_000]]);
    expect(pick(read("Coût total du projet : 6 000 000 $"))).toEqual([["stated_total_cost", 6_000_000]]);
    expect(pick(read("Coût total reconnu : 6 000 000 $"))).toEqual([["stated_total_cost", 6_000_000]]);
  });
  test("a subtotal over read and unread rows: they are its parts when they add up, else it is read alone, never a conflict", () => {
    const head: [string, string] = ["Poste", "Montant ($)"];
    const fits = budget(head, ["Terrain", 100_000], ["Entrepreneur général", 900_000], ["Honoraires professionnels", 50_000], ["Architecture", 30_000], ["Ingénierie", 20_000], ["Total des coûts indirects", 100_000]);
    expect(pick(fits)).toEqual([["land_cost", 100_000], ["hard_cost", 900_000], ["soft_cost", 100_000]]);
    const off = budget(head, ["Terrain", 100_000], ["Entrepreneur général", 900_000], ["Honoraires professionnels", 50_000], ["Architecture", 30_000], ["Ingénierie", 20_000], ["Total des coûts indirects", 130_000]);
    expect(pick(off)).toEqual([["land_cost", 100_000], ["hard_cost", 900_000], ["soft_cost", 130_000]]);
    for (const v of [50_000, 30_000, 20_000]) expect(noteOf(off, v)).toBe(NOT_SHOWN);
    // Negative: when every row of the run was read, a difference is still a conflict.
    const all = budget(head, ["Honoraires professionnels", 50_000], ["Frais indirects divers", 30_000], ["Total des coûts indirects", 100_000]);
    expect(all.candidates.filter((c) => c.fieldKey === "soft_cost").map((c) => c.value)).toEqual([80_000, 100_000]);
  });
  async function formulaBook(): Promise<NormalizedDocument> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Budget");
    ws.addRows([["Item", "Amount"], ["Land", 100_000], ["Hard costs", 200_000]]);
    ws.getCell("A4").value = "Soft costs";
    ws.getCell("B4").value = { formula: "SUM(B2:B3)" } as never;
    ws.getCell("A6").value = "Other costs";
    ws.getCell("B6").value = { formula: "B2/0", result: { error: "#DIV/0!" } } as never;
    ws.getCell("A5").value = "Contingency";
    ws.getCell("B5").value = { formula: "B3*0.05", result: 10_000 } as never;
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "f.xlsx");
  }
  test("a formula with no saved result gives no value and a document note; one with a result is read", async () => {
    const parsed = await formulaBook();
    const r = extractCandidates(parsed);
    expect(JSON.stringify([r.candidates, r.other, parsed.tables])).not.toContain("[object Object]");
    expect(pick(r)).toEqual([["land_cost", 100_000], ["hard_cost", 200_000], ["contingency", 10_000]]);
    expect(JSON.stringify(parsed.tables)).not.toContain("#REF");
    expect(r.notes).toEqual(["This workbook has formulas with no saved results (B4). Open and save it in Excel to include them."]);
  });
  test("negative: a workbook of plain values has no document note", async () => {
    const r = extractCandidates(await parseDocument(new Uint8Array(await (async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet("Budget").addRows([["Item", "Amount"], ["Land", 100_000]]);
      return wb.xlsx.writeBuffer();
    })()), "p.xlsx"));
    expect(r.notes).toEqual([]);
  });
  describe("workbook packages with absolute internal links", () => {
    async function twoSheetBytes(): Promise<Uint8Array> {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const a = wb.addWorksheet("Budget");
      a.addRows([["Item", "Amount"], ["Land", 100_000]]);
      a.getCell("A3").value = "Contingency";
      a.getCell("B3").value = 0.05;
      a.getCell("B3").numFmt = "0.0%";
      const b = wb.addWorksheet("Notes");
      b.addRows([["Label", 7]]);
      // A cell note gives the sheet its own relationship part, whose target is not under the sheet's folder.
      b.getCell("A1").note = "checked";
      return new Uint8Array(await wb.xlsx.writeBuffer());
    }
    async function withAbsoluteTargets(bytes: Uint8Array): Promise<Uint8Array> {
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(bytes);
      let changed = 0;
      for (const name of Object.keys(zip.files).filter((n) => n.endsWith(".rels"))) {
        const xml = await zip.file(name)!.async("string");
        // A relationship's target is relative to the folder that holds the part it describes.
        const folder = name.replace(/_rels\/[^/]*$/, "");
        const out = xml.replace(/Target="(?!\/|https?:)([^"]*)"/g, (_m, t: string) => {
          changed++;
          const path: string[] = [];
          for (const p of `${folder}${t}`.split("/")) if (p === "..") path.pop(); else path.push(p);
          return `Target="/${path.join("/")}"`;
        });
        zip.file(name, out);
      }
      expect(changed).toBeGreaterThan(0);
      return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    }
    test("a workbook whose sheet links are absolute parses to the same cells as the relative one", async () => {
      const relative = await twoSheetBytes();
      const absolute = await withAbsoluteTargets(relative);
      const JSZip = (await import("jszip")).default;
      expect(await (await JSZip.loadAsync(absolute)).file("xl/_rels/workbook.xml.rels")!.async("string")).toContain('Target="/xl/worksheets/sheet1.xml"');
      const a = await parseDocument(absolute, "a.xlsx");
      const r = await parseDocument(relative, "r.xlsx");
      expect(a.tables.length).toBe(2);
      expect(JSON.stringify(a)).toBe(JSON.stringify(r));
      expect(JSON.stringify(a)).toContain("Contingency");
    });
    test("a sheet written with a prefixed SpreadsheetML namespace parses to the same cells as the plain one", async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("First");
      ws.addRows([["Item", "Amount"], ["Land", 250_000]]);
      ws.getCell("A3").value = "Vacancy";
      ws.getCell("B3").value = 0.04;
      ws.getCell("B3").numFmt = "0.0%";
      wb.addWorksheet("Second").addRows([["Fees", 9_000]]);
      const plain = new Uint8Array(await wb.xlsx.writeBuffer());
      const JSZip = (await import("jszip")).default;
      const zip = await JSZip.loadAsync(plain);
      const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
      const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
      const prefixed = xml.replace(`xmlns="${main}"`, `xmlns:ns0="${main}"`).replace(/<(\/?)([A-Za-z]\w*)/g, "<$1ns0:$2");
      expect(prefixed).toContain("<ns0:sheetData>");
      zip.file("xl/worksheets/sheet1.xml", prefixed);
      const a = await parseDocument(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), "p.xlsx");
      const r = await parseDocument(plain, "r.xlsx");
      expect(JSON.stringify(a)).toBe(JSON.stringify(r));
      expect(JSON.stringify(a)).toContain("Vacancy");
    });
    test("a part is rewritten only when it needs it: a different default namespace is kept, an external link target is never touched", async () => {
      const JSZip = (await import("jszip")).default;
      const pack = async (parts: Record<string, string>) => {
        const zip = new JSZip();
        for (const [n, t] of Object.entries(parts)) zip.file(n, t);
        return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
      };
      const read = async (bytes: Uint8Array, name: string) => (await JSZip.loadAsync(bytes)).file(name)!.async("string");
      const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" TargetMode="External" Type="t" Target="/shared/other.xlsx"/><Relationship Id="rId2" Type="t" Target="/xl/styles.xml" TargetMode="External"/><Relationship Id="rId3" Type="t" Target="/xl/styles.xml"/></Relationships>`;
      const out = await relativeLinks(await pack({ "xl/_rels/workbook.xml.rels": rels }));
      const text = await read(out, "xl/_rels/workbook.xml.rels");
      expect(text).toContain('TargetMode="External" Type="t" Target="/shared/other.xlsx"');
      expect(text).toContain('Target="/xl/styles.xml" TargetMode="External"');
      expect(text).toContain('Id="rId3" Type="t" Target="styles.xml"');
      const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
      const other = `<q:sheetData xmlns:q="${main}" xmlns="urn:other"><q:row/></q:sheetData>`;
      const kept = await relativeLinks(await pack({ "xl/worksheets/sheet1.xml": other, "xl/_rels/workbook.xml.rels": rels }));
      expect(await read(kept, "xl/worksheets/sheet1.xml")).toBe(other);
    });
    /** A small zip whose central directory declares parts of the given sizes, without any such parts existing. */
    const declaring = async (sizes: number[], patch?: (b: Buffer, at: number) => void, word = false) => {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      if (word) zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>`);
      sizes.forEach((_, i) => zip.file(`xl/p${i}.xml`, "a"));
      const b = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
      let at = b.readUInt32LE(b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])) + 16);
      if (word) at += 46 + b.readUInt16LE(at + 28);
      sizes.forEach((size) => {
        b.writeUInt32LE(size, at + 24);
        patch?.(b, at);
        at += 46 + b.readUInt16LE(at + 28);
      });
      return new Uint8Array(b);
    };
    const wordFile = async () => {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      zip.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Land</w:t></w:r></w:p></w:body></w:document>`);
      return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
    };
    test("a package with a part above the size cap is left exactly as it came", async () => {
      const bytes = await declaring([300 * 1024 * 1024]);
      expect(relativeLinks(bytes)).toBe(bytes);
    });
    test("an upload that expands beyond the caps is refused with a plain message (task 47b)", async () => {
      const msg = "This file expands to more than 500 MB when opened; Agir does not read it";
      const big = 300 * 1024 * 1024;
      await expect(parseDocument(await declaring([big]), "b.xlsx")).rejects.toThrow(msg);
      await expect(parseDocument(await declaring([big], undefined, true), "b.docx")).rejects.toThrow(msg);
      // Parts each under the part cap that together pass the package cap.
      await expect(parseDocument(await declaring([200 * 1024 * 1024, 200 * 1024 * 1024, 200 * 1024 * 1024]), "b.xlsx")).rejects.toThrow(msg);
      // An encrypted entry and a zip64 marker.
      await expect(parseDocument(await declaring([1], (b, at) => b.writeUInt16LE(1, at + 8)), "e.xlsx")).rejects.toThrow(msg);
      await expect(parseDocument(await declaring([1], (b, at) => b.writeUInt32LE(0xffffffff, at + 20)), "z.xlsx")).rejects.toThrow(msg);
      // A package that understates a part's size: the part inflates past what it declares.
      const JSZip = (await import("jszip")).default;
      const lying = new JSZip();
      lying.file("xl/p0.xml", "<x>" + "0".repeat(200_000) + "</x>", { createFolders: false });
      const lb = Buffer.from(await lying.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
      lb.writeUInt32LE(64, lb.readUInt32LE(lb.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6])) + 16) + 24);
      await expect(parseDocument(new Uint8Array(lb), "l.xlsx")).rejects.toThrow(msg);
    });
    test("normal workbooks and Word files still read (task 47b)", async () => {
      expect((await parseDocument(await twoSheetBytes(), "r.xlsx")).kind).toBe("xlsx");
      expect((await parseDocument(await wordFile(), "n.docx")).kind).toBe("docx");
    });
    test("a PDF above the page cap is refused (task 47b)", () => {
      expect(MAX_PDF_PAGES).toBe(5000);
      expect(pdfPageError(5001)?.message).toBe("This PDF has more than 5,000 pages; Agir does not read it");
      expect(pdfPageError(5000)).toBeNull();
    });
    test("a relative-target workbook is read as before", async () => {
      const d = await parseDocument(await twoSheetBytes(), "r.xlsx");
      expect(d.tables.map((t) => t.rows.length)).toEqual([3, 1]);
    });
    test("a corrupt file still fails to read", async () => {
      await expect(parseDocument(new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5]), "c.xlsx")).rejects.toThrow();
    });
  });
  describe("more label forms and vocabulary", () => {
    const withLines = (lines: string[], ...tables: Table[]) => extractCandidates(doc(lines, tables));
    test("a capitalised label ending in a full stop, or a run of dots, is a label and its value", () => {
      expect(pick(read("Loan amount. $3,400,000", "INTEREST. 6.10% per annum"))).toEqual([["senior_loan_amount", 3_400_000], ["senior_rate_pct", 6.1]]);
      // A bare number after a label is money (it is not in a sentence).
      expect(pick(read("Hard Costs. 3,200,000"))).toEqual([["hard_cost", 3_200_000]]);
      expect(pick(read("Total project cost ........ $4,210,000", "Interest reserve .... $190,000"))).toEqual([["stated_total_cost", 4_210_000], ["stated_interest_reserve", 190_000]]);
      expect(pick(read("Coût total du projet ...... 4,2 M$"))).toEqual([["stated_total_cost", 4_200_000]]);
      expect(pick(read("Land cost . . . . . 1,485,000"))).toEqual([["land_cost", 1_485_000]]);
      expect(pick(read("MONTANT AUTORISÉ : 2 750 000 $", "TAUX D'INTÉRÊT. 6,10 %"))).toEqual([["senior_loan_amount", 2_750_000], ["senior_rate_pct", 6.1]]);
    });
    test("negative: a sentence that ends in a full stop is not a label", () => {
      const r = read("The loan was approved in 2026. The rate is 6%");
      expect(pick(r)).toEqual([["senior_rate_pct", 6]]);
      expect(noteOf(r, 2026)).toBe("This is a year, not an amount");
      expect(pick(read("Phase 2. 24 units are planned"))).toEqual([]);
      expect(pick(read("We expect to close in Late June. 6 months of construction follow"))).toEqual([]);
    });

    test("a lender's amount and authorised sum, in English and French", () => {
      expect(pick(read("Authorized amount: $2,000,000", "Facility amount: $2,100,000"))).toEqual([["senior_loan_amount", 2_000_000], ["senior_loan_amount", 2_100_000]]);
      expect(pick(read("Montant autorisé : 2 750 000 $"))).toEqual([["senior_loan_amount", 2_750_000]]);
      // Under a mezzanine letter it is the mezzanine amount.
      expect(pick(read("Mezzanine commitment letter", "Authorized amount: $650,000"))).toEqual([["mezz_loan_amount", 650_000]]);
    });
    test("an interest reserve and a stated total, in each form", () => {
      expect(pick(read("Capitalized interest reserve: $190,000", "Réserve d'intérêts : 175 000 $"))).toEqual([["stated_interest_reserve", 190_000], ["stated_interest_reserve", 175_000]]);
      expect(pick(read("All-in cost: $6,400,000", "Total project cost is $6,450,000"))).toEqual([["stated_total_cost", 6_400_000], ["stated_total_cost", 6_450_000]]);
      expect(pick(read("Interest reserve of $190,000 is held back."))).toEqual([["stated_interest_reserve", 190_000]]);
    });
    test("government charges and taxes are their own cost lines (card 61b) or other costs, never the land", () => {
      expect(pick(read("Development charges: $120,000", "DCCs: $80,000", "Development cost charges: $60,000", "Permit levies: $12,000"))).toEqual([["development_charges", 120_000], ["development_charges", 80_000], ["development_charges", 60_000], ["other_cost", 12_000]]);
      expect(pick(read("Land transfer tax: $45,000", "LTT: $46,000", "DCs: $9,000"))).toEqual([["land_transfer_tax", 45_000], ["land_transfer_tax", 46_000], ["development_charges", 9_000]]);
      expect(pick(read("Taxe de bienvenue : 12 000 $", "Droits de mutation : 13 000 $"))).toEqual([["land_transfer_tax", 12_000], ["land_transfer_tax", 13_000]]);
      expect(pick(read("Land transfer tax of $45,000 is due at closing."))).toEqual([["land_transfer_tax", 45_000]]);
      const t = budget(["Item", "Amount"], ["Land", 485_000], ["Land transfer tax", 8_000], ["Development charges", 120_000]);
      expect(pick(t)).toEqual([["land_cost", 485_000], ["land_transfer_tax", 8_000], ["development_charges", 120_000]]);
      // Negative: the land alone is still the land.
      expect(pick(read("Land: $485,000"))).toEqual([["land_cost", 485_000]]);
    });
    test("expense shares of EGI, with the base stated", () => {
      expect(pick(read("Opex 35% of EGI", "Operating expenses (% of EGI): 38%"))).toEqual([["expense_ratio_pct", 35], ["expense_ratio_pct", 38]]);
      expect(pick(read("Dépenses 36 % des revenus"))).toEqual([["expense_ratio_pct", 36]]);
      expect(pick(read("Operating expenses run at 37% of EGI, with management 4% of EGI on top."))).toEqual([["expense_ratio_pct", 37], ["variable_expense_pct", 4]]);
      expect(pick(read("Management 4% of EGI on top", "Gestion 5 % des revenus"))).toEqual([["variable_expense_pct", 4], ["variable_expense_pct", 5]]);
    });
    test("negative: management or expenses of something that is not EGI are not read", () => {
      expect(pick(read("Asset management 1.5% of equity"))).toEqual([]);
      expect(pick(read("Management 4%"))).toEqual([]);
      expect(pick(read("Dépenses en capital 5 % du coût"))).toEqual([]);
      expect(pick(read("Management fee: 4% of EGI"))).toEqual([["variable_expense_pct", 4]]);
    });
    test("recoveries are other income", () => {
      expect(pick(read("Recoveries: $24,000", "CAM and tax recoveries: $30,000", "Récupérations : 18 000 $"))).toEqual([["other_income_annual", 24_000], ["other_income_annual", 30_000], ["other_income_annual", 18_000]]);
      expect(pick(read("Other income: recoveries of $24,000 a year"))).toEqual([["other_income_annual", 24_000]]);
    });
    test("limited partners' percentage is the LP share; a return paid to them is not", () => {
      expect(pick(read("Limited partners 70%, general partner 30%"))).toEqual([["lp_share_pct", 70]]);
      expect(pick(read("LP: 80%"))).toEqual([["lp_share_pct", 80]]);
      expect(pick(read("Commanditaires : 75 %"))).toEqual([["lp_share_pct", 75]]);
      const r = read("Preferred return to limited partners 8%");
      expect(pick(r)).toEqual([["preferred_return_pct", 8]]);
    });
    test("a covenant stated in words is the minimum DSCR; the forms that are not covenants stay shown", () => {
      expect(pick(read("Covenant: debt service coverage of not less than 1.20x"))).toEqual([["min_dscr_covenant", 1.2]]);
      expect(pick(read("The borrower shall keep a DSCR of at least 1.25x."))).toEqual([["min_dscr_covenant", 1.25]]);
      expect(pick(read("Clause : ratio de couverture du service de la dette d'au moins 1,20x"))).toEqual([["min_dscr_covenant", 1.2]]);
      expect(pick(read("Debt service coverage: 1.35x"))).toEqual([]);
      expect(pick(read("Projected debt service coverage of at least 1.35x"))).toEqual([]);
    });

    const QUOTE = ["Fixed-price quote", "Prepared by Northfield Contractors Ltd."];
    test("a builder's quote total is the hard cost", () => {
      expect(pick(withLines([...QUOTE, "Total: $2,310,000"]))).toEqual([["hard_cost", 2_310_000]]);
      expect(pick(withLines(["Soumission", "Entrepreneur : Construction Boréal inc.", "Prix du contrat : 1 980 000 $"]))).toEqual([["hard_cost", 1_980_000]]);
      expect(pick(withLines(["Soumission", "Entrepreneur : Construction Boréal inc.", "Total : 1 980 000 $"]))).toEqual([["hard_cost", 1_980_000]]);
      const t = grid(["Item", "Amount"], ["Framing", 900_000], ["Mechanical", 700_000], ["Subtotal", 1_600_000], ["Total", 1_840_000]);
      expect(pick(withLines(QUOTE, t))).toEqual([["hard_cost", 1_840_000]]);
    });
    test("a later revision of the quote supersedes the earlier, whichever way the revision is written", () => {
      const inLabel = withLines([...QUOTE, "Total (Rev A): $2,150,000", "Total (Rev B): $2,310,000"]);
      expect(pick(inLabel)).toEqual([["hard_cost", 2_310_000]]);
      expect(noteOf(inLabel, 2_150_000)).toMatch(/supersed/i);
      const byHeading = withLines([...QUOTE, "Revision A", "Total: $2,150,000", "Revision B", "Total: $2,310,000"]);
      expect(pick(byHeading)).toEqual([["hard_cost", 2_310_000]]);
      expect(noteOf(byHeading, 2_150_000)).toMatch(/supersed/i);
      const inTable = withLines(QUOTE, grid(["Item", "Amount"], ["Total (Rev A)", 2_150_000], ["Total (Rev B)", 2_310_000]));
      expect(pick(inTable)).toEqual([["hard_cost", 2_310_000]]);
      const fr = withLines(["Soumission", "Entrepreneur : Construction Boréal inc.", "Prix du contrat (rév. A) : 1 980 000 $", "Prix du contrat (rév. B) : 2 040 000 $"]);
      expect(pick(fr)).toEqual([["hard_cost", 2_040_000]]);
      expect(noteOf(fr, 1_980_000)).toMatch(/supersed/i);
      // Negative: the same total twice, or two totals under no revision, is a conflict for a person, not a pick.
      expect(withLines([...QUOTE, "Total: $2,150,000", "Total: $2,310,000"]).candidates.map((c) => c.value)).toEqual([2_150_000, 2_310_000]);
    });
    test("negative: Total outside a builder's quote is unchanged", () => {
      expect(pick(read("Cost estimate", "Prepared by the developer", "Total: $2,000,000"))).toEqual([]);
      expect(pick(read("Quote for an apartment sale", "Total: $2,000,000"))).toEqual([]);
      expect(pick(budget(["Item", "Amount"], ["Land", 100_000], ["Total", 100_000]))).toEqual([["land_cost", 100_000]]);
      const roll = extractCandidates(doc(["Rent roll"], [grid(["Unit type", "Units", "Monthly rent"], ["1BR", 10, 1_500], ["Grand total", 10, 15_000]) ]));
      expect(roll.candidates.some((c) => c.fieldKey === "hard_cost")).toBe(false);
      expect(pick(read("Coût total des travaux : 3 200 000 $"))).toEqual([]);
    });

    test("a loan named as the whole label gets its figures", () => {
      const r = read("Senior $3.5M from Valleyline, mezz $650k at 11%");
      expect(pick(r)).toEqual([["senior_loan_amount", 3_500_000], ["mezz_loan_amount", 650_000], ["mezz_rate_pct", 11]]);
      expect(pick(read("Prêt de second rang 450 000 $ à 11 %"))).toEqual([["mezz_loan_amount", 450_000], ["mezz_rate_pct", 11]]);
      expect(pick(read("Mezzanine: $650,000", "Mezz: 11%", "Mezz: 24 months interest only", "Senior: 25-year amortization"))).toEqual([["mezz_loan_amount", 650_000], ["mezz_rate_pct", 11], ["mezz_io_months", 24], ["senior_amort_years", 25]]);
      expect(pick(extractCandidates(doc([], [grid(["Facility", "Amount"], ["Senior", 3_500_000], ["Second mortgage", 450_000])])))).toEqual([["senior_loan_amount", 3_500_000], ["mezz_loan_amount", 450_000]]);
    });
    test("negative: a lender's type or name, a share, or a limit or term is not a loan's figure", () => {
      expect(pick(read("Credit union $3,000,000"))).toEqual([]);
      expect(pick(read("Mezzanine lender Northgate Capital 650,000"))).toEqual([]);
      expect(pick(read("Senior 65% of cost"))).toEqual([]);
      expect(pick(read("Senior: 65% LTC"))).toEqual([["stated_ltc_pct", 65]]);
      expect(pick(read("Senior: maximum $5,000,000", "Mezz: 24-month term"))).toEqual([]);
      expect(pick(read("Authorized amount fee: 1%"))).toEqual([]);
    });
    test("interest alone is the rate only as the whole label of a label/value line", () => {
      expect(pick(read("INTEREST. 6.25%", "Interest: 6.1%", "Intérêt : 5,9 %"))).toEqual([["senior_rate_pct", 6.25], ["senior_rate_pct", 6.1], ["senior_rate_pct", 5.9]]);
      expect(pick(read("The General Partner receives a promoted interest of 20% of further distributions")).some(([k]) => k === "senior_rate_pct")).toBe(false);
      expect(pick(read("Ownership interest: 20% of distributions"))).toEqual([]);
      expect(pick(read("Une participation avec intérêt de 20 % des distributions"))).toEqual([]);
      expect(pick(read("Carried interest of 20% above the preferred return"))).toEqual([["gp_promote_pct", 20]]);
    });
    test("a list of what a cost covers never labels it", () => {
      expect(pick(read("Soft costs, covering design, permits, development charges and legal fees, are budgeted at $450,000."))).toEqual([["soft_cost", 450_000]]);
      expect(pick(read("Hard costs, including site works and land transfer tax: $3,000,000"))).toEqual([["hard_cost", 3_000_000]]);
      expect(pick(read("Coûts indirects, comprenant les frais de développement et les droits de mutation : 450 000 $"))).toEqual([["soft_cost", 450_000]]);
      // Negative: without a budget field at its head the list is read as before.
      expect(pick(read("Charges including development charges: $120,000"))).toEqual([["development_charges", 120_000]]);
    });
    test("a quote table with revision columns reads the latest column and shows the earlier", () => {
      const NOTE = "Superseded by a later revision of this quote";
      const a = withLines(QUOTE, grid(["Item", "Rev A ($)", "Rev B ($)"], ["Total", 2_150_000, 2_310_000]));
      expect(pick(a)).toEqual([["hard_cost", 2_310_000]]);
      expect(noteOf(a, 2_150_000)).toBe(NOTE);
      const swapped = withLines(QUOTE, grid(["Item", "Rev B ($)", "Rev A ($)"], ["Total", 2_310_000, 2_150_000]));
      expect(pick(swapped)).toEqual([["hard_cost", 2_310_000]]);
      for (const [x, y] of [["Original", "Revised"], ["Previous", "Current"], ["Initial", "Révisé"], ["Révision 1", "Révision 2"]] as const) {
        const r = extractCandidates(doc([], [grid(["Item", `Amount ${x}`, `Amount ${y}`], ["Land", 100_000, 120_000])]));
        expect(pick(r), `${x}/${y}`).toEqual([["land_cost", 120_000]]);
        expect(noteOf(r, 100_000), `${x}/${y}`).toBe(NOTE);
      }
    });
    test("amount columns whose order the headers do not tell are read as none", () => {
      const r = extractCandidates(doc([], [grid(["Item", "Amount (Option X)", "Amount (Option Y)"], ["Land", 100_000, 120_000])]));
      expect(r.candidates).toEqual([]);
      expect(noteOf(r, 100_000)).toBe("Several amount columns; choose one");
      expect(noteOf(r, 120_000)).toBe("Several amount columns; choose one");
      // Negative: one amount column is read as always.
      expect(pick(extractCandidates(doc([], [grid(["Item", "Amount"], ["Land", 100_000])])))).toEqual([["land_cost", 100_000]]);
    });
  });
});

describe("durations after the number, revisions in a sentence, percent cells, vacancy and flags", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: tables.length ? "xlsx" : "pdf",
    lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const noteOf = (r: ReturnType<typeof extractCandidates>, value: number) => r.other.find((o) => o.value === value)?.note ?? "";
  const REPLACED = "A later figure in the same sentence replaces this one";

  test("a duration followed by what it is the duration of", () => {
    expect(pick(read("The build is 16 months, then 7 months to lease up"))).toEqual([["construction_months", 16], ["lease_up_months", 7]]);
    expect(pick(read("Horaire : quatorze mois de construction, puis cinq mois de location"))).toEqual([["construction_months", 14], ["lease_up_months", 5]]);
    expect(pick(read("Expect 9 months to build and 6 months to lease."))).toEqual([["construction_months", 9], ["lease_up_months", 6]]);
    expect(pick(read("On prévoit 8 mois pour louer les logements"))).toEqual([["lease_up_months", 8]]);
  });
  test("a duration after an interest-only label is that loan's interest-only period", () => {
    expect(pick(read("Interest only: first 18 months from first advance"))).toEqual([["senior_io_months", 18]]);
    expect(pick(read("Mezzanine commitment letter", "IO: 12 months"))).toEqual([["mezz_io_months", 12]]);
    expect(pick(read("Intérêts seulement : 20 mois"))).toEqual([["senior_io_months", 20]]);
  });
  test("negative: a loan's term is not construction, and a bare duration names nothing", () => {
    expect(pick(read("The loan has a 24-month term"))).toEqual([]);
    expect(pick(read("A 24 month term, 12 months of construction"))).toEqual([["construction_months", 12]]);
    expect(pick(read("We met for 3 months"))).toEqual([]);
  });

  test("negative: to build or to lease label a duration only right after it, never a later number", () => {
    expect(pick(read("We plan to build in 2027 and expect 18 months of lease-up"))).toEqual([["lease_up_months", 18]]);
    expect(pick(read("Nous voulons pour louer vite et prévoyons 14 mois de construction"))).toEqual([["construction_months", 14]]);
    expect(pick(read("Les travaux, 14 mois pour louer ensuite 5 mois de location"))).toEqual([["lease_up_months", 14], ["lease_up_months", 5]]);
  });

  test("an after-number phrase labels the duration before it only, not the next number", () => {
    expect(pick(read("- 1.5 years to build, 5 months lease-up"))).toEqual([["construction_months", 18], ["lease_up_months", 5]]);
    expect(pick(read("- 16 mois pour louer, 4 mois de construction"))).toEqual([["lease_up_months", 16], ["construction_months", 4]]);
  });

  test("a number word after a bullet is read, and a semicolon ends the clause a label reaches", () => {
    expect(pick(read("- twenty months to build; four months of lease-up once it is done."))).toEqual([["construction_months", 20], ["lease_up_months", 4]]);
    expect(pick(read("• seize mois de construction ; trois mois de location."))).toEqual([["construction_months", 16], ["lease_up_months", 3]]);
    expect(pick(read("* – six months of construction; two months of lease-up"))).toEqual([["construction_months", 6], ["lease_up_months", 2]]);
  });
  test("a label stays in its own clause", () => {
    expect(pick(read("Rate: 6.1%; amortization 30 years"))).toEqual([["senior_rate_pct", 6.1], ["senior_amort_years", 30]]);
    expect(pick(read("Twelve months to build; 5 months"))).toEqual([["construction_months", 12]]);
    expect(pick(read("Construction period: 14 months; 6 months"))).toEqual([["construction_months", 14]]);
  });
  test("negative: a bare duration under a heading keeps today's reading, and a hyphen inside a number is not a bullet", () => {
    const bare = read("Construction period", "- 18 months");
    expect(pick(bare)).toEqual([]);
    expect(noteOf(bare, 18)).toBe("No field matches this label");
    expect(pick(read("a twenty-four month build"))).toEqual([["construction_months", 24]]);
    expect(pick(read("one hundred-twenty units"))).toEqual([]);
  });

  test("a market vacancy or occupancy figure is shown, not the deal's assumption", () => {
    for (const line of ["Vacancy in the submarket was 2.1%", "Average occupancy in the area: 96%", "CMHC reports city vacancy of 1.8%", "Le taux d'inoccupation du marché est de 2 %", "Taux d'occupation moyen du secteur : 95 %", "Vacance dans le quartier : 3 %"]) {
      const r = read(line);
      expect(r.candidates, line).toEqual([]);
      expect(r.other[0]?.note, line).toBe("A market statistic, not the deal's assumption");
    }
    expect(pick(read("Vacancy allowance 3%"))).toEqual([["stabilized_occupancy_pct", 97]]);
  });

  test("goes from X to Y is a revision: Y is read and X is shown as replaced", () => {
    const en = read("Hard cost moved from $2,900,000 to $3,050,000");
    expect(pick(en)).toEqual([["hard_cost", 3_050_000]]);
    expect(noteOf(en, 2_900_000)).toBe(REPLACED);
    const fr = read("Le coût de construction passe de 3 410 000 $ à 3 495 000 $");
    expect(pick(fr)).toEqual([["hard_cost", 3_495_000]]);
    expect(noteOf(fr, 3_410_000)).toBe(REPLACED);
    expect(pick(read("Les coûts indirects sont passés de 410 000 $ à 450 000 $"))).toEqual([["soft_cost", 450_000]]);
    expect(pick(read("Land cost went from $1,000,000 → $1,100,000"))).toEqual([["land_cost", 1_100_000]]);
    expect(pick(read("Construction period increased from 12 to 15 months"))).toEqual([["construction_months", 15]]);
  });
  test("negative: from X to Y with no change verb stays a range", () => {
    const r = read("Hard cost from $2,900,000 to $3,050,000");
    expect(r.candidates).toEqual([]);
    expect(noteOf(r, 3_050_000)).toMatch(/range/i);
    expect(read("Le coût va de 2 900 000 $ à 3 050 000 $").candidates).toEqual([]);
  });

  async function workbook(rows: [string, number | string, string?][]): Promise<NormalizedDocument> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Inputs");
    rows.forEach(([label, value, fmt], i) => {
      ws.getCell(i + 1, 1).value = label;
      const c = ws.getCell(i + 1, 2);
      c.value = value;
      if (fmt) c.numFmt = fmt;
    });
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "inputs.xlsx");
  }
  test("a percent-formatted cell reads as its percentage, with a percent sign, and keeps its stored value", async () => {
    const d = await workbook([["Stabilized occupancy", 0.975, "0.0%"], ["Operating expenses (% of EGI)", 0.38, "0%"], ["Exit cap rate", 0.055, "0.00%"], ["Vacancy allowance", 0.03, "0.0%"]]);
    expect(d.tables[0]!.rows.map((r) => r[1]!.text)).toEqual(["97.5%", "38%", "5.5%", "3%"]);
    const r = extractCandidates(d);
    expect(pick(r)).toEqual([["stabilized_occupancy_pct", 97.5], ["expense_ratio_pct", 38], ["exit_cap_rate_pct", 5.5], ["stabilized_occupancy_pct", 97]]);
    expect(r.candidates[0]!.raw).toContain("0.975");
  });
  test("negative: a cell that is not percent-formatted is unchanged", async () => {
    const d = await workbook([["Stabilized occupancy", 95], ["Construction", 14, "0"], ["Hard cost", 0.5, '0.0" %"']]);
    expect(d.tables[0]!.rows.map((r) => r[1]!.text)).toEqual(["95", "14", "0.5"]);
  });

  test("a vacancy percentage is the stabilized occupancy's complement, and says so", () => {
    for (const [line, occ] of [["Vacancy allowance 3%", 97], ["Vacancy and credit loss: 5%", 95], ["Taux d'inoccupation 2,5 %", 97.5], ["Vacance : 4 %", 96]] as const) {
      const r = read(line);
      expect(pick(r), line).toEqual([["stabilized_occupancy_pct", occ]]);
      expect(r.candidates[0]!.unitSeen, line).toMatch(/vacan|inoccup/i);
    }
  });
  test("negative: vacancy during lease-up, at opening or today is not the stabilized figure", () => {
    for (const line of ["Vacancy during lease-up: 30%", "Vacancy at opening 40%", "Taux d'inoccupation à l'ouverture : 35 %", "Current vacancy: 6%"]) {
      expect(read(line).candidates, line).toEqual([]);
    }
  });

  const flags = (...lines: string[]) => read(...lines).candidates.map((c) => [c.fieldKey, c.value]);
  test("a Yes or No answer beside a flag's label is the flag", () => {
    expect(flags("Lease-up ramp: Yes - straight-line as units lease", "S-curve draws: No")).toEqual([["lease_up_ramp", 1], ["s_curve_draws", 0]]);
    expect(flags("Rampe de location : Oui", "Tirages en courbe en S : Non, linéaires")).toEqual([["lease_up_ramp", 1], ["s_curve_draws", 0]]);
  });
  test("a flag cell in a table or workbook is read the same way", async () => {
    expect(pick(extractCandidates(await workbook([["Lease-up ramp", "Yes - straight-line"], ["S-curve draws", "no"]])))).toEqual([["lease_up_ramp", 1], ["s_curve_draws", 0]]);
  });
  test("negative: anything but yes or no is no flag, and a yes beside another label is no flag", () => {
    expect(flags("Lease-up ramp: maybe", "S-curve draws: 1", "Lease-up ramp: Yesterday it was agreed", "Parking: Yes")).toEqual([]);
  });

  test("a figure stated in the new forms by one document disagrees with another's, and is named as a conflict", () => {
    const tag = (r: ReturnType<typeof extractCandidates>, name: string) => r.candidates.map((c) => ({ ...c, documentId: name, documentName: name }));
    const p = consolidate([...tag(read("Prévoir huit mois pour louer"), "a"), ...tag(read("Lease-up: 10 months"), "b")]).find((x) => x.fieldKey === "lease_up_months")!;
    expect(p.status).toBe("conflicting");
    expect(p.values.map((v) => v.value).sort((a, b) => a! - b!)).toEqual([8, 10]);
  });

  test("a committed first-mortgage or senior principal is the loan amount, and under a mezzanine title the mezzanine amount", () => {
    expect(pick(read("Committed first-mortgage principal: $2,450,000"))).toEqual([["senior_loan_amount", 2_450_000]]);
    expect(pick(read("The committed senior principal is $1,900,000."))).toEqual([["senior_loan_amount", 1_900_000]]);
    expect(pick(read("Mezzanine commitment letter", "Committed first-mortgage principal: $600,000"))).toEqual([["mezz_loan_amount", 600_000]]);
  });
  test("negative: a principal with no loan word is not the loan amount", () => {
    expect(pick(read("Principal: $2,450,000"))).toEqual([]);
  });
  test("of leasing is a lease-up period, with or without a sequencing word after it", () => {
    expect(pick(read("five months of leasing"))).toEqual([["lease_up_months", 5]]);
    expect(pick(read("We allow 3 months of leasing after completion"))).toEqual([["lease_up_months", 3]]);
    expect(pick(read("Nous prévoyons six mois de location"))).toEqual([["lease_up_months", 6]]);
    expect(pick(read("four months of lease up"))).toEqual([["lease_up_months", 4]]);
    expect(pick(read("trois mois de location ensuite."))).toEqual([["lease_up_months", 3]]);
    expect(pick(read("quatre mois de location après la livraison"))).toEqual([["lease_up_months", 4]]);
    expect(pick(read("three months of lease-up afterwards"))).toEqual([["lease_up_months", 3]]);
    expect(pick(read("six months to lease, then stabilize"))).toEqual([["lease_up_months", 6]]);
    expect(pick(read("six mois pour louer, puis stabilisation"))).toEqual([["lease_up_months", 6]]);
  });
  test("negative: a duration before a lease is not a lease-up, and a later number is not labelled by it", () => {
    expect(pick(read("6 months, then a 12-month lease"))).toEqual([]);
    expect(pick(read("a 12-month lease of the retail space"))).toEqual([]);
  });
  test("an exit or terminal capitalization assumption is the exit cap rate", () => {
    expect(pick(read("Exit capitalization assumption 5.4%"))).toEqual([["exit_cap_rate_pct", 5.4]]);
    expect(pick(read("Terminal capitalization assumption: 5.25%"))).toEqual([["exit_cap_rate_pct", 5.25]]);
    expect(pick(read("We use an assumed exit capitalization rate of 5.4%."))).toEqual([["exit_cap_rate_pct", 5.4]]);
    expect(pick(read("Taux de capitalisation de sortie retenu : 5,4 %"))).toEqual([["exit_cap_rate_pct", 5.4]]);
  });
  test("negative: capitalized interest stays the interest reserve, and a bare capitalization rate is not the exit rate", () => {
    expect(pick(read("Capitalized interest: $300,000"))).toEqual([["stated_interest_reserve", 300_000]]);
    expect(pick(read("Capitalization rate 5.1%"))).toEqual([]);
  });
  test("a field named inside another field's label: the one at the head of the label wins", () => {
    const fromTable = (...cells: string[]) => pick(extractCandidates(doc([], [{ name: "Terms", rows: [cells.map((text, i) => ({ text, ref: `${"AB"[i]}1` }))] }])));
    expect(pick(read("Sponsor promote over the pref hurdle 20%"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("GP carried interest above the preferred return: 30%"))).toEqual([["gp_promote_pct", 30]]);
    expect(pick(read("Prime de performance au-delà du rendement privilégié : 20 %"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("The GP promote above the preferred return is 25%."))).toEqual([["gp_promote_pct", 25]]);
    expect(fromTable("GP carried interest above the preferred return", "30%")).toEqual([["gp_promote_pct", 30]]);
    expect(fromTable("Sponsor promote over the pref hurdle", "20%")).toEqual([["gp_promote_pct", 20]]);
  });
  test("negative: the preferred return alone, or with a word before it, is still the preferred return", () => {
    expect(pick(read("Preferred return 8%"))).toEqual([["preferred_return_pct", 8]]);
  });
  test("a later promote tier is not the GP promote (task 51)", () => {
    const LATER = "A later promote tier; the field holds the first tier only";
    const row = (label: string, value: string) => extractCandidates(doc([], [{ name: "Terms", rows: [[{ text: label, ref: "A1" }, { text: value, ref: "B1" }]] }]));
    for (const [label, value, n] of [
      ["Carried interest (tier 3)", "35%", 35],
      ["GP promote - second tier", "30%", 30],
      ["Promote, tier II", "30%", 30],
      ["Promote 2nd tier", "28%", 28],
      ["Promote, tier two", "27%", 27],
      ["Prime de performance (2e palier)", "30 %", 30],
      ["Prime de performance, palier 2", "32 %", 32],
      ["Prime de performance, deuxième palier", "33 %", 33],
    ] as const) {
      const r = row(label, value);
      expect(r.candidates, label).toEqual([]);
      expect(noteOf(r, n), label).toBe(LATER);
    }
    // negative: the first tier reads as before
    expect(pick(row("Tier 1 promote", "20%"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(row("GP promote (first tier)", "20%"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("Tier 1 promote of 20%"))).toEqual([["gp_promote_pct", 20]]);
  });
  test("a share of distributions to the partners is not the preferred return (task 51)", () => {
    const SHARE = "A share of distributions, not the preferred return";
    for (const [line, value] of [
      ["Cash flow first returns capital, then pays the preferred return, then 70% to the investors and 30% to the sponsor.", 70],
      ["After the preferred return, 80% to the limited partners and 20% to the GP.", 80],
      ["Une fois le rendement privilégié versé, 70 % aux commanditaires et 30 % au commandité.", 70],
    ] as const) {
      const r = read(line);
      expect(r.candidates, line).toEqual([]);
      expect(noteOf(r, value), line).toBe(SHARE);
    }
    // negative: a share to the GP is not caught by this rule, and the preferred return itself is read
    expect(noteOf(read("After the preferred return, 80% to the LPs and 20% to the GP."), 20)).not.toBe(SHARE);
    expect(pick(read("Preferred return of 8%."))).toEqual([["preferred_return_pct", 8]]);
    expect(pick(read("A preferred return of 6% to the limited partners, then the split."))).toEqual([["preferred_return_pct", 6]]);
  });
  test("a preferred annual return is the preferred return", () => {
    expect(pick(read("Preferred annual return: 8%"))).toEqual([["preferred_return_pct", 8]]);
    expect(pick(read("Annual preferred return 7.5%"))).toEqual([["preferred_return_pct", 7.5]]);
    expect(pick(read("Rendement privilégié annuel : 8 %"))).toEqual([["preferred_return_pct", 8]]);
    expect(pick(extractCandidates(doc([], [{ name: "Terms", rows: [[{ text: "Preferred annual return", ref: "A1" }, { text: "8%", ref: "B1" }]] }])))).toEqual([["preferred_return_pct", 8]]);
  });
  test("an indicative rate is the loan's rate in scope", () => {
    expect(pick(read("Construction loan", "Taux indicatif : 6,25 %"))).toEqual([["senior_rate_pct", 6.25]]);
    expect(pick(read("Mezzanine loan", "Indicative rate: 11%"))).toEqual([["mezz_rate_pct", 11]]);
  });
});

describe("short-form multipliers in table cells", () => {
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const tableDoc = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"AB"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const read = (rows: string[][]) => extractCandidates(tableDoc(rows)).candidates.map((c) => [c.fieldKey, c.value]);
  test("a k, M, k$ or M$ beside a label scales the cell the way prose does", () => {
    expect(read([["Land cost", "185k"]])).toEqual([["land_cost", 185_000]]);
    expect(read([["Land cost", "1.2M"]])).toEqual([["land_cost", 1_200_000]]);
    expect(read([["Coût du terrain", "1,2 M$"]])).toEqual([["land_cost", 1_200_000]]);
    expect(read([["Coût du terrain", "450 k$"]])).toEqual([["land_cost", 450_000]]);
    expect(read([["Land cost", "1,2 millions $"]])).toEqual([["land_cost", 1_200_000]]);
  });
  test("a CSV text cell is scaled too", async () => {
    const d = await parseDocument(new TextEncoder().encode("Land cost,185k\nHard costs,2.5M\n"), "b.csv");
    expect(extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 185_000], ["hard_cost", 2_500_000]]);
  });
  test("an xlsx text cell is scaled too", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Budget");
    ws.getCell(1, 1).value = "Land cost";
    ws.getCell(1, 2).value = "185k";
    const d = await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "b.xlsx");
    expect(extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 185_000]]);
  });
  test("negative: a bare number is unchanged, a unit count is not scaled, and a lowercase m is not a million", () => {
    expect(read([["Land cost", "185"]])).toEqual([]);
    expect(read([["Land cost", "$185,000"]])).toEqual([["land_cost", 185_000]]);
    const roll = extractCandidates(tableDoc([["Unit type", "Units", "Monthly rent"], ["Studio", "12", "$1,450"]]));
    expect(roll.candidates.find((c) => c.fieldKey === "unit_count")?.value).toBe(12);
    expect(read([["Land cost", "85 m"]])).not.toContainEqual(["land_cost", 85_000_000]);
    expect(read([["Land cost", "85 m"]])).not.toContainEqual(["land_cost", 85]);
  });
});

describe("rows, lines and sections marked as not part of the deal", () => {
  const NOTE = "Marked as not part of this deal";
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const tableDoc = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"ABC"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const linesDoc = (lines: string[]): NormalizedDocument => ({
    kind: "docx",
    lines: lines.map((text, i) => ({ text, location: `L${i + 1}` })),
    tables: [],
    pageCount: null,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const vals = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value]);
  const noted = (d: NormalizedDocument) => extractCandidates(d).other.filter((o) => o.note === NOTE).map((o) => o.value);

  test("a budget row that says it is for reference is shown, not added to land", () => {
    const d = tableDoc([
      ["Item", "Amount", "Note"],
      ["Land - main lot", "$310,000", ""],
      ["Not part of this project: neighbouring lot (for reference)", "$88,000", "for comparison only"],
    ]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
    expect(noted(d)).toEqual([88_000]);
  });
  test("a French note column or a bilingual label marks the row on either half", () => {
    const d = tableDoc([
      ["Poste", "Montant", "Remarque"],
      ["Terrain", "310 000 $", ""],
      ["Terrain voisin", "88 000 $", "à titre indicatif"],
    ]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
    expect(noted(d)).toEqual([88_000]);
    const b = tableDoc([
      ["Item / Poste", "Amount / Montant"],
      ["Land / terrain", "$310,000"],
      ["Excluded parcel / Parcelle exclue", "$88,000"],
    ]);
    expect(vals(b)).toEqual([["land_cost", 310_000]]);
    const c = tableDoc([
      ["Item", "Amount"],
      ["Land", "$310,000"],
      ["Second lot / Lot voisin (non retenu)", "$88,000"],
    ]);
    expect(vals(c)).toEqual([["land_cost", 310_000]]);
  });
  test("an excluded row joins no sum and no conflict", () => {
    const d = tableDoc([
      ["Item", "Amount"],
      ["Land - lot A", "$200,000"],
      ["Land - lot B", "$110,000"],
      ["Land - lot C (hypothetical)", "$88,000"],
    ]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
  });
  test("a section headed as an example gives its lines to other", () => {
    const d = linesDoc(["Land: $310,000", "Example only - not this project", "Land: $90,000", "Hard costs: $1,000,000", "Soft costs: $400,000"]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
    expect(noted(d)).toEqual([90_000, 1_000_000, 400_000]);
  });
  test("a heading ends the excluded section, in prose and in a table", () => {
    const d = linesDoc(["Illustrative case", "Land: $90,000", "This project", "Land: $310,000"]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
    const t = tableDoc([["Land", "$310,000"], ["Exemple seulement - non retenu"], ["Land", "$90,000"]]);
    expect(vals(t)).toEqual([["land_cost", 310_000]]);
    expect(noted(t)).toEqual([90_000]);
  });
  test("a prose sentence that is for reference only is shown", () => {
    const d = linesDoc(["Land is $310,000.", "The neighbouring lot, $88,000, is for reference only."]);
    expect(vals(d)).toEqual([["land_cost", 310_000]]);
    expect(noted(d)).toEqual([88_000]);
    expect(vals(linesDoc(["Terrain: 310 000 $", "Le lot voisin à 88 000 $ est exclu."]))).toEqual([["land_cost", 310_000]]);
  });
  test("negative: a tax basis is not an exclusion, and a word elsewhere excludes nothing", () => {
    expect(vals(linesDoc(["Hard costs (excluding HST) $2,100,000"]))).toEqual([["hard_cost", 2_100_000]]);
    expect(vals(linesDoc(["Hard costs: $2,100,000 (excl. taxes)"]))).toEqual([["hard_cost", 2_100_000]]);
    expect(vals(linesDoc(["Coûts directs (hors taxes) : 2 100 000 $"]))).toEqual([["hard_cost", 2_100_000]]);
    expect(vals(linesDoc(["Coûts directs (taxes exclues) : 2 100 000 $"]))).toEqual([["hard_cost", 2_100_000]]);
    expect(vals(tableDoc([["Item", "Amount"], ["Hard costs (excluding HST)", "$2,100,000"]]))).toEqual([["hard_cost", 2_100_000]]);
    expect(vals(linesDoc(["Site: 12 Example Street", "Land: $310,000"]))).toEqual([["land_cost", 310_000]]);
    expect(vals(linesDoc(["Terrain situé rue de l'Exemple", "Land: $310,000"]))).toEqual([["land_cost", 310_000]]);
    expect(vals(linesDoc(["Note: figures below are for reference elsewhere only in the appendix.", "Hard costs: $2,100,000"]))).toEqual([["hard_cost", 2_100_000]]);
  });
});

describe("unit types written as blocks, and rent opinions", () => {
  const OPINION = "An opinion of rent, not the deal's assumption";
  const BLOCK = [
    ["Unit type", "Figure"],
    ["Two-bedroom flat", ""],
    ["Number of units", "6"],
    ["Rent per month", "$2,300"],
    ["Garden suite", ""],
    ["Number of units", "2"],
    ["Rent per month", "$1,650"],
  ];
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const tableDoc = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"AB"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const linesDoc = (lines: string[]): NormalizedDocument => ({
    kind: "docx",
    lines: lines.map((text, i) => ({ text, location: `L${i + 1}` })),
    tables: [],
    pageCount: null,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const pick = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);
  const BLOCK_READ = [
    ["unit_count", "Two-bedroom flat", 6], ["unit_rent_monthly", "Two-bedroom flat", 2_300],
    ["unit_count", "Garden suite", 2], ["unit_rent_monthly", "Garden suite", 1_650],
  ];

  test("an xlsx block table gives each heading its own units and rent", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Mix");
    BLOCK.forEach((r, i) => r.forEach((v, c) => {
      if (v === "") return;
      ws.getCell(i + 1, c + 1).value = c === 1 && /^\d+$/.test(v) ? Number(v) : v;
    }));
    const d = await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "mix.xlsx");
    expect(pick(d)).toEqual(BLOCK_READ);
  });
  test("a docx block table is read the same way", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const p = (s: string) => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`;
    const body = `<w:tbl>${BLOCK.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    const d = await parseDocument(new Uint8Array(await zip.generateAsync({ type: "uint8array" })), "mix.docx");
    expect(pick(d)).toEqual(BLOCK_READ);
  });
  test("a French block is read, and a total row ends the block", () => {
    expect(pick(tableDoc([
      ["Type", "Valeur"],
      ["Logement 4½", ""],
      ["Nombre de logements", "10"],
      ["Loyer mensuel", "1 450 $"],
    ]))).toEqual([["unit_count", "Logement 4½", 10], ["unit_rent_monthly", "Logement 4½", 1_450]]);
    const r = extractCandidates(tableDoc([
      ["Studio", ""],
      ["Number of units", "5"],
      ["Rent per month", "$1,200"],
      ["Total", ""],
      ["Number of units", "9"],
    ]));
    expect(r.candidates.filter((c) => c.itemKey === "Studio").map((c) => [c.fieldKey, c.value])).toEqual([["unit_count", 5], ["unit_rent_monthly", 1_200]]);
  });
  test("a rent called an opinion is shown with a note and creates no item", () => {
    for (const d of [
      tableDoc([["Agent's view, achievable monthly rent", "$2,400"]]),
      linesDoc(["Possible rent per broker: $2,500"]),
      tableDoc([["Loyer potentiel selon le courtier", "2 600 $"]]),
    ]) {
      const r = extractCandidates(d);
      expect(r.candidates).toEqual([]);
      expect(r.other.map((o) => o.note)).toEqual([OPINION]);
    }
  });
  test("negative: a section heading is no item, and a row-per-type roll is unchanged", () => {
    expect(pick(tableDoc([["Leasing assumptions", ""], ["Stabilized occupancy", "95%"]]))).toEqual([["stabilized_occupancy_pct", null, 95]]);
    expect(pick(tableDoc([["Unit type", "Units", "Monthly rent"], ["Studio", "4", "$1,450"]]))).toEqual([["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1_450]]);
  });

  test("digit headings that are unit types start blocks, in xlsx and in French", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Mix");
    [["1-bed", ""], ["Number of units", 8], ["Rent per month", "$1,750"], ["2-bed", ""], ["Number of units", 4], ["Rent per month", "$2,250"]].forEach((r, i) => r.forEach((v, c) => {
      if (v !== "") ws.getCell(i + 1, c + 1).value = v;
    }));
    const d = await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "mix.xlsx");
    expect(pick(d)).toEqual([["unit_count", "1-bed", 8], ["unit_rent_monthly", "1-bed", 1_750], ["unit_count", "2-bed", 4], ["unit_rent_monthly", "2-bed", 2_250]]);
    const fr = tableDoc([["3½", ""], ["Nombre de logements", "6"], ["Loyer mensuel", "1 300 $"], ["4 ½", ""], ["Nombre de logements", "2"], ["Loyer mensuel", "1 600 $"]]);
    expect(pick(fr)).toEqual([["unit_count", "3½", 6], ["unit_rent_monthly", "3½", 1_300], ["unit_count", "4 ½", 2], ["unit_rent_monthly", "4 ½", 1_600]]);
    const proposals = consolidate(extractCandidates(fr).candidates.map((c) => ({ ...c, documentId: "f", documentName: "f" })));
    expect(proposals.filter((p) => p.status === "conflicting")).toEqual([]);
  });
  test("a named item with a number starts its own block, after a unit-type block", () => {
    const d = tableDoc([["2-bed", ""], ["Unit count", "3"], ["Monthly rent per unit", "$2,050"], ["Shop 2", ""], ["Unit count", "1"], ["Total rentable area for this type", "900 sf"], ["Annual rent per square foot", "$19/sf/year"]]);
    expect(pick(d)).toEqual([["unit_count", "2-bed", 3], ["unit_rent_monthly", "2-bed", 2_050], ["unit_count", "Shop 2", 1], ["rentable_area_sf", "Shop 2", 900], ["rent_psf_annual", "Shop 2", 19]]);
  });
  test("a French monthly rent per dwelling is read in a block", () => {
    const d = tableDoc([["5½", ""], ["Nombre de logements", "2"], ["Loyer mensuel par logement", "1 950 $"]]);
    expect(pick(d).map((r) => [r[0], r[2]])).toEqual([["unit_count", 2], ["unit_rent_monthly", 1_950]]);
  });
  test("negative: a file or room reference over a count row is no heading", () => {
    for (const head of ["File 2026-14", "Room 12"]) {
      const items = pick(tableDoc([[head, ""], ["Number of units", "3"]])).map((r) => r[1]);
      expect(items).not.toContain(head);
    }
  });
  test("negative: a suite number or a year over a count row is no heading", () => {
    for (const head of ["Suite 204", "2026"]) {
      const items = pick(tableDoc([[head, ""], ["Number of units", "3"]])).map((r) => r[1]);
      expect(items).not.toContain(head);
    }
  });
  test("an annual rent per unit is divided by twelve and says so; an annual total is no unit rent", () => {
    const rent = (d: NormalizedDocument) => extractCandidates(d).candidates.filter((c) => c.fieldKey === "unit_rent_monthly");
    for (const d of [tableDoc([["Yearly rent per suite", "$26,400 per year"]]), linesDoc(["Yearly rent per suite: $26,400 per year"])]) {
      expect(rent(d).map((c) => c.value)).toEqual([2_200]);
      expect(rent(d)[0]!.unitSeen).toContain("divided by 12");
      expect(rent(d)[0]!.raw).toContain("26,400");
    }
    for (const d of [tableDoc([["Loyer annuel par logement", "21 600 $ par année"]]), linesDoc(["Loyer annuel par logement : 21 600 $ par année"])]) {
      expect(rent(d).map((c) => c.value)).toEqual([1_800]);
    }
    for (const d of [tableDoc([["Annual rent", "$310,000"]]), linesDoc(["Annual rent: $310,000"])]) {
      const r = extractCandidates(d);
      expect(r.candidates).toEqual([]);
      expect(r.other.map((o) => o.note)).toEqual(["An annual rent total, not a rent per unit"]);
    }
    // Negative: a monthly rent per unit is unchanged.
    expect(rent(tableDoc([["Monthly rent per suite", "$2,200"]])).map((c) => c.value)).toEqual([2_200]);
    // A label naming both periods is never divided: it is not read as a unit rent.
    expect(rent(tableDoc([["Monthly rent per suite, annual escalation", "$2,200"]])).map((c) => c.value)).toEqual([]);
    expect(rent(linesDoc(["Loyer mensuel par logement, hausse annuelle : 1 900 $"])).map((c) => c.value)).toEqual([]);
  });
  test("a commercial block reads area and rent per square foot under its heading", () => {
    const d = tableDoc([["Shop A", ""], ["Number of units", "1"], ["Total rentable area of this type", "1,200 sf"], ["Annual rent per square foot", "$24/sf/year"], ["Occupancy of this component", "95%"]]);
    expect(pick(d)).toEqual([["unit_count", "Shop A", 1], ["rentable_area_sf", "Shop A", 1_200], ["rent_psf_annual", "Shop A", 24], ["item_occupancy_pct", "Shop A", 95]]);
  });
  test("a French commercial block converts m2 and a rent per m2, and counts locaux", () => {
    const d = tableDoc([["Commerce A", ""], ["Nombre de locaux", "3"], ["Superficie louable totale de ce type", "120 m²"], ["Loyer annuel au mètre carré", "280 $/m²/an"], ["Occupation de ce local", "90 %"]]);
    const r = extractCandidates(d).candidates;
    expect(r.map((c) => [c.fieldKey, c.itemKey])).toEqual([["unit_count", "Commerce A"], ["rentable_area_sf", "Commerce A"], ["rent_psf_annual", "Commerce A"], ["item_occupancy_pct", "Commerce A"]]);
    expect(r[1]!.value).toBeCloseTo(1_291.67, 1);
    expect(r[2]!.value).toBe(26.01);
    expect(r[2]!.unitSeen).toContain("m2");
  });
  test("a monthly rent per area is refused, never multiplied", () => {
    for (const d of [tableDoc([["Rent per square foot", "$2.10/sf/month"]]), linesDoc(["Rent per square foot: $2.10/sf/month"])]) {
      const r = extractCandidates(d);
      expect(r.candidates).toEqual([]);
      expect(r.other.length).toBe(1);
    }
  });
});

describe("a row may write its value before its label", () => {
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const wordDoc = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"AB"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const sheet = async (rows: [number | string, string, string?][], valueFirst = true): Promise<NormalizedDocument> => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Inputs");
    rows.forEach(([value, label, fmt], i) => {
      const v = ws.getCell(i + 1, valueFirst ? 1 : 2);
      v.value = value;
      if (fmt) v.numFmt = fmt;
      ws.getCell(i + 1, valueFirst ? 2 : 1).value = label;
    });
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "inputs.xlsx");
  };
  const pick = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value]);
  const ROWS: [number | string, string, string?][] = [
    [480_000, "Land cost"],
    [0.0725, "Senior loan interest rate", "0.00%"],
    ["850k", "Senior loan amount"],
    ["18 months", "Construction period"],
    ["30 years", "Amortization"],
    ["93%", "Stabilized occupancy"],
    ["5.5%", "Exit cap rate"],
    [3_100_000, "Hard costs"],
  ];
  const READ = [
    ["land_cost", 480_000],
    ["senior_rate_pct", 7.25],
    ["senior_loan_amount", 850_000],
    ["construction_months", 18],
    ["senior_amort_years", 30],
    ["stabilized_occupancy_pct", 93],
    ["exit_cap_rate_pct", 5.5],
    ["hard_cost", 3_100_000],
  ];

  test("an xlsx sheet with the value first reads every row, as the label-first sheet does", async () => {
    expect(pick(await sheet(ROWS))).toEqual(READ);
    expect(pick(await sheet(ROWS, false))).toEqual(READ);
  });
  test("a Word table reads a value-first row, in English and in French", () => {
    expect(pick(wordDoc(ROWS.map(([v, l]) => [typeof v === "number" && v < 1 ? "7.25%" : String(v), l])))).toEqual(READ);
    expect(pick(wordDoc([["1,2 M$", "Prêt de premier rang"], ["5,4 %", "Taux d'intérêt"], ["480 000 $", "Coût du terrain"]]))).toEqual([
      ["senior_loan_amount", 1_200_000],
      ["senior_rate_pct", 5.4],
      ["land_cost", 480_000],
    ]);
  });
  test("negative: two value-first rows in a label-first sheet are not a value-first section", () => {
    const odd = wordDoc([["Land cost", "480000"], ["Hard costs", "3100000"], ["Senior loan interest rate", "7.25%"], ["850k", "Senior loan amount"], ["93%", "Stabilized occupancy"]]);
    expect(pick(odd)).toEqual([["land_cost", 480_000], ["hard_cost", 3_100_000], ["senior_rate_pct", 7.25]]);
  });
  test("negative: a year in the value column reads nothing", () => {
    const d = wordDoc([["2026", "Budget year"], ["480000", "Land cost"], ["7.25%", "Senior loan interest rate"]]);
    expect(pick(d)).toEqual([["land_cost", 480_000], ["senior_rate_pct", 7.25]]);
    const r = extractCandidates(d);
    expect(r.other.some((o) => o.value === 2026 || o.raw.includes("2026"))).toBe(false);
  });
  test("negative: a bracketed amount that is not a credit is treated as it is label-first", () => {
    const first = extractCandidates(wordDoc([["480000", "Land cost"], ["7.25%", "Senior loan interest rate"], ["(4,000)", "Deposit already paid"]]));
    const last = extractCandidates(wordDoc([["Land cost", "480000"], ["Senior loan interest rate", "7.25%"], ["Deposit already paid", "(4,000)"]]));
    expect(first.candidates.map((c) => c.fieldKey)).toEqual(["land_cost", "senior_rate_pct"]);
    expect(last.other.length).toBe(1);
    expect(first.other.map((o) => [o.value, o.fieldKey, o.note])).toEqual(last.other.map((o) => [o.value, o.fieldKey, o.note]));
  });
  test("a value written as text is never the label, in a label-first row too", () => {
    expect(pick(wordDoc([["Senior loan amount", "850k"], ["Land cost", "480000"]]))).toEqual([["senior_loan_amount", 850_000], ["land_cost", 480_000]]);
    expect(pick(wordDoc([["850k", "7.25%"]]))).toEqual([]);
  });
});

describe("one sentence may state several terms of one loan", () => {
  const doc = (lines: string[]): NormalizedDocument => ({
    kind: "docx",
    lines: lines.map((text, i) => ({ text, location: `L${i + 1}` })),
    tables: [],
    pageCount: null,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const read = (...lines: string[]) => extractCandidates(doc(lines));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const SENIOR = ["Senior loan amount: $5,000,000", "Senior interest rate: 6.2%", "Amortization: 30 years"];
  const SENIOR_READ = [["senior_loan_amount", 5_000_000], ["senior_rate_pct", 6.2], ["senior_amort_years", 30]];

  test("a mezzanine sentence gives its amount, rate, amortization and interest-only months to the mezzanine loan", () => {
    const r = read(...SENIOR, "A junior lender will advance $240,000 at 11.5% fixed, amortized over 15 years, interest-only for the first 12 months.");
    expect(pick(r)).toEqual([...SENIOR_READ, ["mezz_loan_amount", 240_000], ["mezz_rate_pct", 11.5], ["mezz_amort_years", 15], ["mezz_io_months", 12]]);
  });
  test("a take-out sentence reads the same way, with no senior field and no conflict with the senior loan", () => {
    const r = read(...SENIOR, "The refinance lender commits $2,100,000 with a coupon of 5.1%, 30-year amortization and 6 months IO.");
    expect(pick(r)).toEqual([...SENIOR_READ, ["refinance_amount", 2_100_000], ["refinance_rate_pct", 5.1], ["refinance_amort_years", 30], ["refinance_io_months", 6]]);
    const senior = r.candidates.filter((c) => c.fieldKey!.startsWith("senior_"));
    expect(new Set(senior.map((c) => c.fieldKey)).size).toBe(senior.length);
  });
  test("a French sentence names the loan once and carries it", () => {
    const r = read("Prêt de premier rang : 5 000 000 $", "Taux d'intérêt : 6,2 %", "Le prêteur de deuxième rang consent 300 000 $, au taux de 9 %, amorti sur 20 ans, intérêts seulement pendant 6 mois.");
    expect(pick(r)).toEqual([["senior_loan_amount", 5_000_000], ["senior_rate_pct", 6.2], ["mezz_loan_amount", 300_000], ["mezz_rate_pct", 9], ["mezz_amort_years", 20], ["mezz_io_months", 6]]);
  });
  test("a loan named only in a condition does not take the sentence's terms (audit)", () => {
    const r = read("Should the second mortgage fall away, the bank amortizes its loan over 28 years.", "Si le prêt de deuxième rang n'est pas accordé, nous amortissons sur 28 ans.");
    expect(r.candidates.filter((c) => c.fieldKey?.startsWith("mezz_") || c.fieldKey?.startsWith("refinance_"))).toEqual([]);
  });
  test("each sentence of a paragraph keeps its own loan", () => {
    const r = read("The first mortgage is $5,000,000 at an interest rate of 6.2%.", "The mezzanine lender will advance $800,000 at 12%, amortized over 10 years.");
    expect(pick(r)).toEqual([["senior_loan_amount", 5_000_000], ["senior_rate_pct", 6.2], ["mezz_loan_amount", 800_000], ["mezz_rate_pct", 12], ["mezz_amort_years", 10]]);
  });
  test("a clause that names another loan ends the carry", () => {
    const r = read("The mezzanine lender will advance $240,000 at 11.5%, while the first mortgage stays at 6.2%.");
    expect(pick(r)).toEqual([["mezz_loan_amount", 240_000], ["mezz_rate_pct", 11.5], ["senior_rate_pct", 6.2]]);
  });
  test("negative: a fee and a term in a scoped sentence are still refused", () => {
    const r = read("The mezzanine lender will advance $240,000 at 11.5%, with a 1% arrangement fee and a 24-month term.");
    expect(pick(r)).toEqual([["mezz_loan_amount", 240_000], ["mezz_rate_pct", 11.5]]);
    expect(r.other.map((o) => o.value).sort()).toEqual([1, 24]);
    const ltv = read("The mezzanine lender will advance $240,000 at 11.5%, to a maximum of 75% LTV.");
    expect(pick(ltv)).toEqual([["mezz_loan_amount", 240_000], ["mezz_rate_pct", 11.5]]);
    expect(ltv.other.map((o) => o.value)).toEqual([75]);
  });
  test("negative: a sentence that names no loan's rank reads as it did; a first mortgage is ranked (card 108)", () => {
    expect(pick(read("The lender will advance $240,000 at 11.5% fixed, amortized over 15 years."))).toEqual([]);
    expect(pick(read("The first mortgage will advance $5,000,000 at 6.2%, amortized over 30 years."))).toEqual([["senior_loan_amount", 5_000_000], ["senior_amort_years", 30]]);
  });
});

describe("durations: a unit given by the label, number words, quarters, phases", () => {
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const table = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"ABC"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const prose = (...lines: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const pick = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value]);
  const sheet = async (rows: [string | number, string][], valueFirst: boolean): Promise<NormalizedDocument> => {
    const ExcelJS = (await import("exceljs")).default;
    const ws = new ExcelJS.Workbook().addWorksheet("Inputs");
    rows.forEach(([v, l], i) => {
      ws.getCell(i + 1, valueFirst ? 1 : 2).value = v;
      ws.getCell(i + 1, valueFirst ? 2 : 1).value = l;
    });
    const wb = ws.workbook;
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "inputs.xlsx");
  };
  const ROWS: [number, string][] = [
    [20, "Build period, months"],
    [30, "Amortization (yrs)"],
    [7, "Lease-up months"],
    [14, "Durée des travaux (mois)"],
    [25, "Amortissement, ans"],
  ];

  test("the label names the unit and the cell holds a bare count (label/value sheet and value-first sheet)", async () => {
    const want = [["construction_months", 20], ["senior_amort_years", 30], ["lease_up_months", 7], ["construction_months", 14], ["senior_amort_years", 25]];
    // the same field twice would conflict in a real deal; here each row is read on its own
    for (const valueFirst of [false, true]) {
      const got = pick(await sheet(ROWS, valueFirst));
      expect(got).toEqual(want);
    }
  });
  test("a Word table and an English 'in months' label read the same way", () => {
    expect(pick(table([["Construction period, mo", "18"], ["Amortization period in years", "35"]]))).toEqual([["construction_months", 18], ["senior_amort_years", 35]]);
  });
  test("negative: a label with a unit word does not turn a count or a percentage into a duration", () => {
    expect(pick(table([["Units (count)", "12"]]))).toEqual([["unit_count", 12]]);
    const r = extractCandidates(table([["Amortization (yrs)", "4.5%"]]));
    expect(r.candidates).toEqual([]);
    expect(r.other.map((o) => o.value)).toEqual([4.5]);
    expect(pick(table([["Land cost, years", "480000"]]))).toEqual([["land_cost", 480_000]]);
  });

  test("number words and quarters in a cell", () => {
    expect(pick(table([["Construction period", "nineteen months"]]))).toEqual([["construction_months", 19]]);
    expect(pick(table([["Construction period", "dix-neuf mois"]]))).toEqual([["construction_months", 19]]);
    expect(pick(table([["Lease-up period", "two quarters"]]))).toEqual([["lease_up_months", 6]]);
    expect(pick(table([["Période de location", "deux trimestres"]]))).toEqual([["lease_up_months", 6]]);
    expect(pick(table([["Amortization", "a year"]]))).toEqual([["senior_amort_years", 1]]);
  });
  test("a year and a half, and quarters, in prose", () => {
    expect(pick(prose("Construction should take a year and a half."))).toEqual([["construction_months", 18]]);
    expect(pick(prose("La construction durera un an et demi."))).toEqual([["construction_months", 18]]);
    const r = extractCandidates(prose("Construction will take five quarters."));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["construction_months", 15]]);
    expect(r.candidates[0]!.unitSeen).toContain("quarters");
    expect(r.candidates[0]!.unitSeen).toContain("3");
    expect(r.candidates[0]!.raw).toContain("five quarters");
    expect(pick(prose("Lease-up: 3 quarters"))).toEqual([["lease_up_months", 9]]);
  });
  test("a duration in words is read like one in digits (task 51)", () => {
    const r = extractCandidates(prose("A seven-year hold is planned.", "Durée des travaux : dix-huit mois.", "Amortization of thirty-five years."));
    expect(r.candidates.map((c) => [c.fieldKey, c.value, c.raw])).toEqual([["hold_years", 7, "seven-year"], ["construction_months", 18, "dix-huit mois"], ["senior_amort_years", 35, "thirty-five years"]]);
    // the same rules as digits: a loan's term is refused
    const term = extractCandidates(prose("The loan has a three-year term."));
    expect(term.candidates).toEqual([]);
    expect(term.other.map((o) => [o.value, o.note])).toEqual([[3, "A loan's term, not the build period, hold or amortization"]]);
    // digits win: one figure, the digits
    const both = extractCandidates(prose("Construction will take twelve (12) months."));
    expect(both.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["construction_months", 12]]);
    expect(both.other).toEqual([]);
    // no duration unit after the number word: still text
    expect(extractCandidates(prose("We own eight rentals and two lots.")).other).toEqual([]);
  });
  test("negative: a fraction, dates and a vague span are never a duration", () => {
    expect(pick(prose("Construction is three quarters complete."))).toEqual([]);
    expect(pick(prose("Construction start March 2026, finish June 2027."))).toEqual([]);
    expect(pick(table([["Construction start", "March 2026"], ["Construction finish", "June 2027"]]))).toEqual([]);
    expect(pick(prose("Rent is collected once a year."))).toEqual([]);
  });

  test("the interest-only period named by the phase it covers, with a months figure", () => {
    expect(pick(prose("Interest only while we build and lease: 20 months."))).toEqual([["senior_io_months", 20]]);
    expect(pick(prose("Intérêts seulement pendant les travaux : 14 mois"))).toEqual([["senior_io_months", 14]]);
    expect(pick(table([["Interest only during construction and lease-up", "22 months"]]))).toEqual([["senior_io_months", 22]]);
  });
  test("negative: no months figure, no interest-only period, and none derived from the build period", () => {
    expect(pick(prose("Construction: 16 months", "Interest only while we build."))).toEqual([["construction_months", 16]]);
    expect(pick(prose("Construction: 16 months", "Intérêts seulement pendant les travaux."))).toEqual([["construction_months", 16]]);
  });
});

describe("label families: the same meaning in several wordings, English and Québec French", () => {
  const cell = (text: string, ref: string): Cell => ({ text, ref });
  const table = (rows: string[][]): NormalizedDocument => ({
    kind: "docx",
    lines: [],
    tables: [{ name: "Table 1", rows: rows.map((r, i) => r.map((t, c) => cell(t, `${"ABC"[c]}${i + 1}`))) }],
    pageCount: null,
    needsOcr: false,
    fullText: rows.map((r) => r.join(" ")).join("\n"),
  });
  const prose = (...lines: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const pick = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.value]);
  // One label/value row on its own: what the label means.
  const lv = (label: string, value: string) => pick(table([[label, value]]));
  const same = (rows: [string, string][], want: [string, number]) => {
    for (const [label, value] of rows) expect(lv(label, value), label).toEqual([want]);
  };
  const none = (rows: [string, string][]) => {
    for (const [label, value] of rows) expect(lv(label, value), label).toEqual([]);
  };
  const budget = (...rows: [string, string][]) => pick(table([["Item", "Amount"], ...rows]));

  test("1. the operating expense ratio, written as a share", () => {
    same([["Operating expense share of EGI", "38%"], ["Operating expenses share of revenue", "38%"], ["Expenses as a share of income", "38%"], ["Ratio des charges", "38 %"], ["Charges en % des revenus", "38 %"]], ["expense_ratio_pct", 38]);
  });
  test("1. negative: variable expenses keep the variable-expense field", () => {
    same([["Variable expenses as a share of EGI", "4%"], ["Charges variables en % des revenus", "4 %"]], ["variable_expense_pct", 4]);
  });

  test("2. the senior amount, named by adjectives", () => {
    same(
      [["Senior amount", "$5,000,000"], ["Committed senior funding", "$5,000,000"], ["First-ranking committed", "$5,000,000"], ["Premier rang engagé", "5 000 000 $"], ["Financement de premier rang", "5 000 000 $"], ["Sponsor-reported senior amount", "$5,000,000"], ["Senior amount as reported by the owner", "$5,000,000"]],
      ["senior_loan_amount", 5_000_000],
    );
  });
  test("2. negative: a ceiling or a fee on the senior funding is not the amount", () => {
    none([["Maximum senior amount", "$5,000,000"], ["Senior funding fee", "$50,000"], ["Frais de financement de premier rang", "50 000 $"]]);
  });

  test("3. a Québec 'reprise' is the take-out", () => {
    same([["Prêt de reprise", "2 000 000 $"]], ["refinance_amount", 2_000_000]);
    same([["Reprise : mois", "30"]], ["refinance_month", 30]);
    same([["Taux de reprise", "5,2 %"]], ["refinance_rate_pct", 5.2]);
    same([["Amortissement de reprise", "30 ans"]], ["refinance_amort_years", 30]);
  });
  test("3. negative: 'reprise des travaux' is work resuming, not a loan", () => {
    same([["Reprise des travaux", "30 mois"]], ["construction_months", 30]);
    expect(pick(prose("La reprise des travaux est prévue dans 6 mois."))).not.toContainEqual(["refinance_month", 6]);
  });

  test("4. professional and consultant fees in a cost budget are soft costs", () => {
    expect(budget(["Land", "$900,000"], ["Consultant fees", "$120,000"])).toEqual([["land_cost", 900_000], ["soft_cost", 120_000]]);
    expect(budget(["Land", "900 000 $"], ["Honoraires du projet", "50 000 $"])).toEqual([["land_cost", 900_000], ["soft_cost", 50_000]]);
    expect(budget(["Land", "900 000 $"], ["Honoraires professionnels", "80 000 $"])).toEqual([["land_cost", 900_000], ["soft_cost", 80_000]]);
  });
  test("4. negative: a lender's fee keeps the fee refusal, in a budget and in loan terms", () => {
    expect(budget(["Land", "900 000 $"], ["Honoraires de dossier", "25 000 $"])).toEqual([["land_cost", 900_000]]);
    none([["Honoraires de dossier", "25 000 $"], ["Commitment fee", "$50,000"], ["Frais de prêt", "25 000 $"]]);
  });

  test("5. a French credit that says it reduces cost is a negative other cost", () => {
    const r = extractCandidates(table([["Subvention nette qui réduit les coûts", "-90 000 $"]]));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["other_cost", -90_000]]);
    expect(r.candidates[0]!.note).toContain("credit");
    same([["Aide financière déduite", "-90 000 $"], ["Crédit appliqué aux coûts", "-90 000 $"]], ["other_cost", -90_000]);
  });
  test("5. negative: a grant or aid with no word about reducing cost is not a credit", () => {
    none([["Subvention", "-90 000 $"], ["Aide financière", "-90 000 $"], ["Aide financière déduite", "90 000 $"]]);
  });

  test("6. the lease-up period", () => {
    same([["Période de mise en location", "9 mois"], ["Months allowed for leasing", "9"], ["Time to lease up", "9 months"], ["Time to lease", "9 months"]], ["lease_up_months", 9]);
    expect(lv("Location initiale (mois)", "8")).toEqual([["lease_up_months", 8]]);
    same([["Leasing after completion", "6 months"], ["Leasing after handover", "6 months"]], ["lease_up_months", 6]);
  });
  test("6. negative: a money figure or an unrelated 'location' is not the lease-up", () => {
    none([["Location initiale", "7 000 $"], ["Location du terrain", "9 mois"]]);
  });

  test("7. fixed operating costs", () => {
    same([["Charges annuelles fixes", "96 000 $"], ["Fixed annual operating costs", "$96,000"], ["Fixed annual operating cost", "$96,000"], ["Fixed operations", "$96,000"], ["Frais fixes d'exploitation", "96 000 $"]], ["fixed_opex_annual", 96_000]);
  });
  test("7. negative: a fixed price is the contract, and variable charges are the share", () => {
    same([["Fixed price contract", "$3,400,000"]], ["hard_cost", 3_400_000]);
    same([["Charges variables", "4 %"]], ["variable_expense_pct", 4]);
  });

  test("8. the exit capitalization rate", () => {
    same([["Taux de capitalisation de sortie", "5,5 %"], ["Capitalisation de sortie", "5,5 %"], ["For exit capitalization", "5.5%"], ["Exit capitalization rate", "5.5%"], ["Exit capitalization assumption", "5.5%"], ["Cap at sale", "5.5%"]], ["exit_cap_rate_pct", 5.5]);
  });
  test("8. negative: a going-in cap rate is not the exit rate", () => {
    none([["Going-in capitalization rate", "5.5%"], ["Taux de capitalisation", "5,5 %"], ["Cap rate at closing", "5.5%"]]);
  });

  test("9. rent and expense growth", () => {
    same([["Rent escalation", "3%"], ["Rent increases (per year)", "3%"], ["Annual rent increase", "3%"], ["Croissance annuelle des loyers", "3 %"], ["Indexation des loyers", "3 %"]], ["rent_growth_pct", 3]);
    same([["Expense escalation", "2.5%"], ["Cost inflation on opex", "2.5%"], ["Croissance annuelle des charges", "2,5 %"], ["Croissance des charges d'exploitation", "2,5 %"]], ["expense_growth_pct", 2.5]);
  });
  test("9. negative: a limit or a dollar increase is not a growth rate", () => {
    none([["Maximum rent increases", "3%"], ["Rent increase", "$50"], ["Hausse maximale des loyers", "3 %"]]);
    expect(pick(prose("Rent increases are capped at 3% by the province."))).toEqual([]);
  });

  test("10. selling costs", () => {
    same([["Selling cost assumption", "3%"], ["Selling cost allowance", "3%"], ["Disposition costs", "3%"], ["Frais de vente", "3 %"], ["Frais de disposition", "3 %"]], ["selling_costs_pct", 3]);
  });
  test("10. negative: a selling price is not a cost", () => {
    none([["Selling price", "$9,000,000"], ["Prix de vente", "9 000 000 $"]]);
  });

  test("11. other income", () => {
    same([["Parking income", "$24,000"], ["Parking and storage income", "$24,000"], ["Parking and locker income", "$24,000"], ["Ancillary income", "$24,000"], ["Revenus accessoires", "24 000 $"], ["Revenus de stationnement", "24 000 $"]], ["other_income_annual", 24_000]);
  });
  test("11. negative: a count of stalls is not income", () => {
    none([["Parking stalls", "12"], ["Places de stationnement", "12"]]);
  });

  test("12. the land", () => {
    same([["Acquisition total", "$900,000"], ["Land and acquisition", "$900,000"], ["Coût d'acquisition du terrain", "900 000 $"], ["Coût d'acquisition", "900 000 $"]], ["land_cost", 900_000]);
  });
  test("12. negative: an acquisition fee is not the land", () => {
    none([["Acquisition fee", "$25,000"], ["Frais d'acquisition", "25 000 $"]]);
  });

  test("13. the LPs' share, written as a verb", () => {
    for (const s of ["The LP supplies 90% of the equity.", "LP provides 90% of equity.", "The LPs fund 90% of the equity.", "Limited partners supply 90% of the equity.", "Les commanditaires apportent 90 % des fonds propres."]) {
      expect(pick(prose(s)), s).toEqual([["lp_share_pct", 90]]);
    }
  });
  test("13. negative: a dollar amount, or the sponsor's share, is not the LP share", () => {
    expect(pick(prose("The LP funds $2,000,000 of the equity."))).not.toContainEqual(["lp_share_pct", 2_000_000]);
    expect(pick(prose("The LP funds 90% of the equity."))).not.toContainEqual(["equity_amount", 90]);
    expect(pick(prose("The sponsor funds 10% of the equity."))).toEqual([]);
  });

  test("14. the singular 'other cost', in either case", () => {
    expect(budget(["Land", "$900,000"], ["Other cost", "$90,000"])).toEqual([["land_cost", 900_000], ["other_cost", 90_000]]);
    same([["Other cost", "$90,000"], ["other cost", "$90,000"], ["Autre coût", "90 000 $"]], ["other_cost", 90_000]);
  });
  test("14. negative: 'other' alone is not a cost outside a budget", () => {
    none([["Other", "$90,000"]]);
  });

  test("15. a loan sized on the lender's valuation is the refinance loan-to-value, not an output", () => {
    expect(pick(prose("Take-out loan terms", "The loan is sized at 65% of the lender's valuation."))).toEqual([["refinance_ltv_pct", 65]]);
    expect(pick(prose("Prêt de reprise", "Dimensionné à 65 % de la valeur établie par le prêteur."))).toEqual([["refinance_ltv_pct", 65]]);
    expect(pick(prose("Refinance terms", "Sized at 65% of appraised value."))).toEqual([["refinance_ltv_pct", 65]]);
  });
  test("15. negative: a stated valuation, and a senior loan, are not read", () => {
    expect(pick(prose("Take-out loan terms", "The lender's valuation is $9,000,000."))).toEqual([]);
    expect(pick(prose("Take-out loan terms", "The property is valued at $9,000,000 by the lender."))).toEqual([]);
    expect(pick(prose("Take-out loan terms", "Sized at 65% of the lender's valuation of $9,000,000."))).toEqual([]);
    expect(pick(prose("Senior loan terms", "Sized at 65% of the lender's valuation."))).toEqual([]);
  });
  test("negative: a 'remise en état' is not a credit", () => {
    none([["Remise en état", "-50 000 $"]]);
  });
});

describe("budget lines and operating figures written as sentences with verbs", () => {
  test("words that run on into the next figure name that figure, not the one before (v8 audit)", () => {
    expect(pick("The planner expects lease-up done at 95% with the opex share 32% of EGI.")).not.toContainEqual(["expense_ratio_pct", 95]);
    expect(pick("Partner split: LP share 85% / pref. return 7% / promote 25%.")).not.toContainEqual(["preferred_return_pct", 85]);
    expect(pick("Exit loan: amortization 30 / exit loan IO months 6.")).not.toContainEqual(["refinance_io_months", 30]);
    expect(pick("We assume a sale after a seven-year hold at a 5.00% capitalization rate.")).toContainEqual(["hold_years", 7]);
  });
  test("a sheet or banner for a scenario other than the base case is not read (v8 audit)", () => {
    const rows = (name: string, banner: string) => ({ name, rows: [[{ text: banner, ref: "A1" }], [{ text: "Stabilized occupancy", ref: "A2" }, { text: "88%", ref: "B2", number: 88, unit: "%" }]] });
    for (const [name, banner] of [["Bank case", "Shown for the bank"], ["Summary", "NOT THE BASE CASE"], ["Scénario du prêteur", "Hypothèses"], ["Occupancy", "occupancy illustration"]] as const) {
      const r = extractCandidates({ kind: "xlsx", lines: [], tables: [rows(name, banner)], pageCount: null, needsOcr: false, fullText: "" } as never);
      expect(r.candidates.filter((c) => c.fieldKey === "stabilized_occupancy_pct"), `${name} / ${banner}`).toEqual([]);
    }
    const base = extractCandidates({ kind: "xlsx", lines: [], tables: [rows("Base case", "Our base case")], pageCount: null, needsOcr: false, fullText: "" } as never);
    expect(base.candidates.filter((c) => c.fieldKey === "stabilized_occupancy_pct").map((c) => c.value)).toEqual([88]);
  });
  test("unit types as columns under two title rows (audit)", () => {
    const table = { name: "Mix", rows: [
      [{ text: "Illustrative only", ref: "A1" }],
      [{ text: "Programme", ref: "A2" }, { text: "Programme", ref: "B2" }, { text: "Programme", ref: "C2" }],
      [{ text: "Measure", ref: "A3" }, { text: "1-bed", ref: "B3" }, { text: "2-bed", ref: "C3" }],
      [{ text: "Homes", ref: "A4" }, { text: "6", ref: "B4", number: 6 }, { text: "4", ref: "C4", number: 4 }],
      [{ text: "Monthly rent per home", ref: "A5" }, { text: "1900", ref: "B5", number: 1900 }, { text: "2300", ref: "C5", number: 2300 }],
    ] };
    const r = extractCandidates({ kind: "xlsx", lines: [], tables: [table], pageCount: null, needsOcr: false, fullText: "" } as never);
    expect(r.candidates.filter((c) => c.fieldKey === "unit_count").map((c) => [c.itemKey, c.value])).toEqual([["1BR", 6], ["2BR", 4]]);
    expect(r.candidates.filter((c) => c.fieldKey === "unit_rent_monthly").map((c) => [c.itemKey, c.value])).toEqual([["1BR", 1900], ["2BR", 2300]]);
  });
  test("a rent at today's market is not the existing building (audit)", () => {
    expect(pick("2-bed rent: $2,100 per month at current market.")).toContainEqual(["unit_rent_monthly", 2_100]);
    expect(pick("Loyer 4½ : 1 650 $ par mois, selon le marché actuel")).toContainEqual(["unit_rent_monthly", 1_650]);
    expect(pick("Present rent on the house: $1,500 per month")).not.toContainEqual(["unit_rent_monthly", 1_500]);
  });
  test("a total that includes the deposit is the total (audit)", () => {
    expect(pick("Land cost $900,000 including deposit")).toEqual([["land_cost", 900_000]]);
    expect(pick("Prix du terrain 900 000 $ y compris l'acompte")).toEqual([["land_cost", 900_000]]);
    expect(pick("We put down $50,000 on the lot.")).toEqual([]);
  });
  const prose = (...lines: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const pick = (...lines: string[]) => extractCandidates(prose(...lines)).candidates.map((c) => [c.fieldKey, c.value]);
  const same = (rows: string[], want: [string, number]) => {
    for (const s of rows) expect(pick(s), s).toEqual([want]);
  };

  test("land: a verb of buying and the land, building or site it buys", () => {
    same(["We will pay $910,000 to buy the lot.", "We will pay $910,000 to acquire the property."], ["land_cost", 910_000]);
    expect(pick("The partnership will purchase the site for $910,000.")).toEqual([["land_cost", 910_000]]);
    expect(pick("We will pay $4,200,000 to acquire the building.")).toEqual([["land_cost", 4_200_000]]);
    expect(pick("Le propriétaire paiera 700 000 $ pour acquérir le terrain.")).toEqual([["land_cost", 700_000]]);
    expect(pick("La société achètera l'immeuble pour 4 200 000 $.")).toEqual([["land_cost", 4_200_000]]);
  });
  test("hard: the contractor does the work for a sum", () => {
    same(["Our contractor will do the work for $3,400,000.", "The builder will carry out the construction for $3,400,000.", "L'entrepreneur réalisera les travaux pour 3 400 000 $."], ["hard_cost", 3_400_000]);
  });
  test("soft: the design team, advisers or consultants for their services", () => {
    same(["The design team needs $380,000 for its services.", "The consultants charge $380,000 for their fees.", "Les conseillers demandent 380 000 $ pour leurs services."], ["soft_cost", 380_000]);
  });
  test("contingency and other costs, two lines in one sentence", () => {
    expect(pick("We hold back $150,000 for contingency and set aside $90,000 for other costs.")).toEqual([["contingency", 150_000], ["other_cost", 90_000]]);
    expect(pick("We keep $150,000 for contingency.")).toEqual([["contingency", 150_000]]);
    expect(pick("We set aside $90,000 for other project costs.")).toEqual([["other_cost", 90_000]]);
    expect(pick("On met de côté 90 000 $ pour les autres coûts du projet.")).toEqual([["other_cost", 90_000]]);
  });
  test("fixed operating costs: a yearly sum for the fixed costs", () => {
    same(["Property management needs $96,000 a year for fixed costs.", "We budget $96,000 annually for fixed operations."], ["fixed_opex_annual", 96_000]);
  });
  test("negative: a verb alone, another project, a deposit, a monthly or undated sum", () => {
    expect(pick("We paid $25,000 deposit.")).toEqual([]);
    expect(pick("The builder quoted $3.4M for another project.")).toEqual([]);
    expect(pick("Our contractor will do the work on another project for $3,400,000.")).toEqual([]);
    expect(pick("We will pay $20,000 for the site visit.")).toEqual([]);
    expect(pick("The design team needs $380,000 for another property.")).toEqual([]);
    expect(pick("Property management needs $8,000 a month for fixed costs.")).toEqual([]);
    expect(pick("Property management needs $96,000 for fixed costs.")).toEqual([]);
    expect(pick("The contractor will do the work for 18 months.")).not.toContainEqual(["hard_cost", 18]);
  });

  test("a revised price supersedes the original, in a sentence", () => {
    const r = extractCandidates(prose("The original contract price was $3,400,000.", "The revised signed price is $3,650,000."));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["hard_cost", 3_650_000]]);
    expect(r.other.find((o) => o.value === 3_400_000)?.note).toMatch(/earlier|superseded|replaced/i);
    expect(pick("The contractor originally priced the work at $3,400,000.", "The revised signed price is $3,650,000.")).toEqual([["hard_cost", 3_650_000]]);
  });
  test("a former building's cost is not an old figure, and a cost capped by its contract is the cost (audit)", () => {
    expect(pick("Former church acquisition cost: $1,200,000")).toEqual([["land_cost", 1_200_000]]);
    expect(pick("Hard costs are capped at $3,200,000 under the fixed-price contract.")).toEqual([["hard_cost", 3_200_000]]);
    expect(pick("The construction loan is capped at $5,000,000.")).toEqual([]);
  });
  test("a French revision pair: the old total is superseded and a dollar amount, never a duration", () => {
    const r = extractCandidates(prose("Ancien total travaux : 1 850 000 $", "Nouveau total travaux : 1 950 000 $"));
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["hard_cost", 1_950_000]]);
    const old = r.other.find((o) => o.value === 1_850_000)!;
    expect(old.note).not.toMatch(/period|months/i);
    expect(old.note).toMatch(/earlier|superseded|replaced|old/i);
    expect(extractCandidates(prose("Ancien total travaux : 1 850 000 $")).candidates).toEqual([]);
  });
  test("negative: a figure with no revision word in its label is read as before", () => {
    expect(pick("The contract price is $3,400,000.")).toEqual([["hard_cost", 3_400_000]]);
    expect(pick("The oldest building is a loft.", "Land cost: $900,000")).toEqual([["land_cost", 900_000]]);
  });

  test("prose flags, in both directions, only when stated outright", () => {
    const flag = (s: string) => pick(s).filter((c) => String(c[0]).match(/ramp|s_curve/));
    expect(flag("Rent is credited during lease-up.")).toEqual([["lease_up_ramp", 1]]);
    expect(flag("We count income while leasing.")).toEqual([["lease_up_ramp", 1]]);
    expect(flag("No income until stabilization.")).toEqual([["lease_up_ramp", 0]]);
    expect(flag("Aucun revenu avant la stabilisation.")).toEqual([["lease_up_ramp", 0]]);
    expect(flag("Draws follow an S-curve.")).toEqual([["s_curve_draws", 1]]);
    expect(flag("Tirages en courbe en S.")).toEqual([["s_curve_draws", 1]]);
    expect(flag("Straight-line draws.")).toEqual([["s_curve_draws", 0]]);
    expect(flag("Les tirages sont linéaires.")).toEqual([["s_curve_draws", 0]]);
  });
  test("negative: a hedge, a negation or a passing mention is no flag", () => {
    for (const s of ["Draws may follow an S-curve if the lender agrees.", "Draws do not follow an S-curve.", "Rent is not credited during lease-up.", "We discussed income during lease-up.", "Is rent credited during lease-up?", "The S-curve spreadsheet is attached.", "No income until stabilization is a lender request we may refuse."]) {
      expect(pick(s).filter((c) => String(c[0]).match(/ramp|s_curve/)), s).toEqual([]);
    }
  });
});


describe("struck figures in a PDF, per-door shares of a cost, and deposits (task 45)", () => {
  const prose = (...lines: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const pick = (...lines: string[]) => extractCandidates(prose(...lines)).candidates.map((c) => [c.fieldKey, c.value]);
  const PER_DOOR = /per-door share of a cost, not the line's total; enter the total/;

  /** A one-page PDF whose content stream is `content`, in Helvetica 12 (xref written by hand). */
  function pdf(content: string): Uint8Array {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const at: number[] = [];
    objs.forEach((o, i) => {
      at.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new TextEncoder().encode(out);
  }
  // "Land cost" at x 72, the struck figure at x 200 and the second figure at x 300, one text item each; a line is drawn at height `y`.
  const struckPdf = (y: number) => pdf(`BT /F1 12 Tf 72 700 Td (Land cost) Tj ET\nBT /F1 12 Tf 200 700 Td ($900,000) Tj ET\nBT /F1 12 Tf 300 700 Td ($950,000) Tj ET\n0.6 w 196 ${y} m 252 ${y} l S`);

  test("a PDF's strike-through line over a figure refuses that figure; an underline does not", async () => {
    const struck = extractCandidates(await parseDocument(struckPdf(704), "s.pdf"));
    expect(struck.candidates.map((c) => c.value)).not.toContain(900_000);
    expect(struck.other.find((o) => o.value === 900_000)?.note).toMatch(/struck through/i);
    const under = extractCandidates(await parseDocument(struckPdf(698), "u.pdf"));
    expect(under.candidates.map((c) => c.value)).toContain(900_000);
    // A line over only part of the figure hides nothing.
    const part = extractCandidates(await parseDocument(pdf(`BT /F1 12 Tf 72 700 Td (Land cost) Tj ET\nBT /F1 12 Tf 200 700 Td ($900,000) Tj ET\n0.6 w 196 704 m 215 704 l S`), "p.pdf"));
    expect(part.candidates.map((c) => c.value)).toContain(900_000);
  });

  test("per-door, per-lot and per-unit shares of a cost are refused, and a total in the same document still reads", () => {
    const refused = (s: string) => {
      const r = extractCandidates(prose(s));
      expect(r.candidates, s).toEqual([]);
      expect(r.other.some((o) => PER_DOOR.test(o.note ?? "")), s).toBe(true);
    };
    refused("Hard costs run about $260,000 a door.");
    refused("Hard costs: $260,000 per door.");
    refused("Hard cost per home: $260,000");
    refused("Land is $41,000 per lot.");
    refused("Land cost: $41,000 per lot");
    refused("Soft costs are $18,000 per suite.");
    refused("Soft costs: $18,000 per unit");
    refused("Les coûts de construction sont de 260 000 $ par logement.");
    refused("Coût du terrain : 41 000 $ par lot");
    refused("Honoraires professionnels : 18 000 $ par porte");
    expect(pick("Hard costs run about $260,000 a door.", "Hard costs: $3,120,000")).toEqual([["hard_cost", 3_120_000]]);
    expect(pick("Land is $41,000 per lot, $492,000 in total.")).toEqual([["land_cost", 492_000]]);
  });
  test("rent per unit, parking per stall and commercial rent per sf read as before", () => {
    expect(pick("Retail rent is $24 per sf.")).toEqual([["rent_psf_annual", 24]]);
    expect(pick("Monthly rent per unit: $1,450")).toEqual([["unit_rent_monthly", 1_450]]);
    expect(pick("Parking: $150 per stall")).toEqual([]);
  });
  test("three lots at a price each reads nothing for land and is never multiplied", () => {
    for (const s of ["Three lots at $300,000 each.", "Land: 3 lots at $300,000 each.", "The land is 3 lots at $300,000 each."]) {
      const r = extractCandidates(prose(s));
      expect(r.candidates.filter((c) => c.fieldKey === "land_cost"), s).toEqual([]);
      expect(r.candidates.map((c) => c.value), s).not.toContain(900_000);
    }
  });
  test("a deposit on the lot is not the land cost, and a full price in the same document is", () => {
    for (const s of ["We put down $100,000 on the lot.", "We paid a deposit of $100,000 on the land.", "The $100,000 down payment on the lot is already paid.", "Nous avons versé un acompte de 100 000 $ pour le terrain."]) {
      expect(pick(s).filter((c) => c[0] === "land_cost"), s).toEqual([]);
    }
    expect(pick("We put down $100,000 on the lot.", "The land costs $900,000.")).toEqual([["land_cost", 900_000]]);
    expect(pick("We will pay $900,000 to buy the lot, of which $100,000 is a deposit.")).toEqual([["land_cost", 900_000]]);
  });
});

describe("revenue layouts: income rows, unit types as columns, named types, suite rolls, as-is figures (task 46)", () => {
  const lines = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const grid = (...rows: string[][]): Table => ({ name: "Sheet", rows: rows.map((r, i) => r.map((text, j): Cell => ({ text, ref: `A${i + 1}:${j}` }))) });
  const withTables = (text: string[], ...tables: Table[]): NormalizedDocument => ({ ...lines(...text), kind: "docx", tables });
  /** Every revenue figure read, as "item|field" -> value. */
  const REVENUE = new Set(["unit_count", "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual"]);
  const items = (doc: NormalizedDocument) => Object.fromEntries(extractCandidates(doc).candidates.filter((c) => c.itemKey && REVENUE.has(c.fieldKey ?? "")).map((c) => [`${c.itemKey}|${c.fieldKey}`, c.value]));
  const itemKeys = (doc: NormalizedDocument) => [...new Set(extractCandidates(doc).candidates.filter((c) => c.itemKey).map((c) => c.itemKey))];
  const AS_IS = /existing building as it is today, not the new rental programme/;

  // Rule 1
  test("an income row in a unit table is the income field, never a unit type, and the real types still read", () => {
    const r = extractCandidates(withTables([], grid(["Type", "Units", "Monthly rent"], ["1-bed", "6", "$1,900"], ["Yearly storage income", "$3,600", ""], ["Parking", "12", "75"], ["Laundry income", "1", "400"], ["Total", "6", ""])));
    expect(r.candidates.filter((c) => c.itemKey).map((c) => [c.itemKey, c.fieldKey, c.value])).toEqual([["1BR", "unit_count", 6], ["1BR", "unit_rent_monthly", 1_900]]);
    // The storage row is the income field by its own label, not an item.
    expect(r.candidates.filter((c) => !c.itemKey).map((c) => [c.fieldKey, c.value])).toEqual([["other_income_annual", 3_600]]);
    expect(r.candidates.filter((c) => c.fieldKey === "unit_count").map((c) => c.value)).toEqual([6]);
  });
  test("a unit table's own types, including a commercial tenant row, are still items", () => {
    expect(items(withTables([], grid(["Type", "Units", "Monthly rent"], ["Studio", "4", "$1,400"], ["2-bed", "3", "$2,100"])))).toEqual({ "Studio|unit_count": 4, "Studio|unit_rent_monthly": 1_400, "2BR|unit_count": 3, "2BR|unit_rent_monthly": 2_100 });
  });

  // Rule 2
  test("unit types as columns: English and French, a yearly rent per home is divided by 12, and the type words are the existing vocabulary", () => {
    const en = extractCandidates(withTables([], grid(["Measure", "1-bed", "2-bed"], ["Homes", "6", "4"], ["Yearly rent per home", "$24,000", "$30,000"])));
    expect(items(withTables([], grid(["Measure", "1-bed", "2-bed"], ["Homes", "6", "4"], ["Yearly rent per home", "$24,000", "$30,000"])))).toEqual({ "1BR|unit_count": 6, "1BR|unit_rent_monthly": 2_000, "2BR|unit_count": 4, "2BR|unit_rent_monthly": 2_500 });
    expect(en.candidates.find((c) => c.fieldKey === "unit_rent_monthly")?.note).toMatch(/÷ 12/);
    const fr = items(withTables([], grid(["Mesure", "3½", "4½"], ["Logements", "10", "6"], ["Loyer mensuel par logement", "1 450 $", "1 900 $"])));
    expect(fr).toEqual({ "3½|unit_count": 10, "3½|unit_rent_monthly": 1_450, "4½|unit_count": 6, "4½|unit_rent_monthly": 1_900 });
    // A merged or repeated title above the header is fine.
    expect(items(withTables([], grid(["Unit mix", "Unit mix", "Unit mix"], ["Measure", "Studio", "1-bed"], ["Units", "2", "5"], ["Monthly rent per unit", "$1,300", "$1,750"])))).toEqual({ "Studio|unit_count": 2, "Studio|unit_rent_monthly": 1_300, "1BR|unit_count": 5, "1BR|unit_rent_monthly": 1_750 });
  });
  test("negative: a one-column table is unchanged, and a header of years is not unit types", () => {
    expect(Object.keys(items(withTables([], grid(["Measure", "1-bed"], ["Homes", "6"], ["Monthly rent per home", "$1,900"]))))).not.toContain("1BR|unit_count");
    expect(itemKeys(withTables([], grid(["Measure", "2027", "2028"], ["Homes", "6", "4"], ["Yearly rent per home", "$24,000", "$30,000"]))).filter((k) => k !== "All units")).toEqual([]);
  });

  // Rule 3
  test("a Type / attribute label names the item before the separator and the field after it", () => {
    expect(items(lines("Lane house / count: 2", "Lane house – monthly rent: $2,100"))).toEqual({ "Lane House|unit_count": 2, "Lane House|unit_rent_monthly": 2_100 });
    expect(items(withTables([], grid(["2", "Lane house / count"], ["$2,100", "Lane house – monthly rent"])))).toEqual({ "Lane House|unit_count": 2, "Lane House|unit_rent_monthly": 2_100 });
    expect(itemKeys(lines("Lane house / count: 2"))).toEqual(["Lane House"]);
  });
  test("negative: a slash inside a rate or an area label is not a type separator", () => {
    expect(itemKeys(lines("Rent / month: $2,100"))).toEqual([]);
    expect(itemKeys(lines("Hard cost / sf: $250"))).toEqual([]);
  });

  // Rule 4
  test("a named type with its count and rent in one line or row, in four forms", () => {
    const want = { "Orchard Row|unit_count": 3, "Orchard Row|unit_rent_monthly": 2_300 };
    expect(items(lines("Orchard row: 3 homes at $2,300 per home per month"))).toEqual(want);
    expect(items(lines("Orchard row | 3 homes | $2,300 per home per month"))).toEqual(want);
    expect(items(withTables([], grid(["Orchard row", "3 homes", "$2,300 per home per month"])))).toEqual(want);
    expect(items(withTables([], grid(["Mill flat", "5", "$1,950 / suite / month"])))).toEqual({ "Mill Flat|unit_count": 5, "Mill Flat|unit_rent_monthly": 1_950 });
    expect(items(lines("Mill flat | 5 | $1,950 / suite / month"))).toEqual({ "Mill Flat|unit_count": 5, "Mill Flat|unit_rent_monthly": 1_950 });
    expect(items(lines("Cottage: 4 logements à 1 800 $ par logement par mois"))).toEqual({ "Cottage|unit_count": 4, "Cottage|unit_rent_monthly": 1_800 });
    expect(items(lines("Gallery space 1,800 sf at $34 per sf"))).toEqual({ "Gallery Space|rentable_area_sf": 1_800, "Gallery Space|rent_psf_annual": 34 });
    expect(items(lines("Gallery space: 200 m² at $300 per m²"))).toMatchObject({ "Gallery Space|rentable_area_sf": 200 * SF_PER_M2 });
  });
  test("negative: a bare integer with no per-unit rent is no count, and a summary line naming a field is no item", () => {
    expect(items(lines("Mill flat | 5 | 840 sf"))).not.toHaveProperty("Mill Flat|unit_count");
    expect(items(withTables([], grid(["Mill flat", "5", "$1,950"])))).not.toHaveProperty("Mill Flat|unit_count");
    for (const s of ["Summary: 14 homes at $2,000 per home per month", "Total homes: 14 homes at $2,000 per home per month", "Average rent: 14 homes at $2,000 per home per month", "Unit 204 | 1 | $1,950 / suite / month", "The project has 14 homes at $2,000 per home per month"]) {
      expect(itemKeys(lines(s)).filter((k) => !/^All units$/.test(k!)), s).toEqual([]);
    }
  });
  test("each type of a full document reads with its count and rent", () => {
    const doc = lines("Orchard row: 3 homes at $2,300 per home per month", "Mill flat | 5 | $1,950 / suite / month", "Cottage | 4 logements | 1 800 $ par logement par mois", "Gallery space 1,800 sf at $34 per sf");
    expect(items(doc)).toEqual({
      "Orchard Row|unit_count": 3,
      "Orchard Row|unit_rent_monthly": 2_300,
      "Mill Flat|unit_count": 5,
      "Mill Flat|unit_rent_monthly": 1_950,
      "Cottage|unit_count": 4,
      "Cottage|unit_rent_monthly": 1_800,
      "Gallery Space|rentable_area_sf": 1_800,
      "Gallery Space|rent_psf_annual": 34,
    });
  });
  test("an item with a count and no rent, or a rent and no count, is not created", () => {
    expect(items(lines("Orchard row: 3 homes"))).not.toHaveProperty("Orchard Row|unit_rent_monthly");
    expect(items(lines("Orchard row: $2,300 per home per month"))).not.toHaveProperty("Orchard Row|unit_count");
  });

  // Rule 5
  test("a suite-by-suite roll with a summary reads only the summary; without one it reads nothing and says so", () => {
    const roll = grid(["Suite", "Type", "Status", "Monthly rent"], ["101", "1-bed", "Leased", "$1,900"], ["102", "1-bed", "Vacant", "$1,900"], ["201", "2-bed", "Leased", "$2,400"]);
    const summary = grid(["Type", "Units", "Monthly rent"], ["1-bed", "20", "$1,900"], ["2-bed", "10", "$2,400"]);
    expect(items(withTables([], roll, summary))).toEqual({ "1BR|unit_count": 20, "1BR|unit_rent_monthly": 1_900, "2BR|unit_count": 10, "2BR|unit_rent_monthly": 2_400 });
    const none = extractCandidates(withTables([], roll));
    expect(none.candidates).toEqual([]);
    expect(none.notes).toContain("A suite-by-suite roll without a summary by type; enter the unit mix");
    expect(extractCandidates(withTables([], roll, summary)).notes).not.toContain("A suite-by-suite roll without a summary by type; enter the unit mix");
  });
  test("negative: a table with a count column is a summary, not a suite roll", () => {
    const r = extractCandidates(withTables([], grid(["Type", "Units", "Status", "Monthly rent"], ["1-bed", "20", "Leased", "$1,900"])));
    expect(r.notes.join()).not.toMatch(/suite-by-suite/);
    expect(items(withTables([], grid(["Type", "Units", "Status", "Monthly rent"], ["1-bed", "20", "Leased", "$1,900"])))["1BR|unit_count"]).toBe(20);
  });

  // Rule 6
  test("an as-is rent per sf, count or area is refused with a note", () => {
    for (const s of ["The existing commercial space rents at $14 per sf.", "Current rent for the retail is $14 per sf.", "Retail rent: $14 per sf, in place today.", "Existing retail rent: $14 per sf"]) {
      const r = extractCandidates(lines(s));
      expect(r.candidates, s).toEqual([]);
      expect(r.other.some((o) => AS_IS.test(o.note ?? "")), s).toBe(true);
    }
    const row = extractCandidates(withTables([], grid(["Type", "Units", "Monthly rent"], ["Existing retail", "2", "$1,000"], ["2-bed", "3", "$2,100"])));
    expect(row.candidates.filter((c) => c.itemKey).map((c) => c.itemKey)).toEqual(["2BR", "2BR"]);
    expect(row.other.some((o) => AS_IS.test(o.note ?? ""))).toBe(true);
  });
  test("negative: 'Existing' in a heading over a new-programme table does not refuse the new rows", () => {
    expect(items(withTables(["Existing site"], grid(["Type", "Units", "Monthly rent"], ["1-bed", "6", "$1,900"])))).toEqual({ "1BR|unit_count": 6, "1BR|unit_rent_monthly": 1_900 });
    expect(items(withTables([], grid(["Existing site"], ["Type", "Units", "Monthly rent"], ["1-bed", "6", "$1,900"])))).toEqual({ "1BR|unit_count": 6, "1BR|unit_rent_monthly": 1_900 });
    expect(items(lines("Existing site", "Orchard row: 3 homes at $2,300 per home per month"))).toEqual({ "Orchard Row|unit_count": 3, "Orchard Row|unit_rent_monthly": 2_300 });
  });
  test("nothing is multiplied or summed: a count and a per-home rent stay as written", () => {
    expect(Object.values(items(lines("Orchard row: 3 homes at $2,300 per home per month")))).not.toContain(6_900);
  });

  // Task 55
  test("a unit type written after a count labels that line's rent, one item per type, in English and French (task 55)", () => {
    expect(items(lines("Dwellings planned: 4 three-bed; Rent for each dwelling: $2,600 per unit per month", "Dwellings planned: 7 studios; Rent for each dwelling: $1,350 per unit per month"))).toEqual({
      "3BR|unit_count": 4,
      "3BR|unit_rent_monthly": 2_600,
      "Studio|unit_count": 7,
      "Studio|unit_rent_monthly": 1_350,
    });
    expect(items(lines("Logements prévus : 3 trois et demie ; loyer mensuel par logement : 1 650 $ par logement par mois"))).toEqual({ "3½|unit_count": 3, "3½|unit_rent_monthly": 1_650 });
    // A singular named type after a count is that type too (audit); "Suite 9 Loft" stays a name and a number.
    expect(items(lines("Dwellings planned: 2 loft; Rent for each dwelling: $2,900 per unit per month"))).toEqual({ "Loft|unit_count": 2, "Loft|unit_rent_monthly": 2_900 });
    expect(items(lines("Suite 9 Loft rents at $2,900 per month."))).not.toHaveProperty("Loft|unit_count");
  });
  test("negative: a count with no unit type reads as before, and storeys and stalls make no item (task 55)", () => {
    expect(items(lines("Units: 12"))).toEqual({ "All units|unit_count": 12 });
    expect(itemKeys(lines("Floors: 3 storeys", "Parking: 4 parking stalls"))).toEqual([]);
    // A suite number followed by a type is a name and a number, not a count.
    expect(items(lines("Suite 12 two-bed"))).toEqual({});
  });
  test("a plain-language rent per unit is the monthly rent; a yearly one is divided by 12 with its note (task 55)", () => {
    for (const [label, rent] of [["Monthly rent for each suite: $1,750", 1_750], ["Monthly price for each home: $1,800", 1_800], ["Asking lease per door monthly: $1,900", 1_900], ["Loyer demandé par logement : 1 650 $", 1_650]] as const) {
      expect(items(lines(label)), label).toEqual({ "All units|unit_rent_monthly": rent });
    }
    const yearly = extractCandidates(lines("Annual lease per dwelling: $21,600"));
    expect(yearly.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["unit_rent_monthly", 1_800]]);
    expect(yearly.candidates[0]!.unitSeen).toMatch(/divided by 12/);
  });
  test("negative: a sale price, a price per area or an asking price with no period is no rent (task 55)", () => {
    for (const s of ["Price per door paid by the buyer: $90,000", "Sale price for each suite: $310,000", "Monthly price per sf: $4", "Asking price per door: $450,000", "Prix de vente par logement : 310 000 $"]) {
      expect(items(lines(s)), s).toEqual({});
    }
  });
  test("a unit-mix table is found by its header words, and each type reads with its count and rent (task 55)", () => {
    expect(items(withTables([], grid(["Plan", "Inventory by plan", "Monthly price for each suite"], ["Studio", "5", "$1,250"], ["2-bed", "3", "$2,050"], ["Total", "8", ""])))).toEqual({
      "Studio|unit_count": 5,
      "Studio|unit_rent_monthly": 1_250,
      "2BR|unit_count": 3,
      "2BR|unit_rent_monthly": 2_050,
    });
    expect(items(withTables([], grid(["Type", "Nombre", "Loyer demandé par logement"], ["Studio", "2", "1 100 $"], ["4½", "3", "1 800 $"])))).toEqual({ "Studio|unit_count": 2, "Studio|unit_rent_monthly": 1_100, "4½|unit_count": 3, "4½|unit_rent_monthly": 1_800 });
  });
  test("negative: months or years as headers are no unit mix, and a non-unit row or as-is figure is still refused (task 55)", () => {
    expect(itemKeys(withTables([], grid(["Plan", "Jan", "Feb"], ["Studio", "5", "$1,250"], ["2-bed", "3", "$2,050"])))).not.toContain("Studio");
    const r = extractCandidates(withTables([], grid(["Plan", "Homes in total", "Asking rent per home monthly"], ["Existing retail", "2", "$1,000"], ["2-bed", "3", "$2,100"])));
    expect(r.candidates.filter((c) => c.itemKey).map((c) => c.itemKey)).toEqual(["2BR", "2BR"]);
    expect(r.other.some((o) => AS_IS.test(o.note ?? ""))).toBe(true);
  });
  test("a field, a dash and a whole unit type name the item, in lines and rows; both orders read, and the key keeps no separator (task 55)", () => {
    const want = { "Studio|unit_count": 6, "Studio|unit_rent_monthly": 1_450 };
    expect(items(lines("Number of units – studio: 6", "Rent per door per month – studio: $1,450"))).toEqual(want);
    expect(items(withTables([], grid(["Number of units – studio", "6"], ["Rent per door per month – studio", "$1,450"])))).toEqual(want);
    expect(items(lines("Studio – number of units: 6", "Studio - rent per door per month: $1,450"))).toEqual(want);
    expect(itemKeys(lines("Studio - rent per door per month: $1,450"))).toEqual(["Studio"]);
  });
  test("negative: a dash before something that is no unit type names no item (task 55)", () => {
    expect(itemKeys(lines("Number of units – phase two: 6", "Rent per door per month – total: $1,450")).filter((k) => k !== "All units")).toEqual([]);
  });
  test("a category column beside the line items is set aside; its word stays in the context and the rows read (task 55)", () => {
    const sheet = grid(
      ["Uses", "Land purchase", "450000"],
      ["Uses", "Hard costs", "1800000"],
      ["Uses", "Soft costs", "300000"],
      ["Assumptions", "Construction period", "12 months"],
      ["Revenue", "Rent per door per month – studio", "$1,500"],
      ["Revenue", "Number of units – studio", "8"],
    );
    const r = extractCandidates(withTables([], sheet));
    expect(r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["land_cost", null, 450_000], ["hard_cost", null, 1_800_000], ["soft_cost", null, 300_000], ["construction_months", null, 12], ["unit_rent_monthly", "Studio", 1_500], ["unit_count", "Studio", 8]]);
    expect(r.candidates[1]!.context).toMatch(/Uses/);
    expect(r.other).toEqual([]);
    // A third column of notes is no part of the label.
    const noted = extractCandidates(withTables([], grid(["Uses", "Land purchase", "450000", "paid at closing"], ["Uses", "Hard costs", "1800000", "fixed price"], ["Uses", "Soft costs", "300000", "estimate"])));
    expect(noted.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 450_000], ["hard_cost", 1_800_000], ["soft_cost", 300_000]]);
  });
  test("a figure's context holds every text cell of its row before it, even when the row's first word is not its label (task 57)", () => {
    const mixed = extractCandidates(withTables([], grid(
      ["Pro forma for a fictional duplex"],
      ["Cost", "Design and permit allowance", "92000"],
      ["Note", "Siding upgrade, already in the build price", "18000"],
      ["Construction period", "11 months"],
      ["Stabilized occupancy", "96%"],
      ["Exit cap rate", "5.25%"],
      ["Interest rate", "6.1%"],
    )));
    expect(mixed.other.find((o) => o.value === 92_000)?.context).toBe("Sheet: Cost Design and permit allowance 92000");
    expect(mixed.other.find((o) => o.value === 18_000)?.context).toBe("Sheet: Note Siding upgrade, already in the build price 18000");
    // what is read does not change
    expect(mixed.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["construction_months", 11], ["stabilized_occupancy_pct", 96], ["exit_cap_rate_pct", 5.25], ["senior_rate_pct", 6.1]]);
    expect(mixed.candidates.find((c) => c.value === 11)?.context).toBe("Sheet: Construction period 11 months");
  });
  test("negative: a two-column sheet, a sheet with a header row and a first column of distinct labels read as before (task 55)", () => {
    const two = extractCandidates(withTables([], grid(["Land purchase", "450000"], ["Hard costs", "1800000"], ["Soft costs", "300000"])));
    expect(two.candidates.map((c) => c.fieldKey)).toEqual(["land_cost", "hard_cost", "soft_cost"]);
    const money = (n: number, i: number): Cell => ({ text: String(n), ref: `C${i}`, number: n });
    const headed = extractCandidates(withTables([], { name: "Sheet", rows: [grid(["Group", "Line item", "Amount"]).rows[0]!, ...[["Land purchase", 450_000], ["Hard costs", 1_800_000], ["Soft costs", 300_000]].map(([l, n], i) => [{ text: "Uses", ref: `A${i}` }, { text: l as string, ref: `B${i}` }, money(n as number, i)])] }));
    expect(headed.candidates.map((c) => c.fieldKey)).toEqual(["land_cost", "hard_cost", "soft_cost"]);
    // Distinct, non-section first words are labels: the second text cell is not read in their place.
    const distinct = extractCandidates(withTables([], grid(["Site", "Corner lot", "450000"], ["Frame", "Wood", "1800000"], ["Permit", "City", "300000"])));
    expect(distinct.candidates.map((c) => c.fieldKey)).not.toContain("land_cost");
    // Its context still shows every text cell before the figure, so a person (or a suggested label) sees the whole row (task 57).
    expect(distinct.other.find((o) => o.value === 450_000)?.context).toBe("Sheet: Site Corner lot 450000");
  });
  test("each layout of a full invented document reads every type with its count and rent (task 55)", () => {
    expect(items(lines("Dwellings planned: 4 three-bed; Rent for each dwelling: $2,600 per unit per month", "Dwellings planned: 7 studios; Rent for each dwelling: $1,350 per unit per month"))).toEqual({ "3BR|unit_count": 4, "3BR|unit_rent_monthly": 2_600, "Studio|unit_count": 7, "Studio|unit_rent_monthly": 1_350 });
    expect(items(withTables([], grid(["Plan", "Qty", "Asking rent per home monthly"], ["Studio", "7", "$1,350"], ["3-bed", "4", "$2,600"])))).toEqual({ "Studio|unit_count": 7, "Studio|unit_rent_monthly": 1_350, "3BR|unit_count": 4, "3BR|unit_rent_monthly": 2_600 });
    expect(items(lines("Number of units – studio: 7", "Rent per door per month – studio: $1,350", "Number of units – three-bed: 4", "Rent per door per month – three-bed: $2,600"))).toEqual({ "Studio|unit_count": 7, "Studio|unit_rent_monthly": 1_350, "3BR|unit_count": 4, "3BR|unit_rent_monthly": 2_600 });
    expect(items(withTables([], grid(["Revenue", "Number of units – studio", "7"], ["Revenue", "Rent per door per month – studio", "$1,350"], ["Revenue", "Number of units – three-bed", "4"], ["Revenue", "Rent per door per month – three-bed", "$2,600"], ["Uses", "Hard costs", "1800000"], ["Uses", "Land purchase", "450000"], ["Uses", "Soft costs", "300000"])))).toEqual({ "Studio|unit_count": 7, "Studio|unit_rent_monthly": 1_350, "3BR|unit_count": 4, "3BR|unit_rent_monthly": 2_600 });
  });
  test("'example' inside an e-mail or web address is no marker; the word on its own still is (task 55)", () => {
    for (const first of ["From: Dana Roe <dana@builder.example>", "builder.example/projects", "dana@builder.example", "www.builder-example.ca"]) {
      const r = extractCandidates(lines(first, "Hard costs: $2,100,000"));
      expect(r.candidates.map((c) => [c.fieldKey, c.value]), first).toEqual([["hard_cost", 2_100_000]]);
    }
    for (const first of ["Example budget", "Example figures"]) {
      const r = extractCandidates(lines(first, "Hard costs: $2,100,000"));
      expect(r.candidates, first).toEqual([]);
      expect(r.other.some((o) => o.note === "Marked as not part of this deal"), first).toBe(true);
    }
  });
});

describe("wrong reads found by the V4 trap corpus: scales, spaced digits, allowances, bases, lone items (task 47)", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "txt",
    lines: text.map((t, i) => ({ text: t, location: `line ${i + 1}` })),
    tables: [],
    pageCount: null,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const cand = (r: ReturnType<typeof extractCandidates>, fieldKey: string) => r.candidates.filter((c) => c.fieldKey === fieldKey);
  const values = (r: ReturnType<typeof extractCandidates>) => Object.fromEntries(r.candidates.filter((c) => !c.itemKey).map((c) => [c.fieldKey, c.value]));
  const SCALE_NOTE = "The document states a scale for these amounts that Agir cannot read safely; enter the figure";
  const book = async (sheet: string, rows: (string | number | [number, string])[][]) => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheet);
    rows.forEach((r, i) =>
      r.forEach((v, c) => {
        const cell = ws.getCell(i + 1, c + 1);
        if (Array.isArray(v)) {
          cell.value = v[0];
          cell.numFmt = v[1];
        } else cell.value = v;
      }),
    );
    return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "book.xlsx");
  };
  const plain = [["Land", 34_500], ["Hard costs", 120_000], ["Soft costs", 15_000], ["Stabilized occupancy", [0.93, "0%"]], ["Unit count", 24]] as (string | number | [number, string])[][];

  // Rule 1
  test("a sheet name that states thousands scales money, and only money, by 1,000", async () => {
    const r = extractCandidates(await book("Budget ($ in thousands)", plain));
    expect(values(r)).toMatchObject({ land_cost: 34_500_000, hard_cost: 120_000_000, soft_cost: 15_000_000, stabilized_occupancy_pct: 93 });
    expect(r.candidates.filter((c) => c.fieldKey === "unit_count").map((c) => c.value)).toEqual([24]);
    const land = cand(r, "land_cost")[0]!;
    expect(land.raw).toBe("34500");
    expect(land.unitSeen).toMatch(/stated in thousands/);
  });
  test("negative: with no scale stated the same sheet reads as written", async () => {
    expect(values(extractCandidates(await book("Budget", plain)))).toMatchObject({ land_cost: 34_500, hard_cost: 120_000 });
  });
  test("a column header's scale beats the sheet's, and applies to its column", async () => {
    const r = extractCandidates(await book("Budget ($ in thousands)", [["Line item", "Amount ($ millions)"], ["Land", 34.5], ["Hard costs", 120]]));
    expect(values(r)).toMatchObject({ land_cost: 34_500_000, hard_cost: 120_000_000 });
    const own = extractCandidates(await book("Budget", [["Line item", "Amount ($000)"], ["Land", 34_500]]));
    expect(values(own)).toMatchObject({ land_cost: 34_500_000 });
  });
  test("a caption row with no figure scales the rows under it", async () => {
    const r = extractCandidates(await book("Budget", [["Project budget (in $000s)"], ["Line item", "Amount"], ["Land", 34_500], ["Hard costs", 120_000]]));
    expect(values(r)).toMatchObject({ land_cost: 34_500_000, hard_cost: 120_000_000 });
  });
  test("a heading in a text document scales the label and value lines under it", () => {
    const r = read("Project budget (in $000s)", "Land cost: $34,500", "Hard costs: $120,000", "Loan-to-cost: 65%");
    expect(values(r)).toMatchObject({ land_cost: 34_500_000, hard_cost: 120_000_000 });
    expect(cand(r, "land_cost")[0]!.raw).toBe("$34,500");
    expect(cand(r, "land_cost")[0]!.unitSeen).toMatch(/stated in thousands/);
    expect(values(read("Budget ($ millions)", "Land cost: $34.5"))).toMatchObject({ land_cost: 34_500_000 });
    // A later heading may start a section the scale does not cover, and a figure written in the millions is not plainly scaled: both are refused, never scaled.
    const later = read("Cost plan (in $000s)", "Land cost: $21,750", "Lending", "Senior loan amount: $48,000", "Rate: 6.1%");
    expect(values(later)).toMatchObject({ land_cost: 21_750_000, senior_rate_pct: 6.1 });
    expect(cand(later, "senior_loan_amount")).toEqual([]);
    const big = read("Cost plan (in $000s)", "Senior loan amount: $48,000,000");
    expect(cand(big, "senior_loan_amount")).toEqual([]);
    expect(big.other.some((o) => o.note === SCALE_NOTE)).toBe(true);
  });
  test("negative: a scale that measures something else is not a money scale", () => {
    for (const heading of ["Rentable areas in thousands of SF", "Units (thousands)", "Population in thousands"]) expect(values(read(heading, "Land cost: $34,500")), heading).toMatchObject({ land_cost: 34_500 });
  });
  test("two stated scales that differ refuse the figures, with the note", async () => {
    const r = extractCandidates(await book("Budget ($ in thousands)", [["Budget in millions of dollars"], ["Line item", "Amount"], ["Land", 34.5]]));
    expect(cand(r, "land_cost")).toEqual([]);
    expect(r.other.some((o) => o.note === SCALE_NOTE)).toBe(true);
    const t = read("Budget ($ in thousands; $ in millions)", "Land cost: $34,500");
    expect(cand(t, "land_cost")).toEqual([]);
    expect(t.other.some((o) => o.note === SCALE_NOTE)).toBe(true);
  });
  test("a scale word that is not clearly money refuses the figures", () => {
    const r = read("Budget (000)", "Land cost: $34,500");
    expect(cand(r, "land_cost")).toEqual([]);
    expect(r.other.some((o) => o.note === SCALE_NOTE)).toBe(true);
  });
  test("a figure with a scale of its own is never scaled again", async () => {
    const r = extractCandidates(await book("Budget ($ in thousands)", [["Land", "$1.2M"], ["Hard costs", 120_000]]));
    expect(values(r)).toMatchObject({ land_cost: 1_200_000, hard_cost: 120_000_000 });
    expect(values(read("Budget ($ in thousands)", "Land cost: $1.2M"))).toMatchObject({ land_cost: 1_200_000 });
  });
  test("a French caption scales the rows under it", () => {
    const row = (text: string, number?: number): Cell[] => (number === undefined ? [{ text, ref: "A1" }] : [{ text, ref: "A2" }, { text: String(number), number, ref: "B2" }]);
    const d: NormalizedDocument = { kind: "xlsx", lines: [], tables: [{ name: "Budget", rows: [row("Budget du projet (en milliers de dollars)"), row("Terrain", 34_500)] }], pageCount: null, needsOcr: false, fullText: "Terrain 34500" };
    expect(values(extractCandidates(d))).toMatchObject({ land_cost: 34_500_000 });
  });

  // Rule 2
  test("letter-spaced digits give no candidate and are never joined or read in part", () => {
    const r = read("Senior loan", "amount: $ 1 6 2 , 5 0 0 , 0 0 0");
    expect(cand(r, "senior_loan_amount")).toEqual([]);
    expect(r.candidates.map((c) => c.value)).not.toContain(1);
    expect(r.other.some((o) => /Letter-spaced digits, as OCR leaves them; enter the figure/.test(o.note ?? ""))).toBe(true);
    expect(r.other.map((o) => o.value)).not.toContain(162_500_000);
  });
  test("negative: space-grouped thousands in a fr-CA document still read", () => {
    expect(values(read("Prêt senior : 1 250 000 $"))).toMatchObject({ senior_loan_amount: 1_250_000 });
  });

  // Rule 3
  test("a tenant improvement allowance is not rent, in both languages", () => {
    for (const s of ["Tenant allowance: $75/SF", "The landlord offers the allowance of $65/SF as rent.", "TI allowance of $40/SF for the anchor", "Allocation pour améliorations locatives : 75 $/pi²", "Aménagements du locataire : 65 $/pi²"]) {
      const r = read(s);
      expect(r.candidates, s).toEqual([]);
      expect(r.other.some((o) => o.note === "A tenant improvement allowance, not rent"), s).toBe(true);
    }
  });
  test("negative: rent in the same text still reads", () => {
    const r = read("Office rent $42/SF", "Tenant allowance: $75/SF");
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["rent_psf_annual", 42]]);
    // A bare allowance that is not rent-shaped is its own line's figure, not a tenant improvement allowance.
    const other = read("Interest-only allowance on the loan: 15 months", "Design allowance $95,000 within soft costs");
    expect(other.other.some((o) => o.note === "A tenant improvement allowance, not rent")).toBe(false);
  });

  // Rule 4
  test("a figure after 'per' is a basis, never an area", () => {
    for (const s of ["Parking ratio: 1.8 stalls per 1,000 SF", "Parking is provided at 1.8 stalls per 1,000 SF of retail."]) expect(cand(read(s), "rentable_area_sf"), s).toEqual([]);
  });
  test("negative: a real area still reads", () => {
    expect(read("Rentable area: 12,000 SF").candidates.map((c) => [c.fieldKey, c.value])).toEqual([["rentable_area_sf", 12_000]]);
  });

  // Rule 5
  test("a lone area or rent under an unknown label makes no item", () => {
    for (const s of ["Header: image box 65 sf", "Header: banner at $34 per sf"]) {
      const r = read(s);
      expect(r.candidates, s).toEqual([]);
      expect(r.other.some((o) => o.note === "No field matches this label"), s).toBe(true);
    }
  });
  test("negative: a count and rent, or a unit-type label, still name an item", () => {
    const home = read("Mews home: 3 homes at $2,300 per home per month");
    expect(home.candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "Mews Home", 3], ["unit_rent_monthly", "Mews Home", 2_300]]);
    expect(read("Loft: $2,100 per month").candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_rent_monthly", "Loft", 2_100]]);
  });
  test("a function word is never an item name", () => {
    for (const s of ["Quoted at $65/SF as rent", "The rate is $65/SF in rent", "Asking $65/SF of rent"]) expect(read(s).candidates.filter((c) => /^(as|in|of)$/i.test(c.itemKey ?? "")), s).toEqual([]);
  });

  // Rule 6
  test("two monthly-labelled rents per unit with different figures give a conflict", () => {
    const tag = (r: ReturnType<typeof extractCandidates>, name: string): SourcedCandidate[] => r.candidates.map((c) => ({ ...c, documentId: name, documentName: name }));
    const both = consolidate([...tag(read("Residential rent monthly: $3,250 per unit per month"), "a"), ...tag(read("Residential rent monthly: $3,050 per unit"), "b")]);
    const rent = both.filter((p) => p.fieldKey === "unit_rent_monthly");
    expect(rent).toHaveLength(1);
    expect(rent[0]).toMatchObject({ status: "conflicting" });
    expect(rent[0]!.values.map((v) => v.value)).toEqual([3_050, 3_250]);
    const twoLines = consolidate(tag(read("Residential rent monthly: $3,250 per unit per month", "Residential rent monthly: $3,050 per unit"), "c")).filter((p) => p.fieldKey === "unit_rent_monthly");
    expect(twoLines).toHaveLength(1);
    expect(twoLines[0]!.status).toBe("conflicting");
  });
  test("one such line alone reads as the monthly rent per unit", () => {
    for (const s of ["Residential rent monthly: $3,050 per unit", "Monthly rent: $3,050 per suite", "Loyer mensuel : 3 050 $ par logement"]) {
      expect(read(s).candidates.map((c) => [c.fieldKey, c.value]), s).toEqual([["unit_rent_monthly", 3_050]]);
    }
  });
  test("negative: a rent per unit with no monthly word is not read as monthly", () => {
    expect(cand(read("Residential rent: $36,600 per unit"), "unit_rent_monthly")).toEqual([]);
  });
});

describe("a sentence in a workbook cell is read like a sentence in a text document", () => {
  const sheet = async (rows: (string | number)[][], name = "Terms") => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(name);
    rows.forEach((r, i) => r.forEach((v, c) => (ws.getCell(i + 1, c + 1).value = v)));
    return extractCandidates(await parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "terms.xlsx"));
  };
  const got = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value, c.location]);
  const FOUR = [["senior_loan_amount", 3_100_000], ["senior_rate_pct", 6.4], ["senior_amort_years", 30], ["senior_io_months", 12]];

  test("an English sentence cell gives the loan terms, located at the cell", async () => {
    const r = await sheet([["Name", "Birch Court"], ["Bank terms: loan $3,100,000 at 6.4% interest rate, 30-year amortization, 12 months interest-only."]]);
    expect(got(r)).toEqual(FOUR.map(([k, v]) => [k, v, "Terms!A2"]));
  });
  test("a French sentence cell with M$ and decimal commas gives the same four", async () => {
    const r = await sheet([["La caisse accorde un prêt de 3,1 M$ au taux de 6,4 %, amortissement de 30 ans, intérêts seulement 12 mois."]]);
    expect(got(r)).toEqual(FOUR.map(([k, v]) => [k, v, "Terms!A1"]));
  });
  test("negative: a short text cell and a label/value row read as before", async () => {
    const r = await sheet([["Approved"], ["Interest rate", "6.4%"], ["Status is final and approved by the committee"], ["Selling costs", "2,5 % of the sale price at closing"], ["Contingency (4 % of the direct building costs)", 88_000]]);
    // A long label next to a number cell is that number's label, not a sentence.
    expect(got(r)).toEqual([["senior_rate_pct", 6.4, "Terms!B2"], ["selling_costs_pct", 2.5, "Terms!B4"], ["contingency", 88_000, "Terms!B5"]]);
    expect(r.other).toEqual([]);
  });
  test("a lender's limit inside a sentence cell is refused with the limit note", async () => {
    const r = await sheet([["The lender will advance not more than 70% of cost under this facility letter."]]);
    expect(r.candidates).toEqual([]);
    expect(r.other.map((o) => [o.value, o.note, o.location])).toEqual([[70, "A lender's limit, not the deal's figure", "Terms!A1"]]);
  });
  test("figures that match no field are shown with a note, none disappear", async () => {
    const r = await sheet([["Parking has 41 stalls and 9 bicycle racks near the east lobby entrance."]]);
    expect(r.candidates).toEqual([]);
    expect(r.other.map((o) => [o.value, o.location]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[9, "Terms!A1"], [41, "Terms!A1"]]);
    expect(r.other.every((o) => !!o.note || o.rule.length > 0)).toBe(true);
  });
  test("a sentence cell on a sheet marked as not part of the deal gives no candidate", async () => {
    const r = await sheet([["Bank terms: loan $3,100,000 at 6.4% interest rate, 30-year amortization."]], "Not part of the deal - old terms");
    expect(r.candidates).toEqual([]);
    expect(r.other.length).toBe(3);
    expect(r.other.every((o) => o.note === "Marked as not part of this deal")).toBe(true);
  });
  test("a sentence cell under a mezzanine section takes the mezzanine scope; a figure with its own scale is not scaled again", async () => {
    const r = await sheet([["Amounts in thousands"], ["Mezzanine loan"], ["Bank terms: loan 1,2 M$ at 11% interest rate, 5-year amortization, 6 months interest-only."]]);
    expect(r.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["mezz_loan_amount", 1_200_000], ["mezz_rate_pct", 11], ["mezz_amort_years", 5], ["mezz_io_months", 6]]);
  });
});

describe("a model's label suggestion crosses a boundary before it is a candidate (task 50a)", () => {
  const lines = ["Sundry reserve: $48,000", "Atrium count: 14", "Float factor: 5.5%", "Cadence: 7 months", "Loan limit: maximum loan of $9,000,000", "Application fee: $12,500", "Hall footprint: 3,200 sf"];
  const doc = (text: string[]): NormalizedDocument => ({ kind: "pdf", lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: text.join("\n") });
  const sourced = (c: ReturnType<typeof extractCandidates>["other"][number], documentId = "d1"): SourcedCandidate => ({ ...c, documentId, documentName: `${documentId}.pdf` });
  const all = extractCandidates(doc(lines)).other.map((o) => sourced(o));
  const offered = all.filter(offerable);
  const idOf = (ctx: string) => offeredIds(offered)[offered.findIndex((o) => o.context.startsWith(ctx))]!;
  const read = (fieldKey: string, value: number, itemKey: string | null = null): SourcedCandidate =>
    ({ fieldKey, itemKey, value, raw: String(value), unitSeen: "$", location: "p2", context: "read", rule: "line:label-value", documentId: "d2", documentName: "d2.pdf" });

  test("only a figure with no matching label is offered; a lender limit and a fee never are", () => {
    expect(offered.map((o) => o.value)).toEqual([48_000, 14, 5.5, 7, 3_200]);
    expect(all.filter((o) => !offerable(o)).map((o) => o.value)).toEqual([9_000_000, 12_500]);
    expect(new Set(offeredIds(offered)).size).toBe(offered.length);
  });
  test("a kept suggestion is the figure itself, marked suggested; the model's value is ignored", () => {
    const { kept, dropped } = applySuggestions([], offered, [{ id: idOf("Sundry"), fieldKey: "other_cost", value: 1 } as never]);
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ fieldKey: "other_cost", itemKey: null, value: 48_000, raw: "$48,000", unitSeen: "$", location: "page 1, line 1", context: "Sundry reserve: $48,000", rule: "suggested", documentId: "d1" });
    expect(kept[0]!.note).toBe("Suggested label, not read by Agir's rules; confirm it");
  });
  test("a kept itemized suggestion needs an item named in the figure's own context", () => {
    const ok = applySuggestions([], offered, [{ id: idOf("Atrium"), fieldKey: "unit_count", itemKey: "atrium" }]);
    expect(ok.kept.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "atrium", 14]]);
    const bad = applySuggestions([], offered, [{ id: idOf("Atrium"), fieldKey: "unit_count", itemKey: "Studio" }, { id: idOf("Hall"), fieldKey: "rentable_area_sf" }]);
    expect(bad.kept).toEqual([]);
    expect(bad.dropped.map((d) => d.why)).toHaveLength(2);
  });
  test("each drop has its own reason", () => {
    const run = (s: { id: string; fieldKey: string; itemKey?: string }, results: SourcedCandidate[] = []) => applySuggestions(results, offered, [s]);
    const why = (r: ReturnType<typeof run>) => (r.kept.length ? "kept" : r.dropped[0]!.why);
    const reasons = [
      why(run({ id: idOf("Sundry"), fieldKey: "ignore" })),
      why(run({ id: idOf("Sundry"), fieldKey: "no_such_field" })),
      why(run({ id: idOf("Sundry"), fieldKey: "lease_up_ramp" })),
      why(run({ id: idOf("Float"), fieldKey: "other_cost" })),
      why(run({ id: idOf("Sundry"), fieldKey: "senior_rate_pct" })),
      why(run({ id: idOf("Cadence"), fieldKey: "hold_years" })),
      why(run({ id: idOf("Atrium"), fieldKey: "unit_count" })),
      why(run({ id: idOf("Sundry"), fieldKey: "other_cost" }, [read("other_cost", 50_000)])),
      why(run({ id: "d1|page 9|$1", fieldKey: "other_cost" })),
    ];
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons).not.toContain("kept");
  });
  test("units must fit the field: dollars, months, percent and a whole count are kept; others are not", () => {
    const kept = (ctx: string, fieldKey: string, itemKey?: string) => applySuggestions([], offered, [{ id: idOf(ctx), fieldKey, itemKey }]).kept.length;
    expect([kept("Sundry", "other_cost"), kept("Cadence", "lease_up_months"), kept("Float", "variable_expense_pct"), kept("Atrium", "unit_count", "Atrium"), kept("Hall", "rentable_area_sf", "Hall")]).toEqual([1, 1, 1, 1, 1]);
    expect([kept("Cadence", "other_cost"), kept("Sundry", "unit_rent_monthly", "Sundry"), kept("Float", "unit_count", "Float")]).toEqual([0, 0, 0]);
    // A count written as units fits and takes the reader's item name; a figure outside the field's bounds is dropped.
    const base = offered.find((o) => o.context.startsWith("Atrium"))!;
    const wing: SourcedCandidate = { ...base, raw: "6 units", value: 6, unitSeen: "units", context: "the 2-bed wing has 6 units", location: "page 3, line 1" };
    const counted = applySuggestions([], [wing], [{ id: offeredIds([wing])[0]!, fieldKey: "unit_count", itemKey: "2-bed" }]).kept;
    expect(counted.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "2BR", 6]]);
    const over: SourcedCandidate = { ...offered.find((o) => o.context.startsWith("Float"))!, raw: "140%", value: 140, location: "page 3, line 2" };
    const r = applySuggestions([], [over], [{ id: offeredIds([over])[0]!, fieldKey: "stabilized_occupancy_pct" }]);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]!.why).toMatch(/outside what stabilized_occupancy_pct can hold/);
  });
  test("a suggested candidate is never approved: alone or agreeing with a read figure it needs review", () => {
    const { kept } = applySuggestions([], offered, [{ id: idOf("Sundry"), fieldKey: "other_cost" }]);
    for (const withRead of [[], [read("other_cost", 48_000)]]) {
      const p = consolidate([...kept, ...withRead]);
      expect(p.map((x) => [x.status, x.value])).toEqual([["needs_review", 48_000]]);
      expect(p[0]!.sources.some((s) => s.rule === "suggested")).toBe(true);
    }
  });
  test("a suggested figure that disagrees with a read figure names a conflict", () => {
    const { kept } = applySuggestions([], offered, [{ id: idOf("Sundry"), fieldKey: "other_cost" }]);
    const p = consolidate([...kept, read("other_cost", 50_000)]);
    expect(p.map((x) => [x.status, x.value, x.values.map((v) => v.value)])).toEqual([["conflicting", null, [48_000, 50_000]]]);
  });
});

describe("a person's label for a figure Agir did not use crosses a boundary (task 58)", () => {
  const lines = ["Sundry reserve: $48,000", "Atrium count: 14", "Float factor: 5.5%", "Cadence: 7 months", "Loan limit: maximum loan of $9,000,000", "Spread: 140%", "Hall footprint: 3,200 sf"];
  const doc: NormalizedDocument = { kind: "pdf", lines: lines.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") };
  const figures = figureOrder(extractCandidates(doc).other.map((o) => ({ ...o, documentId: "d1", documentName: "d1.pdf" })));
  const idOf = (ctx: string) => offeredIds(figures)[figures.findIndex((o) => o.context.startsWith(ctx))]!;
  const label = (ctx: string, fieldKey: string, itemKey?: string | null) => applyLabels(figures, [{ id: idOf(ctx), fieldKey, itemKey }]);
  const read = (fieldKey: string, value: number): SourcedCandidate =>
    ({ fieldKey, itemKey: null, value, raw: String(value), unitSeen: "months", location: "p2", context: "read", rule: "line:label-value", documentId: "d2", documentName: "d2.pdf" });

  test("a bare number takes the unit of the field a person names; the figure keeps its source", () => {
    const { kept, dropped } = label("Atrium", "lease_up_months");
    expect(dropped).toEqual([]);
    expect(kept[0]).toMatchObject({ fieldKey: "lease_up_months", itemKey: null, value: 14, raw: "14", location: "page 1, line 2", context: "Atrium count: 14", rule: "labelled", documentId: "d1" });
    expect(kept[0]!.note).toBe("Labelled by a person from the document; confirm it");
  });
  test("a figure refused by the reader may be labelled; a percent never becomes dollars", () => {
    expect(figures.some((f) => f.value === 9_000_000)).toBe(true);
    expect(label("Loan limit", "other_cost").kept.map((c) => c.value)).toEqual([9_000_000]);
    const r = label("Float", "other_cost");
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]!.why).toMatch(/does not fit/);
    expect(label("Float", "variable_expense_pct").kept.map((c) => c.value)).toEqual([5.5]);
  });
  test("a value outside the field's bounds is refused", () => {
    const r = label("Spread", "stabilized_occupancy_pct");
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]!.why).toMatch(/outside what stabilized_occupancy_pct can hold/);
  });
  test("an itemized field needs an item, made canonical; it need not appear in the context", () => {
    expect(label("Atrium", "unit_count").kept).toEqual([]);
    expect(label("Atrium", "unit_count", "  ").dropped).toHaveLength(1);
    expect(label("Atrium", "unit_count", "2-bed").kept.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "2BR", 14]]);
  });
  test("an unknown field, a field not read from documents and an unknown id are dropped", () => {
    const r = applyLabels(figures, [{ id: idOf("Sundry"), fieldKey: "no_such_field" }, { id: idOf("Sundry"), fieldKey: "lease_up_ramp" }, { id: "d1|page 9|$1", fieldKey: "other_cost" }]);
    expect(r.kept).toEqual([]);
    expect(new Set(r.dropped.map((d) => d.why)).size).toBe(3);
  });
  test("a label is kept although the reader read the field; consolidate names the conflict", () => {
    const { kept } = label("Atrium", "lease_up_months");
    expect(kept).toHaveLength(1);
    const p = consolidate([...kept, read("lease_up_months", 18)]);
    expect(p.map((x) => [x.status, x.value, x.values.map((v) => v.value)])).toEqual([["conflicting", null, [14, 18]]]);
    expect(consolidate(kept).map((x) => x.status)).toEqual(["needs_review"]);
  });
  test("a person's label beats a model's suggestion for the same figure", () => {
    const sugg = [{ id: idOf("Sundry"), fieldKey: "other_cost" }, { id: idOf("Cadence"), fieldKey: "lease_up_months" }];
    const rest = withoutLabelled(figures, [{ id: idOf("Sundry") }], sugg);
    expect(rest.map((s) => s.id)).toEqual([idOf("Cadence")]);
    expect(applySuggestions([], figures.filter(offerable), rest).kept.map((c) => c.value)).toEqual([7]);
  });
});

describe("audit of task 58: the unit a person's label may give a figure", () => {
  const fig = (raw: string, value: number, unitSeen: string | null, n: number): SourcedCandidate =>
    ({ fieldKey: null, itemKey: null, value, raw, unitSeen, location: `page 3, line ${n}`, context: `Row ${n} ${raw}`, rule: "", note: "No field matches this label", documentId: "d3", documentName: "d3.pdf" });
  const figures = figureOrder([fig("$2,350", 2350, "$", 1), fig("$1,600 a month", 1600, "$/mo", 2), fig("$38 per sf", 38, "$/sf", 3), fig("$41", 41, "$", 4)]);
  const label = (raw: string, fieldKey: string, itemKey?: string) => applyLabels(figures, [{ id: offeredIds(figures)[figures.findIndex((f) => f.raw === raw)]!, fieldKey, itemKey }]);

  test("a plain dollar figure takes the basis of the money field a person names, as a rent-roll cell under a 'Monthly rent' heading needs", () => {
    expect(label("$2,350", "unit_rent_monthly", "2-bed").kept.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_rent_monthly", "2BR", 2350]]);
    expect(label("$41", "rent_psf_annual", "retail").kept.map((c) => [c.fieldKey, c.value])).toEqual([["rent_psf_annual", 41]]);
  });
  test("a figure written with its own basis must fit the field, and a dollar figure never becomes another kind of unit", () => {
    expect(label("$1,600 a month", "other_income_annual").dropped[0]!.why).toMatch(/does not fit/);
    expect(label("$38 per sf", "unit_rent_monthly", "1-bed").dropped[0]!.why).toMatch(/does not fit/);
    expect(label("$2,350", "construction_months").dropped[0]!.why).toMatch(/does not fit/);
    expect(label("$2,350", "exit_cap_rate_pct").dropped[0]!.why).toMatch(/does not fit/);
  });
});

describe("card 60d: one item, however its name is written", () => {
  const nd = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const rentTable = (name: string, rent: number): Table => ({
    name: "Rent roll",
    rows: [
      [{ text: "Unit type", ref: "A1" }, { text: "Units", ref: "B1" }, { text: "Rent ($/mo)", ref: "C1" }],
      [{ text: name, ref: "A2" }, { text: "2", number: 2, ref: "B2" }, { text: String(rent), number: rent, unit: "$", ref: "C2" }],
    ],
  });
  const from = (r: ReturnType<typeof extractCandidates>, documentName: string): SourcedCandidate[] => r.candidates.map((c) => ({ ...c, documentId: documentName, documentName }));
  const rents = (ps: ReturnType<typeof consolidate>) => ps.filter((p) => p.fieldKey === "unit_rent_monthly");

  test("a table's 'retail' and a sentence's 'Retail' at the same rent are one proposal with both sources", () => {
    const table = extractCandidates(nd([], [rentTable("retail", 3000)]));
    const text = extractCandidates(nd(["Retail monthly rent: $3,000 per unit per month"]));
    expect(table.candidates.find((c) => c.fieldKey === "unit_rent_monthly")?.itemKey).toBe("retail");
    expect(text.candidates.find((c) => c.fieldKey === "unit_rent_monthly")?.itemKey).toBe("Retail");
    const p = rents(consolidate([...from(table, "Rent roll"), ...from(text, "Memo")]));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ itemKey: "Retail", status: "needs_review", value: 3000 });
    expect(p[0]!.sources.map((s) => s.documentName).sort()).toEqual(["Memo", "Rent roll"]);
  });

  test("at $3,000 and $3,200 they are one conflicting proposal naming both values", () => {
    const table = extractCandidates(nd([], [rentTable("retail", 3000)]));
    const text = extractCandidates(nd(["Retail monthly rent: $3,200 per unit per month"]));
    const p = rents(consolidate([...from(table, "Rent roll"), ...from(text, "Memo")]));
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ status: "conflicting", value: null });
    expect(p[0]!.values.map((v) => v.value)).toEqual([3000, 3200]);
  });

  test("the group takes the form most sources use, and on a tie the one that sorts first", () => {
    const one = (itemKey: string, documentName: string): SourcedCandidate => ({
      fieldKey: "unit_rent_monthly", itemKey, value: 3000, raw: "$3,000", unitSeen: "$/mo", location: "page 1, line 1", context: "", rule: "test", documentId: documentName, documentName,
    } as SourcedCandidate);
    expect(rents(consolidate([one("retail", "a"), one("Retail", "b")]))[0]!.itemKey).toBe("Retail");
    expect(rents(consolidate([one("Retail", "a"), one("retail", "b")]))[0]!.itemKey).toBe("Retail");
    expect(rents(consolidate([one("retail", "a"), one("retail", "b"), one("Retail", "c")]))[0]!.itemKey).toBe("retail");
  });

  test("'Office space' and 'Office Space' are one item", () => {
    const a = extractCandidates(nd([], [rentTable("Office space", 1800)]));
    const b = extractCandidates(nd(["Office Space monthly rent: $1,800 per unit per month"]));
    const p = rents(consolidate([...from(a, "a"), ...from(b, "b")]));
    expect(p).toHaveLength(1);
    expect(p[0]!.sources).toHaveLength(2);
  });

  test("itemFold: one unit type in any spelling is one fold; a different name is not", () => {
    expect(itemFold("3-bed")).toBe(itemFold("3 BR"));
    expect(itemFold("3 BR")).toBe(itemFold("3br"));
    expect(itemFold("Office   SPACE ")).toBe(itemFold("office space"));
    expect(itemFold("Retail")).not.toBe(itemFold("Retail 2"));
  });
});

describe("card 61b: development charges and land transfer tax are read into their own fields", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);

  test("each wording of a development charges line is development charges, never other costs", () => {
    for (const line of ["Development charges: $85,000", "Development charge: $85,000", "Dev charges: $85,000", "DCCs: $85,000", "Redevances de développement : 85 000 $"]) {
      expect(pick(read(line)), line).toEqual([["development_charges", 85_000]]);
    }
  });
  test("each wording of a land transfer tax line is land transfer tax, never land or other costs", () => {
    for (const line of ["Land transfer tax: $20,000", "LTT: $20,000", "Land transfer duty: $20,000", "Property transfer tax: $20,000", "Welcome tax: $20,000", "Droits de mutation : 20 000 $"]) {
      expect(pick(read(line)), line).toEqual([["land_transfer_tax", 20_000]]);
    }
  });
  test("beside a land line, land transfer duty is its own value and the land is not in conflict", () => {
    const r = read("Land: $800,000", "Land transfer duty: $20,000");
    expect(pick(r)).toEqual([["land_cost", 800_000], ["land_transfer_tax", 20_000]]);
    const proposals = consolidate(r.candidates.map((c) => ({ ...c, documentId: "d", documentName: "d" })));
    expect(proposals.map((p) => [p.fieldKey, p.status]).sort()).toEqual([["land_cost", "needs_review"], ["land_transfer_tax", "needs_review"]]);
  });
  test("beside an other costs line, development charges are their own value and nothing conflicts", () => {
    const r = read("Other costs: $50,000", "Development charges: $85,000");
    expect(pick(r)).toEqual([["other_cost", 50_000], ["development_charges", 85_000]]);
    const proposals = consolidate(r.candidates.map((c) => ({ ...c, documentId: "d", documentName: "d" })));
    expect(proposals.map((p) => [p.fieldKey, p.status]).sort()).toEqual([["development_charges", "needs_review"], ["other_cost", "needs_review"]]);
  });
  test("property tax and GST/HST net of rebates are still not read as any field", () => {
    expect(pick(read("Property tax: $12,000"))).toEqual([]);
    expect(pick(read("GST/HST net of rebates: $40,000"))).toEqual([]);
  });
  test("permit levies are still other costs", () => {
    expect(pick(read("Permit levies: $5,000"))).toEqual([["other_cost", 5_000]]);
  });
  // Audit of task 61b: "incl." and "excl." are abbreviations, so the words after them stay in the label.
  test("a cost line that says what it includes or excludes is that cost, not the charge it names", () => {
    expect(pick(read("Soft costs incl. DCs: $300,000"))).toEqual([["soft_cost", 300_000]]);
    expect(pick(read("Hard costs incl. DCs: $3,000,000"))).toEqual([["hard_cost", 3_000_000]]);
    expect(pick(read("Other costs incl. LTT: $70,000"))).toEqual([["other_cost", 70_000]]);
    expect(pick(read("Soft costs excl. DCs: $300,000"))).toEqual([["soft_cost", 300_000]]);
  });
  // Audit of task 61b: a waived or exempt charge is not what the deal pays; the figure is shown, never read as a cost.
  test("a charge the city waived or exempted is shown, not read as a cost", () => {
    for (const line of ["The city waived development charges of $85,000 for rental units.", "Development charges exempt under the rental program: $85,000", "Development charges: $85,000 (waived)", "Land transfer tax exemption: $4,000", "Redevances de développement exonérées : 85 000 $"]) {
      const r = read(line);
      expect(pick(r), line).toEqual([]);
      expect(r.other.map((o) => o.note), line).toContain(WAIVED_NOTE);
    }
    // A waived charge stated as $0 is 0, and a figure net of an exemption is what is paid.
    expect(pick(read("Development charges (waived): $0"))).toEqual([["development_charges", 0]]);
    expect(pick(read("Development charges, net of the rental exemption: $40,000"))).toEqual([["development_charges", 40_000]]);
    // A cost exempt from a sales tax is still the cost.
    expect(pick(read("Hard costs (HST exempt): $3,000,000"))).toEqual([["hard_cost", 3_000_000]]);
    expect(pick(read("Soft costs, exempt from GST: $300,000"))).toEqual([["soft_cost", 300_000]]);
  });
});

describe("card 61d: a tax, interest, fee or carrying-cost line is not read as the item it names", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const SALES_TAX_NOTE = "A sales tax line; enter GST/HST net of rebates, or label it";
  const INTEREST_NOTE = "Interest on this item, not the item; label it if it belongs to a cost line";
  const FEE_NOTE = "A fee or premium, not an input";
  const CARRYING_NOTE = "A carrying cost; label it under the cost line it belongs to";

  test("each line that names an item only as the object of a tax, interest, fee or carrying cost is refused with its note", () => {
    const lines: [string, string][] = [
      ["HST on construction: $180,000", SALES_TAX_NOTE],
      ["HST on hard costs: $180,000", SALES_TAX_NOTE],
      ["HST on soft costs: $30,000", SALES_TAX_NOTE],
      ["GST on land: $32,000", SALES_TAX_NOTE],
      ["TVH sur la construction : 180 000 $", SALES_TAX_NOTE],
      ["Construction loan interest: $96,000", INTEREST_NOTE],
      ["Intérêts du prêt de construction : 96 000 $", INTEREST_NOTE],
      ["Construction loan fee: $23,000", FEE_NOTE],
      ["Construction loan interest reserve: $96,000", INTEREST_NOTE],
      ["Land loan interest: $30,000", INTEREST_NOTE],
      ["Interest during construction: $96,000", INTEREST_NOTE],
      ["Property taxes during construction: $7,200", CARRYING_NOTE],
      ["Taxes during construction: $7,200", CARRYING_NOTE],
      ["Taxe foncière pendant la construction : 7 200 $", CARRYING_NOTE],
      ["Insurance during construction: $11,000", CARRYING_NOTE],
      ["Utilities during construction: $4,000", CARRYING_NOTE],
      ["Land carrying costs: $15,000", CARRYING_NOTE],
      ["Land holding costs: $15,000", CARRYING_NOTE],
    ];
    for (const [line, note] of lines) {
      const r = read(line);
      expect(pick(r), line).toEqual([]);
      expect(r.other.map((o) => o.note), line).toContain(note);
    }
  });
  test("a rebate or credit of a sales tax is a sales tax line, positive or negative", () => {
    for (const line of ["HST rebate (rental): -$95,000", "HST rebate: $95,000"]) {
      const r = read(line);
      expect(pick(r), line).toEqual([]);
      expect(r.other.map((o) => o.note), line).toContain(SALES_TAX_NOTE);
    }
  });
  test("a cost line that states its tax basis is still that cost", () => {
    expect(pick(read("Hard costs (incl. HST): $2,130,000"))).toEqual([["hard_cost", 2_130_000]]);
    expect(pick(read("Hard costs before HST: $1,950,000"))).toEqual([["hard_cost", 1_950_000]]);
    expect(pick(read("Hard costs, net of HST: $1,950,000"))).toEqual([["hard_cost", 1_950_000]]);
    expect(pick(read("Hard costs (HST exempt): $1,950,000"))).toEqual([["hard_cost", 1_950_000]]);
    expect(pick(read("Contingency on hard costs: $97,500"))).toEqual([["contingency", 97_500]]);
  });
  test("a loan, the interest reserve and a credit to other costs are still read", () => {
    expect(pick(read("Construction loan: $1,900,000"))).toEqual([["senior_loan_amount", 1_900_000]]);
    expect(pick(read("Prêt de construction : 1 900 000 $"))).toEqual([["senior_loan_amount", 1_900_000]]);
    expect(pick(read("Interest reserve: $96,000"))).toEqual([["stated_interest_reserve", 96_000]]);
    expect(pick(read("Other costs credit: -$4,000"))).toEqual([["other_cost", -4_000]]);
    expect(pick(read("Soft costs (insurance, permits, fees): $300,000"))).toEqual([["soft_cost", 300_000]]);
  });
  test("in a budget table the refused rows are not summed into the head and are shown with their notes", () => {
    const row = (label: string, amount: string, n: number) => [{ text: label, ref: `A${n}` }, { text: amount, ref: `B${n}` }];
    const table = {
      name: "Budget",
      rows: [
        [{ text: "Line item", ref: "A1" }, { text: "Amount", ref: "B1" }],
        row("Land", "$640,000", 2),
        row("Hard costs", "$1,950,000", 3),
        row("HST on construction", "$180,000", 4),
        row("Construction loan interest", "$96,000", 5),
        row("Property taxes during construction", "$7,200", 6),
      ],
    } as Table;
    const r = extractCandidates({ ...doc(), tables: [table] });
    expect(pick(r)).toEqual([["land_cost", 640_000], ["hard_cost", 1_950_000]]);
    expect(r.other.map((o) => [o.value, o.note])).toEqual([[180_000, SALES_TAX_NOTE], [96_000, INTEREST_NOTE], [7_200, CARRYING_NOTE]]);
  });
});

describe("audit of card 61d: a tax basis, a soft-cost fee and the French 'frais' are still read", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const budget = (...rows: [string, string][]) => {
    const cells = [["Line item", "Amount"], ...rows].map((r, i) => r.map((text, c) => ({ text, ref: `${"AB"[c]}${i + 1}` })));
    return pick(extractCandidates({ ...doc(), tables: [{ name: "Budget", rows: cells } as Table] }));
  };
  test("a cost line that states its tax basis another way is still that cost", () => {
    for (const line of ["Hard costs ex-GST: $990,000", "Hard costs (exclusive of HST): $990,000", "Hard costs + HST: $990,000"])
      expect(pick(read(line)), line).toEqual([["hard_cost", 990_000]]);
    for (const line of ["Land purchase price (HST not applicable): $640,000", "Land (no HST): $640,000"])
      expect(pick(read(line)), line).toEqual([["land_cost", 640_000]]);
    // A corrected figure on an ex-GST line is still a named conflict.
    expect(pick(read("Hard costs ex-GST: $990,000 — corrected signed build figure $1,040,000."))).toContainEqual(["hard_cost", 1_040_000]);
  });
  test("fees are soft costs, so a soft-cost row about fees is summed as before", () => {
    expect(budget(["Land", "$640,000"], ["Hard costs", "$1,950,000"], ["Soft costs - fees", "$25,000"])).toEqual([["land_cost", 640_000], ["hard_cost", 1_950_000], ["soft_cost", 25_000]]);
  });
  test("'frais' is a fee only on a loan; in French it is mostly a cost", () => {
    expect(budget(["Terrain", "640 000 $"], ["Frais de construction", "1 950 000 $"], ["Frais indirects", "300 000 $"])).toEqual([["land_cost", 640_000], ["hard_cost", 1_950_000], ["soft_cost", 300_000]]);
    for (const line of ["Frais du prêt de construction : 23 000 $", "Frais d'engagement du prêt : 23 000 $"]) {
      const r = read(line);
      expect(pick(r), line).toEqual([]);
      expect(r.other.map((o) => o.note), line).toContain("A fee or premium, not an input");
    }
  });
});

describe("card 61c: a budget line that is two lines, a rebate, or an amount paid so far is shown, not read", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const TWO_NOTE = "Two budget lines in one figure; enter each, or label it";
  const REBATE_NOTE = "A rebate or credit; enter it as a negative other cost if it reduces the cost";
  const PAID_NOTE = "A deposit or an amount already paid, not a budget line";
  const refused = (lines: string[], note: string) => {
    for (const line of lines) {
      const r = read(line);
      expect(pick(r), line).toEqual([]);
      expect(r.other.map((o) => o.note), line).toContain(note);
    }
  };

  test("a label that names two budget fields is two lines, not the longer one", () => {
    refused(
      [
        "Hard and soft costs: $3,300,000",
        "Land and hard costs: $4,100,000",
        "Land and land transfer tax: $820,000",
        "Purchase price plus land transfer tax: $820,000",
        "Soft costs and development charges: $385,000",
        "Hard costs & soft costs: $3,300,000",
        "Hard/soft costs: $3,300,000",
        "Land + hard costs: $4,100,000",
        "Coûts directs et indirects : 3 300 000 $",
      ],
      TWO_NOTE,
    );
  });
  test("an alias with a joiner, a list of what a head covers, and a pair with one field are read as before", () => {
    expect(pick(read("Design and permits: $90,000"))).toEqual([["soft_cost", 90_000]]);
    expect(pick(read("Soft costs, including permits and development charges: $300,000"))).toEqual([["soft_cost", 300_000]]);
    expect(pick(read("Land and closing costs: $820,000"))).toEqual([["land_cost", 820_000]]);
    expect(pick(read("Hard costs and construction costs: $3,000,000"))).toEqual([["hard_cost", 3_000_000]]);
  });
  test("a rebate, refund or credit stated as a positive figure is shown with the rebate note", () => {
    refused(["LTT rebate: $4,000", "Development charges rebate: $10,000", "Other costs rebate: $4,000", "Remboursement des droits de mutation : 4 000 $"], REBATE_NOTE);
  });
  test("a negative credit, a line of credit and a figure net of a rebate are read as before", () => {
    expect(pick(read("Other costs credit: -$4,000"))).toEqual([["other_cost", -4_000]]);
    expect(pick(read("Line of credit: $500,000"))).toEqual([]);
    expect(pick(read("Development charges, net of the rental rebate: $40,000"))).toEqual([["development_charges", 40_000]]);
  });
  test("an amount paid so far is shown with the paid note, not read as the line's budget", () => {
    refused(["Hard costs spent to date: $1,000,000", "Soft costs paid to date: $100,000", "Dev charges paid to date: $40,000", "Coûts indirects payés à ce jour : 100 000 $"], PAID_NOTE);
  });
  test("budget to date and cost to complete are read as they were", () => {
    expect(pick(read("Budget to date: $1,000,000"))).toEqual([]);
    expect(pick(read("Cost to complete: $1,000,000"))).toEqual([]);
  });
  test("in a budget table a row that names two lines is not summed and the land is read alone", () => {
    const row = (label: string, amount: string, n: number) => [{ text: label, ref: `A${n}` }, { text: amount, ref: `B${n}` }];
    const table = {
      name: "Budget",
      rows: [[{ text: "Line item", ref: "A1" }, { text: "Amount", ref: "B1" }], row("Hard and soft costs", "$3,300,000", 2), row("Land", "$640,000", 3)],
    } as Table;
    const r = extractCandidates({ ...doc(), tables: [table] });
    expect(pick(r)).toEqual([["land_cost", 640_000]]);
    expect(r.other.map((o) => [o.value, o.note])).toContainEqual([3_300_000, TWO_NOTE]);
  });
});

describe("every figure in a table is used or shown (task 65)", () => {
  const grid = (name: string, rows: string[][]): NormalizedDocument => ({
    kind: "pdf",
    lines: [],
    tables: [{ name, rows: rows.map((r, i) => r.map((text, j) => ({ text, ref: `${"ABCDEF"[j]}${i + 1}` }))) } as Table],
    pageCount: 1,
    needsOcr: false,
    // Thousands written with commas elsewhere in the document, so "1,950" is read as 1950.
    fullText: "Amounts such as 1,234,567 are written with commas.",
  });
  /** Every table cell that holds a money figure, a percent or a number of 1,000 or more (not a year) and is in no candidate's or shown figure's location. */
  const vanished = (d: NormalizedDocument): string[] => {
    const r = extractCandidates(d);
    const seen = new Set([...r.candidates, ...r.other].flatMap((c) => c.location.split(", ")));
    const holdsFigure = (text: string) => {
      const nums = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")));
      if (nums.length === 0) return false;
      if (/[$%]/.test(text)) return true;
      return nums.some((n) => n >= 1000 && !(Number.isInteger(n) && n >= 1900 && n <= 2100));
    };
    return d.tables.flatMap((t) => t.rows.flat()).filter((c) => holdsFigure(c.text) && !seen.has(c.ref)).map((c) => c.ref);
  };
  const shown = (d: NormalizedDocument) => extractCandidates(d).other.map((o) => [o.location, o.value, o.note]);
  const read = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.itemKey, c.value, c.location]);

  test("a plain row shows every figure after the first, with the row's own note", () => {
    const size = grid("Suites", [["101", "1 bed", "620", "$1,450"]]);
    expect(vanished(size)).toEqual([]);
    expect(shown(size)).toEqual([["C1", 620, "No field matches this label"], ["D1", 1450, "No field matches this label"]]);
    expect(read(size)).toEqual([]);
    const annual = grid("Units", [["Unit A", "1-bed", "1", "1,950", "23,400"]]);
    expect(vanished(annual)).toEqual([]);
    expect(shown(annual).map((s) => [s[0], s[1]])).toEqual([["B1", 1], ["C1", 1], ["D1", 1950], ["E1", 23400]]);
    expect(read(annual)).toEqual([]);
    const types = grid("Rents", [["Asking per suite", "$1,650", "$2,050", "$2,450"]]);
    expect(vanished(types)).toEqual([]);
    expect(shown(types)).toEqual([["B1", 1650, "No field matches this label"], ["C1", 2050, "No field matches this label"], ["D1", 2450, "No field matches this label"]]);
    expect(read(types)).toEqual([]);
  });

  test("a figure after one that was read is shown as another figure in the row", () => {
    const d = grid("Assumptions", [["Rent growth", "2%", "3%", "3.5%"]]);
    expect(read(d)).toEqual([["rent_growth_pct", null, 2, "B1"]]);
    expect(shown(d)).toEqual([["C1", 3, "Another figure in this row was used"], ["D1", 3.5, "Another figure in this row was used"]]);
    expect(vanished(d)).toEqual([]);
  });

  test("a budget row with an empty label cell is shown, never summed or totalled", () => {
    const named = grid("Budget", [["Category", "Item", "Amount"], ["Hard", "Framing", "$1,000,000"], ["Total project cost", "", "$4,101,500"]]);
    expect(vanished(named)).toEqual([]);
    expect(shown(named)).toContainEqual(["C3", 4101500, "No budget line matches this label"]);
    expect(extractCandidates(named).other.find((o) => o.location === "C3")!.context).toContain("Total project cost");
    // Card 109 names framing; the empty-label row remains shown.
    expect(read(named)).toEqual([["hard_cost", null, 1_000_000, "C2"]]);
    const beside = grid("Budget", [["Item", "Category", "Amount"], ["Framing", "Hard", "$1,000,000"], ["", "Total contract", "$2,148,500"]]);
    expect(vanished(beside)).toEqual([]);
    expect(shown(beside)).toContainEqual(["C3", 2148500, "No budget line matches this label"]);
    expect(extractCandidates(beside).other.find((o) => o.location === "C3")!.context).toContain("Total contract");
    expect(read(beside)).toEqual([["hard_cost", null, 1_000_000, "C2"]]);
  });

  test("a rent roll's total row is shown with the summary note; its suite numbers are not shown", () => {
    const roll = grid("Roll", [["Suite", "Type", "Area (sf)", "Monthly rent"], ["101", "1 bed", "620", "$1,450"], ["102", "2 bed", "820", "$1,850"], ["Total", "", "1,440", "$3,300"]]);
    expect(vanished(roll)).toEqual([]);
    expect(read(roll)).toEqual([
      ["unit_count", "1BR", 1, "A2"],
      ["rentable_area_sf", "1BR", 620, "C2"],
      ["unit_rent_monthly", "1BR", 1450, "D2"],
      ["unit_count", "2BR", 1, "A3"],
      ["rentable_area_sf", "2BR", 820, "C3"],
      ["unit_rent_monthly", "2BR", 1850, "D3"],
    ]);
    expect(shown(roll)).toEqual([["C4", 1440, "A rent roll's summary row is not an assumption"], ["D4", 3300, "A rent roll's summary row is not an assumption"]]);
  });

  test("a budget row's other columns are shown, never read", () => {
    const d = grid("Budget", [["Category", "Item", "Amount", "$ per unit", "% of total"], ["Hard", "Framing", "$1,000,000", "$100,000", "25%"]]);
    expect(vanished(d)).toEqual([]);
    expect(shown(d).filter((s) => s[2] === "Another column of this budget row; not read")).toEqual([["D2", 100000, "Another column of this budget row; not read"], ["E2", 25, "Another column of this budget row; not read"]]);
    expect(read(d)).toEqual([["hard_cost", null, 1_000_000, "C2"]]);
  });

  test("audit of card 65: a unit type's digit is not a figure, and a later figure that names a field says so", () => {
    // A later "1-bed" or "2 BR" is a unit type, not the figure 1 or 2. (A row's first figure is shown as before task 65.)
    expect(shown(grid("Units", [["Unit A", "$1,950", "1-bed"]])).map((s) => s[0])).not.toContain("C1");
    expect(shown(grid("Units", [["Unit B", "$2,150", "2 BR"]])).map((s) => s[0])).not.toContain("C1");
    // Nothing was read from the row, and 5.50% would be the exit cap rate: it is not "No field matches this label".
    const d = grid("Assumptions", [["Exit cap rate", "TBD 2026", "5.50%"]]);
    expect(read(d)).toEqual([]);
    expect(shown(d)).toContainEqual(["C1", 5.5, "A later figure in this row; Agir reads one figure per row. Label it if it is the one to use"]);
  });

  test("a row of years is not shown beyond what it was", () => {
    expect(shown(grid("Forecast", [["Year", "2025", "2026", "2027"]])).map((s) => s[0])).toEqual(["B1"]);
    expect(shown(grid("Forecast", [["Forecast for the first years"], ["2025", "2026", "2027"]]))).toEqual([]);
    expect(vanished(grid("Forecast", [["Year", "2025", "2026", "2027"]]))).toEqual([]);
  });
});

describe("a per-unit amount in a table cell is not the line's total (task 68)", () => {
  const PER_UNIT = "A per-door share of a cost, not the line's total; enter the total";
  const grid = (name: string, rows: string[][]): NormalizedDocument => ({
    kind: "pdf",
    lines: [],
    tables: [{ name, rows: rows.map((r, i) => r.map((text, j) => ({ text, ref: `${"ABCDEF"[j]}${i + 1}` }))) } as Table],
    pageCount: 1,
    needsOcr: false,
    fullText: "Amounts such as 1,234,567 are written with commas.",
  });
  const read = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.itemKey, c.value, c.location]);
  const shown = (d: NormalizedDocument) => extractCandidates(d).other.map((o) => [o.location, o.value, o.note]);

  test("audit of card 68: a budget table's per-unit amount and a per-unit loan cell are not the total", () => {
    const budget = grid("Budget", [["Line item", "Amount"], ["Land", "$900,000"], ["Hard costs", "$400,000 per unit"], ["Soft costs", "$520,000"]]);
    expect(read(budget).map((c) => [c[0], c[2]])).toEqual([["land_cost", 900000], ["soft_cost", 520000]]);
    expect(shown(budget)).toContainEqual(["B3", 400000, PER_UNIT]);
    const door = grid("Budget", [["Line item", "Amount"], ["Land", "$900,000"], ["Hard costs", "$400,000 / door"]]);
    expect(read(door).map((c) => c[0])).toEqual(["land_cost"]);
    const loan = grid("Financing", [["Senior loan", "$350,000 per unit"]]);
    expect(read(loan)).toEqual([]);
    expect(shown(loan)).toEqual([["B1", 350000, PER_UNIT]]);
  });

  test("a per-unit budget cell is refused and shown with the per-door note", () => {
    const d = grid("Budget", [["Hard costs", "$400,000 per unit"]]);
    expect(read(d)).toEqual([]);
    expect(shown(d)).toEqual([["B1", 400000, PER_UNIT]]);
  });

  test("a later cell for the same line is read, and the per-unit one is shown", () => {
    const d = grid("Budget", [["Hard costs", "$400,000 per unit", "$3,200,000"]]);
    expect(read(d)).toEqual([["hard_cost", null, 3200000, "C1"]]);
    expect(shown(d)).toEqual([["B1", 400000, PER_UNIT]]);
  });

  test("a French per-unit cell is refused", () => {
    const d = grid("Budget", [["Soft costs", "45 000 $ par logement"]]);
    expect(read(d)).toEqual([]);
  });

  test("a rent per unit per month and a plain total are as before", () => {
    const rent = grid("Assumptions", [["Rent", "$1,450 per unit per month"]]);
    expect(read(rent).length).toBe(1);
    expect(read(rent)[0]![2]).toBe(1450);
    const plain = grid("Budget", [["Hard costs", "$3,200,000"]]);
    expect(read(plain)).toEqual([["hard_cost", null, 3200000, "B1"]]);
    expect(shown(plain)).toEqual([]);
  });
});


describe("Moncton end-to-end reading faults (task 69)", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const grid = (rows: string[][]): NormalizedDocument => ({
    ...doc("Amounts such as 1,234,567 use comma grouping."),
    lines: [],
    tables: [{ name: "Invented rental schedule", rows: rows.map((r, i) => r.map((text, j) => ({ text, ref: `${"ABCD"[j]}${i + 1}` }))) } as Table],
  });
  const read = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);
  const shown = (d: NormalizedDocument) => extractCandidates(d).other.map((o) => [o.value, o.note]);

  test("audit of card 69: a plan type shaped like a suite id stays the type, and a labelled total monthly rent is not a unit rent", () => {
    const roll = grid([["Unit", "Type", "Monthly rent"], ["101", "A1", "1,900"], ["102", "A1", "1,900"], ["201", "B2", "2,300"]]);
    expect(read(roll)).toEqual([["unit_count", "A1", 2], ["unit_rent_monthly", "A1", 1900], ["unit_count", "B2", 1], ["unit_rent_monthly", "B2", 2300]]);
    for (const line of ["Total monthly rent: $19,475", "Gross monthly rent: $19,475", "Loyer mensuel total : 19 475 $"]) {
      expect(read(doc(line)).filter((c) => c[0] === "unit_rent_monthly")).toEqual([]);
      expect(shown(doc(line))).toContainEqual([19475, "A total of all units' rents, not a rent per unit"]);
    }
    expect(read(doc("Rent per unit: $1,450"))).toEqual([["unit_rent_monthly", "All units", 1450]]);
  });

  test("A: building monthly rent totals are shown rather than read as a unit rent", () => {
    for (const sentence of [
      "The completed rental schedule produces CAD 21,840 of monthly rent, or CAD 262,080 annually.",
      "We forecast total monthly rent of $21,840.",
      "The building earns gross monthly rent of $21,840.",
      "Our rent roll totals $21,840 per month.",
      "Le loyer mensuel total atteint 21 840 $.",
      "Les loyers mensuels totaux atteignent 21 840 $.",
    ]) {
      const d = doc(sentence);
      expect(read(d).filter((c) => c[0] === "unit_rent_monthly"), sentence).toEqual([]);
      expect(shown(d), sentence).toContainEqual([21840, "A total of all units' rents, not a rent per unit"]);
    }
    expect(read(doc("Each one-bedroom rents for $1,530 per month."))).toContainEqual(["unit_rent_monthly", "1BR", 1530]);
    expect(read(doc("Rent per unit: $1,530"))).toContainEqual(["unit_rent_monthly", "All units", 1530]);
  });

  test("B: equity words do not govern the following loan amount", () => {
    for (const noun of ["construction facility", "construction loan", "facility", "loan", "mortgage", "prêt", "financement"]) {
      const d = doc(`We will contribute CAD 630,000 of sponsor equity beside a CAD 1,920,000 ${noun}.`);
      expect(read(d).filter((c) => c[0] === "equity_amount"), noun).toEqual([["equity_amount", null, 630000]]);
      const loan = extractCandidates(d);
      expect(loan.candidates.some((c) => c.fieldKey === "senior_loan_amount" && c.value === 1920000) || loan.other.some((o) => o.value === 1920000 && o.note === "No field matches this label"), noun).toBe(true);
    }
    expect(read(doc("Sponsor equity: $630,000"))).toEqual([["equity_amount", null, 630000]]);
  });

  test("C: month ranges are indices while separately stated periods remain durations", () => {
    for (const sentence of [
      "Construction uses project months 2 through 14 while lease-up uses months 15 through 21.",
      "Construction uses project months 2 to 14 while lease-up uses months 15 to 21.",
      "Lease-up occupies month 15–21.",
      "La mise en location couvre les mois 15 à 21.",
    ]) {
      const d = doc(sentence, "Lease-up: 7 months", "Construction period of 13 months");
      expect(read(d).filter((c) => c[0] === "lease_up_months" || c[0] === "construction_months"), sentence).toEqual([["lease_up_months", null, 7], ["construction_months", null, 13]]);
      for (const value of sentence.includes("Construction") ? [2, 14, 15, 21] : [15, 21]) {
        expect(shown(d), sentence).toContainEqual([value, "A range is not a value; enter the figure to use"]);
      }
    }
  });

  test("D: letter-prefixed suite ids group by type without treating unit types as ids", () => {
    const rows = [
      ["Suite", "Type", "Size (sq ft)", "Monthly rent"],
      ["F01", "1-bed", "600", "1680"], ["B12", "1-bed", "615", "1680"],
      ["PH2", "2-bed", "830", "2070"], ["A-101", "2-bed", "845", "2070"], ["G-3", "2-bed", "860", "2070"],
      ["TOTAL", "", "3750", "9570"],
    ];
    expect(read(grid(rows))).toEqual([
      ["unit_count", "1BR", 2], ["rentable_area_sf", "1BR", 1215], ["unit_rent_monthly", "1BR", 1680],
      ["unit_count", "2BR", 3], ["rentable_area_sf", "2BR", 2535], ["unit_rent_monthly", "2BR", 2070],
    ]);
    const differing = rows.map((r) => [...r]);
    differing[2]![3] = "1695";
    differing[6]![3] = "9585";
    expect(read(grid(differing)).filter((c) => c[0] === "unit_count")).toEqual([["unit_count", "1BR", 2], ["unit_count", "2BR", 3]]);
    expect(read(grid(differing)).filter((c) => c[0] === "unit_rent_monthly")).toEqual([["unit_rent_monthly", "2BR", 2070]]);
    expect(shown(grid(differing))).toContainEqual([1680, "Suites of this type rent at different amounts; enter the rent to use"]);
    expect(shown(grid(differing))).toContainEqual([1695, "Suites of this type rent at different amounts; enter the rent to use"]);
    for (const type of ["2BR", "1-bed", "3 ch.", "Studio", "4½", "Bach"]) {
      const counts = read(grid([["Type", "Units", "Rent"], [type, "4", "1930"]])).filter((c) => c[0] === "unit_count");
      expect(counts, type).toHaveLength(1);
      expect(counts[0]![2], type).toBe(4);
    }
  });

  test("E: mortgage insurance premiums direct manual entry while lender fees keep their note", () => {
    for (const label of ["Mortgage insurance premium", "CMHC mortgage insurance premium", "MLI premium", "Sagen premium", "Canada Guaranty premium", "Prime d'assurance hypothécaire", "Prime SCHL"]) {
      const d = doc(`${label}: 3.80% of the base refinance amount`);
      expect(read(d), label).toEqual([]);
      expect(shown(d), label).toEqual([[3.8, "Mortgage insurance premium: enter it on Review as the refinance mortgage insurance premium"]]);
    }
    const fee = doc("Lender fee: 1.25%");
    expect(read(fee)).toEqual([]);
    expect(shown(fee)).toEqual([[1.25, "A fee or premium, not an input"]]);
  });
});


describe("an equity reimbursement is not equity, and plan types stay distinct (task 71)", () => {
  const NOTE = "Equity returned or left in after a refinance, not the equity contributed";
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf",
    lines: text.map((t, i) => ({ text: t, location: `page 1, line ${i + 1}` })),
    tables: [],
    pageCount: 1,
    needsOcr: false,
    fullText: text.join("\n"),
  });
  const grid = (rows: string[][]): NormalizedDocument => ({
    ...doc("Amounts use comma groups such as 1,234,567."),
    lines: [],
    tables: [{ name: "Invented plan schedule", rows: rows.map((r, i) => r.map((text, j) => ({ text, ref: `${"ABCD"[j]}${i + 1}` }))) } as Table],
  });
  const read = (d: NormalizedDocument) => extractCandidates(d).candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);
  const shown = (d: NormalizedDocument) => extractCandidates(d).other.map((o) => [o.value, o.note]);

  test.each([
    ...["will reimburse", "reimburses", "reimbursed", "is reimbursing", "will repay", "repays", "repaid", "is repaying", "will return", "returns", "returned", "is returning", "will distribute", "distributes", "distributed", "is distributing"].map((verb) => `CAD 285,000 ${verb} sponsor equity after refinancing.`),
    "Refinance proceeds of $285,000 are returned to the equity partners at closing.",
    ...["cash out", "cashed out", "are cashing out"].map((verb) => `We ${verb} CAD 285,000 of sponsor equity at refinance.`),
    "The sponsor cashes out CAD 285,000 of equity at refinance.",
    "The sponsor receives a CAD 285,000 cash-out of equity at refinancing.",
    ...["take out", "took out", "have taken out", "are taking out"].map((verb) => `We ${verb} CAD 285,000 of sponsor equity at refinance.`),
    "The sponsor takes out CAD 285,000 of equity at refinance.",
    "Le refinancement permet de rembourser 285 000 $ de capitaux propres.",
    "Le remboursement des capitaux propres atteint 285 000 $ au refinancement.",
    "Le promoteur va remettre 285 000 $ de capitaux propres aux partenaires.",
    "Le refinancement va distribuer 285 000 $ de capitaux propres.",
  ])("returned equity is shown: %s", (sentence) => {
    const d = doc(sentence);
    expect(read(d)).toEqual([]);
    expect(shown(d)).toEqual([[285000, NOTE]]);
  });

  test.each([
    "Equity left in the property after refinance is CAD 195,000.",
    "After refinancing, CAD 195,000 of sponsor equity is retained.",
    "The remaining equity after refinance is CAD 195,000.",
    "Les capitaux propres restants atteignent 195 000 $ après le refinancement.",
  ])("retained equity is shown: %s", (sentence) => {
    const d = doc(sentence);
    expect(read(d)).toEqual([]);
    expect(shown(d)).toEqual([[195000, NOTE]]);
  });

  test.each([
    "The balance of CAD 440,000 will reimburse sponsor equity after refinancing, leaving CAD 220,000 of original equity invested.",
    "Le remboursement des capitaux propres atteint 440 000 $, laissant 220 000 $ de capitaux propres.",
  ])("returned and retained equity do not conflict with contributed equity: %s", (sentence) => {
    const d = doc("Sponsor equity: $660,000", sentence);
    expect(read(d)).toEqual([["equity_amount", null, 660000]]);
    expect(shown(d)).toEqual([[440000, NOTE], [220000, NOTE]]);
  });

  test.each([
    "We plan to contribute CAD 660,000 of sponsor equity.",
    "Sponsor equity: $660,000",
    "Equity of $660,000 is contributed at closing.",
  ])("contributed equity remains readable: %s", (sentence) => {
    expect(read(doc(sentence))).toEqual([["equity_amount", null, 660000]]);
    expect(shown(doc(sentence))).toEqual([]);
  });

  // Audit of card 71: "return" as a noun or a yield, and "remaining" not said of equity, are not a return of equity.
  test.each([
    "The sponsor targets an 18% return on equity of $660,000.",
    "Equity of $660,000 should return 1.9x over the hold.",
    "The remaining $660,000 of equity is funded by the limited partner at closing.",
  ])("audit of card 71: contributed equity stays readable: %s", (sentence) => {
    expect(read(doc(sentence))).toEqual([["equity_amount", null, 660000]]);
  });

  test("a contribution stays readable beside a returned amount in the same clause", () => {
    const d = doc("We contribute CAD 660000 of sponsor equity alongside CAD 440000 returned to the equity partners at refinance.");
    expect(read(d)).toEqual([["equity_amount", null, 660000]]);
    expect(shown(d)).toEqual([[440000, NOTE]]);
  });

  test.each(["Units", "Count", "Number", "Nombre de logements"])("digit-ending plans stay distinct with the count column %s", (count) => {
    const d = grid([["Plan", count, "Monthly rent"], ["A1", "5", "1870"], ["A2", "2", "1980"], ["B2", "7", "2290"]]);
    expect(read(d)).toEqual([
      ["unit_count", "A1", 5], ["unit_rent_monthly", "A1", 1870],
      ["unit_count", "A2", 2], ["unit_rent_monthly", "A2", 1980],
      ["unit_count", "B2", 7], ["unit_rent_monthly", "B2", 2290],
    ]);
  });

  test("TH codes in an area-column roll with no count column still group as suites", () => {
    const d = grid([["Unit", "Area (sf)", "Rent per month"], ["TH-7", "710", "2470"], ["TH-8", "710", "2470"], ["TH-9", "750", "2470"]]);
    expect(read(d)).toEqual([["unit_count", "TH", 3], ["rentable_area_sf", "TH", 2170], ["unit_rent_monthly", "TH", 2470]]);
  });

  test("a separate suite and digit-ending plan column still group by plan", () => {
    const d = grid([["Unit", "Type", "Monthly rent"], ["111", "A1", "1870"], ["112", "A1", "1870"], ["211", "B2", "2290"]]);
    expect(read(d)).toEqual([["unit_count", "A1", 2], ["unit_rent_monthly", "A1", 1870], ["unit_count", "B2", 1], ["unit_rent_monthly", "B2", 2290]]);
  });

  test("a bedroom type with an explicit count keeps that count", () => {
    expect(read(grid([["Type", "Units", "Rent"], ["2BR", "4", "1920"]]))).toEqual([["unit_count", "2BR", 4], ["unit_rent_monthly", "2BR", 1920]]);
  });
});


describe("four inputs a person still types (task 73)", () => {
  const doc = (...text: string[]): NormalizedDocument => ({
    kind: "pdf", lines: text.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables: [], pageCount: 1, needsOcr: false, fullText: text.join("\n"),
  });
  const read = (...text: string[]) => extractCandidates(doc(...text));
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const ITEM = "An itemized operating cost: enter the total as fixed operating costs on Review.";
  const GOING = "A cap rate with no word about a sale or an exit may be the going-in rate; enter it by hand if it is the exit rate";

  test.each(["Amount", "Facility amount", "Loan amount", "Principal", "Montant", "Montant du prêt"])("A: %s follows the senior and take-out headings", (label) => {
    expect(pick(read("Construction facility", `${label}: $1,780,000`, "Rate: 6.25%", "Interest-only: 16 months", "Take-out loan", `${label}: $2,130,000`))).toEqual([
      ["senior_loan_amount", 1780000], ["senior_rate_pct", 6.25], ["senior_io_months", 16], ["refinance_amount", 2130000],
    ]);
  });
  test("A: Amount without a loan heading stays unmatched", () => {
    const r = read("Amount: $62,000");
    expect(pick(r)).toEqual([]);
    expect(r.other).toMatchObject([{ value: 62000, note: "No field matches this label" }]);
  });
  test.each(["Exit / valuation cap rate", "Exit or valuation cap rate", "Terminal / valuation cap rate", "Reversion / valuation cap rate", "Taux de capitalisation de sortie / valuation"])("B: %s names the exit assumption", (label) => {
    expect(pick(read(`${label}: 5.40%`))).toEqual([["exit_cap_rate_pct", 5.4]]);
  });
  test.each([
    ["Going-in cap rate", GOING],
    ["Valuation cap rate", 'This sentence names an output figure ("valuation"), which is never taken as an input'],
    ["Capitalization rate (appraisal)", GOING],
  ])("B: %s keeps its refusal", (label, note) => {
    const r = read(`${label}: 5.10%`);
    expect(pick(r)).toEqual([]);
    expect(r.other).toMatchObject([{ value: 5.1, note }]);
  });
  test.each(["Stabilized occupancy: 96%", "Occupancy at stabilization of 96%", "We assume 96% occupancy once leased up.", "Taux d'occupation stabilisé : 96 %", "The building is assumed to be 96% occupied."])("C: explicit occupancy already reads: %s", (line) => {
    expect(pick(read(line))).toEqual([["stabilized_occupancy_pct", 96]]);
  });
  // Audit of card 73: a stated stabilized vacancy keeps the existing complement rule (it is stated, and its source says vacancy); "vacancy rate" alone stays unread.
  test("C: a stabilized vacancy reads as occupancy, from the vacancy it states", () => {
    const r = read("Stabilized vacancy: 4%");
    expect(pick(r)).toEqual([["stabilized_occupancy_pct", 96]]);
    expect(r.candidates[0]!.unitSeen).toBe("% vacancy");
    expect(read("Vacancy rate: 4%").other).toMatchObject([{ value: 4, note: "No field matches this label" }]);
  });
  test.each([
    ["Property tax: $23,700", 23700], ["Insurance: $7,600", 7600], ["Utilities: $10,800", 10800],
    ["Repairs and maintenance: $9,400", 9400], ["Management (3% of EGI)", 3],
  ] as const)("D: %s is shown as an item, never a total", (line, value) => {
    const r = read("Appraisal operating costs", line);
    expect(pick(r)).toEqual([]);
    expect(r.other).toMatchObject([{ value, note: ITEM }]);
  });
  test("D: an appraisal list is not summed, and a stated total still reads", () => {
    const lines = ["Property tax: $23,700", "Insurance: $7,600", "Utilities: $10,800", "Repairs and maintenance: $9,400", "Management (3% of EGI)"];
    const r = read("Appraisal operating costs", ...lines);
    expect(pick(r)).toEqual([]);
    expect(r.other.map((o) => [o.value, o.note])).toEqual([23700, 7600, 10800, 9400, 3].map((v) => [v, ITEM]));
    expect(pick(read(...lines, "Total operating expenses: $58,900"))).toEqual([["fixed_opex_annual", 58900]]);
    const table = extractCandidates({ ...doc(), tables: [{ name: "Invented appraisal expenses", rows: [
      ["Property tax", "$23,700"], ["Insurance", "$7,600"], ["Utilities", "$10,800"], ["Caretaking", "$1,500"], ["Total operating expenses", "$58,900"],
    ].map((row, i) => row.map((text, j) => ({ text, ref: `${"AB"[j]}${i + 1}` }))) }] });
    expect(pick(table)).toEqual([["fixed_opex_annual", 58900]]);
  });
});

describe("card 93a", () => {
  const read = async (...lines: string[]) => extractCandidates(await parseDocument(new TextEncoder().encode(lines.join("\n") + "\n"), "p.txt"));
  const values = (r: ReturnType<typeof extractCandidates>) => r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value]);
  test("R1: refi names the refinance without matching refinish", async () => {
    for (const line of ["Refi at 5.1%, 40-year amortization", "Refi rate: 5.1%", "Refi amortization: 40 years"]) {
      const r = await read(line);
      expect(values(r)).toEqual(values(await read(line.replace("Refi", "Refinance"))));
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
      expect(r.candidates.length).toBeGreaterThan(0);
    }
    expect((await read("Refinish the entrance: $46,000")).candidates.some((c) => c.fieldKey?.startsWith("refinance_"))).toBe(false);
  });
  test("R2: an exit cap of is an input while a maximum cap remains a limit", async () => {
    for (const line of ["Our exit cap of 5.5%", "Exit cap of 5.5%"]) expect(values(await read(line))).toEqual([["exit_cap_rate_pct", null, 5.5]]);
    expect((await read("Maximum cap of 9%")).other).toMatchObject([{ value: 9, note: "A lender's limit, not the deal's figure" }]);
  });
  test("R3: going out names the exit, going in remains refused", async () => {
    for (const label of ["Going-out cap rate", "Going out cap", "Going out cap rate", "Going-out cap"]) expect(values(await read(`${label}: 5.25%`))).toEqual([["exit_cap_rate_pct", null, 5.25]]);
    const r = await read("Going-in cap rate: 5.0%");
    expect(values(r)).toEqual([]);
    expect(r.other).toMatchObject([{ value: 5, note: "A cap rate with no word about a sale or an exit may be the going-in rate; enter it by hand if it is the exit rate" }]);
  });
  test("R6: a loan basis after a percentage is not its interest rate", async () => {
    for (const [line, key, amount] of [["Senior loan $4,000,000 at 25% LTC", "senior_loan_amount", 4000000], ["Construction loan of $4,000,000 at 25% loan to cost", "senior_loan_amount", 4000000], ["Mezz $650,000 at 20% LTV", "mezz_loan_amount", 650000]] as const) {
      const r = await read(line);
      expect(values(r)).toContainEqual([key, null, amount]);
      expect(r.candidates.some((c) => c.fieldKey?.endsWith("rate_pct"))).toBe(false);
    }
    for (const tail of ["12% fixed", "12% fixed, 75% LTV"]) expect(values(await read(`Mezz $650,000 at ${tail}`))).toEqual([["mezz_loan_amount", null, 650000], ["mezz_rate_pct", null, 12]]);
  });
  test("R7: a purchase price is land cost unless it names a buyer or a unit basis", async () => {
    for (const line of ["Purchase price: $2,450,000", "Prix d'achat : 2 450 000 $", "Land purchase price: $2,450,000"]) expect(values(await read(line))).toEqual([["land_cost", null, 2450000]]);
    for (const line of ["Purchase price per unit: $650,000", "Buyer's purchase price: $2,450,000", "Two-bedroom purchase price: $650,000", "Purchase price on resale: $2,450,000"]) expect((await read(line)).candidates.some((c) => c.fieldKey === "land_cost")).toBe(false);
  });
  test("R8: complete unit figures do not borrow the next line's unit type", async () => {
    for (const first of ["4 units at $2,100/month", "Rent: $2,100/month"]) expect(values(await read(first, "2 two-bedroom units at $2,400/month"))).not.toContainEqual(["unit_rent_monthly", "2BR", 2100]);
    const expected = [["unit_count", "Studio", 4], ["unit_rent_monthly", "Studio", 1500], ["unit_count", "2BR", 2], ["unit_rent_monthly", "2BR", 2400]];
    expect(values(await read("4 studios at $1,500/month", "2 two-bedroom units at $2,400/month"))).toEqual(expected);
    expect(values(await read("4 studios at $1,500/month.", "2 two-bedroom units at $2,400/month."))).toEqual(expected);
    expect(values(await read("The senior lender will advance a loan of", "$4,000,000 at 6.4%"))).toContainEqual(["senior_loan_amount", null, 4000000]);
  });
});


vi.mock("tesseract.js", async (original) => {
  const actual = await original<typeof import("tesseract.js")>();
  return { ...actual, createWorker: vi.fn(actual.createWorker) };
});

describe("card 93b local OCR", () => {
  const scan = async (pages = 1) => {
    const { createCanvas } = await import("@napi-rs/canvas");
    const { scanPdf } = await import("@agir/testkit");
    const canvas = createCanvas(1700, 2200);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1700, 2200);
    ctx.fillStyle = "black"; ctx.font = "40px sans-serif";
    ctx.fillText("Terminal cap rate 5.5%", 100, 160);
    ctx.fillText("Senior loan $1,850,000 at 6.75%", 100, 250);
    return scanPdf(canvas.toBuffer("image/jpeg", 90), pages);
  };
  test("reads both lines with confidence locations and local language data", async () => {
    const { ocrPdf } = await import("../src/index.ts");
    const { createWorker } = await import("tesseract.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const bytes = await scan();
    const parsed = await parseDocument(bytes, "scan.pdf");
    expect(parsed.needsOcr).toBe(true);
    const result = await ocrPdf(bytes);
    expect(result.pageCount).toBe(1);
    expect(result.lines.map((l) => l.text)).toEqual(["Terminal cap rate 5.5%", "Senior loan $1,850,000 at 6.75%"]);
    for (const line of result.lines) expect(line.location).toMatch(/^page 1, line \d \(OCR, confidence \d+%\)$/);
    const found = extractCandidates({ ...parsed, ...result, fullText: result.lines.map((l) => l.text).join("\n") });
    expect(found.candidates).toContainEqual(expect.objectContaining({ fieldKey: "exit_cap_rate_pct", value: 5.5 }));
    const options = vi.mocked(createWorker).mock.calls.at(-1)![2]!;
    expect(options.gzip).toBe(true);
    expect(options.cacheMethod).toBe("none");
    expect(existsSync(join(options.langPath!, "eng.traineddata.gz"))).toBe(true);
    expect(existsSync(join(options.langPath!, "fra.traineddata.gz"))).toBe(true);
  }, 60_000);
  test("refuses 51 scanned pages before creating an OCR worker", async () => {
    const { ocrPdf } = await import("../src/index.ts");
    const { createWorker } = await import("tesseract.js");
    const calls = vi.mocked(createWorker).mock.calls.length;
    await expect(ocrPdf(await scan(51))).rejects.toThrow("This scanned PDF has more than 50 pages; Agir reads scans of up to 50 pages. Split it, or enter its values by hand.");
    expect(vi.mocked(createWorker).mock.calls.length).toBe(calls);
  }, 60_000);
});

describe("card 97e general Canadian reading rules", () => {
  const read = (lines: string[], tables: Table[] = []) => extractCandidates({
    kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables, pageCount: 1, needsOcr: false,
    fullText: [...lines, ...tables.flatMap((t) => t.rows.map((r) => r.map((c) => c.text).join(" ")))].join("\n"),
  });
  const values = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const terms = [["Interest rate", "4.7%"], ["Amortization", "35 years"], ["Interest-only period", "11 months"], ["Loan-to-value", "80%"]];
  const grid = (rows: string[][]): Table => ({
    name: "Committed terms", rows: rows.map((row, i) => row.map((text, j) => ({ text, ref: `A${i}-${j}` }))),
  });
  test.each(["Insured take-out commitment for Cedar Walk", "Permanent mortgage commitment for Alder Lane", "Engagement de prêt permanent assuré", "Engagement de financement de reprise"])("%s scopes both lines and unlocated tables to refinance", (title) => {
    for (const r of [read([title, ...terms.map(([label, value]) => `${label}: ${value}`)]), read([title], [grid(terms)])]) {
      expect(values(r)).toEqual(expect.arrayContaining([["refinance_rate_pct", 4.7], ["refinance_amort_years", 35], ["refinance_io_months", 11], ["refinance_ltv_pct", 80]]));
      expect(r.candidates.some((c) => c.fieldKey?.startsWith("senior_"))).toBe(false);
    }
  });
  test.each(["Construction facility commitment", "Feuille de modalités du prêt de construction"])("%s retains construction-loan scope", (title) => {
    const r = read([title], [grid(terms.slice(0,3))]);
    expect(values(r)).toEqual(expect.arrayContaining([["senior_rate_pct", 4.7], ["senior_amort_years", 35], ["senior_io_months", 11]]));
    expect(r.candidates.some((c) => c.fieldKey?.startsWith("refinance_"))).toBe(false);
  });
  test.each([
    ["Refinance month, months following construction commencement: 23", "refinance_month", 23],
    ["Mois du refinancement, mois depuis le début du chantier : 25", "refinance_month", 25],
    ["Hold period, years following stabilized operation 8", "hold_years", 8],
    ["Période de détention, années après la stabilisation : 7", "hold_years", 7],
    ["Lease-up duration, months after construction completion: 9", "lease_up_months", 9],
    ["Période de location, mois suivant la fin des travaux : 6", "lease_up_months", 6],
  ])("a unit stated in the label: %s", (line, field, value) => {
    const r = read([line as string]);
    expect(values(r)).toContainEqual([field, value]);
    expect(r.candidates.some((c) => c.fieldKey === "hard_cost")).toBe(false);
  });
  test.each([
    ["Deed transfer tax payable: $18,600", "land_transfer_tax", 18600],
    ["Droits de mutation à payer : 12 450,00 $ CAD", "land_transfer_tax", 12450],
    ["Development cost charges budget: $52,800", "development_charges", 52800],
    ["Capital cost charges payable: $41,200", "development_charges", 41200],
    ["Capital cost contribution allowed: $37,600", "development_charges", 37600],
    ["Redevances de développement prévues : 36 900,00 $ CAD", "development_charges", 36900],
  ])("Canadian cost name: %s", (line, field, value) => expect(values(read([line as string]))).toEqual([[field, value]]));
  test.each([
    ["Construction commitment: CAD 1,840,000.00", 1840000],
    ["Construction loan commitment: CA$ 2,375,000", 2375000],
    ["Construction commitment: 3 460 000,25 $ CAD", 3460000.25],
  ])("a Canadian currency mark belongs to the whole amount: %s", (line, value) => {
    const r = read([line as string]);
    expect(values(r)).toEqual([["senior_loan_amount", value]]);
    expect(r.candidates[0]!.unitSeen).toBe("CAD");
  });
  test.each([
    ["Lender's minimum debt coverage ratio covenant: 1.24x", 1.24],
    ["The lender requires a minimum debt coverage ratio covenant of 1.31x.", 1.31],
  ])("a covenant is a lender limit that is read: %s", (line, value) => expect(values(read([line as string]))).toEqual([["min_dscr_covenant", value]]));
  test.each([
    ["Total expenses are 35% of EGI.", "expense_ratio_pct", 35],
    ["Management fee: 4% of effective gross income", "variable_expense_pct", 4],
    ["Property management fee: 5% of EGI", "variable_expense_pct", 5],
    ["Fee: 2% of EGI", "variable_expense_pct", 2],
    ["Variable: 6% of EGI", "variable_expense_pct", 6],
    ["Gestion locative : 5 % du revenu brut effectif", "variable_expense_pct", 5],
    ["Frais de gestion : 4 % du revenu brut effectif", "variable_expense_pct", 4],
    ["Dépenses : 32 % du revenu brut effectif", "expense_ratio_pct", 32],
    ["Charges d'exploitation : 34 % du revenu brut effectif", "expense_ratio_pct", 34],
    ["Operating expenses: 33% of EGI", "expense_ratio_pct", 33],
    ["OPEX: 31% of EGI", "expense_ratio_pct", 31],
    ["Expenses: 36% of EGI", "expense_ratio_pct", 36],
  ])("an EGI percentage uses its own cost label: %s", (line, field, value) => {
    const r = read([line as string]);
    expect(values(r)).toEqual([[field, value]]);
    expect(r.candidates.some((c) => c.fieldKey === (field === "variable_expense_pct" ? "expense_ratio_pct" : "variable_expense_pct"))).toBe(false);
  });
  test.each(["Vacancy allowance: 3% of effective gross income", "Operating provision: 4% of effective gross income", "Recurring expense allowance: 6% of EGI", "Provision d'exploitation : 3 % du revenu brut effectif"])("an EGI basis alone does not name an expense input: %s", (line) => {
    expect(read([line]).candidates.some((c) => c.fieldKey === "variable_expense_pct" || c.fieldKey === "expense_ratio_pct")).toBe(false);
  });
  test("water charges in an operating budget are not development charges", () => {
    expect(read(["Operating budget", "Water and wastewater charges: $9,600"]).candidates.some((c) => c.fieldKey === "development_charges")).toBe(false);
    expect(values(read(["Capital cost charges: $132,000"]))).toEqual([["development_charges", 132000]]);
  });
  test.each(["Operating provision: 4% of equity", "Provision d'exploitation : 3 % des fonds propres"])("does not turn another basis into EGI: %s", (line) => expect(read([line]).candidates.some((c) => c.fieldKey === "variable_expense_pct")).toBe(false));
});

describe("card 100: a loan's rate written with a qualifier, as \"interest\", or after the amount", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const EN = "Construction loan: $4,200,000";
  const FR = "Prêt de construction : 4 200 000 $";
  test.each([
    [FR, "Taux annuel : 5,40 %"],
    [FR, "Taux fixe contractuel : 5,40 %"],
    [FR, "Taux nominal annuel : 5,40 %"],
    [FR, "Taux effectif : 5,40 %"],
    [FR, "Taux par an : 5,40 %"],
    [EN, "Rate, fixed: 5.40%"],
    [EN, "Rate per annum: 5.40%"],
    [EN, "Rate all-in: 5.40%"],
    [EN, "Contract interest: 5.40%"],
    [EN, "Stated interest: 5.40%"],
    [EN, "Interest, fixed per annum: 5.40%"],
    [FR, "Intérêt annuel : 5,40 %"],
    [FR, "Intérêt contractuel : 5,40 %"],
    [EN, "The facility bears interest at 5.40% per annum, calculated monthly."],
    [EN, "The loan will bear interest at 5.40% per annum."],
    [EN, "Advances under the facility bear interest at 5.40%."],
    [FR, "Le prêt portera intérêt au taux annuel fixe de 5,40 %, calculé mensuellement."],
    [FR, "Les avances porteront intérêt au taux fixe de 5,40 %."],
    [FR, "Le prêt porte intérêt au taux de 5,40 % l'an."],
    [EN, "Annual fixed rate: 5.40%"],
    [EN, "Interest: 5.40% per annum"],
  ])("the senior rate: %s / %s", (head, line) => expect(pick(read(head, line))).toEqual([["senior_loan_amount", 4200000], ["senior_rate_pct", 5.4]]));
  test("carried interest stays the promote", () => expect(pick(read(EN, "Carried interest: 20%"))).toEqual([["senior_loan_amount", 4200000], ["gp_promote_pct", 20]]));
  test.each([
    [["Mezzanine loan: $600,000", "Mezzanine interest: 11.00%"], [["mezz_loan_amount", 600000], ["mezz_rate_pct", 11]]],
    [["Mezz loan: $600,000", "Mezz interest (fixed): 11.00%"], [["mezz_loan_amount", 600000], ["mezz_rate_pct", 11]]],
    [["Mezzanine loan", "Annual interest: 11.00%"], [["mezz_rate_pct", 11]]],
    [["Prêt mezzanine", "Taux annuel : 11,00 %"], [["mezz_rate_pct", 11]]],
    [["Take-out commitment", "Contract interest: 4.30%"], [["refinance_rate_pct", 4.3]]],
    [["Permanent loan commitment", "Stated interest: 4.30%"], [["refinance_rate_pct", 4.3]]],
    [["Engagement de financement de reprise", "Taux annuel : 4,30 %"], [["refinance_rate_pct", 4.3]]],
    [["Engagement de financement de reprise", "Intérêt contractuel : 4,30 %"], [["refinance_rate_pct", 4.3]]],
  ])("another loan's rate: %j", (lines, expected) => expect(pick(read(...lines))).toEqual(expected));
  test.each([
    ["Construction loan: $4,200,000 at 6.10%.", [["senior_loan_amount", 4200000], ["senior_rate_pct", 6.1]]],
    ["Prêt de construction : 4 200 000 $ à 6,10 %.", [["senior_loan_amount", 4200000], ["senior_rate_pct", 6.1]]],
    ["Prêt de construction : 4 200 000 $ au taux de 6,10 %", [["senior_loan_amount", 4200000], ["senior_rate_pct", 6.1]]],
    ["Senior loan: $4,200,000 at 6.10% fixed", [["senior_loan_amount", 4200000], ["senior_rate_pct", 6.1]]],
    ["Mezzanine loan: $600,000 at 11%.", [["mezz_loan_amount", 600000], ["mezz_rate_pct", 11]]],
    ["Prêt mezzanine : 600 000 $ à 11 %", [["mezz_loan_amount", 600000], ["mezz_rate_pct", 11]]],
    ["Take-out loan: $3,900,000 at 4.30%", [["refinance_amount", 3900000], ["refinance_rate_pct", 4.3]]],
  ])("the rate beside the amount: %s", (line, expected) => expect(pick(read(line))).toEqual(expected));
  test.each([
    "Construction loan: $4,200,000 at 65% of cost.",
    "Construction loan: $4,200,000 at 65% LTC",
    "Construction loan: $4,200,000 at 70% LTV",
    "Construction loan: $4,200,000 at 60% of value",
    "Construction loan: $4,200,000 at 1.20 DCR",
    "Construction loan: $4,200,000 with 6.10%",
    "Construction loan: $4,200,000 at 6.10% interest only",
    "Prêt de construction : 4 200 000 $ à 6,10 % intérêts seulement",
    "Prêt de construction : 4 200 000 $ à 65 % du coût",
    "Prêt de construction : 4 200 000 $ à 75 % de la valeur",
  ])("a basis or another word beside the amount is not its rate: %s", (line) => expect(pick(read(line))).toEqual([["senior_loan_amount", 4200000]]));
  test.each([
    "Ownership interest: 20%", "Partnership interest: 20%", "Equity interest: 20%", "Working interest: 20%", "Minority interest: 20%",
    "Majority interest: 60%", "Controlling interest: 51%", "LP interest: 90%", "GP interest: 10%", "Profits interest: 15%",
    "Beneficial interest: 100%", "Participation: 25%", "Participation rate: 25%", "Interest coverage: 150%", "Interest reserve: 5%",
    "Interest income: 3%", "Intérêt minoritaire : 20 %", "Participation : 25 %", "Taux de participation : 25 %", "Réserve d'intérêts : 5 %",
    "Revenus d'intérêts : 3 %", "Taux de vacance annuel : 3 %",
  ])("never a loan rate: %s", (line) => {
    const r = read(EN, line);
    expect(r.candidates.some((c) => /_rate_pct$/.test(c.fieldKey ?? ""))).toBe(false);
  });
  test.each([
    "Deposit interest: 2%", "Purchaser deposits earn interest at 1.5% per annum.", "Investors earn interest at 8%.",
    "The limited partners receive interest at 8% on unreturned capital.", "Late payment interest: 2% per month", "Default interest: 18%",
    "Default rate: 18%", "Deposit rate: 2%", "Interest rate cap strike: 7%", "Interest on overdue amounts: 1.5%",
    "Intérêt sur les dépôts : 2 %", "Taux de pénalité : 18 %", "Les commanditaires reçoivent un intérêt de 8 %", "Taux d'intérêt sur les arrérages : 2 %", "Taux d'intérêt en cas de défaut : 18 %",
  ])("interest on deposits, a partner's capital or a late or default payment is not the loan's rate: %s", (line) => {
    const r = read(line);
    expect(r.candidates.some((c) => /_rate_pct$/.test(c.fieldKey ?? ""))).toBe(false);
    expect(r.other.length).toBeGreaterThan(0);
  });
  test("the promote and the preferred return still read beside a partner's interest", () => {
    expect(pick(read("Carried interest: 20%"))).toEqual([["gp_promote_pct", 20]]);
    expect(pick(read("LP preferred return: 8%"))).toEqual([["preferred_return_pct", 8]]);
  });
});

describe("card 101: the take-out's month, written as a timing label or as a loan that replaces another", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const HEAD = "Construction loan: $5,000,000";
  const REPLACED = "A later figure in the same sentence replaces this one";
  test.each([
    ["Refinance in month 28.", 28],
    ["A take-out loan repays the construction loan in month 28.", 28],
    ["The permanent loan replaces the construction facility at month 28.", 28],
    ["Le prêt permanent remplace le prêt de construction au mois 28.", 28],
    ["The take-out mortgage will replace the interim loan in month 30.", 30],
    ["A refinance loan replaces our bridge loan at month 26.", 26],
    ["Le financement permanent remplace le prêt intérimaire au mois 30.", 30],
    ["Le prêt de reprise remplacera le financement temporaire au mois 26.", 26],
    ["Take-out month: 24 months", 24],
    ["Refinance closing month: 30 months", 30],
    ["Take-out timing: 24 months", 24],
    ["Mois de la reprise : 24 mois", 24],
    ["Refi date: month 26", 26],
    ["Permanent loan timing: 22 months", 22],
    ["Moment du refinancement : 26 mois", 26],
    ["Date prévue du refinancement : mois 30", 30],
  ])("the refinance month: %s", (line, month) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5000000], ["refinance_month", month]]));
  test.each([
    "Take-out loan term: 24 months", "Refinance interest-only period: 24 months", "Take-out IO months: 24 months", "Take-out rate lock: 6 months",
    "Refinance maturity date: 60 months", "Durée du refinancement : 24 mois", "Échéance de la reprise : 60 mois", "Période de reprise : 24 mois",
    "Lease-up months before refinance: 12 months", "Date de reprise des travaux : 18 mois",
    "A new construction loan replaces the bridge loan at month 3.", "Le prêt permanent remplace le prêt de construction.",
  ])("not a refinance month: %s", (line) => expect(read(HEAD, line).candidates.some((c) => c.fieldKey === "refinance_month")).toBe(false));
  test.each([
    "Take-out timing: 24 months after completion", "Refinance date: 18 months after stabilization", "Take-out month: 6 months after substantial completion",
    "Mois de la reprise : 12 mois après la fin des travaux", "Date du refinancement : 18 mois suivant la stabilisation", "Moment de la reprise : 6 mois à compter de l'achèvement",
  ])("a month counted from a later event is shown, not read: %s", (line) => {
    const r = read(HEAD, line);
    expect(pick(r)).toEqual([["senior_loan_amount", 5000000]]);
    expect(r.other.some((o) => o.note === "A month counted from a later event, not the project month; enter the project month")).toBe(true);
  });
  test.each([
    ["Take-out timing: 30 months after construction start", 30], ["Refinance month: 30 months from first advance", 30], ["Mois de la reprise : 30 mois après le début des travaux", 30],
    ["Refinance in month 30 after construction start.", 30],
  ])("a month counted from the project's start is read: %s", (line, month) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5000000], ["refinance_month", month]]));
  test.each(["Refi notice month: 3 months", "Take-out deadline month: 36 months", "Refinance outside date: 36 months", "Take-out latest date: 36 months", "Date limite de reprise : 36 mois"])("a notice, deadline or outside date is not the refinance month: %s", (line) => {
    expect(read(HEAD, line).candidates.some((c) => c.fieldKey === "refinance_month")).toBe(false);
  });
  test.each([["Take-out planned month: 24 months", 24], ["Refinance expected date: 26 months", 26], ["Mois prévu de la reprise : 24 mois", 24]])("a planned take-out month is read: %s", (line, month) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5000000], ["refinance_month", month]]));
  test("a figure-like noun after the replaced loan keeps the replace rule", () => {
    const r = read(HEAD, "Our updated lender quote replaces the construction loan estimate of $4,600,000.");
    expect(pick(r)).toEqual([["senior_loan_amount", 5000000]]);
    expect(r.other.find((o) => o.value === 4600000)?.note).toBe(REPLACED);
  });
  test("a permanent loan that replaces another names no figure by itself", () => expect(pick(read(HEAD, "Le prêt permanent remplace le prêt de construction."))).toEqual([["senior_loan_amount", 5000000]]));
  test("a refinance amortization stays the refinance amortization", () => expect(pick(read(HEAD, "Refinance amortization: 30 years"))).toEqual([["senior_loan_amount", 5000000], ["refinance_amort_years", 30]]));
  test("a replacement loan is the take-out loan; the construction loan stays senior", () => {
    expect(pick(read(HEAD, "Replacement loan: $3,200,000", "Replacement interest: 5.40%", "Replacement amortization: 30 years")))
      .toEqual([["senior_loan_amount", 5000000], ["refinance_amount", 3200000], ["refinance_rate_pct", 5.4], ["refinance_amort_years", 30]]);
    expect(pick(read(HEAD, "Replacement mortgage: $3,200,000", "Replacement rate: 5.40%"))).toEqual([["senior_loan_amount", 5000000], ["refinance_amount", 3200000], ["refinance_rate_pct", 5.4]]);
    expect(pick(read("Prêt de construction : 5 000 000 $", "Prêt de remplacement : 3 200 000 $", "Financement de remplacement, taux : 5,40 %")))
      .toEqual([["senior_loan_amount", 5000000], ["refinance_amount", 3200000], ["refinance_rate_pct", 5.4]]);
  });
  test.each(["Replacement reserve: $250 per unit", "Replacement cost: $6,100,000", "Roof replacement: $90,000", "Remplacement des fenêtres : 80 000 $", "Réserve de remplacement : 300 $ par logement"])("not the take-out loan: %s", (line) => {
    expect(read(HEAD, line).candidates.some((c) => /^refinance_/.test(c.fieldKey ?? ""))).toBe(false);
  });
  test("a figure that replaces another figure keeps today's rule", () => {
    const r = read("Revised hard cost $1,710,000 replaces our earlier $1,560,000.");
    expect(pick(r)).toEqual([["hard_cost", 1710000]]);
    expect(r.other.find((o) => o.value === 1560000)?.note).toBe(REPLACED);
    const fr = read("Le coût de construction révisé de 1 710 000 $ remplace notre montant précédent de 1 560 000 $.");
    expect(fr.other.find((o) => o.value === 1560000)?.note).toBe(REPLACED);
    const mezz = read("the mezz term sheet came in at 1,150 bps, that replaces the 11% I mentioned");
    expect(mezz.other.find((o) => o.value === 11)?.note).toBe(REPLACED);
  });
});

describe("card 102: the build period and the lease-up, in common English and Quebec French wording", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const has = (line: string, key: string) => read(line).candidates.some((c) => c.fieldKey === key);
  test.each([
    ["Chantier : 16 mois", 16], ["Le chantier prendra dix-sept mois.", 17], ["Le chantier prend 16 mois", 16], ["Les travaux s'échelonneront sur 18 mois.", 18],
    ["Le chantier s'étalera sur 14 mois.", 14], ["Les travaux s'étendront sur 20 mois.", 20], ["Durée du chantier : 15 mois", 15], ["Durée des travaux de construction : 19 mois", 19],
    ["Calendrier des travaux : 21 mois", 21], ["Build window: 15 months", 15], ["Build time: 13 months", 13], ["Time to build: 18 months", 18],
    ["Construction timeline: 22 months", 22], ["Construction program: 17 months", 17], ["Construction programme: 16 months", 16],
  ])("the build period: %s", (line, months) => expect(pick(read(line))).toEqual([["construction_months", months]]));
  test.each([
    ["Letting period: 5 months", 5], ["Initial letting: 7 months", 7], ["Letting: 6 months", 6], ["Absorption locative : 6 mois", 6], ["Rent-up: 8 months", 8],
    ["Rent up: 9 months", 9], ["Rent-up period: 10 months", 10], ["Période d'absorption locative : 11 mois", 11], ["Location initiale des logements : 6 mois", 6],
    ["Délai de location : 4 mois", 4],
  ])("the lease-up: %s", (line, months) => expect(pick(read(line))).toEqual([["lease_up_months", months]]));
  test.each([
    ["We expect 15 months of construction, then 5 months to let.", 15, 5],
    ["Échéancier : 16 mois de construction, puis 6 mois de location.", 16, 6],
    ["Plan on 14 months of building, then 6 months of lease-up.", 14, 6],
    ["About 16 months on site, then 7 months to fill the building.", 16, 7],
    ["Prévoir 18 mois de travaux, puis 8 mois de mise en location.", 18, 8],
    ["Comptez 20 mois de chantier; ensuite 5 mois pour remplir l'immeuble.", 20, 5],
    ["Plan 13 months on site and 9 months of leasing.", 13, 9],
    ["Allow 12 months of building, then 4 months of letting.", 12, 4],
  ])("the noun after the number names the period: %s", (line, build, lease) => expect(pick(read(line))).toEqual([["construction_months", build], ["lease_up_months", lease]]));
  test.each(["Chantier : 1 200 000 $", "Construction loan term: 24 months", "Prêt de construction, terme : 24 mois", "Garantie du chantier : 12 mois", "Assurance chantier : 18 mois",
    "Début du chantier : mois 3", "Délai avant le chantier : 4 mois", "Construction start: month 4", "Construction loan: 24 months of construction", "Prêt de construction : 24 mois de chantier",
    "Interest reserve: 18 months of construction interest", "We budget 24 months of construction financing.", "Construction loan: 16 months to build"])("not the build period: %s", (line) => expect(has(line, "construction_months")).toBe(false));
  test.each(["Letting fee: 2 months", "Notice period before letting: 2 months", "Incitatif : 1 mois de location gratuite.", "We offer 2 months of leasing incentives.", "Lease term: 10 years",
    "Initial letting term: 10 years", "Commercial lease: 10 years to let", "Bail commercial : 10 ans pour louer", "Bail : 5 ans de location", "Absorption: 2 units per month", "Absorption: 3 sales per month", "Rent up 3% per year"])("not the lease-up: %s", (line) => expect(has(line, "lease_up_months")).toBe(false));
  test.each(["Absorption: 2 units per month", "Sales pace: 4 units per month", "Absorption: 5 units a month", "Pace: 2 units/month", "Absorption : 3 unités par mois", "Rythme : 2 ventes par mois"])("a pace is not a count: %s", (line) => {
    const r = read(line);
    expect(pick(r)).toEqual([]);
    expect(r.other.some((o) => o.note === "A sales pace, not the number of units")).toBe(true);
  });
  test.each([["Units: 24", "All units", 24], ["Studios: 12 units", "Studio", 12]])("a count is still a count: %s", (line, item, n) => expect(read(line).candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", item, n]]));
  test("rent growth is not a rent-up", () => expect(pick(read("Rent growth: 3%"))).toEqual([["rent_growth_pct", 3]]));
});

describe("card 102 audit: a loan's term named after its figure, a figure the sentence says is not a field, and \"to fill\"", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const TERM = "A loan's term, not the build period, hold or amortization";
  test.each([
    ["Do not treat the 24-month legal term as either IO or build time.", 24], ["Do not treat the 36-month legal term as either IO or build time.", 36],
    ["Never count the 30-month loan term as letting time.", 30], ["Please do not read the 20-month facility term as build time.", 20],
    ["The 18-month maturity is not the construction period.", 18], ["A 27-month outside maturity applies; it is not the lease-up.", 27],
    ["Ne pas traiter le terme de 24 mois comme la durée du chantier.", 24], ["L'échéance de 36 mois n'est pas la période de location.", 36],
    ["Le prêt a une échéance de 30 mois; ne pas la compter comme durée des travaux.", 30],
  ])("a loan's term named by its own words is shown, not read: %s", (line, n) => {
    const r = read(line);
    expect(pick(r)).toEqual([]);
    expect(r.other.find((o) => o.value === n)?.note).toBe(TERM);
  });
  test.each([
    "The lease-up is not 6 months; it is 9 months.", "Do not treat 14 months as the build time.", "Never count 4 months of leasing as the lease-up.",
    "La période de location n'est pas 6 mois; elle est de 9 mois.", "Ne pas traiter 14 mois comme la durée du chantier.",
  ])("a figure the sentence says is not a field gives nothing from it: %s", (line) => {
    const r = read(line);
    expect(r.candidates.some((c) => c.value === 6 || c.value === 14 || c.value === 4)).toBe(false);
  });
  test("the other clause of a negated sentence still reads", () => {
    expect(pick(read("The lease-up is not 6 months; it is 9 months."))).toEqual([]);
    expect(pick(read("Construction will take 16 months, not counting the permit wait."))).toEqual([["construction_months", 16]]);
    expect(pick(read("Build time: 16 months"))).toEqual([["construction_months", 16]]);
    expect(pick(read("Interest-only: 24 months"))).toEqual([["senior_io_months", 24]]);
  });
  test.each([
    ["6 months to fill.", 6], ["8 months to fill the units", 8], ["We allow 7 months to fill the building.", 7], ["Plan 9 months to fill the project.", 9],
    ["We expect 5 months to fill the suites.", 5], ["5 mois pour remplir les logements", 5], ["Comptez 4 mois pour remplir l'immeuble.", 4],
  ])("\"to fill\" a building or its units is the lease-up: %s", (line, n) => expect(pick(read(line))).toEqual([["lease_up_months", n]]));
  test.each(["We need 6 months to fill the staff positions.", "Allow 3 months to fill the retention pond.", "Il faut 2 mois pour remplir les formulaires du permis."])("\"to fill\" anything else is not the lease-up: %s", (line) => {
    expect(read(line).candidates.some((c) => c.fieldKey === "lease_up_months")).toBe(false);
  });
});

describe("card 103: French budget words for soft costs and contingency", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const FEE = "A fee or premium, not an input";
  test.each([
    ["Honoraires 240 000 $", "soft_cost", 240_000], ["Honoraires et frais 310 000 $", "soft_cost", 310_000], ["Honoraires et frais connexes 185 000 $", "soft_cost", 185_000],
    ["Frais et honoraires 205 000 $", "soft_cost", 205_000], ["Honoraires professionnels et frais 275 000 $", "soft_cost", 275_000],
    ["Réserve pour aléas 150 000 $", "contingency", 150_000], ["Aléas 90 000 $", "contingency", 90_000], ["Provision pour imprévus 120 000 $", "contingency", 120_000],
    ["Réserve aléas 80 000 $", "contingency", 80_000], ["Provision pour aléas 95 000 $", "contingency", 95_000], ["Réserve pour imprévus 70 000 $", "contingency", 70_000],
    ["Réserve pour contingences 60 000 $", "contingency", 60_000], ["Contingence de construction 110 000 $", "contingency", 110_000],
  ])("a budget-table row: %s", (row, key, n) => expect(pick(read("Poste Montant", "Coût du terrain 310 000 $", row))).toEqual([["land_cost", 310_000], [key, n]]));
  test.each([
    ["Honoraires : 240 000 $", "soft_cost", 240_000], ["Honoraires et frais : 310 000 $", "soft_cost", 310_000], ["Honoraires et frais connexes : 185 000 $", "soft_cost", 185_000],
    ["Frais et honoraires : 205 000 $", "soft_cost", 205_000], ["Honoraires professionnels et frais : 275 000 $", "soft_cost", 275_000],
    ["Réserve pour aléas : 150 000 $", "contingency", 150_000], ["Aléas : 90 000 $", "contingency", 90_000], ["Provision pour imprévus : 120 000 $", "contingency", 120_000],
    ["Réserve aléas : 80 000 $", "contingency", 80_000], ["Provision pour aléas : 95 000 $", "contingency", 95_000], ["Réserve pour imprévus : 70 000 $", "contingency", 70_000],
    ["Réserve pour contingences : 60 000 $", "contingency", 60_000], ["Contingence de construction : 110 000 $", "contingency", 110_000],
  ])("a budget line: %s", (line, key, n) => expect(pick(read(line))).toEqual([[key, n]]));
  test.each([
    "Honoraires de courtage : 45 000 $", "Honoraires du prêteur : 1 %", "Honoraires du prêteur : 25 000 $", "Frais de financement : 60 000 $", "Honoraires de garantie : 15 000 $",
    "Honoraires de gestion : 4 %", "Honoraires : 3 %", "Honoraires de gestion : 30 000 $", "Honoraires juridiques du financement : 20 000 $", "Honoraires d'engagement : 0,5 %",
    "Courtage - honoraires : 40 000 $", "Honoraires (prêteur) : 25 000 $", "Le prêteur exige des honoraires de 1 %.", "Les honoraires du courtier sont de 45 000 $.",
  ])("a fee that is not the project's soft costs: %s", (line) => expect(read(line).candidates.some((c) => c.fieldKey === "soft_cost")).toBe(false));
  test.each(["Honoraires de courtage 45 000 $", "Honoraires du prêteur 25 000 $", "Honoraires de garantie 15 000 $", "Frais de financement 60 000 $", "Courtage honoraires 40 000 $", "Honoraires (prêteur) 25 000 $"])("a financing fee row in a budget table is not soft costs: %s", (row) => {
    expect(read("Poste Montant", "Coût du terrain 310 000 $", row).candidates.some((c) => c.fieldKey === "soft_cost")).toBe(false);
  });
  test.each([["Honoraires de gestion : 4 %", 4], ["Honoraires du prêteur : 1 %", 1], ["Honoraires de courtage : 45 000 $", 45_000], ["Honoraires : 3 %", 3], ["Le prêteur exige des honoraires de 1 %.", 1], ["Courtage - honoraires : 40 000 $", 40_000]])("a fee keeps its note: %s", (line, n) => {
    const r = read(line);
    expect(pick(r)).toEqual([]);
    expect(r.other.find((o) => o.value === n)?.note).toBe(FEE);
  });
  test("a plain sentence on the fees is still the soft-cost line", () => expect(pick(read("Les honoraires sont de 240 000 $."))).toEqual([["soft_cost", 240_000]]));
  test.each(["Les aléas climatiques ont retardé le chantier de 3 semaines.", "Aléas climatiques : 2 semaines de retard", "Les aléas du marché ont coûté 40 000 $ au vendeur l'an dernier.", "Aléas de chantier : 12 jours"])("\"aléas\" that is not a cost line is not the contingency: %s", (line) => {
    expect(read(line).candidates.some((c) => c.fieldKey === "contingency")).toBe(false);
  });
});

describe("card 103 audit: a part included in a line, and the writer's own fee, are not that line", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  test.each([
    ["Contribution de réseau comprise dans les honoraires : 18 000,50 $.", 18_000.5], ["Contribution déjà incluse aux honoraires : 22 500 $.", 22_500],
    ["Permit fees included in soft costs: $35,000", 35_000], ["Les frais de permis compris dans les honoraires : 35 000 $", 35_000],
    ["Survey costs, part of the soft costs: $12,000", 12_000], ["Testing allowance within the contingency: $40,000", 40_000],
    ["Frais d'arpentage inclus dans les coûts indirects : 9 000 $", 9_000], ["Étude de sol, fait partie des honoraires : 14 000 $", 14_000],
    ["Winter heating already in hard costs: $55,000", 55_000], ["Signage covered by the contingency: $8,000", 8_000], ["Clôture de chantier déjà dans les imprévus : 6 000 $", 6_000],
  ])("a part said to be included in a line is not that line: %s", (line, n) => {
    const r = read(line);
    expect(pick(r)).toEqual([]);
    expect(r.other.find((o) => o.value === n)?.note).toBe("A part included in another line, not that line");
  });
  test.each([["Nos honoraires : 4 500 $", 4_500], ["Our professional fees: $4,500", 4_500], ["Mes honoraires pour ce mandat : 2 000 $", 2_000], ["Notre honoraires : 3 200 $", 3_200], ["My fees: $1,800", 1_800]])("the writer's own fee is not the project's soft costs: %s", (line, n) => {
    const r = read(line);
    expect(r.candidates.some((c) => c.fieldKey === "soft_cost")).toBe(false);
    expect(r.other.find((o) => o.value === n)?.note).toBe("The writer's own fee, not the project's soft costs");
  });
  test.each([["Honoraires : 240 000 $", 240_000], ["Soft costs: $450,000", 450_000], ["Professional fees: $310,000", 310_000], ["Soft costs (including permits): $500,000", 500_000]])("the line itself still reads: %s", (line, n) => expect(pick(read(line))).toEqual([["soft_cost", n]]));
});

describe("card 104: the minimum coverage covenant in ordinary lender wording", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const LOAN = "Construction loan: $5,000,000";
  const covenant = (r: ReturnType<typeof read>) => r.candidates.some((c) => c.fieldKey === "min_dscr_covenant");
  test.each([
    ["DCR floor: 1.20x", 1.2], ["DSCR floor: 1.25x", 1.25], ["Required coverage: 1.20x", 1.2], ["Coverage requirement: 1.20x", 1.2],
    ["Covenant: DCR of 1.20x tested annually", 1.2], ["Maintenance DCR floor 1.25x applies through operations", 1.25], ["The borrower must maintain a DSCR of 1.25x.", 1.25],
    ["Minimum coverage: 1.20x", 1.2], ["Debt coverage ratio: 1.20x minimum", 1.2],
    ["Lender's required DCR: 1.30x", 1.3], ["DSCR must be at least 1.25x.", 1.25], ["Debt service coverage threshold: 1.10x", 1.1],
    ["DSCR: minimum 1.20x", 1.2], ["The borrower shall maintain a DCR of 1.15 throughout the term.", 1.15], ["Coverage floor of 1.25x, tested quarterly", 1.25],
  ])("English: %s", (line, value) => expect(pick(read(LOAN, line as string))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", value]]));
  test.each([
    ["Ratio de couverture exigé : 1,20", 1.2], ["Seuil du RCD : 1,20x", 1.2], ["Plancher de couverture : 1,20x", 1.2],
    ["Couverture requise : 1,25x", 1.25], ["RCD exigé : 1,20", 1.2], ["L'emprunteur doit maintenir un RCD de 1,25x.", 1.25], ["Exigence de couverture : 1,15x", 1.15],
    ["Plancher du RCD : 1,25x", 1.25], ["Le RCD doit être d'au moins 1,20.", 1.2], ["Seuil de couverture minimal : 1,10x", 1.1],
  ])("French: %s", (line, value) => expect(pick(read(LOAN, line as string))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", value]]));
  test("keep: a projected DSCR is shown as an output figure, and one at stabilization reads nothing", () => {
    const projected = read(LOAN, "Projected DSCR: 1.45x");
    expect(pick(projected)).toEqual([["senior_loan_amount", 5_000_000]]);
    expect(projected.other.find((o) => o.value === 1.45)?.note).toContain("output figure");
    expect(pick(read(LOAN, "DSCR at stabilization: 1.38x"))).toEqual([["senior_loan_amount", 5_000_000]]);
  });
  test.each([
    "RCD projeté : 1,45", "DSCR under a 100 bps shock: 1.05x", "Interest coverage ratio: 2.10x", "Minimum interest coverage: 1.50x", "Ratio de couverture des intérêts minimal : 2,0x",
    "Actual DSCR: 1.32x", "Underwritten DSCR: 1.30x", "Stabilized DSCR at the required rate: 1.40x", "Calculated DCR vs minimum: 1.28x", "DSCR stress test: 1.05x",
    "RCD réel minimal atteint : 1,32x", "RCD stabilisé exigé : 1,40", "Equity multiple of at least 1.8x", "DCR floor: 75%", "DSCR covenant headroom: 0.25x",
    "Rent coverage test: 1.15x", "Liquidity coverage minimum 1.5x", "Fixed charge coverage minimum: 1.20x", "Cash sweep trigger DSCR floor: 1.10x",
    "DSCR test result: 1.35x", "Covenants: DSCR 1.35x projected vs 1.20x required", "Insurance coverage minimum: $2,000,000",
  ])("never the covenant: %s", (line) => expect(covenant(read(LOAN, line))).toBe(false));
  test.each(["DSCR: 1.45x (minimum 1.20x)", "DSCR: 1.45x vs 1.20x required", "Coverage: 1.45x against a 1.20x floor", "RCD : 1,45x, minimum 1,20x"])("beside a result, only the minimum is the covenant: %s", (line) => {
    expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", 1.2]]);
  });
  test.each([["Minimum DSCR during interest-only period: 1.20x", 1.2], ["Minimum DSCR on in-place rents: 1.20x", 1.2], ["DSCR covenant: 1.20x", 1.2], ["The lender's DSCR threshold is 1.2.", 1.2]])("a covenant still reads: %s", (line, value) => {
    expect(pick(read(LOAN, line as string))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", value]]);
  });
  test("a margin over the covenant is shown, not read", () => {
    const r = read(LOAN, "DSCR covenant headroom: 0.25x");
    expect(r.other.find((o) => o.value === 0.25)?.note).toBe("A coverage result or a margin over the covenant, not the minimum covenant");
  });
  test("a table row reads the covenant", () => {
    const r = extractCandidates({ kind: "docx", lines: [], tables: [{ name: "Terms", rows: [["DCR floor", "1.20x"], ["Seuil du RCD", "1,25x"], ["Projected DSCR", "1.45x"]].map((row, i) => row.map((text, c): Cell => ({ text, ref: `R${i + 1}C${c + 1}` }))) }], pageCount: 1, needsOcr: false, fullText: "" });
    expect(pick(r)).toEqual([["min_dscr_covenant", 1.2], ["min_dscr_covenant", 1.25]]);
  });
  test.each(["Min DSCR in year 1: 1.28x", "DSCR floor in year 2: 1.25x", "RCD minimal à l'an 2 : 1,25", "Minimum DSCR, phase 2: 1.30x", "Minimum DSCR for tranche 2 of 1.25x", "Seuil du RCD au mois 3 : 1,20x", "Required coverage in period 1: 1.15x"])("a year, month or phase number is never the covenant: %s", (line) => {
    const r = read(LOAN, line);
    expect(r.candidates.some((c) => c.fieldKey === "min_dscr_covenant" && Number.isInteger(c.value))).toBe(false);
  });
  test.each([
    ["The DSCR must not fall below 1.20x.", 1.2], ["Coverage shall not be less than 1.20x", 1.2], ["Le RCD ne doit pas être inférieur à 1,20", 1.2],
    ["The DCR may not drop below 1.15x.", 1.15], ["Debt coverage must not go below 1.25x", 1.25], ["Le ratio de couverture ne doit pas descendre sous 1,25x.", 1.25], ["La couverture ne doit pas être inférieure à 1,10.", 1.1],
  ])("a requirement stated as a floor not to cross: %s", (line, value) => expect(pick(read(LOAN, line as string))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", value]]));
  test.each(["DSCR fell below 1.20x in the stress case", "The DCR dropped below 1.15x last year.", "Le RCD est descendu sous 1,20 l'an dernier."])("a coverage that fell is a result, not the covenant: %s", (line) => {
    expect(covenant(read(LOAN, line))).toBe(false);
  });
  test.each([
    "DSCR test: 1.20x", "Credit test DCR 1.15x", "Sizing test: DSCR 1.25x", "Test de RCD avant la reprise : 1,15x", "The 1.10x coverage test belongs to the permanent lender, not to us.",
    "Take-out test: debt coverage of 1.20x", "DCR tested at 1.18x for the first advance", "Test de couverture du prêteur permanent : 1,20x", "RCD testé à 1,25x pour le dimensionnement",
  ])("a test alone is not the covenant: %s", (line) => expect(covenant(read(LOAN, line))).toBe(false));
  test.each([["Covenant: DCR of 1.20x tested annually", 1.2], ["Minimum DSCR test: 1.20x", 1.2], ["Test du RCD minimal : 1,20x", 1.2], ["DSCR floor test: 1.25x", 1.25]])("a test with a requirement word still reads: %s", (line, value) => {
    expect(pick(read(LOAN, line as string))).toEqual([["senior_loan_amount", 5_000_000], ["min_dscr_covenant", value]]);
  });
  test("a coverage limit of another kind keeps the limit note", () => {
    expect(read(LOAN, "Minimum interest coverage: 1.50x").other.find((o) => o.value === 1.5)?.note).toBe("A lender's limit, not the deal's figure");
    expect(read("Minimum cash equity of $2,400,000").other.find((o) => o.value === 2_400_000)?.note).toBe("A lender's limit, not the deal's figure");
  });
  test.each([["Mezzanine term sheet", "DCR floor: 1.30x"], ["Financement mezzanine", "Seuil du RCD : 1,30x"], ["Second mortgage offer", "Required coverage: 1.25x"]])("mezzanine still refuses the covenant: %s", (heading, line) => {
    expect(covenant(read(heading, line))).toBe(false);
  });
  test.each([["Take-out commitment", "DCR floor: 1.15x", 1.15], ["Offre de refinancement", "Plancher de couverture : 1,20x", 1.2]])("the take-out reads the covenant: %s", (heading, line, value) => {
    expect(pick(read(heading as string, line as string))).toEqual([["min_dscr_covenant", value]]);
  });
});

describe("card 105: trade shorthand for operating and loan assumptions", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const LOAN = "Construction loan: $5,000,000";
  const positives: [string, string, number][] = [
    ...["Terminal cap: 5.60%", "Exit cap: 5.60%", "Going-out cap rate: 5.60%", "Taux de capitalisation à la sortie : 5,60 %", "Cap de revente : 5,60 %"].map((s): [string, string, number] => [s, "exit_cap_rate_pct", 5.6]),
    ["Resale cap: 5.70%", "exit_cap_rate_pct", 5.7], ["Sale cap: 5.70%", "exit_cap_rate_pct", 5.7], ["Reversion cap rate: 5.40%", "exit_cap_rate_pct", 5.4],
    ...["Stab. occ.: 95%", "Stabilized occ. 95%", "Occupation à maturité : 95 %", "Stabilized occupancy: 95%", "Occupation stabilisée : 95 %"].map((s): [string, string, number] => [s, "stabilized_occupancy_pct", 95]),
    ["We underwrite stabilized occupancy at 95.5%.", "stabilized_occupancy_pct", 95.5],
    ...["Expense load: 34%", "Operating expenses: 34% of EGI", "Expense ratio: 34%", "Ratio des dépenses : 34 %"].map((s): [string, string, number] => [s, "expense_ratio_pct", 34]),
    ...["Amort.: 30 yr", "Sr amort. 30 yr", "Amortization: 30 years", "Amortissement : 30 ans"].map((s): [string, string, number] => [s, "senior_amort_years", 30]),
    ["Senior amort 25 years", "senior_amort_years", 25], ["Mezz amort.: 10 yr", "mezz_amort_years", 10], ["Take-out amort. 35 yr", "refinance_amort_years", 35],
  ];
  test.each(positives)("requested positive: %s", (line, key, value) => {
    expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000], [key, value]]);
  });
  test.each([
    "Going-in cap rate: 5.20%", "Cap rate at purchase: 5.20%", "Market cap rate: 5.10%", "Interest rate cap: 7.00%", "Fee cap: 2%", "Cap on cost overruns: 5%", "Sales commission cap: 3%",
    "Expense load: $420,000", "Rent load factor: 12%", "Amort. of financing fees: 3 yr", "Amortissement des frais : 3 ans",
    "Amortization of project costs: 4 years", "Amortissement des coûts : 5 ans",
  ])("requested or accounting refusal: %s", (line) => expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000]]));
  const early = [
    "Occupancy at completion: 60%", "Occupancy at maturity of the loan: 90%", "Current occupancy: 82%",
    "Occupancy at delivery: 61%", "Occupancy at opening: 62%", "Occupancy at turnover: 63%", "Occupancy at month 6: 64%", "Occupancy in year 1: 65%",
    "Initial occupancy: 66%", "In-place occupancy: 67%", "Actual occupancy: 68%", "Occupancy today: 69%",
    "Occupation à la livraison : 70 %", "Occupation à l'ouverture : 71 %", "Occupation actuelle : 72 %", "Occupation initiale : 73 %", "Occupation à l'échéance du prêt : 74 %",
    "Taux d'occupation actuel : 75 %", "Taux d'occupation initial : 76 %",
  ];
  test.each(early)("a non-stabilized occupancy is shown, not read: %s", (line) => {
    const r = read(LOAN, line);
    expect(pick(r)).toEqual([["senior_loan_amount", 5_000_000]]);
    expect(r.other.some((o) => o.note === "An occupancy before stabilization, not the stabilized occupancy")).toBe(true);
  });
  test.each(early)("a non-stabilized occupancy table row: %s", (line) => {
    const [label, value] = line.split(":");
    const r = extractCandidates({ kind: "docx", lines: [], tables: [{ name: "Assumptions", rows: [[{ text: label!, ref: "R1C1" }, { text: value!, ref: "R1C2" }]] }], pageCount: 1, needsOcr: false, fullText: "" });
    expect(pick(r)).toEqual([]);
    expect(r.other.some((o) => o.note === "An occupancy before stabilization, not the stabilized occupancy")).toBe(true);
  });
  // Own English and French variants for each rule, exercised as both lines and assumption-table rows.
  const variants: [string, string, string, number][] = [
    ["Resale cap rate", "5.85%", "exit_cap_rate_pct", 5.85], ["Reversion cap", "5.45%", "exit_cap_rate_pct", 5.45],
    ["Taux de capitalisation à la revente", "5,75 %", "exit_cap_rate_pct", 5.75], ["Cap à la revente", "5,35 %", "exit_cap_rate_pct", 5.35], ["Taux de cap à la sortie", "5,25 %", "exit_cap_rate_pct", 5.25], ["Sale cap rate", "5.65%", "exit_cap_rate_pct", 5.65],
    ["Stabilised occ.", "96%", "stabilized_occupancy_pct", 96], ["Stab. occupancy", "94%", "stabilized_occupancy_pct", 94],
    ["Occupation de croisière", "97 %", "stabilized_occupancy_pct", 97], ["Taux d'occupation à maturité", "93 %", "stabilized_occupancy_pct", 93],
    ["Opex load", "32%", "expense_ratio_pct", 32], ["Expense load", "36%", "expense_ratio_pct", 36],
    ["Charge d'exploitation annuelle", "33 %", "expense_ratio_pct", 33], ["Charge d’exploitation prévue", "37 %", "expense_ratio_pct", 37],
    ["Amort period", "28 years", "senior_amort_years", 28], ["Senior amort.", "32 yr", "senior_amort_years", 32],
    ["Amort.", "27 ans", "senior_amort_years", 27], ["Période d'amortissement", "29 ans", "senior_amort_years", 29],
  ];
  test.each(variants)("own label line: %s", (label, value, key, n) => expect(pick(read(LOAN, `${label}: ${value}`))).toEqual([["senior_loan_amount", 5_000_000], [key, n]]));
  test.each(variants)("own assumption-table row: %s", (label, value, key, n) => {
    const r = extractCandidates({ kind: "docx", lines: [], tables: [{ name: "Assumptions", rows: [[label, value]].map((row, i) => row.map((text, c): Cell => ({ text, ref: `R${i + 1}C${c + 1}` }))) }], pageCount: 1, needsOcr: false, fullText: "" });
    expect(pick(r)).toEqual([[key, n]]);
  });
});

describe("card 105 audit: stabilization named, presale and resale-price caps", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const LOAN = "Construction loan: $5,000,000";
  test.each(["Actual stabilized occupancy: 95%", "Initial stabilized occupancy: 95%", "Occupation stabilisée initiale : 95 %"])("a label that names stabilization is not an early occupancy: %s", (line) => {
    expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000], ["stabilized_occupancy_pct", 95]]);
  });
  test.each(["Pre-sale cap: 25%", "Pre sale cap: 30%", "Presales cap: 60%", "Pre-sales cap rate: 5.5%"])("a presale cap is not the exit cap: %s", (line) => {
    expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000]]);
  });
  test.each(["Resale cap: 2% per year", "Resale cap: 2.5% annually", "Sale cap: 3% a year", "Cap de revente : 2 % par an", "Resale cap: 2% of appreciation"])("a resale price limit is not the exit cap: %s", (line) => {
    expect(pick(read(LOAN, line))).toEqual([["senior_loan_amount", 5_000_000]]);
  });
  test.each([
    ["First mortgage amort.: 30 years", "The second amort.: 20 years"],
    ["Bank amortization: 30 years", "Second amort 20 years"],
    ["Senior amort 30 yr;", "the second int. 11% and the second amort 20 yr;"],
  ])("a second mortgage's amortization is the mezzanine's: %s / %s", (a, b) => {
    const keys = pick(read(LOAN, a, b));
    expect(keys).toContainEqual(["senior_amort_years", 30]);
    expect(keys).toContainEqual(["mezz_amort_years", 20]);
    expect(keys).not.toContainEqual(["senior_amort_years", 20]);
  });
  test("the bare abbreviation 'amort.' in a sentence is shown, not read", () => {
    const r = read(LOAN, "Behind it, a second lender advances $200,000 at 11%, amort. 20 years, IO 12 months.");
    expect(pick(r).filter(([k]) => /amort/.test(String(k)))).toEqual([]);
    expect(pick(read(LOAN, "The loan amortizes over 30 years."))).toContainEqual(["senior_amort_years", 30]);
  });
  test("a second phase or second year is not a second mortgage", () => {
    expect(pick(read(LOAN, "Second phase amortization: 30 years"))).toEqual([["senior_loan_amount", 5_000_000], ["senior_amort_years", 30]]);
  });
  test("a sale cap rate is still the exit cap", () => {
    expect(pick(read(LOAN, "Resale cap: 5.70%"))).toEqual([["senior_loan_amount", 5_000_000], ["exit_cap_rate_pct", 5.7]]);
    expect(pick(read(LOAN, "Sale cap rate 5.5%, going-in 5.0%"))).toEqual([["senior_loan_amount", 5_000_000], ["exit_cap_rate_pct", 5.5]]);
  });
});

describe("card 106: French loan interest word order and target take-out months", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const HEAD = "Construction loan: $5,000,000";
  test.each([
    ["Prêt mezzanine : 600 000 $", "Intérêt mezzanine : 11 %"],
    ["Prêt mezzanine : 600 000 $", "Taux mezzanine : 11 %"],
    ["Mezzanine loan: $600,000", "Mezzanine interest: 11%"],
    ["Prêt mezzanine : 600 000 $", "Intérêt du prêt mezzanine : 11 %"],
    ["Prêt mezzanine : 600 000 $", "Intérêt de la mezzanine : 11 %"],
    ["Mezzanine loan: $600,000", "Annual mezzanine interest: 11%"],
    ["Mezzanine loan: $600,000", "Mezzanine interest, fixed: 11%"],
  ])("a loan's interest: %s / %s", (loan, rate) => expect(pick(read(HEAD, loan, rate))).toEqual([["senior_loan_amount", 5_000_000], ["mezz_loan_amount", 600_000], ["mezz_rate_pct", 11]]));
  test.each([
    ["Intérêt du prêt de reprise : 5,25 %", "refinance_rate_pct", 5.25],
    ["Intérêt du prêt mezzanine annuel : 10,75 %", "mezz_rate_pct", 10.75],
    ["Intérêt de la mezzanine fixe : 12 %", "mezz_rate_pct", 12],
  ])("French own scoped-rate variant: %s", (line, key, n) => expect(pick(read(HEAD, line as string))).toEqual([["senior_loan_amount", 5_000_000], [key, n]]));
  test.each([
    "Intérêt des commanditaires : 8 %", "Intérêts de retard : 18 %", "Partnership interest: 20%", "Ownership interest: 25%",
    "Intérêt du prêt mezzanine en défaut : 18 %", "Intérêt de la mezzanine des commanditaires : 8 %",
  ])("interest that is not the loan rate: %s", (line) => expect(read(HEAD, line).candidates.some((c) => /_rate_pct$/.test(c.fieldKey ?? ""))).toBe(false));
  test("carried interest keeps its existing promote meaning", () => expect(pick(read(HEAD, "Carried interest: 20%"))).toEqual([["senior_loan_amount", 5_000_000], ["gp_promote_pct", 20]]));
  const months: [string, number][] = [
    ["Take-out target month: 26", 26], ["Take-out target: month 26", 26], ["Target refinance month: 26", 26], ["Mois cible de la reprise : 26", 26],
    ["Refinance in month 28.", 28], ["Take-out month: 24 months", 24],
    ["Take-out targeted month: 27", 27], ["Planned refinance month: 29", 29], ["Expected take-out month: 31", 31],
    ["Mois prévu du refinancement : 28", 28], ["Date prévue de la reprise : mois 32", 32],
  ];
  test.each(months)("the take-out month: %s", (line, n) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5_000_000], ["refinance_month", n]]));
  test.each(["Target IRR: 18%", "Target equity multiple: 1.9x", "Target yield on cost: 6.5%", "Rendement cible : 18 %", "Target refinance rate: 5%", "Take-out target amount: $3,000,000", "Target construction month: 26", "Take-out target amortization: 30 years", "Target IRR at refinance month: 18%", "Target refinance month: 18%"])("a target other than take-out timing is refused: %s", (line) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5_000_000]]));
  test.each(["Take-out target month: 12 months after completion", "Mois cible de la reprise : 12 mois après la livraison"])("target timing still refuses a later-event offset: %s", (line) => expect(pick(read(HEAD, line))).toEqual([["senior_loan_amount", 5_000_000]]));
  test.each([
    ["Intérêt du prêt mezzanine", "11 %", "mezz_rate_pct", 11], ["Intérêt du prêt de reprise", "5,25 %", "refinance_rate_pct", 5.25],
    ["Take-out target month", "26", "refinance_month", 26], ["Mois cible de la reprise", "26", "refinance_month", 26],
  ])("the same label in a table: %s", (label, value, key, n) => {
    const r = extractCandidates({ kind: "docx", lines: [], tables: [{ name: "Terms", rows: [[{ text: label as string, ref: "R1C1" }, { text: value as string, ref: "R1C2" }]] }], pageCount: 1, needsOcr: false, fullText: "" });
    expect(pick(r)).toEqual([[key, n]]);
  });
});

describe("card 107: a budget category column names its lines", () => {
  type Row = [string, string, number | string];
  const sheet = (rows: Row[], name = "Budget", section?: string) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name, rows: [...(section ? [[{ text: section, ref: "A0" }]] : []), ...rows.map((row, i) => row.map((v, c): Cell => ({ text: String(v), ref: `${String.fromCharCode(65 + c)}${i + 1}`, ...(typeof v === "number" ? { number: v } : {}) })))] }], pageCount: 1, needsOcr: false, fullText: "" });
  const read = (text: string) => extractCandidates({ kind: "pdf", lines: [{ text, location: "page 1" }], tables: [], pageCount: 1, needsOcr: false, fullText: text });
  const pick = (r: ReturnType<typeof sheet>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const en: Row[] = [["Hard", "Fourplex trades package before HST", 1_450_000], ["Hard", "Site servicing and hookups", 120_000], ["Soft", "Architect, engineers and city permits", 210_000], ["Soft", "Legal and accounting", 40_000]];
  const fr: Row[] = [["Directs", "Lots de travaux avant TPS", 1_450_000], ["Directs", "Raccordements et desserte", 120_000], ["Indirects", "Architecte, ingénieurs et permis municipaux", 210_000], ["Indirects", "Services juridiques et comptables", 40_000]];
  test.each([["English", en], ["French", fr]] as const)("S1 sums the category rows with both refs: %s", (_, rows) => {
    const r = sheet([...rows]);
    expect(pick(r)).toEqual([["hard_cost", 1_570_000], ["soft_cost", 250_000]]);
    expect(r.candidates.map((c) => [c.rule, c.location])).toEqual([["table:budget-sum", "C1, C2"], ["table:budget-sum", "C3, C4"]]);
    expect(r.candidates[0]!.context).toContain(rows[0]![1]);
    expect(r.candidates[0]!.context).toContain(rows[0]![0]);
  });
  test.each([["English", en, "Land", "Contingency"], ["French", fr, "Terrain", "Imprévus"]] as const)("S2 single land and contingency categories do not break detection: %s", (_, rows, land, reserve) => {
    expect(pick(sheet([[land, "Parcel purchase", 600_000], ...rows, [reserve, "Owner reserve for surprises", 90_000]]))).toEqual([["land_cost", 600_000], ["hard_cost", 1_570_000], ["soft_cost", 250_000], ["contingency", 90_000]]);
  });
  const subtotal = (french: boolean, total = 1_570_000): Row[] => french
    ? [["Directs", "Coûts directs - bâtiment", 1_450_000], ["Directs", "Coûts directs - raccordements", 120_000], ["Directs", "Sous-total directs", total], ["Indirects", "Coûts indirects - conception", 210_000], ["Indirects", "Coûts indirects - juristes", 40_000], ["Total", "Coût total du projet", 1_820_000]]
    : [["Hard", "Hard costs - building", 1_450_000], ["Hard", "Hard costs - site work", 120_000], ["Hard", "Hard subtotal", total], ["Soft", "Soft costs - design", 210_000], ["Soft", "Soft costs - legal", 40_000], ["Total", "Total project cost", 1_820_000]];
  test.each([false, true])("S3 checks subtotals rather than adding them (French=%s)", (french) => expect(pick(sheet(subtotal(french)))).toEqual([["hard_cost", 1_570_000], ["soft_cost", 250_000], ["stated_total_cost", 1_820_000]]));
  test.each([false, true])("a wrong subtotal retains the existing mismatch note (French=%s)", (french) => {
    const r = sheet(subtotal(french, 1_600_000));
    expect(r.candidates.filter((c) => c.fieldKey === "hard_cost").map((c) => [c.value, c.note])).toEqual([[1_570_000, undefined], [1_600_000, "The printed total does not equal the sum of its lines (1,570,000)"]]);
  });
  test.each(["Retired", "Remplacé", "Retirée", "Retirés", "Remplacées", "Replaced", "Retired estimate", "Replaced budget", "Budget retiré", "Estimation remplacée", "Superseded", "Old budget", "Previous", "Archive", "Ancien budget", "Prior version"])("an excluded sheet supplies neither category nor plain costs: %s", (name) => {
    expect(pick(sheet(en, name))).toEqual([]);
    expect(pick(sheet([["Hard costs", "Trade package", 500_000]], name))).toEqual([]);
    const plain = extractCandidates({ kind: "xlsx", lines: [], tables: [{ name, rows: [[{ text: "Hard costs", ref: "A1" }, { text: "500000", number: 500_000, ref: "B1" }]] }], pageCount: 1, needsOcr: false, fullText: "" });
    expect(pick(plain)).toEqual([]);
  });
  test.each(["Retired", "Remplacé", "Not part of the project", "Ne fait pas partie du projet"])("section exclusions still apply: %s", (section) => expect(pick(sheet(en, "Budget", section))).toEqual([]));
  test.each(["Uses", "Costs", "Sources", "Emplois", "Coûts"])("generic category %s adds no field", (cat) => {
    expect(pick(sheet([[cat, "Land", 600_000], [cat, "Hard costs", 1_450_000], [cat, "Soft costs", 210_000], [cat, "Fresh wording with no field", 30_000]]))).toEqual([["land_cost", 600_000], ["hard_cost", 1_450_000], ["soft_cost", 210_000]]);
  });
  test("a description's own field wins and partial explicit rows join the category sums", () => {
    expect(pick(sheet([["Hard", "Hard costs", 1_450_000], ["Hard", "Site work", 120_000], ["Soft", "Soft costs", 210_000], ["Soft", "Legal", 40_000], ["Soft", "Contingency on design", 20_000]]))).toEqual([["hard_cost", 1_570_000], ["soft_cost", 250_000], ["contingency", 20_000]]);
  });
  test.each([
    [["Construction", "Framing and envelope", 800_000], ["Soft costs", "Consultants and filings", 100_000], ["Acquisition", "Parcel conveyance", 300_000], ["Contingencies", "Unallocated cushion", 50_000]],
    [["Coûts directs", "Structure et enveloppe", 800_000], ["Coûts indirects", "Études et autorisations", 100_000], ["Terrain", "Acte de vente du lot", 300_000], ["Aléas", "Marge pour surprises", 50_000]],
    [["Hard costs", "Masonry contract", 800_000], ["Indirects", "Planning advisers", 100_000], ["Land", "Deed transfer", 300_000], ["Contingency", "Somme non affectée", 50_000]],
  ] as Row[][])("own category variants: %j", (...rows) => expect(pick(sheet(rows))).toEqual([["hard_cost", 800_000], ["soft_cost", 100_000], ["land_cost", 300_000], ["contingency", 50_000]]));
  test("an excluded category never contributes to the live budget", () => {
    expect(pick(sheet([["Hard", "Live framing", 800_000], ["Soft", "Live studies", 100_000], ["Retired", "Hard costs", 900_000], ["Retired", "Soft costs", 120_000]]))).toEqual([["hard_cost", 800_000], ["soft_cost", 100_000]]);
  });
  test("per-door, percent and currency handling remain separate", () => {
    const r = sheet([["Hard", "Per-door amount", "$10,000 per door"], ["Hard", "Allowance share", "5%"], ["Hard", "Canadian work", "CAD 800,000"], ["Hard", "Foreign work", "USD 90,000"], ["Soft", "Advisers", 100_000]]);
    expect(r.candidates.filter((c) => c.fieldKey === "hard_cost").map((c) => [c.value, c.unitSeen])).toEqual([[800_000, "CAD"], [90_000, "USD"]]);
    expect(r.candidates.some((c) => c.value === 10_000 || c.value === 5)).toBe(false);
    expect(r.other.some((o) => o.value === 10_000 && o.note?.includes("per"))).toBe(true);
  });
  test.each([
    ["Construction costs before taxes: $2,000,000", "hard_cost"], ["Coûts de construction hors taxes : 2 000 000 $", "hard_cost"],
    ["Hard costs excluding HST: $2,000,000", "hard_cost"], ["Hard costs (net of GST): $2,000,000", "hard_cost"], ["Soft costs incl. HST: $2,000,000", "soft_cost"],
    ["Construction costs excluding taxes: $2,000,000", "hard_cost"], ["Construction costs net of taxes: $2,000,000", "hard_cost"], ["Construction costs ex taxes: $2,000,000", "hard_cost"],
    ["Coûts de construction avant taxes : 2 000 000 $", "hard_cost"], ["Coûts de construction taxes en sus : 2 000 000 $", "hard_cost"], ["Coûts de construction taxes incluses : 2 000 000 $", "hard_cost"],
  ])("a tax qualifier preserves its cost line: %s", (line, key) => expect(pick(read(line))).toEqual([[key, 2_000_000]]));
  test.each(["Property taxes during construction: $40,000", "Construction costs - property taxes: $40,000", "Coûts de construction - taxes foncières : 40 000 $", "Construction costs before taxes - property taxes: $40,000"])("a real property-tax carrying cost stays refused: %s", (line) => {
    const r = read(line);
    expect(pick(r)).toEqual([]);
    expect(r.other.some((o) => o.note === "A carrying cost; label it under the cost line it belongs to")).toBe(true);
  });
  test("a sales tax line stays refused", () => {
    const r = read("HST on hard costs: $260,000");
    expect(pick(r)).toEqual([]);
    expect(r.other.some((o) => o.note?.startsWith("A sales tax line"))).toBe(true);
  });
  test("the stated project total remains an input in prose", () => expect(pick(read("Total project cost: $1,820,000"))).toEqual([["stated_total_cost", 1_820_000]]));
});

describe("card 107 audit: a category keeps the line's own guards, reserves stay unnamed, blank columns", () => {
  const sheet = (rows: (string | number)[][], name = "Budget") => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name, rows: rows.map((row, i) => row.map((v, c): Cell => ({ text: String(v), ref: `${String.fromCharCode(65 + c)}${i + 1}`, ...(typeof v === "number" ? { number: v } : {}) }))) }], pageCount: 1, needsOcr: false, fullText: "" });
  const pick = (r: ReturnType<typeof sheet>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  test("a fee or an amount drawn to date under a category is not that cost", () => {
    const r = sheet([["Land", "Parcel", 600_000], ["Construction", "Trades", 1_450_000], ["Construction", "Draws to date", 1_000_000], ["Construction", "Lender fee", 50_000], ["Hard", "Envelope", 300_000], ["Hard", "Interest during construction", 80_000]]);
    expect(pick(r)).toEqual([["land_cost", 600_000], ["hard_cost", 1_750_000]]);
    expect(r.other.map((o) => o.value)).toEqual(expect.arrayContaining([1_000_000, 50_000, 80_000]));
  });
  test.each(["Reserve", "Réserve"])("a %s category names no contingency (replacement, operating and interest reserves)", (cat) => {
    expect(pick(sheet([["Land", "Parcel", 600_000], ["Hard", "Trades", 1_450_000], [cat, "Operating deficit reserve", 100_000], [cat, "Replacement reserve", 40_000]]))).toEqual([["land_cost", 600_000], ["hard_cost", 1_450_000]]);
  });
  test("blank cells between the description and the amount", () => {
    expect(pick(sheet([["Hard", "Trades package", "", "", 1_450_000], ["Hard", "Servicing", "", "", 120_000], ["Soft", "Design fees", "", "", 210_000], ["Total", "Total project cost", "", "", 1_780_000]]))).toEqual([["hard_cost", 1_570_000], ["soft_cost", 210_000], ["stated_total_cost", 1_780_000]]);
  });
  test("a note column between them still keeps the sheet out of the category sums", () => {
    expect(pick(sheet([["Hard", "Trades package", "fixed", 1_450_000], ["Hard", "Servicing", "quote", 120_000], ["Soft", "Design fees", "est", 210_000]]))).toEqual([]);
  });
});

describe("card 107 audit: the verb to retire a loan is not a retired sheet", () => {
  const read = (...ls: string[]) => extractCandidates({ kind: "pdf", lines: ls.map((text) => ({ text, location: "page 1" })), tables: [], pageCount: 1, needsOcr: false, fullText: ls.join("\n") });
  test.each(["Take-out loan to retire the construction facility: $5,200,000", "Take-out loan, which retires the construction facility: $5,200,000"])("%s", (line) => {
    expect(read("Construction loan: $5,000,000", line).candidates.map((c) => [c.fieldKey, c.value])).toEqual([["senior_loan_amount", 5_000_000], ["refinance_amount", 5_200_000]]);
  });
});

describe("card 108: loan terms named by concept and unit", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const sheet = (heading: string | null, rows: [string, string][]) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name: "Financing", rows: [...(heading ? [[{ text: heading, ref: "A1" }]] : []), ...rows.map((row, i) => row.map((text, c): Cell => ({ text, ref: `${String.fromCharCode(65 + c)}${i + 2}` })))] }], pageCount: 1, needsOcr: false, fullText: "" });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const four = [["senior_loan_amount", 2_000_000], ["senior_rate_pct", 6.1], ["senior_amort_years", 25], ["senior_io_months", 18]];
  test.each([
    "Senior loan: $2,000,000, interest rate 6.1%, amortization 25 years, interest-only period 18 months",
    "Lender advance granted $2,000,000, Yearly charge on the advance 6.1%, Years to repay the advance 25 years, Months before repayment begins 18 months",
    "Prêt de construction accordé 2 000 000 $, Taux annuel consenti 6,1 %, Amortissement prévu 25 ans, Intérêts seulement 18 mois",
    "Senior lender terms: advance $2,000,000; annual charge 6.1%; repaid over 25 years; 18 months interest only.",
  ])("the four requested terms: %s", (line) => expect(pick(read(line))).toEqual(four));
  test("a bank facility's repayment term stays refused", () => {
    const r = read("Bank facility $2,000,000, coupon on the facility 6.1%, facility repayment term 25 years, facility interest-only 18 months");
    expect(pick(r)).toEqual([four[0], four[1], four[3]]);
    expect(r.other.find((c) => c.value === 25)?.note).toBe("A loan's term, not the build period, hold or amortization");
  });
  test("the second lender's amount and amortization share its mezzanine scope", () => expect(pick(read("Construction loan: $5,000,000", "Second lender: $300,000, rate 10%, amortized over 20 years"))).toEqual([["senior_loan_amount", 5_000_000], ["mezz_loan_amount", 300_000], ["mezz_rate_pct", 10], ["mezz_amort_years", 20]]));
  test("a first-mortgage section scopes short table labels", () => expect(pick(sheet("First mortgage", [["Advance", "2000000"], ["Charge", "6.1%"], ["Repayment period", "25 years"], ["Interest-only months", "18"]]))).toEqual(four));
  const variants: [string, string, string, number][] = [
    ["Bank facility granted", "$2,000,000", "senior_loan_amount", 2_000_000], ["Lender advance approved", "$2,000,000", "senior_loan_amount", 2_000_000], ["Financing size authorized", "$2,000,000", "senior_loan_amount", 2_000_000],
    ["Avance bancaire accordée", "2 000 000 $", "senior_loan_amount", 2_000_000], ["Capital du financement consenti", "2 000 000 $", "senior_loan_amount", 2_000_000], ["Crédit bancaire octroyé", "2 000 000 $", "senior_loan_amount", 2_000_000],
    ["Annual charge on the facility", "6.1%", "senior_rate_pct", 6.1], ["Cost of borrowing for the advance", "6.1%", "senior_rate_pct", 6.1], ["Charge on bank financing", "6.1%", "senior_rate_pct", 6.1],
    ["Taux annuel consenti par la banque", "6,1 %", "senior_rate_pct", 6.1], ["Intérêt annuel appliqué au crédit", "6,1 %", "senior_rate_pct", 6.1], ["Taux applicable au financement", "6,1 %", "senior_rate_pct", 6.1],
    ["Bank advance repaid over", "25 years", "senior_amort_years", 25], ["Facility repaid over", "25 years", "senior_amort_years", 25], ["Mortgage paid down over", "25 years", "senior_amort_years", 25],
    ["Remboursement de l'avance sur", "25 ans", "senior_amort_years", 25], ["Crédit remboursé sur", "25 ans", "senior_amort_years", 25], ["Capital du prêt remboursable sur", "25 ans", "senior_amort_years", 25],
    ["Facility before repayment begins", "18 months", "senior_io_months", 18], ["Mortgage before repayment begins", "18 months", "senior_io_months", 18], ["Bank financing interest only", "18 months", "senior_io_months", 18],
    ["Avance sans remboursement de capital", "18 mois", "senior_io_months", 18], ["Crédit sans remboursement de capital", "18 mois", "senior_io_months", 18], ["Financement sans remboursement de capital", "18 mois", "senior_io_months", 18],
  ];
  test.each(variants)("own label line: %s", (label, value, field, n) => expect(pick(read(`${label}: ${value}`))).toEqual([[field, n]]));
  test.each(variants)("own comma-list clause: %s", (label, value, field, n) => expect(pick(read(`First mortgage, ${label} ${value}, supporting documents attached.`))).toEqual([[field, n]]));
  test.each(variants)("own sheet row: %s", (label, value, field, n) => expect(pick(sheet("First mortgage", [[label, value]]))).toEqual([[field, n]]));
  test.each(["Lender fee: $20,000", "Loan-to-cost 70%", "Spread over prime 1.5%", "Loan term: 5 years", "Interest reserve: $150,000", "Drawn to date $1,000,000", "Monthly payment $11,000", "Frais du prêteur : 20 000 $", "Ratio prêt-coût : 70 %", "Écart au-dessus du taux préférentiel : 1,5 %", "Durée du prêt : 5 ans", "Réserve d'intérêts : 150 000 $", "Avance tirée à ce jour : 1 000 000 $", "Versement mensuel : 11 000 $"])("a required exclusion stays shown: %s", (line) => {
    const r = read("First mortgage", line);
    expect(r.candidates.filter((c) => /^(senior|mezz|refinance)_/.test(c.fieldKey ?? ""))).toEqual([]);
    expect([...r.other, ...r.candidates].length).toBeGreaterThan(0);
  });
  test.each(["Facility holdback: $50,000", "Lender balance: $900,000", "Bank deposit: $40,000", "Mortgage equity: $500,000", "Loan fee charge: 1%", "Loan insurance charge: 2%", "Bank spread charge: 1.5%", "Mortgage DCR charge: 1.2%", "Loan repayment maturity: 5 years", "Bank repayment renewal: 3 years", "Facility before repayment begins - term: 18 months", "Advance draw before repayment begins: 12 months", "Retenue bancaire : 50 000 $", "Solde du crédit : 900 000 $", "Dépôt bancaire : 40 000 $", "Capital propre du financement : 500 000 $", "Charge du prêt - frais : 1 %", "Charge du prêt - prime d'assurance : 2 %", "Charge du crédit - ratio : 70 %", "Remboursement du prêt à l'échéance : 5 ans", "Prêt sans remboursement de capital - terme : 18 mois"])("own exclusion variant: %s", (line) => expect(read("First mortgage", line).candidates.filter((c) => /^(senior|mezz|refinance)_/.test(c.fieldKey ?? ""))).toEqual([]));
  test.each(["Months before repayment begins: 18 months", "Annual charge: 6.1%", "Repaid over: 25 years", "Montant consenti : 2 000 000 $", "Charge annuelle : 6,1 %", "Remboursé sur : 25 ans"])("no loan name or scope gives no concept read: %s", (line) => expect(pick(read(line))).toEqual([]));
  test("a generic sheet's default senior scope is not a loan heading", () => expect(pick(sheet(null, [["Charge", "6.1%"], ["Repayment period", "25 years"], ["Unallocated sum", "2000000"]]))).toEqual([]));
  test.each(["Permanent lender", "Take-out lender", "Prêt permanent", "Financement de sortie"])("a take-out heading gives refinance fields: %s", (heading) => expect(pick(read(heading, "Advance granted: $2,000,000", "Annual charge: 6.1%", "Repaid over: 25 years", "Months before repayment begins: 18 months"))).toEqual(four.map(([key, value]) => [(key === "senior_loan_amount" ? "refinance_amount" : String(key).replace("senior_", "refinance_")), value])));
  test("a concept read is counted separately and aliases keep their existing rule", () => {
    expect(read("Bank facility granted: $2,000,000").candidates[0]?.rule).toBe("concept");
    expect(read("Senior loan: $2,000,000").candidates[0]?.rule).toBe("line:label-value");
    expect(sheet("First mortgage", [["Charge", "6.1%"]]).candidates[0]?.rule).toBe("concept");
  });
});

describe("card 108 audit: a loan noun alone is not the loan", () => {
  const read = (...lines: string[]) => extractCandidates({ kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") });
  const sheet = (rows: [string, number][]) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name: "Budget", rows: rows.map(([l, v], i) => [{ text: l, ref: `A${i + 1}` }, { text: String(v), number: v, ref: `B${i + 1}` }]) }], pageCount: 1, needsOcr: false, fullText: "" });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  test.each([
    "Note: the lender's appraiser valued it at $5,150,000 on completion.",
    "For the record, the bank's appraisal came in at $5,150,000 stabilized.",
    "The broker mentioned an alternative advance of $2,300,000, never committed.",
    "A rough alternate bank figure of $2,300,000 was floated but not committed.",
    "Le prêteur a fait évaluer l'immeuble à 5 150 000 $.",
    "Line of credit: $500,000",
    "Marge de crédit : 500 000 $",
  ])("only the stated loan is read: %s", (line) => expect(pick(read("Construction loan: $2,450,000", line))).toEqual([["senior_loan_amount", 2_450_000]]));
  test.each(["Subtotal before financing", "Total excluding financing costs", "Sous-total avant financement"])("a budget total that names financing is not the loan: %s", (label) => {
    expect(pick(sheet([["Hard costs", 3_000_000], ["Soft costs", 500_000], [label, 3_500_000]])).filter(([k]) => /loan|refinance/.test(String(k)))).toEqual([]);
  });
  test.each([
    ["Prêt mezzanine : 450 000 $", "Le prêteur principal (Banque Fictive) propose 2 950 000 $."],
    ["Mezzanine loan: $450,000", "Our main lender is offering $2,950,000."],
  ])("the main lender is the senior loan, even in a mezzanine document: %s", (mezz, line) => {
    expect(pick(read(mezz, line)).sort()).toEqual([["mezz_loan_amount", 450_000], ["senior_loan_amount", 2_950_000]]);
  });
});

describe("card 109: budget concepts and mixed category sections", () => {
  type Row = [string, string, number | string];
  const read = (text: string) => extractCandidates({ kind: "pdf", lines: [{ text, location: "page 1" }], tables: [], pageCount: 1, needsOcr: false, fullText: text });
  const sheet = (rows: Row[], name = "Current", section?: string) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name, rows: [...(section ? [[{ text: section, ref: "A0" }]] : []), ...rows.map((row, i) => row.map((v, c): Cell => ({ text: String(v), ref: `${String.fromCharCode(65 + c)}${i + 1}`, ...(typeof v === "number" ? { number: v } : {}) })))] }], pageCount: 1, needsOcr: false, fullText: "" });
  const plain = (rows: [string, number | string][], section?: string) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name: "Current", rows: [...(section ? [[{ text: section, ref: "A0" }]] : []), ...rows.map((row, i) => row.map((v, c): Cell => ({ text: String(v), ref: `${String.fromCharCode(65 + c)}${i + 1}`, ...(typeof v === "number" ? { number: v } : {}) })))] }], pageCount: 1, needsOcr: false, fullText: "" });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const en: Row[] = [["Uses", "Lot acquisition and closing", 600_000], ["Uses", "Framing, envelope and finishes", 1_450_000], ["Uses", "Architect and permit fees", 210_000], ["Uses", "Overrun allowance", 90_000]];
  const fr: Row[] = [["Emplois", "Achat du lot et frais de clôture", 600_000], ["Emplois", "Charpente, enveloppe et finitions", 1_450_000], ["Emplois", "Honoraires d'architecte et permis", 210_000], ["Emplois", "Provision pour dépassements", 90_000]];
  const costs = [["land_cost", 600_000], ["hard_cost", 1_450_000], ["soft_cost", 210_000], ["contingency", 90_000]];
  test.each([["EN", en, "Sum of uses"], ["FR", fr, "Somme des emplois"]] as const)("U: %s", (_, rows, total) => expect(pick(sheet([...rows, [rows[0]![0], total, 2_350_000]]))).toEqual([...costs, ["stated_total_cost", 2_350_000]]));
  test.each([...en, ...fr])("the same budget label in prose: %s | %s", (_, label, value) => expect(pick(read(`${label}: $${value.toLocaleString("en-US")}`))).toEqual([costs[[...en, ...fr].findIndex((r) => r[1] === label) % 4]]));
  test("M: budget and input runs use their existing readers", () => {
    const r = sheet([["Uses", "Lot acquisition and closing", 600_000], ["Hard", "Framing, envelope and finishes", 1_450_000], ["Hard", "Site services", 120_000], ["Soft", "Architect and permit fees", 210_000], ["Input", "Build period in months", 18], ["Input", "Hold in years", 7]]);
    expect(pick(r)).toEqual([["land_cost", 600_000], ["hard_cost", 1_570_000], ["soft_cost", 210_000], ["construction_months", 18], ["hold_years", 7]]);
    expect(r.candidates.find((c) => c.fieldKey === "hard_cost")?.location).toBe("C2, C3");
  });
  test("uses-only categories preserve the input rows too", () => expect(pick(sheet([...en, ["Input", "Build period in months", 18], ["Input", "Lease-up allowance in months", 5], ["Input", "Exit cap", "5.5%"]]))).toEqual([...costs, ["construction_months", 18], ["lease_up_months", 5], ["exit_cap_rate_pct", 5.5]]));
  test("plain labels continue to supply the bare number's unit", () => expect(pick(plain([["Build period in months", 18], ["Lease-up in months", 5], ["Hold (years)", 7]]))).toEqual([["construction_months", 18], ["lease_up_months", 5], ["hold_years", 7]]));
  test.each(["Total uses", "Uses total", "Sum of uses", "Total des emplois", "Somme des emplois"])("the section total is kept and checked: %s", (total) => {
    const r = sheet([...en, ["Uses", total, 2_400_000]]);
    expect(pick(r)).toEqual([...costs, ["stated_total_cost", 2_400_000]]);
    expect(r.candidates.at(-1)?.note).toBe("The printed total does not equal the sum of its lines (2,350,000)");
  });
  test.each(["Uses", "Costs", "Budget", "Emplois", "Coûts"])("a cost section without a category column: %s", (section) => expect(pick(plain(en.map(([, label, value]) => [label, value]), section))).toEqual(costs));
  const variants: [string, string, number][] = [
    ["Parcel acquisition and conveyance", "land_cost", 610_000], ["Ground purchase", "land_cost", 610_000], ["Purchase of the building", "land_cost", 610_000],
    ["Achat du terrain et clôture", "land_cost", 610_000], ["Parcelle acquise", "land_cost", 610_000], ["Achat de l'immeuble", "land_cost", 610_000],
    ["Framing trades package", "hard_cost", 1_460_000], ["Shell and fit-out", "hard_cost", 1_460_000], ["Site servicing works", "hard_cost", 1_460_000],
    ["Charpente et enveloppe", "hard_cost", 1_460_000], ["Travaux de finitions", "hard_cost", 1_460_000], ["Structure par l'entrepreneur", "hard_cost", 1_460_000],
    ["Engineering studies and approvals", "soft_cost", 220_000], ["Consultants and legal fees", "soft_cost", 220_000], ["Project management services", "soft_cost", 220_000],
    ["Études et conception", "soft_cost", 220_000], ["Plans et services juridiques", "soft_cost", 220_000], ["Honoraires comptables et permis", "soft_cost", 220_000],
    ["Unallocated cushion", "contingency", 95_000], ["Allowance for unknowns", "contingency", 95_000], ["Unforeseen risk allowance", "contingency", 95_000],
    ["Provision pour imprévus", "contingency", 95_000], ["Marge pour imprévus", "contingency", 95_000], ["Aléas non affectés", "contingency", 95_000],
  ];
  test.each(variants)("own prose label: %s", (label, key, value) => expect(pick(read(`${label}: $${value.toLocaleString("en-US")}`))).toEqual([[key, value]]));
  test.each(variants)("own category-sheet label: %s", (label, key, value) => {
    for (const cat of ["Uses", "Emplois", ...(key === "hard_cost" ? ["Hard"] : key === "soft_cost" ? ["Soft"] : [])]) {
      const r = sheet([[cat, label, value], ["Input", "Build period in months", 18], ["Input", "Hold (years)", 7]]);
      expect(r.candidates.some((c) => c.fieldKey === key && c.value === value)).toBe(true);
    }
  });
  // Card 109 audit: "Land and design" keeps its alias read as land (as before card 109); the rule is for labels only concepts name.
  test.each(["Lot and design", "Construction and permits", "Achat du lot et conception", "Travaux et permis"])("two budget concepts stay shown: %s", (label) => {
    expect(pick(read(`${label}: $80,000`))).toEqual([]);
    expect(pick(sheet([["Hard", label, 80_000], ["Hard", "Site services", 120_000], ["Soft", "Architect fees", 210_000]]))).not.toContainEqual(["hard_cost", 200_000]);
  });
  test.each(["Land transfer tax", "Construction loan interest", "Lender fee", "Replacement reserve", "Development charges", "Droits de mutation du terrain", "Intérêts du prêt de construction", "Frais du prêteur", "Réserve de remplacement", "Redevances de développement"])("an excluded item never becomes one of the four cost concepts: %s", (label) => {
    const r = read(`${label}: $20,000`);
    expect(r.candidates.filter((c) => c.rule === "concept" && ["land_cost", "hard_cost", "soft_cost", "contingency"].includes(c.fieldKey ?? ""))).toEqual([]);
  });
  test.each(["Parcel acquisition per door: $30,000", "Framing work paid to date: $40,000", "Architect fees rebate: $5,000", "Unallocated cushion: 5%", "Achat du lot par porte : 30 000 $", "Travaux payés à ce jour : 40 000 $", "Honoraires remboursés : 5 000 $"])("qualified amounts remain shown: %s", (line) => expect(read(line).candidates.filter((c) => c.rule === "concept")).toEqual([]));
  test.each(["Old budget", "Superseded", "Remplacé", "Retired"])("excluded sheets cannot feed new concepts: %s", (name) => expect(pick(sheet(en, name))).toEqual([]));
  test.each(["Not part of the project", "Ne fait pas partie du projet"])("excluded cost sections remain excluded: %s", (section) => expect(pick(sheet(en, "Current", section))).toEqual([]));
  test("a concept-only amount in another currency stays shown", () => {
    const r = sheet([["Uses", "Framing and finishes", "USD 800,000"], ["Uses", "Architect studies", 100_000], ["Uses", "Overrun allowance", 50_000]]);
    expect(r.candidates.some((c) => c.value === 800_000)).toBe(false);
    expect(r.other.some((c) => c.value === 800_000)).toBe(true);
  });
  test("plain inputs can separate two budget runs", () => expect(pick(sheet([["Uses", "Parcel acquisition", 600_000], ["Inputs", "Build period in months", 18], ["Hard", "Framing and finishes", 1_450_000], ["Hard", "Site services", 120_000], ["Hypothèses", "Hold (years)", 7]]))).toEqual([["land_cost", 600_000], ["construction_months", 18], ["hard_cost", 1_570_000], ["hold_years", 7]]));
});

describe("card 109 audit: a concept names a line only when the line is that cost", () => {
  const read = (text: string) => extractCandidates({ kind: "pdf", lines: [{ text, location: "page 1" }], tables: [], pageCount: 1, needsOcr: false, fullText: text });
  const table = (...rows: (string | number)[][]) => extractCandidates({ kind: "xlsx", lines: [], tables: [{ name: "Budget", rows: rows.map((r, i) => r.map((x, c): Cell => (typeof x === "number" ? { text: String(x), number: x, ref: `${"ABC"[c]}${i + 1}` } : { text: x, ref: `${"ABC"[c]}${i + 1}` }))) }], pageCount: 1, needsOcr: false, fullText: "" });
  const pick = (r: ReturnType<typeof read>) => r.candidates.map((c) => [c.fieldKey, c.value]);
  const costs = ["land_cost", "hard_cost", "soft_cost", "contingency"];
  const concept = (r: ReturnType<typeof read>) => r.candidates.filter((c) => costs.includes(c.fieldKey ?? "")).map((c) => [c.fieldKey, c.value]);

  test.each([
    "Recoverable service charges already in consultants etc.: $61,500",
    "Hydro hookup charges included in site services: $18,000",
    "Utility deposits within the construction budget: $12,000",
    "Frais de services déjà inclus dans les honoraires : 61 500 $",
    "Taxes municipales comprises dans les travaux : 18 000 $",
    "Site servicing levy: $24,000",
    "Framing already paid by the owner: $40,000",
    "Redevance de viabilisation : 24 000 $",
    "Charpente déjà réglée : 40 000 $",
  ])("a concept word after in, within or included in names where the figure sits, not what it is; a levy or an amount already settled is not the line: %s", (line) => expect(concept(read(line))).toEqual([]));

  test.each([
    ["Building purchase basis: $870,000", 870_000],
    ["Building acquisition price: $640,000", 640_000],
    ["Property purchase price: $640,000", 640_000],
  ])("a building bought is land, never construction: %s", (line, value) => expect(concept(read(line))).toEqual([["land_cost", value]]));

  test.each([
    "Construction principal: $2,050,000",
    "Construction facility: $2,050,000",
    "Building mortgage advance: $2,050,000",
    "Capital du prêt de construction : 2 050 000 $",
    "Financement des travaux : 2 050 000 $",
  ])("a loan named with a cost word is never the cost: %s", (line) => expect(concept(read(line))).toEqual([]));

  test.each([
    "Total job envelope: $750,000",
    "Overall construction envelope: $750,000",
    "All-in build budget: $750,000",
    "Enveloppe totale des travaux : 750 000 $",
    "Total build envelope: $750,000",
  ])("a total in cost words is not one line: %s", (line) => expect(concept(read(line)).filter(([k]) => k !== "stated_total_cost")).toEqual([]));

  test("a line named by concept does not split the unnamed lines a subtotal adds up", () => {
    const r = table(["Poste", "Montant ($)"], ["Fondations et structure", 820_000], ["Enveloppe du bâtiment", 540_000], ["Mécanique et électricité", 610_000], ["Finitions intérieures", 455_000], ["Aménagement extérieur", 95_000], ["Sous-total coûts directs", 2_580_000]);
    const hard = r.candidates.filter((c) => c.fieldKey === "hard_cost");
    expect(hard.map((c) => c.value).sort()).toEqual([2_520_000, 2_580_000]);
    expect(hard.find((c) => c.value === 2_580_000)?.note).toBe("The printed total does not equal the sum of its lines (2,520,000)");
    const en = table(["Item", "Amount"], ["Framing", 400_000], ["Mechanical", 300_000], ["Finishes", 300_000], ["Total hard costs", 1_000_000]);
    expect(pick(en)).toEqual([["hard_cost", 1_000_000]]);
  });

  test.each<[string, number][][]>([
    [[["Framing", 400_000], ["Mechanical", 200_000]]],
    [[["Charpente", 400_000], ["Mécanique", 200_000], ["Électricité", 150_000]]],
    [[["Architect", 80_000], ["Marketing", 20_000], ["Framing", 400_000]]],
  ])("with no subtotal, a concept line beside unnamed lines is shown, not read as the whole field", (rows) => {
    const r = table(["Item", "Amount"], ...rows);
    expect(concept(r)).toEqual([]);
    expect(r.other.map((o) => o.value).sort()).toEqual(rows.map(([, v]) => v).sort());
  });

  const lines = (...texts: string[]) => extractCandidates({ kind: "pdf", lines: texts.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: texts.join("\n") });
  test.each([
    [["Framing: $400,000", "Mechanical: $200,000"]],
    [["Uses of funds", "Framing: $400,000", "Finishes: $300,000"]],
    [["Charpente : 400 000 $", "Mécanique : 200 000 $", "Électricité : 150 000 $"]],
    [["Architect: $50,000", "Marketing: $20,000"]],
  ])("text lines: a concept line beside unnamed lines of a one-field block, or beside another line of its field, is shown", (texts) => {
    const r = lines(...texts);
    expect(r.candidates.filter((c) => c.rule === "concept")).toEqual([]);
  });
  test("text lines: an unnamed figure that is the total of the lines beside it does not stop them", () => {
    expect(concept(lines("Building purchase basis: $870,000; Conversion works: $1,750,000; Architect studies: $210,000; Project uses stated: $3,130,000.")).sort()).toEqual([["hard_cost", 1_750_000], ["land_cost", 870_000], ["soft_cost", 210_000]]);
    expect(concept(lines("Lot purchase: $600,000", "Framing and finishes: $1,450,000", "All uses: $2,050,000")).sort()).toEqual([["hard_cost", 1_450_000], ["land_cost", 600_000]]);
  });
  test("text lines: a block naming several cost fields lists one line per field, so an unnamed line beside them is another cost", () => {
    expect(concept(lines("Lot purchase: $620,000", "Construction allowance: $650,000", "Design and permits: $125,000", "Money held for surprises: $65,000", "Whole project budget: $1,460,000")).sort()).toEqual([["hard_cost", 650_000], ["land_cost", 620_000], ["soft_cost", 125_000]]);
    expect(concept(lines("Achat du lot : 160 000 $", "Pose des logements : 480 000 $", "Approbations et conception : 75 000 $")).sort()).toEqual([["land_cost", 160_000], ["soft_cost", 75_000]]);
  });
  test("an alias read keeps its field when the description also has a second concept", () => {
    expect(pick(read("Land and existing building: $520,000"))).toEqual([["land_cost", 520_000]]);
  });
  test("text lines: a concept line apart from the unnamed ones is read", () => {
    expect(concept(lines("Framing package: $400,000", "", "The sponsor met the city planner on Tuesday.", "Marketing: $20,000"))).toEqual([["hard_cost", 400_000]]);
  });

  test("named lines with no unnamed line beside them are still read", () => {
    expect(pick(table(["Item", "Amount"], ["Lot purchase", 600_000], ["Framing and finishes", 1_450_000], ["Architect studies", 210_000], ["Overrun allowance", 90_000]))).toEqual([["land_cost", 600_000], ["hard_cost", 1_450_000], ["soft_cost", 210_000], ["contingency", 90_000]]);
  });
});
