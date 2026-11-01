import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { extractCandidates, parseDocument, type NormalizedDocument, type Cell } from "../src/index.ts";
import { boundedForRules, MAX_RULE_TEXT, MAX_RULE_FIGURES, MAX_RULE_CHARS, MAX_RULE_WORK } from "../src/rule-limits.ts";

const note = "This file is too long for Agir's rules to read in full, so they may have missed figures further in.";
const document = (texts: string[]): NormalizedDocument => ({ kind: "txt", lines: texts.map((text, i) => ({ text, location: `line ${i + 1}` })), tables: [], pageCount: null, needsOcr: false, fullText: texts.join("\n") });
const cells = (rows: Cell[][]) => ({ ...document([]), tables: [{ name: "Invented", rows }] });

describe("card 199 boundedForRules", () => {
  it("keeps the owner's four limits", () => {
    expect([MAX_RULE_TEXT, MAX_RULE_FIGURES, MAX_RULE_CHARS, MAX_RULE_WORK]).toEqual([10000, 50000, 3000000, 20000000]);
  });
  it("keeps an exact-limit line and document identity", () => {
    const doc = document(["a".repeat(MAX_RULE_TEXT)]);
    expect(boundedForRules(doc)).toEqual({ doc, cut: false });
    expect(boundedForRules(doc).doc).toBe(doc);
  });
  it("blanks only the long line, preserving locations and the input", () => {
    const doc = document(["x", "a".repeat(MAX_RULE_TEXT + 1), "Land cost: $1,000,000"]);
    const before = structuredClone(doc), result = boundedForRules(doc);
    expect(result.cut).toBe(true);
    expect(result.doc.lines.map(l => l.text.length)).toEqual([1, 0, 21]);
    expect(result.doc.lines.map(l => l.location)).toEqual(doc.lines.map(l => l.location));
    expect(doc).toEqual(before);
  });
  it("blanks only the long typed cell and preserves refs", () => {
    const doc = cells([[{ text: "a".repeat(MAX_RULE_TEXT), ref: "A1" }, { text: "a".repeat(MAX_RULE_TEXT + 1), ref: "B1" }]]);
    const before = structuredClone(doc), result = boundedForRules(doc);
    expect(result.cut).toBe(true);
    expect(result.doc.tables[0]!.rows[0]!.map(c => [c.text.length, c.ref])).toEqual([[10000, "A1"], [0, "B1"]]);
    expect(doc).toEqual(before);
  });
  it("keeps a long computed cell", () => {
    const doc = cells([[{ text: "a".repeat(MAX_RULE_TEXT + 1), ref: "A1", computed: true }]]);
    expect(boundedForRules(doc)).toEqual({ doc, cut: false });
  });
  it.each([[300, false, 300], [301, false, 301], [302, true, 301]] as const)("counts the characters of typed cells: %i rows of the longest cell", (n, cut, kept) => {
    const doc = cells(Array.from({ length: n }, (_, i) => [{ text: "a".repeat(MAX_RULE_TEXT), ref: `A${i + 1}` }]));
    const result = boundedForRules(doc);
    expect(result.cut).toBe(cut); expect(result.doc.tables[0]!.rows).toHaveLength(kept);
  });
  it.each([[50001, false, 50001], [50002, true, 50001]] as const)("bounds %i numbered lines", (n, cut, kept) => {
    const doc = document(Array.from({ length: n }, (_, i) => `n ${i}`)), result = boundedForRules(doc);
    expect(result.cut).toBe(cut); expect(result.doc.lines).toHaveLength(kept); expect(doc.lines).toHaveLength(n);
  });
  it.each([true, false])("counts typed figures but not computed figures: computed=%s", computed => {
    const doc = cells(Array.from({ length: MAX_RULE_FIGURES + 5 }, (_, i) => [{ text: String(i), number: i, ref: `A${i + 1}`, ...(computed ? { computed: true as const } : {}) }]));
    const result = boundedForRules(doc);
    expect(result.cut).toBe(!computed); expect(result.doc.tables[0]!.rows).toHaveLength(computed ? 50005 : 50001);
  });
  it("bounds total characters without changing the input", () => {
    const doc = document(Array(302).fill("a".repeat(MAX_RULE_TEXT))), result = boundedForRules(doc);
    expect(result.cut).toBe(true); expect(result.doc.lines).toHaveLength(301);
    expect(result.doc.fullText).toHaveLength(3000000); expect(doc.lines).toHaveLength(302);
  });
});

// One sentence of 3,000 figures in 6,000 characters asks 18 million of the 20 million allowed, and these figures read in milliseconds.
const D = "1 ".repeat(3000), land = "Land cost: $1,000,000";
describe("card 199 rule work", () => {
  it.each([
    { name: "one D", lines: [D], readings: [], unused: 1, cut: false },
    { name: "exactly the limit", lines: ["1 ".repeat(2000) + "a".repeat(6000)], readings: [], unused: 1, cut: false },
    { name: "just over the limit", lines: ["1 ".repeat(2001) + "a".repeat(5994)], readings: [], unused: 0, cut: true },
    { name: "the limit, then land", lines: ["1 ".repeat(2000) + "a".repeat(6000), land], readings: [], unused: 1, cut: true },
    { name: "two D", lines: [D, D], readings: [], unused: 1, cut: true },
    { name: "two D before land", lines: [D, D, land], readings: [], unused: 1, cut: true },
    { name: "land before two D", lines: [land, D, D], readings: [["land_cost", 1000000, "line 1"]], unused: 1, cut: true },
    { name: "dot leaders and abbreviation", lines: ["Land cost ........ $1,000,000", "Hard cost . . . . $2,000,000", "Soft cost.. $300,000", "Meeting at 3 p.m. Land cost: $1,000,001"], readings: [["land_cost", 1000000, "line 1"], ["hard_cost", 2000000, "line 2"], ["soft_cost", 300000, "line 3"], ["land_cost", 1000001, "line 4"]], unused: 1, cut: false },
    { name: "email boundaries", lines: ["Land cost: $1,000,000, write to notpart@example.com", "x".repeat(300), "@example.com hard cost $2,000,000"], readings: [["land_cost", 1000000, "line 1"], ["hard_cost", 2000000, "line 3"]], unused: 0, cut: false },
  ])("$name", ({ lines, readings, unused, cut }) => {
    const result = extractCandidates(document(lines));
    expect(result.candidates.map(c => [c.fieldKey, c.value, c.location])).toEqual(readings);
    expect(result.other).toHaveLength(unused); expect(result.notes.includes(note)).toBe(cut);
  }, 90000);
  it.each(["5% of ", "$1,000 "])("bounds an 800,000-character line of %s", pattern => {
    const doc = document([pattern.repeat(Math.ceil(800000 / pattern.length)).slice(0, 800000)]);
    const start = performance.now(), result = extractCandidates(doc);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(result.candidates).toEqual([]); expect(result.other).toEqual([]); expect(result.notes).toContain(note);
  }, 90000);
  it("keeps readings on either side of a long parsed text line", async () => {
    const doc = await parseDocument(new TextEncoder().encode([land, "a".repeat(10001), "Hard cost: $2,000,000"].join("\n")), "long.txt");
    const result = extractCandidates(doc);
    expect(result.candidates.map(c => [c.fieldKey, c.value, c.location])).toEqual([["land_cost", 1000000, "line 1"], ["hard_cost", 2000000, "line 3"]]);
    expect(result.other).toEqual([]); expect(result.notes).toContain(note);
  });
});

async function workbook(name: string, rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook(); wb.addWorksheet(name).addRows(rows);
  return parseDocument(new Uint8Array(await wb.xlsx.writeBuffer()), "invented.xlsx");
}
describe("card 199 scaling", () => {
  it("reads 4,000 headerless budget rows within 30 seconds", async () => {
    const doc = await workbook("Lines", [["Land cost", 1000000], ...Array.from({ length: 4000 }, (_, i) => [`Invented line ${i} of the workbook`, 1000 + i])]);
    const start = performance.now(), result = extractCandidates(doc);
    expect(performance.now() - start).toBeLessThan(30000);
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ fieldKey: "land_cost", value: 1000000 })]));
  }, 120000);
  it("reads 8,000 rent types within 15 seconds", async () => {
    const doc = await workbook("Rent roll", [["Unit type", "Units", "Monthly rent"], ...Array.from({ length: 8000 }, (_, i) => [`Type ${i}`, 1 + i % 9, 1000 + i])]);
    const start = performance.now(), result = extractCandidates(doc);
    expect(performance.now() - start).toBeLessThan(15000); expect(result.candidates).toHaveLength(16000);
  }, 120000);
  it("groups 600 suites within 15 seconds", async () => {
    const doc = await workbook("Rent roll", [["Unit", "Type", "Monthly rent"], ...Array.from({ length: 600 }, (_, i) => [String(100 + i), `Type ${Math.floor(i / 2)}`, 1000 + i % 2])]);
    const start = performance.now(), result = extractCandidates(doc);
    expect(performance.now() - start).toBeLessThan(15000); expect(result.candidates).toHaveLength(300); expect(result.other).toHaveLength(600);
  }, 120000);
  it("keeps suite types in first-appearance order", async () => {
    const doc = await workbook("Rent roll", [["Unit", "Type", "Monthly rent"], ["101", "Two bed", 2000], ["102", "One bed", 1500], ["103", "Two bed", 2000], ["104", "One bed", 1500]]);
    expect(extractCandidates(doc).candidates.filter(c => c.fieldKey === "unit_count").map(c => [c.itemKey, c.value])).toEqual([["2BR", 2], ["1BR", 2]]);
  });
});

describe("card 199 a wrapped paragraph stops at the limit", () => {
  // The label ends one line and its figure starts the next, so the figure is read only when the two lines join.
  const wrapped = (joined: number) => {
    const end = " the land cost is", figure = "$1,000,000";
    return document(["a".repeat(joined - figure.length - end.length) + end, figure]);
  };
  const land = (joined: number) => extractCandidates(wrapped(joined)).candidates.filter(c => c.fieldKey === "land_cost").map(c => c.value);
  it("joins two lines just under the limit", () => { expect(land(MAX_RULE_TEXT - 1)).toEqual([1000000]); });
  it("does not join two lines at the limit", () => { expect(land(MAX_RULE_TEXT)).toEqual([]); });
  it("does not join two lines over the limit", () => { expect(land(MAX_RULE_TEXT + 100)).toEqual([]); });
});

describe("card 199 a rent line is not a list of counts", () => {
  it("reads no mix count from a line that states a rent", () => {
    const doc = document(["6 x Studio, rent $1,500 a month"]);
    expect(extractCandidates(doc).candidates.filter(c => c.rule === "line:mix-count")).toEqual([]);
  });
});
