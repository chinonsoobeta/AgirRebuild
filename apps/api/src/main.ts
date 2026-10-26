import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { checkStartup, migrate, openPglite, openPostgres, openStore, type Startup } from "@agir/db";
import { startWorker } from "@agir/worker";
import { createApp } from "./app.ts";
import { fileMailer, unsentMailer } from "./mailer.ts";
import { DEMO, seedDemo } from "./seed.ts";

const root = resolve(import.meta.dirname, "../../..");
let startup: Startup;
try {
  startup = checkStartup(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const env = startup.env;
for (const w of startup.warnings) console.warn(w);
const dataDir = resolve(process.env.AGIR_DATA_DIR ?? join(root, ".data"));
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 8787);
// 127.0.0.1 behind a proxy on the same host; 0.0.0.0 in a container.
const bind = process.env.AGIR_BIND || "127.0.0.1";

const db = process.env.DATABASE_URL ? await openPostgres(process.env.DATABASE_URL) : await openPglite(join(dataDir, "pg"));
const { applied } = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
const store = openStore(startup.store, dataDir);

if (env !== "production" && process.env.AGIR_SEED !== "0") {
  await seedDemo(db, store);
}

const app = createApp({ db, store, secureCookies: env === "production", demoSignIn: env !== "production" && process.env.AGIR_SEED !== "0",
  // Set it only when the API runs behind exactly one proxy that sets x-forwarded-for.
  trustProxy: process.env.AGIR_TRUST_PROXY === "1",
  // No mail provider yet: development writes each email to the data folder's mail/ directory; production sends nothing.
  mailer: env === "production" ? unsentMailer() : fileMailer(join(dataDir, "mail")),
  publicOrigin: process.env.AGIR_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
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
if (embeddedWorker) startWorker({ db, store, log: (e) => (e.event === "job.done" ? undefined : console.log(JSON.stringify(e))) });

serve({ fetch: app.fetch, port, hostname: bind }, () => {
  console.log(`Agir API listening on http://${bind}:${port}`);
  if (env !== "production") console.log(`Demo sign-in: ${DEMO.analyst.email} / ${DEMO.analyst.password} (second approver: ${DEMO.approver.email})`);
});
