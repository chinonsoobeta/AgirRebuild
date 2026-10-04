import { codeOf } from "@agir/numbers";
import { columnName, type Cell, type Line, type NormalizedDocument, type Table } from "./document.ts";

export class UnsupportedDocumentError extends Error {}

export function kindOf(fileName: string): NormalizedDocument["kind"] | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "md") return "txt";
  return null;
}

function linesFromText(text: string, prefix = "line"): Line[] {
  return text
    .split(/\r?\n/)
    .map((t, i) => ({ text: t.replace(/\s+$/, ""), location: `${prefix} ${i + 1}` }))
    .filter((l) => l.text.trim().length > 0);
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function parsePdf(bytes: Uint8Array): Promise<NormalizedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  const lines: Line[] = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Group text items into lines by their baseline.
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as { str?: string; transform?: number[] }[]) {
      if (!item.str || !item.transform) continue;
      const y = Math.round(item.transform[5]!);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      const list = rows.get(key) ?? [];
      list.push({ x: item.transform[4]!, s: item.str });
      rows.set(key, list);
    }
    const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    ordered.forEach(([, parts], i) => {
      const text = parts
        .sort((a, b) => a.x - b.x)
        .map((x) => x.s)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        chars += text.replace(/\s/g, "").length;
        lines.push({ text, location: `page ${p}, line ${i + 1}` });
      }
    });
  }
  const pageCount = doc.numPages;
  await task.destroy();
  return { kind: "pdf", lines, tables: [], pageCount, needsOcr: chars < 16, fullText: lines.map((l) => l.text).join("\n") };
}

async function parseXlsx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const tables: Table[] = [];
  const texts: string[] = [];
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const cells: Cell[] = [];
      const count = Math.max(row.cellCount, row.actualCellCount);
      for (let c = 1; c <= count; c++) {
        const cell = row.getCell(c);
        const ref = `${ws.name}!${columnName(c - 1)}${r}`;
        let v: unknown = cell.value;
        if (v && typeof v === "object" && "result" in (v as object)) v = (v as { result: unknown }).result;
        if (v && typeof v === "object" && "richText" in (v as object)) {
          v = (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
        }
        if (typeof v === "number" && Number.isFinite(v)) {
          const fmt = String(cell.numFmt ?? "");
          const isPct = fmt.includes("%");
          // Only an explicit mark names a currency; "$" and "[$$-409]" name none.
          const code = codeOf(/(?<![A-Za-z])(?:US|CA|C|A)\$|\b(?:USD|CAD|AUD)\b/.exec(fmt)?.[0]);
          const isMoney = fmt.includes("$") || code !== null;
          const number = isPct ? v * 100 : v;
          cells.push({ text: String(number), number, ...(isPct ? { unit: "%" as const } : isMoney ? { unit: "$" as const, ...(code ? { currency: code } : {}) } : {}), ref });
        } else if (v === null || v === undefined) {
          cells.push({ text: "", ref });
        } else {
          cells.push({ text: String(v), ref });
        }
      }
      rows.push(cells);
      texts.push(cells.map((c) => c.text).join("\n"));
    });
    tables.push({ name: ws.name, rows });
  });
  return { kind: "xlsx", lines: [], tables, pageCount: null, needsOcr: false, fullText: texts.join("\n") };
}

async function parseDocx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  const lines = linesFromText(value, "paragraph");
  return { kind: "docx", lines, tables: [], pageCount: null, needsOcr: false, fullText: value };
}

/** Turn a file's bytes into lines and tables, each with its location. */
export async function parseDocument(bytes: Uint8Array, fileName: string): Promise<NormalizedDocument> {
  const kind = kindOf(fileName);
  if (kind === "pdf") return parsePdf(bytes);
  if (kind === "xlsx") return parseXlsx(bytes);
  if (kind === "docx") return parseDocx(bytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "csv") {
    const rows = parseCsv(text).map((r, i) => r.map((t, c) => ({ text: t.trim(), ref: `${columnName(c)}${i + 1}` })));
    // Detect number format from cell values, not the raw file: the commas that
    // separate cells would otherwise hide numbers from the left-edge guard.
    const fullText = rows.map((r) => r.map((c) => c.text).join("\n")).join("\n");
    return { kind, lines: [], tables: [{ name: "CSV", rows }], pageCount: null, needsOcr: false, fullText };
  }
  if (kind === "txt") return { kind, lines: linesFromText(text), tables: [], pageCount: null, needsOcr: false, fullText: text };
  throw new UnsupportedDocumentError(`Agir cannot read ${fileName}. Upload PDF, Excel (.xlsx), CSV, Word (.docx) or text.`);
}
