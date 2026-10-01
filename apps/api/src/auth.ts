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

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)`, [
    tokenHash(token),
    userId,
    String(SESSION_DAYS),
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

/** A small fixed-window limiter for the sign-in endpoints. */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.until < now) {
      hits.set(key, { n: 1, until: now + windowMs });
      return true;
    }
    h.n++;
    return h.n <= limit;
  };
}
