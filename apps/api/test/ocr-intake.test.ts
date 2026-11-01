import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, reconcileDeal, type ReaderRequest, type WorkerDeps } from "@agir/worker";
import { parseSavedOcr } from "@agir/extraction";
import { loadDocument } from "../../worker/src/reader.ts";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-picture-test-")));
beforeAll(async () => {
  db = await openPglite(); await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "pictures@example.com", name: "Picture tests", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });
async function call(method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", ...(body ? { "content-type": "application/json" } : {}) }, body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
async function pdf(mixed = true, blank = false, picturePages = 1) {
  const doc = await PDFDocument.create();
  if (mixed) doc.addPage([612, 792]).drawText("Land cost $400,000", { x: 72, y: 700, size: 16 });
  const canvas = createCanvas(1700, 2200), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1700, 2200);
  ctx.fillStyle = "black"; ctx.font = "40px sans-serif";
  ctx.fillText("Exit cap rate 5.5%", 100, 160);
  ctx.fillText("Contact test@example.com", 100, 250);
  const img = await doc.embedJpg(canvas.toBuffer("image/jpeg", 90));
  for (let i = 0; i < picturePages; i++) {
    const page = doc.addPage([612, 792]);
    if (!blank) page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  }
  return doc.save();
}
async function upload(bytes: Uint8Array, name = "picture.pdf") {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Invented picture deal", assetType: "Multifamily" })).id;
  const document = await call("PUT", `/api/deals/${deal}/documents?name=${encodeURIComponent(name)}`, undefined, bytes);
  return { deal, document };
}
const docs = (id: string) => call("GET", `/api/deals/${id}/documents`);
const review = (id: string) => call("GET", `/api/deals/${id}/review`);
const mixedDetail = "1 of 2 pages in this PDF is a picture.\nAgir read text from it by OCR. Check every value read that way against the page before approving it.";
const fakeOcr: NonNullable<WorkerDeps["ocr"]> = async (_bytes, pages) => ({ pages: (pages ?? [1]).map(page => ({ page, lines: [{ text: "Exit cap rate 5.5%", confidence: 95 }, { text: "Contact test@example.com", confidence: 95 }] })), failed: [] });
test("real mixed OCR reaches Review, saved once on retry, AI redaction, source replay and rule-read copy", async () => {
  const { deal } = await upload(await pdf());
  const putOcr = vi.fn(store.putOcr.bind(store));
  const wrapped = { ...store, putOcr };
  const read = vi.fn(async (_request: ReaderRequest) => ({ readings: [{ field: "exit_cap_rate_pct", item: null, value: 5.5, unit_seen: "%" as const, file: "picture.pdf", location: "page 2, line 1", quote: "Exit cap rate 5.5%", note: null, confidence: "high" as const }], conflicts: [], not_used: [] }));
  await drain({ db, store: wrapped, read });
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: mixedDetail });
  const request = read.mock.calls[0]![0].messages[0]!.content;
  expect(request).toContain("Exit cap rate 5.5%"); expect(request).not.toContain("test@example.com"); expect(request).toContain("[redacted email]");
  const check = async (id: string) => {
    const assumptions = (await review(id)).assumptions;
    const picture = assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    expect(picture.value).toBe(5.5); expect(picture.sources[0].ocr).toBe(true);
    expect(picture.sources.some((s: any) => s.rule === "ai" && s.ocr)).toBe(true);
    expect(assumptions.find((a: any) => a.fieldKey === "land_cost").sources[0].ocr).toBeUndefined();
  };
  await check(deal); await reconcileDeal(db, store, deal); await check(deal);
  const [row] = await db.query<any>(`select id from documents where deal_id=$1`, [deal]);
  await db.query(`insert into jobs (kind,payload) values ('extract_document',$1)`, [JSON.stringify({ document_id: row.id })]);
  await drain({ db, store: wrapped, read }); expect(putOcr).toHaveBeenCalledTimes(1);
  const copy = await call("POST", `/api/deals/${deal}/copy`, { name: "Picture copy" });
  await drain({ db, store, read }); await reconcileDeal(db, store, copy.id);
  const picture = (await review(copy.id)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
  expect(picture.value).toBe(5.5);
  expect(picture.sources.some((s: any) => s.rule !== "ai" && s.ocr === true)).toBe(true);
  // The deal-copy card restores the AI source assertion.
  const [sourceDoc] = await db.query<any>(`select storage_key from documents where deal_id=$1`, [deal]);
  const [copyDoc] = await db.query<any>(`select storage_key from documents where deal_id=$1`, [copy.id]);
  expect(await store.getOcr(copyDoc.storage_key)).toEqual(await store.getOcr(sourceDoc.storage_key));
}, 60_000);
test.each([true, false])("engine unavailable on mixed=%s", async mixed => {
  const { deal } = await upload(await pdf(mixed));
  // Ignore any shared sidecar to exercise the engine failure.
  const noSaved = { ...store, getOcr: async () => null, putOcr: vi.fn() };
  const log = vi.fn();
  await drain({ db, store: noSaved, log, ocr: async () => { throw new Error("OCR is not available on this machine"); } });
  const doc = (await docs(deal))[0];
  expect(doc.stage).toBe(mixed ? "extracted" : "read_failed");
  expect(doc.stage_detail).toBe(mixed ? "1 of 2 pages in this PDF is a picture.\nOCR is not available on this machine, so they were not read." : "This PDF is scanned pages with no text layer, and OCR is not available on this machine. Enter its values by hand, or upload a text PDF.");
  expect(noSaved.putOcr).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith({ event: "ocr.unavailable", document_id: doc.id, message: "OCR is not available on this machine" });
  if (mixed) expect((await review(deal)).assumptions.some((a: any) => a.fieldKey === "land_cost")).toBe(true);
});
test("OCR retry reads only failed pages and retains both pages on Review", async () => {
  const { deal } = await upload(await pdf(true, false, 2));
  const wrapped = { ...store, getOcr: vi.fn(store.getOcr.bind(store)), putOcr: vi.fn(store.putOcr.bind(store)) };
  wrapped.getOcr.mockResolvedValueOnce(null);
  const first = { page: 2, lines: [{ text: "Exit cap rate 5.5%", confidence: 95 }] };
  const next = { page: 3, lines: [{ text: "Interest rate 6.1%", confidence: 95 }] };
  const ocr = vi.fn<NonNullable<WorkerDeps["ocr"]>>()
    .mockResolvedValueOnce({ pages: [first], failed: [3] })
    .mockResolvedValueOnce({ pages: [next], failed: [] });
  const read = vi.fn(async () => ({ readings: [], conflicts: [], not_used: [] }));
  await drain({ db, store: wrapped, ocr, read });
  const [row] = await db.query<any>(`select id,storage_key from documents where deal_id=$1`, [deal]);
  const retry = async () => {
    await db.query(`insert into jobs (kind,payload) values ('extract_document',$1)`, [JSON.stringify({ document_id: row.id })]);
    await drain({ db, store: wrapped, ocr, read });
  };
  await retry();
  expect(ocr.mock.calls.map(call => call[1])).toEqual([[2, 3], [3]]);
  expect(parseSavedOcr(await store.getOcr(row.storage_key))).toEqual({ version: 1, pages: [first, next], failed: [], notRead: [] });
  const assumptions = (await review(deal)).assumptions;
  for (const [field, value, page] of [["exit_cap_rate_pct", 5.5, 2], ["senior_rate_pct", 6.1, 3]] as const) {
    const assumption = assumptions.find((a: any) => a.fieldKey === field);
    expect(assumption.value).toBe(value);
    expect(assumption.sources.some((s: any) => s.ocr && s.location.startsWith(`page ${page},`))).toBe(true);
  }
  ocr.mockClear();
  await retry();
  expect(ocr).not.toHaveBeenCalled();
  expect(wrapped.putOcr).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
});
test.each([true, false])("OCR retry failure preserves saved text for rules and loadDocument on mixed=%s", async mixed => {
  const { deal } = await upload(await pdf(mixed, false, mixed ? 2 : 3));
  const wrapped = { ...store, getOcr: vi.fn(store.getOcr.bind(store)), putOcr: vi.fn(store.putOcr.bind(store)) };
  wrapped.getOcr.mockResolvedValueOnce(null);
  const ocr = vi.fn<NonNullable<WorkerDeps["ocr"]>>()
    .mockResolvedValueOnce({ pages: [{ page: 2, lines: [{ text: "Exit cap rate 5.5%", confidence: 95 }] }], failed: [3] })
    .mockRejectedValueOnce(new Error("engine stopped"));
  await drain({ db, store: wrapped, ocr });
  const [row] = await db.query<any>(`select id,storage_key from documents where deal_id=$1`, [deal]);
  const saved = await store.getOcr(row.storage_key);
  await db.query(`insert into jobs (kind,payload) values ('extract_document',$1)`, [JSON.stringify({ document_id: row.id })]);
  await drain({ db, store: wrapped, ocr });
  expect(await store.getOcr(row.storage_key)).toEqual(saved);
  expect(wrapped.putOcr).toHaveBeenCalledTimes(1);
  expect((await loadDocument(store, row.storage_key, "picture.pdf")).lines).toContainEqual({ text: "Exit cap rate 5.5%", location: "page 2, line 1 (OCR, confidence 95%)" });
  const doc = (await docs(deal))[0];
  expect(doc.stage).toBe("extracted");
  expect(doc.stage_detail).not.toContain("OCR is not available");
  if (mixed) expect(doc.stage_detail).toContain("1 page could not be read. Retry the file to try again.");
  else expect(doc.stage_detail).toContain("Read by OCR from 1 of 3 scanned pages");
  const picture = (await review(deal)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
  expect(picture?.value).toBe(5.5);
  expect(picture.sources.some((s: any) => s.rule !== "ai" && s.ocr)).toBe(true);
});
test("blank PDF has a no-readable-text explanation", async () => {
  const { deal } = await upload(await pdf(false, true));
  await drain({ db, store, ocr: async () => ({ pages: [{ page: 1, lines: [] }], failed: [] }) });
  expect((await docs(deal))[0]).toMatchObject({ stage: "read_failed", stage_detail: "Agir found no readable text on the scanned pages of this PDF. Enter its values by hand, or upload a clearer copy." });
});
test("mixed limit and failures are reported without losing text", async () => {
  const { deal } = await upload(await pdf(true, false, 52));
  const ocr = vi.fn<NonNullable<WorkerDeps["ocr"]>>(async (_bytes, pages) => ({ pages: [{ page: pages![0]!, lines: [{ text: "Exit cap rate 5.5%", confidence: 90 }] }], failed: pages!.slice(1) }));
  await drain({ db, store, ocr });
  expect(ocr.mock.calls[0]![1]).toEqual(Array.from({ length: 50 }, (_, i) => i + 2));
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: "52 of 53 pages in this PDF are pictures.\nAgir read text from 1 of them by OCR. Check every value read that way against the page before approving it.\nAgir reads the first 50 picture pages of a PDF, so 2 pages were not read.\n49 pages could not be read. Retry the file to try again." });
});
test("lease renews during a slow injected reading and clears afterwards", async () => {
  const { deal } = await upload(await pdf());
  let observed = false;
  await drain({ db, store, ocr: fakeOcr, leaseRenewMs: 50, read: async () => {
    const [before] = await db.query<any>(`select id,lease_until from jobs where status='running'`);
    await new Promise(resolve => setTimeout(resolve, 180));
    const [after] = await db.query<any>(`select lease_until from jobs where id=$1`, [before.id]);
    expect(new Date(after.lease_until).getTime()).toBeGreaterThan(new Date(before.lease_until).getTime()); observed = true;
    return { readings: [], conflicts: [], not_used: [] };
  } });
  expect(observed).toBe(true);
  expect(await db.query(`select id from jobs where lease_until is not null`)).toEqual([]);
  expect((await docs(deal))[0].stage).toBe("extracted");
});
test("locked PDF explains how to remove the password", async () => {
  const bytes = Buffer.from("JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPGJhZWQxYWIxODQxNDFmOWM2OTI1YTM2MjM3OWVkODAyZDI2YzhkMTMxNzZmOTdjYzgyOGQzMzE5OWIzZjgyMmI+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCAyMDAgMjAwIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViA1Ci9SIDYKL0xlbmd0aCAyNTYKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8ZGM0Y2UzNjY3ZDUzOTMxNDcwYTM0OTRkNjU0NTZlYzIyMmZjMzg1Mzk1MDljNmE3ZTZhN2IyODk0ZmU1ZTMzYjJhNjIyZjFlMWRhYTY1ZWU4ZDA1NzEwMmJiZjAxZDI3PgovVSA8NGRlMjYzZDg0ZWMyYTcyYWRiZDkzMGJlNTBhNWU1ODkyOWQxOTcxZjc5NjlkYWFiMmU2ODlkMjY0YWYwOWZiYjZmNzE2NzZmMDBhYmE1MDFjOTU1ZWE2NmQwMDU3MWNlPgovQ0YgPDwKL1N0ZENGIDw8Ci9BdXRoRXZlbnQgL0RvY09wZW4KL0NGTSAvQUVTVjMKL0xlbmd0aCAzMgo+Pgo+PgovU3RtRiAvU3RkQ0YKL1N0ckYgL1N0ZENGCi9PRSA8NTQzMzFiYjQzMWI5YWZiZDA3NDNmMzcxOGZkMDhhODM5NGQxMDgxNWMzMzczZmVkNTNiYmU4Zjg3ZGY2MmMzNj4KL1VFIDw5NDY3YjNiODk0ZjNlNjVhOTVlMTgxNjYwZjgwMjI1MjVmZmM4OTY0ZmEwYTM0ZTIzZTUwN2RkODc3ZjA4YTI5PgovUGVybXMgPDBiNjU2NTA5ZjBkNzAwYzIwMWFjZGU0M2UxYmE1NTZhPgo+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAxMTMgMDAwMDAgbiAKMDAwMDAwMDE3MiAwMDAwMCBuIAowMDAwMDAwMjIxIDAwMDAwIG4gCjAwMDAwMDAzMTUgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDwzNTM5NjMzMjMwNjI2MjYxNjU2MzM4MzI2NTMxNjIzNTYzMzYzMzYzNjE2MjY1NjYzNTYxNjY2MTY1NjYzMTMxPiA8MzUzOTYzMzIzMDYyNjI2MTY1NjMzODMyNjUzMTYyMzU2MzM2MzM2MzYxNjI2NTY2MzU2MTY2NjE2NTY2MzEzMT4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKODcwCiUlRU9GCg==", "base64");
  const { deal } = await upload(bytes); await drain({ db, store });
  expect((await docs(deal))[0]).toMatchObject({ stage: "read_failed", stage_detail: "This PDF is protected by a password. Remove the password and upload it again." });
});

// Card 181: pictures use the same saved OCR, reader and redaction path as PDF pages.
const imageRead = "Read by OCR from this picture. Check every value against the picture before approving it.";
const imageDamaged = "Agir could not open this picture. It may be damaged. Upload it again, or save it as a PDF.";
function imageBytes(format: "png" | "jpeg" = "png") {
  const canvas = createCanvas(816, 1056), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 816, 1056); ctx.fillStyle = "black"; ctx.font = "32px sans-serif";
  ctx.fillText("Exit cap rate 5.5%", 55, 140); ctx.fillText("Contact test@example.com", 55, 210);
  return format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg");
}
test("real PNG upload, OCR provenance, saved text and fake AI reader", async () => {
  const { deal } = await upload(imageBytes(), "picture.png");
  const read = vi.fn(async (_request: ReaderRequest) => ({ readings: [], conflicts: [], not_used: [] }));
  await drain({ db, store, read });
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: imageRead, needs_ocr: true });
  expect(read.mock.calls[0]![0].messages[0]!.content).toContain("Exit cap rate 5.5%");
  const figure = (await review(deal)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
  expect(figure.value).toBe(5.5); expect(figure.sources[0].ocr).toBe(true);
  const [row] = await db.query<any>(`select storage_key from documents where deal_id=$1`, [deal]);
  expect((await loadDocument(store, row.storage_key, "picture.png")).fullText).toContain("5.5%");
  const [m] = await db.query<any>(`select docs_image from deal_metrics where deal_id=$1`, [deal]);
  expect(m.docs_image).toBe(1);
  const totals = await call("GET", `/api/workspaces/${ws}/deal-metrics`);
  expect(totals.deals.find((d: any) => d.deal_id === deal).docs_image).toBe(1);
  expect(totals.totals.docs_image).toBeGreaterThanOrEqual(1);
}, 60_000);
test.each(["jpg", "tiff"])("fake OCR %s saves once across retries and redacts before AI", async ext => {
  const { tiffBytes } = await import("@agir/testkit");
  const bytes = ext === "jpg" ? imageBytes("jpeg") : tiffBytes(2, 2, new Uint8Array(4));
  const { deal, document } = await upload(bytes, `picture.${ext}`);
  const ocr = vi.fn(fakeOcr), read = vi.fn(async (_request: ReaderRequest) => ({ readings: [], conflicts: [], not_used: [] }));
  await drain({ db, store, ocr, read });
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: imageRead, needs_ocr: true });
  const text = read.mock.calls[0]![0].messages[0]!.content;
  expect(text).toContain("5.5%"); expect(text).toContain("[redacted email]"); expect(text).not.toContain("test@example.com");
  for (let n = 0; n < 2; n++) {
    await db.query(`insert into jobs (kind,payload) values ('extract_document',$1)`, [JSON.stringify({ document_id: document.id })]);
    await drain({ db, store, ocr, read });
  }
  expect(ocr).toHaveBeenCalledTimes(1);
});
test.each([
  ["missing", "This file is a picture, and OCR is not available on this machine. Enter its values by hand, or upload a text PDF."],
  ["empty", "Agir found no readable text in this picture. Enter its values by hand, or upload a clearer copy."],
  ["failed", imageDamaged],
])("picture OCR %s explains read_failed", async (mode, message) => {
  const { deal } = await upload(imageBytes(), "picture.png");
  const noSaved = { ...store, getOcr: async () => null };
  await drain({ db, store: noSaved, ocr: async () => {
    if (mode === "missing") throw new Error("OCR is not available on this machine");
    return mode === "empty" ? { pages: [{ page: 1, lines: [] }], failed: [] } : { pages: [], failed: [1] };
  } });
  expect((await docs(deal))[0]).toMatchObject({ stage: "read_failed", stage_detail: message, needs_ocr: true });
});
test("image signatures, mismatched extensions, damaged PNG and multipage TIFF", async () => {
  const { tiffBytes } = await import("@agir/testkit");
  for (const [bytes, name, stage, detail] of [
    [await pdf(), "fake.png", "rejected", "The file does not start like an image"],
    [imageBytes(), "png.jpg", "extracted", imageRead],
    [imageBytes().subarray(0, -20), "cut.png", "read_failed", imageDamaged],
    [tiffBytes(1, 1, new Uint8Array(1), { pages: 2 }), "multi.tif", "read_failed", "This TIFF has 2 pages. Save it as a PDF, then upload that."],
  ] as const) {
    const { deal } = await upload(bytes, name); await drain({ db, store: { ...store, getOcr: async () => null }, ocr: fakeOcr });
    expect((await docs(deal))[0]).toMatchObject({ stage, stage_detail: detail });
  }
});
test.each([
  ["heic", "Agir cannot read HEIC photos. Export the photo as JPEG, then upload it."],
  ["heif", "Agir cannot read HEIC photos. Export the photo as JPEG, then upload it."],
  ["xls", "Agir reads Excel files saved as .xlsx. Open this one in Excel, save it as .xlsx, then upload it."],
  ["doc", "Agir reads Word files saved as .docx. Open this one in Word, save it as .docx, then upload it."],
  ["ppt", "Agir does not read PowerPoint files. Save this one as a PDF, then upload that."],
  ["pptx", "Agir does not read PowerPoint files. Save this one as a PDF, then upload that."],
  ["zip", "Upload a PDF, Excel (.xlsx), CSV, Word (.docx), text file, or a picture (PNG, JPEG or TIFF)."],
])("upload route refusal for %s", async (ext, message) => {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Refused format", assetType: "Multifamily" })).id;
  const res = await app.request(`/api/deals/${deal}/documents?name=file.${ext.toUpperCase()}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new Uint8Array(imageBytes()) });
  expect(res.status).toBe(415); expect(await res.json()).toEqual({ error: message });
});
test("uncached Excel formulas appear on the document row", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook(); const sheet = wb.addWorksheet("Values"); sheet.getCell("A1").value = { formula: "1+2" };
  const { deal } = await upload(new Uint8Array(await wb.xlsx.writeBuffer()), "formula.xlsx");
  await drain({ db, store });
  expect((await docs(deal))[0]).toMatchObject({ stage: "extracted", stage_detail: "This workbook has formulas with no saved results (A1). Open and save it in Excel to include them." });
});
test("logo keeps strict JPEG ending validation", async () => {
  const jpeg = imageBytes("jpeg");
  for (const [bytes, status] of [[jpeg, 200], [Buffer.concat([jpeg, Buffer.from("trailing")]), 422]] as const) {
    const res = await app.request(`/api/workspaces/${ws}/logo`, { method: "POST", headers: { cookie, "x-agir": "1" }, body: new Uint8Array(bytes) });
    expect(res.status).toBe(status);
  }
});
