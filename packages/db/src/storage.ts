// Content-addressed file storage. Local development keeps bytes on disk; a
// deployment can use any S3-compatible object store with the same two methods.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ key: string; sha256: string; size: number }>;
  get(key: string): Promise<Uint8Array>;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileStore(root: string): BlobStore {
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const dir = join(root, sha256.slice(0, 2));
      await mkdir(dir, { recursive: true });
      const path = join(dir, sha256);
      try {
        await stat(path);
      } catch {
        await writeFile(path, bytes);
      }
      return { key: `${sha256.slice(0, 2)}/${sha256}`, sha256, size: bytes.byteLength };
    },
    async get(key) {
      checkKey(key);
      return new Uint8Array(await readFile(join(root, key)));
    },
  };
}

function checkKey(key: string): void {
  if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
}

/** Only the SDK's send is used, so a test can pass a fake. */
export interface S3Like {
  send(command: object): Promise<any>;
}

export interface S3StoreOptions {
  bucket: string;
  region: string;
  /** Put in front of every object name, e.g. "agir/". The stored key does not include it. */
  prefix?: string;
  /** Any S3-compatible store (MinIO, R2, Ceph). Path-style addressing is the default when an endpoint is given. */
  endpoint?: string;
  pathStyle?: boolean;
  /** Left out, the SDK reads AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or its other usual sources). */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  client?: S3Like;
}

/**
 * The same keys as fileStore (`xx/sha256`) in a bucket. put asks whether the object exists
 * before sending it: the key is the content's hash, so an existing object already holds these
 * bytes, and skipping the upload saves the transfer and a new version in a versioned bucket.
 * Two puts racing past the check write the same bytes, which is harmless.
 */
export function s3Store(opts: S3StoreOptions): BlobStore {
  const prefix = opts.prefix ?? "";
  // The SDK loads on first use, so a process on the file store never loads it.
  let ready: Promise<{ client: S3Like; sdk: typeof import("@aws-sdk/client-s3") }> | undefined;
  const s3 = () =>
    (ready ??= import("@aws-sdk/client-s3").then((sdk) => ({
      sdk,
      client: opts.client ?? new sdk.S3Client({ region: opts.region, endpoint: opts.endpoint, forcePathStyle: opts.pathStyle ?? Boolean(opts.endpoint), credentials: opts.credentials }),
    })));
  return {
    async put(bytes) {
      const sha256 = sha256Hex(bytes);
      const key = `${sha256.slice(0, 2)}/${sha256}`;
      const { client, sdk } = await s3();
      const target = { Bucket: opts.bucket, Key: prefix + key };
      try {
        await client.send(new sdk.HeadObjectCommand(target));
      } catch (e) {
        const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (err.name !== "NotFound" && err.$metadata?.httpStatusCode !== 404) throw e;
        await client.send(new sdk.PutObjectCommand({ ...target, Body: bytes, ContentLength: bytes.byteLength }));
      }
      return { key, sha256, size: bytes.byteLength };
    },
    async get(key) {
      checkKey(key);
      const { client, sdk } = await s3();
      const out = await client.send(new sdk.GetObjectCommand({ Bucket: opts.bucket, Key: prefix + key }));
      return new Uint8Array(await out.Body.transformToByteArray());
    },
  };
}
