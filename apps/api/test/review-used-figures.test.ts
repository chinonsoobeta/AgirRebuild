// QA run 2, card D2: the review's unused figures, rejecting a stated value, and the documents' counts.
import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, type ReaderRequest } from "@agir/worker";
import { createApp } from "../src/app.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
type Session = { cookie: string };
async function call(s: Session, method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const headers: Record<string, string> = { "x-agir": "1", cookie: s.cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
let alice: Session, ws: string;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", {
    method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email: "d2@example.com", name: "Dana Analyst", password: "correct horse battery" }),
  });
  alice = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
  ws = (await call(alice, "GET", "/api/me")).json.workspaces[0].id;
});

const ROLL = ["Rent roll (invented)", "8 × One-bedroom $1,650 / month each", "4 × Two-bedroom $2,100 / month each", "Parking stalls 9"].join("\n");
const reading = (field: string, item: string | null, value: number, unit: "units" | "$", line: number) =>
  ({ field, item, value, unit_seen: unit, file: "rent-roll.txt", location: `line ${line}`, quote: ROLL.split("\n")[line - 1]!, note: null, confidence: "high" as const });

const rollDeal = async (name: string) => {
  const id = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name, assetType: "Multifamily", location: "Halifax", province: "NS" })).json.id;
  await call(alice, "PUT", `/api/deals/${id}/documents?name=rent-roll.txt`, undefined, new TextEncoder().encode(ROLL));
  return id;
};
const figures = (review: any) => review.other.map((o: any) => [o.location, o.raw]);

describe("card D2: figures a reader used are not listed as unused (skeptic N1)", () => {
  test("rent-roll figures the AI reading made values leave the unused list; the rest stay", async () => {
    const id = await rollDeal("Invented Roll");
    await drain({ db, store, read: async (_r: ReaderRequest) => ({ readings: [
      reading("unit_count", "one-bedroom", 8, "units", 2), reading("unit_rent_monthly", "one-bedroom", 1650, "$", 2),
      reading("unit_count", "two-bedroom", 4, "units", 3),
    ], conflicts: [], not_used: [] }) });
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(review.assumptions.filter((a: any) => a.sources.some((s: any) => s.rule === "ai")).map((a: any) => a.value).sort()).toEqual([1650, 4, 8]);
    expect(figures(review)).toEqual([["line 4", "9"]]);
    const [doc] = (await call(alice, "GET", `/api/deals/${id}/documents`)).json;
    // One value the rules read (2BR rent) and three the AI reading read, all from this file; one figure left unused.
    expect(doc).toMatchObject({ candidate_count: 1, used_count: 4, other_count: 1 });
  });
  test("with no AI reading the same figures are unused, each on the line it is written on", async () => {
    const id = await rollDeal("Invented Roll, rules only");
    await drain({ db, store, read: async () => ({ readings: [], conflicts: [], not_used: [] }) });
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(figures(review)).toEqual([["line 2", "8 ×"], ["line 2", "$1,650 / month"], ["line 3", "4 ×"], ["line 4", "9"]]);
    const [doc] = (await call(alice, "GET", `/api/deals/${id}/documents`)).json;
    expect(doc).toMatchObject({ candidate_count: 1, used_count: 1, other_count: 4 });
  });
  test("a figure a person labelled stays listed with its label", async () => {
    const id = await rollDeal("Invented Roll, labelled");
    await drain({ db, store, read: async () => ({ readings: [], conflicts: [], not_used: [] }) });
    const parking = (await call(alice, "GET", `/api/deals/${id}/review`)).json.other.find((o: any) => o.raw === "9");
    expect((await call(alice, "POST", `/api/deals/${id}/figure-labels`, { documentId: parking.documentId, figureId: parking.figureId, fieldKey: "other_income_annual" })).status).toBe(200);
    await drain({ db, store, read: async () => ({ readings: [], conflicts: [], not_used: [] }) });
    const after = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(after.assumptions.some((a: any) => a.fieldKey === "other_income_annual" && a.sources.some((s: any) => s.raw === "9"))).toBe(true);
    expect(after.other.find((o: any) => o.raw === "9")?.label).toMatchObject({ fieldKey: "other_income_annual" });
  });
});

describe("card D2: rejecting a value a document states needs a reason (breaker #21, N7)", () => {
  const BUDGET = ["Development budget (invented)", "Land cost: $1,650,000", "Property tax (per year): $38,000"].join("\n");
  const setup = async () => {
    const id = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Invented Kingsway", assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    await call(alice, "PUT", `/api/deals/${id}/documents?name=budget.txt`, undefined, new TextEncoder().encode(BUDGET));
    await drain({ db, store, read: async () => ({ readings: [], conflicts: [], not_used: [] }) });
    return id;
  };
  const field = async (id: string, key: string) => (await call(alice, "GET", `/api/deals/${id}/review`)).json.assumptions.find((a: any) => a.fieldKey === key);
  test("no reason or a short one is refused; a written reason is stored as the action's reason", async () => {
    const id = await setup();
    const tax = await field(id, "property_tax_annual");
    expect(tax.sources).toHaveLength(1);
    for (const reason of [undefined, null, "  too short  "]) {
      const r = await call(alice, "POST", `/api/assumptions/${tax.id}/review`, { action: "reject", reason, version: tax.version });
      expect(r.status).toBe(422);
      expect(r.json.error).toBe("A document states this value; to reject it, say why (at least 10 characters).");
    }
    expect((await field(id, "property_tax_annual")).status).toBe("needs_review");
    expect((await call(alice, "POST", `/api/assumptions/${tax.id}/review`, { action: "reject", reason: "The tax line is last year's bill", version: tax.version })).status).toBe(200);
    const after = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(after.assumptions.find((a: any) => a.fieldKey === "property_tax_annual")).toMatchObject({ status: "rejected", reason: "The tax line is last year's bill", value: 38000 });
    // Optional: it is not missing; the web lists it as rejected on Review, from the rejected value and this not-found line.
    expect(after.notFound.map((m: any) => m.fieldKey)).toContain("property_tax_annual");
    expect(after.readiness.missing.map((m: any) => m.fieldKey)).not.toContain("property_tax_annual");
    const events = await db.query<any>(`select payload from audit_events where deal_id=$1 and action like 'assumption.%' order by seq desc limit 1`, [id]);
    expect(JSON.stringify(events[0]?.payload)).toContain("The tax line is last year's bill");
  });
  test("a required value rejected with a reason is missing, as before", async () => {
    const id = await setup();
    const land = await field(id, "land_cost");
    expect((await call(alice, "POST", `/api/assumptions/${land.id}/review`, { action: "reject", reason: "Land price is still under negotiation", version: land.version })).status).toBe(200);
    expect((await call(alice, "GET", `/api/deals/${id}/review`)).json.readiness.missing.map((m: any) => m.fieldKey)).toContain("land_cost");
  });
  test("a value no document states is rejected without a reason, as before", async () => {
    const id = await setup();
    expect((await call(alice, "POST", `/api/deals/${id}/values`, { fieldKey: "other_income_annual", value: 9600, reason: "Sponsor call on parking income" })).status).toBe(200);
    const own = await field(id, "other_income_annual");
    expect(own.sources).toEqual([]);
    expect((await call(alice, "POST", `/api/assumptions/${own.id}/review`, { action: "reject", version: own.version })).status).toBe(200);
  });
});
