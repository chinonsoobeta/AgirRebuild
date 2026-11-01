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
      tessedit_pageseg_mode: "3" as PSM, // Automatic layout keeps table items and amounts together.
      user_defined_dpi: "300", // A known resolution lets Tesseract remove thick table rules.
    });
    return worker;
  } catch (error) { await worker.terminate(); throw error; }
}

async function recognizeLines(worker: Awaited<ReturnType<typeof ocrWorker>>, bytes: Uint8Array): Promise<OcrPage["lines"]> {
  const { data } = await worker.recognize(Buffer.from(bytes), {}, { blocks: true });
  const lines: OcrPage["lines"] = [];
  for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) {
    const text = line.text.trim();
    if (text) lines.push({ text, confidence: line.confidence });
  }
  return lines;
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
