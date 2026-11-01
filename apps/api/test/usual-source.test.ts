import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import type { ReaderResponse } from "@agir/extraction";
import { createApp } from "../src/app.ts";

// Card 194: usual sources describe a conflict without choosing a value. Every reader is fake.
let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-usual-source-")));
const filler = Array.from({ length: 20 }, () => "The narrative explains the purpose and background of this document.");
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
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "usual@example.com", name: "Types", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });


const paper = (title: string, ...figures: string[]) => [title, ...filler, ...figures].join("\n");
const review = (id: string) => call("GET", `/api/deals/${id}/review`);
const assumption = (r: any, field: string, item: string | null = null) => r.assumptions.find((a: any) => a.fieldKey === field && a.itemKey === item);
async function pair(firstTitle: string, first: string[], secondTitle: string, second: string[]) {
  const id = await deal();
  const document = await upload(id, "agreement.txt", paper(firstTitle, ...first));
  await upload(id, "notes.txt", paper(secondTitle, ...second));
  await settle();
  return { id, document, result: await review(id) };
}

const cases: [string, string, string[], string, string[], string, number | null, string | null][] = [
  ["land", "Agreement of Purchase and Sale", ["Land cost: $830,000"], "Project notes", ["Land cost: $900,000"], "land_cost", 830000, "purchase agreement"],
  ["senior amount", "Term Sheet", ["Senior loan amount: $5,000,000", "Senior interest rate: 5.5%"], "Pro Forma", ["Senior loan amount: $5,500,000", "Senior interest rate: 6%"], "senior_loan_amount", 5000000, "term sheet"],
  ["senior rate", "Term Sheet", ["Senior loan amount: $5,000,000", "Senior interest rate: 5.5%"], "Pro Forma", ["Senior loan amount: $5,500,000", "Senior interest rate: 6%"], "senior_rate_pct", 5.5, "term sheet"],
  ["mezzanine", "Term Sheet", ["Mezzanine loan amount: $1,000,000"], "Pro Forma", ["Mezzanine loan amount: $1,200,000"], "mezz_loan_amount", 1000000, "term sheet"],
  ["refinance", "Term Sheet", ["Refinance loan amount: $7,000,000"], "Pro Forma", ["Refinance loan amount: $7,200,000"], "refinance_amount", 7000000, "term sheet"],
  ["budget", "Cost Budget", ["Hard costs: $9,000,000"], "Pro Forma", ["Hard costs: $9,500,000"], "hard_cost", 9000000, "cost budget"],
  ["cost report", "Cost Report", ["Hard costs: $9,000,000"], "Pro Forma", ["Hard costs: $9,500,000"], "hard_cost", 9000000, "cost report"],
  ["both lender papers", "Term Sheet", ["Senior loan amount: $5,000,000"], "Commitment Letter", ["Senior loan amount: $5,500,000"], "senior_loan_amount", null, null],
  ["neither", "Project notes", ["Land cost: $830,000"], "Pro Forma", ["Land cost: $900,000"], "land_cost", null, null],
  ["wrong field", "Agreement of Purchase and Sale", ["Hard costs: $9,000,000"], "Pro Forma", ["Hard costs: $9,500,000"], "hard_cost", null, null],
];
for (const [name, title, lines, title2, lines2, field, value, kind] of cases) test(name, async () => {
  const { result } = await pair(title, lines, title2, lines2);
  const a = assumption(result, field);
  expect(a.status).toBe("conflicting");
  expect(a.conflictValues).toHaveLength(2);
  expect(a.usualSource).toEqual(kind ? { value, kind } : null);
  expect(a.value).toBeNull();
  expect(result.readiness.status).toBe("blocked");
  expect(result.todo.items.filter((i: any) => i.assumptionId === a.id)).toEqual([{ kind: "conflict", fieldKey: field, itemKey: null, assumptionId: a.id, blocking: true }]);
});

test("a rent roll settles a unit count, never a rent", async () => {
  const { result } = await pair("Rent Roll", ["Type Units Rent", "1 bedroom 12 $1,500", "2 bedroom 8 $1,800", "Total 20"], "Pro Forma", ["Type Units Rent", "1 bedroom 14 $1,600", "2 bedroom 8 $1,800", "Total 22"]);
  for (const field of ["unit_count", "unit_rent_monthly"]) {
    const a = assumption(result, field, "1BR");
    expect(a.status).toBe("conflicting");
    expect(a.usualSource).toEqual(field === "unit_count" ? { value: 12, kind: "rent roll" } : null);
  }
});

test("background and evidence do not hold a kind", async () => {
  for (const role of ["context", "evidence"]) {
    const { id, document } = await pair("Agreement of Purchase and Sale", ["Land cost: $830,000"], "Project notes", ["Land cost: $900,000"]);
    if (role === "context") await upload(id, "proforma.txt", paper("Pro Forma", "Land cost: $950,000"));
    await call("POST", `/api/documents/${document}/role`, { role }); await settle();
    expect((await row(document)).read_role).toBe(`purchase agreement (${role}, set by a person)`);
    const a = assumption(await review(id), "land_cost");
    expect(a.status).toBe("conflicting");
    expect(a.conflictValues.map((v: any) => v.value).sort()).toEqual(role === "context" ? [900000, 950000] : [830000, 900000]);
    expect(a.usualSource).toBeNull();
  }
});

test("one value can have several documents, but two agreement values give no hint", async () => {
  for (const second of [830000, 850000]) {
    const { id } = await pair("Agreement of Purchase and Sale", ["Land cost: $830,000"], second === 830000 ? "Project notes" : "Agreement of Purchase and Sale", [`Land cost: $${second}`]);
    await upload(id, "proforma.txt", paper("Pro Forma", "Land cost: $950,000")); await settle();
    const a = assumption(await review(id), "land_cost");
    expect(a.usualSource).toEqual(second === 830000 ? { value: 830000, kind: "purchase agreement" } : null);
    if (second === 830000) expect(a.conflictValues.find((v: any) => v.value === 830000).documents).toEqual(expect.arrayContaining(["agreement.txt", "notes.txt"]));
  }
});

test("an earlier approval stays held and a conflict still prevents a run", async () => {
  const id = await deal();
  await upload(id, "notes.txt", paper("Project notes", "Land cost: $900,000")); await settle();
  let a = assumption(await review(id), "land_cost");
  expect(a.usualSource).toBeNull();
  await call("POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version });
  await upload(id, "agreement.txt", paper("Agreement of Purchase and Sale", "Land cost: $830,000")); await settle();
  a = assumption(await review(id), "land_cost");
  expect(a.conflictValues).toEqual(expect.arrayContaining([{ value: 900000, documents: ["Approved earlier"] }, { value: 830000, documents: ["agreement.txt"] }]));
  expect(a.usualSource).toEqual({ value: 830000, kind: "purchase agreement" });
  expect(a.value).toBe(900000);
  const res = await app.request(`/api/deals/${id}/runs`, { method: "POST", headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: "{}" });
  expect(res.status).toBe(409);
});

test("a resolved conflict has no usual source", async () => {
  const { id, result } = await pair("Agreement of Purchase and Sale", ["Land cost: $830,000"], "Project notes", ["Land cost: $900,000"]);
  const a = assumption(result, "land_cost");
  await call("POST", `/api/assumptions/${a.id}/review`, { action: "resolve", value: 830000, version: a.version });
  expect(assumption(await review(id), "land_cost").usualSource).toBeNull();
});

test("a person-set deal source counts, and the first matching kind wins within one value", async () => {
  const { id, document } = await pair("Term Sheet", ["Senior loan amount: $5,000,000"], "Pro Forma", ["Senior loan amount: $5,500,000"]);
  await call("POST", `/api/documents/${document}/role`, { role: "deal_source" });
  await upload(id, "commitment.txt", paper("Commitment Letter", "Senior loan amount: $5,000,000")); await settle();
  expect((await row(document)).read_role).toBe("term sheet (deal source, set by a person)");
  expect(assumption(await review(id), "senior_loan_amount").usualSource).toEqual({ value: 5000000, kind: "commitment letter" });
});
