import { describe, expect, test, vi } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { parseDocument } from "../src/parse.ts";
import { keepOcrLine, mergeOcr, parseSavedOcr, serializeOcr, isOcrLocation, MAX_OCR_PAGES } from "../src/ocr-text.ts";
import { ocrPdf } from "../src/ocr.ts";

vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));
async function fixture(pages: { text?: string; image?: number; rotate?: boolean; paths?: number }[]) {
  const pdf = await PDFDocument.create();
  const canvas = createCanvas(100, 100);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  for (const spec of pages) {
    const page = pdf.addPage([600, 800]);
    if (spec.text) page.drawText(spec.text, { x: 10, y: 700, size: 2 });
    if (spec.image) page.drawImage(image, { x: 0, y: 0, width: 600 * spec.image, height: 800 });
    if (spec.rotate) page.setRotation(degrees(90));
    for (let i = 0; i < (spec.paths ?? 0); i++) page.drawLine({ start: { x: 0, y: i * 5 }, end: { x: 400, y: i * 5 } });
  }
  return pdf.save();
}
const text = { text: "Land cost $400,000 and other text" };
describe("picture pages", () => {
  test.each([
    ["text only", [text], undefined],
    ["image page 2", [text, { image: 1 }, text], [2]],
    ["100 character caption", [text, { image: 1, text: "a".repeat(100) }], [2]],
    ["300 character caption", [text, { image: 1, text: "a".repeat(300) }], undefined],
    ["small logo", [text, { image: 0.05, text: "a".repeat(30) }], undefined],
    ["blank between text", [text, {}, text], undefined],
    ["rotated image", [text, { image: 1, rotate: true }], [2]],
    ["drawn paths", [text, { paths: 60 }], [2]],
    ["all scanned", [{ image: 1 }, { image: 1 }], [1, 2]],
    ["blank whole PDF", [{}], [1]],
  ])("%s", async (_name, pages, expected) => {
    const doc = await parseDocument(await fixture(pages), "fixture.pdf");
    expect(doc.ocrPages).toEqual(expected);
    expect(doc.needsOcr).toBe(Boolean(expected));
  });
  test.each([[60, 0, true], [59, 64, false], [40, 65, true], [39, 100, false], [59, 65, true]])("confidence %s on page %s", (c, p, expected) => {
    expect(keepOcrLine(c, p)).toBe(expected);
  });
  test("merges in page order without renumbering filtered or duplicate lines", async () => {
    const doc = await parseDocument(await fixture([text, text]), "f.pdf");
    doc.lines = [{ text: "Land cost $12,000", location: "page 1, line 3" }, { text: "Last page", location: "page 2, line 1" }];
    const saved = { version: 1 as const, pages: [{ page: 1, lines: [{ text: "land COST", confidence: 90 }, { text: "noise", confidence: 10 }, { text: "$12", confidence: 90 }, { text: "New amount 7000", confidence: 90 }] }], failed: [], notRead: [] };
    const merged = mergeOcr(doc, saved);
    expect(merged.lines).toEqual([doc.lines[0], { text: "$12", location: "page 1, line 6 (OCR, confidence 90%)" }, { text: "New amount 7000", location: "page 1, line 7 (OCR, confidence 90%)" }, doc.lines[1]]);
    expect(merged.fullText).toBe("Land cost $12,000\n$12\nNew amount 7000\nLast page");
    expect(parseSavedOcr(serializeOcr(saved))).toEqual(saved);
    expect(MAX_OCR_PAGES).toBe(50);
    expect(isOcrLocation(merged.lines[1]!.location)).toBe(true);
    expect(isOcrLocation("page 1, line 3")).toBe(false);
  });
  test("weighted page confidence retains a short 40 confidence line beside long real text", async () => {
    const doc = await parseDocument(await fixture([{}]), "f.pdf");
    expect(mergeOcr(doc, { version: 1, pages: [{ page: 1, lines: [{ text: "a long clear readable sentence", confidence: 90 }, { text: "40", confidence: 40 }] }], failed: [], notRead: [] }).lines).toHaveLength(2);
  });
  test("invalid saved text", () => {
    for (const value of [null, new TextEncoder().encode("oops"), new TextEncoder().encode('{"version":2}')]) expect(parseSavedOcr(value)).toBeNull();
  });
  test("reads selected pages, catches one recognition failure and keeps empty pages", async () => {
    const { createWorker } = await import("tesseract.js");
    const recognize = vi.fn().mockRejectedValueOnce(new Error("bad page")).mockResolvedValueOnce({ data: { blocks: [] } });
    const terminate = vi.fn();
    vi.mocked(createWorker).mockResolvedValue({ recognize, terminate } as never);
    expect(await ocrPdf(await fixture([text, { image: 1 }, { image: 1 }]), [2, 3])).toEqual({ pages: [{ page: 3, lines: [] }], failed: [2] });
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenCalledWith("eng+fra", 1, expect.objectContaining({ errorHandler: expect.any(Function) }));
    expect(terminate).toHaveBeenCalledOnce();
  });
});
