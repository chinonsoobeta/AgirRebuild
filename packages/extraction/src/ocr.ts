import { copyFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWorker } from "tesseract.js";
import type { Line } from "./document.ts";

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
export async function ocrPdf(bytes: Uint8Array): Promise<{ lines: Line[]; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > 50) throw new Error("This scanned PDF has more than 50 pages; Agir reads scans of up to 50 pages. Split it, or enter its values by hand.");
    let canvasModule: typeof import("@napi-rs/canvas");
    try { canvasModule = await import("@napi-rs/canvas"); }
    catch { throw new Error("OCR is not available on this machine"); }
    const worker = await createWorker("eng+fra", 1, { langPath: await languagePath(), gzip: true, cacheMethod: "none" });
    try {
      const lines: Line[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        let canvas: import("@napi-rs/canvas").Canvas | null = null;
        try {
          const size = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(300 / 72, 3300 / Math.max(size.width, size.height)) });
          canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
          const { data } = await worker.recognize(canvas.toBuffer("image/png"), {}, { blocks: true });
          let lineNumber = 0;
          for (const block of data.blocks ?? []) for (const para of block.paragraphs) for (const line of para.lines) {
            const text = line.text.trim();
            if (text) lines.push({ text, location: `page ${n}, line ${++lineNumber} (OCR, confidence ${Math.round(line.confidence)}%)` });
          }
        } finally { canvas = null; page.cleanup(); }
      }
      return { lines, pageCount: doc.numPages };
    } finally { await worker.terminate(); }
  } finally { await task.destroy(); }
}
