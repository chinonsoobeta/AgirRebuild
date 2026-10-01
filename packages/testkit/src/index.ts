// Reference deals (oracles/deals/*.json) and real file bytes generated from
// them, for parser tests and for the demo seed. The oracles are data owned by
// people; this module only reads them.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
