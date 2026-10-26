import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { seedDemo } from "../src/seed.ts";
import { dbState, memoryState } from "../src/shared-state.ts";

// Card D: rate limits and run stops kept in the database, so every API process sees the same ones. Two dbState
// values over one database stand for two API processes. Nothing here runs inside a run's transaction (PGlite is one
// connection: a query there would wait for the run).
let db: Db;
let info: { userId: string; dealId: string };
const token = () => randomBytes(32).toString("base64url");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  await seedDemo(db, fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-"))), () => {});
  const [d] = await db.query<{ userId: string; dealId: string }>(`select created_by as "userId", id as "dealId" from deals where created_by is not null limit 1`);
  info = d!;
});
afterAll(async () => db.close());

describe("rate limits in the database", () => {
  test("a key over the limit is refused in every process, and other keys are not", async () => {
    const a = dbState(db), b = dbState(db);
    expect(await a.hit("signup:10.0.0.1", 2, 60 * 60_000)).toBe(true);
    expect(await b.hit("signup:10.0.0.1", 2, 60 * 60_000)).toBe(true);
    expect(await a.hit("signup:10.0.0.1", 2, 60 * 60_000)).toBe(false);
    expect(await b.hit("signup:10.0.0.1", 2, 60 * 60_000)).toBe(false);
    expect(await b.hit("signup:10.0.0.2", 2, 60 * 60_000)).toBe(true);
  });

  test("the window rolls over", async () => {
    const s = dbState(db);
    // Start just after a one-second window opens, so the three hits share it.
    await sleep(1000 - (Date.now() % 1000) + 20);
    expect(await s.hit("roll", 2, 1000)).toBe(true);
    expect(await s.hit("roll", 2, 1000)).toBe(true);
    expect(await s.hit("roll", 2, 1000)).toBe(false);
    await sleep(1000);
    expect(await s.hit("roll", 2, 1000)).toBe(true);
  });

  test("keys are stored hashed, and windows that ended more than an hour ago are deleted as it goes", async () => {
    await db.query(`insert into rate_limit_hits (key, window_start, hits) values ('old', now() - interval '2 hours', 5)`);
    await dbState(db).hit("reset:someone@example.com", 3, 60 * 60_000);
    const keys = (await db.query<{ key: string }>(`select key from rate_limit_hits`)).map((r) => r.key);
    expect(keys).not.toContain("old");
    expect(keys.some((k) => k.includes("someone"))).toBe(false);
  });
});

describe("run stops in the database", () => {
  test("a stop asked for in another process is seen by the process running the run", async () => {
    const runner = dbState(db), other = dbState(db), tok = token();
    expect(await runner.runs.start(tok, info)).toBe(true);
    expect(await runner.runs.start(tok, info)).toBe(false);
    expect(await runner.runs.stopRequested(tok)).toBe(false);
    await sleep(1100); // the runner caches its last answer for a second
    expect(await other.runs.requestStop(tok)).toBe("stopping");
    expect(await runner.runs.stopRequested(tok)).toBe(true);
    await runner.runs.end(tok);
    expect(await other.runs.requestStop(tok)).toBe("unknown");
    expect(await db.query(`select 1 from run_stops`)).toEqual([]);
  });

  test("an unknown token answers unknown", async () => {
    const s = dbState(db);
    expect(await s.runs.requestStop(token())).toBe("unknown");
    expect(await s.runs.stopRequested(token())).toBe(false);
  });

  test("a row older than two hours counts as no run, and its token can start again", async () => {
    const s = dbState(db), tok = token();
    expect(await s.runs.start(tok, info)).toBe(true);
    await db.query(`update run_stops set started_at = now() - interval '3 hours'`);
    expect(await s.runs.requestStop(tok)).toBe("unknown");
    expect(await dbState(db).runs.stopRequested(tok)).toBe(false);
    expect(await s.runs.start(tok, info)).toBe(true);
    await s.runs.end(tok);
  });

  test("the tables are not readable by agir_app", async () => {
    for (const table of ["rate_limit_hits", "run_stops"]) {
      await expect(db.transaction(async (tx) => {
        await tx.query(`set local role agir_app`);
        await tx.query(`select * from ${table}`);
      })).rejects.toThrow(/permission denied/);
    }
  });
});

describe("the memory state", () => {
  test("keeps today's behaviour in one process", async () => {
    const s = memoryState(), tok = token();
    expect(await s.hit("k", 1, 60_000)).toBe(true);
    expect(await s.hit("k", 1, 60_000)).toBe(false);
    expect(await s.runs.start(tok, info)).toBe(true);
    expect(await s.runs.start(tok, info)).toBe(false);
    expect(await s.runs.requestStop(tok)).toBe("stopping");
    expect(await s.runs.stopRequested(tok)).toBe(true);
    await s.runs.end(tok);
    expect(await s.runs.requestStop(tok)).toBe("unknown");
  });
});
