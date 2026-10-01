// Standalone worker process for production: node apps/worker/src/main.ts
import { join } from "node:path";
import { fileStore, migrate, openDb } from "@agir/db";
import { startWorker } from "./index.ts";

const db = await openDb();
await migrate(db);
const store = fileStore(join(process.env.AGIR_DATA_DIR ?? ".data", "blobs"));
startWorker({ db, store, log: (e) => console.log(JSON.stringify({ at: new Date().toISOString(), ...e })) });
console.log("Agir worker started");
