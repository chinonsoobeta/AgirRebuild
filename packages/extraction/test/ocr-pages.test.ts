import { describe, expect, test, vi } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { tiffBytes } from "@agir/testkit";
import { parseDocument } from "../src/parse.ts";
import { keepOcrLine, mergeOcr, parseSavedOcr, serializeOcr, isOcrLocation, MAX_OCR_PAGES } from "../src/ocr-text.ts";
import { ocrImage, ocrPdf } from "../src/ocr.ts";

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
    vi.mocked(createWorker).mockResolvedValue({ recognize, terminate, setParameters: vi.fn() } as never);
    expect(await ocrPdf(await fixture([text, { image: 1 }, { image: 1 }]), [2, 3])).toEqual({ pages: [{ page: 3, lines: [] }], failed: [2] });
    expect(recognize).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenCalledWith("eng+fra", 1, expect.objectContaining({ errorHandler: expect.any(Function) }));
    expect(terminate).toHaveBeenCalledOnce();
  });
});

describe("a figure goes back beside the line at its height", () => {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const line = (text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90, baseline?: Box) =>
    ({ text, confidence, bbox: { x0, y0, x1, y1 }, baseline: baseline ?? { x0, y0: y1, x1, y1 } });
  const png = () => {
    const canvas = createCanvas(1800, 2400), ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1800, 2400);
    return canvas.toBuffer("image/png");
  };
  async function read(lines: ReturnType<typeof line>[]) {
    const { createWorker } = await import("tesseract.js");
    const worker = { recognize: vi.fn().mockResolvedValue({ data: { blocks: [{ paragraphs: [{ lines }] }] } }), setParameters: vi.fn(), terminate: vi.fn() };
    vi.mocked(createWorker).mockResolvedValue(worker as never);
    return (await ocrImage(png())).pages[0]!.lines;
  }
  const texts = async (lines: ReturnType<typeof line>[]) => (await read(lines)).map(l => l.text);
  test("names listed before their amounts come back together, in the names' order", async () => {
    expect(await texts([
      line("Land", 100, 100, 200, 140), line("Hard costs", 100, 200, 300, 240),
      line("1,250,000", 900, 102, 1100, 142), line("8,430,000", 900, 202, 1100, 242),
    ])).toEqual(["Land 1,250,000", "Hard costs 8,430,000"]);
  });
  test("several figures on one row join from left to right", async () => {
    expect(await texts([
      line("441", 1200, 100, 1280, 140), line("Studio", 100, 100, 240, 140),
      line("$1,470", 800, 100, 950, 140), line("6", 500, 100, 520, 140),
    ])).toEqual(["Studio 6 $1,470 441"]);
  });
  test("a figure joins the nearest line on its left", async () => {
    expect(await texts([
      line("Far away", 100, 100, 300, 140), line("Land", 500, 100, 600, 140), line("1,250,000", 900, 100, 1100, 140),
    ])).toEqual(["Far away", "Land 1,250,000"]);
  });
  test("a figure at another height stays on its own line", async () => {
    const lines = [line("Land", 100, 100, 200, 140), line("1,250,000", 900, 121, 1100, 161)];
    expect(await texts(lines)).toEqual(["Land", "1,250,000"]);
  });
  test("half a line apart is still the same height", async () => {
    expect(await texts([line("Land", 100, 100, 200, 140), line("1,250,000", 900, 120, 1100, 160)])).toEqual(["Land 1,250,000"]);
  });
  test("a figure to the left of a line stays on its own line", async () => {
    expect(await texts([line("1,250,000", 100, 100, 300, 140), line("Land", 500, 100, 600, 140)])).toEqual(["1,250,000", "Land"]);
  });
  test("a line holding a long word is not a figure", async () => {
    expect(await texts([line("Land", 100, 100, 200, 140), line("Phase 2", 900, 100, 1100, 140)])).toEqual(["Land", "Phase 2"]);
  });
  test.each([[8, true], [9, false]])("a line of %s words taking a figure: %s", async (words, joins) => {
    const text = Array.from({ length: words }, () => "word").join(" ");
    expect(await texts([line(text, 100, 100, 800, 140), line("1,250,000", 900, 100, 1100, 140)])).toEqual(joins ? [`${text} 1,250,000`] : [text, "1,250,000"]);
  });
  test.each([[59.9, 90], [90, 59.9]])("confidence %s and %s stays apart, so joining never changes what is kept", async (left, figure) => {
    expect(await texts([line("Land", 100, 100, 200, 140, left), line("1,250,000", 900, 100, 1100, 140, figure)])).toEqual(["Land", "1,250,000"]);
  });
  test("confidence of a joined line is weighted by length", async () => {
    const [joined] = await read([line("Land", 100, 100, 200, 140, 60), line("1,250,000", 900, 100, 1100, 140, 90)]);
    expect(joined!.confidence).toBeCloseTo((4 * 60 + 9 * 90) / 13, 6);
    expect(Object.keys(joined!).sort()).toEqual(["confidence", "text"]);
  });
  test("heights follow the page's own tilt", async () => {
    // One pixel down for every fifty across: the amount sits 24 px below its name's height.
    const tilted = (text: string, x0: number, y0: number, x1: number) => line(text, x0, y0, x1, y0 + (x1 - x0) / 50 + 40, 90, { x0, y0: y0 + 40, x1, y1: y0 + 40 + (x1 - x0) / 50 });
    expect(await texts([
      tilted("A long sentence that gives the page its tilt", 100, 40, 1600),
      tilted("Land", 100, 300, 200), tilted("1,250,000", 1300, 324, 1500),
    ])).toEqual(["A long sentence that gives the page its tilt", "Land 1,250,000"]);
  });
  test("a level page keeps a figure 24 px lower apart", async () => {
    expect(await texts([
      line("A long sentence that gives the page its tilt", 100, 40, 1600, 80),
      line("Land", 100, 300, 200, 340), line("1,250,000", 1300, 324, 1500, 364),
    ])).toEqual(["A long sentence that gives the page its tilt", "Land", "1,250,000"]);
  });
  test("a page read sideways has tall boxes, and a column of figures does not gather on one", async () => {
    const figures = [300, 500, 700, 900].map((y, i) => line(`${i + 1},000`, 900, y, 1000, y + 40));
    expect(await texts([line("Sideways words read as one tall line", 100, 100, 160, 1400), ...figures])).toEqual(["Sideways words read as one tall line", "1,000", "2,000", "3,000", "4,000"]);
  });
});

describe("card 195 page settings and retries", () => {
  const png = (width = 1800, height = 2400) => {
    const canvas = createCanvas(width, height), ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "black"; ctx.font = "40px sans-serif";
    ctx.fillText("Invented budget 1,234,567", 50, 100);
    return canvas.toBuffer("image/png");
  };
  const lines = (confidence: number, length = 100) => [{ text: "a".repeat(length), confidence }];
  type Lines = ReturnType<typeof lines>;
  async function fake(reads: (Lines | Error)[]) {
    const { createWorker } = await import("tesseract.js");
    const recognize = vi.fn();
    for (const read of reads) {
      if (read instanceof Error) recognize.mockRejectedValueOnce(read);
      else recognize.mockResolvedValueOnce({ data: { blocks: [{ paragraphs: [{ lines: read }] }] } });
    }
    const worker = { recognize, setParameters: vi.fn(), terminate: vi.fn() };
    vi.mocked(createWorker).mockResolvedValue(worker as never);
    return worker;
  }
  async function sizes(worker: Awaited<ReturnType<typeof fake>>) {
    return Promise.all(worker.recognize.mock.calls.map(async ([bytes]) => {
      const image = await loadImage(bytes);
      return [image.width, image.height];
    }));
  }
  test.each(["pdf", "image"])("sets layout and DPI before reading %s", async kind => {
    const worker = await fake([lines(90)]);
    if (kind === "pdf") await ocrPdf(await fixture([{}]));
    else await ocrImage(png());
    expect(worker.setParameters).toHaveBeenCalledExactlyOnceWith({ tessedit_pageseg_mode: "3", user_defined_dpi: "300" });
    expect(worker.setParameters.mock.invocationCallOrder[0]).toBeLessThan(worker.recognize.mock.invocationCallOrder[0]!);
  });
  test.each(["pdf", "image"])("terminates when settings reject for %s", async kind => {
    const worker = await fake([]);
    worker.setParameters.mockRejectedValueOnce(new Error("settings failed"));
    await expect(kind === "pdf" ? ocrPdf(await fixture([{}])) : ocrImage(png())).rejects.toThrow("settings failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.recognize).not.toHaveBeenCalled();
  });
  test.each([
    [90, 100, 1], [60, 100, 1], [59.9, 100, 4], [50, 39, 1], [50, 40, 4],
  ])("first confidence %s with %s characters costs %s reads", async (confidence, length, count) => {
    const first = lines(confidence, length);
    const worker = await fake([first, lines(50), lines(50), lines(50)]);
    expect(await ocrImage(png())).toEqual({ pages: [{ page: 1, lines: first }], failed: [] });
    expect(worker.recognize).toHaveBeenCalledTimes(count);
  });
  test("uses text-length weighted confidence", async () => {
    const first = [...lines(90, 90), ...lines(0, 10)];
    const worker = await fake([first]);
    expect((await ocrImage(png())).pages[0]?.lines).toEqual(first);
    expect(worker.recognize).toHaveBeenCalledOnce();
  });
  test.each([65, 64.9])("does not keep a turn at %s; probes have long side 1200", async confidence => {
    const first = lines(50), worker = await fake([first, lines(confidence), lines(50), lines(50)]);
    expect(await ocrImage(png())).toEqual({ pages: [{ page: 1, lines: first }], failed: [] });
    expect(await sizes(worker)).toEqual([[1800, 2400], [1200, 900], [900, 1200], [1200, 900]]);
  });
  test.each([0, 1, 2])("keeps turn index %s only after a full-size read", async index => {
    const turns = [lines(50), lines(50), lines(50)]; turns[index] = lines(65.1, 40);
    const full = lines(66, 40), worker = await fake([lines(50), ...turns, full]);
    expect(await ocrImage(png())).toEqual({ pages: [{ page: 1, lines: full }], failed: [] });
    expect(worker.recognize).toHaveBeenCalledTimes(5);
    expect((await sizes(worker))[4]).toEqual(index === 1 ? [1800, 2400] : [2400, 1800]);
  });
  test("does not keep a high-confidence turn with 39 characters", async () => {
    const first = lines(50), worker = await fake([first, lines(90, 39), lines(50), lines(50)]);
    expect((await ocrImage(png())).pages[0]?.lines).toEqual(first);
    expect(worker.recognize).toHaveBeenCalledTimes(4);
  });
  test("reads the highest passing turn at full size", async () => {
    const worker = await fake([lines(50), lines(70), lines(90), lines(80), lines(91)]);
    expect((await ocrImage(png())).pages[0]?.lines).toEqual(lines(91));
    expect((await sizes(worker))[4]).toEqual([1800, 2400]);
  });
  test.each([[65, 100], [64, 100], [90, 39]])("rejects full-size confidence %s with %s characters", async (confidence, length) => {
    const first = lines(50), worker = await fake([first, lines(90), lines(50), lines(50), lines(confidence, length)]);
    expect(await ocrImage(png())).toEqual({ pages: [{ page: 1, lines: first }], failed: [] });
    expect(worker.recognize).toHaveBeenCalledTimes(5);
  });
  test.each(["image", "pdf"])("preserves the first read after retry failures for %s", async kind => {
    for (const fullSize of [false, true]) {
      const first = lines(50);
      const worker = await fake(fullSize
        ? [first, lines(90), lines(50), lines(50), new Error("full read")]
        : [first, new Error("probe")]);
      const result = kind === "pdf" ? await ocrPdf(await fixture([{}])) : await ocrImage(png());
      expect(result).toEqual({ pages: [{ page: 1, lines: first }], failed: [] });
      expect(worker.recognize).toHaveBeenCalledTimes(fullSize ? 5 : 2);
    }
  });
  test("keeps TIFF text when canvas cannot open it", async () => {
    const first = lines(50), worker = await fake([first]);
    const bytes = tiffBytes(100, 100, new Uint8Array(10000).fill(255));
    expect(await ocrImage(bytes)).toEqual({ pages: [{ page: 1, lines: first }], failed: [] });
    expect(worker.recognize).toHaveBeenCalledExactlyOnceWith(Buffer.from(bytes), {}, { blocks: true });
  });
  test.each([[1100, 2200], [1650, 3300], [1651, 1651], [4000, 3300]])("scales long side %s to %s", async (input, output) => {
    const worker = await fake([lines(90)]);
    await ocrImage(png(Math.round(input / 2), input));
    expect((await sizes(worker))[0]?.[1]).toBe(output);
  });
  test("does not enlarge retry probes", async () => {
    const worker = await fake([lines(50), lines(50), lines(50), lines(50)]);
    await ocrImage(png(200, 300));
    expect(await sizes(worker)).toEqual([[400, 600], [600, 400], [400, 600], [600, 400]]);
  });
  test("retries low-confidence PDF pages too", async () => {
    const full = lines(95), worker = await fake([lines(50), lines(90), lines(50), lines(50), full]);
    expect(await ocrPdf(await fixture([{}]))).toEqual({ pages: [{ page: 1, lines: full }], failed: [] });
    expect(await sizes(worker)).toEqual([[2475, 3300], [1200, 900], [900, 1200], [1200, 900], [3300, 2475]]);
  });
});
