import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";
import { deviceLabel } from "../src/auth.ts";

// Card R4: the kind of device each session was signed in from, and the counts' second lines.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  androidPhone: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
  chromebook: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

type Session = { cookie: string };
async function call(s: Session | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}
async function auth(path: string, body: unknown, ua?: string): Promise<Session> {
  const headers: Record<string, string> = { "x-agir": "1", "content-type": "application/json" };
  if (ua) headers["user-agent"] = ua;
  const res = await app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}
const signup = (email: string, name: string, ua?: string) => auth("/api/auth/signup", { email, name, password: "correct horse battery" }, ua);
const login = (email: string, ua?: string) => auth("/api/auth/login", { email, password: "correct horse battery" }, ua);
const idOf = async (s: Session): Promise<string> => (await call(s, "GET", "/api/me")).json.user.id;
const devicesOf = async (userId: string) =>
  (await db.query<{ device: string | null }>(`select device from sessions where user_id = $1 order by created_at`, [userId])).map((r) => r.device);

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false, demoSignIn: true });
});

describe("deviceLabel", () => {
  test("names the kind of device only", () => {
    expect(deviceLabel(UA.mac)).toBe("Mac");
    expect(deviceLabel(UA.iphone)).toBe("iPhone");
    expect(deviceLabel(UA.ipad)).toBe("iPad");
    expect(deviceLabel(UA.androidPhone)).toBe("Android phone");
    expect(deviceLabel(UA.androidTablet)).toBe("Android tablet");
    expect(deviceLabel(UA.windows)).toBe("Windows PC");
    expect(deviceLabel(UA.linux)).toBe("Linux computer");
    expect(deviceLabel(UA.chromebook)).toBe("Chromebook");
  });

  test("answers null when it cannot tell", () => {
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel("")).toBeNull();
    expect(deviceLabel("curl/8.4.0")).toBeNull();
    expect(deviceLabel("x".repeat(5000))).toBeNull();
  });
});

describe("your sessions and their devices", () => {
  test("lists each live session, the current one first, with no token or hash", async () => {
    const mac = await signup("mia@example.com", "Mia Two", UA.mac);
    const phone = await login("mia@example.com", UA.iphone);
    const mia = await idOf(mac);
    // A session that has expired is not listed.
    await db.query(`insert into sessions (token_hash, user_id, expires_at, device) values ('expired-r4-hash', $1, now() - interval '1 day', 'Windows PC')`, [mia]);
    const fromMac = await call(mac, "GET", "/api/me/sessions");
    expect(fromMac.status).toBe(200);
    expect(fromMac.json.count).toBe(2);
    expect(fromMac.json.devices.map((d: any) => [d.device, d.current])).toEqual([["Mac", true], ["iPhone", false]]);
    for (const d of fromMac.json.devices) {
      expect(Object.keys(d).sort()).toEqual(["current", "device", "signedInAt"]);
      expect(Number.isNaN(Date.parse(d.signedInAt))).toBe(false);
    }
    const fromPhone = await call(phone, "GET", "/api/me/sessions");
    expect(fromPhone.json.devices.map((d: any) => [d.device, d.current])).toEqual([["iPhone", true], ["Mac", false]]);
    // No token or token hash anywhere in the body.
    const hashes = (await db.query<{ token_hash: string }>(`select token_hash from sessions where user_id = $1`, [mia])).map((r) => r.token_hash);
    const tokens = [mac.cookie.split("=")[1]!, phone.cookie.split("=")[1]!];
    for (const secret of [...hashes, ...tokens]) {
      expect(fromMac.text).not.toContain(secret);
      expect(fromPhone.text).not.toContain(secret);
    }
    expect(fromMac.text).not.toMatch(/token|hash/i);
  });

  test("a session from before the change has no label and reads as null", async () => {
    const s = await signup("old@example.com", "Old Session", UA.windows);
    const id = await idOf(s);
    await db.query(`insert into sessions (token_hash, user_id, expires_at, created_at) values ('pre-r4-hash', $1, now() + interval '1 day', now() - interval '2 days')`, [id]);
    const r = await call(s, "GET", "/api/me/sessions");
    expect(r.json.devices.map((d: any) => [d.device, d.current])).toEqual([["Windows PC", true], [null, false]]);
  });

  test("sign-up, sign-in and the demo sign-in store the label; no user agent stores null", async () => {
    const s = await signup("lab@example.com", "Lab Person", UA.androidPhone);
    const id = await idOf(s);
    await login("lab@example.com", UA.chromebook);
    await login("lab@example.com");
    expect(await devicesOf(id)).toEqual(["Android phone", "Chromebook", null]);
    const [demo] = await db.query<{ id: string }>(`insert into users (email, name, password_hash) values ('demo@agir.local', 'Demo', 'x') returning id`);
    await auth("/api/auth/demo", { who: "analyst" }, UA.ipad);
    expect(await devicesOf(demo!.id)).toEqual(["iPad"]);
  });

  test("the column keeps at most 60 characters", async () => {
    const s = await signup("long@example.com", "Long Label");
    const id = await idOf(s);
    await expect(
      db.query(`insert into sessions (token_hash, user_id, expires_at, device) values ('long-hash', $1, now() + interval '1 day', $2)`, [id, "x".repeat(61)]),
    ).rejects.toThrow();
  });
});

describe("runs and reports in the production counts", () => {
  let n = 0;
  const run = async (deal: string, ws: string, number: number, at: string) => {
    const id = randomUUID();
    n++;
    await db.query(
      `insert into runs (id, deal_id, workspace_id, run_number, engine_version, policy_version, policy_hash, input_snapshot, input_hash, assumptions_hash, result, result_hash, verdict_code, signature, created_at)
       values ($1, $2, $3, $4, 'e', 'p', 'ph', '{}', $5, 'ah', '{}', 'rh', 'NOT_EVALUATED', 'sig', $6)`,
      [id, deal, ws, number, `ih-${n}`, at],
    );
    return id;
  };
  const artifact = async (deal: string, ws: string, runId: string, status = "ready") => {
    const [a] = await db.query<{ id: string }>(`insert into artifacts (deal_id, workspace_id, run_id, kind, format, status) values ($1, $2, $3, 'ic_memo', 'pdf', $4) returning id`, [
      deal, ws, runId, status,
    ]);
    return a!.id;
  };
  const share = async (deal: string, ws: string, artifactId: string, by: string, revoked = false) => {
    await db.query(
      `insert into share_links (workspace_id, deal_id, artifact_id, token_hash, term, created_by, revoked_at) values ($1, $2, $3, $4, 'none', $5, $6)`,
      [ws, deal, artifactId, `share-${randomUUID()}`, by, revoked ? new Date().toISOString() : null],
    );
  };

  test("count only the deals that are not archived, the latest run's ready files, and the files shared by a link", async () => {
    const owner = await signup("olga@example.com", "Olga Owner", UA.mac);
    const me = await idOf(owner);
    const ws = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    const live = (await call(owner, "POST", `/api/workspaces/${ws}/deals`, { name: "Larch Court", assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    const gone = (await call(owner, "POST", `/api/workspaces/${ws}/deals`, { name: "Birch Row", assetType: "Multifamily", location: "Kelowna", province: "BC" })).json.id;
    const r1 = await run(live, ws, 1, "2026-10-01T15:00:00Z");
    const r2 = await run(live, ws, 2, "2026-10-05T15:00:00Z");
    // The first run's file is not counted: only the latest run's ready files are, as in the deals list.
    await artifact(live, ws, r1);
    const shared = await artifact(live, ws, r2);
    await artifact(live, ws, r2);
    await artifact(live, ws, r2, "failed");
    await share(live, ws, shared, me, true);
    await share(live, ws, shared, me);
    // The archived deal has an earlier run, more files and a share; none of it is counted.
    const g1 = await run(gone, ws, 1, "2026-09-01T15:00:00Z");
    const ga = await artifact(gone, ws, g1);
    await share(gone, ws, ga, me);
    await db.query(`update deals set archived_at = now() where id = $1`, [gone]);

    const totals = (await call(owner, "GET", `/api/workspaces/${ws}/deal-metrics`)).json.totals;
    expect(totals.runs).toBe(2);
    expect(Date.parse(totals.first_run_at)).toBe(Date.parse("2026-10-01T15:00:00Z"));
    expect(totals.reports).toBe(2);
    expect(totals.reports_shared).toBe(1);
    expect(totals.archived_deals).toBe(1);
  });

  test("a workspace with no runs has no first run", async () => {
    const owner = await signup("nora@example.com", "Nora None");
    const ws = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    await call(owner, "POST", `/api/workspaces/${ws}/deals`, { name: "Empty Lot", assetType: "Multifamily", location: "Regina" });
    const totals = (await call(owner, "GET", `/api/workspaces/${ws}/deal-metrics`)).json.totals;
    expect(totals).toMatchObject({ runs: 0, first_run_at: null, reports: 0, reports_shared: 0 });
  });
});
