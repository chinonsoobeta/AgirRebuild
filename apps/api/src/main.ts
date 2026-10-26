import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileStore, migrate, openPglite, openPostgres } from "@agir/db";
import { startWorker } from "@agir/worker";
import { createApp } from "./app.ts";
import { alerter, log, type LogFields } from "./log.ts";
import { fileMailer, unsentMailer } from "./mailer.ts";
import { DEMO, seedDemo } from "./seed.ts";

const root = resolve(import.meta.dirname, "../../..");
const env = process.env.AGIR_ENV ?? "development";
const dataDir = resolve(process.env.AGIR_DATA_DIR ?? join(root, ".data"));
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 8787);
const alert = alerter(process.env.AGIR_ALERT_URL);
/** A refused start is logged and alerted (the alert is awaited, so it leaves before the process exits). */
const refuse = async (event: string, fields: LogFields) => {
  log(event, fields);
  await alert(event, fields);
  process.exit(1);
};

if (env === "production") {
  for (const k of ["DATABASE_URL", "AGIR_RUN_SIGNING_SECRET"]) {
    if (!process.env[k]) await refuse("api.refused_start", { reason: `${k} is required in production.` });
  }
}
// Card B: "invite" lets only a client invitation create an account.
const signup = process.env.AGIR_SIGNUP ?? "open";
if (signup !== "open" && signup !== "invite") await refuse("api.refused_start", { reason: "AGIR_SIGNUP must be open or invite." });

const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(join(dataDir, "pg"));
let applied: string[] = [];
try {
  ({ applied } = await migrate(db));
} catch (e) {
  await refuse("migrations.failed", { error: (e as Error).message });
}
if (applied.length) log("migrations.applied", { count: applied.length, names: applied.join(", ") });
const store = fileStore(join(dataDir, "blobs"));
// The worker runs in-process when the database is embedded; in production it is its own service.
const embeddedWorker = !process.env.DATABASE_URL || process.env.AGIR_EMBEDDED_WORKER === "1";

if (env !== "production" && process.env.AGIR_SEED !== "0") {
  await seedDemo(db, store);
}

const app = createApp({ db, store, secureCookies: env === "production", demoSignIn: env !== "production" && process.env.AGIR_SEED !== "0",
  // Set it only when the API runs behind exactly one proxy that sets x-forwarded-for.
  trustProxy: process.env.AGIR_TRUST_PROXY === "1",
  // No mail provider yet: development writes each email to the data folder's mail/ directory; production sends nothing.
  mailer: env === "production" ? unsentMailer() : fileMailer(join(dataDir, "mail")),
  publicOrigin: process.env.AGIR_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  signup: signup as "open" | "invite", worker: embeddedWorker, log, logRequests: true, alert,
});
const webDist = join(root, "apps/web/dist");
if (existsSync(webDist)) {
  // Production reads the page once; elsewhere it is re-read so a rebuild shows without a restart.
  const cached = readFileSync(join(webDist, "index.html"), "utf8");
  const index = () => (env === "production" ? cached : readFileSync(join(webDist, "index.html"), "utf8"));
  app.use("/assets/*", serveStatic({ root: relative(process.cwd(), webDist) }));
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.html(index())));
}

if (embeddedWorker) {
  startWorker({ db, store, log: ({ event, ...fields }) => {
    if (event === "job.done") return;
    log(String(event), fields as LogFields);
    // A job that will not be retried, or the worker's loop failing: alerted with ids only.
    if (event === "job.dead") void alert("job.dead", { id: String(fields.id), kind: String(fields.kind) });
    if (event === "worker.error") void alert("worker.error");
  } });
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  log("api.listening", { url: `http://127.0.0.1:${port}` });
  // The seeded demo accounts, which exist only outside production.
  if (env !== "production") log("api.demo_sign_in", { email: DEMO.analyst.email, password: DEMO.analyst.password, approver: DEMO.approver.email });
});
