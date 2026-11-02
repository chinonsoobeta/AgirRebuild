// One long workbook never costs a deal its AI reading. Invented workbooks only.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { fileStore, migrate, openPglite, sha256Hex, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import { addressedText, parseDocument, redactDocument, type ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const directory = mkdtempSync(join(tmpdir(), "agir-card201-")), store = fileStore(directory);
const reader = () => vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => ({ readings: [], conflicts: [], not_used: [] }));
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const deal = async () => (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Invented budget", assetType: "Multifamily" })).id as string;
const review = (id: string) => call("GET", `/api/deals/${id}/review`);
const rows = (id: string) => db.query<any>(`select * from ai_readings where deal_id=$1 order by created_at desc,id desc`, [id]);
const role = (document: string, value: string | null) => call("POST", `/api/documents/${document}/role`, { role: value });
const figure = async (id: string) => (await review(id)).assumptions.find((a: any) => a.fieldKey === "land_cost");
const hash = async (id: string) => (await db.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [id]))[0]!.h;
async function upload(id: string, name: string, bytes: Uint8Array) {
  const res = await app.request(`/api/deals/${id}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: bytes as unknown as BodyInit });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
async function workbook(sheets: [string, number][] = [["Flows", 300000], ["Ledger", 700000]], landInLedger = false) {
  const book = new ExcelJS.Workbook(), inputs = book.addWorksheet("Inputs");
  if (!landInLedger) inputs.addRow(["Land cost", 1000000]);
  inputs.addRow(["Hard cost", 2000000]); inputs.addRow(["Exit cap rate", "5.5%"]);
  for (const [name, size] of sheets) {
    const sheet = book.addWorksheet(name);
    if (landInLedger && name === "Ledger") sheet.addRow(["Land cost", 1000000]);
    for (let left = size; left > 0; left -= 1000) sheet.addRow(["x".repeat(Math.min(left, 1000))]);
  }
  return new Uint8Array(await book.xlsx.writeBuffer());
}
async function setup(sheets?: [string, number][], landInLedger = false) {
  const id = await deal(), bytes = await workbook(sheets, landInLedger), name = "model.xlsx";
  const document = await upload(id, name, bytes), read = reader();
  await drain({ db, store, read });
  return { id, document, read, name, bytes };
}
const sent = (read: ReturnType<typeof reader>, index = 0) => read.mock.calls[index]![0].messages[0]!.content;
const omitted = (document: string, sheets = ["Ledger"], readAnyway: string | null = "deal_source", name = "model.xlsx") => [{ id: document, name, sheets, readAnyway }];
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "card201@example.com", name: "Budget", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); rmSync(directory, { recursive: true, force: true }); });

test("a fitting workbook keeps whole text and exactly the old stored document keys", async () => {
  const { id, read, bytes, name } = await setup([["Flows", 5000]]);
  const text = addressedText(redactDocument(await parseDocument(bytes, name)).document, name);
  expect(read).toHaveBeenCalledTimes(1); expect(sent(read)).toBe(text);
  const ref = (await rows(id))[0].verification.documents[0];
  expect(Object.keys(ref).sort()).toEqual(["id", "name", "sha256", "text_sha256"]);
  expect(ref.text_sha256).toBe(sha256Hex(text));
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual([]);
});
test("long sheets are omitted without calling the file unread", async () => {
  const { id, document, read } = await setup();
  expect(read).toHaveBeenCalledTimes(1);
  expect(sent(read)).toContain("[Inputs!A1] Land cost"); expect(sent(read)).toContain("[Flows!A1]"); expect(sent(read)).not.toContain("[Ledger!A1]");
  expect(sent(read).length).toBeLessThanOrEqual(500000);
  expect((await review(id)).aiReading).toMatchObject({ unread: [], sheetsLeftOut: omitted(document) });
  expect((await rows(id))[0].verification.documents[0].text_sha256).toBe(sha256Hex(sent(read)));
});
test("Read again reuses the same budgeted reading", async () => {
  const { id, document, read } = await setup();
  await call("POST", `/api/deals/${id}/read-again`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document));
});
test("asking widens reading without changing approved values; clearing reuses original", async () => {
  const { id, document, read } = await setup();
  const a = await figure(id); await call("POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version });
  const approved = await figure(id), beforeHash = await hash(id);
  await role(document, "deal_source");
  expect((await review(id)).aiReading?.sheetsLeftOut ?? []).toEqual([]);
  await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2); expect(sent(read, 1)).toContain("[Ledger!A1]");
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual([]);
  expect(await figure(id)).toEqual(approved); expect(await hash(id)).toBe(beforeHash);
  expect((await db.query<any>(`select read_role from documents where id=$1`, [document]))[0].read_role).toMatch(/\(deal source, set by a person\)$/);
  await role(document, null); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2); expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document));
});
test("asked workbook still leaves an oversized Archive out without another button", async () => {
  const { id, document, read } = await setup([["Flows", 300000], ["Ledger", 700000], ["Archive", 1600000]]);
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document, ["Ledger", "Archive"]));
  await role(document, "deal_source"); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2); expect(sent(read, 1)).toContain("[Ledger!A1]"); expect(sent(read, 1)).not.toContain("[Archive!A1]");
  expect(sent(read, 1).length).toBeLessThanOrEqual(1500000);
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document, ["Archive"], null));
});
test("failed wider reading hides the earlier omission notice", async () => {
  const { id, document } = await setup(); await role(document, "deal_source");
  const read = vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => { throw new Error("invented outage"); });
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(2);
  expect((await review(id)).aiReading).toMatchObject({ outcome: "failed", sheetsLeftOut: [] });
});
test("evidence role offers the evidence reading", async () => {
  const { id, document } = await setup();
  await db.query(`update documents set read_role='rent survey (evidence)' where id=$1`, [document]);
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document, ["Ledger"], "evidence"));
});
test("long CSV beside a small workbook is left out as a file", async () => {
  const id = await deal(), read = reader(); await upload(id, "model.xlsx", await workbook([["Flows", 5000]]));
  const document = await upload(id, "rents.csv", new TextEncoder().encode(Array.from({ length: 800 }, () => "ordinary," + "x".repeat(1000)).join("\n")));
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1); expect(sent(read)).not.toContain("[CSV!");
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document, [], "deal_source", "rents.csv"));
});
test("reconcile job preserves omission metadata and the sent-text hash", async () => {
  const { id, read } = await setup();
  await db.query(`insert into jobs(kind,payload) values('reconcile_deal',$1)`, [JSON.stringify({ deal_id: id })]);
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  expect((await rows(id))[0].verification.documents[0]).toMatchObject({ sheetsLeftOut: ["Ledger"], text_sha256: sha256Hex(sent(read)) });
});
test("rules still read land cost from the omitted Ledger", async () => {
  const { id, read } = await setup(undefined, true);
  expect(sent(read)).not.toContain("[Ledger!"); expect(await figure(id)).toMatchObject({ value: 1000000 });
  expect((await figure(id)).sources.some((s: any) => s.rule !== "ai" && s.location.includes("Ledger!"))).toBe(true);
});
// What the audit added: a file is named only while what the reading said of it still holds.
test.each([
  ["no longer reads", `update documents set stage='read_failed' where id=$1`],
  ["now holds other bytes", `update documents set sha256=repeat('0',64) where id=$1`],
  ["now reads as background", `update documents set read_role='site report (context)' where id=$1`],
])("a file that %s is not named", async (_what, sql) => {
  const { id, document } = await setup();
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual(omitted(document));
  await db.query(sql, [document]);
  expect((await review(id)).aiReading.sheetsLeftOut).toEqual([]);
});
