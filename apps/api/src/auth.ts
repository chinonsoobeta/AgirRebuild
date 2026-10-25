import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "@agir/db";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const got = await scrypt(password, Buffer.from(salt, "base64"), 32, { ...PARAMS, N: Number(n) });
  const want = Buffer.from(key, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");
export const SESSION_DAYS = 14;

export type DeviceLabel = "Mac" | "iPhone" | "iPad" | "Android phone" | "Android tablet" | "Windows PC" | "Linux computer" | "Chromebook";

/** The kind of device a browser's user agent names, or null when it cannot tell. Never the browser or its version. */
export function deviceLabel(userAgent: string | undefined): DeviceLabel | null {
  const ua = (userAgent ?? "").slice(0, 512);
  if (!ua || /Windows Phone/i.test(ua)) return null;
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Windows NT/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Linux|X11/.test(ua)) return "Linux computer";
  return null;
}

/** Starts a session. `device` is the label from deviceLabel, never the user agent itself. */
export async function createSession(db: Db, userId: string, device?: DeviceLabel | null): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(`insert into sessions (token_hash, user_id, expires_at, device) values ($1, $2, now() + ($3 || ' days')::interval, $4)`, [
    tokenHash(token),
    userId,
    String(SESSION_DAYS),
    device ?? null,
  ]);
  return token;
}

export async function userForSession(db: Db, token: string | undefined): Promise<{ id: string; email: string; name: string } | null> {
  if (!token) return null;
  const [u] = await db.query<{ id: string; email: string; name: string }>(
    `select u.id, u.email, u.name from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`,
    [tokenHash(token)],
  );
  return u ?? null;
}

export async function endSession(db: Db, token: string | undefined) {
  if (token) await db.query(`delete from sessions where token_hash = $1`, [tokenHash(token)]);
}

/** The person's sessions that have not expired. */
export async function countSessions(db: Db, userId: string): Promise<number> {
  const [r] = await db.query<{ n: number }>(`select count(*)::int as n from sessions where user_id = $1 and expires_at > now()`, [userId]);
  return r?.n ?? 0;
}

/** The person's live sessions: the kind of device and when it signed in, the current one first, then newest first. Never a token or its hash. */
export async function listSessions(db: Db, userId: string, token: string | undefined): Promise<{ device: string | null; signedInAt: string; current: boolean }[]> {
  const rows = await db.query<{ device: string | null; created_at: string | Date; current: boolean }>(
    `select device, created_at, token_hash = $2 as current from sessions where user_id = $1 and expires_at > now() order by token_hash = $2 desc, created_at desc`,
    [userId, token ? tokenHash(token) : ""],
  );
  return rows.map((r) => ({ device: r.device, signedInAt: new Date(r.created_at).toISOString(), current: r.current }));
}

/** Ends every other session of the person, keeping the one with this token. Answers how many live ones ended. */
export async function endOtherSessions(db: Db, userId: string, token: string): Promise<number> {
  const rows = await db.query<{ live: boolean }>(`delete from sessions where user_id = $1 and token_hash <> $2 returning expires_at > now() as live`, [
    userId,
    tokenHash(token),
  ]);
  return rows.filter((r) => r.live).length;
}

/** A small fixed-window limiter for the sign-in endpoints. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.until < now) {
      if (hits.size > 10_000) {
        for (const [oldKey, entry] of hits) if (entry.until < now) hits.delete(oldKey);
      }
      hits.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}
