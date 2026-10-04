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
    expect(unitRoll.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "1 chambre", 10], ["unit_rent_monthly", "1 chambre", 1_850], ["item_occupancy_pct", "1 chambre", 95]]);
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
    const d = await workbook([["Occupancy", 97, '0.0 "%"'], ["Rate", 0.28, "0.0%"], ["Escaped", 5, "0\\%"]]);
    const cells = d.tables[0]!.rows.map((r) => r[1]!);
    expect(cells[0]).toMatchObject({ number: 97, unit: "%" });
    expect(cells[1]).toMatchObject({ number: 28, unit: "%" });
    expect(cells[2]).toMatchObject({ number: 5, unit: "%" });
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
});
