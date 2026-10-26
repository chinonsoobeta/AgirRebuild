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
startWorker({ db, store, log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })) });
console.log("Agir worker started");
