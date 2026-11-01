import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { PDFDocument, PDFDict, PDFName, StandardFonts, type PDFFont } from "pdf-lib";
import { parseDocument, ocrPdf, mergeOcr, verifyReading, extractCandidates } from "../src/index.ts";

type Map = (byte: number) => number;
const hex = (c: number, n = 2) => c.toString(16).padStart(n, "0").toUpperCase();
function cmap(map: Map) {
  const bytes = Array.from({ length: 224 }, (_, i) => i + 32);
  const blocks = Array.from({ length: Math.ceil(bytes.length / 100) }, (_, b) => bytes.slice(b * 100, b * 100 + 100));
  return "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /X def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n" +
    blocks.map(part => part.length + " beginbfchar\n" + part.map(c => "<" + hex(c) + "> <" + hex(map(c), 4) + ">").join("\n") + "\nendbfchar\n").join("") +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
}
async function pdf(pages: { text: string; map?: Map }[][]) {
  const doc = await PDFDocument.create();
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = new globalThis.Map<Map, PDFFont>();
  for (const rows of pages) {
    const p = doc.addPage([612, 792]);
    for (const [i, row] of rows.entries()) {
      let font = plain;
      if (row.map) { font = fonts.get(row.map) ?? await doc.embedFont(StandardFonts.HelveticaBold); fonts.set(row.map, font); }
      p.drawText(row.text, { x: 50, y: 740 - i * 22, size: 13, font });
    }
  }
  for (const [map, font] of fonts) {
    await font.embed();
    doc.context.lookup(font.ref, PDFDict).set(PDFName.of("ToUnicode"), doc.context.register(doc.context.stream(cmap(map))));
  }
  return new Uint8Array(await doc.save());
}
const shift: Map = b => 0xf000 + b, junk: Map = () => 1;
const budget = ["Land cost 1,025,000", ...Array.from({ length: 22 }, (_, i) => `Budget row ${i + 1} amount 2,000`)];
const rows = (map?: Map) => budget.map(text => ({ text, map }));

test("decodes a shifted page before counting its text", async () => {
  const doc = await parseDocument(await pdf([rows(shift)]), "invented.pdf");
  expect(doc.lines.map(l => l.text)).toEqual(budget);
  expect(doc.needsOcr).toBe(false);
});
test("decides separately for each page and preserves line addresses", async () => {
  const doc = await parseDocument(await pdf([rows(), rows(shift)]), "invented.pdf");
  expect(doc.lines).toEqual([1, 2].flatMap(p => budget.map((text, i) => ({ text, location: `page ${p}, line ${i + 1}` }))));
  expect(doc.needsOcr).toBe(false);
});
test("a shifted page does not decide for the page after it", async () => {
  const doc = await parseDocument(await pdf([rows(shift), [...rows(), { text: "lll", map: shift }]]), "invented.pdf");
  expect(doc.lines.map(l => l.text)).toEqual([...budget, ...budget, "\uf06c\uf06c\uf06c"]);
});
test.each([
  ["exactly half", "abcde", "abcde"],
  ["under half", "abcd", "\uf061\uf062\uf063\uf064"],
])("shift threshold: %s", async (_name, text, expected) => {
  const doc = await parseDocument(await pdf([[{ text, map: shift }, { text: "fghij" }]]), "invented.pdf");
  expect(doc.lines.map(l => l.text)).toEqual([expected, "fghij"]);
});
test("leaves occasional symbol characters alone", async () => {
  const doc = await parseDocument(await pdf([[...rows(), { text: "lll", map: shift }]]), "invented.pdf");
  expect(doc.lines.map(l => l.text)).toEqual([...budget, "\uf06c\uf06c\uf06c"]);
  expect(doc.needsOcr).toBe(false);
});
test("preserves low private characters on a shifted page", async () => {
  const map: Map = b => b === 0x7a ? 0xf001 : shift(b);
  const doc = await parseDocument(await pdf([[{ text: "Land cost zone 1,025,000", map }]]), "invented.pdf");
  expect(doc.lines[0]!.text).toBe("Land cost \uf001one 1,025,000");
});
test("decodes shifted bytes as Windows-1252", async () => {
  const text = "Coûts du terrain – 2,000";
  const doc = await parseDocument(await pdf([[{ text, map: shift }]]), "invented.pdf");
  expect(doc.lines[0]!.text).toBe(text);
  expect(doc.needsOcr).toBe(false);
});
test.each([
  ["control", junk], ["replacement", () => 0xfffd], ["C1 control", () => 0x90],
] as const)("routes undecodable %s text to OCR and retains its lines", async (_name, map) => {
  const doc = await parseDocument(await pdf([rows(map)]), "invented.pdf");
  expect(doc.ocrPages).toEqual([1]);
  expect(doc.needsOcr).toBe(true);
  expect(doc.lines).toHaveLength(23);
  expect(doc.lines[0]!.text).toContain(String.fromCharCode(map(0x4c)));
});
test("routes only the undecodable page", async () => {
  const doc = await parseDocument(await pdf([rows(), rows(junk)]), "invented.pdf");
  expect(doc.ocrPages).toEqual([2]);
  expect(doc.lines).toHaveLength(46);
});
test.each([
  [10, 9, "", junk, true], [9, 9, "", junk, false],
  [5, 2, "", junk, true], [4, 2, "", junk, false],
  [5, 4, "abcdef", () => 0xfffd, false],
] as const)("junk threshold: %i bad, %i ten-letter lines, extra %s", async (bad, tens, extra, map, flagged) => {
  const page = [{ text: "a".repeat(bad), map }, ...(extra ? [{ text: extra }] : []),
    ...Array.from({ length: tens }, () => ({ text: "abcdefghij" }))];
  const doc = await parseDocument(await pdf([page]), "invented.pdf");
  expect(doc.ocrPages).toEqual(flagged ? [1] : undefined);
  expect(doc.needsOcr).toBe(flagged);
  expect(doc.lines).toHaveLength(page.length);
});
test("recognizes an undecodable page and merges beside the original 23 lines", async () => {
  const bytes = await pdf([rows(junk)]);
  const doc = await parseDocument(bytes, "invented.pdf");
  const result = await ocrPdf(bytes, [1]);
  expect(result.failed).toEqual([]);
  expect(result.pages[0]!.lines).toHaveLength(23);
  const merged = mergeOcr(doc, { version: 1, ...result, notRead: [] });
  expect(merged.lines).toHaveLength(46);
  expect(merged.lines.slice(0, 23)).toEqual(doc.lines);
  expect(merged.lines.slice(23)).toContainEqual(expect.objectContaining({ text: budget[0] }));
}, 60_000);
test.each(["jbig2", "jpx"])("reads invented %s scan through recognition and verification", async format => {
  const bytes = new Uint8Array(await readFile(new URL(`./fixtures/scan-${format}.pdf`, import.meta.url)));
  const doc = await parseDocument(bytes, "invented.pdf");
  expect(doc.ocrPages).toEqual([1]);
  const result = await ocrPdf(bytes, [1]);
  expect(result.failed).toEqual([]);
  expect(result.pages.map(p => p.page)).toEqual([1]);
  expect(result.pages[0]!.lines.map(l => l.text)).toEqual([
    "Harbour Row budget summary", budget[0], "Hard costs 4,394,000", "Soft costs 1,120,500", "Senior loan 3,850,000", "Total units 24",
  ]);
  const merged = mergeOcr(doc, { version: 1, ...result, notRead: [] });
  const land = merged.lines.find(l => l.text === budget[0])!;
  expect(verifyReading({ field: "land_cost", item: null, value: 1025000, unit_seen: "$", file: "invented.pdf",
    location: land.location, quote: land.text, note: null, confidence: "high" },
    [{ id: "invented", name: "invented.pdf", document: merged }])).toMatchObject({ outcome: "verified", candidate: { value: 1025000 } });
  expect(extractCandidates(merged).candidates).toContainEqual(expect.objectContaining({ fieldKey: "unit_count", value: 24, location: expect.stringContaining("OCR") }));
}, 60_000);
