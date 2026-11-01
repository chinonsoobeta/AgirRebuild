import { copyFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorker, type PSM } from "tesseract.js";
import { MAX_OCR_PAGES, type OcrPage } from "./ocr-text.ts";

const require = createRequire(import.meta.url);
let languages: Promise<string> | undefined;
function languagePath(): Promise<string> {
  return languages ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "agir-ocr-"));
    await Promise.all(["eng", "fra"].map((lang) => copyFile(
      join(dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`)), "4.0.0", `${lang}.traineddata.gz`),
      join(dir, `${lang}.traineddata.gz`),
    )));
    return dir;
  })();
}

async function ocrWorker() {
  const worker = await createWorker("eng+fra", 1, { langPath: await languagePath(), gzip: true, cacheMethod: "none", errorHandler: () => {} });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: "3" as PSM, // Automatic layout finds a page's columns, turned pages and the table rows a single block drops.
      user_defined_dpi: "300", // A known resolution lets Tesseract remove thick table rules.
    });
    return worker;
  } catch (error) { await worker.terminate(); throw error; }
}

async function recognizeLines(worker: Awaited<ReturnType<typeof ocrWorker>>, bytes: Uint8Array): Promise<OcrPage["lines"]> {
  const { data } = await worker.recognize(Buffer.from(bytes), {}, { blocks: true });
  const lines: SeenLine[] = [];
  for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) {
    const text = line.text.trim();
    if (text) lines.push({ text, confidence: line.confidence, box: line.bbox, baseline: line.baseline });
  }
  return joinTableRows(lines);
}

type Box = { x0: number; y0: number; x1: number; y1: number };
type SeenLine = OcrPage["lines"][number] & { box?: Box; baseline?: Box };

/** A page Tesseract read sideways has lines running down the picture, with the next line to their left. Here across and down mean what they do on any page. */
function upright(lines: SeenLine[]): SeenLine[] {
  const characters = (tall: boolean) => lines.reduce((sum, { box, text }) => box && box.y1 - box.y0 > box.x1 - box.x0 === tall ? sum + text.length : sum, 0);
  if (characters(true) <= characters(false)) return lines;
  return lines.map(l => ({
    ...l,
    ...(l.box ? { box: { x0: l.box.y0, y0: -l.box.x1, x1: l.box.y1, y1: -l.box.x0 } } : {}),
    ...(l.baseline ? { baseline: { x0: l.baseline.y0, y0: -l.baseline.x0, x1: l.baseline.y1, y1: -l.baseline.x1 } } : {}),
  }));
}

/** Automatic layout can list a table's names and then its amounts. A line of figures goes back beside the short line at its height, as a PDF's text layer has it. */
function joinTableRows(seen: SeenLine[]): OcrPage["lines"] {
  const lines = upright(seen);
  const figures = lines.filter(l => l.box && /\d/.test(l.text) && !/\p{L}{4,}/u.test(l.text)).sort((a, b) => a.box!.x0 - b.box!.x0);
  // A page photographed or scanned slightly crooked: heights are compared along the page's own tilt.
  const slopes = lines.flatMap(l => l.baseline && l.baseline.x1 - l.baseline.x0 >= 200 ? [(l.baseline.y1 - l.baseline.y0) / (l.baseline.x1 - l.baseline.x0)] : []).sort((a, b) => a - b);
  const tilt = slopes[Math.floor(slopes.length / 2)] ?? 0;
  const joined = new Set<SeenLine>();
  for (const figure of figures) {
    const at = figure.box!;
    let left: SeenLine | undefined;
    for (const line of lines) {
      const box = line.box;
      // A line running the other way across the page is tall, and stands beside everything.
      if (!box || line === figure || joined.has(line) || box.x1 > at.x0 || box.x1 - box.x0 <= box.y1 - box.y0) continue;
      const drift = (box.y0 + box.y1) / 2 + tilt * ((at.x0 + at.x1) / 2 - (box.x0 + box.x1) / 2) - (at.y0 + at.y1) / 2;
      if (Math.abs(drift) * 2 > Math.min(box.y1 - box.y0, at.y1 - at.y0)) continue;
      if (!left || box.x1 > left.box!.x1) left = line;
    }
    // Lines this sure are kept whatever the page's confidence, so joining never changes what is kept.
    if (!left || (left.text.match(/\p{L}{2,}/gu) ?? []).length > 8 || left.confidence < 60 || figure.confidence < 60) continue;
    left.confidence = (left.confidence * left.text.length + figure.confidence * figure.text.length) / (left.text.length + figure.text.length);
    left.text += " " + figure.text;
    left.box = { ...left.box!, x1: at.x1 };
    joined.add(figure);
  }
  return lines.filter(l => !joined.has(l)).map(({ text, confidence }) => ({ text, confidence }));
}

function pageConfidence(lines: OcrPage["lines"]) {
  const characters = lines.reduce((sum, line) => sum + line.text.length, 0);
  const confidence = characters ? lines.reduce((sum, line) => sum + line.confidence * line.text.length, 0) / characters : 0;
  return { characters, confidence };
}

async function recognizePage(worker: Awaited<ReturnType<typeof ocrWorker>>, bytes: Uint8Array): Promise<OcrPage["lines"]> {
  const first = await recognizeLines(worker, bytes);
  const initial = pageConfidence(first);
  if (initial.confidence >= 60 || initial.characters < 40) return first;
  try {
    const { loadImage, createCanvas } = await import("@napi-rs/canvas");
    const image = await loadImage(Buffer.from(bytes));
    const longest = Math.max(image.width, image.height);
    const turned = (degrees: number, limit: number) => {
      const scale = Math.min(1, limit / longest), swap = degrees !== 180;
      const canvas = createCanvas(
        Math.max(1, Math.round((swap ? image.height : image.width) * scale)),
        Math.max(1, Math.round((swap ? image.width : image.height) * scale)),
      );
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate(degrees * Math.PI / 180);
      ctx.drawImage(image, -image.width * scale / 2, -image.height * scale / 2, image.width * scale, image.height * scale);
      return canvas.toBuffer("image/png");
    };
    let bestTurn: number | undefined, bestConfidence = initial.confidence + 15;
    for (const degrees of [270, 180, 90]) {
      const score = pageConfidence(await recognizeLines(worker, turned(degrees, 1200)));
      if (score.characters >= 40 && score.confidence > bestConfidence) {
        bestTurn = degrees; bestConfidence = score.confidence;
      }
    }
    if (bestTurn !== undefined) {
      const full = await recognizeLines(worker, turned(bestTurn, longest));
      const score = pageConfidence(full);
      if (score.characters >= 40 && score.confidence > initial.confidence + 15) return full;
    }
  } catch { /* A retry must not discard the first read. */ }
  return first;
}

/** Local OCR only. Every resulting value still needs a person's check against the scanned page. */
export async function ocrPdf(bytes: Uint8Array, pages?: number[]): Promise<{ pages: OcrPage[]; failed: number[] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    if (!pages && doc.numPages > MAX_OCR_PAGES) throw new Error("This scanned PDF has more than 50 pages; Agir reads scans of up to 50 pages. Split it, or enter its values by hand.");
    let canvasModule: typeof import("@napi-rs/canvas");
    try { canvasModule = await import("@napi-rs/canvas"); }
    catch { throw new Error("OCR is not available on this machine"); }
    const worker = await ocrWorker();
    try {
      const result: OcrPage[] = [], failed: number[] = [];
      for (const n of pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
        let page: Awaited<ReturnType<typeof doc.getPage>> | undefined;
        let canvas: import("@napi-rs/canvas").Canvas | null = null;
        try {
          page = await doc.getPage(n);
          const size = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(300 / 72, 3300 / Math.max(size.width, size.height)) });
          canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
          const lines = await recognizePage(worker, canvas.toBuffer("image/png"));
          result.push({ page: n, lines });
        } catch { failed.push(n); } finally { canvas = null; page?.cleanup(); }
      }
      return { pages: result, failed };
    } finally { await worker.terminate(); }
  } finally { await task.destroy(); }
}

/** Pictures always represent page 1; TIFF goes straight to the OCR decoder. */
export async function ocrImage(bytes: Uint8Array, _pages?: number[]): Promise<{ pages: OcrPage[]; failed: number[] }> {
  const worker = await ocrWorker();
  try {
    let input = bytes;
    if (bytes[0] === 0x89 || bytes[0] === 0xff) {
      try {
        const { loadImage, createCanvas } = await import("@napi-rs/canvas");
        const image = await loadImage(Buffer.from(bytes));
        const longest = Math.max(image.width, image.height);
        const scale = longest * 2 <= 3300 ? 2 : Math.min(1, 3300 / longest);
        const canvas = createCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        input = canvas.toBuffer("image/png");
      } catch { /* Pass images canvas cannot open to the OCR decoder. */ }
    }
    try { return { pages: [{ page: 1, lines: await recognizePage(worker, input) }], failed: [] }; }
    catch { return { pages: [], failed: [1] }; }
  } finally { await worker.terminate(); }
}
