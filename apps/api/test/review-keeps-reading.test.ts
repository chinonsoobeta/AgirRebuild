import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import { READING_FAILURE, type ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-keeps-reading-")));
const text = "Unlabelled reserve 7000\nOther amount 8000";
const badPdf = "%PDF-1.4\nnot a pdf\n";
const answer = (files = ["notes.txt"], field = "land_cost"): ReaderResponse => ({
  readings: files.map(file => ({ field, item: null, value: 8000, unit_seen: "$", file, location: "line 2", quote: "Absent 8000", note: null, confidence: "high" })),
  conflicts: [],
  not_used: files.map(file => ({ value: 7000, file, location: "line 1", quote: "7000", why: "No stated purpose" })),
});
const reader = (files?: string[], field?: string) => vi.fn(async (_request: ReaderRequest) => answer(files, field));
const failing = () => vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => { throw new Error("fake reader failure"); });
async function call(method: string, path: string, body?: unknown, session = cookie) {
  const res = await app.request(path, { method, headers: { cookie: session, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const deal = async (workspace = ws) => (await call("POST", `/api/workspaces/${workspace}/deals`, { name: "Keeps reading", assetType: "Multifamily" })).id as string;
const review = (id: string) => call("GET", `/api/deals/${id}/review`);
const rows = (id: string) => db.query<any>(`select * from ai_readings where deal_id=$1 order by created_at desc,id desc`, [id]);
async function upload(id: string, name = "notes.txt", content = text) {
  const res = await app.request(`/api/deals/${id}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new TextEncoder().encode(content) });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
const retire = (document: string) => call("POST", `/api/documents/${document}/retire`);
async function setup() {
  const id = await deal(), document = await upload(id), read = reader();
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  return { id, document, read, before: (await review(id)).aiReading };
}
function lists(view: any, files = ["notes.txt"]) {
  expect(view.aiReading).not.toBeNull();
  expect(view.aiReading.pleaseCheck.map((r: any) => r.file).sort()).toEqual([...files].sort());
  expect(view.aiReading.notUsed.map((r: any) => r.file).sort()).toEqual([...files].sort());
  expect(view.todo.items.filter((r: any) => r.kind === "ai_check")).toHaveLength(files.length);
}
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "keeps@example.com", name: "Keeps", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test("retiring a damaged PDF preserves the checks, omissions and todo without reading again", async () => {
  const id = await deal(), read = reader(); await upload(id); const bad = await upload(id, "bad.pdf", badPdf);
  await drain({ db, store, read }); lists(await review(id));
  await retire(bad); await drain({ db, store, read });
  const view = await review(id); lists(view); expect(view.aiReading).toMatchObject({ outcome: "ok", unread: [] });
  expect(read).toHaveBeenCalledTimes(1);
});
test("adding a damaged PDF preserves the finished reading without another call", async () => {
  const { id, read, before } = await setup(); await upload(id, "bad.pdf", badPdf); await drain({ db, store, read });
  const view = await review(id); lists(view); expect(view.aiReading).toEqual(before); expect(read).toHaveBeenCalledTimes(1);
});
test("retiring one of two documents retains only the remaining document's lists", async () => {
  const id = await deal(), read = reader(["notes.txt", "second.txt"]);
  const first = await upload(id); await upload(id, "second.txt", text + "\nSecond document"); await drain({ db, store, read });
  lists(await review(id), ["notes.txt", "second.txt"]);
  await retire(first); await drain({ db, store, read }); lists(await review(id), ["second.txt"]); expect(read).toHaveBeenCalledTimes(1);
});
test("a replacement with the same name and different bytes does not inherit the old lists when reading fails", async () => {
  const { id, document } = await setup(); await retire(document); await upload(id, "notes.txt", text + "\nReplacement");
  const read = failing(); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(2);
  const view = await review(id); lists(view, []); expect(view.aiReading).toMatchObject({ outcome: "failed", unread: [] });
});
test("a failed current reading keeps earlier lists and its own failure metadata", async () => {
  const { id, before } = await setup(); await upload(id, "second.txt", "Further information");
  const read = failing(); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(2);
  const view = await review(id), current = (await rows(id))[0]; lists(view);
  expect(view.aiReading).toMatchObject({ outcome: "failed", model: current.model, promptVersion: current.prompt_version, unread: [] });
  expect(view.aiReading.createdAt).toBe(new Date(current.created_at).toISOString());
  expect(view.aiReading.pleaseCheck).toEqual(before.pleaseCheck); expect(view.aiReading.notUsed).toEqual(before.notUsed);
});
test("a document set to context loses its earlier items when the next reading fails", async () => {
  const id = await deal(), read = reader(["notes.txt", "second.txt"]); const first = await upload(id);
  await upload(id, "second.txt", text + "\nSecond"); await drain({ db, store, read });
  await call("POST", `/api/documents/${first}/role`, { role: "context" });
  const fail = failing(); await drain({ db, store, read: fail }); expect(fail).toHaveBeenCalledTimes(2);
  const view = await review(id); lists(view, ["second.txt"]); expect(view.aiReading.outcome).toBe("failed");
});
test("an old prompt and model still supply the row's metadata and lists", async () => {
  const { id, before } = await setup();
  await db.query(`update ai_readings set prompt_version='old-prompt',model='old-model' where deal_id=$1`, [id]);
  expect((await review(id)).aiReading).toEqual({ ...before, promptVersion: "old-prompt", model: "old-model" });
});
test.each(["uploaded", "checking", "reading", "extracting"])("a new document at %s hides the earlier reading", async stage => {
  const { id } = await setup(); const document = await upload(id, "second.txt", "Further information");
  await db.query(`update documents set stage=$2 where id=$1`, [document, stage]);
  expect((await review(id)).aiReading).toBeNull();
  await drain({ db, store, read: reader() });
});
test("AI reading off and a client both hide an earlier reading", async () => {
  const { id, read } = await setup(); await upload(id, "bad.pdf", badPdf); await drain({ db, store, read });
  await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: false });
  try { expect((await review(id)).aiReading).toBeNull(); }
  finally { await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: true }); }
  const signup = await createApp({ db, store, secureCookies: false }).request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "keeps-client@example.com", name: "Client", password: "correct horse battery" }) });
  expect(signup.status).toBe(200); const client = signup.headers.get("set-cookie")!.split(";")[0]!;
  await call("POST", `/api/deals/${id}/clients`, { email: "keeps-client@example.com" });
  expect((await call("GET", `/api/deals/${id}/review`, undefined, client)).aiReading).toBeNull();
});
test("a current ok row does not merge superseded items", async () => {
  const { id } = await setup();
  // A narrower successful snapshot at the same key is superseded by a wider success.
  await db.query(`update ai_readings set verification=jsonb_set(verification,'{documents}','[]'::jsonb) where deal_id=$1`, [id]);
  await call("POST", `/api/deals/${id}/read-again`);
  const read = vi.fn(async () => ({ readings: [], conflicts: [], not_used: [] })); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); expect(await rows(id)).toHaveLength(2);
  expect((await rows(id)).some(r => r.documents_hash.includes(":superseded:"))).toBe(true);
  lists(await review(id), []); expect((await review(id)).aiReading.outcome).toBe("ok");
});
test("an earlier reading lists unread files extracted while off and Read again covers them once", async () => {
  const { id, read } = await setup(); await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: false });
  try { await upload(id, "second.txt", "Further information"); await drain({ db, store, read }); }
  finally { await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: true }); }
  expect((await review(id)).aiReading.unread).toEqual([]); // the switch queues an update, and nothing is called unread until it ends
  await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(1); lists(await review(id)); expect((await review(id)).aiReading.unread).toEqual(["second.txt"]);
  await call("POST", `/api/deals/${id}/read-again`); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls[1]![0].messages[0]!.content).toContain("second.txt");
  expect((await review(id)).aiReading.unread).toEqual([]);
});
test("sale mode puts an earlier failed rental figure in notNeeded", async () => {
  const solo = (await call("POST", "/api/workspaces", { name: "Solo", reviewMode: "solo" })).id;
  const id = await deal(solo), read = reader(undefined, "exit_cap_rate_pct"); await upload(id); await drain({ db, store, read });
  await call("POST", `/api/deals/${id}/values`, { fieldKey: "sell_units", value: 1, reason: "The homes are sold" });
  await upload(id, "bad.pdf", badPdf); await drain({ db, store, read });
  const view = await review(id); expect(view.aiReading).not.toBeNull(); expect(view.aiReading.pleaseCheck).toEqual([]);
  expect(view.notNeeded.find((r: any) => r.fieldKey === "exit_cap_rate_pct")).toMatchObject({ value: 8000, why: "This deal sells its units", sources: [{ document_name: "notes.txt", location: "line 2" }] });
  expect(read).toHaveBeenCalledTimes(1);
});

test.each(["role_set", "read_role", "person", "null", "hash mismatch", "legacy", "document key only", "not extracted"])("earlier item provenance filter: %s", async mode => {
  const { id, document, read } = await setup(), row = (await rows(id))[0];
  if (mode === "role_set") await db.query(`update documents set role_set='context' where id=$1`, [document]);
  if (mode === "read_role" || mode === "person" || mode === "null") await db.query(`update documents set read_role=$2 where id=$1`, [document, mode === "null" ? null : mode === "person" ? "Other (context, set by a person)" : "Other (context)"]);
  if (mode === "not extracted") await db.query(`update documents set stage='read_failed' where id=$1`, [document]);
  const ref = row.verification.documents[0];
  if (mode === "hash mismatch") ref.sha256 = "different bytes";
  if (mode === "legacy") { delete ref.sha256; ref.document = { ignored: true }; }
  if (mode === "document key only") { ref.document = ref.id; delete ref.id; }
  await db.query(`update ai_readings set documents_hash='earlier-hash',verification=$2 where id=$1`, [row.id, JSON.stringify(row.verification)]);
  lists(await review(id), ["null", "legacy"].includes(mode) ? ["notes.txt"] : []); expect(read).toHaveBeenCalledTimes(1);
});

test("the newest successful superseded row supplies the earlier lists", async () => {
  const { id } = await setup(), old = (await rows(id))[0];
  await db.query(`update ai_readings set documents_hash='older-hash',created_at=now()-interval '1 day' where id=$1`, [old.id]);
  const response = answer(); response.not_used[0]!.why = "Newest explanation";
  await db.query(`insert into ai_readings(deal_id,workspace_id,model,prompt_version,documents_hash,response,outcome,verification) values($1,$2,'another-model','another-prompt','hash:superseded:newest',$3,'ok',$4)`, [id, ws, JSON.stringify(response), JSON.stringify(old.verification)]);
  const view = await review(id); lists(view);
  expect(view.aiReading).toMatchObject({ model: "another-model", promptVersion: "another-prompt", notUsed: [{ why: "Newest explanation" }] });
});
test("earlier conflict values are filtered by their own document without shifting verification indexes", async () => {
  const id = await deal(), first = await upload(id); await upload(id, "second.txt", text + "\nSecond");
  const response = answer(["notes.txt", "second.txt"]);
  response.readings[1]!.location = "line 99";
  response.conflicts = [{ field: "land_cost", item: null, why: "Disagreement", values: response.readings }];
  response.readings = [];
  await drain({ db, store, read: async () => response });
  await retire(first); await drain({ db, store, read: failing() });
  const view = await review(id);
  expect(view.aiReading.pleaseCheck).toMatchObject([{ file: "second.txt", reason: READING_FAILURE.address }]);
  expect(view.aiReading.pleaseCheck).toHaveLength(1);
  expect(view.aiReading.notUsed.map((r: any) => r.file)).toEqual(["second.txt"]);
});
test("while the AI is reading a new file, that file is not called unread and the lists stay", async () => {
  const { id } = await setup(); await upload(id, "second.txt", "Further information");
  let during: any;
  const read = vi.fn(async (_request: ReaderRequest) => { during = await review(id); return answer(); });
  await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  lists(during); expect(during.aiReading).toMatchObject({ outcome: "ok", unread: [] });
  expect((await review(id)).aiReading.unread).toEqual([]);
});
test("a deal with no documents left keeps no lists", async () => {
  const { id, document } = await setup(); await retire(document); await drain({ db, store, read: reader() });
  const view = await review(id); lists(view, []); expect(view.aiReading.unread).toEqual([]);
});
