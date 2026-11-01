// What Agir refuses, and what it still reads, measured on invented files only.
import { deflateSync } from "node:zlib";
import v8 from "node:v8";
import vm from "node:vm";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import ExcelJS from "exceljs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  parseDocument, UnsupportedDocumentError, FILE_TOO_LARGE, FILE_DAMAGED, FILE_LOCKED,
  MAX_PDF_ITEMS, MAX_PDF_COLUMN_WORK, MAX_PDF_STRIKE_WORK, MAX_PDF_PAGE_COMMANDS, MAX_PDF_COMMANDS,
  MAX_WORKBOOK_CELLS, MAX_WORKBOOK_TAGS, MAX_WORD_TAGS, MAX_MERGED_RANGES, MAX_SHEETS, MAX_TEXT_PIECES,
  assertStartTags, textItems, drawingList, pdfReadingOrder, pdfRowKey,
} from "../src/parse.ts";
// A real collection, so the memory test measures what is kept and not when the collector last ran.
v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc") as () => void;
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const CT = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WBRELS = (n: number) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
const ROWS = '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>';
const sheet = ({ cols = "", rows = ROWS, after = "" } = {}) => `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}>${cols}<sheetData>${rows}</sheetData>${after}</worksheet>`;
async function xlsx(sheets: string[] | string, names = "") {
  const list = Array.isArray(sheets) ? sheets : [sheets];
  const z = new JSZip();
  z.file("[Content_Types].xml", CT); z.file("_rels/.rels", RELS); z.file("xl/_rels/workbook.xml.rels", WBRELS(list.length));
  z.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets>${list.map((_, i) => `<sheet name="Sheet${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${names}</workbook>`);
  list.forEach((s, i) => z.file(`xl/worksheets/sheet${i + 1}.xml`, s));
  return new Uint8Array(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
async function docx(body: string) {
  const z = new JSZip();
  z.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}
function pdf(pages: string[]) {
  const objs = new Map<number, Buffer>();
  objs.set(1, Buffer.from("<< /Type /Catalog /Pages 2 0 R >>")); objs.set(3, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const kids: string[] = []; let n = 4;
  for (const content of pages) {
    const raw = deflateSync(Buffer.from(content));
    objs.set(n, Buffer.concat([Buffer.from(`<< /Length ${raw.length} /Filter /FlateDecode >>\nstream\n`), raw, Buffer.from("\nendstream")]));
    objs.set(n + 1, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000000 10000000] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n} 0 R >>`));
    kids.push(`${n + 1} 0 R`); n += 2;
  }
  objs.set(2, Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(" ")}] >>`));
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")]; let at = parts[0]!.length; const offs = new Map<number, number>();
  for (const k of [...objs.keys()].sort((a, b) => a - b)) { const b = Buffer.concat([Buffer.from(`${k} 0 obj\n`), objs.get(k)!, Buffer.from("\nendobj\n")]); offs.set(k, at); parts.push(b); at += b.length; }
  const size = Math.max(...objs.keys()) + 1;
  parts.push(Buffer.from(`xref\n0 ${size}\n0000000000 65535 f \n${[...objs.keys()].sort((a, b) => a - b).map(k => `${String(offs.get(k)).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}
const text = (s: string) => new TextEncoder().encode(s);
// Pieces of text, each at a position of its own. One piece is one item.
const tall = (n: number) => "BT /F1 8 Tf " + Array.from({ length: n }, (_, i) => `1 0 0 1 72 ${9000000 - 20 * i} Tm (a) Tj `).join("") + "ET";
// Each "q Q " is two drawing commands.
const saves = (n: number) => "q Q ".repeat(Math.floor(n / 2));
// Rows with a gap at a distance of its own, so every row adds a position for the column search.
const gutters = (n: number) => "BT /F1 8 Tf " + Array.from({ length: n }, (_, i) => `1 0 0 1 72 ${9000000 - 20 * i} Tm (a) Tj 1 0 0 1 ${200 + 2 * i} ${9000000 - 20 * i} Tm (b) Tj `).join("") + "ET";
// Pieces and thin lines. The lines' y stays under 2^24, because pdf.js keeps boxes in 32-bit floats and larger ones lose their thinness.
const strike = (n: number) => "BT /F1 8 Tf " + Array.from({ length: n }, (_, i) => `1 0 0 1 72 ${9000000 - 20 * i} Tm (a) Tj `).join("") + "ET " + Array.from({ length: n }, (_, i) => `72 ${16000000 - 20 * i} 400 0.5 re f `).join("");


const LONG = 120_000;
async function refused(promise: Promise<unknown>, message = FILE_TOO_LARGE) {
  await expect(promise).rejects.toBeInstanceOf(UnsupportedDocumentError);
  await expect(promise).rejects.toHaveProperty("message", message);
}
const values = (d: Awaited<ReturnType<typeof parseDocument>>) => d.tables[0]!.rows[0]!.map(c => c.text);
const merges = (n: number) => `<mergeCells count="${n}">${Array.from({ length: n }, (_, i) => `<mergeCell ref="A${2 * i + 3}:B${2 * i + 3}"/>`).join("")}</mergeCells>`;
const merge = (ref: string) => `<mergeCells count="1"><mergeCell ref="${ref}"/></mergeCells>`;
const oneCellRows = (n: number, col = "A") => Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="${col}${i + 1}"><v>${i + 1}</v></c></row>`).join("");

// The constants and helper exports are introduced by Card 200.
test("the limits are pinned", () => {
  expect([MAX_PDF_ITEMS, MAX_PDF_COLUMN_WORK, MAX_PDF_STRIKE_WORK, MAX_PDF_PAGE_COMMANDS, MAX_PDF_COMMANDS,
    MAX_WORKBOOK_CELLS, MAX_WORKBOOK_TAGS, MAX_WORD_TAGS, MAX_MERGED_RANGES, MAX_SHEETS, MAX_TEXT_PIECES])
    .toEqual([2_000_000, 100_000_000, 2_000_000_000, 1_000_000, 20_000_000, 1_000_000, 4_000_000, 500_000, 10_000, 1000, 1_000_000]);
});

describe("workbooks", () => {
  test.each(["A1:XFD1048576", "A1:Z200000", "whole"])("refuses merge %s", async ref => {
    await refused(parseDocument(await xlsx(sheet({ after: merge(ref) })), "a.xlsx"));
  }, LONG);
  test.each([10000, 10001])("merge count %i", async n => {
    const p = parseDocument(await xlsx(sheet({ after: merges(n) })), "a.xlsx");
    if (n > 10000) await refused(p); else expect(values(await p)).toEqual(["1", "2"]);
  }, LONG);
  test.each([499999, 500001])("one-cell rows %i", async n => {
    const p = parseDocument(await xlsx(sheet({ rows: oneCellRows(n) })), "a.xlsx");
    if (n > 500000) await refused(p); else expect((await p).tables[0]!.rows).toHaveLength(n);
  }, LONG);
  test.each([61, 62])("padded XFD rows %i", async n => {
    const p = parseDocument(await xlsx(sheet({ rows: oneCellRows(n, "XFD") })), "a.xlsx");
    if (n === 62) await refused(p); else expect((await p).tables[0]!.rows.reduce((sum, r) => sum + r.length, 0)).toBe(999424);
  }, LONG);
  test.each([2147483647, 1048576])("last row %i", async n => {
    const p = parseDocument(await xlsx(sheet({ rows: `<row r="${n}"><c r="A${n}"><v>1</v></c></row>` })), "a.xlsx");
    if (n > 1048576) await refused(p); else expect((await p).tables[0]!.rows).toHaveLength(1);
  }, LONG);
  test.each([1000, 1001])("sheet count %i", async n => {
    const p = parseDocument(await xlsx(Array(n).fill(sheet())), "a.xlsx");
    if (n > 1000) await refused(p); else expect((await p).tables).toHaveLength(1000);
  }, LONG);
  test("refuses 4,000,002 shared-string start tags", async () => {
    const z = await JSZip.loadAsync(await xlsx(sheet()));
    z.file("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + "<si><t>x</t></si>".repeat(2000001) + "</sst>");
    await refused(parseDocument(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }), "a.xlsx"));
  }, LONG);
});

test.each([4, 3])("assertStartTags limit %i", async limit => {
  const z = new JSZip();
  z.file("a.xml", '<?xml version="1.0"?><!-- no --><a><b/><c></c></a>');
  z.file("b.rels", "<d/>"); z.file("c.bin", "<e/><f/>");
  const bytes = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  if (limit === 4) expect(() => assertStartTags(bytes, limit)).not.toThrow();
  else { expect(() => assertStartTags(bytes, limit)).toThrow(UnsupportedDocumentError); expect(() => assertStartTags(bytes, limit)).toThrow(FILE_TOO_LARGE); }
});

test.each(["cols", "validation", "name"])("does not expand unused %s", async block => {
  const bytes = await xlsx(sheet({
    cols: block === "cols" ? '<cols><col min="1" max="100000000" width="9" customWidth="1"/></cols>' : "",
    after: block === "validation" ? '<dataValidations count="1"><dataValidation type="whole" sqref="A1:XFD1048576"/></dataValidations>' : "",
  }), block === "name" ? '<definedNames><definedName name="big">Sheet1!$A$1:$XFD$1048576</definedName></definedNames>' : "");
  const start = performance.now();
  expect(values(await parseDocument(bytes, "a.xlsx"))).toEqual(["1", "2"]);
  expect(performance.now() - start).toBeLessThan(5000);
});

test("removing all three unused blocks preserves workbook JSON", async () => {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Budget");
  ws.columns = [{ width: 25 }, { width: 18 }];
  ws.addRows([["Land cost", 1000000], ["Hard cost", 2000000]]);
  ws.getCell("B1").dataValidation = { type: "whole", operator: "greaterThan", formulae: [0] };
  wb.definedNames.add("Budget!$B$1", "land");
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  const z = await JSZip.loadAsync(bytes);
  for (const [path, tags] of [["xl/worksheets/sheet1.xml", ["cols", "dataValidations"]], ["xl/workbook.xml", ["definedNames"]]] as const) {
    let xml = await z.file(path)!.async("string");
    for (const tag of tags) { expect(xml).toContain(`<${tag}`); xml = xml.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), ""); }
    z.file(path, xml);
  }
  expect(await parseDocument(await z.generateAsync({ type: "uint8array", compression: "DEFLATE" }), "a.xlsx"))
    .toEqual(await parseDocument(bytes, "a.xlsx"));
});

test.each([
  ["newline at limit", "\n", 1000000, "txt", true], ["newline over limit", "\n", 1000001, "txt", false],
  ["commas in text", ",", 1000001, "txt", true], ["CSV at limit", ",", 1000000, "csv", true],
  ["CSV over limit", ",", 1000001, "csv", false], ["CSV carriage returns", "\r", 1000001, "csv", false],
] as const)("text: %s", async (_name, ch, n, ext, read) => {
  const p = parseDocument(text(ch.repeat(n)), `a.${ext}`);
  if (!read) await refused(p);
  else { const d = await p; if (ext === "txt") expect(d.lines).toHaveLength(ch === "," ? 1 : 0); else expect(d.tables[0]!.rows[0]).toHaveLength(1000001); }
}, LONG);

test.each([100000, 500001])("Word paragraphs %i", async n => {
  const p = parseDocument(await docx("<w:p/>".repeat(n)), "a.docx");
  if (n > 500000) await refused(p); else expect((await p).lines).toEqual([]);
}, LONG);
test("Word reads an invented budget line", async () => {
  expect((await parseDocument(await docx("<w:p><w:r><w:t>Land cost: $1,000,000</w:t></w:r></w:p>"), "a.docx")).lines.map(l => l.text)).toEqual(["Land cost: $1,000,000"]);
});

describe("packages", () => {
  test.each(["xlsx", "docx"])("%s with a prefix is damaged", async ext => {
    const bytes = ext === "xlsx" ? await xlsx(sheet()) : await docx("<w:p/>");
    await refused(parseDocument(Buffer.concat([Buffer.alloc(100, 32), bytes]), `a.${ext}`), FILE_DAMAGED);
  });
  test("a prefixed merge bomb is damaged", async () => {
    await refused(parseDocument(Buffer.concat([Buffer.alloc(100, 32), await xlsx(sheet({ after: merge("A1:XFD1048576") }))]), "a.xlsx"), FILE_DAMAGED);
  });
  test.each(["xlsx", "docx"])("%s random and empty bytes are damaged", async ext => {
    for (const bytes of [Uint8Array.of(1, 17, 88, 99), new Uint8Array()]) await refused(parseDocument(bytes, `a.${ext}`), FILE_DAMAGED);
  });
  test("a truncated workbook is damaged", async () => {
    const bytes = await xlsx(sheet()); await refused(parseDocument(bytes.subarray(0, Math.floor(bytes.length / 2)), "a.xlsx"), FILE_DAMAGED);
  });
  test("CSV disguised as a workbook is damaged", async () => { await refused(parseDocument(text("Land cost,1000000"), "a.xlsx"), FILE_DAMAGED); });
  test.each(["xlsx", "docx"])("%s in an OLE container is locked", async ext => {
    await refused(parseDocument(Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(5000)]), `a.${ext}`), FILE_LOCKED);
  });
  test.each(["comment", "STORE", "trailing zeros"])("a workbook with %s preserves JSON", async kind => {
    const bytes = await xlsx(sheet()), z = await JSZip.loadAsync(bytes);
    const modified = kind === "trailing zeros" ? Buffer.concat([bytes, Buffer.alloc(300)])
      : await z.generateAsync({ type: "uint8array", compression: kind === "STORE" ? "STORE" : "DEFLATE", comment: kind === "comment" ? "Invented comment" : "" });
    expect(await parseDocument(modified, "a.xlsx")).toEqual(await parseDocument(bytes, "a.xlsx"));
  });
  test("reads local zip64 headers", async () => {
    const d = await parseDocument(readFileSync(new URL("./fixtures/zip64-local.xlsx", import.meta.url)), "a.xlsx");
    expect(d.tables[0]!.rows.map(r => r.map(c => c.text))).toEqual([["Land cost", "1000000"], ["Hard cost", "2000000"]]);
  });
});

describe("PDFs through parseDocument", () => {
  test.each([1000000, 1000002])("page commands %i", async n => {
    const p = parseDocument(pdf([saves(n)]), "a.pdf"); if (n > 1000000) await refused(p); else expect((await p).pageCount).toBe(1);
  }, LONG);
  test.each([20, 21])("total commands on %i pages", async n => {
    const p = parseDocument(pdf(Array(n).fill(saves(1000000))), "a.pdf"); if (n === 21) await refused(p); else expect((await p).pageCount).toBe(20);
  }, LONG);
  test("refuses repeated text drawing commands", async () => {
    await refused(parseDocument(pdf(["BT /F1 8 Tf 1 0 0 1 72 500 Tm " + "(a) Tj ".repeat(1000001) + "ET"]), "a.pdf"));
  }, LONG);
  test("refuses excessive gutter work", async () => { await refused(parseDocument(pdf([gutters(8000)]), "a.pdf")); }, LONG);
  test.each([44000, 45000])("strike work at %i pieces", async n => {
    const p = parseDocument(pdf([strike(n)]), "a.pdf"); if (n === 45000) await refused(p); else expect((await p).lines).toHaveLength(n);
  }, LONG);
  test("the total item refusal settles across pages", async () => {
    await refused(parseDocument(pdf(Array(5).fill(tall(450000))), "a.pdf"));
  }, LONG);
  test("reads a struck line", async () => {
    const d = await parseDocument(pdf(["BT /F1 8 Tf 1 0 0 1 72 500 Tm (Land cost 1000000) Tj ET 72 502 80 0.5 re f"]), "a.pdf");
    expect(d.lines).toHaveLength(1); expect(d.lines[0]).toMatchObject({ text: "Land cost 1000000", struck: expect.any(Array) });
    expect(d.lines[0]!.struck!.length).toBeGreaterThan(0);
  });
});

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function onPage(content: string, run: (page: pdfjs.PDFPageProxy) => Promise<void>) {
  const task = pdfjs.getDocument({ data: pdf([content]), useSystemFonts: true });
  try { await run(await (await task.promise).getPage(1)); }
  finally { setImmediate(() => void task.destroy().catch(() => {})); await turn(); await turn(); }
}

test("textItems matches getTextContent exactly at the boundary", async () => {
  await onPage(tall(250), async page => {
    const expected = (await page.getTextContent()).items;
    expect(expected).toHaveLength(250); expect(await textItems(page, expected.length)).toEqual(expected);
  });
});
test("textItems refuses one item over room", async () => { await onPage(tall(250), async page => { await refused(textItems(page, 249)); }); });
test.each([[10, 10], [10, 9], [2500, 2500], [2500, 2499], [0, 0]])("drawingList commands %i with room %i", async (n, room) => {
  await onPage(saves(n), async page => {
    if (n > room) await refused(drawingList(page, room));
    else {
      expect((await drawingList(page, room)).fnArray).toHaveLength(n);
      expect((page as any)._renderPageChunk).toBe(Object.getPrototypeOf(page)._renderPageChunk);
    }
  });
});
test("a refused drawing list stops retaining chunks", async () => {
  await onPage(saves(5000), async page => {
    await refused(drawingList(page, 2000));
    for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect([...(page as any)._intentStates.values()][0].operatorList.fnArray.length).toBeLessThanOrEqual(2000);
  });
});
test.each([0, 100000000 - 4, 100000000 - 3])("column work with %i already spent", columns => {
  const rows = Array.from({ length: 2 }, () => [{ x: 10, end: 20, size: 8, s: "a" }, { x: 200, end: 210, size: 8, s: "a" }]);
  const spent = { columns };
  if (columns === 100000000 - 3) { expect(() => pdfReadingOrder(rows, spent)).toThrow(UnsupportedDocumentError); expect(() => pdfReadingOrder(rows, { columns })).toThrow(FILE_TOO_LARGE); }
  else { pdfReadingOrder(rows, spent); expect(spent.columns).toBe(columns + 4); }
});

describe("refused streams never end the process", () => {
  async function noRejections(run: () => Promise<void>) {
    const errors: unknown[] = [], listener = (e: unknown) => { errors.push(e); };
    process.on("unhandledRejection", listener);
    try { await run(); await turn(); await turn(); expect(errors).toEqual([]); }
    finally { process.removeListener("unhandledRejection", listener); }
  }
  for (const method of ["text", "drawing"] as const) {
    test.each([50, 101, 1000, 1001, 5000, 20000].flatMap(n => [0, 50, 100, 101, 1000].map(room => ({ n, room }))))(`${method} n=$n room=$room`, async ({ n, room }) => {
      await noRejections(async () => onPage(method === "text" ? tall(n) : saves(n), async page => {
        // saves(n) writes whole pairs, so an odd n gives n - 1 commands.
        const count = method === "text" ? n : Math.floor(n / 2) * 2;
        const p = method === "text" ? textItems(page, room) : drawingList(page, room);
        if (count > room) await refused(p);
        else { const result = await p; expect(Array.isArray(result) ? result.length : result.fnArray.length).toBe(count); }
      }));
    });
  }
  test("text refusals across final and intermediate chunks", async () => {
    await noRejections(async () => {
      for (const [n, room] of [[5000, 100], [2100, 2000], [200000, 100]]) await onPage(tall(n!), async page => { await refused(textItems(page, room!)); });
    });
  }, LONG);
  test("200 sequential text refusals keep the heap within 100 MB", async () => {
    await noRejections(async () => {
      let baseline = 0;
      for (let i = 0; i < 200; i++) {
        await onPage(tall(20000), async page => { await refused(textItems(page, 100)); });
        collect();
        if (i === 9) baseline = process.memoryUsage().heapUsed;
      }
      expect(process.memoryUsage().heapUsed - baseline).toBeLessThanOrEqual(100 * 1024 * 1024);
    });
  }, LONG);
  test("three items remain readable after refusals", async () => {
    await noRejections(async () => onPage(tall(3), async page => { expect(await textItems(page, 3)).toHaveLength(3); }));
  });
});

test("pdfRowKey matches the old insertion-order search", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pools: (() => number)[] = [
    () => Math.round(rnd() * 40), () => Math.round(rnd() * 400), () => Math.round(rnd() * 8) * 3,
    () => { const r = rnd(); return r < 0.05 ? NaN : r < 0.1 ? Infinity : r < 0.15 ? -Infinity : r < 0.2 ? -0 : Math.round(rnd() * 12 - 6); },
    () => 2 ** 53 + Math.round(rnd() * 8) * 2, () => 2 ** 54 + Math.round(rnd() * 8) * 4,
    () => 1e300 * (rnd() < 0.5 ? 1 : 1.0000000000000002), () => Math.round(-rnd() * 30),
  ];
  const zero = (n: number) => n === 0 ? 0 : n;
  for (let round = 0; round < 4000; round++) {
    const old = new Map<number, number>(), started = new Map<number, number>(), pool = pools[round % pools.length]!;
    for (let i = 0; i < 60; i++) {
      const y = pool(), expected = [...old.keys()].find(k => Math.abs(k - y) <= 2) ?? y;
      expect(Object.is(zero(pdfRowKey(started, y)), zero(expected))).toBe(true);
      if (!old.has(expected)) old.set(expected, old.size);
    }
    expect([...started.keys()].map(zero)).toEqual([...old.keys()].map(zero));
  }
});
