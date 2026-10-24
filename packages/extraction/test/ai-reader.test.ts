import { describe, expect, test } from "vitest";
import { addressedText, verifyReading, READING_FAILURE, type NormalizedDocument, type Reading } from "../src/index.ts";
import { SF_PER_M2 } from "@agir/numbers";
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
