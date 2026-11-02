// Reference deals (oracles/deals/*.json) and real file bytes generated from
// them, for parser tests and for the demo seed. The oracles are data owned by
// people; this module only reads them.

import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export type OracleDoc = {
  name: string;
  kind: "pdf" | "xlsx" | "csv" | "txt";
  title?: string;
  sheet?: string;
  lines?: string[];
  rows?: (string | number)[][];
};

export type OracleDeal = {
  slug: string;
  name: string;
  assetType: string;
  location: string;
  purpose: string;
  documents: OracleDoc[];
  expect: {
    conflicts: { key: string; values: number[] }[];
    missing: string[];
    values?: Record<string, number>;
    neverValues?: Record<string, number[]>;
    neverInputs?: number[];
    teaserNeverCandidates?: string[];
    runs: boolean;
  };
};

export const ORACLE_DIR = join(import.meta.dirname, "../../../oracles/deals");

export function loadOracles(): OracleDeal[] {
  return readdirSync(ORACLE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(ORACLE_DIR, f), "utf8")) as OracleDeal);
}

export function loadOracle(slug: string): OracleDeal {
  const d = loadOracles().find((x) => x.slug === slug);
  if (!d) throw new Error(`No reference deal "${slug}"`);
  return d;
}

// WinAnsi (the standard PDF fonts) cannot encode every character; keep the
// text a reader would see, with typographic minus and dashes as ASCII.
function winAnsi(s: string): string {
  return s.replace(/[−‒–—]/g, "-").replace(/[^\x20-\x7E -ÿ]/g, "?");
}

async function pdfBytes(doc: OracleDoc): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title ?? doc.name);
  pdf.setProducer("Agir V2 testkit");
  pdf.setCreationDate(new Date(0));
  pdf.setModificationDate(new Date(0));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 720;
  if (doc.title) {
    page.drawText(winAnsi(doc.title), { x: 72, y, size: 16, font: bold, color: rgb(0.08, 0.09, 0.11) });
    y -= 36;
  }
  for (const line of doc.lines ?? []) {
    if (y < 72) {
      page = pdf.addPage([612, 792]);
      y = 720;
    }
    page.drawText(winAnsi(line), { x: 72, y, size: 11, font, color: rgb(0.08, 0.09, 0.11) });
    y -= 20;
  }
  return pdf.save({ useObjectStreams: false });
}

async function xlsxBytes(doc: OracleDoc): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Agir V2 testkit";
  wb.created = new Date(0);
  wb.modified = new Date(0);
  const ws = wb.addWorksheet(doc.sheet ?? "Sheet1");
  (doc.rows ?? []).forEach((r, i) => {
    const row = ws.addRow(r);
    if (i === 0) row.font = { bold: true };
    row.eachCell((cell) => {
      if (typeof cell.value === "number") cell.numFmt = '"$"#,##0';
    });
  });
  ws.columns.forEach((c) => (c.width = 28));
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

function csvBytes(doc: OracleDoc): Uint8Array {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return new TextEncoder().encode((doc.rows ?? []).map((r) => r.map(esc).join(",")).join("\n") + "\n");
}

/** The bytes of one reference document, as a real file of its kind. */
export async function documentBytes(doc: OracleDoc): Promise<Uint8Array> {
  if (doc.kind === "pdf") return pdfBytes(doc);
  if (doc.kind === "xlsx") return xlsxBytes(doc);
  if (doc.kind === "csv") return csvBytes(doc);
  return new TextEncoder().encode([doc.title, ...(doc.lines ?? [])].filter(Boolean).join("\n") + "\n");
}

let pageFontFamily: string | undefined;

/** The font for a page that real OCR reads. "sans-serif" can be a pixel font on Linux, whose digits Tesseract misreads, so these pages name a font every machine gets from the install. */
export function pageFont(): string {
  if (pageFontFamily) return pageFontFamily;
  const require = createRequire(import.meta.url);
  const { GlobalFonts } = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
  const folder = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  GlobalFonts.registerFromPath(join(folder, "LiberationSans-Regular.ttf"), "AgirTestSans");
  GlobalFonts.registerFromPath(join(folder, "LiberationSans-Bold.ttf"), "AgirTestSans");
  return pageFontFamily = "AgirTestSans";
}

/** An image-only PDF for scan-reading tests, with no text layer. */
export async function scanPdf(jpeg: Uint8Array, pages = 1): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const img = await pdf.embedJpg(jpeg);
  for (let n = 0; n < pages; n++) pdf.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  return pdf.save();
}

/** Uncompressed 8-bit grayscale TIFF, built without platform tools. */
export function tiffBytes(width: number, height: number, gray: Uint8Array, options: { bigEndian?: boolean; pages?: number } = {}): Uint8Array {
  const pages = options.pages ?? 1, entries = 9, directorySize = 2 + entries * 12 + 4;
  const pixels = width * height;
  if (gray.length !== pixels) throw new Error("TIFF grayscale data must match its dimensions");
  const bytes = new Uint8Array(8 + pages * (directorySize + pixels));
  const view = new DataView(bytes.buffer), little = !options.bigEndian;
  const u16 = (at: number, n: number) => view.setUint16(at, n, little);
  const u32 = (at: number, n: number) => view.setUint32(at, n, little);
  bytes.set(little ? [73, 73] : [77, 77]); u16(2, 42); u32(4, 8);
  for (let page = 0; page < pages; page++) {
    const at = 8 + page * (directorySize + pixels), data = at + directorySize;
    u16(at, entries);
    const tags = [[256, 4, width], [257, 4, height], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, data], [277, 3, 1], [278, 4, height], [279, 4, pixels]];
    tags.forEach(([tag, type, value], i) => {
      const entry = at + 2 + i * 12;
      u16(entry, tag!); u16(entry + 2, type!); u32(entry + 4, 1);
      if (type === 3) u16(entry + 8, value!); else u32(entry + 8, value!);
    });
    u32(at + 2 + entries * 12, page + 1 < pages ? data + pixels : 0);
    bytes.set(gray, data);
  }
  return bytes;
}
