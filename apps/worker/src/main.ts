// Standalone worker process for production: node apps/worker/src/main.ts
import { join } from "node:path";
import { fileStore, migrate, openDb } from "@agir/db";
import { startWorker } from "./index.ts";

const db = await openDb();
await migrate(db);
const store = fileStore(join(process.env.AGIR_DATA_DIR ?? ".data", "blobs"));
// One JSON line per event, in the API's shape (apps/api/src/log.ts): at, event, then ids, counts and statuses.
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
startWorker({ db, store, log });
log({ event: "worker.started" });
