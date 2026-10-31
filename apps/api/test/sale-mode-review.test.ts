// Card F1: a reading for a field this deal's mode does not use is listed as not needed, never offered for approval.
import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain } from "@agir/worker";
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
let alice: Session, ws: string, solo: string;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", {
    method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email: "f1@example.com", name: "Dana Analyst", password: "correct horse battery" }),
  });
  alice = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
  ws = (await call(alice, "GET", "/api/me")).json.workspaces[0].id;
  solo = (await call(alice, "POST", "/api/workspaces", { name: "Solo", reviewMode: "solo" })).json.id;
});

const NOTE = ["Sales and rent note (invented)", "Presales: 50%", "Sales commission: 4%", "Rent per unit: $2,100 per month", "Exit cap rate: 5%", "End unit price: $899,900"].join("\n");
const ai = (field: string, item: string | null, value: number, unit: "%" | "$", line: number) =>
  ({ field, item, value, unit_seen: unit, file: "note.txt", location: `line ${line}`, quote: NOTE.split("\n")[line - 1]!, note: null, confidence: "high" as const });

const noteDeal = async (name: string, workspace = ws) => {
  const id = (await call(alice, "POST", `/api/workspaces/${workspace}/deals`, { name, assetType: "Townhomes", location: "Guelph", province: "ON" })).json.id;
  await call(alice, "PUT", `/api/deals/${id}/documents?name=note.txt`, undefined, new TextEncoder().encode(NOTE));
  return id;
};
const keys = (rows: { fieldKey: string }[]) => rows.map((r) => r.fieldKey).sort();

describe("card F1: Review offers only the readings this deal's mode uses", () => {
  test("a rental deal sets the sale readings aside, with the reason, and Approve all cannot reach them", async () => {
    const id = await noteDeal("Invented rental");
    await drain({ db, store, read: async () => ({ readings: [ai("sales_commission_pct", null, 4, "%", 3)], conflicts: [], not_used: [] }) });
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(keys(review.notNeeded)).toEqual(["presold_units_pct", "sales_commission_pct", "unit_sale_price"]);
    expect(new Set(review.notNeeded.map((n: any) => n.why))).toEqual(new Set(["This deal rents its units"]));
    expect(review.notNeeded.find((n: any) => n.fieldKey === "unit_sale_price")).toMatchObject({ itemKey: "End", value: 899900 });
    expect(review.notNeeded.find((n: any) => n.fieldKey === "sales_commission_pct")).toMatchObject({ value: 4, label: "Sales commission", sources: expect.arrayContaining([expect.objectContaining({ document_name: "note.txt", location: "line 3", rule: "ai" })]) });
    expect(keys(review.assumptions)).toEqual(["exit_cap_rate_pct", "unit_rent_monthly"]);
    expect(review.readiness.impossible).toEqual([]);
    const [doc] = (await call(alice, "GET", `/api/deals/${id}/documents`)).json;
    expect(doc).toMatchObject({ used_count: 2 });
    expect(doc.other_count).toBe(review.other.length + 3);
  });

  test("once the deal sells its units the rental readings are set aside instead, with no new reading", async () => {
    const id = await noteDeal("Invented sale", solo);
    await drain({ db, store, read: async () => ({ readings: [ai("exit_cap_rate_pct", null, 5, "%", 5)], conflicts: [], not_used: [] }) });
    expect((await call(alice, "POST", `/api/deals/${id}/values`, { fieldKey: "sell_units", value: 1, reason: "The homes are sold" })).status).toBe(200);
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(keys(review.notNeeded)).toEqual(["exit_cap_rate_pct", "unit_rent_monthly"]);
    expect(new Set(review.notNeeded.map((n: any) => n.why))).toEqual(new Set(["This deal sells its units"]));
    expect(keys(review.assumptions)).toEqual(["presold_units_pct", "sales_commission_pct", "sell_units", "unit_sale_price"]);
    expect(review.readiness.impossible).toEqual([]);
  });

  test("a failed AI reading of a field this mode does not use is not asked about", async () => {
    const id = await noteDeal("Invented rental, failed reading");
    await drain({ db, store, read: async () => ({ readings: [ai("deposit_pct", null, 12, "%", 2)], conflicts: [], not_used: [] }) });
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(review.aiReading.pleaseCheck).toEqual([]);
    expect(review.notNeeded.find((n: any) => n.fieldKey === "deposit_pct")).toMatchObject({ value: 12, why: "This deal rents its units", sources: [{ document_name: "note.txt", location: "line 2" }] });
  });

  test("a choice to sell still waiting for its second approver does not change the mode, as in readiness", async () => {
    const id = await noteDeal("Invented sale, waiting");
    await drain({ db, store, read: async () => ({ readings: [], conflicts: [], not_used: [] }) });
    expect((await call(alice, "POST", `/api/deals/${id}/values`, { fieldKey: "sell_units", value: 1, reason: "The homes are sold" })).json.status).toBe("awaiting_second_approval");
    const review = (await call(alice, "GET", `/api/deals/${id}/review`)).json;
    expect(keys(review.notNeeded)).toEqual(["presold_units_pct", "sales_commission_pct", "unit_sale_price"]);
  });
});
