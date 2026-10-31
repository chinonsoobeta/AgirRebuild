// Standalone worker process for production: node apps/worker/src/main.ts
import { checkStartup, migrate, openDb, openStore, type Startup } from "@agir/db";
import { retentionDays, startPurge, startWorker } from "./index.ts";
import { alerter, alertWorkerEvent } from "./log.ts";

let startup: Startup;
try {
  startup = checkStartup(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
for (const w of startup.warnings) console.warn(w);
// Card F: unset, closed workspaces are kept; a value that is not a whole number of days stops the start.
const retention = retentionDays(process.env.AGIR_RETENTION_DAYS);
const db = await openDb();
await migrate(db);
// The same settings as the API's: both must read and write the same store.
const store = openStore(startup.store, process.env.AGIR_DATA_DIR ?? ".data");
// One JSON line per event, in the API's shape (./log.ts): at, event, then ids, counts and statuses.
const write = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
// Card S8: a dead job and a failing loop are posted to AGIR_ALERT_URL, as the worker embedded in the API does.
const alert = alerter(process.env.AGIR_ALERT_URL);
const log = (e: Record<string, unknown>) => {
  write(e);
  alertWorkerEvent(alert, e);
};
startWorker({ db, store, log });
if (retention !== null) startPurge({ db, store, log }, retention);
log({ event: "worker.started" });
