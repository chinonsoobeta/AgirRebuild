// The checks both processes (API and worker) make before they open anything. A deployment
// that forgets AGIR_ENV must not start as development: development seeds demo deals, publishes
// a demo password, sends cookies without Secure and signs runs with a development key.

import { join } from "node:path";
import { fileStore, s3Store, type BlobStore } from "./storage.ts";

export type AgirEnv = "development" | "test" | "production";
export type StoreConfig = { kind: "file" } | { kind: "s3"; bucket: string; region: string; endpoint?: string; prefix?: string };
export interface Startup {
  env: AgirEnv;
  store: StoreConfig;
  /** One line each, to log at start. */
  warnings: string[];
}

/** Throws with one line to print when the process must not start. */
export function checkStartup(vars: Record<string, string | undefined>): Startup {
  const raw = vars.AGIR_ENV;
  if (raw === undefined && vars.DATABASE_URL) {
    throw new Error("AGIR_ENV is not set. Set AGIR_ENV=production for a real deployment or AGIR_ENV=development to use the demo seed.");
  }
  const env = raw ?? "development";
  if (env !== "development" && env !== "test" && env !== "production") throw new Error("AGIR_ENV must be development, test or production.");

  const warnings: string[] = [];
  if (env === "production") {
    // AGIR_PUBLIC_ORIGIN builds the links in email; without it they would point at 127.0.0.1.
    for (const k of ["DATABASE_URL", "AGIR_RUN_SIGNING_SECRET", "AGIR_PUBLIC_ORIGIN"]) {
      if (!vars[k]) throw new Error(`${k} is required in production.`);
    }
    if (vars.AGIR_SEED === "1") throw new Error("AGIR_SEED=1 is not allowed in production: the demo seed never runs there.");
  }

  const kind = vars.AGIR_BLOB_STORE ?? "file";
  let store: StoreConfig;
  if (kind === "s3") {
    for (const k of ["AGIR_S3_BUCKET", "AGIR_S3_REGION"]) {
      if (!vars[k]) throw new Error(`${k} is required when AGIR_BLOB_STORE=s3.`);
    }
    store = { kind: "s3", bucket: vars.AGIR_S3_BUCKET!, region: vars.AGIR_S3_REGION! };
    if (vars.AGIR_S3_ENDPOINT) store.endpoint = vars.AGIR_S3_ENDPOINT;
    if (vars.AGIR_S3_PREFIX) store.prefix = vars.AGIR_S3_PREFIX;
  } else if (kind === "file") {
    store = { kind: "file" };
    // A persistent volume is a valid pilot choice, so this is a warning, not a refusal.
    if (env === "production") warnings.push("Blobs are stored on the local disk (AGIR_DATA_DIR/blobs). The API and the worker must mount the same volume.");
  } else {
    throw new Error("AGIR_BLOB_STORE must be file or s3.");
  }
  return { env, store, warnings };
}

/** The API and the worker open the store through this, so they cannot choose different ones from the same settings. */
export function openStore(config: StoreConfig, dataDir: string): BlobStore {
  return config.kind === "s3" ? s3Store(config) : fileStore(join(dataDir, "blobs"));
}
