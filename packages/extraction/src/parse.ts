import { codeOf } from "@agir/numbers";
import { columnName, type Cell, type CellUnit, type Line, type NormalizedDocument, type Table } from "./document.ts";

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

/** A unit written alone, as a quoted number-format literal or in the cell beside a value; anything longer is a note, not a unit. */
function unitOfWord(w: string): CellUnit | null {
  if (w === "%" || w === "$" || w === "x") return w;
  if (/^(mois|mo|months?)$/.test(w)) return "months";
  if (/^(ans?|years?|yrs?)$/.test(w)) return "years";
  if (/^(sf|pi²|pi2)$/.test(w)) return "sf";
  if (/^(m²|m2)$/.test(w)) return "m2";
  return null;
}

async function parseXlsx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const tables: Table[] = [];
  const texts: string[] = [];
  // A formula with no saved result (a workbook written by a script) has no value: nothing is computed from the formula.
  const uncached: string[] = [];
  wb.eachSheet((ws) => {
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const cells: Cell[] = [];
      const count = Math.max(row.cellCount, row.actualCellCount);
      for (let c = 1; c <= count; c++) {
        const cell = row.getCell(c);
        const ref = `${ws.name}!${columnName(c - 1)}${r}`;
        let v: unknown = cell.value;
        if (v && typeof v === "object" && ("result" in (v as object) || "formula" in (v as object) || "sharedFormula" in (v as object))) {
          v = (v as { result?: unknown }).result;
          if (v === undefined) uncached.push(wb.worksheets.length > 1 ? ref : ref.slice(ws.name.length + 1));
        }
        // An error result ("#REF!") is no value either.
        if (v && typeof v === "object" && "error" in (v as object)) v = null;
        if (v && typeof v === "object" && "richText" in (v as object)) {
          v = (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
        }
        if (typeof v === "number" && Number.isFinite(v)) {
          const fmt = String(cell.numFmt ?? "");
          // Quoted strings and backslash-escaped characters are literal text, not format codes: only a bare "%" is Excel's percent.
          const literals = [...fmt.matchAll(/"([^"]*)"|\\(.)/g)].map((m) => (m[1] ?? m[2]!).trim().toLowerCase());
          const bare = fmt.replace(/"[^"]*"|\\./g, "");
          const literalUnit = literals.map(unitOfWord).find((u) => u !== null) ?? null;
          const isPct = bare.includes("%");
          // Only an explicit mark names a currency; "$" and "[$$-409]" name none.
          const code = codeOf(/(?<![A-Za-z])(?:US|CA|C|A)\$|\b(?:USD|CAD|AUD)\b/.exec(fmt)?.[0]);
          const unit: CellUnit | null = isPct ? "%" : bare.includes("$") || code !== null || literals.includes("$") ? "$" : literalUnit;
          const number = isPct ? Number((v * 100).toPrecision(12)) : v;
          cells.push({ text: String(number), number, ...(unit ? { unit } : {}), ...(unit === "$" && code ? { currency: code } : {}), ref });
        } else if (v === null || v === undefined) {
          cells.push({ text: "", ref });
        } else {
          cells.push({ text: String(v), ref });
        }
      }
      // A value with no unit of its own, beside a cell holding only a unit word ("months", "%"), is written in that unit.
      cells.forEach((c, i) => {
        const next = cells[i + 1];
        const unit = c.number !== undefined && !c.unit && next?.number === undefined ? unitOfWord(next?.text.trim().toLowerCase() ?? "") : null;
        if (unit) c.unit = unit;
      });
      rows.push(cells);
      texts.push(cells.map((c) => c.text).join("\n"));
    });
    tables.push({ name: ws.name, rows });
  });
  const notes = uncached.length > 0 ? [`This workbook has formulas with no saved results (${uncached.join(", ")}). Open and save it in Excel to include them.`] : [];
  return { kind: "xlsx", lines: [], tables, pageCount: null, needsOcr: false, fullText: texts.join("\n"), notes };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
const tidy = (s: string) => s.replace(/[ \t\r\n]+/g, " ").trim();

/**
 * Word files go through mammoth's HTML. Paragraphs, headings and list items outside tables are lines, located
 * "paragraph N" (N counts the non-empty ones, from 1, in document order); every table is a Table ("Table 1", ...)
 * whose cells keep their text and are located "Table 1 R2C3". A nested table is flattened into its cell's text.
 */
async function parseDocx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const mammoth = (await import("mammoth")).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const lines: Line[] = [];
  const tables: Table[] = [];
  const full: string[] = [];
  let depth = 0;
  let buf = "";
  let table: Table | null = null;
  let row: Cell[] | null = null;
  let cell: string | null = null;
  const flush = () => {
    const t = tidy(buf);
    buf = "";
    if (t) {
      lines.push({ text: t, location: `paragraph ${lines.length + 1}` });
      full.push(t);
    }
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const t = decode(m[4]);
      if (cell !== null) cell += t;
      else buf += t;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (tag === "table") {
      if (!closing) {
        if (depth++ === 0) {
          flush();
          table = { name: `Table ${tables.length + 1}`, rows: [], at: lines.length };
        } else cell += " ";
      } else if (--depth === 0 && table) {
        tables.push(table);
        table = null;
      }
    } else if (depth > 1) {
      if (/^(p|h[1-6]|li|br|tr|td|th)$/.test(tag)) cell += " ";
    } else if (depth === 1) {
      if (tag === "tr" && !closing) row = [];
      else if (tag === "tr" && row && table) {
        table.rows.push(row);
        row = null;
      } else if ((tag === "td" || tag === "th") && !closing) cell = "";
      else if ((tag === "td" || tag === "th") && row && table && cell !== null) {
        const text = tidy(cell);
        row.push({ text, ref: `${table.name} R${table.rows.length + 1}C${row.length + 1}` });
        full.push(text);
        cell = null;
      } else if (cell !== null && /^(p|h[1-6]|li|br)$/.test(tag)) cell += " ";
    } else if (/^(p|h[1-6]|li|ul|ol|br)$/.test(tag)) flush();
  }
  flush();
  return { kind: "docx", lines, tables, pageCount: null, needsOcr: false, fullText: full.join("\n") };
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
