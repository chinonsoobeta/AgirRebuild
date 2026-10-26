// Standalone worker process for production: node apps/worker/src/main.ts
import { checkStartup, migrate, openDb, openStore, type Startup } from "@agir/db";
import { startWorker } from "./index.ts";

let startup: Startup;
try {
  startup = checkStartup(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
for (const w of startup.warnings) console.warn(w);
const db = await openDb();
await migrate(db);
// The same settings as the API's: both must read and write the same store.
const store = openStore(startup.store, process.env.AGIR_DATA_DIR ?? ".data");
// One JSON line per event, in the API's shape (apps/api/src/log.ts): at, event, then ids, counts and statuses.
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
startWorker({ db, store, log });
log({ event: "worker.started" });
