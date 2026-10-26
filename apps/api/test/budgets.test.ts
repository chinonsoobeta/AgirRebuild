import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";
import { DEMO, seedDemo } from "../src/seed.ts";

// Plan L5 and E18: payload and time budgets for the screens people open most, on the demo seed.
// A trip-wire, not a benchmark: each budget is several times what was measured on 2026-10-25,
// so only a large regression (a payload that grows by multiples, a review that slows by seconds) fails.
let db: Db;
let app: ReturnType<typeof createApp>;
let cookie = "";
const dealIds = new Map<string, string>();

async function get(path: string) {
  const t0 = performance.now();
  const res = await app.request(path, { headers: { cookie, "x-agir": "1" } });
  const body = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(body), ms: performance.now() - t0, json: JSON.parse(body) };
}

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
  await seedDemo(db, store, () => {});
  app = createApp({ db, store, secureCookies: false });
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email: DEMO.analyst.email, password: DEMO.analyst.password }),
  });
  expect(res.status).toBe(200);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const ws = (await get("/api/me")).json.workspaces[0].id as string;
  for (const d of (await get(`/api/workspaces/${ws}/deals`)).json as { deal: { id: string; name: string } }[]) dealIds.set(d.deal.name, d.deal.id);
}, 180_000);
afterAll(async () => {
  await db.close();
});

// Measured on 2026-10-25 on the six demo deals (bytes of the JSON body; ms on an Apple-silicon laptop, PGlite in
// memory, the slower of two calls). Each budget is about five times the largest measured value.
const BUDGET = {
  dealsList: 20_000, // measured 4,424 bytes for six deals
  deal: 4_000, // measured 677 to 803 bytes
  review: 200_000, // measured 31,295 to 42,984 bytes (Dominion Exchange, blocked with conflicts, is the largest)
  run: 400_000, // measured 87,228 to 90,221 bytes for the three runs the seed makes
  reviewMs: 1_000, // measured 6 to 10 ms
};

describe("payload and time budgets on the demo seed", () => {
  test("the deals list stays under its byte budget", async () => {
    const ws = (await get("/api/me")).json.workspaces[0].id as string;
    const list = await get(`/api/workspaces/${ws}/deals`);
    expect(list.status).toBe(200);
    expect(list.json).toHaveLength(6);
    expect(list.bytes).toBeLessThan(BUDGET.dealsList);
  });

  test("each deal and its review stay under their byte budgets, and the review answers in time", async () => {
    expect(dealIds.size).toBe(6);
    for (const [name, id] of dealIds) {
      const deal = await get(`/api/deals/${id}`);
      expect(deal.status, name).toBe(200);
      expect(deal.bytes, name).toBeLessThan(BUDGET.deal);
      // The first call warms PGlite's plans; the budget holds for both.
      for (let i = 0; i < 2; i++) {
        const review = await get(`/api/deals/${id}/review`);
        expect(review.status, name).toBe(200);
        expect(review.bytes, name).toBeLessThan(BUDGET.review);
        expect(review.ms, name).toBeLessThan(BUDGET.reviewMs);
      }
    }
  });

  test("each of the seed's runs stays under its byte budget", async () => {
    let runs = 0;
    for (const [name, id] of dealIds) {
      const list = (await get(`/api/deals/${id}/runs`)).json as { id: string }[];
      for (const r of list) {
        const run = await get(`/api/runs/${r.id}`);
        expect(run.status, name).toBe(200);
        expect(run.bytes, name).toBeLessThan(BUDGET.run);
        runs++;
      }
    }
    expect(runs).toBe(3);
  });
});
