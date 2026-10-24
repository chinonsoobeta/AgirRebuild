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
