import { describe, expect, test } from "vitest";
import { addressedText, extractCandidates, consolidate, checkArithmetic, verifyReadings, verifyReading, READING_FAILURE, READER_PROMPT, READER_PROMPT_VERSION, type NormalizedDocument, type Reading } from "../src/index.ts";
import { SF_PER_M2 } from "@agir/numbers";

describe("Card 173: financing costs in the reader prompt", () => {
  const otherCostNote = "- `other_cost`: a development cost that is not land, hard costs, soft costs, contingency or one of the other cost fields. Financing costs are never `other_cost`: interest, a construction interest reserve, capitalized interest, and lender, loan, commitment, broker or insurer fees on a loan. Name an interest reserve as `stated_interest_reserve`; list the others under `not_used`.";

  test("uses reader-v3", () => {
    expect(READER_PROMPT_VERSION).toBe("reader-v3");
  });
  test("contains the exact other_cost field note", () => {
    expect(READER_PROMPT.split("\n")).toContain(otherCostNote);
  });
  test("places other_cost after development_charges and before expense_ratio_pct", () => {
    const fieldNotes = READER_PROMPT.split("**Field notes.**\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(fieldNotes.map(line => line.split(":")[0])).toEqual([
      "- `development_charges`", "- `other_cost`", "- `expense_ratio_pct`",
    ]);
  });
});

const doc = (kind: NormalizedDocument["kind"]): NormalizedDocument => ({ kind, lines: [], tables: [], pageCount: null, needsOcr: false, fullText: "" });
describe("addressed text", () => {
  test.each(["docx", "xlsx", "pdf"] as const)("%s addresses and strike ranges", kind => {
    const d = doc(kind);
    const location = kind === "pdf" ? "page 2, line 7" : "paragraph 3";
    if (kind !== "xlsx") d.lines = [{ location, text: "Old 10 new 20", struck: [[4, 6]] }, { location: "empty", text: "  " }];
    d.tables = [{ name: "Costs", rows: [[{ ref: "Costs!A1", text: "Cost" }, { ref: "Costs!B1", text: "30", struck: [[0, 2]] }], [{ ref: "Costs!A2", text: "" }]] }];
    expect(addressedText(d, "invented." + kind)).toBe(`=== FILE invented.${kind} ===\n${kind === "xlsx" ? "" : `[${location}] Old ~~10~~ new 20\n`}[Costs!A1] Cost\n[Costs!B1] ~~30~~`);
  });
});
const d = doc("txt");
d.lines = [{ location: "line 1", text: "Area 100 m²; vacancy 4%; duration 2 years; cost $400." }, { location: "line 2", text: "Elsewhere 900" }];
const documents = [{ id: "d", name: "fiction.txt", document: d }];
const reading: Reading = { field: "land_cost", item: null, value: 400, unit_seen: "$", file: "fiction.txt", location: "line 1", quote: "$400", note: null, confidence: "high" };
describe("reading verification", () => {
  test.each([
    ["Taux : 7,215 %\nTerrain : 1 250 000 $\nCoût : 2 500 000,00 $", "7,215 %", 7.215, "exit_cap_rate_pct", "%"],
    ["Land: $1,250\nCost: $2,500.00", "1,250", 1250, "land_cost", "$"],
  ] as const)("uses the document number format: %s", (fullText, quote, value, field, unit_seen) => {
    const document = { ...doc("txt"), fullText, lines: [{ location: "line 1", text: fullText.split("\n")[0]! }] };
    expect(verifyReading({ ...reading, quote, value, field, unit_seen }, [{ id: "d", name: reading.file, document }])).toMatchObject({ outcome: "verified", candidate: { value } });
  });
  test.each(["senior_rate_pct", "mezz_rate_pct", "refinance_rate_pct"])("verifies basis points for %s", field => {
    const quote = "Senior interest rate: 621 bps";
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(verifyReading({ ...reading, field, value: 6.21, unit_seen: "%", quote }, [{ ...documents[0]!, document }])).toMatchObject({ outcome: "verified", candidate: { value: 6.21, unitSeen: "bps (÷ 100)" } });
    for (const value of [6.21, 621]) expect(verifyReading({ ...reading, field: "exit_cap_rate_pct", value, unit_seen: "%", quote }, [{ ...documents[0]!, document }])).toEqual({ outcome: READING_FAILURE.value });
  });
  test.each([
    ["Loan: $1.216M", 1216000],
  ])("verifies the alternate scaled reading with review: %s", (quote, value) => {
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(verifyReading({ ...reading, quote, value }, [{ ...documents[0]!, document }])).toMatchObject({ outcome: "verified", candidate: { value, ambiguous: true } });
  });
  test("a zero whole part reads as a decimal without review: Prêt : 0,614 M$", () => {
    const quote = "Prêt : 0,614 M$";
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    const got = verifyReading({ ...reading, quote, value: 614000 }, [{ ...documents[0]!, document }]);
    expect(got).toMatchObject({ outcome: "verified", candidate: { value: 614000 } });
    expect(got.candidate).not.toHaveProperty("ambiguous");
  });
  test("requires the scale and respects settled document formatting", () => {
    const quote = "Loan: $1.216M";
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    for (const value of [1216, 1.216]) expect(verifyReading({ ...reading, quote, value }, [{ ...documents[0]!, document }])).toEqual({ outcome: READING_FAILURE.value });
    const own = verifyReading({ ...reading, quote, value: 1216000000 }, [{ ...documents[0]!, document }]);
    expect(own.outcome).toBe("verified");
    expect(own.candidate).toHaveProperty("ambiguous", true);
    document.fullText += "\nCost: $2,500,000.50";
    const settled = verifyReading({ ...reading, quote, value: 1216000 }, [{ ...documents[0]!, document }]);
    expect(settled.outcome).toBe("verified");
    expect(settled.candidate).not.toHaveProperty("ambiguous");
    expect(verifyReading({ ...reading, quote, value: 1216000000 }, [{ ...documents[0]!, document }]).outcome).toBe(READING_FAILURE.value);
  });
  test.each([
    [{ field: "unknown" }, "field"], [{ field: "sell_units" }, "field"], [{ item: "studio" }, "item"],
    [{ file: "absent" }, "address"], [{ location: "line 9" }, "address"],
    [{ quote: "900", value: 900 }, "quote"], [{ value: 500 }, "value"], [{ unit_seen: "years" }, "unit"],
  ] as const)("rejects %j", (change, reason) => {
    expect(verifyReading({ ...reading, ...change }, documents)).toEqual({ outcome: READING_FAILURE[reason] });
  });
  test.each([
    [{ field: "rentable_area_sf", item: "studio", value: 100, unit_seen: "m2", quote: "100 m²" }, 100 * SF_PER_M2],
    [{ field: "stabilized_occupancy_pct", value: 4, unit_seen: "vacancy_%", quote: "4%" }, 96],
    [{ field: "construction_months", value: 2, unit_seen: "years", quote: "2 years" }, 24],
  ] as const)("converts %j", (change, value) => {
    expect(verifyReading({ ...reading, ...change }, documents)).toMatchObject({ outcome: "verified", candidate: { value, rule: "ai", documentId: "d", context: change.quote } });
  });
});

 test("card 160b: merged model text keeps every verification address", () => {
  const document = doc("xlsx");
  document.tables = [{ name: "Inputs", rows: [[..."ABCDE"].map(c => ({ ref: `Inputs!${c}1`, text: "Fictional test deal" }))] }];
  expect(addressedText(document, "fiction.xlsx")).toBe("=== FILE fiction.xlsx ===\n[Inputs!A1..E1] Fictional test deal");
  document.tables[0]!.rows.push([..."ABCDE"].map(c => ({ ref: `Inputs!${c}2`, text: "$400" })));
  for (const location of ["Inputs!C2", "Inputs!A2..E2"]) expect(verifyReading({ ...reading, file: "fiction.xlsx", location }, [{ id: "d", name: "fiction.xlsx", document }]).outcome).toBe("verified");
 });
 test.each([["$1.15M", 1150000], ["$1.001M", 1001000]] as const)("card 160b: scaled rounding %s", (quote, value) => {
  const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
  expect(verifyReading({ ...reading, quote, value }, [{ ...documents[0]!, document }]).outcome).toBe("verified");
 });


describe("Card 166: the verifier reads the quoted figure in context", () => {
  test.each([
    ["cell", "185K", "soft_cost", 185000, "$", "", "verified"],
    ["cell", "1.2M", "hard_cost", 1200000, "$", "", "verified"],
    ["cell", "267.168K", "soft_cost", 267168, "$", "Cost: $2,500.00", "verified"],
    ["cell", "1.208", "min_dscr_covenant", 1.208, "x", "", "verified"],
    ["line", "Minimum DSCR: 1.208", "min_dscr_covenant", 1.208, "x", "", "verified"],
    ["line", "Minimum DSCR: 1.208", "min_dscr_covenant", 1208, "x", "", READING_FAILURE.value],
    ["cell", "4.738", "exit_cap_rate_pct", 4.738, "%", "", "verified"],
    ["line", "Rent growth 2.206", "rent_growth_pct", 2.206, "%", "", "verified"],
    ["line", "Land 1.250", "land_cost", 1.25, "$", "", READING_FAILURE.value],
    ["line", "Land 1.250", "land_cost", 1250, "$", "", READING_FAILURE.value],
    ["line", "Construction budget | 3.226 million dollars", "hard_cost", 3226000, "$", "Cost: $2,500.00", "verified"],
    ["line", "Budget de construction : 3,2 millions de dollars", "hard_cost", 3200000, "$", "Coût : 2 500,00 $", "verified"],
    ["line", "Durée des travaux : vingt et un mois", "construction_months", 21, "months", "", "verified"],
    ["line", "Construction period: twenty one months", "construction_months", 21, "months", "", "verified"],
    ["line", "Construction period: twenty-one months", "construction_months", 21, "months", "", "verified"],
    ["line", "500 dollars US", "land_cost", 500, "$", "", READING_FAILURE.unit],
    ["line", "Land: US$1,250,000", "land_cost", 1250000, "$", "", READING_FAILURE.unit],
    ["line", "Land: $1,250,000 USD", "land_cost", 1250000, "$", "", READING_FAILURE.unit],
    ["line", "Land: 2 million dollars américains", "land_cost", 2000000, "$", "", READING_FAILURE.unit],
    ["line", "Land: $1,250,000 CAD", "land_cost", 1250000, "$", "", "verified"],
    ["line", "Land: C$1,250,000", "land_cost", 1250000, "$", "", "verified"],
    ["line", "Période de détention : vingt et un ans", "hold_years", 21, "years", "", "verified"],
    ["cell", "185K", "soft_cost", 185, "$", "", READING_FAILURE.value],
  ] as const)("%s %s for %s = %s: %s %s %s", (where, quote, field, value, unit_seen, evidence, outcome) => {
    const document = doc(where === "cell" ? "xlsx" : "txt");
    document.fullText = [quote, evidence].filter(Boolean).join("\n");
    const location = where === "cell" ? "Costs!B4" : "line 1";
    if (where === "cell") document.tables = [{ name: "Costs", rows: [[{ ref: location, text: quote }]] }];
    else document.lines = [{ location, text: quote }];
    const got = verifyReading({ ...reading, location, quote, field, value, unit_seen }, [{ ...documents[0]!, document }]);
    expect(got.outcome).toBe(outcome);
    if (outcome === "verified") {
      expect(got.candidate).toMatchObject({ value });
      expect(got.candidate).not.toHaveProperty("ambiguous");
    }
  });
  test("normalizes a cell range before reading its scaled amount", () => {
    const document = doc("xlsx");
    document.fullText = "185K";
    document.tables = [{ name: "Costs", rows: [[{ ref: "Costs!B4", text: "185K" }]] }];
    expect(verifyReading({ ...reading, location: "Costs!B4..D4", quote: "185K", field: "soft_cost", value: 185000 }, [{ ...documents[0]!, document }])).toMatchObject({ outcome: "verified", candidate: { value: 185000 } });
  });
  test("the fallback reader extracts twenty one construction months, never one", () => {
    const quote = "Construction period: twenty one months";
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(extractCandidates(document).candidates.map(c => [c.fieldKey, c.value])).toEqual([["construction_months", 21]]);
  });
  test.each(["Coûts de construction : 5,2 millions 1 de dollars", "Land cost: 500 usd"])("the fallback reader reads no money from %s", quote => {
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(extractCandidates(document).candidates).toEqual([]);
  });
  test.each(["Hard costs in 2024 dollars: 5,000,000", "Hard costs in 2024 dollars: $5,000,000"])("the fallback reader takes the amount, not the year, from %s", quote => {
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(extractCandidates(document).candidates.map(c => [c.fieldKey, c.value])).toEqual([["hard_cost", 5000000]]);
  });
});

describe("Card 167: whole-building AI unit counts", () => {
  const lines = ["Type A: 24 units", "Type B: 24 units", "Total units: 48", "Units: 7"];
  const document = { ...doc("txt"), fullText: lines.join("\n"), lines: lines.map((text, i) => ({ location: `line ${i + 1}`, text })) };
  const sources = [{ id: "d", name: "fiction.txt", document }];
  const count = (item: string | null, line = 3): Reading => ({ ...reading, field: "unit_count", item, value: line === 4 ? 7 : line < 3 ? 24 : 48, unit_seen: "units", location: `line ${line}`, quote: lines[line - 1]! });

  test.each([["total", 3], [null, 3], ["Total", 4]] as const)("verifies whole count %s at line %s", (item, line) => {
    expect(verifyReading(count(item, line), sources)).toMatchObject({ outcome: "verified", candidate: { itemKey: null, value: line === 4 ? 7 : 48 } });
  });
  test.each([["total", 3], [null, 3], ["Total", 4]] as const)("checks whole count %s at line %s against the types", (item, line) => {
    const candidates = [count("Type A", 1), count("Type B", 2), count(item, line)].flatMap(r => {
      const result = verifyReading(r, sources);
      return result.candidate ? [result.candidate] : [];
    });
    expect(checkArithmetic(consolidate(candidates, "CAD")).map(p => ({ itemKey: p.itemKey, value: p.value, check: p.check }))).toEqual([
      { itemKey: null, value: line === 4 ? 7 : 48, check: line === 4
        ? { outcome: "questions", note: "Please check: the unit types read add up to 48, the documents state 7" }
        : { outcome: "confirms", note: "Checked: the unit types read add up to the stated total of 48" } },
      { itemKey: "Type A", value: 24, check: undefined },
      { itemKey: "Type B", value: 24, check: undefined },
    ]);
  });
  test.each(["Total", "Grand Total", "Total Units", "Total Unit", "Units Total", "Total Unit Count", "Total Number of Units", "Building Total", "Total Logements", "Total des Logements", "Nombre total de logements", "Logements au Total", "  TÓTAL   UNITS :  ", "", " \t "])("normalizes whole-count item %j", item => {
    expect(verifyReading(count(item), sources)).toMatchObject({ outcome: "verified", candidate: { itemKey: null } });
  });
  test.each(["All units", "Type A", "Totally renovated suites"])("preserves unit type %s", item => {
    expect(verifyReading(count(item), sources)).toMatchObject({ outcome: "verified", candidate: { itemKey: item } });
  });
  test.each([null, "total"])("preserves monthly-rent item behavior for %s", item => {
    const result = verifyReading({ ...count(item), field: "unit_rent_monthly", unit_seen: "$" }, sources);
    expect(result).toMatchObject(item === null ? { outcome: READING_FAILURE.item } : { outcome: "verified", candidate: { itemKey: "total" } });
  });
  test.each([null, "Total"])("normalizes whole counts in conflicts for %s", item => {
    const { field, note, confidence, ...value } = count(item);
    const result = verifyReadings({ readings: [], conflicts: [{ field, item, values: [value], why: "Invented disagreement" }], not_used: [] }, sources);
    expect(result.conflicts[0]).toMatchObject([{ outcome: "verified", candidate: { itemKey: null, note: "Invented disagreement" } }]);
  });
  test.each([
    [{ location: "line 9" }, READING_FAILURE.address],
    [{ quote: "Absent 48" }, READING_FAILURE.quote],
    [{ value: 49 }, READING_FAILURE.value],
    [{ unit_seen: "$" }, READING_FAILURE.unit],
  ] as const)("still checks whole-count evidence %j", (change, outcome) => {
    expect(verifyReading({ ...count(null), ...change }, sources)).toEqual({ outcome });
  });
});

describe("Card 168: fallback reader word ranges", () => {
  test.each([
    ["Lease-up: seven to nine months", []],
    ["Lease-up: nine months", [9]],
  ] as const)("%s", (quote, expected) => {
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    expect(extractCandidates(document).candidates.filter(c => c.fieldKey === "lease_up_months").map(c => c.value)).toEqual(expected);
  });
});

describe("Card 169: a field's usual range settles three digits with review", () => {
  test.each([
    ["Rent: $29.009/sf/year", "rent_psf_annual", "Retail", "$/sf", 29.009, "verified", true],
    ["Rent: $29.009/sf/year", "rent_psf_annual", "Retail", "$/sf", 29009, "verified", false],
    ["Rent: $29,009/sf/year", "rent_psf_annual", "Retail", "$/sf", 29.009, "verified", true],
    ["Rent: $1.250/sf/year", "rent_psf_annual", "Retail", "$/sf", 1.25, READING_FAILURE.value, false],
    ["Rent: $1.250/sf/year", "rent_psf_annual", "Retail", "$/sf", 1250, "verified", false],
    ["Rent: $250.500/sf/year", "rent_psf_annual", "Retail", "$/sf", 250.5, READING_FAILURE.value, false],
    ["Rent: $29.50/sf/year", "rent_psf_annual", "Retail", "$/sf", 29.5, "verified", false],
    ["Rent: $1.250 per month", "unit_rent_monthly", "Type A", "$", 1250, "verified", false],
    ["Rent: $1.250 per month", "unit_rent_monthly", "Type A", "$", 1.25, READING_FAILURE.value, false],
    ["Rent: $2.450 per month", "unit_rent_monthly", "Type A", "$", 2450, "verified", false],
    ["Minimum DSCR: 1.208", "min_dscr_covenant", null, "x", 1.208, "verified", false],
  ] as const)("%s for %s = %s %s %s %s %s", (quote, field, item, unit_seen, value, outcome, ambiguous) => {
    const document = { ...doc("txt"), fullText: quote, lines: [{ location: "line 1", text: quote }] };
    const got = verifyReading({ ...reading, quote, field, item, unit_seen, value }, [{ ...documents[0]!, document }]);
    expect(got.outcome).toBe(outcome);
    if (outcome === "verified") {
      expect(got.candidate).toMatchObject({ value });
      if (ambiguous) expect(got.candidate).toHaveProperty("ambiguous", true);
      else expect(got.candidate).not.toHaveProperty("ambiguous");
    }
  });
});
