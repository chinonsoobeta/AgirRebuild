import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type Mail = { to: string; subject: string; text: string };
export interface Mailer {
  send(m: Mail): Promise<void>;
}

/** Development only: each message becomes a file in `dir`, and one line says where. The file holds the link; the log never does. */
export function fileMailer(dir: string, log: (line: string) => void = console.log): Mailer {
  return {
    async send(m) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.txt`);
      writeFileSync(file, `To: ${m.to}\nSubject: ${m.subject}\n\n${m.text}\n`, { mode: 0o600 });
      log(`Mail written to ${file}`);
    },
  };
}

/** Production has no mail provider yet: nothing is sent, and the log says so without the recipient or the content. */
export function unsentMailer(log: (line: string) => void = console.log): Mailer {
  return { async send() { log(JSON.stringify({ at: new Date().toISOString(), event: "mail.not_sent", reason: "no mail provider configured" })); } };
}

/** Tests: messages are kept in `sent`. */
export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return { sent, async send(m) { sent.push({ ...m }); } };
}
