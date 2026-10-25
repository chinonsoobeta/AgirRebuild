// Card U17: email verification and password reset. Tokens are 32 random bytes and codes six random digits; both are
// stored only as sha256 hashes and looked up or compared by hash. A token is single use and expires after 60 minutes.
// Nothing in the app is gated on verification: email_verified_at only records it (an owner decision).
import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Db } from "@agir/db";
import { createSession, hashPassword, PASSWORD_RULE, rateLimiter, userForSession } from "./auth.ts";
import type { Mailer } from "./mailer.ts";

type Kind = "verify_email" | "reset_password";
const TOKEN_MINUTES = 60;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export type EmailAuthDeps = {
  db: Db;
  mailer: Mailer;
  /** Where links point. Configured, never taken from a request header, so a request cannot point a link elsewhere. */
  publicOrigin: string;
  cookie: string;
  cookieOpts: Parameters<typeof setCookie>[3];
  clientKey: (c: Context<any>) => string;
};

/** Deletes the person's earlier tokens of this kind and stores a new one. Returns the token and code to send. */
async function issue(db: Db, userId: string, kind: Kind): Promise<{ token: string; code: string | null }> {
  const token = randomBytes(32).toString("base64url");
  const code = kind === "verify_email" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : null;
  await db.transaction(async (tx) => {
    await tx.query(`delete from email_tokens where user_id = $1 and kind = $2`, [userId, kind]);
    await tx.query(
      `insert into email_tokens (user_id, kind, token_hash, code_hash, expires_at) values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)`,
      [userId, kind, hash(token), code === null ? null : hash(code), String(TOKEN_MINUTES)],
    );
  });
  return { token, code };
}

/** Spends a live token of this kind, once: the update succeeds for exactly one caller. */
async function spend(db: Db, token: string, kind: Kind): Promise<string | null> {
  const [r] = await db.query<{ user_id: string }>(
    `update email_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id`,
    [hash(token), kind],
  );
  return r?.user_id ?? null;
}

function verifyMail(origin: string, token: string, code: string) {
  const link = `${origin}/verify?token=${token}`;
  return {
    subject: "Confirm your email address for Agir / Confirmez votre adresse courriel pour Agir",
    text: [
      "To confirm your email address, open this link:",
      link,
      `Or enter this code in Agir: ${code}`,
      `The link and the code work once, for ${TOKEN_MINUTES} minutes. If you did not create an Agir account, you can ignore this email.`,
      "",
      "Pour confirmer votre adresse courriel, ouvrez ce lien :",
      link,
      `Ou entrez ce code dans Agir : ${code}`,
      `Le lien et le code ne servent qu’une fois, pendant ${TOKEN_MINUTES} minutes. Si vous n’avez pas créé de compte Agir, ignorez ce courriel.`,
    ].join("\n"),
  };
}

function resetMail(origin: string, token: string) {
  const link = `${origin}/reset?token=${token}`;
  return {
    subject: "Reset your Agir password / Réinitialisez votre mot de passe Agir",
    text: [
      "To choose a new password, open this link:",
      link,
      `The link works once, for ${TOKEN_MINUTES} minutes. If you did not ask for this, you can ignore this email; your password has not changed.`,
      "",
      "Pour choisir un nouveau mot de passe, ouvrez ce lien :",
      link,
      `Le lien ne sert qu’une fois, pendant ${TOKEN_MINUTES} minutes. Si vous n’avez rien demandé, ignorez ce courriel ; votre mot de passe n’a pas changé.`,
    ].join("\n"),
  };
}

export function emailAuth({ db, mailer, publicOrigin, cookie, cookieOpts, clientKey }: EmailAuthDeps) {
  const origin = publicOrigin.replace(/\/+$/, "");
  const verifySendLimit = rateLimiter(5, 60 * 60_000); // per person
  const codeLimit = rateLimiter(10, 15 * 60_000); // per person
  const tokenLimit = rateLimiter(20, 60_000); // per address, for verify and reset
  const resetSendIpLimit = rateLimiter(10, 15 * 60_000); // per address
  const resetSendEmailLimit = rateLimiter(3, 60 * 60_000); // per email, whether or not it has an account
  const tooMany = (c: Context<any>) => c.json({ error: "Too many attempts. Wait a while and try again." }, 429);

  /** Sends a new verification email. A failure to send is logged without detail and never undoes the caller's work. */
  async function sendVerification(user: { id: string; email: string }) {
    const { token, code } = await issue(db, user.id, "verify_email");
    try { await mailer.send({ to: user.email, ...verifyMail(origin, token, code!) }); }
    catch { console.error(JSON.stringify({ at: new Date().toISOString(), event: "mail.failed", kind: "verify_email" })); }
  }

  function register(app: Hono<any>) {
    app.post("/api/auth/verify/send", async (c) => {
      const user = await userForSession(db, getCookie(c, cookie));
      if (!user) return c.json({ error: "Sign in to continue." }, 401);
      if (!verifySendLimit(user.id)) return tooMany(c);
      await sendVerification(user);
      return c.json({ ok: true });
    });

    app.post("/api/auth/verify", async (c) => {
      const body = z.union([z.object({ token: z.string().min(1).max(200) }).strict(), z.object({ code: z.string().regex(/^\d{6}$/) }).strict()]).parse(await c.req.json());
      let userId: string | null;
      if ("token" in body) {
        if (!tokenLimit(clientKey(c))) return tooMany(c);
        userId = await spend(db, body.token, "verify_email");
        if (!userId) return c.json({ error: "This link does not work any more. It may have been used or expired. Ask for a new one." }, 400);
      } else {
        const user = await userForSession(db, getCookie(c, cookie));
        if (!user) return c.json({ error: "Sign in to continue." }, 401);
        if (!codeLimit(user.id)) return tooMany(c);
        // Only the person's own live code counts; compare hashes in constant time, then spend that token once.
        const live = await db.query<{ token_hash: string; code_hash: string }>(
          `select token_hash, code_hash from email_tokens where user_id = $1 and kind = 'verify_email' and code_hash is not null and used_at is null and expires_at > now()`,
          [user.id],
        );
        const want = Buffer.from(hash(body.code));
        const match = live.find((t) => timingSafeEqual(Buffer.from(t.code_hash), want));
        const [spent] = match
          ? await db.query<{ user_id: string }>(`update email_tokens set used_at = now() where token_hash = $1 and used_at is null returning user_id`, [match.token_hash])
          : [];
        userId = spent?.user_id ?? null;
        if (!userId) return c.json({ error: "That code is not right, or it has expired. Check the latest email or ask for a new code." }, 400);
      }
      await db.query(`update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1`, [userId]);
      return c.json({ ok: true });
    });

    // The same answer whether or not the account exists. Both limits apply before the lookup, to every email alike.
    app.post("/api/auth/reset/send", async (c) => {
      const { email } = z.object({ email: z.string().email().max(320) }).parse(await c.req.json());
      const normalized = email.toLowerCase();
      if (!resetSendIpLimit(clientKey(c)) || !resetSendEmailLimit(normalized)) return tooMany(c);
      const [u] = await db.query<{ id: string; email: string }>(`select id, email from users where email = $1`, [normalized]);
      if (u) {
        const { token } = await issue(db, u.id, "reset_password");
        try { await mailer.send({ to: u.email, ...resetMail(origin, token) }); }
        catch { console.error(JSON.stringify({ at: new Date().toISOString(), event: "mail.failed", kind: "reset_password" })); }
      }
      return c.json({ ok: true });
    });

    app.post("/api/auth/reset", async (c) => {
      if (!tokenLimit(clientKey(c))) return tooMany(c);
      const body = z.object({ token: z.string().min(1).max(200), password: PASSWORD_RULE, signOutOthers: z.boolean() }).parse(await c.req.json());
      const passwordHash = await hashPassword(body.password);
      const userId = await db.transaction(async (tx) => {
        const id = await spend(tx, body.token, "reset_password");
        if (!id) return null;
        await tx.query(`update users set password_hash = $1 where id = $2`, [passwordHash, id]);
        // Any other reset link for this person stops working once the password has changed.
        await tx.query(`delete from email_tokens where user_id = $1 and kind = 'reset_password' and used_at is null`, [id]);
        if (body.signOutOthers) await tx.query(`delete from sessions where user_id = $1`, [id]);
        return id;
      });
      if (!userId) return c.json({ error: "This link does not work any more. It may have been used or expired. Ask for a new one." }, 400);
      setCookie(c, cookie, await createSession(db, userId), cookieOpts);
      return c.json({ ok: true });
    });
  }

  return { register, sendVerification };
}
