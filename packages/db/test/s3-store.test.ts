import { describe, expect, test } from "vitest";
import { s3Store, sha256Hex } from "@agir/db";

// A fake S3: the SDK's send replaced by a function over a map. No network.
function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const calls: { command: string; input: { Bucket?: string; Key?: string } }[] = [];
  const client = {
    async send(cmd: { constructor: { name: string }; input: { Bucket?: string; Key?: string; Body?: Uint8Array } }) {
      const command = cmd.constructor.name;
      calls.push({ command, input: { Bucket: cmd.input.Bucket, Key: cmd.input.Key } });
      const id = `${cmd.input.Bucket}/${cmd.input.Key}`;
      if (command === "PutObjectCommand") {
        objects.set(id, new Uint8Array(cmd.input.Body!));
        return {};
      }
      const found = objects.get(id);
      if (!found) throw Object.assign(new Error("not found"), { name: command === "HeadObjectCommand" ? "NotFound" : "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      if (command === "HeadObjectCommand") return { ContentLength: found.byteLength };
      return { Body: { transformToByteArray: async () => found } };
    },
  };
  return { client, objects, calls };
}

const bytes = new TextEncoder().encode("rent roll, 12 units");
const sha = sha256Hex(bytes);

describe("s3Store", () => {
  test("keys a blob exactly like the file store: the first two hex digits, a slash, the SHA-256", async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: "agir", region: "ca-central-1", client: s3.client });
    expect(await store.put(bytes)).toEqual({ key: `${sha.slice(0, 2)}/${sha}`, sha256: sha, size: bytes.byteLength });
    expect([...s3.objects.keys()]).toEqual([`agir/${sha.slice(0, 2)}/${sha}`]);
  });

  test("a prefix goes in front of the object name but not into the stored key", async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: "agir", prefix: "pilot/", region: "ca-central-1", client: s3.client });
    const { key } = await store.put(bytes);
    expect(key).toBe(`${sha.slice(0, 2)}/${sha}`);
    expect([...s3.objects.keys()]).toEqual([`agir/pilot/${sha.slice(0, 2)}/${sha}`]);
    expect(await store.get(key)).toEqual(bytes);
  });

  test("round trip: get returns the bytes put", async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: "agir", region: "ca-central-1", client: s3.client });
    const { key } = await store.put(bytes);
    expect(await store.get(key)).toEqual(bytes);
  });

  test("get refuses a malformed key before any request", async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: "agir", region: "ca-central-1", client: s3.client });
    for (const bad of ["../etc/passwd", sha, `${sha.slice(0, 2)}/${sha}/x`, `ZZ/${sha}`, `${sha.slice(0, 2)}/${sha.toUpperCase()}`]) {
      await expect(store.get(bad)).rejects.toThrow("Invalid storage key");
    }
    expect(s3.calls).toEqual([]);
  });

  test("putting the same bytes twice stores them once", async () => {
    const s3 = fakeS3();
    const store = s3Store({ bucket: "agir", region: "ca-central-1", client: s3.client });
    const a = await store.put(bytes);
    const b = await store.put(new Uint8Array(bytes));
    expect(b).toEqual(a);
    expect(s3.calls.map((c) => c.command)).toEqual(["HeadObjectCommand", "PutObjectCommand", "HeadObjectCommand"]);
    expect(s3.objects.size).toBe(1);
  });

  test("an error other than not-found is not taken as a missing object", async () => {
    const client = { send: async () => { throw Object.assign(new Error("denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }); } };
    const store = s3Store({ bucket: "agir", region: "ca-central-1", client });
    await expect(store.put(bytes)).rejects.toThrow("denied");
  });
});
