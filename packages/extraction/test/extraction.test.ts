import { describe, expect, test } from "vitest";
import { SF_PER_M2 } from "@agir/numbers";
import { assemble, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, normalizeLabel, parseDocument, scoreExtraction, type Cell, type NormalizedDocument, type SourcedCandidate, type Table } from "../src/index.ts";
import { relativeLinks } from "../src/parse.ts";
import { loadOracles, toNormalized } from "./oracle.ts";

const key = (f: string, i: string | null) => (i ? `${f}|${i}` : f);

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
    expect(c.value).toBeCloseTo(34.0025, 4);
  });
  test("a component named with only an area in m²", () => {
    const c = only(extractCandidates(doc(["Retail: 836 m²"])), "rentable_area_sf");
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
    const c = only(extractCandidates(doc(["Commerce : 9 400 pi²", "Prix demandé : 31 200 000"])), "rentable_area_sf");
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
    expect(budget.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000], ["hard_cost", 5_000_000]]);
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
    expect(none.candidates).toEqual([]);
    expect(none.other.map((o) => o.value)).toEqual([400_000, 200_000]);
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

  describe("the exit cap rate comes from the sentence", () => {
    test("a cap rate in a sentence about a sale is the exit cap rate; alone it stays unread", () => {
      expect(pick(read("We plan to sell at a 5.0% cap rate."))).toEqual([["exit_cap_rate_pct", 5]]);
      expect(pick(read("Cap rate on reversion: 5.25%"))).toEqual([["exit_cap_rate_pct", 5.25]]);
      expect(pick(read("Nous vendrons à un taux de capitalisation de 5,5 %."))).toEqual([["exit_cap_rate_pct", 5.5]]);
      expect(read("The going-in cap rate is 6%.").candidates).toEqual([]);
      expect(read("Cap rate: 5.25%").candidates).toEqual([]);
      expect(read("Le taux de capitalisation est de 5,5 %.").candidates).toEqual([]);
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
    // still negative: money
    expect(pick(read("Contingency: ($50,000)"))).toEqual([["contingency", -50_000]]);
    expect(pick(sheets(grid("S", ["Contingency", "(50,000.50)"])))).toEqual([["contingency", -50_000.5]]);
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
      // negative: an area under a component name that is no residential type keeps that name
      expect(items(read("Retail: 9,000 SF"))).toEqual([["rentable_area_sf", "Retail", 9_000]]);
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
  test("negative: a figure attached to its sign stays negative, in words too", () => {
    expect(pick(read("Other costs: -$12,500"))).toEqual([["other_cost", -12_500]]);
    expect(pick(read("Other costs: (25,000)", "Selling costs: 2.5%"))).toEqual([["other_cost", -25_000], ["selling_costs_pct", 2.5]]);
    expect(pick(read("Rent growth: -2%"))).toEqual([["rent_growth_pct", -2]]);
    const budget = extractCandidates(doc([], [textGrid(["Line item", "Amount"], ["Land acquisition", "1,000,000"], ["Other costs", "($25,000)"])]));
    expect(budget.candidates.map((c) => [c.fieldKey, c.value])).toEqual([["land_cost", 1_000_000], ["other_cost", -25_000]]);
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
    expect(noteOf(r, 160_000)).toBe("A price per unit, not the total");
    expect(pick(read("Land: $160,000 per lot, $480,000 total"))).toEqual([["land_cost", 480_000]]);
    expect(pick(read("Land cost: $160,000 per lot, for a total of $480,000"))).toEqual([["land_cost", 480_000]]);
  });
  test("a price each with no total reads nothing for land", () => {
    const r = read("The land is three lots at $160,000 each.");
    expect(pick(r)).toEqual([]);
    expect(noteOf(r, 160_000)).toBe("A price per unit, not the total");
    expect(pick(read("Land cost: $160,000 per lot; the deposit is $20,000"))).toEqual([]);
    expect(noteOf(read("Hard costs: $95,000 per door"), 95_000)).toBe("A price per unit, not the total");
  });
  test("chacun, chacune and par lot, par porte, par unité in French", () => {
    const r = read("Le terrain compte trois lots à 160 000 $ chacun (480 000 $).");
    expect(pick(r)).toEqual([["land_cost", 480_000]]);
    expect(noteOf(r, 160_000)).toBe("A price per unit, not the total");
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
    });
  });

  describe("a loan's term is not a period", () => {
    test("a duration labelled as the term is shown, in a label, a table or prose", () => {
      for (const [line, value] of [
        ["Term: 30 months", 30],
        ["Terme du prêt 24 mois (construction)", 24],
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
    expect(pick(r)).toEqual([["land_cost", 485_000], ["soft_cost", 455_000]]);
    for (const v of [3_100_000, 120_000, 180_000, 155_000]) expect(noteOf(r, v)).toBe(NOT_SHOWN);
    const en = budget(["Item", "Amount"], ["Land", 100_000], ["General contractor lump sum", 900_000], ["Architecture", 50_000], ["Engineering", 30_000], ["Total soft costs", 80_000]);
    expect(pick(en)).toEqual([["land_cost", 100_000], ["soft_cost", 80_000]]);
    expect(noteOf(en, 900_000)).toBe(NOT_SHOWN);
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
    expect(pick(fits)).toEqual([["land_cost", 100_000], ["soft_cost", 100_000]]);
    const off = budget(head, ["Terrain", 100_000], ["Entrepreneur général", 900_000], ["Honoraires professionnels", 50_000], ["Architecture", 30_000], ["Ingénierie", 20_000], ["Total des coûts indirects", 130_000]);
    expect(pick(off)).toEqual([["land_cost", 100_000], ["soft_cost", 130_000]]);
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
    test("a package with a part above the size cap is left exactly as it came", async () => {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="/xl/styles.xml"/></Relationships>`);
      zip.file("xl/extra.xml", "a".repeat(60 * 1024 * 1024), { compression: "DEFLATE" });
      const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
      expect(relativeLinks(bytes)).toBe(bytes);
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
    test("government charges and taxes are other costs, never the land", () => {
      expect(pick(read("Development charges: $120,000", "DCCs: $80,000", "Development cost charges: $60,000", "Permit levies: $12,000"))).toEqual([["other_cost", 120_000], ["other_cost", 80_000], ["other_cost", 60_000], ["other_cost", 12_000]]);
      expect(pick(read("Land transfer tax: $45,000", "LTT: $46,000", "DCs: $9,000"))).toEqual([["other_cost", 45_000], ["other_cost", 46_000], ["other_cost", 9_000]]);
      expect(pick(read("Taxe de bienvenue : 12 000 $", "Droits de mutation : 13 000 $"))).toEqual([["other_cost", 12_000], ["other_cost", 13_000]]);
      expect(pick(read("Land transfer tax of $45,000 is due at closing."))).toEqual([["other_cost", 45_000]]);
      const t = budget(["Item", "Amount"], ["Land", 485_000], ["Land transfer tax", 8_000], ["Development charges", 120_000]);
      expect(pick(t)).toEqual([["land_cost", 485_000], ["other_cost", 128_000]]);
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
      expect(pick(read("Charges including development charges: $120,000"))).toEqual([["other_cost", 120_000]]);
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
    const t = tableDoc([["Land", "$310,000"], ["Exemple seulement - ne fait pas partie du projet"], ["Land", "$90,000"]]);
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
