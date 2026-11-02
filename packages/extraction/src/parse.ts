import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";
import { codeOf } from "@agir/numbers";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { columnName, type Cell, type CellUnit, type Line, type NormalizedDocument, type Table } from "./document.ts";
import { pictureInfo } from "./image.ts";

export class UnsupportedDocumentError extends Error {}

export function kindOf(fileName: string): NormalizedDocument["kind"] | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "tif", "tiff"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "xlsx") return "xlsx";
  if (ext === "csv") return "csv";
  if (ext === "docx") return "docx";
  if (ext === "txt" || ext === "md") return "txt";
  return null;
}

/** Format-specific next steps, shared by uploads and direct parsing. */
export function refusalFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "heic" || ext === "heif") return "Agir cannot read HEIC photos. Export the photo as JPEG, then upload it.";
  if (ext === "xls") return "Agir reads Excel files saved as .xlsx. Open this one in Excel, save it as .xlsx, then upload it.";
  if (ext === "doc") return "Agir reads Word files saved as .docx. Open this one in Word, save it as .docx, then upload it.";
  if (ext === "ppt" || ext === "pptx") return "Agir does not read PowerPoint files. Save this one as a PDF, then upload that.";
  return "Upload a PDF, Excel (.xlsx), CSV, Word (.docx), text file, or a picture (PNG, JPEG or TIFF).";
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

/**
 * A page's drawing list. pdf.js sets no limit on it, and it builds the list on promises alone, so a timer barely gets a turn: 10 ticks of 10 ms in 4.6 seconds.
 * So this counts each chunk as it arrives, in pdf.js's own private method. A refusal leaves the list short, and `parsePdf` destroys the task, which stops the rest.
 */
export function drawingList(page: PDFPageProxy, room: number) {
  const inner = page as unknown as { _renderPageChunk(chunk: { length: number }, state: { operatorList: { fnArray: unknown[] } }): void };
  const add = inner._renderPageChunk;
  return new Promise<Awaited<ReturnType<PDFPageProxy["getOperatorList"]>>>((resolve, reject) => {
    inner._renderPageChunk = (chunk, state) => {
      if (state.operatorList.fnArray.length + chunk.length > room) reject(new UnsupportedDocumentError(FILE_TOO_LARGE));
      else add.call(page, chunk, state);
    };
    // The counting method holds this promise and so the finished list. Put pdf.js's own back, or `page.cleanup` frees nothing. After a refusal it stays, so what is still on its way is not kept.
    page.getOperatorList().then((list) => { inner._renderPageChunk = add; resolve(list); }, reject);
  });
}

/** One operator walk counts picture paints and their coverage, and finds thin horizontal rules as [x0, x1, y]. Rotated or skewed strokes are excluded from the rules. */
async function horizontalRules(pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"), page: PDFPageProxy, room: number): Promise<{ rules: [number, number, number][]; images: number; paths: number; cover: number; commands: number }> {
  const { OPS } = pdfjs;
  const paints = new Set<number>([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const list = await drawingList(page, room);
  const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectGroup]);
  let images = 0, paths = 0, area = 0;
  const pageArea = Math.abs((page.view[2]! - page.view[0]!) * (page.view[3]! - page.view[1]!));
  type M = [number, number, number, number, number, number];
  const mul = (a: M, b: M): M => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const saved: M[] = [];
  const rules: [number, number, number][] = [];
  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] as unknown[];
    if (fn === OPS.constructPath) paths++;
    if (imageOps.has(fn)) { images++; area += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]); }
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
  return { rules, images, paths, cover: Math.min(1, area / pageArea), commands: list.fnArray.length };
}

// Struck text is wrapped in these private-use marks while a line or cell is put together; `unmark` takes them out and returns the ranges.
const STRIKE_ON = "\ue000";
const STRIKE_OFF = "\ue001";

type PdfPiece = { x: number; end: number; size: number; s: string };

/** PDF font changes can split a word into items. An explicit space still wins. */
function pdfWords(parts: PdfPiece[]): string {
  return parts.map((part, i) => {
    const prev = parts[i - 1];
    const adjacent = prev && part.x - prev.end <= 0.12 * Math.min(prev.size, part.size);
    const space = prev && !adjacent && !/\s(?:\ue001)?$/.test(prev.s) && !/^(?:\ue000)?\s/.test(part.s) ? " " : "";
    return space + part.s;
  }).join("").replace(/\s+/g, " ");
}

/** Only persistent gutters with prose on both sides justify changing row order. */
export function pdfReadingOrder(rows: PdfPiece[][], spent: { columns: number }): PdfPiece[][] {
  const wide = (a: PdfPiece, b: PdfPiece) => b.x - a.end >= Math.max(18, 2 * Math.min(a.size, b.size));
  const cells = (row: PdfPiece[]) => {
    const out: PdfPiece[][] = [];
    row.forEach((p, i) => {
      if (i === 0 || wide(row[i - 1]!, p)) out.push([]);
      out.at(-1)!.push(p);
    });
    return out;
  };
  const prose = (row: PdfPiece[]) => {
    const text = pdfWords(row).replace(/[\ue000\ue001]/g, "");
    return (text.match(/\p{L}+/gu)?.length ?? 0) >= 5 && (text.match(/\d+/g)?.length ?? 0) <= 1;
  };
  const rowCells = rows.map(cells);
  const short = (cs: PdfPiece[][]) => cs.length >= 3 && cs.every(c => pdfWords(c).trim().split(/\s+/).length <= 4);
  // Three short-cell rows, with numbers in the body, are records, including their header.
  const table = new Set<number>();
  rows.forEach((_, i) => {
    if (rowCells.slice(i, i + 3).length === 3 && rowCells.slice(i, i + 3).every(short) && rowCells.slice(i + 1, i + 3).every(cs => cs.filter(c => /\d/.test(pdfWords(c))).length >= 2)) {
      [i, i + 1, i + 2].forEach(n => table.add(n));
    }
  });
  const positions = new Set<number>();
  for (const row of rows) row.forEach((p, i) => { if (i && wide(row[i - 1]!, p)) positions.add((row[i - 1]!.end + p.x) / 2); });
  // Each gap position is tried against every piece of text.
  spent.columns += positions.size * rows.reduce((n, row) => n + row.length, 0);
  if (spent.columns > MAX_PDF_COLUMN_WORK) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
  let best: { x: number; from: number; to: number; support: number } | null = null;
  for (const x of positions) {
    let from = 0, support = 0, leftProse = 0, rightProse = 0;
    const finish = (to: number) => {
      if (support >= 5 && leftProse >= 3 && rightProse >= 3 && (!best || support > best.support)) best = { x, from, to, support };
      from = to + 1; support = 0; leftProse = 0; rightProse = 0;
    };
    rows.forEach((row, i) => {
      const left = row.filter(p => p.end <= x), right = row.filter(p => p.x >= x);
      if (left.length + right.length !== row.length || table.has(i) && left.length > 0 && right.length > 0) { finish(i); return; }
      if (left.length && right.length) {
        if (!wide(left.at(-1)!, right[0]!)) { finish(i); return; }
        support++;
      }
      if (prose(left)) leftProse++;
      if (prose(right)) rightProse++;
    });
    finish(rows.length);
  }
  if (!best) return rows;
  // The search above assigns best inside a callback.
  const cut = best as { x: number; from: number; to: number; support: number };
  const run = rows.slice(cut.from, cut.to);
  const left = run.map(row => row.filter(p => p.end <= cut.x)).filter(row => row.length);
  const right = run.map(row => row.filter(p => p.x >= cut.x)).filter(row => row.length);
  return [...rows.slice(0, cut.from), ...pdfReadingOrder(left, spent), ...pdfReadingOrder(right, spent), ...pdfReadingOrder(rows.slice(cut.to), spent)];
}

/** A page's text, stopping at the limit: compressed, a few KB can hold tens of millions of pieces, each an object in memory. */
export async function textItems(page: PDFPageProxy, room: number) {
  const items: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>["items"] = [];
  const reader = page.streamTextContent().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return items;
    items.push(...value.items);
    // Never cancelled: as a page's last chunk goes out, pdf.js's cancel rejects a promise nothing holds, and that ends a Node process. `parsePdf` lets the stream go.
    if (items.length > room) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
  }
}

/** The row a text item joins: the first started within 2 points of its baseline, else its own. `started` holds each row's place in the order they began. */
export function pdfRowKey(started: Map<number, number>, y: number): number {
  let key = y, first = Infinity;
  for (const d of [-2, -1, 0, 1, 2]) {
    const k = y + d, at = started.get(k);
    if (at !== undefined && at < first && Math.abs(k - y) <= 2) {
      first = at;
      key = k;
    }
  }
  if (!started.has(key)) started.set(key, started.size);
  return key;
}

async function parsePdf(bytes: Uint8Array): Promise<NormalizedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    return await readPdf(pdfjs, await task.promise);
  } finally {
    // After this turn, when no stream is in that last moment, and not awaited: pdf.js's worker waits for ever on a text stream let go, so this may never end. What it holds is then collected.
    setImmediate(() => void task.destroy().catch(() => {}));
  }
}

async function readPdf(pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs"), doc: PDFDocumentProxy): Promise<NormalizedDocument> {
  const tooLong = pdfPageError(doc.numPages);
  if (tooLong) throw tooLong;
  const lines: Line[] = [];
  let chars = 0;
  const ocrPages: number[] = [];
  let items = 0, strikeWork = 0, commands = 0;
  const spent = { columns: 0 };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = { items: await textItems(page, MAX_PDF_ITEMS - items) };
    items += content.items.length;
    const text = content.items.flatMap(item => "str" in item ? [item.str] : []).join("").replace(/\s/g, "");
    // A symbol font can store its text 0xF000 above the bytes it means. A page mostly of such characters is that text; elsewhere they are bullets and stay.
    const shifted = (text.match(/[\uf000-\uf0ff]/g) ?? []).length;
    if (shifted > 0 && shifted * 2 >= text.length) {
      const decoder = new TextDecoder("windows-1252");
      for (const item of content.items) if ("str" in item) {
        item.str = item.str.replace(/[\uf020-\uf0ff]/g, c => decoder.decode(Uint8Array.of(c.charCodeAt(0) - 0xf000)));
      }
    }
    // A page drawn rotated is not checked for strike-through lines.
    const pageChars = content.items.reduce((n, item) => n + ("str" in item ? item.str.replace(/\s/g, "").length : 0), 0);
    // Text a font maps to control characters or U+FFFD can't be read, though the page looks fine. Five such characters and one in ten sends it to recognition.
    const undecodable = content.items.reduce((n, item) => n + ("str" in item ? (item.str.replace(/\s/g, "").match(/[\ufffd\u0000-\u001f\u007f-\u009f]/g) ?? []).length : 0), 0);
    const drawing = page.rotate === 0 || pageChars < 200 ? await horizontalRules(pdfjs, page, Math.min(MAX_PDF_PAGE_COMMANDS, MAX_PDF_COMMANDS - commands)) : { rules: [], images: 0, paths: 0, cover: 0, commands: 0 };
    commands += drawing.commands;
    const rules = page.rotate === 0 ? drawing.rules : [];
    strikeWork += rules.length * content.items.length;
    if (strikeWork > MAX_PDF_STRIKE_WORK) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
    if (pageChars < 16 && (drawing.images > 0 || drawing.paths > 50) || pageChars < 200 && drawing.cover >= 0.5 || undecodable >= 5 && undecodable * 10 >= pageChars) ocrPages.push(p);
    // Group text items into lines by their baseline.
    const rows = new Map<number, PdfPiece[]>();
    const started = new Map<number, number>();
    for (const item of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!item.str?.trim() || !item.transform) continue;
      const [a, b, , d, x, base] = item.transform as [number, number, number, number, number, number];
      const size = Math.abs(item.height || d);
      const width = item.width ?? 0;
      // Struck: an upright text item whose width a thin line covers almost entirely, at the middle of its letters. A line at or below the baseline is an underline.
      const covered = (r: [number, number, number]) => Math.max(0, Math.min(r[1], x + width) - Math.max(r[0], x)) >= 0.9 * width;
      const struck = b === 0 && a > 0 && width > 0 && item.str.trim() !== "" && rules.some((r) => r[2] >= base + 0.2 * size && r[2] <= base + 0.6 * size && covered(r));
      const y = Math.round(base);
      const key = pdfRowKey(started, y);
      const list = rows.get(key) ?? [];
      list.push({ x, end: x + width, size, s: struck ? STRIKE_ON + item.str + STRIKE_OFF : item.str });
      rows.set(key, list);
    }
    const ordered = pdfReadingOrder([...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, parts]) => parts.sort((a, b) => a.x - b.x)), spent);
    ordered.forEach((parts, i) => {
      const { text, struck } = unmark(pdfWords(parts));
      if (text) {
        chars += text.replace(/\s/g, "").length;
        lines.push({ text, location: `page ${p}, line ${i + 1}`, ...(struck.length > 0 ? { struck } : {}) });
      }
    });
    page.cleanup();
  }
  const pageCount = doc.numPages;
  if (chars < 16) ocrPages.splice(0, ocrPages.length, ...Array.from({ length: pageCount }, (_, i) => i + 1));
  return { kind: "pdf", lines, tables: [], pageCount, needsOcr: ocrPages.length > 0, ...(ocrPages.length ? { ocrPages } : {}), fullText: lines.map((l) => l.text).join("\n") };
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
/** Pieces of text in a whole PDF. The largest real PDF measured has 171,303. */
export const MAX_PDF_ITEMS = 2_000_000;
/** The search for columns tries each gap position against every piece of text, over all pages: 100 million takes about 18 seconds. The largest real PDF measured asks 26.8 million. */
export const MAX_PDF_COLUMN_WORK = 100_000_000;
/** The check for struck text tries each piece against every thin line, over all pages: 2 billion takes about 7 seconds. The largest real PDF measured asks 243 million. */
export const MAX_PDF_STRIKE_WORK = 2_000_000_000;
/** Drawing commands on one page, then in a whole PDF. A million on a page hold about 1 GB until the page is done, and 20 million take about a minute. The largest real PDF measured has 373,286 on a page and 1,777,596 in all. */
export const MAX_PDF_PAGE_COMMANDS = 1_000_000;
export const MAX_PDF_COMMANDS = 20_000_000;
/**
 * What a workbook may hold, counting rows, every cell of a merged range, and the empty cells that pad a row. exceljs and this parser keep an object
 * for each, about 0.75 KB, so this keeps one file to about 750 MB of memory. The largest real workbook measured has 407,000.
 */
export const MAX_WORKBOOK_CELLS = 1_000_000;
/** Text runs, shared strings and comments are smaller objects, so a workbook may hold more of those. The largest real workbook measured has 1,145,000 start tags. */
export const MAX_WORKBOOK_TAGS = 4_000_000;
/** mammoth keeps about 1.2 KB for each paragraph. The largest real Word file measured has 20,300 start tags. */
export const MAX_WORD_TAGS = 500_000;
/** exceljs compares each merged range with all those before it, so 10,000 take about 3.5 seconds and 20,000 about 15. The largest real workbook measured has 4,051. */
export const MAX_MERGED_RANGES = 10_000;
/** exceljs walks every row number up to a sheet's last, so each sheet costs time, however empty. The largest real workbook measured has 31. */
export const MAX_SHEETS = 1000;
/** Excel's own last row. A row number past it takes exceljs half a minute or more to walk. */
const LAST_ROW = 1_048_576;
/** A line of a text file or a field of a CSV is an object to this parser. The largest real text file measured has 869 lines. */
export const MAX_TEXT_PIECES = 1_000_000;
export const FILE_TOO_LARGE = "This file is too large for Agir to read. Save the parts that matter in a file of their own, then upload that.";
export const FILE_DAMAGED = "Agir could not open this file. It may be damaged. Save it again, then upload it.";
export const FILE_LOCKED = "This file has a password, or is in an older format. Remove the password or save it as a current Excel or Word file, then upload it.";
/** A password-protected Excel or Word file is this older container with the package encrypted inside it, not a zip. */
const OLE_FILE = Buffer.from("d0cf11e0a1b11ae1", "hex");
const SPREADSHEET_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * Nothing here reads these, and exceljs turns each into one object per cell it names, on load: a validation of a whole sheet, a named range, a width
 * given to a billion columns. A file of a few KB can run the worker out of memory, and whole-column validations are common in real workbooks.
 */
const UNUSED_BLOCKS = ["cols", "dataValidations", "definedNames"];
function withoutUnusedBlocks(xml: string): string {
  for (const tag of UNUSED_BLOCKS) {
    const open = `<${tag}`, close = `</${tag}>`;
    let at = xml.indexOf(open);
    if (at < 0) continue;
    const kept: string[] = [];
    let from = 0;
    for (; at >= 0; at = xml.indexOf(open, from)) {
      const end = xml.indexOf(close, at);
      if (end < 0) break;
      kept.push(xml.slice(from, at));
      from = end + close.length;
    }
    kept.push(xml.slice(from));
    xml = kept.join("");
  }
  return xml;
}

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
  // exceljs and mammoth open a package with bytes in front of it, and this directory reader does not, so every check here would pass it by.
  if (!dir) throw new UnsupportedDocumentError(b.subarray(0, OLE_FILE.length).equals(OLE_FILE) ? FILE_LOCKED : FILE_DAMAGED);
  let refuse = dir.refuse;
  for (const h of dir.heads) {
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

const columnNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
/** How many cells a <mergeCell> tag fills in. One this cannot read counts as too many, so exceljs never gets to expand it. */
function mergedCells(tag: string): number {
  const ref = /\sref\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
  const range = /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/.exec(ref?.[1] ?? ref?.[2] ?? "");
  if (!range) return Infinity;
  const [, left, top, right = left!, bottom = top!] = range;
  return (Math.abs(columnNumber(right) - columnNumber(left!)) + 1) * (Math.abs(Number(bottom) - Number(top)) + 1);
}

/** One part of a package, inflated. Null when it will not inflate: the reader that opens it then gets to say so. */
function partBytes(b: Buffer, h: ZipHead): Buffer | null {
  try {
    return h.method === 8 ? inflateRawSync(partData(b, h), { maxOutputLength: MAX_PART }) : partData(b, h);
  } catch {
    return null;
  }
}

/** A package whose XML holds too many start tags would not fit in memory once opened. Counted on the bytes, so a huge part never becomes a string. */
export function assertStartTags(bytes: Uint8Array, limit: number): void {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let tags = 0;
  for (const h of centralDirectory(b)?.heads ?? []) {
    if (!/\.(?:xml|rels)$/i.test(h.name)) continue;
    const xml = partBytes(b, h);
    for (let at = xml?.indexOf(0x3c) ?? -1; at >= 0; at = xml!.indexOf(0x3c, at + 1)) {
      const next = xml![at + 1];
      if (next !== 0x2f && next !== 0x3f && next !== 0x21 && ++tags > limit) throw new UnsupportedDocumentError(FILE_TOO_LARGE); // Not </, <? or <!.
    }
  }
}

/** A workbook that would not fit in memory is refused before exceljs opens it. */
function assertWorkbookSize(linked: Uint8Array): void {
  const b = Buffer.from(linked.buffer, linked.byteOffset, linked.byteLength);
  const sheets = (centralDirectory(b)?.heads ?? []).filter((h) => /xl\/worksheets\/[^/]*\.xml$/.test(h.name));
  if (sheets.length > MAX_SHEETS) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
  let cells = 0, merged = 0;
  for (const h of sheets) {
    const xml = partBytes(b, h)?.toString("utf8") ?? "";
    for (const [tag] of xml.matchAll(/<(?:c|row)[\s/>]|<mergeCell\s[^<>]*>/g)) {
      if (tag[1] === "m") { merged++; cells += mergedCells(tag); } else cells++;
      if (cells > MAX_WORKBOOK_CELLS || merged > MAX_MERGED_RANGES) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
    }
  }
}

/** A PDF above MAX_PDF_PAGES is refused; null when the count is allowed. */
export function pdfPageError(pages: number): Error | null {
  return pages > MAX_PDF_PAGES ? new Error("This PDF has more than 5,000 pages; Agir does not read it") : null;
}

// exceljs cannot tell a formula that returned "" from one with no saved result, so the empty result becomes one space. The bounds keep this linear on an untrusted file.
export const blankResults = (xml: string) => xml.replace(/(<c\b[^<>]{0,200}\bt="str"[^<>]{0,200}>\s{0,20}<f\b[^<>]{0,200}(?:\/>|>[^<]*<\/f>)\s{0,20})(?:<v>\s{0,20}<\/v>|<v\s{0,20}\/>)/g, "$1<v> </v>");

/** A column that numbers its own rows (a form's lookup index) holds no figures: at least 5 typed numbers, at least half of them their own row number. */
function markRowNumbers(rows: Cell[][]): void {
  const columns = new Map<string, { typed: Cell[]; own: number }>();
  for (const row of rows) for (const c of row) {
    if (c.number === undefined || c.computed || c.repeat) continue;
    const m = /([A-Z]+)(\d+)$/.exec(c.ref)!;
    const n = columns.get(m[1]!) ?? { typed: [], own: 0 };
    n.typed.push(c);
    if (c.number === Number(m[2])) n.own++;
    columns.set(m[1]!, n);
  }
  for (const n of columns.values()) if (n.typed.length >= 5 && n.own * 2 >= n.typed.length) for (const c of n.typed) c.rowNumber = true;
}

/** A workbook that asks to be recalculated when opened (a script wrote it) may hold a placeholder 0 for every formula. */
function recalculatesOnOpen(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = centralDirectory(b)?.heads.find((x) => x.name === "xl/workbook.xml");
  if (!h) return false;
  try {
    const xml = (h.method === 8 ? inflateRawSync(partData(b, h), { maxOutputLength: MAX_PART }) : partData(b, h)).toString("utf8");
    return /<(?:\w+:)?calcPr\b[^<>]{0,500}\bfullCalcOnLoad="(?:1|true)"/.test(xml);
  } catch { return false; }
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
      if (name.endsWith(".rels") || (name.includes("xl/") && name.endsWith(".xml"))) {
        const xml = (method === 8 ? inflateRawSync(entry.data, { maxOutputLength: MAX_PART }) : entry.data).toString("utf8");
        const rewritten = name.endsWith(".rels") ? relativeTargets(xml, name) : blankResults(withoutUnusedBlocks(defaultNamespace(xml)));
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

// Small images are usually logos and icons, rather than pages of figures.
const MIN_PICTURE_BYTES = 20_000;
function embeddedPictureNotes(bytes: Uint8Array, prefix: "word" | "xl"): string[] {
  const count = centralDirectory(Buffer.from(bytes))?.heads.filter(h => h.name.startsWith(`${prefix}/media/`) && h.size >= MIN_PICTURE_BYTES).length ?? 0;
  return count ? [`This file has ${count} ${count === 1 ? "picture" : "pictures"}. Agir does not read pictures inside Word or Excel files, so check ${count === 1 ? "it" : "them"} for figures.`] : [];
}

async function parseXlsx(bytes: Uint8Array): Promise<NormalizedDocument> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  assertPackageSize(bytes);
  assertStartTags(bytes, MAX_WORKBOOK_TAGS);
  const linked = relativeLinks(bytes);
  assertWorkbookSize(linked);
  await wb.xlsx.load(linked.buffer.slice(linked.byteOffset, linked.byteOffset + linked.byteLength) as ArrayBuffer);
  const tables: Table[] = [];
  const texts: string[] = [];
  // A formula with no saved result (a workbook written by a script) has no value: nothing is computed from the formula.
  const uncached: string[] = [];
  const stale = recalculatesOnOpen(bytes);
  const ZERO_DATE = Date.UTC(1899, 11, 30), FIRST_DATE = Date.UTC(1899, 11, 31);
  let padded = 0;
  wb.eachSheet((ws) => {
    if ((ws.lastRow?.number ?? 0) > LAST_ROW) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
    const rows: Cell[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      const cells: Cell[] = [];
      const count = Math.max(row.cellCount, row.actualCellCount);
      padded += count;
      if (padded > MAX_WORKBOOK_CELLS) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
      for (let c = 1; c <= count; c++) {
        const cell = row.getCell(c);
        const ref = `${ws.name}!${columnName(c - 1)}${r}`;
        let v: unknown = cell.value;
        let computed = false;
        if (v && typeof v === "object" && ("result" in (v as object) || "formula" in (v as object) || "sharedFormula" in (v as object))) {
          // exceljs's `value` leaves out a saved 0 or FALSE; `result` keeps them.
          computed = true;
          v = cell.master.result;
          if (stale && (v === 0 || v === false || (v instanceof Date && v.getTime() === ZERO_DATE))) v = undefined;
          if (typeof v === "string" && !v.trim()) v = null;
          if (v === undefined) uncached.push(wb.worksheets.length > 1 ? ref : ref.slice(ws.name.length + 1));
        }
        // A date reads as written, whatever the server's time zone. A saved 0 under a date format, or a time with no date, is no date.
        if (v instanceof Date) v = v.getTime() < FIRST_DATE ? null : v.toISOString().slice(0, 10);
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
        if (computed) cells[cells.length - 1]!.computed = true;
        // exceljs repeats a merged cell's value in every column it spans. A person sees it once. A cell merged down keeps its text on each row: a label that spans rows labels them all.
        if (cell.master !== cell && Number(cell.master.col) !== c) cells[cells.length - 1]!.repeat = true;
      }
      // A value with no unit of its own, beside a cell holding only a unit word ("months", "%"), is written in that unit.
      cells.forEach((c, i) => {
        const next = cells[i + 1];
        const unit = c.number !== undefined && !c.unit && next?.number === undefined ? unitOfWord(next?.text.trim().toLowerCase() ?? "") : null;
        if (unit) c.unit = unit;
      });
      rows.push(cells);
    });
    markRowNumbers(rows);
    for (const cells of rows) texts.push(cells.map((c) => c.text).join("\n"));
    tables.push({ name: ws.name, rows });
  });
  const listed = uncached.slice(0, 5).join(", ") + (uncached.length > 5 ? ` and ${(uncached.length - 5).toLocaleString("en-US")} more` : "");
  const notes = uncached.length > 0 ? [`This workbook has formulas with no saved results (${listed}). Open and save it in Excel to include them.`] : [];
  notes.push(...embeddedPictureNotes(bytes, "xl"));
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
  assertStartTags(bytes, MAX_WORD_TAGS);
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
  return { kind: "docx", lines, tables, pageCount: null, needsOcr: false, fullText: full.join("\n"), notes: embeddedPictureNotes(bytes, "word") };
}

/** Turn a file's bytes into lines and tables, each with its location. */
export async function parseDocument(bytes: Uint8Array, fileName: string): Promise<NormalizedDocument> {
  const kind = kindOf(fileName);
  if (kind === "image") {
    const info = pictureInfo(bytes);
    if (info === "unknown" || info === "unreadable") throw new UnsupportedDocumentError("Agir could not open this picture. It may be damaged. Upload it again, or save it as a PDF.");
    if (info.format === "tiff" && info.pages > 1) throw new UnsupportedDocumentError(`This TIFF has ${info.pages} pages. Save it as a PDF, then upload that.`);
    if (info.width * info.height > 80_000_000) throw new UnsupportedDocumentError(`This picture is ${Math.round(info.width * info.height / 1_000_000)} megapixels, and Agir reads pictures of up to 80. Save a smaller copy, then upload it.`);
    return { kind, lines: [], tables: [], pageCount: 1, needsOcr: true, ocrPages: [1], fullText: "" };
  }
  if (kind === "pdf") return parsePdf(bytes);
  if (kind === "xlsx") return parseXlsx(bytes);
  if (kind === "docx") return parseDocx(bytes);
  // Counted before the text is split: a field of a CSV ends at a comma or a line end, and a line of text at a newline.
  const pieces = bytes.reduce((n, byte) => (byte === 0x0a || (kind === "csv" && (byte === 0x2c || byte === 0x0d)) ? n + 1 : n), 0);
  if (kind && pieces > MAX_TEXT_PIECES) throw new UnsupportedDocumentError(FILE_TOO_LARGE);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "csv") {
    const rows = parseCsv(text).map((r, i) => r.map((t, c) => ({ text: t.trim(), ref: `${columnName(c)}${i + 1}` })));
    // Detect number format from cell values, not the raw file: the commas that
    // separate cells would otherwise hide numbers from the left-edge guard.
    const fullText = rows.map((r) => r.map((c) => c.text).join("\n")).join("\n");
    return { kind, lines: [], tables: [{ name: "CSV", rows }], pageCount: null, needsOcr: false, fullText };
  }
  if (kind === "txt") return { kind, lines: linesFromText(text), tables: [], pageCount: null, needsOcr: false, fullText: text };
  throw new UnsupportedDocumentError(refusalFor(fileName));
}
