import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { fileStore, migrate, openPglite, sha256Hex, type Db } from "@agir/db";
import { drain, reconcileDeal, type ReaderRequest, type WorkerDeps } from "@agir/worker";
import { addressedText, redactDocument, type ReaderResponse } from "@agir/extraction";
import { loadDocument } from "../../worker/src/reader.ts";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-every-file-")));
const quote = "The owners picture a buyer paying a 5.5% yield on the way out.";
const badPdf = "%PDF-1.4\nnot a pdf\n";
const empty = (): ReaderResponse => ({ readings: [], conflicts: [], not_used: [] });
const answer = (): ReaderResponse => ({ ...empty(), readings: [{ field: "exit_cap_rate_pct", item: null, value: 5.5, unit_seen: "%", file: "notes.txt", location: "line 1", quote, note: null, confidence: "high" }] });
const reader = () => vi.fn(async (_request: ReaderRequest) => answer());
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const deal = async () => (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Every file", assetType: "Multifamily" })).id as string;
const review = (id: string) => call("GET", `/api/deals/${id}/review`);
const rows = (id: string) => db.query<any>(`select * from ai_readings where deal_id=$1 order by created_at desc,id desc`, [id]);
const figure = async (id: string) => (await review(id)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
async function upload(id: string, name: string, text: string | Uint8Array) {
  const res = await app.request(`/api/deals/${id}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: typeof text === "string" ? new TextEncoder().encode(text) : new Uint8Array(text) });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
const queue = (kind: string, payload: Record<string, string>) => db.query(`insert into jobs(kind,payload) values($1,$2)`, [kind, JSON.stringify(payload)]);
const retry = (document: string) => queue("extract_document", { document_id: document });
const unreadJob = (id: string) => queue("read_deal", { deal_id: id, only_unread: "true" });
const held = (id: string) => db.query<any>(`select id,run_after from jobs where kind='reconcile_deal' and status='queued' and payload->>'deal_id'=$1 and run_after>now()`, [id]);
async function setup() {
  const id = await deal(), document = await upload(id, "notes.txt", quote), read = reader();
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  return { id, document, read };
}
async function deadFile(id: string) {
  const document = await upload(id, "two.txt", "A second document with further information.");
  const [d] = await db.query<any>(`select storage_key from documents where id=$1`, [document]);
  let gets = 0;
  const broken = { ...store, get: async (key: string) => {
    if (key === d.storage_key && ++gets > 1) throw new Error("fake store unavailable");
    return store.get(key);
  } };
  return { document, broken };
}
async function kill(deps: WorkerDeps) {
  await drain(deps);
  await db.query(`update jobs set attempts=max_attempts, run_after=now() where kind='extract_document' and status='queued'`);
  await drain(deps);
}
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "every@example.com", name: "Every", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test.each([
  { names: ["notes.txt", "bad.pdf"] },
  { names: ["bad.pdf", "notes.txt"] },
  { names: ["bad.pdf", "notes.txt", "bad2.pdf"] },
])("damaged files in order $names allow exactly one reading", async ({ names }) => {
  const id = await deal(), read = reader();
  for (const name of names) await upload(id, name, name === "notes.txt" ? quote : badPdf + (name === "bad2.pdf" ? "second" : ""));
  await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect((await rows(id))[0].outcome).toBe("ok");
  expect(await figure(id)).toMatchObject({ value: 5.5, status: "needs_review" });
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("removal recovers an older deal without a reading", async () => {
  const id = await deal(), read = reader();
  await upload(id, "notes.txt", quote); const bad = await upload(id, "bad.pdf", badPdf);
  await drain({ db, store, read }); await db.query(`delete from ai_readings where deal_id=$1`, [id]); read.mockClear();
  await call("POST", `/api/documents/${bad}/retire`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect(await figure(id)).toMatchObject({ value: 5.5 });
});
test("dead extraction leaves the other document read", async () => {
  const id = await deal(); await upload(id, "notes.txt", quote);
  const { document, broken } = await deadFile(id), read = reader();
  await kill({ db, store: broken, read });
  expect(await db.query(`select stage from documents where id=$1`, [document])).toEqual([{ stage: "read_failed" }]);
  expect(read).toHaveBeenCalledTimes(1); expect(await figure(id)).toMatchObject({ value: 5.5 });
});
test("a check rejection finishing after extraction starts a reading", async () => {
  const id = await deal(), read = reader(); await upload(id, "notes.txt", quote);
  await drain({ db, store, read }, 1); await upload(id, "fake.pdf", "plain text");
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("retiring a file still in reading reads the other file", async () => {
  const id = await deal(), read = reader(); await upload(id, "notes.txt", quote);
  const { document, broken } = await deadFile(id);
  await drain({ db, store: broken, read }); expect(read).not.toHaveBeenCalled();
  await call("POST", `/api/documents/${document}/retire`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1);
  await db.query(`update jobs set run_after=now() where status='queued' and payload->>'document_id'=$1`, [document]);
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("adding a damaged file and removing files preserve a reading without calls", async () => {
  const { id, document, read } = await setup(); const before = await figure(id);
  const bad = await upload(id, "bad.pdf", badPdf); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect(await figure(id)).toEqual(before);
  await call("POST", `/api/documents/${bad}/retire`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect(await figure(id)).toEqual(before);
  await call("POST", `/api/documents/${document}/retire`); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("removing an extracted file leaves the other figure and costs no reading", async () => {
  const { id, read } = await setup(); const extra = await upload(id, "extra.txt", "Nothing further.");
  await drain({ db, store, read }); const before = await figure(id); read.mockClear();
  await call("POST", `/api/documents/${extra}/retire`); await drain({ db, store, read });
  expect(read).not.toHaveBeenCalled(); expect(await figure(id)).toEqual(before);
});
test("a covered extraction and an only_unread no-op leave another held reconcile alone", async () => {
  const { id, document, read } = await setup(); await retry(document); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  await db.query(`insert into jobs(kind,payload,run_after) values('reconcile_deal',$1,now()+interval '600 seconds')`, [JSON.stringify({ deal_id: id })]);
  const before = await held(id);
  const reconciles = () => db.query(`select id from jobs where kind='reconcile_deal' and payload->>'deal_id'=$1 order by id`, [id]);
  const jobsBefore = await reconciles();
  await unreadJob(id); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect(await held(id)).toEqual(before); expect(await reconciles()).toEqual(jobsBefore);
  await db.query(`update jobs set run_after=now() where id=$1`, [before[0].id]); await drain({ db, store, read });
});
test.each([false, true])("only_unread holds reconciliation during reading and releases it, failure=%s", async failure => {
  const id = await deal(); await upload(id, "notes.txt", quote); await drain({ db, store });
  const observed: number[] = [];
  const read = vi.fn(async () => { observed.push((await held(id)).length); if (failure) throw new Error("fake failure"); return answer(); });
  await unreadJob(id); await drain({ db, store, read });
  expect(observed).toEqual(failure ? [1, 1] : [1]); expect(await held(id)).toEqual([]);
  expect((await rows(id))[0].outcome).toBe(failure ? "failed" : "ok");
});
test.each(["off", "no provider"])("settling a damaged file with %s makes no call", async mode => {
  const id = await deal(), read = reader();
  if (mode === "off") await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: false });
  try {
    await upload(id, "notes.txt", quote); await upload(id, "bad.pdf", badPdf);
    await drain({ db, store, ...(mode === "off" ? { read } : {}) });
    expect(read).not.toHaveBeenCalled(); expect(await rows(id)).toEqual([]);
  } finally { if (mode === "off") await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: true }); }
});
async function narrowReading() {
  const id = await deal(), { document, broken } = await deadFile(id);
  await kill({ db, store: broken }); await upload(id, "notes.txt", quote);
  const read = reader(); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  return { id, document, read, old: (await rows(id))[0] };
}
test("a successful retry widens coverage, preserves the earlier figure and copies both readings", async () => {
  const { id, document, old } = await narrowReading();
  const read = vi.fn(async (_request: ReaderRequest) => empty());
  await call("POST", `/api/documents/${document}/retry`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1);
  for (const name of ["notes.txt", "two.txt"]) expect(read.mock.calls[0]![0].messages[0]!.content).toContain(name);
  const saved = await rows(id); expect(saved).toHaveLength(2);
  expect(saved.find(r => r.id === old.id).documents_hash).toBe(`${old.documents_hash}:superseded:${old.id}`);
  expect(saved[0].verification.documents.map((d: any) => d.name).sort()).toEqual(["notes.txt", "two.txt"]);
  for (const ref of saved[0].verification.documents) {
    const [d] = await db.query<any>(`select storage_key from documents where id=$1`, [ref.id]);
    expect(ref.text_sha256).toBe(sha256Hex(addressedText(redactDocument(await loadDocument(store, d.storage_key, ref.name)).document, ref.name)));
  }
  expect(await figure(id)).toMatchObject({ value: 5.5, status: "needs_review" });
  const copy = (await call("POST", `/api/deals/${id}/copy`, { name: "Wider copy" })).id;
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  expect(await rows(copy)).toHaveLength(2); expect((await rows(copy)).some(r => r.documents_hash.includes(":superseded:"))).toBe(true);
  expect(await figure(copy)).toMatchObject({ value: 5.5, status: "needs_review" });
});
test("a failed wider retry keeps the ok row unchanged, reports unread, and Read again covers it", async () => {
  const { id, document, old } = await narrowReading();
  const read = vi.fn(async () => { throw new Error("fake failure"); });
  await call("POST", `/api/documents/${document}/retry`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2); expect(await rows(id)).toEqual([old]);
  expect((await review(id)).aiReading).toMatchObject({ outcome: "ok", unread: ["two.txt"] });
  const again = reader(); await call("POST", `/api/deals/${id}/read-again`); await drain({ db, store, read: again });
  expect(again).toHaveBeenCalledTimes(1); expect(again.mock.calls[0]![0].messages[0]!.content).toContain("two.txt");
  expect((await review(id)).aiReading.unread).toEqual([]);
});
test("a non-extracted document retains its coverage through replay and unchanged retry", async () => {
  const { id, document, read } = await setup(); const before = (await rows(id))[0].verification.documents;
  await db.query(`update documents set stage='read_failed' where id=$1`, [document]); await reconcileDeal(db, store, id);
  expect((await rows(id))[0].verification.documents).toEqual(before);
  await retry(document); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test.each(["role_set", "read_role", "person", "null"])("unread background filtering uses %s", async mode => {
  const { id } = await setup(); const doc = await upload(id, "two.txt", "Further information.");
  await drain({ db, store });
  if (mode === "role_set") await db.query(`update documents set role_set='context' where id=$1`, [doc]);
  if (mode === "read_role" || mode === "person") await db.query(`update documents set read_role=$2 where id=$1`, [doc, mode === "person" ? "Other (context, set by a person)" : "Other (context)"]);
  if (mode === "null") await db.query(`update documents set read_role=null where id=$1`, [doc]);
  // Keep a current row that lists just the original document, as on a failed wider retry.
  const { documentsHash, currentDocuments } = await import("@agir/db");
  await db.query(`update ai_readings set documents_hash=$2 where deal_id=$1`, [id, documentsHash(await currentDocuments(db, id))]);
  expect((await review(id)).aiReading.unread).toEqual(mode === "null" ? ["two.txt"] : []);
});
test("OCR recovery changes the sent-text hash once; an unchanged retry costs nothing", async () => {
  const pdf = await PDFDocument.create(), canvas = createCanvas(20, 20);
  const img = await pdf.embedPng(canvas.toBuffer("image/png"));
  for (let n = 0; n < 2; n++) pdf.addPage([100, 100]).drawImage(img, { x: 0, y: 0, width: 100, height: 100 });
  const id = await deal(), document = await upload(id, "picture.pdf", await pdf.save());
  const ocr = vi.fn<NonNullable<WorkerDeps["ocr"]>>()
    .mockResolvedValueOnce({ pages: [{ page: 1, lines: [{ text: "Initial text", confidence: 95 }] }], failed: [2] })
    .mockResolvedValueOnce({ pages: [{ page: 2, lines: [{ text: "Recovered text", confidence: 95 }] }], failed: [] });
  const read = vi.fn(async (_request: ReaderRequest) => empty()); await drain({ db, store, ocr, read });
  const before = (await rows(id))[0].verification.documents[0].text_sha256;
  await retry(document); await drain({ db, store, ocr, read }); expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![0].messages[0]!.content).toContain("Recovered text");
  expect((await rows(id))[0].verification.documents[0].text_sha256).not.toBe(before);
  await retry(document); await drain({ db, store, ocr, read }); expect(read).toHaveBeenCalledTimes(2);
});

test.each(["without text hash", "id only"])("legacy coverage %s avoids a duplicate reading", async mode => {
  const { id, document, read } = await setup();
  const row = (await rows(id))[0];
  const refs = row.verification.documents.map(({ text_sha256, sha256, ...ref }: any) => mode === "id only" ? ref : { ...ref, sha256 });
  await db.query(`update ai_readings set verification=$2 where id=$1`, [row.id, JSON.stringify({ ...row.verification, documents: refs })]);
  await retry(document); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("only_unread uses coverage from any model, prompt and document hash", async () => {
  const { id, read } = await setup();
  await db.query(`update ai_readings set model='old-model',prompt_version='old-prompt',documents_hash='old-hash' where deal_id=$1`, [id]);
  await unreadJob(id); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});
test("byte-hash mismatch is unread, even when the sent-text hash matches", async () => {
  const { id, document, read } = await setup(), row = (await rows(id))[0];
  row.verification.documents[0].sha256 = "different bytes";
  await db.query(`update ai_readings set verification=$2 where id=$1`, [row.id, JSON.stringify(row.verification)]);
  await retry(document); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(2);
});
test("no extracted or only context documents never reach the reader", async () => {
  const id = await deal(), read = reader(); await unreadJob(id); await drain({ db, store, read });
  const doc = await upload(id, "notes.txt", quote);
  await call("POST", `/api/documents/${doc}/role`, { role: "context" });
  await drain({ db, store, read }); await unreadJob(id); await drain({ db, store, read });
  expect(read).not.toHaveBeenCalled(); expect(await rows(id)).toEqual([]); expect(await held(id)).toEqual([]);
});

test.each(["OCR unavailable", "too many pages", "no text"])("a PDF ending with %s still lets the good document be read", async mode => {
  const pdf = await PDFDocument.create();
  for (let n = 0; n < (mode === "too many pages" ? 51 : 1); n++) pdf.addPage([100, 100]);
  const id = await deal(), read = reader(); await upload(id, "notes.txt", quote);
  const document = await upload(id, "picture.pdf", await pdf.save());
  await drain({ db, store, read, ocr: async () => {
    if (mode === "OCR unavailable") throw new Error("OCR is not available on this machine");
    return { pages: [{ page: 1, lines: [] }], failed: [] };
  } });
  expect(await db.query(`select stage from documents where id=$1`, [document])).toEqual([{ stage: "read_failed" }]);
  expect(read).toHaveBeenCalledTimes(1); expect(await figure(id)).toMatchObject({ value: 5.5 });
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
});

test("an outage with several damaged files costs one reading's attempts, and Read again still reads", async () => {
  const id = await deal(); await upload(id, "notes.txt", quote);
  for (const name of ["a.pdf", "b.pdf", "c.pdf"]) await upload(id, name, badPdf + name);
  const read = vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => { throw new Error("fake outage"); });
  await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2);
  expect((await review(id)).aiReading).toMatchObject({ outcome: "failed" });
  const again = reader(); await call("POST", `/api/deals/${id}/read-again`); await drain({ db, store, read: again });
  expect(again).toHaveBeenCalledTimes(1); expect(await figure(id)).toMatchObject({ value: 5.5 });
});

const stopped = (document: string, attempts: string) => db.query(`update jobs set status='running', attempts=${attempts}, lease_until=now() - interval '1 minute' where kind='verify_document' and payload->>'document_id'=$1`, [document]);
const jobOf = async (document: string) => (await db.query<any>(`select status,attempts,last_error,lease_until from jobs where kind='verify_document' and payload->>'document_id'=$1`, [document]))[0];

test("a file that stopped the worker on every attempt is given up on", async () => {
  const id = await deal(), read = reader(), log = vi.fn();
  const document = await upload(id, "notes.txt", quote);
  await stopped(document, "max_attempts");
  await drain({ db, store, read, log });
  expect(await jobOf(document)).toMatchObject({ status: "dead", attempts: 3, last_error: "The worker stopped while running this job, on every attempt", lease_until: null });
  const [d] = await db.query<any>(`select stage,stage_detail from documents where id=$1`, [document]);
  expect(d).toEqual({ stage: "read_failed", stage_detail: "Agir could not process this file after several attempts. Retry it, or upload it again." });
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "job.dead", kind: "verify_document", error: "The worker stopped while running this job, on every attempt" }));
  // It never ran again.
  expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: "job.done", kind: "verify_document" }));
});

test("a file that stopped the worker with attempts left is tried again", async () => {
  const id = await deal(), read = reader(), log = vi.fn();
  const document = await upload(id, "notes.txt", quote);
  await stopped(document, "1");
  await drain({ db, store, read, log });
  expect(await jobOf(document)).toMatchObject({ status: "done", attempts: 2 });
  const [d] = await db.query<any>(`select stage from documents where id=$1`, [document]);
  expect(d.stage).toBe("extracted");
  expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: "job.dead" }));
});

test("a job with a lease still running is left alone", async () => {
  const id = await deal(), read = reader(), log = vi.fn();
  const document = await upload(id, "notes.txt", quote);
  await db.query(`update jobs set status='running', attempts=max_attempts, lease_until=now() + interval '4 minutes' where kind='verify_document' and payload->>'document_id'=$1`, [document]);
  await drain({ db, store, read, log });
  expect(await jobOf(document)).toMatchObject({ status: "running", attempts: 3 });
  expect(log).not.toHaveBeenCalledWith(expect.objectContaining({ event: "job.dead" }));
  await db.query(`update jobs set status='done', lease_until=null where kind='verify_document' and payload->>'document_id'=$1`, [document]);
});

test("a file too large to read fails in plain words, and the deal's other file is still read", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>`);
  const id = await deal(), read = reader();
  const large = await upload(id, "model.xlsx", new Uint8Array(await zip.generateAsync({ type: "uint8array" })));
  const notes = await upload(id, "notes.txt", quote);
  await drain({ db, store, read });
  const stages = await db.query<any>(`select id,stage,stage_detail from documents where deal_id=$1`, [id]);
  expect(stages.find((d: any) => d.id === large)).toMatchObject({ stage: "read_failed", stage_detail: "This file is too large for Agir to read. Save the parts that matter in a file of their own, then upload that." });
  expect(stages.find((d: any) => d.id === notes)).toMatchObject({ stage: "extracted" });
  expect(read).toHaveBeenCalledTimes(1);
  expect((await jobOf(large))?.status).toBe("done");
});
