import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFDict, PDFName, StandardFonts, type PDFFont } from "pdf-lib";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest, type WorkerDeps } from "@agir/worker";
import { createApp } from "../src/app.ts";

type Map = (byte: number) => number;
const hex = (c: number, n = 2) => c.toString(16).padStart(n, "0").toUpperCase();
function cmap(map: Map) {
  const bytes = Array.from({ length: 224 }, (_, i) => i + 32);
  const blocks = Array.from({ length: Math.ceil(bytes.length / 100) }, (_, b) => bytes.slice(b * 100, b * 100 + 100));
  return "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /X def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n" +
    blocks.map(part => part.length + " beginbfchar\n" + part.map(c => "<" + hex(c) + "> <" + hex(map(c), 4) + ">").join("\n") + "\nendbfchar\n").join("") +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
}
async function pdf(pages: { text: string; map?: Map }[][]) {
  const doc = await PDFDocument.create();
  const plain = await doc.embedFont(StandardFonts.Helvetica);
  const fonts = new globalThis.Map<Map, PDFFont>();
  for (const rows of pages) {
    const p = doc.addPage([612, 792]);
    for (const [i, row] of rows.entries()) {
      let font = plain;
      if (row.map) { font = fonts.get(row.map) ?? await doc.embedFont(StandardFonts.HelveticaBold); fonts.set(row.map, font); }
      p.drawText(row.text, { x: 50, y: 740 - i * 22, size: 13, font });
    }
  }
  for (const [map, font] of fonts) {
    await font.embed();
    doc.context.lookup(font.ref, PDFDict).set(PDFName.of("ToUnicode"), doc.context.register(doc.context.stream(cmap(map))));
  }
  return new Uint8Array(await doc.save());
}
const shift: Map = b => 0xf000 + b, junk: Map = () => 1;
const budget = ["Land cost 1,025,000", ...Array.from({ length: 22 }, (_, i) => `Budget row ${i + 1} amount 2,000`)];
const rows = (map?: Map) => budget.map(text => ({ text, map }));

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-readable-pages-")));
beforeAll(async () => {
  db = await openPglite(); await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email: "readable@example.com", name: "Readable tests", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });
async function call(method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", ...(body ? { "content-type": "application/json" } : {}) },
    body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
async function upload(bytes: Uint8Array) {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Invented readable deal", assetType: "Multifamily" })).id;
  await call("PUT", `/api/deals/${deal}/documents?name=invented.pdf`, undefined, bytes);
  return deal;
}
const docs = (id: string) => call("GET", `/api/deals/${id}/documents`);
const fakeOcr: NonNullable<WorkerDeps["ocr"]> = async (_bytes, pages) => ({
  pages: (pages ?? [1]).map(page => ({ page, lines: [{ text: budget[0]!, confidence: 95 }] })), failed: [],
});
const fakeRead = () => vi.fn(async (_request: ReaderRequest) => ({ readings: [], conflicts: [], not_used: [] }));
test.each(["jbig2", "jpx"])("uploads invented %s scan with real recognition and a fake reader", async format => {
  const bytes = new Uint8Array(await readFile(new URL(`../../../packages/extraction/test/fixtures/scan-${format}.pdf`, import.meta.url)));
  const deal = await upload(bytes), read = fakeRead();
  await drain({ db, store, read });
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted",
    stage_detail: "Read by OCR from 1 scanned page. Check every value against the page before approving it." });
  expect(read.mock.calls[0]![0].messages[0]!.content).toContain(budget[0]);
}, 60_000);
test("sends only the undecodable second page to OCR", async () => {
  const deal = await upload(await pdf([rows(), rows(junk)]));
  const ocr = vi.fn(fakeOcr), read = fakeRead();
  await drain({ db, store, ocr, read });
  expect(ocr).toHaveBeenCalledTimes(1);
  expect(ocr.mock.calls[0]![1]).toEqual([2]);
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted",
    stage_detail: "1 of 2 pages in this PDF is a picture.\nAgir read text from it by OCR. Check every value read that way against the page before approving it." });
});
test("sends decoded shifted text to the reader without OCR", async () => {
  const deal = await upload(await pdf([rows(shift)]));
  const ocr = vi.fn(fakeOcr), read = fakeRead();
  await drain({ db, store, ocr, read });
  expect(ocr).not.toHaveBeenCalled();
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: null });
  expect(read.mock.calls[0]![0].messages[0]!.content).toContain(budget[0]);
});
