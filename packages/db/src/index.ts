// Database access for the API and the worker. One interface over PGlite
// (embedded Postgres, used for local development and tests) and node-postgres
// (any Postgres, including Supabase, in production). The SQL is the same.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIELDS } from "@agir/contracts";
import { sha256Hex } from "./storage.ts";

export type Row = Record<string, unknown>;

export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = join(import.meta.dirname, "../migrations");

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  const wrap = (q: { query: typeof pg.query }): Db => ({
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await q.query<T>(sql, params)).rows;
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      return pg.transaction((tx) => fn(wrap(tx as unknown as { query: typeof pg.query })));
    },
    async close() {
      await pg.close();
    },
  });
  return wrap(pg);
}

export async function openPostgres(url: string): Promise<Db> {
  const { default: pg } = await import("pg");
  // Return numeric and bigint columns as numbers where they fit.
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const client = (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await c.query(sql, params)).rows as T[];
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>) {
      const conn = await pool.connect();
      try {
        await conn.query("begin");
        const out = await fn(client(conn));
        await conn.query("commit");
        return out;
      } catch (e) {
        await conn.query("rollback");
        throw e;
      } finally {
        conn.release();
      }
    },
    async close() {
      await pool.end();
    },
  });
  // The returned Db queries through the pool, so its query runs on its own connection even while a transaction()
  // holds another: a run's stop check (card D) uses this.
  return client(pool);
}

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return openPostgres(url);
  return openPglite(process.env.AGIR_DATA_DIR ? join(process.env.AGIR_DATA_DIR, "pg") : undefined);
}

export function migrationFiles(): { name: string; sql: string; sha256: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    });
}

/**
 * Apply new migrations and refuse to start if an applied one has changed
 * (plan task R3). Then seed the field catalog from @agir/contracts.
 */
export async function migrate(db: Db): Promise<{ applied: string[] }> {
  await db.query(`create table if not exists schema_migrations (
    name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
  const done = new Map((await db.query<{ name: string; sha256: string }>(`select name, sha256 from schema_migrations`)).map((r) => [r.name, r.sha256]));
  const applied: string[] = [];
  for (const m of migrationFiles()) {
    const prior = done.get(m.name);
    if (prior) {
      if (prior !== m.sha256) throw new Error(`Migration ${m.name} was edited after it was applied. Add a new migration instead.`);
      continue;
    }
    await db.transaction(async (tx) => {
      for (const stmt of splitSql(m.sql)) await tx.query(stmt);
      await tx.query(`insert into schema_migrations (name, sha256) values ($1, $2)`, [m.name, m.sha256]);
    });
    applied.push(m.name);
  }
  for (const f of FIELDS) {
    await db.query(
      `insert into field_catalog (key, label, unit, itemized, material, min_value, max_value, is_integer, default_value)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (key) do update set label = excluded.label, unit = excluded.unit, itemized = excluded.itemized,
         material = excluded.material, min_value = excluded.min_value, max_value = excluded.max_value,
         is_integer = excluded.is_integer, default_value = excluded.default_value`,
      [f.key, f.label, f.unit, Boolean(f.itemized), f.material, f.min ?? null, f.max ?? null, Boolean(f.integer), f.default ?? null],
    );
  }
  return { applied };
}

/** Split a migration into statements, keeping $$-quoted bodies whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  let inLineComment = false;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const two = sql.slice(i, i + 2);
    if (inLineComment) {
      cur += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (!inDollar && !inQuote && two === "--") {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (!inQuote && two === "$$") {
      inDollar = !inDollar;
      cur += two;
      i++;
      continue;
    }
    if (!inDollar && ch === "'") inQuote = !inQuote;
    if (!inDollar && !inQuote && ch === ";") {
      if (cur.replace(/--[^\n]*/g, "").trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.replace(/--[^\n]*/g, "").trim()) out.push(cur.trim());
  return out;
}

/**
 * Run `fn` as a signed-in user: inside one transaction, as the agir_app role,
 * with agir.user_id set, so row-level security and the governed functions see
 * exactly this caller.
 */
export async function asUser<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('agir.user_id', $1, true)`, [userId]);
    await tx.query(`set local role agir_app`);
    return fn(tx);
  });
}

export { fileStore, sha256Hex, type BlobStore } from "./storage.ts";

/** A deal's unretired documents, as the AI reader keys its stored reading on them (card 160a). */
export const currentDocuments = (db: Db, dealId: string) =>
  db.query<{ id: string; name: string; sha256: string; storage_key: string; stage: string; role_set: "deal_source" | "evidence" | "context" | null }>(`select id, name, sha256, storage_key, stage, role_set from documents where deal_id=$1 and retired_at is null order by id`, [dealId]);
/** sha-256 over sorted document ids, content hashes, and any explicitly set roles. */
export const documentsHash = (docs: readonly { id: string; sha256: string; role_set?: "deal_source" | "evidence" | "context" | null }[]) =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(docs.map(d => d.role_set == null ? [d.id, d.sha256] : [d.id, d.sha256, d.role_set]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))));
