// Rate limits and the streamed runs in progress (card D). With one API process they can live in its memory; with
// several behind a load balancer they must be shared, or a limit is per process and a stop can reach a process that
// is not running the run. `memoryState` is the first, `dbState` keeps both in Postgres (migration 0038).
import type { Db } from "@agir/db";
import { rateLimiter, tokenHash } from "./auth.ts";

export type RunInfo = { userId: string; dealId: string };
export type SharedState = {
  /** Counts one request for `key` and answers whether it is within `limit` for the window. */
  hit(key: string, limit: number, windowMs: number): Promise<boolean>;
  runs: {
    /** False when a run with this token is already in progress. */
    start(token: string, info: RunInfo): Promise<boolean>;
    stopRequested(token: string): Promise<boolean>;
    requestStop(token: string): Promise<"stopping" | "unknown">;
    end(token: string): Promise<void>;
  };
};

/** One limiter: its own name, so two limiters never share a key. */
export const limiter = (state: SharedState, name: string, limit: number, windowMs: number) =>
  (key: string) => state.hit(`${name}:${key}`, limit, windowMs);

/** Everything in this process's memory: for embedded PGlite, which is one process by definition. */
export function memoryState(): SharedState {
  // One limiter of today's kind for each limit and window; keys carry the limiter's name, so they never collide.
  const limiters = new Map<string, (key: string) => boolean>();
  const runs = new Map<string, RunInfo & { stopRequested: boolean }>();
  return {
    async hit(key, limit, windowMs) {
      const at = `${limit}/${windowMs}`;
      if (!limiters.has(at)) limiters.set(at, rateLimiter(limit, windowMs));
      return limiters.get(at)!(key);
    },
    runs: {
      async start(token, info) {
        if (runs.has(token)) return false;
        runs.set(token, { ...info, stopRequested: false });
        return true;
      },
      async stopRequested(token) { return runs.get(token)?.stopRequested ?? false; },
      async requestStop(token) {
        const run = runs.get(token);
        if (!run) return "unknown";
        run.stopRequested = true;
        return "stopping";
      },
      async end(token) { runs.delete(token); },
    },
  };
}

/**
 * Both in Postgres, through the functions of migration 0038. `db` must be the pool, not a transaction: a run asks
 * whether it was stopped while its own transaction is open, and the pool answers on another connection. Keys and run
 * tokens are stored hashed. A run checks at every stage; the last answer is kept for a second so a run makes at most
 * one query a second.
 */
export function dbState(db: Db): SharedState {
  const asked = new Map<string, { at: number; stop: boolean }>();
  return {
    async hit(key, limit, windowMs) {
      const [r] = await db.query<{ ok: boolean }>(`select fn_rate_hit($1, $2, $3::interval) as ok`, [tokenHash(key), limit, `${windowMs} milliseconds`]);
      return r!.ok;
    },
    runs: {
      async start(token, info) {
        const [r] = await db.query<{ ok: boolean }>(`select fn_run_start($1, $2, $3) as ok`, [tokenHash(token), info.userId, info.dealId]);
        return r!.ok;
      },
      async stopRequested(token) {
        const last = asked.get(token);
        if (last && (last.stop || Date.now() - last.at < 1000)) return last.stop;
        const [r] = await db.query<{ stop: boolean }>(`select fn_run_stop_requested($1) as stop`, [tokenHash(token)]);
        asked.set(token, { at: Date.now(), stop: r!.stop });
        return r!.stop;
      },
      async requestStop(token) {
        const [r] = await db.query<{ ok: boolean }>(`select fn_run_request_stop($1) as ok`, [tokenHash(token)]);
        return r!.ok ? "stopping" : "unknown";
      },
      async end(token) {
        asked.delete(token);
        await db.query(`select fn_run_end($1)`, [tokenHash(token)]);
      },
    },
  };
}
