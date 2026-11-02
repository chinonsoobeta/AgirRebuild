// Card 192: one odd label costs one reading, never the whole deal's reading. A reading of a field Agir does not have is
// never put to a person. The fake reader goes through the real format object's parse, because the SDK does in production.
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain, reconcileDeal } from "@agir/worker";
import { storedReadings } from "../../worker/src/reader.ts";
import { READING_FAILURE } from "@agir/extraction";
import { createApp } from "../src/app.ts";

let db: Db, app: ReturnType<typeof createApp>, cookie: string, ws: string;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-reader-labels-")));
const CAP = "The owners picture a buyer paying a 5.5% yield on the way out.";
const CAP_LATER = "A later note pictures a buyer paying a 6.5% yield instead.";
const RENT = "Studios would bring in $1,500 from each tenant every month.";
const PSF = "The shops would bring in $30 for each square foot every year.";
const OPEX = "Running the place would come to $1,500 for each home.";
const LAND = "The owners would pay $1,400,000 for the site.";
const TEXT = [CAP, CAP_LATER, RENT, PSF, OPEX, LAND].join("\n");
const at = (quote: string) => `line ${TEXT.split("\n").indexOf(quote) + 1}`;
const reading = (over: Record<string, unknown>, quote: string) => ({ item: null, file: "notes.txt", location: at(quote), quote, note: null, confidence: "high", ...over });
const cap = reading({ field: "exit_cap_rate_pct", value: 5.5, unit_seen: "%" }, CAP);
const reply = (readings: unknown[], conflicts: unknown[] = []) => ({ readings, conflicts, not_used: [] });
/** What messages.parse does with a model's reply. */
const sdk = (body: unknown) => vi.fn(async (request: any) => request.output_config.format.parse(JSON.stringify(body)));

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { cookie, "x-agir": "1", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200); return res.json() as Promise<any>;
}
const review = (deal: string) => call("GET", `/api/deals/${deal}/review`);
const latest = async (deal: string) => (await db.query<any>(`select * from ai_readings where deal_id=$1 order by created_at desc,id desc`, [deal]))[0];
async function read(body: unknown, reader = sdk(body)) {
  const deal = (await call("POST", `/api/workspaces/${ws}/deals`, { name: "Odd labels", assetType: "Multifamily" })).id as string;
  const res = await app.request(`/api/deals/${deal}/documents?name=notes.txt`, { method: "PUT", headers: { cookie, "x-agir": "1" }, body: new TextEncoder().encode(TEXT) });
  expect(res.status).toBe(200);
  await drain({ db, store, read: reader as any });
  return { deal, row: await latest(deal), reader };
}
beforeAll(async () => {
  db = await openPglite(); await migrate(db); app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" }, body: JSON.stringify({ email: "labels@example.com", name: "Labels", password: "correct horse battery" }) });
  expect(res.status).toBe(200); cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  ws = (await call("GET", "/api/me")).workspaces[0].id;
});
afterAll(async () => { await db.close(); });

test("the field's own unit on the monthly rent keeps the whole reply, with one paid call", async () => {
  const { deal, row, reader } = await read(reply([reading({ field: "unit_rent_monthly", item: "studio", value: 1500, unit_seen: "$/unit/mo" }, RENT), cap]));
  expect(row.outcome).toBe("ok");
  expect(reader).toHaveBeenCalledTimes(1);
  expect(row.verification.readings.map((r: any) => r.outcome)).toEqual(["verified", "verified"]);
  expect(row.verification.readings[0].candidate).toMatchObject({ value: 1500, unitSeen: "$" });
  expect((await review(deal)).assumptions.find((a: any) => a.fieldKey === "unit_rent_monthly")?.value).toBe(1500);
  expect((await review(deal)).assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct")?.value).toBe(5.5);
});
test("the field's own unit on the yearly area rent verifies as $/sf", async () => {
  const { row } = await read(reply([reading({ field: "rent_psf_annual", item: "shops", value: 30, unit_seen: "$/sf/yr" }, PSF)]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.readings[0]).toMatchObject({ outcome: "verified", candidate: { value: 30, unitSeen: "$/sf" } });
});
test("a monthly per-unit label on a yearly total fails alone", async () => {
  const { row } = await read(reply([reading({ field: "fixed_opex_annual", value: 1500, unit_seen: "$/unit/mo" }, OPEX), cap]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.readings.map((r: any) => r.outcome)).toEqual([READING_FAILURE.unit, "verified"]);
});
test("an invented label fails alone", async () => {
  const { row } = await read(reply([reading({ field: "land_cost", value: 1400000, unit_seen: "per year" }, LAND), cap]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.readings.map((r: any) => r.outcome)).toEqual([READING_FAILURE.unit, "verified"]);
});
test("a conflict value with an invented label fails alone, and the other value is kept and shown", async () => {
  const value = (quote: string, v: number, unit_seen: string) => ({ value: v, unit_seen, file: "notes.txt", location: at(quote), quote });
  const { deal, row } = await read(reply([], [{ field: "exit_cap_rate_pct", item: null, values: [value(CAP, 5.5, "%"), value(CAP_LATER, 6.5, "points")], why: "Two notes differ" }]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.conflicts[0].map((r: any) => r.outcome)).toEqual(["verified", READING_FAILURE.unit]);
  const r = await review(deal);
  expect(r.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct")?.value).toBe(5.5);
  expect(r.aiReading.pleaseCheck).toMatchObject([{ field: "exit_cap_rate_pct", value: 6.5, reason: READING_FAILURE.unit }]);
});
test("a confidence we cannot understand counts as low and asks for a check when it is the only source", async () => {
  const { deal, row } = await read(reply([{ ...cap, confidence: "very high" }]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.readings[0].candidate.confidence).toBe("low");
  const a = (await review(deal)).assumptions.find((x: any) => x.fieldKey === "exit_cap_rate_pct");
  expect(a.sources.map((s: any) => s.check_note)).toContain("Please check: every source is a low-confidence AI reading");
});
test("a field Agir does not have is never put to a person, and stays in the stored reply", async () => {
  const stranger = reading({ field: "not_a_field", value: 1400000, unit_seen: "$" }, LAND);
  const conflict = { field: "not_a_field_either", item: null, values: [{ value: 5.5, unit_seen: "%", file: "notes.txt", location: at(CAP), quote: CAP }], why: "Odd" };
  const { deal, row } = await read(reply([stranger, cap], [conflict]));
  expect(row.outcome).toBe("ok");
  expect(row.verification.readings[0].outcome).toBe(READING_FAILURE.field);
  expect(row.verification.conflicts[0][0].outcome).toBe(READING_FAILURE.field);
  const r = await review(deal);
  const strangers = (x: { field?: string; fieldKey?: string }) => /^not_a_field/.test(x.field ?? x.fieldKey ?? "");
  expect(r.aiReading.pleaseCheck.filter(strangers)).toEqual([]);
  expect(r.notNeeded.filter(strangers)).toEqual([]);
  expect(r.todo.items.filter(strangers)).toEqual([]);
  expect(row.response.readings[0].field).toBe("not_a_field");
  expect(row.response.conflicts[0].field).toBe("not_a_field_either");
});
test("a real field that fails its quote check is still put to a person", async () => {
  const { deal } = await read(reply([reading({ field: "hard_cost", value: 9000000, unit_seen: "$", quote: "This sentence is nowhere" }, LAND)]));
  const r = await review(deal);
  expect(r.aiReading.pleaseCheck).toMatchObject([{ field: "hard_cost", reason: READING_FAILURE.quote }]);
  expect(r.todo.items.filter((i: any) => i.kind === "ai_check")).toMatchObject([{ fieldKey: "hard_cost" }]);
});
test("replaying a stored reply with an odd label gives the same result", async () => {
  // Written as a canonical reading, then the stored reply is given the label: the replay path alone, with no reader in it.
  const { deal, row } = await read(reply([reading({ field: "unit_rent_monthly", item: "studio", value: 1500, unit_seen: "$" }, RENT), cap]));
  const before = await storedReadings(db, store, deal);
  expect(before.map(c => c.fieldKey).sort()).toEqual(["exit_cap_rate_pct", "unit_rent_monthly"]);
  const odd = { ...row.response, readings: [{ ...row.response.readings[0], unit_seen: "$/unit/mo" }, row.response.readings[1]] };
  await db.query(`update ai_readings set response=$2 where id=$1`, [row.id, JSON.stringify(odd)]);
  await reconcileDeal(db, store, deal);
  expect((await latest(deal)).response.readings[0].unit_seen).toBe("$/unit/mo");
  expect(await storedReadings(db, store, deal)).toEqual(before);
  expect((await latest(deal)).verification.readings.map((r: any) => r.outcome)).toEqual(["verified", "verified"]);
});
test("the format sent to the API has plain strings with guidance, and refuses extra properties at each level", async () => {
  const { reader } = await read(reply([cap]));
  const sent = (reader.mock.calls[0]![0] as any).output_config.format.schema;
  const resolve = (s: any) => s.$ref ? sent.$defs[s.$ref.replace("#/$defs/", "")] : s;
  const item = sent.properties.readings.items, conflict = sent.properties.conflicts.items, value = conflict.properties.values.items;
  for (const label of [item.properties.unit_seen, value.properties.unit_seen, item.properties.confidence].map(resolve)) {
    expect(label.type).toBe("string");
    expect(label.enum).toBeUndefined();
    expect(label.description).toMatch(/^One of: /);
  }
  expect(resolve(item.properties.unit_seen).description).toContain("vacancy_%");
  expect(resolve(item.properties.confidence).description).toContain("medium");
  for (const level of [sent, item, conflict, value, sent.properties.not_used.items]) expect(level.additionalProperties).toBe(false);
});
