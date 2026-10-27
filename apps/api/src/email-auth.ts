// Card U17: email verification and password reset. Tokens are 32 random bytes and codes six random digits; both are
// stored only as sha256 hashes and looked up or compared by hash. A token is single use and expires after 60 minutes.
// Nothing in the app is gated on verification: email_verified_at only records it (an owner decision).
// Card R6 adds changing the address: a change_email token sent to the new address, and an undo_email_change token that
// the old address keeps for 7 days. Both carry the address they concern in email_tokens.email.
import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { Db } from "@agir/db";
import { checkPassword, createSession, deviceLabel, hashPassword, PASSWORD_RULE, userForSession } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { Mailer } from "./mailer.ts";
import { limiter, type SharedState } from "./shared-state.ts";

type Kind = "verify_email" | "reset_password" | "change_email" | "undo_email_change";
const TOKEN_MINUTES = 60;
const UNDO_DAYS = 7;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const TAKEN = "An account with that email already exists.";
const DEAD_LINK = "This link does not work any more. It may have been used or expired. Ask for a new one.";
/** An undo link cannot be asked for again, so its dead-link sentence does not say to. */
const UNDO_DEAD = "This link does not work any more. It may have been used already, or be more than 7 days old.";
/**
 * Stored in place of a password hash when an undo turns the password off. checkPassword accepts only values that start
 * with "scrypt$", so no password signs in until the person chooses a new one through the reset link.
 */
const PASSWORD_OFF = "off";

/**
 * True when the address belongs to another account, or another account's live, unused undo link would put it back.
 * The second part is the 7-day hold: nobody can take an address its former owner may still reclaim.
 */
export async function addressTaken(db: Db, email: string, exceptUserId?: string): Promise<boolean> {
  const [r] = await db.query<{ taken: boolean }>(
    `select exists (select 1 from users where email = $1 and id is distinct from $2::uuid)
         or exists (select 1 from email_tokens where kind = 'undo_email_change' and email = $1 and used_at is null
                      and expires_at > now() and user_id is distinct from $2::uuid) as taken`,
    [email, exceptUserId ?? null],
  );
  return r?.taken ?? false;
}

/** Raised inside a transaction when the address turned out to be taken, so the transaction (and the spent token) rolls back. */
class AddressTaken extends Error {}
/** The address is taken: by the hold, or by another account (a unique-index race, code 23505). */
const isTaken = (e: unknown) => e instanceof AddressTaken || (e as { code?: string }).code === "23505";

export type EmailAuthDeps = {
  db: Db;
  mailer: Mailer;
  /** Where links point. Configured, never taken from a request header, so a request cannot point a link elsewhere. */
  publicOrigin: string;
  cookie: string;
  cookieOpts: Parameters<typeof setCookie>[3];
  clientKey: (c: Context<any>) => string;
  log: Logger;
  alert: Logger;
  /** Where the rate limits are counted (card D). */
  state: SharedState;
};

/**
 * Stores a new token and returns it, with a code for verify_email. `held` gives the address a change_email or
 * undo_email_change token carries, and its lifetime when it is not 60 minutes. It opens no transaction of its own, so it
 * can be part of the caller's.
 */
async function addToken(q: Db, userId: string, kind: Kind, held?: { email: string; minutes?: number }): Promise<{ token: string; code: string | null }> {
  const token = randomBytes(32).toString("base64url");
  const code = kind === "verify_email" ? String(randomInt(0, 1_000_000)).padStart(6, "0") : null;
  await q.query(
    `insert into email_tokens (user_id, kind, token_hash, code_hash, email, expires_at) values ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
    [userId, kind, hash(token), code === null ? null : hash(code), held?.email ?? null, String(held?.minutes ?? TOKEN_MINUTES)],
  );
  return { token, code };
}

/**
 * Deletes the person's earlier tokens of this kind and stores a new one. Returns the token and code to send. Undo links
 * are never replaced this way: the confirm route adds them (see there).
 */
async function issue(db: Db, userId: string, kind: Exclude<Kind, "undo_email_change">, held?: { email: string }) {
  return db.transaction(async (tx) => {
    await tx.query(`delete from email_tokens where user_id = $1 and kind = $2`, [userId, kind]);
    return addToken(tx, userId, kind, held);
  });
}

/** Spends a live token of this kind, once: the update succeeds for exactly one caller. */
async function spend(db: Db, token: string, kind: Kind): Promise<string | null> {
  const [r] = await db.query<{ user_id: string }>(
    `update email_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id`,
    [hash(token), kind],
  );
  return r?.user_id ?? null;
}

/** Spends a live change or undo token once, like spend, and returns what it carries. created_at is text, to keep its microseconds. */
async function spendHeld(db: Db, token: string, kind: "change_email" | "undo_email_change") {
  const [r] = await db.query<{ user_id: string; email: string; created_at: string }>(
    `update email_tokens set used_at = now() where token_hash = $1 and kind = $2 and used_at is null and expires_at > now() returning user_id, email, created_at::text as created_at`,
    [hash(token), kind],
  );
  return r ?? null;
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

function changeMail(origin: string, token: string) {
  const link = `${origin}/email/confirm?token=${token}`;
  return {
    subject: "Confirm your new email address for Agir / Confirmez votre nouvelle adresse courriel pour Agir",
    text: [
      "To use this address for your Agir account, open this link:",
      link,
      `The link works once, for ${TOKEN_MINUTES} minutes. Until it is opened, the account keeps its current address. If you did not ask for this, you can ignore this email.`,
      "",
      "Pour utiliser cette adresse avec votre compte Agir, ouvrez ce lien :",
      link,
      `Le lien ne sert qu’une fois, pendant ${TOKEN_MINUTES} minutes. D’ici là, le compte garde son adresse actuelle. Si vous n’avez rien demandé, ignorez ce courriel.`,
    ].join("\n"),
  };
}

function changedMail(origin: string, token: string, newEmail: string) {
  const link = `${origin}/email/undo?token=${token}`;
  return {
    subject: "Your Agir email address was changed / L’adresse courriel de votre compte Agir a changé",
    text: [
      `Your Agir account now uses ${newEmail}. If you made this change, there is nothing to do.`,
      `If you did not, open this link within ${UNDO_DAYS} days. It puts this address back, signs every device out and sends you a link to choose a new password:`,
      link,
      "",
      `Votre compte Agir utilise maintenant ${newEmail}. Si vous avez fait cette modification, vous n’avez rien à faire.`,
      `Sinon, ouvrez ce lien d’ici ${UNDO_DAYS} jours. Il rétablit cette adresse, déconnecte tous les appareils et vous envoie un lien pour choisir un nouveau mot de passe :`,
      link,
    ].join("\n"),
  };
}

export function emailAuth({ db, mailer, publicOrigin, cookie, cookieOpts, clientKey, state, log, alert }: EmailAuthDeps) {
  const origin = publicOrigin.replace(/\/+$/, "");
  const verifySendLimit = limiter(state, "verify-send", 5, 60 * 60_000); // per person
  const codeLimit = limiter(state, "code", 10, 15 * 60_000); // per person
  const tokenLimit = limiter(state, "email-token", 20, 60_000); // per address, for verify and reset
  const resetSendIpLimit = limiter(state, "reset-send-ip", 10, 15 * 60_000); // per address
  const resetSendEmailLimit = limiter(state, "reset-send-email", 3, 60 * 60_000); // per email, whether or not it has an account
  const changeLimit = limiter(state, "email-change", 5, 60 * 60_000); // per person, counted before the password check, so it also limits guessing
  const tooMany = (c: Context<any>) => c.json({ error: "Too many attempts. Wait a while and try again." }, 429);
  const taken = (c: Context<any>) => c.json({ error: TAKEN }, 409);
  /** Added to an answer when no mail provider is configured (card B): the token is made, and simply not delivered. */
  const unsent = mailer.configured ? {} : { sent: false as const };
  /** Sends a mail; a failure is logged and alerted with the kind only (no address, no link) and never undoes the caller's work. */
  async function mail(kind: Kind, m: { to: string; subject: string; text: string }) {
    try { await mailer.send(m); }
    catch { log("mail.failed", { kind }); alert("mail.failed", { kind }); }
  }

  /** Sends a new verification email. A failure to send is logged without detail and never undoes the caller's work. */
  async function sendVerification(user: { id: string; email: string }) {
    const { token, code } = await issue(db, user.id, "verify_email");
    await mail("verify_email", { to: user.email, ...verifyMail(origin, token, code!) });
  }

  function register(app: Hono<any>) {
    app.post("/api/auth/verify/send", async (c) => {
      const user = await userForSession(db, getCookie(c, cookie));
      if (!user) return c.json({ error: "Sign in to continue." }, 401);
      if (!(await verifySendLimit(user.id))) return tooMany(c);
      await sendVerification(user);
      return c.json({ ok: true, ...unsent });
    });

    app.post("/api/auth/verify", async (c) => {
      const body = z.union([z.object({ token: z.string().min(1).max(200) }).strict(), z.object({ code: z.string().max(40).transform((c) => c.replace(/\s/g, "")).pipe(z.string().regex(/^\d{6}$/)) }).strict()]).parse(await c.req.json());
      let userId: string | null;
      if ("token" in body) {
        if (!(await tokenLimit(clientKey(c)))) return tooMany(c);
        userId = await spend(db, body.token, "verify_email");
        if (!userId) return c.json({ error: "This link does not work any more. It may have been used or expired. Ask for a new one." }, 400);
      } else {
        const user = await userForSession(db, getCookie(c, cookie));
        if (!user) return c.json({ error: "Sign in to continue." }, 401);
        if (!(await codeLimit(user.id))) return tooMany(c);
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
      if (!(await resetSendIpLimit(clientKey(c))) || !(await resetSendEmailLimit(normalized))) return tooMany(c);
      const [u] = await db.query<{ id: string; email: string }>(`select id, email from users where email = $1`, [normalized]);
      if (u) {
        const { token } = await issue(db, u.id, "reset_password");
        await mail("reset_password", { to: u.email, ...resetMail(origin, token) });
      }
      // sent depends on the server only, so the answer still says nothing about whether the account exists.
      return c.json({ ok: true, ...unsent });
    });

    app.post("/api/auth/reset", async (c) => {
      if (!(await tokenLimit(clientKey(c)))) return tooMany(c);
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
      setCookie(c, cookie, await createSession(db, userId, deviceLabel(c.req.header("user-agent"))), cookieOpts);
      return c.json({ ok: true });
    });

    // Changing the address (card R6). The route checks the session itself, like verify/send, because these routes are
    // registered before the app's session middleware.
    app.post("/api/me/email", async (c) => {
      const user = await userForSession(db, getCookie(c, cookie));
      if (!user) return c.json({ error: "Sign in to continue." }, 401);
      if (!(await changeLimit(user.id))) return tooMany(c);
      const body = z.object({ email: z.string().email().max(320), password: z.string().max(1000) }).parse(await c.req.json());
      const email = body.email.toLowerCase();
      const [u] = await db.query<{ password_hash: string; verified: boolean }>(
        `select password_hash, email_verified_at is not null as verified from users where id = $1`, [user.id]);
      // The current password first, so someone holding only the session learns nothing, not even whether an address has
      // an account. 403, not 401: the web treats a 401 as signed out.
      if (!u || !(await checkPassword(body.password, u.password_hash))) return c.json({ error: "That password is not right." }, 403);
      if (email === user.email) return c.json({ error: "That is already your email address." }, 422);
      if (await addressTaken(db, email, user.id)) return taken(c);

      if (!u.verified) {
        // Nobody has proved they own the current address, so nothing is lost by switching at once. Verification and reset
        // links sent to it stop working: the address may be a stranger's (mistyped), so it must not be able to reset the
        // password. The old address is not told, for the same reason.
        try {
          await db.transaction(async (tx) => {
            await tx.query(`update users set email = $1 where id = $2`, [email, user.id]);
            await tx.query(`delete from email_tokens where user_id = $1 and kind in ('verify_email', 'reset_password')`, [user.id]);
          });
        } catch (e) {
          if (isTaken(e)) return taken(c);
          throw e;
        }
        await sendVerification({ id: user.id, email });
        return c.json({ changed: true, ...unsent });
      }

      // A confirmed address changes only when the new one is confirmed: until the link is opened, nothing changes.
      // Asking again replaces the earlier link (issue deletes it).
      const { token } = await issue(db, user.id, "change_email", { email });
      await mail("change_email", { to: email, ...changeMail(origin, token) });
      return c.json({ pending: true, ...unsent });
    });

    // Opening the link sent to the new address: no session needed, it may be opened on any device.
    app.post("/api/auth/email/confirm", async (c) => {
      if (!(await tokenLimit(clientKey(c)))) return tooMany(c);
      const { token } = z.object({ token: z.string().min(1).max(200) }).parse(await c.req.json());
      let done: { newEmail: string; oldEmail: string; undo: string | null } | null;
      try {
        done = await db.transaction(async (tx) => {
          const t = await spendHeld(tx, token, "change_email");
          if (!t) return null;
          // The address may have been taken, or put on hold, since the link was sent; rolling back keeps the link unspent.
          if (await addressTaken(tx, t.email, t.user_id)) throw new AddressTaken();
          const [old] = await tx.query<{ email: string; verified: boolean }>(
            `select email, email_verified_at is not null as verified from users where id = $1 for update`, [t.user_id]);
          // Opening the link proves the new address, so it is confirmed now. Sessions stay signed in.
          await tx.query(`update users set email = $1, email_verified_at = now() where id = $2`, [t.email, t.user_id]);
          // Verification links and codes were for the old address; they no longer mean anything.
          await tx.query(`delete from email_tokens where user_id = $1 and kind = 'verify_email'`, [t.user_id]);
          // A confirmed address that is replaced keeps a way back for 7 days: the answer to someone who took over the
          // session and knew the password. The undo link is stored in this transaction, so the change never happens without
          // it and the old address is held from the moment it is released. Earlier undo links are kept: each confirmed
          // change leaves its own way back, and the oldest one wins (see the undo route).
          const undo = old!.verified ? await addToken(tx, t.user_id, "undo_email_change", { email: old!.email, minutes: UNDO_DAYS * 24 * 60 }) : null;
          return { newEmail: t.email, oldEmail: old!.email, undo: undo?.token ?? null };
        });
      } catch (e) {
        if (isTaken(e)) return taken(c);
        throw e;
      }
      if (!done) return c.json({ error: DEAD_LINK }, 400);
      if (done.undo) await mail("undo_email_change", { to: done.oldEmail, ...changedMail(origin, done.undo, done.newEmail) });
      return c.json({ email: done.newEmail });
    });

    // Opening the undo link sent to the old address: no session needed.
    app.post("/api/auth/email/undo", async (c) => {
      if (!(await tokenLimit(clientKey(c)))) return tooMany(c);
      const { token } = z.object({ token: z.string().min(1).max(200) }).parse(await c.req.json());
      let restored: { user_id: string; email: string } | null;
      try {
        restored = await db.transaction(async (tx) => {
          const t = await spendHeld(tx, token, "undo_email_change");
          if (!t) return null;
          // The old address comes back, confirmed (it was confirmed when it was replaced). The password is turned off
          // (PASSWORD_OFF) and every session ends: whoever made the change may know the password and hold a session.
          await tx.query(`update users set email = $1, email_verified_at = now(), password_hash = $2 where id = $3`, [t.email, PASSWORD_OFF, t.user_id]);
          await tx.query(`delete from sessions where user_id = $1`, [t.user_id]);
          // Every other unused token of the person ends, except undo links older than this one: the oldest undo wins. After
          // A→B→C, B's link cannot undo A's (A's link survives it), while A's link ends B's.
          await tx.query(
            `delete from email_tokens where user_id = $1 and used_at is null and not (kind = 'undo_email_change' and created_at < $2::timestamptz)`,
            [t.user_id, t.created_at]);
          return t;
        });
      } catch (e) {
        // Only a unique-index race can reach here: the hold keeps the address from everyone else.
        if (isTaken(e)) return taken(c);
        throw e;
      }
      if (!restored) return c.json({ error: UNDO_DEAD }, 400);
      const reset = await issue(db, restored.user_id, "reset_password");
      await mail("reset_password", { to: restored.email, ...resetMail(origin, reset.token) });
      return c.json({ email: restored.email, ...unsent });
    });
  }

  return { register, sendVerification };
}
