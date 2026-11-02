import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asUser, fileStore, migrate, openPglite, currentDocuments, documentsHash, type Db } from "@agir/db";
import { drain, reconcileDeal } from "@agir/worker";
import { storedReadings } from "../../worker/src/reader.ts";
import type { ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-readings-stay-")));
const quote = "The owners picture a buyer paying a 5.5% yield on the way out.";
const empty = (): ReaderResponse => ({ readings: [], conflicts: [], not_used: [] });
const response = (value = 5.5, file = "notes.txt", text = quote): ReaderResponse => ({ ...empty(), readings: [{ field: "exit_cap_rate_pct", item: null, value, unit_seen: "%", file, location: "line 1", quote: text, note: null, confidence: "high" }] });
const working = () => vi.fn(async () => response());
const failing = () => vi.fn(async (): Promise<ReaderResponse> => { throw new TypeError("fake reader failed"); });
async function request(method: string, path: string, body?: unknown, who = cookie) {
  return app.request(path, { method, headers: { cookie: who, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function call(method: string, path: string, body?: unknown) {
  const res = await request(method, path, body); expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const review = (deal: string) => call("GET", `/api/deals/${deal}/review`);
const figure = async (deal: string) => (await review(deal)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
const rows = (deal: string) => db.query<any>(`select * from ai_readings where deal_id=$1 order by created_at desc,id desc`, [deal]);
async function upload(deal: string, name: string, text: string) {
  const res = await app.request(`/api/deals/${deal}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new TextEncoder().encode(text) });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
async function setup(approved = false, read = working()) {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Reading stays", assetType: "Multifamily" })).id as string;
  const document = await upload(deal, "notes.txt", quote);
  await drain({ db, store, read });
  if ((await rows(deal))[0]?.outcome === "ok") {
    expect(await db.query(`select 1 from candidates where deal_id=$1 and field_key='exit_cap_rate_pct'`, [deal])).toEqual([]);
    expect((await figure(deal)).sources.every((s: any) => s.rule === "ai")).toBe(true);
    if (approved) { const a = await figure(deal); await call("POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version }); }
  }
  return { deal, document };
}
const eventCount = async (deal: string) => (await db.query<any>(`select count(*)::int as n from assumption_events where deal_id=$1`, [deal]))[0].n;
const held = (deal: string) => db.query(`insert into jobs(kind,payload,run_after) values ('reconcile_deal',$1,now()+interval '600 seconds')`, [JSON.stringify({ deal_id: deal })]);
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await request("POST", "/api/auth/signup", { email: "stay@example.com", name: "Stay", password: "correct horse battery" }, "");
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test.each([false, true])("added document, failed or silent reading preserves approved=%s exactly", async approved => {
  for (const read of [failing(), vi.fn(async () => empty())]) {
    const { deal } = await setup(approved); const before = await figure(deal), events = await eventCount(deal);
    await upload(deal, "extra.txt", "Nothing further to price."); await drain({ db, store, read });
    const after = await figure(deal);
    expect(after).toMatchObject({ status: before.status, value: before.value, sources: before.sources, version: before.version });
    expect(await eventCount(deal)).toBe(events);
  }
});
test.each([false, true])("a newer verified field supersedes older value, approved=%s", async approved => {
  const { deal } = await setup(approved); const text = "The owners picture a buyer paying a 6.5% yield on the way out.";
  await upload(deal, "next.txt", text); await drain({ db, store, read: async () => response(6.5, "next.txt", text) });
  const a = await figure(deal);
  expect(a.status).toBe(approved ? "conflicting" : "needs_review");
  if (approved) expect(a.conflictValues.map((c: any) => c.value).sort()).toEqual([5.5, 6.5]); else expect(a.value).toBe(6.5);
});
test("a newer unverified figure does not speak for its field, and still asks for checking", async () => {
  const { deal } = await setup(); await upload(deal, "extra.txt", "Nothing further to price.");
  await drain({ db, store, read: async () => response(6.5) });
  expect(await figure(deal)).toMatchObject({ status: "needs_review", value: 5.5 });
  expect((await review(deal)).aiReading.pleaseCheck).toMatchObject([{ value: 6.5 }]);
});
test("not_used sets aside the same file and value", async () => {
  const { deal } = await setup(); await upload(deal, "extra.txt", "Nothing further to price.");
  await drain({ db, store, read: async () => ({ ...empty(), not_used: [{ file: "notes.txt", value: 5.5, location: "line 1", quote, why: "Not the exit assumption" }] }) });
  expect(await figure(deal)).toMatchObject({ status: "rejected", reason: "The latest reading of the documents did not use this figure" });
});
test("itemized silence is per field, so renamed units do not double the count", async () => {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Units", assetType: "Multifamily" })).id;
  const text = "Owners picture 4 apartments in the first group and 6 in the second.";
  await upload(deal, "notes.txt", text);
  const unit = (item: string, value: number) => ({ ...response().readings[0]!, field: "unit_count", item, value, unit_seen: "units" as const, quote: text });
  await drain({ db, store, read: async () => ({ ...empty(), readings: [unit("1BR", 4), unit("2BR", 6)] }) });
  expect((await review(deal)).assumptions.filter((a: any) => a.fieldKey === "unit_count")).toHaveLength(2);
  await upload(deal, "extra.txt", "No further details.");
  await drain({ db, store, read: async () => ({ ...empty(), readings: [unit("One bedroom", 4)] }) });
  const units = (await review(deal)).assumptions.filter((a: any) => a.fieldKey === "unit_count");
  expect(units.filter((a: any) => a.status !== "rejected")).toMatchObject([{ value: 4 }]);
  expect(units.filter((a: any) => a.status === "rejected").map((a: any) => a.reason)).toEqual(Array(1).fill("The latest reading of the documents did not use this figure"));
});
test("old prompt still counts; older verification stays byte-for-byte while current verification refreshes", async () => {
  const { deal } = await setup(); const old = (await rows(deal))[0];
  await db.query(`update ai_readings set prompt_version='old-prompt' where id=$1`, [old.id]);
  await reconcileDeal(db, store, deal); expect(await figure(deal)).toMatchObject({ status: "needs_review", value: 5.5 });
  await upload(deal, "extra.txt", "Nothing further to price."); await drain({ db, store, read: async () => empty() });
  const current = (await rows(deal))[0]; const original = JSON.stringify((await rows(deal)).find(r => r.id === old.id).verification);
  await db.query(`update ai_readings set verification=verification || '{"marker":true}'::jsonb where id=$1`, [current.id]);
  await reconcileDeal(db, store, deal);
  expect(JSON.stringify((await rows(deal)).find(r => r.id === old.id).verification)).toBe(original);
  expect((await rows(deal)).find(r => r.id === current.id).verification.marker).toBeUndefined();
});
test("replay parses a document only once across multiple rows", async () => {
  const { deal } = await setup();
  await db.query(`insert into ai_readings(deal_id,workspace_id,model,prompt_version,documents_hash,response,outcome,verification) select deal_id,workspace_id,model,'older',documents_hash,response,outcome,verification from ai_readings where deal_id=$1`, [deal]);
  const get = vi.fn(store.get.bind(store)); await storedReadings(db, { ...store, get }, deal); expect(get).toHaveBeenCalledTimes(1);
});
test.each([false, true])("context and AI off give truthful reasons, approved=%s; restoring returns values", async approved => {
  for (const mode of ["context", "off"] as const) {
    const { deal, document } = await setup(approved);
    if (mode === "context") await call("POST", `/api/documents/${document}/role`, { role: "context" });
    else await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: false });
    await drain({ db, store });
    const reason = mode === "context" ? "Its document is now marked as background only" : "AI reading was turned off, and only AI reading found this figure";
    expect(await figure(deal)).toMatchObject({ status: approved ? "needs_review" : "rejected", reason: reason + (approved ? "; confirm or reject it" : "") });
    if (mode === "off") { expect((await review(deal)).aiReading).toBeNull(); expect(await storedReadings(db, store, deal)).toEqual([]); }
    if (mode === "context") await call("POST", `/api/documents/${document}/role`, { role: null });
    else await call("PUT", `/api/workspaces/${ws}/ai-reading`, { on: true });
    await drain({ db, store }); expect(await figure(deal)).toMatchObject({ status: "needs_review", value: 5.5 });
  }
});
test("retirement removes only the retired source's figure", async () => {
  const { deal, document } = await setup(); const text = "The owners picture a buyer paying a 6.5% yield on the way out.";
  await upload(deal, "next.txt", text);
  await drain({ db, store, read: async () => ({ ...empty(), readings: [{ ...response(6.5, "next.txt", text).readings[0]!, field: "vacancy_pct" }] }) });
  const before = (await review(deal)).assumptions.find((a: any) => a.fieldKey === "vacancy_pct");
  await call("POST", `/api/documents/${document}/retire`); await drain({ db, store });
  expect(await figure(deal)).toMatchObject({ status: "rejected", reason: "Its source document was removed" });
  expect((await review(deal)).assumptions.find((a: any) => a.fieldKey === "vacancy_pct")).toEqual(before);
});
test("failed reading can be retried once, audited, released and becomes an AI proposal", async () => {
  const { deal } = await setup(false, failing()); expect((await review(deal)).aiReading.outcome).toBe("failed");
  await call("POST", `/api/deals/${deal}/read-again`);
  const [owner] = await db.query<any>(`select user_id from workspace_members where workspace_id=$1 and role='owner'`, [ws]);
  expect((await asUser(db, owner.user_id, tx => tx.query<any>(`select fn_deal_updating($1) as updating`, [deal])))[0]!.updating).toBe(true);
  expect(await db.query(`select 1 from audit_events where deal_id=$1 and action='deal.read_again'`, [deal])).toHaveLength(1);
  const read = working(); await drain({ db, store, read }); expect(read).toHaveBeenCalledTimes(1);
  expect(await rows(deal)).toMatchObject([{ outcome: "ok" }]); expect(await rows(deal)).toHaveLength(1);
  expect((await figure(deal)).sources.some((s: any) => s.rule === "ai")).toBe(true);
  expect(await db.query(`select 1 from jobs where kind='reconcile_deal' and status='queued' and run_after>now() and payload->>'deal_id'=$1`, [deal])).toEqual([]);
  read.mockClear(); await call("POST", `/api/deals/${deal}/read-again`); await drain({ db, store, read }); expect(read).not.toHaveBeenCalled();
});
test("second failure replaces the safe error in one row", async () => {
  const { deal } = await setup(false, failing()); await call("POST", `/api/deals/${deal}/read-again`);
  await drain({ db, store, read: async () => { throw new RangeError("another failure"); } });
  expect(await rows(deal)).toHaveLength(1); expect((await rows(deal))[0]).toMatchObject({ outcome: "failed", error: { class: "RangeError" } });
});
test.each([false, true])("later extraction retries failed but not successful rows, ok=%s", async ok => {
  const { deal, document } = await setup(false, ok ? working() : failing()); const read = working();
  await db.query(`insert into jobs(kind,payload) values ('extract_document',$1)`, [JSON.stringify({ document_id: document })]); await drain({ db, store, read });
  expect(read).toHaveBeenCalledTimes(ok ? 0 : 1); expect((await rows(deal))[0].outcome).toBe("ok");
});
test("retry permissions and active-reading guards; copy permits an ordinary queued reconcile", async () => {
  const { deal, document } = await setup(); await held(deal);
  const res = await request("POST", `/api/deals/${deal}/read-again`); expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "Agir is still reading this deal. Try again when it finishes." });
  expect((await request("POST", `/api/deals/${deal}/copy`, { name: "Busy copy" })).status).toBe(409);
  await db.query(`update jobs set run_after=now() where payload->>'deal_id'=$1`, [deal]);
  expect((await request("POST", `/api/deals/${deal}/copy`, { name: "Plain queued copy" })).status).toBe(200);
  await db.query(`update documents set stage='extracting' where id=$1`, [document]);
  expect((await request("POST", `/api/deals/${deal}/read-again`)).status).toBe(409);
  await db.query(`update documents set stage='extracted' where id=$1`, [document]);
  const signup = await request("POST", "/api/auth/signup", { email: "outside-stay@example.com", name: "Other", password: "correct horse battery" }, "");
  const other = signup.headers.get("set-cookie")!.split(";")[0]!;
  expect((await request("POST", `/api/deals/${deal}/read-again`, undefined, other)).status).toBe(404);
  await call("POST", `/api/workspaces/${ws}/members`, { email: "outside-stay@example.com", role: "viewer" });
  expect((await request("POST", `/api/deals/${deal}/read-again`, undefined, other)).status).toBe(403);
});
test("queued read of a deleted deal is a no-op", async () => {
  const read = working(); const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Deleted deal", assetType: "Multifamily" })).id;
  await db.query(`insert into jobs(kind,payload) values ('read_deal',$1)`, [JSON.stringify({ deal_id: deal })]);
  await db.query(`delete from deals where id=$1`, [deal]);
  await drain({ db, store, read }); expect(read).not.toHaveBeenCalled();
  expect(await db.query(`select status from jobs where kind='read_deal' and payload->>'deal_id'=$1`, [deal])).toEqual([{ status: "done" }]);
});
test("copy carries readings, roles, candidate details, remapped hashes and verification", async () => {
  const { deal, document } = await setup();
  await call("POST", `/api/documents/${document}/role`, { role: "evidence" });
  const read = vi.fn(async () => ({ ...response(), not_used: [{ value: 77, file: "notes.txt", location: "line 1", quote, why: "Unneeded" }] }));
  await upload(deal, "contact.txt", "Contact someone@example.com"); await drain({ db, store, read });
  await db.query(`update candidates set alternatives=array['land_cost'],region='{"table":"budget"}'::jsonb where deal_id=$1`, [deal]);
  // Ensure a candidate exists even though the exit figure is deliberately AI-only.
  await db.query(`insert into candidates(document_id,deal_id,workspace_id,field_key,value,raw,location,context,rule,alternatives,region) values($1,$2,$3,null,77,'77','line 1','77','unlabelled',array['land_cost'],'{"table":"budget"}')`, [document, deal, ws]);
  const before = await figure(deal); const sourceReview = await review(deal);
  const copy = (await call("POST", `/api/deals/${deal}/copy`, { name: "Copy" })).id;
  const initial = await figure(copy); read.mockClear(); await drain({ db, store, read });
  const a = await figure(copy); expect(a).toMatchObject({ status: before.status, value: before.value, version: initial.version }); expect(read).not.toHaveBeenCalled();
  const copiedDocs = await currentDocuments(db, copy);
  expect(a.sources.some((s: any) => s.rule === "ai" && copiedDocs.some(d => d.id === s.document_id))).toBe(true);
  expect((await review(copy)).aiReading).toMatchObject({ outcome: sourceReview.aiReading.outcome, notUsed: sourceReview.aiReading.notUsed.map(({ figureId, ...r }: any) => r) });
  for (const table of ["documents", "candidates"]) {
    const cols = table === "documents" ? "role_set,read_role" : "alternatives,region";
    expect(await db.query(`select ${cols} from ${table} where deal_id=$1 order by ${table === "documents" ? "name" : "raw"}`, [copy])).toEqual(await db.query(`select ${cols} from ${table} where deal_id=$1 order by ${table === "documents" ? "name" : "raw"}`, [deal]));
  }
  const currentHash = documentsHash(copiedDocs); const current = (await rows(copy)).find(r => r.documents_hash === currentHash); expect(current).toBeDefined();
  expect(current.verification.documents.map((d: any) => d.id).sort()).toEqual(copiedDocs.map(d => d.id).sort());
  expect(Object.keys(current.verification.redactions).sort()).toEqual(copiedDocs.map(d => d.id).sort());
  expect((await rows(copy)).length).toBe((await rows(deal)).length);
});
test("a copied failed reading stays failed and can be retried", async () => {
  const { deal } = await setup(false, failing()); const copy = (await call("POST", `/api/deals/${deal}/copy`, { name: "Failed copy" })).id;
  await drain({ db, store }); expect((await review(copy)).aiReading.outcome).toBe("failed");
  await call("POST", `/api/deals/${copy}/read-again`); await drain({ db, store, read: working() }); expect(await figure(copy)).toMatchObject({ value: 5.5, status: "needs_review" });
});
test("SQL document hash equals the JS hash for empty, ordered, role-set and retired documents", async () => {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Hash", assetType: "Multifamily" })).id;
  const check = async () => expect((await db.query<any>(`select agir_documents_hash($1) as hash`, [deal]))[0].hash).toBe(documentsHash(await currentDocuments(db, deal)));
  await check(); const first = await upload(deal, "one.txt", "one"); await check(); await upload(deal, "two.txt", "two"); await upload(deal, "three.txt", "three"); await check();
  await db.query(`update documents set role_set='evidence' where id=$1`, [first]); await check(); await db.query(`update documents set retired_at=now() where id=$1`, [first]); await check();
  await drain({ db, store });
});
// Explicit exceptions preserve the existing copy contract; new columns must be considered deliberately.
const COPY_EXCLUSIONS: Record<string, Record<string, string>> = {
  deals: { archived_at: "A copy starts unarchived." },
  assumptions: { version: "A copy starts its own version sequence.", updated_at: "A copy starts its own update time.", client_confirmed_by: "Client confirmation belongs to the original deal.", client_confirmed_at: "Client confirmation belongs to the original deal." },
};
test("copy definition accounts for every column, including future columns", async () => {
  const [fn] = await db.query<any>(`select pg_get_functiondef('fn_copy_deal(uuid,text)'::regprocedure) as definition`);
  const columns = await db.query<any>(`select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('deals','documents','candidates','figure_labels','label_suggestions','assumptions','ai_readings')`);
  const missing = columns.filter(c => !new RegExp(`\\b${c.column_name}\\b`).test(fn.definition) && !COPY_EXCLUSIONS[c.table_name]?.[c.column_name]);
  expect(missing).toEqual([]);
});
