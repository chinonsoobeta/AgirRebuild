import { describe, expect, test } from "vitest";
import { checkStartup } from "@agir/db";

const prod = { AGIR_ENV: "production", DATABASE_URL: "postgres://db/agir", AGIR_RUN_SIGNING_SECRET: "s", AGIR_PUBLIC_ORIGIN: "https://agir.example" };

describe("startup check", () => {
  test("no AGIR_ENV and no DATABASE_URL is development on the embedded database", () => {
    expect(checkStartup({})).toEqual({ env: "development", store: { kind: "file" }, warnings: [] });
  });

  test("a database with no AGIR_ENV refuses to start, so a deployment never seeds the demo by accident", () => {
    expect(() => checkStartup({ DATABASE_URL: "postgres://db/agir" })).toThrow(
      "AGIR_ENV is not set. Set AGIR_ENV=production for a real deployment or AGIR_ENV=development to use the demo seed.",
    );
  });

  test("AGIR_ENV accepts only development, test and production", () => {
    expect(checkStartup({ AGIR_ENV: "test" }).env).toBe("test");
    expect(checkStartup({ AGIR_ENV: "development", DATABASE_URL: "postgres://db/agir" }).env).toBe("development");
    for (const bad of ["prod", "Production", "staging", ""]) expect(() => checkStartup({ AGIR_ENV: bad })).toThrow(/AGIR_ENV must be/);
  });

  test("production needs the database, the signing secret and the public origin", () => {
    expect(checkStartup(prod).env).toBe("production");
    for (const k of ["DATABASE_URL", "AGIR_RUN_SIGNING_SECRET", "AGIR_PUBLIC_ORIGIN"] as const) {
      expect(() => checkStartup({ ...prod, [k]: undefined })).toThrow(`${k} is required in production.`);
      expect(() => checkStartup({ ...prod, [k]: "" })).toThrow(`${k} is required in production.`);
    }
  });

  test("production refuses the demo seed", () => {
    expect(() => checkStartup({ ...prod, AGIR_SEED: "1" })).toThrow("AGIR_SEED=1 is not allowed in production");
    expect(checkStartup({ ...prod, AGIR_SEED: "0" }).env).toBe("production");
    expect(checkStartup({ AGIR_SEED: "1" }).env).toBe("development");
  });

  test("production on the file store starts with one warning that blobs are on the local disk", () => {
    expect(checkStartup(prod).warnings).toEqual([expect.stringMatching(/^Blobs are stored on the local disk/)]);
    expect(checkStartup({}).warnings).toEqual([]);
  });

  test("the S3 store needs a bucket and a region and takes an endpoint and a prefix", () => {
    const s3 = { ...prod, AGIR_BLOB_STORE: "s3", AGIR_S3_BUCKET: "b", AGIR_S3_REGION: "ca-central-1" };
    expect(checkStartup(s3)).toEqual({ env: "production", store: { kind: "s3", bucket: "b", region: "ca-central-1" }, warnings: [] });
    expect(checkStartup({ ...s3, AGIR_S3_ENDPOINT: "http://minio:9000", AGIR_S3_PREFIX: "agir/" }).store).toEqual({
      kind: "s3", bucket: "b", region: "ca-central-1", endpoint: "http://minio:9000", prefix: "agir/",
    });
    expect(() => checkStartup({ ...s3, AGIR_S3_BUCKET: undefined })).toThrow("AGIR_S3_BUCKET is required when AGIR_BLOB_STORE=s3.");
    expect(() => checkStartup({ ...s3, AGIR_S3_REGION: undefined })).toThrow("AGIR_S3_REGION is required when AGIR_BLOB_STORE=s3.");
    expect(checkStartup({ AGIR_BLOB_STORE: "file" }).store).toEqual({ kind: "file" });
    expect(() => checkStartup({ AGIR_BLOB_STORE: "disk" })).toThrow("AGIR_BLOB_STORE must be file or s3.");
  });
});
