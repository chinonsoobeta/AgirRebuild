import { describe, expect, test } from "vitest";
import { parseDocument, addressedText, extractCandidates, consolidate, checkArithmetic, verifyReadings, verifyReading, READING_FAILURE, READER_PROMPT, READER_PROMPT_VERSION, type NormalizedDocument, type Reading, type SourcedCandidate } from "../src/index.ts";
import { SF_PER_M2 } from "@agir/numbers";

describe("Card 173: financing costs in the reader prompt", () => {
  const otherCostNote = "- `other_cost`: a development cost that is not land, hard costs, soft costs, contingency or one of the other cost fields. Financing costs are never `other_cost`: interest, a construction interest reserve, capitalized interest, and lender, loan, commitment, broker or insurer fees on a loan. Name an interest reserve as `stated_interest_reserve`; list the others under `not_used`.";

  test("contains the exact other_cost field note", () => {
    expect(READER_PROMPT.split("\n")).toContain(otherCostNote);
  });
  test("places other_cost after development_charges and before expense_ratio_pct", () => {
    const fieldNotes = READER_PROMPT.split("**Field notes.**\n")[1]!.split("\n\n")[0]!.split("\n");
    expect(fieldNotes.map(line => line.split(":")[0])).toEqual([
      "- `development_charges`", "- `other_cost`", "- `expense_ratio_pct`", "- `fixed_opex_annual`",
    ]);
  });
});

describe("Card K: operating-expense totals, scenarios, rounding and final figures in the reader prompt", () => {
  const lines = READER_PROMPT.split("\n");
  const fixedOpexNote = "- `fixed_opex_annual`: the deal's total annual operating expenses in dollars for the whole property, however they are named (operating expenses, total expenses, \"dépenses totales\"). \"Fixed\" only means a dollar amount rather than a share of revenue: the documents need not split fixed from variable expenses, and an expense ratio stated beside the total is named too. A total that includes mortgage payments or debt service is not this field. When the total you name includes property tax, list the tax under `not_used`, not as `property_tax_annual`.";
  const replacesRule = "- When the documents give two different values for one field and neither clearly replaces the other, list it under `conflicts`, not `readings`. When one value visibly replaces another (a revision or correction, or a figure the document calls final, updated or revised), read that one and mention the old one in `note`.";
  const scenarioRule = "- When the documents give a base case and a downside, upside, sensitivity or stress case for one field, read the base case and list the other cases under `not_used` with the reason; they are not conflicts. When alternatives with no base case all give the same value for a field, read that value.";
  const roundingRule = "- When the same figure is written exactly in one place and rounded in another (for example $12,345,000 in a budget and \"$12.3 million\" in a summary), read the exact one and mention the rounded one in `note`; this is not a conflict.";

  test("uses reader-v4", () => {
    expect(READER_PROMPT_VERSION).toBe("reader-v4");
  });
  test.each([
    ["the fixed_opex_annual field note", fixedOpexNote],
    ["the final, updated or revised figure rule", replacesRule],
    ["the base-case scenario rule", scenarioRule],
    ["the rounded restatement rule", roundingRule],
  ])("contains %s", (_name, line) => {
    expect(lines).toContain(line);
  });
  test("keeps the new rules in the Rules section, after the conflict rule", () => {
    const rules = READER_PROMPT.split("**Rules.**")[1]!.split("**Output.**")[0]!.split("\n");
    const at = (line: string) => rules.indexOf(line);
    expect(at(replacesRule)).toBeGreaterThan(-1);
    expect(at(scenarioRule)).toBe(at(replacesRule) + 1);
    expect(at(roundingRule)).toBe(at(replacesRule) + 2);
  });
  test("no longer asks for a replaced value in quote", () => {
    expect(READER_PROMPT).not.toContain("mention the old one in `quote`");
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
d.lines = [{ location: "line 1", text: "Area 100 m²; vacancy 4%; duration 2 years; cost $1400." }, { location: "line 2", text: "Elsewhere 900" }];
const documents = [{ id: "d", name: "fiction.txt", document: d }];
const reading: Reading = { field: "land_cost", item: null, value: 1400, unit_seen: "$", file: "fiction.txt", location: "line 1", quote: "$1400", note: null, confidence: "high" };
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
  document.tables[0]!.rows.push([..."ABCDE"].map(c => ({ ref: `Inputs!${c}2`, text: "$1400" })));
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
    ["cell", "185K", "soft_cost", 185, "$", "", "verified"],
  ] as const)("%s %s for %s = %s: %s %s %s", (where, quote, field, value, unit_seen, evidence, outcome) => {
    const document = doc(where === "cell" ? "xlsx" : "txt");
    document.fullText = [quote, evidence].filter(Boolean).join("\n");
    const location = where === "cell" ? "Costs!B4" : "line 1";
    if (where === "cell") document.tables = [{ name: "Costs", rows: [[{ ref: location, text: quote }]] }];
    else document.lines = [{ location, text: quote }];
    const got = verifyReading({ ...reading, location, quote, field, value, unit_seen }, [{ ...documents[0]!, document }]);
    expect(got.outcome).toBe(outcome);
    if (outcome === "verified") {
      expect(got.candidate).toMatchObject({ value: quote === "185K" ? 185000 : value });
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
  test("QA run 3: a quote that starts with its own address marker still verifies", () => {
    const c = count(null);
    expect(verifyReading({ ...c, quote: `[${c.location}] ${c.quote}` }, sources)).toMatchObject({ outcome: "verified", candidate: { value: 48, context: c.quote } });
    expect(verifyReading({ ...c, quote: `[line 9] ${c.quote}` }, sources)).toEqual({ outcome: READING_FAILURE.quote });
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

describe("Card 171: two figures separated by a plain space", () => {
  test.each([
    ["d.txt", 2, "unit_count", "one-bedroom", 60, "units", "verified", true],
    ["d.txt", 2, "unit_count", "one-bedroom", 60590, "units", READING_FAILURE.value, false],
    ["d.txt", 2, "rentable_area_sf", "one-bedroom", 590, "sf", "verified", true],
    ["d.txt", 3, "unit_count", "two-bedroom", 50, "units", "verified", true],
    ["d.txt", 4, "land_cost", null, 8500000, "$", "verified", false],
    ["e.txt", 3, "unit_count", null, 1200, "units", "verified", false],
    ["e.txt", 3, "unit_count", null, 1, "units", READING_FAILURE.value, false],
    ["f.txt", 2, "unit_count", "studio", 50, "units", READING_FAILURE.value, false],
  ] as const)("%s line %s: %s %s = %s", async (file, line, field, item, value, unit_seen, outcome, ambiguous) => {
    const text = {
      "d.txt": "Suite mix\nOne-bedroom 60 590 $2,200\nTwo-bedroom 50 820 $2,600\nLand $8,500,000",
      "e.txt": "Sommaire\nTerrain 8 500 000 $\nLogements 1 200",
      "f.txt": "Suite mix\nStudio 1 050 $1,900",
    }[file];
    const document = await parseDocument(new TextEncoder().encode(text), file);
    const quote = text.split("\n")[line - 1]!;
    const got = verifyReading({ ...reading, file, location: `line ${line}`, quote, field, item, value, unit_seen }, [{ id: file, name: file, document }]);
    expect(got.outcome).toBe(outcome);
    if (outcome === "verified") {
      expect(got.candidate).toMatchObject({ value });
      if (ambiguous) expect(got.candidate).toHaveProperty("ambiguous", true);
      else expect(got.candidate).not.toHaveProperty("ambiguous");
    }
  });
});

describe("Card 170: money scales and accounting brackets", () => {
  const texts = {
    "a.txt": "Project budget\nEstimated development costs ($M)\nLand 9.44\nDevelopment costs 60.34\nTotal $69.78\nRequired mortgage ($M) $43.63",
    "c.txt": "Term sheet\nFacility size $276.8 million\nEquity $184.6 million\nLand $9.44",
    "g.txt": "Operating budget\nProperty taxes ($705,000)\nGST rebate ($50,000)",
    "h.txt": "Budget ($K)\nLand 8,500\nHard costs 29,150",
    "i.txt": "Coûts du projet (M$)\nTerrain 9,44\nConstruction 60,34",
    "j.csv": "Item,Cost ($M)\nLand,9.44\nTotal,69.78",
    "k.csv": 'Item,Cost ($000s)\nLand,"8,500"\nTotal,"69,780"',
    "m.txt": "Budget (in thousands of dollars)\nLand 8,500\nLoan $12,000,000",
    "plain.txt": "Land $8,500,000\nTerrain 8 500 000 $\nContingency $0",
    "mixed.txt": "Budget ($K; $M)\nLand $8,500",
    "own.txt": "Budget ($K)\nLand $1.2M",
    "words.txt": "Purchase agreement\n(e) Purchase Price: Twenty One Million Seven Hundred Fifty\nThousand Dollars\nAncillary income $71,000",
    "mots.txt": "Convention d'achat\nPrix : vingt et un millions sept cent cinquante\nmille dollars\nAutres revenus 71 000 $",
    "over.txt": "Proceeds\nOver a million\nAncillary income $71,000",
  };
  const millions = "$ (stated in millions; × 1,000,000)";
  const thousands = "$ (stated in thousands; × 1,000)";
  test.each([
    ["a.txt", "line 3", "Land 9.44", "land_cost", 9.44, 9440000, millions],
    ["a.txt", "line 3", "Land 9.44", "land_cost", 9440000, 9440000, millions],
    ["a.txt", "line 5", "Total $69.78", "stated_total_cost", 69.78, 69780000, millions],
    ["a.txt", "line 6", "Required mortgage ($M) $43.63", "senior_loan_amount", 43.63, 43630000, millions],
    ["c.txt", "line 2", "Facility size $276.8 million", "senior_loan_amount", 276.8, 276800000, "$"],
    ["c.txt", "line 2", "Facility size $276.8 million", "senior_loan_amount", 276800000, 276800000, "$"],
    ["c.txt", "line 4", "Land $9.44", "land_cost", 9.44, "small", "$"],
    ["g.txt", "line 2", "Property taxes ($705,000)", "property_tax_annual", 705000, 705000, "$"],
    ["g.txt", "line 2", "Property taxes ($705,000)", "property_tax_annual", -705000, -705000, "$"],
    ["g.txt", "line 3", "GST rebate ($50,000)", "other_cost", -50000, -50000, "$"],
    ["g.txt", "line 3", "GST rebate ($50,000)", "other_cost", 50000, "value", "$"],
    ["h.txt", "line 2", "Land 8,500", "land_cost", 8500, 8500000, thousands],
    ["i.txt", "line 2", "Terrain 9,44", "land_cost", 9.44, 9440000, millions],
    ["j.csv", "B2", "9.44", "land_cost", 9.44, 9440000, millions],
    ["k.csv", "B2", "8,500", "land_cost", 8500, 8500000, thousands],
    ["m.txt", "line 2", "Land 8,500", "land_cost", 8500000, 8500000, thousands],
    ["m.txt", "line 3", "Loan $12,000,000", "senior_loan_amount", 12000000, "scale", "$"],
    ["plain.txt", "line 1", "Land $8,500,000", "land_cost", 8500000, 8500000, "$"],
    ["plain.txt", "line 2", "Terrain 8 500 000 $", "land_cost", 8500000, 8500000, "$"],
    ["plain.txt", "line 3", "Contingency $0", "contingency", 0, 0, "$"],
    ["mixed.txt", "line 2", "Land $8,500", "land_cost", 8500, "scale", "$"],
    ["own.txt", "line 2", "Land $1.2M", "land_cost", 1.2, 1200000, "$"],
    ["words.txt", "line 4", "Ancillary income $71,000", "other_income_annual", 71000, 71000, "$"],
    ["mots.txt", "line 4", "Autres revenus 71 000 $", "other_income_annual", 71000, 71000, "$"],
    ["over.txt", "line 3", "Ancillary income $71,000", "other_income_annual", 71000, 71000, "$"],
  ] as const)("%s %s %s = %s", async (file, location, quote, field, value, expected, unitSeen) => {
    const document = await parseDocument(new TextEncoder().encode(texts[file]), file);
    const got = verifyReading({ ...reading, file, location, quote, field, value }, [{ id: file, name: file, document }]);
    expect(got.outcome).toBe(typeof expected === "number" ? "verified" : READING_FAILURE[expected]);
    if (typeof expected === "number") expect(got.candidate).toMatchObject({ value: expected, unitSeen });
  });
  test("a scale heading in running text ends at its page", () => {
    const lines = ([
      ["Building permit values ($ 000)", "page 1, line 1"],
      ["Permit values reached", "page 1, line 2"],
      ["Land $8,500", "page 1, line 3"],
      ["Property taxes $120,000", "page 2, line 1"],
      ["Land cost: $9,440,000", "page 2, line 2"],
    ] as [string, string][]).map(([text, location]) => ({ text, location }));
    const document = { ...doc("pdf"), lines, pageCount: 2, fullText: lines.map(l => l.text).join("\n") };
    const read = (location: string, quote: string, field: string, value: number) =>
      verifyReading({ ...reading, file: "p.pdf", location, quote, field, value }, [{ id: "p.pdf", name: "p.pdf", document }]).outcome;
    expect(read("page 1, line 3", "Land $8,500", "land_cost", 8500)).toBe(READING_FAILURE.scale);
    expect(read("page 2, line 1", "Property taxes $120,000", "property_tax_annual", 120000)).toBe("verified");
    // The rule reader, frozen as the fallback, still keeps the heading to the end of the document.
    expect(extractCandidates(document).candidates.filter(c => c.fieldKey === "land_cost")).toEqual([]);
  });
});
describe("Card 174: a financing figure is not an other cost", () => {
  const build = (name: string, rows: [string, string][]) => {
    const lines = rows.map(([text, location]) => ({ text, location }));
    return { id: name, name, document: { ...doc("txt"), lines, fullText: lines.map(l => l.text).join("\n") } };
  };
  const english = build("budget.txt", [
    ["Financing costs $1,250,000", "line 1"],
    ["Other costs (excluding financing) $400,000", "line 2"],
    ["Developer fee $300,000", "line 3"],
    ["Lender fee $25,000; Other $40,000", "line 4"],
    ["Capitalized interest: $610,000", "line 5"],
    ["Permit levies $55,000", "line 6"],
  ]);
  const french = build("budget-fr.txt", [
    ["Frais de financement : 850 000 $", "line 1"],
    ["Autres coûts hors financement : 120 000 $", "line 2"],
    ["Intérêts capitalisés : 410 000 $", "line 3"],
  ]);
  const sheet = { id: "b.xlsx", name: "b.xlsx", document: { ...doc("xlsx"), tables: [{ name: "Budget", rows: [
    [{ ref: "Budget!A1", text: "Interest during construction" }, { ref: "Budget!B1", text: "1,100,000" }],
    [{ ref: "Budget!A2", text: "Other" }, { ref: "Budget!B2", text: "75,000" }],
  ] }], fullText: "Interest during construction 1,100,000\nOther 75,000" } };
  const sources = [english, french, sheet];
  const read = (file: string, location: string, quote: string, value: number, field = "other_cost") =>
    verifyReading({ ...reading, file, location, quote, value, field }, sources).outcome;
  test.each([
    ["budget.txt", "line 1", "Financing costs $1,250,000", 1250000, READING_FAILURE.financing],
    ["budget.txt", "line 1", "$1,250,000", 1250000, READING_FAILURE.financing],
    ["budget.txt", "line 2", "$400,000", 400000, "verified"],
    ["budget.txt", "line 3", "Developer fee $300,000", 300000, "verified"],
    ["budget.txt", "line 4", "$25,000", 25000, READING_FAILURE.financing],
    ["budget.txt", "line 4", "Other $40,000", 40000, "verified"],
    ["budget.txt", "line 5", "$610,000", 610000, READING_FAILURE.financing],
    ["budget.txt", "line 6", "Permit levies $55,000", 55000, "verified"],
    ["budget-fr.txt", "line 1", "850 000 $", 850000, READING_FAILURE.financing],
    ["budget-fr.txt", "line 2", "120 000 $", 120000, "verified"],
    ["budget-fr.txt", "line 3", "Intérêts capitalisés : 410 000 $", 410000, READING_FAILURE.financing],
    ["b.xlsx", "Budget!B1", "1,100,000", 1100000, READING_FAILURE.financing],
    ["b.xlsx", "Budget!B2", "75,000", 75000, "verified"],
  ] as const)("%s %s %s as other_cost: %s", (file, location, quote, value, expected) => {
    expect(read(file, location, quote, value)).toBe(expected);
  });
  test("the same financing line is verified as the stated interest reserve", () => {
    expect(read("budget.txt", "line 1", "Financing costs $1,250,000", 1250000, "stated_interest_reserve")).toBe("verified");
    expect(read("budget-fr.txt", "line 1", "850 000 $", 850000, "stated_interest_reserve")).toBe("verified");
  });
  test("a conflict loses only its financing value", () => {
    const value = (location: string, quote: string, v: number) => ({ value: v, unit_seen: "$" as const, file: "budget.txt", location, quote });
    const result = verifyReadings({ readings: [], not_used: [], conflicts: [{ field: "other_cost", item: null, why: "Invented disagreement",
      values: [value("line 1", "$1,250,000", 1250000), value("line 3", "Developer fee $300,000", 300000)] }] }, sources);
    expect(result.conflicts[0]).toMatchObject([{ outcome: READING_FAILURE.financing }, { outcome: "verified", candidate: { fieldKey: "other_cost", value: 300000 } }]);
  });
});

describe("Card J: verifier refusals of figures that are written", () => {
  const build = (name: string, texts: string[]) => {
    const lines = texts.map((text, i) => ({ text, location: `line ${i + 1}` }));
    return { id: name, name, document: { ...doc("txt"), lines, fullText: texts.join("\n") } };
  };
  const sources = [
    // A letterhead phone number and an IP address are not decimal commas.
    build("memo.txt", ["415.701.5500  415.701.5501 fax", "IP address: 99.229.253.21", "Rate 5.25%", "Transfer Tax 102,000 102,000", "Real Estate Taxes 40,120 Assumes 25% exempt"]),
    // Real evidence of both separators still leaves a lone group ambiguous.
    build("both.txt", ["Loan 12.400.000", "Rate 5.25%", "Transfer Tax 102,000"]),
    build("prose.txt", ["The final costs show a total project budget of $16.4 million including land"]),
    // A short line under a scale heading ends what it covers; the figure's own label still states its scale.
    build("chip.txt", ["Anticipated sources of funding ($M)", "Applicant land equity 9.44", "Initiative grant", "Required mortgage ($M) $43.63", "Land (in thousands) 8,500"]),
    build("label.txt", ["Summary", "Required mortgage ($M) $43.63", "Land costs ($K) $1,250 then Loan $12,000,000"]),
    build("clash.txt", ["Budget ($K)", "Required mortgage ($M) $43.63"]),
    // A scale word inside a figure written in words is not the label's scale.
    build("words.txt", ["Purchase agreement", "Seven Million Four Hundred Twenty Thousand (CAD $7,420,000.00) Dollars being the price", "Thousand (CAD $7,420,000.00) Dollars", "Prix : sept millions quatre cent vingt mille (7 420 000 $) dollars", "mille (7 420 000 $) dollars"]),
    build("markers.txt", ["Land in thousands 8,500", "Hard costs $ millions 29.15", "Terrain en milliers 8 500 $"]),
  ];
  const millions = "$ (stated in millions; × 1,000,000)";
  const thousands = "$ (stated in thousands; × 1,000)";
  test.each([
    ["memo.txt", "line 4", "Transfer Tax 102,000 102,000", "land_transfer_tax", 102000, 102000, "$"],
    ["memo.txt", "line 5", "Real Estate Taxes 40,120 Assumes 25% exempt", "property_tax_annual", 40120, 40120, "$"],
    ["memo.txt", "line 5", "Real Estate Taxes 40,120 Assumes 25% exempt", "property_tax_annual", 40.12, "value", "$"],
    ["prose.txt", "line 1", "total project budget of $16.4 million including land", "stated_total_cost", 16400000, 16400000, "$"],
    ["prose.txt", "line 1", "total project budget of $16.4 million including land", "stated_total_cost", 16.4, 16400000, "$"],
    ["prose.txt", "line 1", "total project budget of $16.4 million including land", "stated_total_cost", 1640000, "value", "$"],
    ["chip.txt", "line 4", "Required mortgage ($M) $43.63", "senior_loan_amount", 43.63, 43630000, millions],
    ["chip.txt", "line 4", "Required mortgage ($M) $43.63", "senior_loan_amount", 43630000, 43630000, millions],
    ["chip.txt", "line 4", "$43.63", "senior_loan_amount", 43.63, 43630000, millions],
    ["chip.txt", "line 5", "Land (in thousands) 8,500", "land_cost", 8500, 8500000, thousands],
    ["label.txt", "line 2", "Required mortgage ($M) $43.63", "senior_loan_amount", 43.63, 43630000, millions],
    ["label.txt", "line 3", "Land costs ($K) $1,250", "land_cost", 1250, 1250000, thousands],
    // The label of the second figure is "then Loan", not the "($K)" of the first.
    ["label.txt", "line 3", "Loan $12,000,000", "senior_loan_amount", 12000000, 12000000, "$"],
    ["clash.txt", "line 2", "Required mortgage ($M) $43.63", "senior_loan_amount", 43.63, "scale", "$"],
    ["words.txt", "line 2", "Thousand (CAD $7,420,000.00) Dollars", "land_cost", 7420000, 7420000, "$"],
    ["words.txt", "line 3", "Thousand (CAD $7,420,000.00) Dollars", "land_cost", 7420000, 7420000, "$"],
    ["words.txt", "line 4", "mille (7 420 000 $) dollars", "land_cost", 7420000, 7420000, "$"],
    ["words.txt", "line 5", "mille (7 420 000 $) dollars", "land_cost", 7420000, 7420000, "$"],
    ["markers.txt", "line 1", "Land in thousands 8,500", "land_cost", 8500, 8500000, thousands],
    ["markers.txt", "line 2", "Hard costs $ millions 29.15", "hard_cost", 29.15, 29150000, millions],
    ["markers.txt", "line 3", "Terrain en milliers 8 500 $", "land_cost", 8500, 8500000, thousands],
  ] as const)("%s %s %s = %s", (file, location, quote, field, value, expected, unitSeen) => {
    const got = verifyReading({ ...reading, file, location, quote, field, value }, sources);
    expect(got.outcome).toBe(typeof expected === "number" ? "verified" : READING_FAILURE[expected]);
    if (typeof expected === "number") {
      expect(got.candidate).toMatchObject({ value: expected, unitSeen });
      expect(got.candidate).not.toHaveProperty("ambiguous");
    }
  });
  test("a lone group under real evidence of both separators is still refused", () => {
    const got = verifyReading({ ...reading, file: "both.txt", location: "line 3", quote: "Transfer Tax 102,000", field: "land_transfer_tax", value: 102000 }, sources);
    expect(got.outcome).toBe(READING_FAILURE.value);
  });
});

describe("QA card C1: unit types read from one line are one type", () => {
  const lines = ["Rents", "Units 4", "Rent per unit per month $1,850"];
  const budget: NormalizedDocument = { kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 19}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") };
  const docs = [{ id: "b", name: "invented-budget.pdf", document: budget }];
  const sourced = (r: ReturnType<typeof extractCandidates>) => r.candidates.map(c => ({ ...c, documentId: "b", documentName: "invented-budget.pdf" }));
  const ai = (field: string, item: string, value: number, location: string, quote: string) => {
    const v = verifyReading({ field, item, value, unit_seen: field === "unit_count" ? "units" : "$", file: "invented-budget.pdf", location, quote, note: null, confidence: "high" }, docs);
    if (v.outcome !== "verified") throw new Error(v.outcome);
    return v.candidate!;
  };
  const types = (ps: ReturnType<typeof consolidate>) => ps.filter(p => ["unit_count", "unit_rent_monthly"].includes(p.fieldKey)).map(p => [p.fieldKey, p.itemKey, p.value]);

  test("an income section heading is not a unit type; a type heading still is", () => {
    expect(extractCandidates(budget).candidates.map(c => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_count", "All units", 4], ["unit_rent_monthly", "All units", 1850]]);
    for (const heading of ["Rent", "Rent roll", "Rental income", "Revenue", "Income", "Loyers", "Revenus", "Operations", "Operations and exit", "Operating"]) {
      const d = { ...budget, lines: budget.lines.map((l, i) => (i ? l : { ...l, text: heading })) };
      expect(extractCandidates(d).candidates.map(c => c.itemKey), heading).toEqual(["All units", "All units"]);
    }
    const typed = { ...budget, lines: budget.lines.map((l, i) => (i ? l : { ...l, text: "Two-bedroom" })) };
    expect(extractCandidates(typed).candidates.find(c => c.fieldKey === "unit_count")?.itemKey).toBe("2BR");
  });

  test("the rule reader's and the AI's names for one line consolidate to one type", () => {
    const read = [...sourced(extractCandidates(budget)), ai("unit_count", "rental unit", 4, "page 1, line 20", "Units 4"), ai("unit_rent_monthly", "rental unit", 1850, "page 1, line 21", "$1,850")];
    expect(types(consolidate(read, "CAD"))).toEqual([["unit_count", "rental unit", 4], ["unit_rent_monthly", "rental unit", 1850]]);
  });

  test("a heading name, All units and the AI's name linked across a count and a rent are one type, named by the AI", () => {
    const rule = (fieldKey: string, itemKey: string, value: number, location: string) => ({ fieldKey, itemKey, value, location, raw: String(value), unitSeen: null, context: "", rule: "line:prose", note: null, documentId: "b", documentName: "invented-budget.pdf" }) as unknown as SourcedCandidate;
    const read = [rule("unit_count", "Rents", 4, "page 1, line 20"), rule("unit_rent_monthly", "All units", 1850, "page 1, line 21"), ai("unit_count", "rental unit", 4, "page 1, line 20", "Units 4"), ai("unit_rent_monthly", "rental unit", 1850, "page 1, line 21", "$1,850")];
    const ps = consolidate(read, "CAD");
    expect(types(ps)).toEqual([["unit_count", "rental unit", 4], ["unit_rent_monthly", "rental unit", 1850]]);
    expect(ps.find(p => p.fieldKey === "unit_count")!.sources).toHaveLength(2);
    // "All units" alone keeps its name.
    expect(types(consolidate([rule("unit_rent_monthly", "All units", 1850, "page 1, line 21")], "CAD"))).toEqual([["unit_rent_monthly", "All units", 1850]]);
    // Two types one reader names on one line with one value stay two types.
    const two = [rule("unit_count", "2BR", 4, "page 1, line 20"), rule("unit_count", "3BR", 4, "page 1, line 20"), ai("unit_count", "rental unit", 4, "page 1, line 20", "Units 4")];
    expect(types(consolidate(two, "CAD")).map(t => t[1])).toEqual(["2BR", "3BR", "rental unit"]);
  });

  test("the AI's \"Two-bedroom\" is the rule reader's \"2BR\", from another line", () => {
    for (const item of ["Two-bedroom", "2-bedroom", "two bedroom", "2 bed", "2 chambres"]) expect(ai("unit_rent_monthly", item, 1850, "page 1, line 21", "$1,850").itemKey, item).toBe("2BR");
    expect(ai("unit_count", "3½", 4, "page 1, line 20", "Units 4").itemKey).toBe("3½");
    const rule = { fieldKey: "unit_rent_monthly", itemKey: "2BR", value: 1850, location: "page 2, line 4", raw: "$1,850", unitSeen: "$/mo", context: "", rule: "table:labelled-roll", note: null, documentId: "r", documentName: "invented-roll.pdf" } as unknown as SourcedCandidate;
    expect(types(consolidate([rule, ai("unit_rent_monthly", "Two-bedroom", 1850, "page 1, line 21", "$1,850")], "CAD"))).toEqual([["unit_rent_monthly", "2BR", 1850]]);
  });
});
