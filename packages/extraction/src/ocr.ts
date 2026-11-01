import { copyFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorker } from "tesseract.js";
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
    const worker = await createWorker("eng+fra", 1, { langPath: await languagePath(), gzip: true, cacheMethod: "none", errorHandler: () => {} });
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
          const { data } = await worker.recognize(canvas.toBuffer("image/png"), {}, { blocks: true });
          const lines: OcrPage["lines"] = [];
          for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) {
            const text = line.text.trim();
            if (text) lines.push({ text, confidence: line.confidence });
          }
          result.push({ page: n, lines });
        } catch { failed.push(n); } finally { canvas = null; page?.cleanup(); }
      }
      return { pages: result, failed };
    } finally { await worker.terminate(); }
  } finally { await task.destroy(); }
}
