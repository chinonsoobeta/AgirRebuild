import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { checkStartup, migrate, openPglite, openPostgres, openStore, type Startup } from "@agir/db";
import { retentionDays, startPurge, startWorker } from "@agir/worker";
import { createApp } from "./app.ts";
import { alerter, log, type LogFields } from "./log.ts";
import { dbState, memoryState } from "./shared-state.ts";
import { fileMailer, unsentMailer } from "./mailer.ts";
import { DEMO, seedDemo } from "./seed.ts";

const root = resolve(import.meta.dirname, "../../..");
const port = Number(process.env.PORT ?? 8787);
const alert = alerter(process.env.AGIR_ALERT_URL);
/** A refused start is logged and alerted (the alert is awaited, so it leaves before the process exits). */
const refuse = async (event: string, fields: LogFields) => {
  log(event, fields);
  await alert(event, fields);
  process.exit(1);
};

// The startup check (card A): a refused start is one api.refused_start line, then exit 1.
let startup!: Startup;
try {
  startup = checkStartup(process.env);
} catch (e) {
  await refuse("api.refused_start", { reason: (e as Error).message });
}
const env = startup.env;
for (const w of startup.warnings) log("api.warning", { warning: w });
// Nothing is created before the check passes.
const dataDir = resolve(process.env.AGIR_DATA_DIR ?? join(root, ".data"));
mkdirSync(dataDir, { recursive: true });
// Card B: "invite" lets only a client invitation create an account.
const signup = process.env.AGIR_SIGNUP ?? "open";
if (signup !== "open" && signup !== "invite") await refuse("api.refused_start", { reason: "AGIR_SIGNUP must be open or invite." });
// Card F: unset, closed workspaces are kept; a value that is not a whole number of days refuses the start.
let retention: number | null = null;
try {
  retention = retentionDays(process.env.AGIR_RETENTION_DAYS);
} catch (e) {
  await refuse("api.refused_start", { reason: (e as Error).message });
}
// 127.0.0.1 behind a proxy on the same host; 0.0.0.0 in a container.
const bind = process.env.AGIR_BIND || "127.0.0.1";


const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(join(dataDir, "pg"));
let applied: string[] = [];
try {
  ({ applied } = await migrate(db));
} catch (e) {
  await refuse("migrations.failed", { error: (e as Error).message });
}
if (applied.length) log("migrations.applied", { count: applied.length, names: applied.join(", ") });
const store = openStore(startup.store, dataDir);
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
  // Postgres may run several API processes, so rate limits and run stops live in the database. Embedded PGlite is one
  // process and one connection: a stop written to it would wait for the run's open transaction, so they stay in memory.
  state: process.env.DATABASE_URL ? dbState(db) : memoryState(),
  // Closing a workspace and deleting an account stay off until the retention period is settled (card F).
  closure: process.env.AGIR_ACCOUNT_CLOSURE === "1",
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
  const workerLog = ({ event, ...fields }: Record<string, unknown>) => {
    if (event === "job.done") return;
    log(String(event), fields as LogFields);
    // A job that will not be retried, or the worker's loop failing: alerted with ids only.
    if (event === "job.dead") void alert("job.dead", { id: String(fields.id), kind: String(fields.kind) });
    if (event === "worker.error") void alert("worker.error");
  };
  startWorker({ db, store, log: workerLog });
  if (retention !== null) startPurge({ db, store, log: workerLog }, retention);
}

serve({ fetch: app.fetch, port, hostname: bind }, () => {
  log("api.listening", { url: `http://${bind}:${port}` });
  // The seeded demo accounts, which exist only outside production.
  if (env !== "production") log("api.demo_sign_in", { email: DEMO.analyst.email, password: DEMO.analyst.password, approver: DEMO.approver.email });
});
