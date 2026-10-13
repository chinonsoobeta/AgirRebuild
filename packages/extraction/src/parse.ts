import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
import { codeOf } from "@agir/numbers";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
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

/** The thin horizontal strokes and fills a page draws, as [x0, x1, y] in page space. Only plain scaling and translation are followed; a rotated or skewed drawing is left out. */
async function horizontalRules(pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"), page: PDFPageProxy): Promise<[number, number, number][]> {
  const { OPS } = pdfjs;
  const paints = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const list = await page.getOperatorList();
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const saved: M[] = [];
  const rules: [number, number, number][] = [];
  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] as unknown[];
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      saved.push(ctm);
      if (fn === OPS.paintFormXObjectBegin && Array.isArray(args?.[0])) ctm = mul(args[0] as M, ctm);
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) ctm = saved.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(args as unknown as M, ctm);
    else if (fn === OPS.constructPath && paints.has(args[0] as number)) {
      const box = args[2] as Record<number, number> | undefined;
      if (!box || ctm[1] !== 0 || ctm[2] !== 0) return;
      const [x0, x1] = [box[0]! * ctm[0] + ctm[4], box[2]! * ctm[0] + ctm[4]].sort((a, b) => a - b);
      const [y0, y1] = [box[1]! * ctm[3] + ctm[5], box[3]! * ctm[3] + ctm[5]].sort((a, b) => a - b);
      // A rule is at most 1.5 points thick (a stroked line has no thickness of its own: its width is a separate setting, so a zero-height box is a line).
      if (y1! - y0! <= 1.5 && x1! - x0! > 0) rules.push([x0!, x1!, (y0! + y1!) / 2]);
    }
  });
  return rules;
}

// Struck text is wrapped in these private-use marks while a line or cell is put together; `unmark` takes them out and returns the ranges.
const STRIKE_ON = "\ue000";
const STRIKE_OFF = "\ue001";

async function parsePdf(bytes: Uint8Array): Promise<NormalizedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  const tooLong = pdfPageError(doc.numPages);
  if (tooLong) {
    await task.destroy();
    throw tooLong;
  }
  const lines: Line[] = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // A page drawn rotated is not checked for strike-through lines.
    const rules = page.rotate === 0 ? await horizontalRules(pdfjs, page) : [];
    // Group text items into lines by their baseline.
    const rows = new Map<number, { x: number; s: string }[]>();
    for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!item.str || !item.transform) continue;
      const [a, b, , d, x, base] = item.transform as [number, number, number, number, number, number];
      const size = Math.abs(item.height || d);
      const width = item.width ?? 0;
      // Struck: an upright text item whose width a thin line covers almost entirely, at the middle of its letters. A line at or below the baseline is an underline.
      const covered = (r: [number, number, number]) => Math.max(0, Math.min(r[1], x + width) - Math.max(r[0], x)) >= 0.9 * width;
      const struck = b === 0 && a > 0 && width > 0 && item.str.trim() !== "" && rules.some((r) => r[2] >= base + 0.2 * size && r[2] <= base + 0.6 * size && covered(r));
      const y = Math.round(base);
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      const list = rows.get(key) ?? [];
      list.push({ x, s: struck ? STRIKE_ON + item.str + STRIKE_OFF : item.str });
      rows.set(key, list);
    }
    const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    ordered.forEach(([, parts], i) => {
      const { text, struck } = unmark(
        parts
          .sort((a, b) => a.x - b.x)
          .map((x) => x.s)
          .join(" ")
          .replace(/\s+/g, " "),
      );
      if (text) {
        chars += text.replace(/\s/g, "").length;
        lines.push({ text, location: `page ${p}, line ${i + 1}`, ...(struck.length > 0 ? { struck } : {}) });
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

const MAX_PART = 250 * 1024 * 1024;
const MAX_PACKAGE = 500 * 1024 * 1024;
export const MAX_PDF_PAGES = 5000;
const SPREADSHEET_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Internal absolute targets become relative to the folder holding the described part; an external target is never touched. */
function relativeTargets(xml: string, name: string): string {
  // "xl/_rels/a.rels" describes parts in "xl/".
  const dirs = name.replace(/(^|\/)_rels\/[^/]*$/, "$1").split("/").filter(Boolean);
  return xml.replace(/<Relationship\b[^>]*>/g, (tag) => {
    if (/\bTargetMode\s*=\s*["']External["']/.test(tag)) return tag;
    return tag.replace(/(\bTarget\s*=\s*)(["'])\/([^"']*)\2/, (_m, pre: string, q: string, target: string) => {
      const shared = target.split("/");
      let k = 0;
      while (k < dirs.length && k < shared.length - 1 && dirs[k] === shared[k]) k++;
      return `${pre}${q}${[...dirs.slice(k).map(() => ".."), ...shared.slice(k)].join("/")}${q}`;
    });
  });
}

/** A root element prefixed with the SpreadsheetML namespace is rewritten to the default namespace; any other default namespace leaves the part as it is. */
function defaultNamespace(xml: string): string {
  const root = /^\s*<([A-Za-z_][\w.-]*):[\w.-]+(\s[^>]*)?>/.exec(xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length)));
  if (!root) return xml;
  const prefix = root[1]!.replace(/[.-]/g, "\\$&");
  const attrs = root[2] ?? "";
  if (/\sxmlns\s*=/.test(attrs) || !new RegExp(`\\sxmlns:${prefix}\\s*=\\s*"${SPREADSHEET_MAIN}"`).test(attrs)) return xml;
  return xml
    .replace(new RegExp(`(\\sxmlns):${prefix}(\\s*=\\s*"${SPREADSHEET_MAIN}")`), "$1$2")
    .replace(new RegExp(`<(/?)${prefix}:`, "g"), "<$1");
}

type ZipHead = { name: string; method: number; time: number; date: number; crc: number; size: number; csize: number; local: number };

/**
 * The central directory of a zip, read once for both `relativeLinks` and `assertPackageSize`. `refuse` is set when the package declares a
 * part above MAX_PART or a total above MAX_PACKAGE, is zip64, or has an encrypted entry. Null: a package this cannot read.
 */
function centralDirectory(b: Buffer): { heads: ZipHead[]; refuse: boolean } | null {
  try {
    let eocd = b.length - 22;
    while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    if (eocd < 0) return null;
    const count = b.readUInt16LE(eocd + 10);
    let at = b.readUInt32LE(eocd + 16);
    if (count === 0xffff || at === 0xffffffff) return { heads: [], refuse: true }; // zip64
    const heads: ZipHead[] = [];
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (b.readUInt32LE(at) !== 0x02014b50) return null;
      const method = b.readUInt16LE(at + 10);
      const nameLen = b.readUInt16LE(at + 28);
      const head = { name: b.toString("utf8", at + 46, at + 46 + nameLen), method, time: b.readUInt16LE(at + 12), date: b.readUInt16LE(at + 14), crc: b.readUInt32LE(at + 16), csize: b.readUInt32LE(at + 20), size: b.readUInt32LE(at + 24), local: b.readUInt32LE(at + 42) };
      if (b.readUInt16LE(at + 8) & 1 || head.csize === 0xffffffff || head.local === 0xffffffff || head.size === 0xffffffff) return { heads: [], refuse: true };
      if (method !== 0 && method !== 8) return null;
      total += head.size;
      if (head.size > MAX_PART || total > MAX_PACKAGE) return { heads: [], refuse: true };
      heads.push(head);
      at += 46 + nameLen + b.readUInt16LE(at + 30) + b.readUInt16LE(at + 32);
    }
    return { heads, refuse: false };
  } catch {
    return null;
  }
}

/** One entry's stored bytes, after its local header. */
const partData = (b: Buffer, h: ZipHead) => {
  const start = h.local + 30 + b.readUInt16LE(h.local + 26) + b.readUInt16LE(h.local + 28);
  return b.subarray(start, start + h.csize);
};

/**
 * Uploads are untrusted: an xlsx or docx that declares more than it may expand to is refused before exceljs or mammoth opens it. A package
 * may understate its sizes, so each compressed part is inflated once with its output capped at the size it declares: a part that inflates past it is refused.
 */
function assertPackageSize(bytes: Uint8Array): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dir = centralDirectory(b);
  let refuse = dir?.refuse ?? false;
  for (const h of dir?.heads ?? []) {
    if (refuse || h.method !== 8) continue;
    try {
      inflateRawSync(partData(b, h), { maxOutputLength: Math.max(h.size, 1) });
    } catch (e) {
      // Only an overflow is a refusal; a part that cannot be inflated is left to the reader's own error.
      if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") refuse = true;
    }
  }
  if (refuse) throw new Error("This file expands to more than 500 MB when opened; Agir does not read it");
}

/** A PDF above MAX_PDF_PAGES is refused; null when the count is allowed. */
export function pdfPageError(pages: number): Error | null {
  return pages > MAX_PDF_PAGES ? new Error("This PDF has more than 5,000 pages; Agir does not read it") : null;
}

/**
 * Excel writes relative link targets inside the package ("worksheets/sheet1.xml"); other tools write absolute ones ("/xl/worksheets/sheet1.xml"),
 * which are just as valid but which exceljs does not follow for a sheet's comments or tables. A script that rewrites a part can also leave
 * the SpreadsheetML namespace on a prefix ("ns0:worksheet"), which exceljs's parser does not match. Only the link targets in `.rels` parts and
 * that prefix in `xl/` parts are changed; every other part is carried over byte for byte. Uploads are untrusted: a part above 250 MB, or a
 * package above 500 MB, is returned as it came (`assertPackageSize` refuses such a file before a reader opens it). A package this cannot read is returned as it came, so the reader's own
 * failure message stands. (No zip library is a direct dependency here, so the few zip structures needed are read with node:zlib.)
 */
export function relativeLinks(bytes: Uint8Array): Uint8Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: { name: string; method: number; time: number; date: number; crc: number; size: number; data: Buffer }[] = [];
  let changed = false;
  const dir = centralDirectory(b);
  if (!dir || dir.refuse) return bytes;
  try {
    for (const h of dir.heads) {
      const { name, method, time, date, crc, size } = h;
      let entry = { name, method, time, date, crc, size, data: partData(b, h) };
      if (name.endsWith(".rels") || (name.startsWith("xl/") && name.endsWith(".xml"))) {
        const xml = (method === 8 ? inflateRawSync(entry.data, { maxOutputLength: MAX_PART }) : entry.data).toString("utf8");
        const rewritten = name.endsWith(".rels") ? relativeTargets(xml, name) : defaultNamespace(xml);
        if (rewritten !== xml) {
          const raw = Buffer.from(rewritten, "utf8");
          entry = { ...entry, method: 8, crc: crc32(raw), size: raw.length, data: deflateRawSync(raw) };
          changed = true;
        }
      }
      entries.push(entry);
    }
    if (!changed) return bytes;
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name, "utf8");
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(e.time, 10);
      local.writeUInt16LE(e.date, 12);
      local.writeUInt32LE(e.crc, 14);
      local.writeUInt32LE(e.data.length, 18);
      local.writeUInt32LE(e.size, 22);
      local.writeUInt16LE(name.length, 26);
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(20, 4);
      local.copy(head, 6, 4, 30);
      head.writeUInt16LE(name.length, 28);
      head.writeUInt32LE(offset, 42);
      central.push(head, name);
      parts.push(local, name, e.data);
      offset += 30 + name.length + e.data.length;
    }
    const centralBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBytes.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...parts, centralBytes, end]));
  } catch {
    return bytes;
  }
}

async function parseXlsx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  assertPackageSize(bytes);
  const linked = relativeLinks(bytes);
  await wb.xlsx.load(linked.buffer.slice(linked.byteOffset, linked.byteOffset + linked.byteLength) as ArrayBuffer);
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
          cells.push({ text: isPct ? `${number}%` : String(number), number, ...(isPct ? { stored: v } : {}), ...(unit ? { unit } : {}), ...(unit === "$" && code ? { currency: code } : {}), ref });
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
function unmark(marked: string): { text: string; struck: [number, number][] } {
  let text = "";
  let from = -1;
  const ranges: [number, number][] = [];
  for (const ch of marked) {
    if (ch === STRIKE_ON) from = text.length;
    else if (ch === STRIKE_OFF) {
      if (from >= 0 && text.length > from) ranges.push(ranges.length > 0 && ranges.at(-1)![1] === from ? [ranges.pop()![0], text.length] : [from, text.length]);
      from = -1;
    } else text += ch;
  }
  const lead = text.length - text.trimStart().length;
  text = text.trim();
  return { text, struck: ranges.map(([a, b]): [number, number] => [Math.max(a - lead, 0), Math.min(b - lead, text.length)]).filter(([a, b]) => b > a) };
}

/**
 * Word files go through mammoth's HTML. Paragraphs, headings and list items outside tables are lines, located
 * "paragraph N" (N counts the non-empty ones, from 1, in document order); every table is a Table ("Table 1", ...)
 * whose cells keep their text and are located "Table 1 R2C3". A nested table is flattened into its cell's text.
 */
async function parseDocx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const mammoth = (await import("mammoth")).default;
  assertPackageSize(bytes);
  const { value: html } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const lines: Line[] = [];
  const tables: Table[] = [];
  const full: string[] = [];
  let depth = 0;
  let buf = "";
  let table: Table | null = null;
  let row: Cell[] | null = null;
  let cell: string | null = null;
  let struck = 0;
  const flush = () => {
    const { text: t, struck: ranges } = unmark(tidy(buf));
    buf = "";
    if (t) {
      lines.push({ text: t, location: `paragraph ${lines.length + 1}`, ...(ranges.length > 0 ? { struck: ranges } : {}) });
      full.push(t);
    }
  };
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const t = struck > 0 && m[4].trim() ? STRIKE_ON + decode(m[4]) + STRIKE_OFF : decode(m[4]);
      if (cell !== null) cell += t;
      else buf += t;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    // mammoth writes Word's strike-through as <s>.
    if (tag === "s" || tag === "strike" || tag === "del") {
      struck = Math.max(struck + (closing ? -1 : 1), 0);
      continue;
    }
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
        const { text, struck: ranges } = unmark(tidy(cell));
        row.push({ text, ref: `${table.name} R${table.rows.length + 1}C${row.length + 1}`, ...(ranges.length > 0 ? { struck: ranges } : {}) });
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
