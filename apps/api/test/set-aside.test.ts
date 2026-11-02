import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import type { ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

// Card 189: Review says so when Agir set aside every file it read. Every reader here is fake.
let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-set-aside-")));
const filler = Array.from({ length: 20 }, () => "The narrative explains the purpose and background of this document.");
const market = (extra = "") => ["Market report", "Vacancy rate statistics for the region", ...filler, "Unlabelled reserve: $65,000", extra].join("\n");
const source = "Unlabelled reserve 7000\nOther amount 8000";
const badPdf = "%PDF-1.4\nnot a pdf\n";
const reader = () => vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => ({ readings: [], conflicts: [], not_used: [] }));
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const deal = async () => (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Set aside", assetType: "Multifamily" })).id as string;
const setAsideAll = async (id: string) => (await call("GET", `/api/deals/${id}/review`)).setAsideAll as unknown;
const readRole = async (document: string) => (await db.query<{ read_role: string | null }>(`select read_role from documents where id=$1`, [document]))[0]!.read_role;
async function upload(id: string, name: string, content: string) {
  const res = await app.request(`/api/deals/${id}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new TextEncoder().encode(content) });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
const setRole = (document: string, role: string) => call("POST", `/api/documents/${document}/role`, { role });
const retire = (document: string) => call("POST", `/api/documents/${document}/retire`);
const settle = (read = reader()) => drain({ db, store, read }).then(() => read);

beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "aside@example.com", name: "Aside", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test("a real upload of a market report is set aside, with no model call", async () => {
  const id = await deal(), document = await upload(id, "market.txt", market());
  const read = await settle();
  expect(await readRole(document)).toBe("market report (context)");
  expect(await setAsideAll(id)).toBe(true);
  expect(read).toHaveBeenCalledTimes(0);
});
test("a deal source beside it means not everything was set aside", async () => {
  const id = await deal(); await upload(id, "market.txt", market()); await upload(id, "notes.txt", source);
  await settle();
  expect(await setAsideAll(id)).toBe(false);
});
test("a person setting the only document to context was not set aside by Agir", async () => {
  const id = await deal(), document = await upload(id, "market.txt", market());
  await settle(); await setRole(document, "context"); await settle();
  expect(await readRole(document)).toBe("market report (context, set by a person)");
  expect(await setAsideAll(id)).toBe(false);
});
test("one set aside by Agir and one by a person", async () => {
  const id = await deal(); await upload(id, "market.txt", market());
  const other = await upload(id, "other.txt", market("A second market report"));
  await settle(); await setRole(other, "context"); await settle();
  expect(await readRole(other)).toBe("market report (context, set by a person)");
  expect(await setAsideAll(id)).toBe(true);
});
test("a damaged PDF beside a set-aside file does not change the answer", async () => {
  const id = await deal(); await upload(id, "market.txt", market()); await upload(id, "bad.pdf", badPdf);
  await settle();
  expect(await setAsideAll(id)).toBe(true);
});
test("only a damaged PDF, or no documents at all, is not a set-aside", async () => {
  const empty = await deal(); expect(await setAsideAll(empty)).toBe(false);
  const id = await deal(); await upload(id, "bad.pdf", badPdf); await settle();
  expect(await setAsideAll(id)).toBe(false);
});
test("a retired document does not count, either way", async () => {
  const withSource = await deal(); await upload(withSource, "market.txt", market());
  const retiredSource = await upload(withSource, "notes.txt", source);
  await settle(); expect(await setAsideAll(withSource)).toBe(false);
  await retire(retiredSource); await settle();
  expect(await setAsideAll(withSource)).toBe(true);
  const alone = await deal(), retiredMarket = await upload(alone, "market.txt", market());
  await settle(); expect(await setAsideAll(alone)).toBe(true);
  await retire(retiredMarket); await settle();
  expect(await setAsideAll(alone)).toBe(false);
});
test("a document still being read holds the answer back", async () => {
  const id = await deal(); await upload(id, "market.txt", market()); await settle();
  const next = await upload(id, "other.txt", market("A second market report"));
  await db.query(`update documents set stage='reading' where id=$1`, [next]);
  expect(await setAsideAll(id)).toBe(false);
  await settle();
});
test("reading it anyway overrules Agir and calls the model once", async () => {
  const id = await deal(), document = await upload(id, "market.txt", market());
  expect((await settle()).mock.calls).toHaveLength(0);
  await setRole(document, "deal_source");
  const read = await settle();
  expect(await setAsideAll(id)).toBe(false);
  expect(await readRole(document)).toMatch(/set by a person\)$/);
  expect(read).toHaveBeenCalledTimes(1);
});
