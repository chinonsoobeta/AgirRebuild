import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { fileStore, migrate, openPglite, openPostgres } from "@agir/db";
import { retentionDays, startPurge, startWorker } from "@agir/worker";
import { createApp } from "./app.ts";
import { fileMailer, unsentMailer } from "./mailer.ts";
import { DEMO, seedDemo } from "./seed.ts";

const root = resolve(import.meta.dirname, "../../..");
const env = process.env.AGIR_ENV ?? "development";
const dataDir = resolve(process.env.AGIR_DATA_DIR ?? join(root, ".data"));
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 8787);

if (env === "production") {
  for (const k of ["DATABASE_URL", "AGIR_RUN_SIGNING_SECRET"]) {
    if (!process.env[k]) {
      console.error(`${k} is required in production.`);
      process.exit(1);
    }
  }
}

// Card F: unset, closed workspaces are kept; a value that is not a whole number of days stops the start.
const retention = retentionDays(process.env.AGIR_RETENTION_DAYS);

const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(join(dataDir, "pg"));
const { applied } = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
const store = fileStore(join(dataDir, "blobs"));

if (env !== "production" && process.env.AGIR_SEED !== "0") {
  await seedDemo(db, store);
}

const app = createApp({ db, store, secureCookies: env === "production", demoSignIn: env !== "production" && process.env.AGIR_SEED !== "0",
  // Set it only when the API runs behind exactly one proxy that sets x-forwarded-for.
  trustProxy: process.env.AGIR_TRUST_PROXY === "1",
  // No mail provider yet: development writes each email to the data folder's mail/ directory; production sends nothing.
  mailer: env === "production" ? unsentMailer() : fileMailer(join(dataDir, "mail")),
  publicOrigin: process.env.AGIR_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
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

// The worker runs in-process when the database is embedded; in production it is its own service.
const embeddedWorker = !process.env.DATABASE_URL || process.env.AGIR_EMBEDDED_WORKER === "1";
if (embeddedWorker) {
  const log = (e: Record<string, unknown>) => (e.event === "job.done" ? undefined : console.log(JSON.stringify(e)));
  startWorker({ db, store, log });
  if (retention !== null) startPurge({ db, store, log }, retention);
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Agir API listening on http://127.0.0.1:${port}`);
  if (env !== "production") console.log(`Demo sign-in: ${DEMO.analyst.email} / ${DEMO.analyst.password} (second approver: ${DEMO.approver.email})`);
});
