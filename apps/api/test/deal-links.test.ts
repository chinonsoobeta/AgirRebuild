import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileStore, migrate, migrationFiles, openPglite, splitSql, type Db } from "@agir/db";
import { drain } from "@agir/worker";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/services.ts";

// Card R2: one link shares several files of a run together, and its maker can preview the page it opens.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));

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
  return { status: res.status, json, headers: res.headers };
}
async function signup(email: string, name: string, extra: object = {}): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery", ...extra }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

const BASE: [string, number, string?][] = [
  ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
  ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
  ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
];
const unavailable = "This link is not available. It may have expired or been revoked.";

let alice: Session, viewer: Session, outsider: Session, client: Session;
let ws: string, deal: string, run: string, otherRun: string, viewerId: string;
let memo: string, decision: string, decisionFr: string, lender: string, queued: string, otherFile: string;

async function newRun(name: string) {
  const d = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name, assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id as string;
  for (const [fieldKey, value, itemKey] of BASE) {
    expect((await call(alice, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Deal links test", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
  }
  const made = await call(alice, "POST", `/api/deals/${d}/runs`);
  expect(made.status).toBe(200);
  return { deal: d, run: made.json.id as string };
}
const artifact = async (r: string, kind: string, format: string, lang?: string) => {
  const made = await call(alice, "POST", `/api/runs/${r}/artifacts`, { kind, format, ...(lang ? { lang } : {}) });
  expect(made.status).toBe(200);
  return made.json.id as string;
};
const share = async (artifacts: string[], who = alice, term = "7d") => {
  const made = await call(who, "POST", `/api/runs/${run}/share-links`, { term, artifacts });
  expect(made.status).toBe(200);
  const secret = String(made.json.url).slice(3);
  expect(/^[A-Za-z0-9_-]{43}$/.test(secret)).toBe(true);
  return { id: made.json.id as string, secret, expiresAt: made.json.expiresAt as string | null };
};
const openings = async (link: string) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from audit_events where action = 'share.opened' and entity_id = $1`, [link]))[0]!.n;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Analyst");
  viewer = await signup("val@example.com", "Val Viewer");
  outsider = await signup("olly@example.com", "Olly Outsider");
  viewerId = (await call(viewer, "GET", "/api/me")).json.user.id;
  ws = (await call(alice, "POST", "/api/workspaces", { name: "Links", reviewMode: "solo" })).json.id;
  expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email: "val@example.com", role: "viewer" })).status).toBe(200);
  ({ deal, run } = await newRun("Linked deal"));
  ({ run: otherRun } = await newRun("Other deal"));
  memo = await artifact(run, "ic_memo", "pdf");
  decision = await artifact(run, "build_decision", "docx");
  decisionFr = await artifact(run, "build_decision", "docx", "fr");
  lender = await artifact(run, "lender_package", "pdf");
  otherFile = await artifact(otherRun, "ic_memo", "pdf");
  await drain({ db, store });
  const arts = (await call(alice, "GET", `/api/deals/${deal}/artifacts`)).json as { id: string; status: string }[];
  for (const id of [memo, decision, decisionFr, lender]) expect(arts.find((a) => a.id === id)!.status).toBe("ready");
  queued = await artifact(run, "ic_memo", "docx");
  const invite = await call(alice, "POST", `/api/deals/${deal}/invites`);
  expect(invite.status).toBe(200);
  client = await signup("cleo.client@example.com", "Cleo Client", { invite: String(invite.json.url).slice(3) });
}, 180_000);
afterAll(async () => {
  await db.close();
});

describe("a link with several files", () => {
  test("the page lists its files in order, each file opens, a file left out is refused, and the package opens", async () => {
    const link = await share([memo, decisionFr, decision]);
    const page = await call(null, "GET", `/api/share/${link.secret}`);
    expect(page.status).toBe(200);
    expect(page.json.files.map((f: any) => f.id)).toEqual([decision, decisionFr, memo]);
    const traced = async (id: string) => (await db.query<{ n: number | null }>(`select (provenance->>'entries')::int as n from artifacts where id = $1`, [id]))[0]!.n ?? null;
    expect(page.json.files).toEqual([
      { id: decision, kind: "build_decision", format: "docx", lang: "en", traced: await traced(decision) },
      { id: decisionFr, kind: "build_decision", format: "docx", lang: "fr", traced: await traced(decisionFr) },
      { id: memo, kind: "ic_memo", format: "pdf", lang: "en", traced: await traced(memo) },
    ]);
    expect(page.json.files.some((f: any) => typeof f.traced === "number" && f.traced > 0)).toBe(true);
    expect(page.json).toMatchObject({ deal: "Linked deal", kind: "build_decision", format: "docx", runNumber: 1, expiresAt: link.expiresAt });
    for (const id of [memo, decision, decisionFr]) {
      const file = await app.request(`/api/share/${link.secret}/file?artifact=${id}`);
      const signed = await app.request(`/api/artifacts/${id}/file`, { headers: { cookie: alice.cookie } });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toBe(signed.headers.get("content-disposition"));
      expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await signed.arrayBuffer()));
    }
    const inline = await app.request(`/api/share/${link.secret}/file?artifact=${memo}&inline=1`);
    expect(inline.headers.get("content-disposition")!.startsWith("inline")).toBe(true);
    for (const refused of [lender, otherFile, randomUUID(), "not-a-uuid"]) {
      const r = await call(null, "GET", `/api/share/${link.secret}/file?artifact=${refused}`);
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: unavailable });
    }
    // With several files, the address without a file names none of them.
    expect((await call(null, "GET", `/api/share/${link.secret}/file`)).status).toBe(404);
    const pkg = await call(null, "GET", `/api/share/${link.secret}/audit-package`);
    expect(pkg.status).toBe(200);
    expect(pkg.json.manifest.run.number).toBe(1);
    const opened = await db.query<{ payload: unknown }>(`select payload from audit_events where action = 'share.opened' and entity_id = $1 order by seq`, [link.id]);
    expect(opened.map((e) => e.payload)).toEqual([{ what: "page" }, ...[memo, decision, decisionFr].map((artifact_id) => ({ what: "file", artifact_id })),
      { what: "file", artifact_id: memo }, { what: "audit_package" }]);
  });
  test("the made link is recorded with its run and files, and the list names them", async () => {
    const link = await share([lender, memo]);
    const [row] = await db.query<{ run_id: string; artifact_id: string | null }>(`select run_id, artifact_id from share_links where id = $1`, [link.id]);
    expect(row).toEqual({ run_id: run, artifact_id: null });
    const files = await db.query<{ artifact_id: string }>(`select artifact_id from share_link_files where link_id = $1 order by artifact_id`, [link.id]);
    expect(files.map((f) => f.artifact_id)).toEqual([lender, memo].sort());
    const [created] = await db.query<{ payload: any }>(`select payload from audit_events where action = 'share.created' and entity_id = $1`, [link.id]);
    expect(Object.keys(created!.payload).sort()).toEqual(["artifact_ids", "expires_at", "run_id", "term"]);
    expect([...created!.payload.artifact_ids].sort()).toEqual([lender, memo].sort());
    expect(created!.payload.run_id).toBe(run);
    const listed = (await call(alice, "GET", `/api/deals/${deal}/share-links`)).json.find((l: any) => l.id === link.id);
    expect(listed).toMatchObject({ run_number: 1, term: "7d", created_by: "Alice Analyst", openings: 0, revoked_at: null,
      files: [{ kind: "lender_package", format: "pdf", lang: "en" }, { kind: "ic_memo", format: "pdf", lang: "en" }] });
  });
  test("the old single-file route and the old file address still work", async () => {
    const made = await call(alice, "POST", `/api/artifacts/${memo}/share-links`, { term: "24h" });
    expect(made.status).toBe(200);
    const secret = String(made.json.url).slice(3);
    const page = await call(null, "GET", `/api/share/${secret}`);
    expect(page.status).toBe(200);
    expect(page.json).toMatchObject({ kind: "ic_memo", format: "pdf", files: [{ id: memo, kind: "ic_memo", format: "pdf", lang: "en" }] });
    expect((await app.request(`/api/share/${secret}/file`)).status).toBe(200);
    expect((await app.request(`/api/share/${secret}/file?artifact=${memo}`)).status).toBe(200);
    const [row] = await db.query<{ run_id: string; artifact_id: string }>(`select run_id, artifact_id from share_links where id = $1`, [made.json.id]);
    expect(row).toEqual({ run_id: run, artifact_id: memo });
  });
});

describe("what a link may not share", () => {
  test("a client, an outsider, another run's file, a file not ready, no files and 21 files are refused", async () => {
    const tries = [
      [client, [memo], 403], [outsider, [memo], 403], [alice, [memo, otherFile], 422], [alice, [queued], 422], [alice, [], 422],
      [alice, Array.from({ length: 21 }, () => randomUUID()), 422], [alice, [memo, memo], 422], [alice, [randomUUID()], 422],
    ] as const;
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from share_links`))[0]!.n;
    for (const [who, artifacts, status] of tries) {
      const r = await call(who, "POST", `/api/runs/${run}/share-links`, { term: "7d", artifacts });
      expect(r.status, JSON.stringify(artifacts)).toBe(status);
    }
    expect((await call(alice, "POST", `/api/runs/${randomUUID()}/share-links`, { term: "7d", artifacts: [memo] })).status).toBe(404);
    expect((await call(alice, "POST", `/api/runs/${run}/share-links`, { term: "bad", artifacts: [memo] })).status).toBe(422);
    const notReady = await call(alice, "POST", `/api/runs/${run}/share-links`, { term: "7d", artifacts: [queued] });
    expect(notReady.json.error).toBe("Only a finished report can be shared.");
    expect((await db.query<{ n: number }>(`select count(*)::int as n from share_links`))[0]!.n).toBe(before);
  });
  test("a viewer may share", async () => {
    await share([memo], viewer);
  });
});

describe("closing a link closes every file", () => {
  test.each(["revoked", "expired", "maker left"])("%s", async (mode) => {
    const link = await share([memo, decision], mode === "maker left" ? viewer : alice);
    if (mode === "revoked") expect((await call(alice, "POST", `/api/share-links/${link.id}/revoke`)).status).toBe(200);
    if (mode === "expired") await db.query(`update share_links set expires_at = now() - interval '1 minute' where id = $1`, [link.id]);
    if (mode === "maker left") await db.query(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [ws, viewerId]);
    try {
      for (const suffix of ["", "/file", `/file?artifact=${memo}`, `/file?artifact=${decision}`, "/audit-package"]) {
        const r = await call(null, "GET", `/api/share/${link.secret}${suffix}`);
        expect(r.status, suffix).toBe(404);
        expect(r.json).toEqual({ error: unavailable });
      }
      expect(await openings(link.id)).toBe(0);
    } finally {
      if (mode === "maker left") expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email: "val@example.com", role: "viewer" })).status).toBe(200);
    }
  });
  test("a file that is no longer ready closes the link", async () => {
    const link = await share([memo, lender]);
    await db.query(`update artifacts set status = 'failed' where id = $1`, [lender]);
    try {
      expect((await call(null, "GET", `/api/share/${link.secret}`)).status).toBe(404);
      expect((await call(null, "GET", `/api/share/${link.secret}/file?artifact=${memo}`)).status).toBe(404);
    } finally {
      await db.query(`update artifacts set status = 'ready' where id = $1`, [lender]);
    }
  });
});

describe("the preview", () => {
  test("is the page's body, writes no opening and leaves the count alone", async () => {
    const link = await share([memo, decision, decisionFr]);
    const page = await call(null, "GET", `/api/share/${link.secret}`);
    const opened = await openings(link.id);
    expect(opened).toBe(1);
    const preview = await call(alice, "GET", `/api/share-links/${link.id}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.json).toEqual(page.json);
    expect((await call(viewer, "GET", `/api/share-links/${link.id}/preview`)).status).toBe(200);
    expect(await openings(link.id)).toBe(opened);
    const listed = (await call(alice, "GET", `/api/deals/${deal}/share-links`)).json.find((l: any) => l.id === link.id);
    expect(listed.openings).toBe(opened);
  });
  test("is refused for a revoked or expired link, an outsider and a client", async () => {
    const link = await share([memo]);
    expect([403, 404]).toContain((await call(outsider, "GET", `/api/share-links/${link.id}/preview`)).status);
    expect([403, 404]).toContain((await call(client, "GET", `/api/share-links/${link.id}/preview`)).status);
    expect((await call(null, "GET", `/api/share-links/${link.id}/preview`)).status).toBe(401);
    await db.query(`update share_links set expires_at = now() - interval '1 minute' where id = $1`, [link.id]);
    expect((await call(alice, "GET", `/api/share-links/${link.id}/preview`)).status).toBe(404);
    const revoked = await share([memo]);
    expect((await call(alice, "POST", `/api/share-links/${revoked.id}/revoke`)).status).toBe(200);
    expect((await call(alice, "GET", `/api/share-links/${revoked.id}/preview`)).status).toBe(404);
    expect((await call(alice, "GET", `/api/share-links/${randomUUID()}/preview`)).status).toBe(404);
  });
});

describe("secrets", () => {
  test("no audit event and no stored row holds a link's secret or its hash", async () => {
    const link = await share([memo, decision]);
    await call(null, "GET", `/api/share/${link.secret}`);
    await call(null, "GET", `/api/share/${link.secret}/file?artifact=${memo}`);
    await call(alice, "GET", `/api/share-links/${link.id}/preview`);
    const events = JSON.stringify(await db.query(`select payload, entity_id from audit_events`));
    expect(events.includes(link.secret)).toBe(false);
    expect(events.includes(sha256(link.secret))).toBe(false);
    expect(JSON.stringify(await db.query(`select * from share_link_files`)).includes(link.secret)).toBe(false);
    const listed = JSON.stringify((await call(alice, "GET", `/api/deals/${deal}/share-links`)).json);
    expect(listed.includes(link.secret) || listed.includes(sha256(link.secret)) || listed.includes("token_hash")).toBe(false);
  });
});

describe("the migration", () => {
  test("fills run_id and share_link_files for a link made before it", async () => {
    const old = await openPglite();
    try {
      const before = migrationFiles().filter((m) => m.name < "0033");
      await old.query(`create table schema_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
      for (const m of before) {
        await old.transaction(async (tx) => {
          for (const stmt of splitSql(m.sql)) await tx.query(stmt);
          await tx.query(`insert into schema_migrations (name, sha256) values ($1, $2)`, [m.name, m.sha256]);
        });
      }
      // A link made through the app, with 0017's function, before 0033 exists.
      const current = app;
      app = createApp({ db: old, store, secureCookies: false });
      let link: string, oldRun: string, file: string;
      try {
        const maker = await signup("old.maker@example.com", "Old Maker");
        const w = (await call(maker, "POST", "/api/workspaces", { name: "Old", reviewMode: "solo" })).json.id;
        const d = (await call(maker, "POST", `/api/workspaces/${w}/deals`, { name: "Old deal", assetType: "Multifamily" })).json.id;
        for (const [fieldKey, value, itemKey] of BASE) {
          expect((await call(maker, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Old link", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
        }
        oldRun = (await call(maker, "POST", `/api/deals/${d}/runs`)).json.id;
        file = (await call(maker, "POST", `/api/runs/${oldRun}/artifacts`, { kind: "ic_memo", format: "pdf" })).json.id;
        await old.query(`update artifacts set status = 'ready' where id = $1`, [file]);
        const made = await call(maker, "POST", `/api/artifacts/${file}/share-links`, { term: "7d" });
        expect(made.status).toBe(200);
        link = made.json.id;
      } finally {
        app = current;
      }
      const { applied } = await migrate(old);
      expect(applied[0]).toBe("0033_share_link_files.sql");
      expect((await old.query(`select run_id, artifact_id from share_links where id = $1`, [link]))[0]).toEqual({ run_id: oldRun, artifact_id: file });
      expect(await old.query(`select link_id, artifact_id from share_link_files`)).toEqual([{ link_id: link, artifact_id: file }]);
    } finally {
      await old.close();
    }
  });
});
