import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log as defaultLog, type Logger } from "./log.ts";

export type Mail = { to: string; subject: string; text: string };
export interface Mailer {
  /** False when nothing is delivered: the API then answers `sent: false` and the screens never claim a send (card B). */
  configured: boolean;
  send(m: Mail): Promise<void>;
}

/** Development only: each message becomes a file in `dir`, and one line says where. The file holds the link; the log never does. */
export function fileMailer(dir: string, log: Logger = defaultLog): Mailer {
  return {
    configured: true,
    async send(m) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.txt`);
      writeFileSync(file, `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`, { mode: 0o600 });
      log("mail.written", { file });
    },
  };
}

/** Production has no mail provider yet: nothing is sent, and the log says so without the recipient or the content. */
export function unsentMailer(log: Logger = defaultLog): Mailer {
  return { configured: false, async send() { log("mail.not_sent", { reason: "no mail provider configured" }); } };
}

/** Tests: messages are kept in `sent`. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { configured: true, sent, async send(m) { sent.push({ ...m }); } };
}
