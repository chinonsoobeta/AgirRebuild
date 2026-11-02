import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import type { ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

// Card 190: a soil report is not read for deal figures, and a new name for a paper changes no reading. Every reader here is fake.
let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-document-types-")));
const filler = Array.from({ length: 20 }, () => "The narrative explains the purpose and background of this document.");
const soil = Array.from({ length: 8 }, (_, i) => `Borehole BH-${i + 1} met bedrock, and the bearing capacity at this depth is adequate.`);
const geotechnical = ["Geotechnical Investigation Report", ...soil, ...filler, "Land cost: $830,000"].join("\n");
const operating = ["Operating Statement", ...filler, "Land cost: $830,000"].join("\n");
const reader = () => vi.fn(async (_request: ReaderRequest): Promise<ReaderResponse> => ({ readings: [], conflicts: [], not_used: [] }));
async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const deal = async () => (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Document types", assetType: "Multifamily" })).id as string;
const row = async (document: string) => (await db.query<{ read_role: string | null; candidate_count: number }>(`select read_role,candidate_count from documents where id=$1`, [document]))[0]!;
async function upload(id: string, name: string, content: string) {
  const res = await app.request(`/api/deals/${id}/documents?name=${name}`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new TextEncoder().encode(content) });
  expect(res.status).toBe(200); return (await res.json() as any).id as string;
}
const settle = (read = reader()) => drain({ db, store, read }).then(() => read);

beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "types@example.com", name: "Types", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test("a geotechnical report alone is set aside, with no model call and no proposed figure", async () => {
  const id = await deal(), document = await upload(id, "soil.txt", geotechnical);
  const read = await settle();
  expect(read).toHaveBeenCalledTimes(0);
  expect(await row(document)).toEqual({ read_role: "geotechnical report (context)", candidate_count: 0 });
  expect((await call("GET", `/api/deals/${id}/review`)).setAsideAll).toBe(true);
});
test("reading it anyway overrules Agir and calls the model", async () => {
  const id = await deal(), document = await upload(id, "soil.txt", geotechnical);
  await settle();
  await call("POST", `/api/documents/${document}/role`, { role: "deal_source" });
  const read = await settle();
  expect(read).toHaveBeenCalledTimes(1);
  expect((await row(document)).read_role).toBe("geotechnical report (deal source, set by a person)");
});
test("an operating statement keeps being read, under its name", async () => {
  const id = await deal(), document = await upload(id, "operating.txt", operating);
  const read = await settle();
  expect(read).toHaveBeenCalledTimes(1);
  expect((await row(document)).read_role).toBe("operating statement (deal source)");
});
