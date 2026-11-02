// What the AI reader gets of a deal's files. Invented documents only.
import { expect, test } from "vitest";
import { addressedText, type NormalizedDocument } from "../src/index.ts";
import { MAX_READING_CHARS, MAX_ASKED_READING_CHARS, MIN_SHEET_ROOM, readingTexts, type ReadingInput } from "../src/reading-budget.ts";

const table = (name: string, size: number) => ({ name, rows: [[{ ref: `${name}!A1`, text: "x".repeat(size - "=== FILE w.xlsx ===\n".length - `[${name}!A1] `.length) }]] });
const workbook = (sheets: [string, number][], asked = false, name = "w.xlsx", kind: "xlsx" | "csv" = "xlsx"): ReadingInput => ({ name, asked, document: { kind, lines: [], tables: sheets.map(([n, s]) => table(n, s)), fullText: "", pageCount: null, needsOcr: false } });
const pdf = (size: number): ReadingInput => ({ name: "p.pdf", asked: false, document: { kind: "pdf", lines: [{ text: "p".repeat(size), location: "page 1 line 1" }], tables: [], fullText: "", pageCount: null, needsOcr: false } });
const textOf = (input: ReadingInput) => addressedText(input.document, input.name);

test("table helper makes the exact addressed size", () => {
  const document: NormalizedDocument = workbook([["Inputs", 1000]]).document;
  expect(addressedText(document, "w.xlsx")).toHaveLength(1000);
  expect(document.tables[0]!.rows[0]![0]!.ref).toBe("Inputs!A1");
});
test("the three reading limits", () => {
  expect([MAX_READING_CHARS, MAX_ASKED_READING_CHARS, MIN_SHEET_ROOM]).toEqual([500000, 1500000, 200000]);
});
test("small workbook keeps exactly its whole addressed text", () => {
  const input = workbook([["Inputs", 1000], ["Flows", 2000]]);
  expect(readingTexts([input])).toEqual([{ text: textOf(input), sheetsLeftOut: [] }]);
});
test("choose smallest sheets but retain source order in text", () => {
  const [result] = readingTexts([workbook([["Big", 400000], ["Huge", 900000], ["Small", 1000], ["Mid", 90000]])]);
  expect(result!.sheetsLeftOut).toEqual(["Huge"]);
  expect(result!.text).toBe(textOf(workbook([["Big", 400000], ["Small", 1000], ["Mid", 90000]])));
});
test.each([
  { sheets: [["A", 500000]], left: [] },
  { sheets: [["A", 500001]], left: ["A"] },
  { sheets: [["A", 200000], ["B", 300000], ["C", 300001]], left: ["C"] },
  { sheets: [["A", 300000], ["B", 300000], ["C", 300000]], left: ["B", "C"] },
] as { sheets: [string, number][]; left: string[] }[])("ordinary whole sheet boundary $sheets", ({ sheets, left }) => {
  expect(readingTexts([workbook(sheets)])[0]!.sheetsLeftOut).toEqual(left);
});
test("a Word file's tables go whole: only a workbook's or a CSV's are sheets", () => {
  const word: ReadingInput = { name: "w.docx", asked: false, document: { ...pdf(10).document, kind: "docx", tables: [table("Table 1", 600000)] } };
  expect(readingTexts([word])).toEqual([{ text: textOf(word), sheetsLeftOut: [] }]);
});
test("PDF stays whole and leaves the minimum sheet room", () => {
  const p = pdf(450000), result = readingTexts([p, workbook([["A", 100000], ["B", 300000]])]);
  expect(result[0]).toEqual({ text: textOf(p), sheetsLeftOut: [] });
  expect(result[1]!.sheetsLeftOut).toEqual(["B"]);
});
test.each([0, 1])("fixed text ordinary exact boundary plus %s", extra => {
  const p = pdf(100000), size = textOf(p).length;
  expect(readingTexts([p, workbook([["A", 500000 - size + extra]])])[1]!.sheetsLeftOut).toEqual(extra ? ["A"] : []);
});
test.each([0, 1])("large PDF ordinary floor plus %s", extra => {
  const p = pdf(900000), result = readingTexts([p, workbook([["A", 200000 + extra]])]);
  expect(result[0]!.text).toBe(textOf(p));
  expect(result[1]!.sheetsLeftOut).toEqual(extra ? ["A"] : []);
});
test("workbooks share a deal budget", () => {
  const result = readingTexts([workbook([["A1", 200000], ["A2", 100]], false, "a.xlsx"), workbook([["B1", 300000], ["B2", 100]], false, "b.xlsx")]);
  expect(result.map(r => r.sheetsLeftOut)).toEqual([[], ["B1"]]);
});
test("CSV is one whole table", () => {
  expect(readingTexts([workbook([["CSV", 500001]], false, "w.xlsx", "csv")])).toEqual([{ text: "=== FILE w.xlsx ===", sheetsLeftOut: ["CSV"] }]);
});
test("asked sheets get priority over earlier ordinary files", () => {
  const result = readingTexts([workbook([["Plan", 90000], ["Sum", 100000]], false, "o.xlsx"), workbook([["Ledger", 1400000], ["Inputs", 1000]], true)]);
  expect(result.map(r => r.sheetsLeftOut)).toEqual([["Sum"], []]);
});
test.each([0, 100])("asked exact budget with another %s characters", extra => {
  const sheets: [string, number][] = [["A", 1000000], ["B", 500000]];
  if (extra) sheets.push(["C", extra]);
  expect(readingTexts([workbook(sheets, true)])[0]!.sheetsLeftOut).toEqual(extra ? ["A"] : []);
});
test.each([0, 1])("large PDF asked floor plus %s", extra => {
  expect(readingTexts([pdf(1400000), workbook([["A", 200000 + extra]], true)])[1]!.sheetsLeftOut).toEqual(extra ? ["A"] : []);
});
test.each([0, 1])("fixed text asked exact boundary plus %s", extra => {
  const p = pdf(1000000), small = textOf(p).length;
  expect(readingTexts([p, workbook([["A", 1500000 - small + extra]], true)])[1]!.sheetsLeftOut).toEqual(extra ? ["A"] : []);
});
test.each([
  [1300000, 200000, []], [1300000, 200001, ["P"]],
  [1000, 500000, []], [1000, 500001, ["P"]],
] as [number, number, string[]][])("asked %s leaves room for ordinary %s", (asked, ordinary, left) => {
  expect(readingTexts([workbook([["L", asked]], true), workbook([["P", ordinary]], false, "o.xlsx")])[1]!.sheetsLeftOut).toEqual(left);
});
test("same files twice give equal results", () => {
  const inputs = [pdf(100000), workbook([["A", 1000], ["B", 700000]]), workbook([["C", 1200000]], true)];
  expect(readingTexts(inputs)).toEqual(readingTexts(inputs));
});
