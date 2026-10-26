import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { createApp } from "../src/app.ts";
import type { Mail } from "../src/mailer.ts";

// Card R1e: when the browser that started a streamed run goes away before the end, the starter gets an email once the
// run is recorded, with a link to it. A browser that stays, a stopped run and a failed send each get no email or no harm.
let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
/** Awaited after each progress line; tests set it to hold a run at a stage or to learn that it has ended. */
let pause: ((stage: string) => Promise<void> | void) | undefined;
const sent: Mail[] = [];
let failSend = false;

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
  return { status: res.status, json };
}
async function signup(email: string, name: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery" }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

let bea: Session;
let ws: string;
const VALUES: [string, number, string?][] = [
  ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
  ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
  ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
];
const newDeal = async (name: string) => {
  const d = (await call(bea, "POST", `/api/workspaces/${ws}/deals`, { name, assetType: "Multifamily" })).json.id as string;
  for (const [fieldKey, value, itemKey] of VALUES) {
    const r = await call(bea, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Run email test", ...(itemKey ? { itemKey } : {}) });
    expect(r.status, fieldKey).toBe(200);
  }
  return d;
};
const token = () => randomBytes(32).toString("base64url");
const streamed = (d: string, runToken: string) =>
  app.request(`/api/deals/${d}/runs?progress=1`, { method: "POST", headers: { "x-agir": "1", cookie: bea.cookie, "x-run-token": runToken } });
const runsOf = (d: string) => db.query<{ id: string; run_number: number }>(`select id, run_number from runs where deal_id = $1 order by run_number`, [d]);
/** Holds the run at its inputs stage until `release`, and resolves `ended` once the run's last progress line has gone out. */
const hold = () => {
  let release!: () => void;
  let end!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const ended = new Promise<void>((r) => (end = r));
  pause = async (stage) => {
    if (stage === "inputs") await held;
    if (stage === "record") end();
  };
  return { release, ended };
};

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({
    db, store, secureCookies: false, publicOrigin: "https://agir.example/", progressHook: (stage) => pause?.(stage),
    mailer: { configured: true, send: async (m) => { if (failSend) throw new Error("smtp down"); sent.push({ ...m }); } },
  });
  bea = await signup("bea@example.com", "Bea Builder");
  ws = (await call(bea, "POST", "/api/workspaces", { name: "Mail", reviewMode: "solo" })).json.id;
}, 120_000);
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  pause = undefined;
  failSend = false;
  sent.length = 0;
  vi.restoreAllMocks();
});

describe("the email when a run finishes after its browser went away", () => {
  test("goes to the person who started it, with the deal, the run's number and a link to it, and nothing else", async () => {
    const d = await newDeal("Larch Court");
    sent.length = 0;
    const runToken = token();
    const { release, ended } = hold();
    const res = await streamed(d, runToken);
    await res.body!.cancel();
    release();
    await ended;
    const [run] = await runsOf(d);
    expect(run?.run_number).toBe(1);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe("bea@example.com");
    expect(mail.subject).toBe("Run 1 of Larch Court is done / L’analyse 1 de Larch Court est terminée");
    const link = `https://agir.example/deals/${d}/run?run=${run!.id}`;
    expect(mail.text.split("\n").filter((line) => line === link)).toHaveLength(2);
    expect(mail.text).toContain("Run 1 of Larch Court is done. To see it, open this link:");
    expect(mail.text).toContain("L’analyse 1 de Larch Court est terminée. Pour la voir, ouvrez ce lien :");
    // No figure, verdict or secret: the email only says where to look.
    expect(mail.text).not.toMatch(/\$|%|verdict|approve|decline/i);
    expect(mail.text.includes(runToken)).toBe(false);
  });

  test("is not sent when the browser stays to the end", async () => {
    const d = await newDeal("Birch Row");
    sent.length = 0;
    const res = await streamed(d, token());
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toHaveProperty("done");
    expect(sent).toHaveLength(0);
  });

  test("is not sent for a run that was stopped", async () => {
    const d = await newDeal("Cedar Mews");
    sent.length = 0;
    const runToken = token();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    pause = async (stage) => { if (stage === "inputs") await held; };
    const res = await streamed(d, runToken);
    const reading = res.text();
    expect((await call(null, "POST", "/api/runs/stop", { token: runToken })).status).toBe(200);
    release();
    const lines = (await reading).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ stopped: true });
    expect(await runsOf(d)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  test("a send that fails leaves the run recorded and logs no address", async () => {
    const d = await newDeal("Douglas Yard");
    sent.length = 0;
    failSend = true;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { release, ended } = hold();
    const res = await streamed(d, token());
    await res.body!.cancel();
    release();
    await ended;
    expect(await runsOf(d)).toHaveLength(1);
    const lines = logged.mock.calls.map((args) => args.join(" "));
    expect(lines.some((line) => line.includes("mail.failed") && line.includes("run_done"))).toBe(true);
    expect(lines.some((line) => line.includes("bea@example.com") || line.includes("Douglas Yard"))).toBe(false);
  });
});
