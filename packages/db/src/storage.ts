// Content-addressed file storage. Local development keeps bytes on disk; a
// production deployment supplies an object store with the same two methods.

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
      if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
      return new Uint8Array(await readFile(join(root, key)));
    },
  };
}
