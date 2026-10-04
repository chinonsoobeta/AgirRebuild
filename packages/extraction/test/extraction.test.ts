import { describe, expect, test } from "vitest";
import { SF_PER_M2 } from "@agir/numbers";
import { assemble, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, normalizeLabel, parseDocument, scoreExtraction, type Cell, type NormalizedDocument, type SourcedCandidate, type Table } from "../src/index.ts";
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
