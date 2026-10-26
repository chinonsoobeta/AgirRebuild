// Standalone worker process for production: node apps/worker/src/main.ts
import { join } from "node:path";
import { fileStore, migrate, openDb } from "@agir/db";
import { retentionDays, startPurge, startWorker } from "./index.ts";

// Card F: unset, closed workspaces are kept; a value that is not a whole number of days stops the start.
const retention = retentionDays(process.env.AGIR_RETENTION_DAYS);
const db = await openDb();
await migrate(db);
const store = fileStore(join(process.env.AGIR_DATA_DIR ?? ".data", "blobs"));
const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e }));
startWorker({ db, store, log });
if (retention !== null) startPurge({ db, store, log }, retention);
console.log("Agir worker started");
