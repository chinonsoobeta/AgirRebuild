import { beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as zlib from "node:zlib";
import { asUser, fileStore, migrate, openPglite, type Db } from "@agir/db";
import Anthropic from "@anthropic-ai/sdk";
import { drain, reconcileDeal, type SuggestRequest, type SuggestReply } from "@agir/worker";
import { documentBytes, loadOracle } from "@agir/testkit";
import { createApp } from "../src/app.ts";
import { POLICIES, POLICY_V1, RENTAL_HOLD_DRAFT, type Policy } from "@agir/contracts";
import { DRIVERS, SALE_DRIVERS, canonicalJson, heldPartnerReturns } from "@agir/engine";
import { POLICY_HASHES, sha256, sourceLabel } from "../src/services.ts";

let db: Db;
let app: ReturnType<typeof createApp>;
const store = fileStore(mkdtempSync(join(tmpdir(), "agir-blobs-")));
const work = () => drain({ db, store });

type Session = { cookie: string };
async function call(s: Session | null, method: string, path: string, body?: unknown, raw?: Uint8Array) {
  const headers: Record<string, string> = { "x-agir": "1" };
  if (s) headers.cookie = s.cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}
async function signup(email: string, name: string, reviewMode?: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery", ...(reviewMode ? { reviewMode } : {}) }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
}

let alice: Session, bob: Session, carol: Session;
let ws: string, deal: string, run: string;

beforeAll(async () => {
  db = await openPglite();
  await migrate(db);
  app = createApp({ db, store, secureCookies: false });
  alice = await signup("alice@example.com", "Alice Analyst");
  bob = await signup("bob@example.com", "Bob Approver");
  carol = await signup("carol@example.com", "Carol Outsider");
  ws = (await call(alice, "GET", "/api/me")).json.workspaces[0].id;
  expect((await call(alice, "POST", `/api/workspaces/${ws}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
});

describe("the whole workflow, from documents to an audit package", () => {
  test("upload the Maple Heights documents; the worker verifies and extracts them", async () => {
    deal = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Maple Heights", assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    for (const doc of loadOracle("maple-heights").documents) {
      const r = await call(alice, "PUT", `/api/deals/${deal}/documents?name=${encodeURIComponent(doc.name)}`, undefined, await documentBytes(doc));
      expect(r.status).toBe(200);
    }
    await work();
    const docs = (await call(alice, "GET", `/api/deals/${deal}/documents`)).json;
    expect(docs.map((d: any) => d.stage)).toEqual(docs.map(() => "extracted"));
  });

  test("a new deal is in Canadian dollars unless it says otherwise", async () => {
    expect((await call(alice, "GET", `/api/deals/${deal}`)).json.deal).toMatchObject({ currency: "CAD", country: "CA", province: "BC" });
    const us = await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Boise Flats", assetType: "Multifamily", location: "Boise, Idaho", currency: "USD", country: "US" });
    expect((await call(alice, "GET", `/api/deals/${us.json.id}`)).json.deal).toMatchObject({ currency: "USD", country: "US", province: null });
    expect((await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Nowhere", assetType: "Office", country: "US", province: "BC" })).status).toBe(422);
  });

  test("the same file uploaded twice is one document", async () => {
    const doc = loadOracle("maple-heights").documents[0]!;
    const r = await call(alice, "PUT", `/api/deals/${deal}/documents?name=copy.pdf`, undefined, await documentBytes(doc));
    expect(r.json.duplicate).toBe(true);
  });

  test("the run is blocked until review is clear", async () => {
    const r = await call(alice, "POST", `/api/deals/${deal}/runs`);
    expect(r.status).toBe(409);
    expect(r.json.detail.readiness.pending.length).toBeGreaterThan(10);
  });

  test("approve every extracted value, then run", async () => {
    const review = (await call(alice, "GET", `/api/deals/${deal}/review`)).json;
    expect(review.readiness.missing).toEqual([]);
    expect(review.other.some((o: any) => /output figure/.test(o.note ?? ""))).toBe(true);
    for (const a of review.assumptions.filter((x: any) => x.status === "needs_review")) {
      expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    }
    const r = await call(alice, "POST", `/api/deals/${deal}/runs`);
    expect(r.status).toBe(200);
    run = r.json.id;
    const view = (await call(alice, "GET", `/api/runs/${run}`)).json;
    // Oracle update (task 39, owner sign-off 2026-10-05): lease-up carrying costs leave the stated sources short, so the run rejects.
    expect(view.result.verdict.code).toBe("REJECT");
    expect(view.result.checks.find((c: any) => c.key === "sources_cover_uses")?.severity).toBe("error");
    expect(view.fresh).toBe(true);
    const overview = (await call(alice, "GET", `/api/deals/${deal}`)).json;
    expect(overview.step).toBe("decision");
  });

  test("running again with the same inputs returns the same run", async () => {
    expect((await call(alice, "POST", `/api/deals/${deal}/runs`)).json.id).toBe(run);
  });

  test("only an admin records the decision, and conditions must be stated", async () => {
    await call(alice, "POST", `/api/workspaces/${ws}/members`, { email: "carol@example.com", role: "viewer" });
    const noConditions = await call(bob, "POST", `/api/runs/${run}/decision`, { decision: "approve_with_conditions", rationale: "Strong location and sponsor" });
    expect(noConditions.status).toBe(422);
    const noReason = await call(bob, "POST", `/api/runs/${run}/decision`, { decision: "approve_with_conditions", rationale: "Strong location and sponsor", conditions: "Lender to confirm a 25-year amortization before close" });
    expect(noReason.status).toBe(422);
    const ok = await call(bob, "POST", `/api/runs/${run}/decision`, { decision: "approve_with_conditions", rationale: "Strong location and sponsor", conditions: "Sponsor to fund a lease-up reserve before close", overrideReason: "The shortfall is the lease-up carry; a funded reserve closes it" });
    expect(ok.status).toBe(200);
  });

  test("memo, lender package and model export render, each with a clean provenance scan", async () => {
    for (const [kind, format] of [["ic_memo", "pdf"], ["ic_memo", "docx"], ["lender_package", "pdf"], ["model_export", "xlsx"]]) {
      expect((await call(alice, "POST", `/api/runs/${run}/artifacts`, { kind, format })).status).toBe(200);
    }
    await work();
    const arts = (await call(alice, "GET", `/api/deals/${deal}/artifacts`)).json;
    expect(arts.map((a: any) => a.status)).toEqual(["ready", "ready", "ready", "ready"]);
    const file = await app.request(`/api/artifacts/${arts.find((a: any) => a.format === "pdf").id}/file`, { headers: { cookie: alice.cookie } });
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("%PDF"));
  }, 120_000);

  test("the build decision report renders as a PDF end to end", async () => {
    expect((await call(alice, "POST", `/api/runs/${run}/artifacts`, { kind: "build_decision", format: "pdf" })).status).toBe(200);
    await work();
    const art = (await call(alice, "GET", `/api/deals/${deal}/artifacts`)).json.find((a: any) => a.kind === "build_decision");
    expect(art.status).toBe("ready");
    const file = await app.request(`/api/artifacts/${art.id}/file`, { headers: { cookie: alice.cookie } });
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("%PDF"));
  }, 120_000);

  test("the audit package validates itself, including an exact replay of the run", async () => {
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    expect(pkg.validation.status).toBe("passed");
    expect(pkg.validation.checks.map((c: any) => c.name)).toEqual(["input_hash", "result_hash", "signature", "replay", "decisions_bound", "audit_chain"]);
  });
});

describe("not found lines on a stored run", () => {
  test("the run keeps its list beside the input, and the hashes and replay are unchanged by it", async () => {
    const [{ snap }] = (await db.query<{ snap: { input: unknown; notFound: { fieldKey: string; detail: string }[] } }>(`select input_snapshot as snap from runs where id = $1`, [run])) as [{ snap: { input: unknown; notFound: { fieldKey: string; detail: string }[] } }];
    expect(Array.isArray(snap.notFound)).toBe(true);
    for (const i of snap.notFound) expect(typeof i.detail).toBe("string");
    const [{ input_hash }] = (await db.query<{ input_hash: string }>(`select input_hash from runs where id = $1`, [run])) as [{ input_hash: string }];
    expect(sha256(canonicalJson(snap.input))).toBe(input_hash);
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    expect(pkg.validation.status).toBe("passed");
    const review = (await call(alice, "GET", `/api/deals/${deal}/review`)).json;
    expect(Array.isArray(review.readiness.notFound)).toBe(true);
    expect(review.notFound.map((i: any) => i.fieldKey)).toEqual(review.readiness.notFound.map((i: any) => i.fieldKey));
  });
});

describe("sensitivity", () => {
  test("explores a stored run without writing anything", async () => {
    const count = async () => (await db.query<{ n: number }>(`select (select count(*) from runs) + (select count(*) from audit_events) + (select count(*) from run_metrics) as n`))[0]!.n;
    const before = await count();
    const base = await call(alice, "POST", `/api/runs/${run}/explore`, { shock: {} });
    const shocked = await call(alice, "POST", `/api/runs/${run}/explore`, { shock: { rentPct: -15, exitCapBps: 100 } });
    const t = await call(alice, "POST", `/api/runs/${run}/tornado`, { metric: "equity_multiple" });
    const g = await call(alice, "POST", `/api/runs/${run}/grid`, { metric: "sizing_dscr", x: "rateBps", y: "rentPct" });
    expect([base.status, shocked.status, t.status, g.status]).toEqual([200, 200, 200, 200]);
    expect(base.json.scratch).toBe(true);
    const em = (r: any) => r.json.scenarios[0].metrics.find((m: any) => m.key === "equity_multiple").value;
    expect(em(shocked)).toBeLessThan(em(base));
    expect(t.json.rows.length).toBe(8);
    expect(g.json.cells.length).toBe(5);
    expect(await count()).toBe(before);
  });
  test("breakeven returns one input at a time for each failing gate, and leaves the run exactly as it was", async () => {
    const stored = async () => canonicalJson(await db.query(`select r.*, (select count(*) from audit_events) as audit, (select count(*) from run_metrics) as metrics, (select count(*) from runs) as runs from runs r where r.id = $1`, [run]));
    const before = await stored();
    const b = await call(alice, "POST", `/api/runs/${run}/breakeven`, {});
    expect(b.status).toBe(200);
    expect(b.json.scratch).toBe(true);
    expect(Array.isArray(b.json.hardFails)).toBe(true);
    const failing = (await call(alice, "GET", `/api/runs/${run}`)).json.result.verdict.gates.filter((g: any) => g.status === "failed").map((g: any) => g.key);
    expect([...new Set(b.json.rows.map((r: any) => r.gate))].sort()).toEqual([...failing].sort());
    expect(b.json.rows.length).toBe(failing.length * 5);
    for (const r of b.json.rows) {
      expect(["value", "out_of_range", "no_effect", "not_monotonic"]).toContain(r.state);
      if (r.state !== "value") expect(r.shock).toBeNull();
    }
    expect(await stored()).toBe(before);
    const eve = await signup("eve2@example.com", "Eve Again");
    expect((await call(eve, "POST", `/api/runs/${run}/breakeven`, {})).status).toBe(404);
  });
  test("an input the engine refuses is a 422 with the reason, never a 500", async () => {
    // Runs are append-only; lift that for one statement to put an invalid input where readiness should have stopped it, then restore it.
    const [{ snap }] = (await db.query<{ snap: unknown }>(`select input_snapshot as snap from runs where id = $1`, [run])) as [{ snap: unknown }];
    const bad = JSON.stringify({ month: 1, ratePct: 5, amortYears: 30, ioMonths: 0 });
    await db.query(`alter table runs disable trigger runs_append_only`);
    try {
      await db.query(`update runs set input_snapshot = jsonb_set(input_snapshot, '{input,refinance}', $2::jsonb) where id = $1`, [run, bad]);
      const r = await call(alice, "POST", `/api/runs/${run}/explore`, { shock: {} });
      expect(r.status).toBe(422);
      expect(r.json.error).toMatch(/give the refinance either a loan amount or a loan-to-value/);
      expect(r.json.problems.length).toBeGreaterThan(0);
    } finally {
      await db.query(`update runs set input_snapshot = $2::jsonb where id = $1`, [run, JSON.stringify(snap)]);
      await db.query(`alter table runs enable trigger runs_append_only`);
    }
  });
  test("refuses shocks outside a driver's range", async () => {
    expect((await call(alice, "POST", `/api/runs/${run}/explore`, { shock: { exitCapBps: 5000 } })).status).toBe(422);
  });
  test("is invisible outside the workspace", async () => {
    const eve = await signup("eve@example.com", "Eve Elsewhere");
    expect((await call(eve, "POST", `/api/runs/${run}/explore`, { shock: {} })).status).toBe(404);
  });
});

describe("controls", () => {
  test("a material override needs a second, different person, and makes the run stale", async () => {
    const review = (await call(alice, "GET", `/api/deals/${deal}/review`)).json;
    const cap = review.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    const m = await call(alice, "POST", `/api/assumptions/${cap.id}/review`, { action: "modify", value: 5.25, reason: "Broker opinion of value received today", version: cap.version });
    expect(m.json.status).toBe("awaiting_second_approval");
    expect((await call(alice, "POST", `/api/assumptions/${cap.id}/review`, { action: "second_approve" })).status).toBe(403);
    expect((await call(bob, "POST", `/api/assumptions/${cap.id}/review`, { action: "second_approve" })).json.status).toBe("approved");
    const view = (await call(alice, "GET", `/api/runs/${run}`)).json;
    expect(view.fresh).toBe(false);
    expect(view.staleReasons).toEqual(["An approved input changed after this run."]);
  });

  test("a viewer can read but not change anything", async () => {
    expect((await call(carol, "GET", `/api/deals/${deal}`)).status).toBe(200);
    expect((await call(carol, "POST", `/api/deals/${deal}/runs`)).status).toBe(403);
  });

  test("someone outside the workspace sees nothing", async () => {
    const dave = await signup("dave@example.com", "Dave Elsewhere");
    expect((await call(dave, "GET", `/api/deals/${deal}`)).status).toBe(404);
    expect((await call(dave, "GET", `/api/runs/${run}`)).status).toBe(404);
    expect((await call(dave, "GET", `/api/deals/${deal}/documents`)).json).toEqual([]);
  });

  test("a file that is not what its name says is rejected by the structural check", async () => {
    const r = await call(alice, "PUT", `/api/deals/${deal}/documents?name=budget.pdf`, undefined, new TextEncoder().encode("not really a pdf"));
    await work();
    const doc = (await call(alice, "GET", `/api/deals/${deal}/documents`)).json.find((d: any) => d.id === r.json.id);
    expect(doc.stage).toBe("rejected");
    expect(doc.stage_detail).toMatch(/PDF/);
  });

  test("a request without the custom header is refused", async () => {
    const res = await app.request(`/api/deals/${deal}/runs`, { method: "POST", headers: { cookie: alice.cookie } });
    expect(res.status).toBe(403);
  });

  test("a new document that disagrees with an approved value reopens it", async () => {
    const r = await call(alice, "PUT", `/api/deals/${deal}/documents?name=appraisal-update.txt`, undefined, new TextEncoder().encode("Appraisal update\nExit cap rate: 5.50%\n"));
    expect(r.status).toBe(200);
    await work();
    const cap = (await call(alice, "GET", `/api/deals/${deal}/review`)).json.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    expect(cap.status).toBe("conflicting");
    // The analyst's override, the original appraisal and the new update: every value is on the table.
    expect(cap.conflictValues.map((v: any) => v.value).sort()).toEqual([4.75, 5.25, 5.5]);
  });

  test("an unrelated upload does not reopen a settled override", async () => {
    const review = (await call(alice, "GET", `/api/deals/${deal}/review`)).json;
    const cap = review.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    await call(alice, "POST", `/api/assumptions/${cap.id}/review`, { action: "resolve", value: 5.5, version: cap.version });
    await call(alice, "PUT", `/api/deals/${deal}/documents?name=site-notes.txt`, undefined, new TextEncoder().encode("Site notes\nParking stalls: 140\n"));
    await work();
    const after = (await call(alice, "GET", `/api/deals/${deal}/review`)).json.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    expect(after.status).toBe("approved");
  });

  test("an area stated in square metres is reviewed in square feet, and its source says it was converted", async () => {
    const d = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Whyte Fourplex", assetType: "Multifamily", location: "Edmonton", province: "AB" })).json.id;
    await call(alice, "PUT", `/api/deals/${d}/documents?name=plans.txt`, undefined, new TextEncoder().encode("Floor plans\nRetail area: 1,000 m²\n"));
    await work();
    const area = (await call(alice, "GET", `/api/deals/${d}/review`)).json.assumptions.find((a: any) => a.fieldKey === "rentable_area_sf");
    expect(area.value).toBeCloseTo(10_763.91, 2);
    expect(area.sources[0]).toMatchObject({ raw: "1,000 m²", unit_seen: "m2" });
    expect(sourceLabel({ source_kind: "document", sources: area.sources } as never)).toMatch(/^plans\.txt, .+, converted from square metres \("1,000 m²"\)$/);
  });
});

describe("a figure in another currency", () => {
  test("is kept as a source, never the value, and is settled by entering the amount", async () => {
    const d = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Cross-border Land", assetType: "Multifamily", location: "Windsor", province: "ON" })).json.id;
    const review = async () => (await call(alice, "GET", `/api/deals/${d}/review`)).json.assumptions.find((a: any) => a.fieldKey === "land_cost");
    await call(alice, "PUT", `/api/deals/${d}/documents?name=budget.txt`, undefined, new TextEncoder().encode("Budget\nLand cost: US$1,200,000\n"));
    await work();
    const land = await review();
    expect(land).toMatchObject({
      status: "conflicting",
      value: null,
      conflictValues: [],
      reason: "A document states this in USD; this deal is in CAD. Enter the amount in CAD.",
    });
    expect(land.sources[0]).toMatchObject({ value: 1_200_000, raw: "US$1,200,000", unit_seen: "USD" });
    // The foreign figure is not a documented value, so it cannot be chosen.
    const pick = await call(alice, "POST", `/api/assumptions/${land.id}/review`, { action: "resolve", value: 1_200_000, version: land.version });
    expect(pick.status).toBeGreaterThanOrEqual(400);
    // Entering the amount in the deal's currency settles it, and a later reconcile leaves it settled.
    const done = await call(alice, "POST", `/api/assumptions/${land.id}/review`, { action: "modify", value: 1_650_000, reason: "Converted at the closing rate", version: land.version });
    expect(done.status).toBe(200);
    await call(alice, "PUT", `/api/deals/${d}/documents?name=notes.txt`, undefined, new TextEncoder().encode("Notes\nParking stalls: 40\n"));
    await work();
    expect(await review()).toMatchObject({ status: "approved", value: 1_650_000 });
  });
});

describe("reading a later document", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  const newDeal = async (name: string) =>
    (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name, assetType: "Multifamily", location: "Windsor", province: "ON" })).json.id;
  const field = async (d: string, key: string) => (await call(alice, "GET", `/api/deals/${d}/review`)).json.assumptions.find((a: any) => a.fieldKey === key);
  const read = async (d: string, name: string, text: string) => {
    await call(alice, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, enc(text));
    await work();
  };

  test("leaves a value's version alone when nothing it shows changed, so a confirm still lands", async () => {
    const d = await newDeal("Stable Versions");
    await read(d, "land.txt", "Budget\nLand cost: $1,200,000\n");
    const before = await field(d, "land_cost");
    expect(before).toMatchObject({ status: "needs_review", value: 1_200_000 });
    await read(d, "hard.txt", "Budget\nHard costs: $5,000,000\n");
    const after = await field(d, "land_cost");
    expect(after.version).toBe(before.version);
    const ok = await call(alice, "POST", `/api/assumptions/${before.id}/review`, { action: "approve", version: before.version });
    expect(ok.status).toBe(200);
  });

  test("bumps the version when a second document adds a source to the same value", async () => {
    const d = await newDeal("Added Source");
    await read(d, "land.txt", "Budget\nLand cost: $1,200,000\n");
    const before = await field(d, "land_cost");
    await read(d, "land-again.txt", "Closing summary\nLand cost: $1,200,000\n");
    const after = await field(d, "land_cost");
    expect(after).toMatchObject({ status: "needs_review", value: 1_200_000 });
    expect(after.sources).toHaveLength(2);
    expect(after.version).toBe(before.version + 1);
  });

  test("bumps the version when a second document disagrees", async () => {
    const d = await newDeal("Disagreement");
    await read(d, "land.txt", "Budget\nLand cost: $1,200,000\n");
    const before = await field(d, "land_cost");
    await read(d, "land-other.txt", "Closing summary\nLand cost: $1,300,000\n");
    const after = await field(d, "land_cost");
    expect(after.status).toBe("conflicting");
    expect(after.version).toBe(before.version + 1);
  });
});

describe("a new run after a change", () => {
  const selling = async () => (await call(alice, "GET", `/api/deals/${deal}/review`)).json.assumptions.find((a: any) => a.fieldKey === "selling_costs_pct");
  const review = async (action: string) => {
    const a = await selling();
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action, version: a.version })).status).toBe(200);
  };
  const acceptDefault = async () => {
    await review("reject");
    expect((await call(alice, "POST", `/api/deals/${deal}/defaults`, { fields: ["selling_costs_pct"] })).json.accepted).toBe(1);
  };
  const runNow = async () => {
    const r = await call(alice, "POST", `/api/deals/${deal}/runs`);
    expect(r.status).toBe(200);
    return (await call(alice, "GET", `/api/runs/${r.json.id}`)).json;
  };

  test("is current when only a status changed: a default approved as it stands", async () => {
    await acceptDefault();
    const first = await runNow();
    await review("reopen");
    await review("approve");
    const second = await runNow();
    expect(second.id).not.toBe(first.id);
    expect(second.fresh).toBe(true);
  });

  test("is current when the inputs change back to an earlier run's", async () => {
    const before = await runNow();
    await acceptDefault();
    const back = await runNow();
    expect(back.number).toBe(before.number + 1);
    expect([back.fresh, back.isLatest]).toEqual([true, true]);
  });
});

describe("solo review", () => {
  const cap = async () => (await call(alice, "GET", `/api/deals/${deal}/review`)).json.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
  const runNow = async () => {
    const r = await call(alice, "POST", `/api/deals/${deal}/runs`);
    expect(r.status).toBe(200);
    return (await call(alice, "GET", `/api/runs/${r.json.id}`)).json;
  };
  const exitCap = (view: any) => view.inputs.find((i: any) => i.fieldKey === "exit_cap_rate_pct");

  test("a value you state is used at once, labelled until someone else confirms it", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "solo" })).status).toBe(200);
    expect((await call(alice, "GET", "/api/me")).json.workspaces[0].review_mode).toBe("solo");
    const a = await cap();
    const m = await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "modify", value: 5, reason: "Lender term sheet", version: a.version });
    expect(m.json.status).toBe("approved");
    expect((await cap()).sponsorStated).toBe(true);
    const first = await runNow();
    expect(exitCap(first)).toMatchObject({ sponsorStated: true, confirmedBy: null });
    const b = await cap();
    expect((await call(bob, "POST", `/api/assumptions/${b.id}/review`, { action: "second_approve", version: b.version })).status).toBe(200);
    expect((await call(alice, "GET", `/api/runs/${first.id}`)).json.fresh).toBe(false);
    const second = await runNow();
    expect(exitCap(second)).toMatchObject({ sponsorStated: false, confirmedBy: "Bob Approver" });
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "team" })).status).toBe(200);
  });
});

describe("Agir review", () => {
  test("a reviewer's confirmation is labelled on the review and on the next run", async () => {
    const rowan = await signup("rowan@example.com", "Rowan Reviewer");
    const cap = async () => (await call(alice, "GET", `/api/deals/${deal}/review`)).json.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "solo" })).status).toBe(200);
    const a = await cap();
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "modify", value: 5.5, reason: "Broker opinion of value", version: a.version })).status).toBe(200);
    expect((await call(bob, "POST", `/api/workspaces/${ws}/review-grant`, { email: "rowan@example.com", days: 14 })).status).toBe(403);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant`, { email: "rowan@example.com", days: 0 })).status).toBe(422);
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-grant`, { email: "rowan@example.com", days: 14 })).status).toBe(200);
    const members = (await call(alice, "GET", `/api/workspaces/${ws}/members`)).json;
    expect(members.find((m: any) => m.email === "rowan@example.com")).toMatchObject({ role: "reviewer" });
    expect(members.find((m: any) => m.email === "rowan@example.com").expires_at).not.toBeNull();
    const b = await cap();
    expect(b).toMatchObject({ sponsorStated: true, confirmedByReview: false });
    expect((await call(rowan, "POST", `/api/assumptions/${b.id}/review`, { action: "second_approve", version: b.version })).status).toBe(200);
    expect(await cap()).toMatchObject({ sponsorStated: false, confirmedByReview: true, secondApprover: "Rowan Reviewer" });
    const r = await call(alice, "POST", `/api/deals/${deal}/runs`);
    const input = (await call(alice, "GET", `/api/runs/${r.json.id}`)).json.inputs.find((i: any) => i.fieldKey === "exit_cap_rate_pct");
    expect(input).toMatchObject({ confirmedBy: "Rowan Reviewer", confirmedByReview: true });
    expect(input.confirmedAt).not.toBeNull();
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "team" })).status).toBe(200);
  });
});

describe("model label suggestions", () => {
  let sw: string, sd: string;
  const calls: SuggestRequest[] = [];
  let reply: (req: SuggestRequest) => SuggestReply | Promise<SuggestReply>;
  const suggest = async (req: SuggestRequest) => {
    calls.push(req);
    return reply(req);
  };
  const figuresOf = (req: SuggestRequest): { id: string; raw: string }[] => JSON.parse(req.messages[0]!.content).figures;
  const ok = (suggestions: unknown[]): SuggestReply => ({ model: "claude-fake-served", stop_reason: "end_turn", text: JSON.stringify({ suggestions }) });
  const wk = () => drain({ db, store, suggest });
  const put = async (d: string, name: string, text: string) =>
    expect((await call(alice, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
  const newDeal = async (name: string) => (await call(alice, "POST", `/api/workspaces/${sw}/deals`, { name, assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id as string;
  const rows = () => db.query<any>(`select * from label_suggestions order by created_at, document_id`);
  const assumptions = async (d = sd) => (await call(alice, "GET", `/api/deals/${d}/review`)).json.assumptions as any[];
  const byField = async (k: string) => (await assumptions()).find((a) => a.fieldKey === k);
  const three = "Project notes\nWidget allowance: $5,000\nLandscaping reserve of $12,000 is held\nSignage kit: $3,000\n";

  test("with the switch off the provider is never called and nothing is stored", async () => {
    sw = (await call(alice, "POST", "/api/workspaces", { name: "Suggesting" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${sw}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
    sd = await newDeal("Suggest Heights");
    reply = () => ok([]);
    await put(sd, "off.txt", "Project notes\nBanner allowance: $7,000\n");
    await wk();
    expect(calls).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect((await call(alice, "GET", "/api/me")).json.workspaces.find((w: any) => w.id === sw).label_suggestions).toBe(false);
  });

  test("only an owner can turn it on", async () => {
    expect((await call(bob, "POST", `/api/workspaces/${sw}/label-suggestions`, { on: true })).status).toBe(403);
    expect((await call(alice, "POST", `/api/workspaces/${sw}/label-suggestions`, { on: true })).status).toBe(200);
    expect((await call(alice, "GET", "/api/me")).json.workspaces.find((w: any) => w.id === sw).label_suggestions).toBe(true);
    const ev = await db.query<any>(`select payload from audit_events where action = 'workspace.label_suggestions_changed' and workspace_id = $1`, [sw]);
    expect(ev).toHaveLength(1);
  });

  test("the provider gets only the offered figures; a kept suggestion reaches review as a suggested label", async () => {
    reply = (req) =>
      ok([
        ...figuresOf(req).map((f) => ({ id: f.id, fieldKey: { "$5,000": "other_cost", "$12,000": "stabilized_occupancy_pct", "$3,000": "land_cost" }[f.raw] ?? "ignore", itemKey: null })),
        { id: "nowhere|line 9|$1", fieldKey: "other_cost", itemKey: null },
      ]);
    await put(sd, "three.txt", three);
    await wk();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.messages[0]!.content);
    expect(Object.keys(body).sort()).toEqual(["catalog", "figures"]);
    expect(body.figures).toHaveLength(3);
    for (const f of body.figures) expect(Object.keys(f).sort()).toEqual(["context", "id", "location", "raw", "unitSeen", "value"]);
    expect(Object.keys(body.catalog[0]).sort()).toEqual(["aliases", "itemized", "key", "label", "unit"]);
    expect(JSON.stringify(calls[0])).not.toMatch(/Suggest Heights|Suggesting|Burnaby/);
    expect(calls[0]).toMatchObject({ output_config: { effort: "medium", format: { type: "json_schema" } }, thinking: { type: "adaptive" }, max_tokens: 16000, fallbacks: "default" });
    const [row] = await rows();
    expect(row).toMatchObject({ model: "claude-fake-served", outcome: "ok", stop_reason: "end_turn", prompt_hash: sha256(JSON.stringify(calls[0])), workspace_id: sw, deal_id: sd });
    expect(row.request).toEqual(JSON.parse(JSON.stringify(calls[0])));
    expect(row.response).toHaveLength(4);
    for (const k of ["other_cost", "land_cost"]) {
      const a = await byField(k);
      expect(a).toMatchObject({ status: "needs_review" });
      expect(a.sources[0]).toMatchObject({ rule: "suggested", note: expect.stringContaining("Suggested label") });
    }
    expect(await byField("stabilized_occupancy_pct")).toBeUndefined();
  });

  test("a person approving a suggested value is audited, with the suggestion marked", async () => {
    const a = await byField("other_cost");
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    const [ev] = await db.query<any>(`select payload from audit_events where action = 'assumption.approve' and entity_id = $1`, [a.id]);
    expect(ev.payload).toMatchObject({ field: "other_cost", to: "approved", suggested: true });
  });

  test("a reconcile never calls the model, and gives the same answer each time", async () => {
    const snap = async () => (await assumptions()).map((a) => [a.fieldKey, a.status, a.value, a.version, a.sources.map((s: any) => s.rule)]);
    const before = await snap();
    const n = calls.length;
    await reconcileDeal(db, sd);
    await reconcileDeal(db, sd);
    expect(await snap()).toEqual(before);
    expect(calls).toHaveLength(n);
  });

  test("a document with more than 100 figures is sent in batches of at most 100", async () => {
    const d = await newDeal("Many figures");
    reply = (req) => ok(figuresOf(req).map((f) => ({ id: f.id, fieldKey: "ignore", itemKey: null })));
    const before = calls.length;
    await put(d, "many.txt", Array.from({ length: 130 }, (_, i) => `Gadget ${i} reserve: $${1000 + i}`).join("\n") + "\n");
    await wk();
    const sizes = calls.slice(before).map((c) => figuresOf(c).length);
    const all = calls.slice(before).flatMap((c) => figuresOf(c).map((f) => f.id));
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.slice(0, -1)).toEqual(sizes.slice(0, -1).map(() => 100));
    expect(sizes.at(-1)).toBeLessThanOrEqual(100);
    expect(all.length).toBeGreaterThanOrEqual(130);
    expect(new Set(all).size).toBe(all.length);
  });

  test("a refusal, a cut-off and an API error each store a row, and the document still ends extracted", async () => {
    const d = await newDeal("Failing");
    const cases: [string, () => SuggestReply, string, string | null][] = [
      ["refusal.txt", () => ({ model: "claude-fake-served", stop_reason: "refusal", text: "" }), "refused", "refusal"],
      ["cut.txt", () => ({ model: "claude-fake-served", stop_reason: "max_tokens", text: "{" }), "failed", "max_tokens"],
      ["error.txt", () => { throw Anthropic.APIError.generate(500, { error: { message: "down" } }, "down", new Headers()); }, "failed", null],
    ];
    for (const [i, [name, r, outcome, stop]] of cases.entries()) {
      reply = r;
      await put(d, name, `Project notes\nHard costs: $2,000,000\nKiosk allowance: $${2000 + i}\n`);
      await wk();
      const [doc] = await db.query<any>(`select id, stage from documents where deal_id = $1 and name = $2`, [d, name]);
      expect(doc.stage).toBe("extracted");
      expect((await db.query<any>(`select 1 from candidates where document_id = $1 and field_key = 'hard_cost'`, [doc.id])).length).toBe(1);
      const [row] = await db.query<any>(`select * from label_suggestions where document_id = $1`, [doc.id]);
      expect(row).toMatchObject({ outcome, stop_reason: stop });
      expect(row.response === null || row.response.error === "InternalServerError").toBe(true);
    }
    expect((await db.query<any>(`select payload from audit_events where action = 'document.suggestions_failed' and deal_id = $1`, [d])).length).toBe(1);
  });

  test("turning the switch off takes suggested values out of review; an approved one goes back to confirm, as when its document is retired", async () => {
    const n = calls.length;
    expect((await call(alice, "POST", `/api/workspaces/${sw}/label-suggestions`, { on: false })).status).toBe(200);
    await wk();
    expect(calls).toHaveLength(n);
    expect((await byField("land_cost"))?.status ?? "rejected").toBe("rejected");
    expect(await byField("other_cost")).toMatchObject({ status: "needs_review", value: 5000, reason: "Its label was a model's suggestion, and suggestions are now off; confirm or reject it" });
  });
});

describe("a person labels a figure Agir did not use (task 58)", () => {
  let lw: string, ld: string;
  const put = async (name: string, text: string) =>
    expect((await call(alice, "PUT", `/api/deals/${ld}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
  const review = async (s = alice) => (await call(s, "GET", `/api/deals/${ld}/review`)).json;
  const row = async (raw: string) => (await review()).other.find((o: any) => o.raw === raw);
  const byField = async (k: string) => (await review()).assumptions.find((a: any) => a.fieldKey === k);

  test("with label suggestions off, a labelled figure reaches review as a labelled value and an approval is audited", async () => {
    lw = (await call(alice, "POST", "/api/workspaces", { name: "Labelling" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${lw}/members`, { email: "carol@example.com", role: "viewer" })).status).toBe(200);
    ld = (await call(alice, "POST", `/api/workspaces/${lw}/deals`, { name: "Label Heights", assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    await put("notes.txt", "Project notes\nBanner allowance: $7,000\nSignage kit: $3,000\n");
    await work();
    const r = await row("$7,000");
    expect(r).toMatchObject({ value: 7000, label: null });
    expect(r.figureId).toEqual(expect.any(String));
    expect(await byField("other_cost")).toBeUndefined();
    const body = { documentId: r.documentId, figureId: r.figureId, fieldKey: "other_cost" };
    expect((await call(carol, "POST", `/api/deals/${ld}/figure-labels`, body)).status).toBe(403);
    expect((await call(alice, "POST", `/api/deals/${ld}/figure-labels`, { ...body, fieldKey: "no_such_field" })).status).toBe(422);
    expect((await call(alice, "POST", `/api/deals/${ld}/figure-labels`, body)).status).toBe(200);
    await work();
    const a = await byField("other_cost");
    expect(a).toMatchObject({ status: "needs_review", value: 7000 });
    expect(a.sources[0]).toMatchObject({ rule: "labelled", raw: "$7,000", document_name: "notes.txt", note: expect.stringContaining("Labelled by a person") });
    expect((await row("$7,000")).label).toMatchObject({ fieldKey: "other_cost", by: "Alice Analyst" });
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    const [ev] = await db.query<any>(`select payload from audit_events where action = 'assumption.approve' and entity_id = $1`, [a.id]);
    expect(ev.payload).toMatchObject({ field: "other_cost", to: "approved", labelled: true });
    expect((await db.query<any>(`select payload from audit_events where action = 'figure.labelled' and deal_id = $1`, [ld]))[0].payload).toMatchObject({ field: "other_cost" });
  });

  test("undo removes the label and its value; a viewer cannot undo", async () => {
    const r = await row("$3,000");
    const body = { documentId: r.documentId, figureId: r.figureId };
    expect((await call(alice, "POST", `/api/deals/${ld}/figure-labels`, { ...body, fieldKey: "land_cost" })).status).toBe(200);
    await work();
    expect(await byField("land_cost")).toMatchObject({ status: "needs_review" });
    expect((await call(carol, "DELETE", `/api/deals/${ld}/figure-labels`, body)).status).toBe(403);
    expect((await call(alice, "DELETE", `/api/deals/${ld}/figure-labels`, body)).status).toBe(200);
    await work();
    expect((await byField("land_cost"))?.status ?? "rejected").toBe("rejected");
    expect((await row("$3,000")).label).toBeNull();
    expect((await db.query<any>(`select seq from audit_events where action = 'figure.unlabelled' and deal_id = $1`, [ld]))).toHaveLength(1);
  });

  test("a label whose figure is gone is dropped at reconcile, and the audit says so", async () => {
    const r = await row("$3,000");
    await db.query(`insert into figure_labels (deal_id, workspace_id, document_id, figure_id, field_key, created_by) select $1, $2, $3, 'nowhere|line 9|$1', 'land_cost', id from users where email = 'alice@example.com'`, [ld, lw, r.documentId]);
    await reconcileDeal(db, ld);
    const [ev] = await db.query<any>(`select payload from audit_events where action = 'assumptions.reconciled' and deal_id = $1 order by seq desc limit 1`, [ld]);
    expect(ev.payload.labelDropped).toEqual([expect.objectContaining({ id: "nowhere|line 9|$1" })]);
  });
});

describe("audit of task 58: a label is checked when it is saved, and in team review one's own label needs a second person", () => {
  let aw: string, ad: string;
  const review = async () => (await call(alice, "GET", `/api/deals/${ad}/review`)).json;
  const row = async (raw: string) => (await review()).other.find((o: any) => o.raw === raw);
  const byField = async (k: string) => (await review()).assumptions.find((a: any) => a.fieldKey === k);
  const labelAs = async (raw: string, fieldKey: string, itemKey?: string) => {
    const r = await row(raw);
    return call(alice, "POST", `/api/deals/${ad}/figure-labels`, { documentId: r.documentId, figureId: r.figureId, fieldKey, ...(itemKey ? { itemKey } : {}) });
  };

  test("a label the boundary would refuse is refused with its reason, and nothing is stored", async () => {
    aw = (await call(alice, "POST", "/api/workspaces", { name: "Label audit" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${aw}/members`, { email: "bob@example.com", role: "analyst" })).status).toBe(200);
    expect((await call(alice, "POST", `/api/workspaces/${aw}/review-mode`, { mode: "team" })).status).toBe(200);
    ad = (await call(alice, "POST", `/api/workspaces/${aw}/deals`, { name: "Audit Row", assetType: "Multifamily", location: "Regina", province: "SK" })).json.id;
    expect((await call(alice, "PUT", `/api/deals/${ad}/documents?name=audit.txt`, undefined, new TextEncoder().encode("Gauge: 5.25%\nTariff: $2,350\nQuota: 6.10%\n"))).status).toBe(200);
    await work();
    const bad = await labelAs("$2,350", "construction_months");
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.json)).toMatch(/does not fit/);
    expect(await db.query(`select 1 from figure_labels where deal_id = $1`, [ad])).toHaveLength(0);
  });

  test("a plain dollar figure labelled as a monthly rent reaches review", async () => {
    expect((await labelAs("$2,350", "unit_rent_monthly", "2-bed")).status).toBe(200);
    await work();
    expect(await byField("unit_rent_monthly")).toMatchObject({ status: "needs_review", value: 2350, itemKey: "2BR" });
  });

  test("in team review, approving a material value only one's own label supports waits for someone else", async () => {
    expect((await labelAs("5.25%", "exit_cap_rate_pct")).status).toBe(200);
    await work();
    const a = await byField("exit_cap_rate_pct");
    expect(a).toMatchObject({ status: "needs_review", value: 5.25 });
    expect(a.sources[0]).toMatchObject({ rule: "labelled" });
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    const waiting = await byField("exit_cap_rate_pct");
    expect(waiting.status).toBe("awaiting_second_approval");
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "second_approve", version: waiting.version })).status).toBe(403);
    expect((await call(bob, "POST", `/api/assumptions/${a.id}/review`, { action: "second_approve", version: waiting.version })).status).toBe(200);
    expect(await byField("exit_cap_rate_pct")).toMatchObject({ status: "approved", value: 5.25 });
    const [row0] = await db.query<any>(`select * from assumptions where id = $1`, [a.id]);
    expect(sourceLabel(row0)).toMatch(/audit\.txt, .*labelled by a person/);
  });

  test("in solo review the same person approves their own label at once", async () => {
    expect((await call(alice, "POST", `/api/workspaces/${aw}/review-mode`, { mode: "solo" })).status).toBe(200);
    expect((await labelAs("6.10%", "senior_rate_pct")).status).toBe(200);
    await work();
    const a = await byField("senior_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    expect(await byField("senior_rate_pct")).toMatchObject({ status: "approved", value: 6.1 });
  });
});

describe("task 59: a person working alone is not blocked on day one", () => {
  const modeOf = async (s: Session) => (await call(s, "GET", "/api/me")).json.workspaces[0];
  const newDeal = async (s: Session, w: string, name: string) =>
    (await call(s, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", location: "Calgary", province: "AB" })).json.id as string;
  const exitCap = async (s: Session, d: string) => (await call(s, "GET", `/api/deals/${d}/review`)).json.assumptions.find((a: any) => a.fieldKey === "exit_cap_rate_pct");
  let sam: Session, tina: Session, sw: string, sd: string;

  test("a sign-up that chooses solo gets a solo workspace, and the change is audited", async () => {
    sam = await signup("sam@example.com", "Sam Solo", "solo");
    const w = await modeOf(sam);
    expect(w.review_mode).toBe("solo");
    sw = w.id;
    const ev = await db.query<any>(`select payload from audit_events where action = 'workspace.review_mode_changed' and workspace_id = $1`, [sw]);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ from: "team", to: "solo" });
  });

  test("a sign-up that chooses team keeps team review", async () => {
    tina = await signup("tina@example.com", "Tina Team", "team");
    expect((await modeOf(tina)).review_mode).toBe("team");
    expect((await call(null, "POST", "/api/auth/signup", { email: "bad@example.com", name: "Bad", password: "correct horse battery", reviewMode: "both" })).status).toBe(422);
  });

  test("in a team workspace a material entry waits; after the switch to solo its author uses it as stated", async () => {
    const tw = (await modeOf(tina)).id;
    expect((await call(tina, "POST", `/api/workspaces/${tw}/members`, { email: "carol@example.com", role: "analyst" })).status).toBe(200);
    const d = await newDeal(tina, tw, "Team Fourplex");
    expect((await call(tina, "POST", `/api/deals/${d}/values`, { fieldKey: "exit_cap_rate_pct", value: 5.5, reason: "Broker opinion" })).json.status).toBe("awaiting_second_approval");
    const a = await exitCap(tina, d);
    expect(a.status).toBe("awaiting_second_approval");
    // In team review it is refused, with a message that says so.
    const refused = await call(tina, "POST", `/api/assumptions/${a.id}/review`, { action: "use_as_stated", version: a.version });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.json)).toMatch(/solo review/);
    expect((await call(tina, "POST", `/api/workspaces/${tw}/review-mode`, { mode: "solo" })).status).toBe(200);
    const b = await exitCap(tina, d);
    expect(b.status).toBe("awaiting_second_approval");
    // Another person cannot use it as stated.
    expect((await call(carol, "POST", `/api/assumptions/${b.id}/review`, { action: "use_as_stated", version: b.version })).status).toBe(403);
    const used = await call(tina, "POST", `/api/assumptions/${b.id}/review`, { action: "use_as_stated", version: b.version });
    expect(used.status).toBe(200);
    expect(await exitCap(tina, d)).toMatchObject({ status: "approved", value: 5.5, sponsorStated: true, secondApprover: null });
    const [row] = await db.query<any>(`select source_kind, second_approver, pending_value from assumptions where id = $1`, [b.id]);
    expect(row).toMatchObject({ source_kind: "analyst", second_approver: null, pending_value: null });
    expect(await db.query(`select 1 from assumption_events where assumption_id = $1 and action = 'use_as_stated'`, [b.id])).toHaveLength(1);
    expect(await db.query(`select 1 from audit_events where action = 'assumption.use_as_stated' and workspace_id = $1`, [tw])).toHaveLength(1);
    // Once approved it is no longer waiting, so the action is refused.
    expect((await call(tina, "POST", `/api/assumptions/${b.id}/review`, { action: "use_as_stated", version: used.json.version })).status).toBe(422);
  });

  test("a deal with approved values, a run and no documents is at the decision step, not at documents", async () => {
    sd = await newDeal(sam, sw, "Fictional Fourplex");
    const empty = (await call(sam, "GET", `/api/deals/${sd}`)).json;
    expect(empty).toMatchObject({ step: "documents", next: "Upload the deal documents" });
    const put = async (fieldKey: string, value: number, itemKey?: string) =>
      expect((await call(sam, "POST", `/api/deals/${sd}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
    await put("exit_cap_rate_pct", 5.5);
    const partial = (await call(sam, "GET", `/api/deals/${sd}`)).json;
    expect(partial.step).toBe("review");
    expect((await call(sam, "GET", `/api/workspaces/${sw}/deals`)).json.find((x: any) => x.deal.id === sd).step).toBe("review");
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["senior_loan_amount", 2000000], ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) await put(f, v, i);
    expect((await call(sam, "POST", `/api/deals/${sd}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
    expect((await call(sam, "POST", `/api/deals/${sd}/runs`)).status).toBe(200);
    const o = (await call(sam, "GET", `/api/deals/${sd}`)).json;
    expect(o).toMatchObject({ step: "decision", next: "Record the committee decision" });
    expect(o.status.text).toMatch(/^Verdict: /);
    expect((await call(sam, "GET", `/api/workspaces/${sw}/deals`)).json.find((x: any) => x.deal.id === sd)).toMatchObject({ step: "decision", next: "Record the committee decision" });
  });
});

describe("audit of task 59: using one's own label as stated keeps its document source", () => {
  test("a labelled material value waiting in team review, used as stated after the switch to solo, still names its document", async () => {
    const ws = (await call(alice, "POST", "/api/workspaces", { name: "Label then solo", reviewMode: "team" })).json.id;
    const deal = (await call(alice, "POST", `/api/workspaces/${ws}/deals`, { name: "Kept Source", assetType: "Multifamily", location: "Moncton", province: "NB" })).json.id;
    expect((await call(alice, "PUT", `/api/deals/${deal}/documents?name=kept.txt`, undefined, new TextEncoder().encode("Gauge: 5.75%\n"))).status).toBe(200);
    await work();
    const review = async () => (await call(alice, "GET", `/api/deals/${deal}/review`)).json;
    const fig = (await review()).other.find((o: any) => o.raw === "5.75%");
    expect((await call(alice, "POST", `/api/deals/${deal}/figure-labels`, { documentId: fig.documentId, figureId: fig.figureId, fieldKey: "exit_cap_rate_pct" })).status).toBe(200);
    await work();
    const a = (await review()).assumptions.find((x: any) => x.fieldKey === "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    expect((await review()).assumptions.find((x: any) => x.fieldKey === "exit_cap_rate_pct").status).toBe("awaiting_second_approval");
    expect((await call(alice, "POST", `/api/workspaces/${ws}/review-mode`, { mode: "solo" })).status).toBe(200);
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "use_as_stated" })).status).toBe(200);
    const [row] = await db.query<any>(`select * from assumptions where id = $1`, [a.id]);
    expect(row).toMatchObject({ status: "approved", value: 5.75, source_kind: "document", second_approver: null });
    expect(sourceLabel(row)).toMatch(/kept\.txt, .*labelled by a person/);
  });
});

describe("card 60: a deal that is kept and refinanced runs under its own policy", () => {
  let hal: Session, hw: string, hd: string, holdRun: string;
  const sha = (x: unknown) => sha256(canonicalJson(x));
  // A build, lease-up, and a refinance at month 24 sized by loan-to-value. Hold 5 years (the accepted default).
  const put = async (d: string, fieldKey: string, value: number, itemKey?: string) =>
    expect((await call(hal, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
  const fill = async (d: string, flag: boolean) => {
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30], ["refinance_month", 24], ["refinance_ltv_pct", 65], ["refinance_rate_pct", 5], ["refinance_amort_years", 30]] as [string, number, string?][]) await put(d, f, v, i);
    if (flag) await put(d, "refinance_and_hold", 1);
    expect((await call(hal, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
  };

  test("a hold-mode run records the draft policy and its hash, and is fresh after creation", async () => {
    hal = await signup("hal@example.com", "Hal Holder", "solo");
    hw = (await call(hal, "GET", "/api/me")).json.workspaces[0].id;
    hd = (await call(hal, "POST", `/api/workspaces/${hw}/deals`, { name: "Kept Fourplex", assetType: "Multifamily", location: "Calgary", province: "AB" })).json.id;
    await fill(hd, true);
    const r = await call(hal, "POST", `/api/deals/${hd}/runs`);
    expect(r.status).toBe(200);
    holdRun = r.json.id;
    const view = (await call(hal, "GET", `/api/runs/${holdRun}`)).json;
    expect(view).toMatchObject({ policyVersion: "rental-hold-draft", fresh: true, staleReasons: [] });
    expect(view.result.verdict.gates).toHaveLength(4);
    expect(view.result.scenarios[0].metrics.some((m: any) => m.key === "refinance_cash_returned")).toBe(true);
    const [row] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [holdRun]);
    expect(row).toMatchObject({ policy_version: "rental-hold-draft", policy_hash: POLICY_HASHES["rental-hold-draft"] });
    expect(row.policy_hash).not.toBe(sha(POLICY_V1));
    expect((await call(hal, "GET", `/api/deals/${hd}`)).json.status.text).toMatch(/^Verdict: /);
    const overview = (await call(hal, "GET", `/api/deals/${hd}`)).json;
    expect(overview.step).toBe("decision");
  });

  test("it replays: the audit package validates, signature and replay included", async () => {
    const pkg = (await call(hal, "GET", `/api/runs/${holdRun}/audit-package`)).json;
    expect(pkg.validation.checks.filter((c: any) => c.status !== "passed")).toEqual([]);
    expect(pkg.validation.status).toBe("passed");
  });

  test("the sensitivity routes use the run's own policy", async () => {
    const e = (await call(hal, "POST", `/api/runs/${holdRun}/explore`, { shock: {} })).json;
    expect(e.policyVersion).toBe("rental-hold-draft");
    expect(e.verdict.gates).toHaveLength(4);
    const b = await call(hal, "POST", `/api/runs/${holdRun}/breakeven`, {});
    expect(b.status).toBe(200);
  });

  // Consolidation: drafts are edited in place, so a run keeps the policy it ran under and replays under that copy.
  test("after its draft is edited, a run replays and explores under its stored policy, and is stale", async () => {
    const [{ snap }] = await db.query<any>(`select input_snapshot as snap from runs where id = $1`, [holdRun]);
    expect(snap.policy).toEqual(POLICIES["rental-hold-draft"]);
    const registry = POLICIES as Record<string, Policy>;
    const hashes = POLICY_HASHES as Record<string, string>;
    const [original, originalHash] = [registry["rental-hold-draft"]!, hashes["rental-hold-draft"]!];
    // The draft as a later build might edit it: a stricter refinance DCR floor.
    const edited = { ...original, gates: { ...original.gates, dcrAfterRefinanceMin: 9 } };
    registry["rental-hold-draft"] = edited;
    hashes["rental-hold-draft"] = sha(edited);
    try {
      const view = (await call(hal, "GET", `/api/runs/${holdRun}`)).json;
      expect(view).toMatchObject({ policyDraft: true, fresh: false, staleReasons: ["The policy thresholds changed after this run."] });
      expect((await call(hal, "GET", `/api/runs/${holdRun}/audit-package`)).json.validation.status).toBe("passed");
      const e = (await call(hal, "POST", `/api/runs/${holdRun}/explore`, { shock: {} })).json;
      expect(e.verdict.gates.find((g: any) => g.metricKey === "dcr_after_refinance").threshold).toBe(1.2);
    } finally {
      registry["rental-hold-draft"] = original;
      hashes["rental-hold-draft"] = originalHash;
    }
  });

  test("the catalog exposes the registry so the web can label a draft policy", async () => {
    const cat = (await call(hal, "GET", "/api/catalog")).json;
    expect(cat.policy.version).toBe("policy-v1");
    expect(cat.policies["policy-v1"].draft).toBeUndefined();
    expect(cat.policies["rental-hold-draft"].draft).toBe(true);
  });

  test("a decision can be recorded on a draft policy run, and the artifacts carry the draft line", async () => {
    const view = (await call(hal, "GET", `/api/runs/${holdRun}`)).json;
    const body = view.result.verdict.code === "APPROVE"
      ? { decision: "approve", rationale: "Holds its coverage after the refinance" }
      : view.result.verdict.code === "APPROVE_WITH_CONDITIONS"
        ? { decision: "approve_with_conditions", rationale: "Holds its coverage after the refinance", conditions: "Lender to confirm the take-out terms" }
        : { decision: "reject", rationale: "Does not hold its coverage after the refinance" };
    expect((await call(hal, "POST", `/api/runs/${holdRun}/decision`, body)).status).toBe(200);
    for (const [kind, format] of [["ic_memo", "docx"], ["lender_package", "docx"], ["model_export", "xlsx"]]) {
      expect((await call(hal, "POST", `/api/runs/${holdRun}/artifacts`, { kind, format })).status).toBe(200);
    }
    await work();
    const arts = (await call(hal, "GET", `/api/deals/${hd}/artifacts`)).json;
    expect(arts.map((a: any) => a.status)).toEqual(["ready", "ready", "ready"]);
  }, 120_000);

  test("a policy-v1 run is still fresh, with the hash it was pinned to before this card", async () => {
    const sd = (await call(hal, "POST", `/api/workspaces/${hw}/deals`, { name: "Sold Fourplex", assetType: "Multifamily", location: "Calgary", province: "AB" })).json.id;
    await fill(sd, false);
    const r = await call(hal, "POST", `/api/deals/${sd}/runs`);
    expect(r.status).toBe(200);
    const view = (await call(hal, "GET", `/api/runs/${r.json.id}`)).json;
    expect(view).toMatchObject({ policyVersion: "policy-v1", fresh: true });
    expect(view.result.verdict.gates).toHaveLength(5);
    const [row] = await db.query<any>(`select policy_hash from runs where id = $1`, [r.json.id]);
    expect(row.policy_hash).toBe("9f95780101a9ecfe6444c47dd319c1cb8d77251d60700a1a4dde1733055296b9");
    // The same, for the Maple Heights run made earlier in this file.
    const [maple] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [run]);
    expect(maple).toMatchObject({ policy_version: "policy-v1", policy_hash: "9f95780101a9ecfe6444c47dd319c1cb8d77251d60700a1a4dde1733055296b9" });
    expect((await call(hal, "GET", `/api/runs/${r.json.id}/audit-package`)).json.validation.status).toBe("passed");
  });

  test.each([
    [0, "rental-hold-draft"],
    [4, "rental-hold-insured-draft"],
  ] as const)("a held run with premium %s stores its IO-sizing policy (task 72)", async (premium, version) => {
    hal ??= await signup("fictional-io-72@example.com", "Fictional IO Owner", "solo");
    const workspace = (await call(hal, "GET", "/api/me")).json.workspaces[0].id;
    const id = (await call(hal, "POST", `/api/workspaces/${workspace}/deals`, { name: "Fictional IO Lantern Rental", assetType: "Multifamily", location: "Invented Borough", province: "AB" })).json.id;
    await fill(id, true);
    await put(id, "senior_io_months", 24);
    if (premium > 0) await put(id, "refinance_insurance_premium_pct", premium);
    const run = await call(hal, "POST", `/api/deals/${id}/runs`);
    expect(run.status).toBe(200);
    const [row] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [run.json.id]);
    expect(row).toMatchObject({ policy_version: version, policy_hash: POLICY_HASHES[version] });
    expect((await call(hal, "GET", `/api/runs/${run.json.id}/audit-package`)).json.validation.status).toBe("passed");
  });

  test("an insured held run stores insured v2 (task 70)", async () => {
    hal ??= await signup("fictional-insured-70@example.com", "Fictional Card Seventy Owner", "solo");
    const workspace = (await call(hal, "GET", "/api/me")).json.workspaces[0].id;
    const id = (await call(hal, "POST", `/api/workspaces/${workspace}/deals`, { name: "Fictional Juniper Lantern Rental", assetType: "Multifamily", location: "Invented Borough", province: "AB" })).json.id;
    await fill(id, true);
    await put(id, "refinance_insurance_premium_pct", 4);
    const run = await call(hal, "POST", `/api/deals/${id}/runs`);
    expect(run.status).toBe(200);
    const [row] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [run.json.id]);
    expect(row).toMatchObject({ policy_version: "rental-hold-insured-draft", policy_hash: POLICY_HASHES["rental-hold-insured-draft"] });
  });

  test("an insured held run stores its own policy and hash, replays, and renders its artifacts (task 67)", async () => {
    hal ??= await signup("fictional-insured-67@example.com", "Fictional Insured Owner", "solo");
    const workspace = (await call(hal, "GET", "/api/me")).json.workspaces[0].id;
    const insuredDeal = (await call(hal, "POST", `/api/workspaces/${workspace}/deals`, { name: "Fictional Insured Fourplex", assetType: "Multifamily", location: "Invented Township", province: "AB" })).json.id;
    await fill(insuredDeal, true);
    await put(insuredDeal, "refinance_insurance_premium_pct", 4);
    const r = await call(hal, "POST", `/api/deals/${insuredDeal}/runs`);
    expect(r.status).toBe(200);
    const insuredRun = r.json.id;
    const view = (await call(hal, "GET", `/api/runs/${insuredRun}`)).json;
    expect(view).toMatchObject({ policyVersion: "rental-hold-insured-draft", fresh: true, staleReasons: [] });
    const [row] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [insuredRun]);
    expect(row).toMatchObject({ policy_version: "rental-hold-insured-draft", policy_hash: POLICY_HASHES["rental-hold-insured-draft"] });
    expect((await call(hal, "GET", `/api/runs/${insuredRun}/audit-package`)).json.validation.status).toBe("passed");
    const body = view.result.verdict.code === "APPROVE"
      ? { decision: "approve", rationale: "Fictional policy-selection test" }
      : view.result.verdict.code === "APPROVE_WITH_CONDITIONS"
        ? { decision: "approve_with_conditions", rationale: "Fictional policy-selection test", conditions: "Confirm fictional refinance terms" }
        : { decision: "reject", rationale: "Fictional policy-selection test" };
    expect((await call(hal, "POST", `/api/runs/${insuredRun}/decision`, body)).status).toBe(200);
    for (const [kind, format] of [["ic_memo", "docx"], ["lender_package", "docx"], ["model_export", "xlsx"]]) {
      expect((await call(hal, "POST", `/api/runs/${insuredRun}/artifacts`, { kind, format })).status).toBe(200);
    }
    await work();
    const artifacts = (await call(hal, "GET", `/api/deals/${insuredDeal}/artifacts`)).json;
    expect(artifacts.map((a: any) => a.status)).toEqual(["ready", "ready", "ready"]);
  }, 120_000);
});

describe("task 60b: a choice only a person makes is offered on review and entered like any value", () => {
  let cw: string, cd: string, tw: string, td: string, cora: Session, tess: Session;
  const review = async (s: Session, d: string) => (await call(s, "GET", `/api/deals/${d}/review`)).json;
  const make = async (s: Session, w: string, name: string) =>
    (await call(s, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", location: "Calgary", province: "AB" })).json.id as string;

  test("the review payload lists the choices with unit and help, apart from what was not found", async () => {
    cora = await signup("cora@example.com", "Cora Chooser", "solo");
    cw = (await call(cora, "GET", "/api/me")).json.workspaces[0].id;
    cd = await make(cora, cw, "Choice Fourplex");
    const r = await review(cora, cd);
    const by = new Map<string, any>(r.choices.map((c: any) => [c.fieldKey, c]));
    expect([...by.keys()]).toEqual(expect.arrayContaining(["lease_up_ramp", "s_curve_draws", "refinance_and_hold"]));
    expect(by.get("lease_up_ramp")).toMatchObject({ unit: "flag", material: false, detail: "no income before stabilization", groupLabel: expect.any(String) });
    expect(by.get("refinance_and_hold")).toMatchObject({ unit: "flag", material: true });
    expect(by.get("refinance_and_hold")).toHaveProperty("help");
    for (const c of r.choices) expect(r.notFound.map((n: any) => n.fieldKey)).not.toContain(c.fieldKey);
    expect(r.readiness.choices.map((c: any) => c.fieldKey)).toEqual(r.choices.map((c: any) => c.fieldKey));
  });

  test("in solo review, lease_up_ramp = 1 with a reason is approved and leaves the list", async () => {
    const e = await call(cora, "POST", `/api/deals/${cd}/values`, { fieldKey: "lease_up_ramp", value: 1, reason: "We credit lease-up income" });
    expect(e.status).toBe(200);
    expect(e.json.status).toBe("approved");
    const r = await review(cora, cd);
    expect(r.assumptions.find((a: any) => a.fieldKey === "lease_up_ramp")).toMatchObject({ status: "approved", value: 1, unit: "flag" });
    expect(r.choices.map((c: any) => c.fieldKey)).not.toContain("lease_up_ramp");
  });

  test("a value other than 0 or 1 is refused", async () => {
    expect((await call(cora, "POST", `/api/deals/${cd}/values`, { fieldKey: "s_curve_draws", value: 2, reason: "Not a yes or no" })).status).toBeGreaterThanOrEqual(400);
  });

  test("in team review, refinance_and_hold (material) waits for a second person; a run keeps choices out of its snapshot", async () => {
    tess = await signup("tess@example.com", "Tess Team", "team");
    tw = (await call(tess, "GET", "/api/me")).json.workspaces[0].id;
    td = await make(tess, tw, "Team Choice");
    const e = await call(tess, "POST", `/api/deals/${td}/values`, { fieldKey: "refinance_and_hold", value: 1, reason: "We keep and refinance" });
    expect(e.json.status).toBe("awaiting_second_approval");
    const r = await review(tess, td);
    expect(r.choices.map((c: any) => c.fieldKey)).not.toContain("refinance_and_hold");
    const [{ snap }] = (await db.query<{ snap: Record<string, unknown> }>(`select input_snapshot as snap from runs where id = $1`, [run])) as [{ snap: Record<string, unknown> }];
    expect(Object.keys(snap).sort()).toEqual(["assumptions", "input", "notFound", "policy"]);
  });
});

describe("task 60c: a person adds a unit type or space that no document states", () => {
  let uw: string, ud: string, usr: Session, tsr: Session, td2: string;
  const make = async (s: Session, w: string, name: string) =>
    (await call(s, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", location: "Calgary", province: "AB" })).json.id as string;
  const put = async (s: Session, d: string, fieldKey: string, value: number, itemKey?: string) =>
    expect((await call(s, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
  const items = async (s: Session, d: string) => (await call(s, "GET", `/api/deals/${d}/review`)).json.assumptions.filter((a: any) => a.itemKey);
  const gpr = async (s: Session, d: string) => {
    const r = await call(s, "POST", `/api/deals/${d}/runs`);
    expect(r.status).toBe(200);
    const view = (await call(s, "GET", `/api/runs/${r.json.id}`)).json;
    return view.result.scenarios[0].metrics.find((m: any) => m.key === "gross_potential_rent").value as number;
  };

  test("3BR with 2 units at $2,400 joins a deal that has 2BR: two approved items, counted by readiness", async () => {
    usr = await signup("una@example.com", "Una Adder", "solo");
    uw = (await call(usr, "GET", "/api/me")).json.workspaces[0].id;
    ud = await make(usr, uw, "Added Type Fourplex");
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "2BR"], ["unit_rent_monthly", 2000, "2BR"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) await put(usr, ud, f, v, i);
    expect((await call(usr, "POST", `/api/deals/${ud}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
    const before = await gpr(usr, ud);
    const add = await call(usr, "POST", `/api/deals/${ud}/items`, { name: "3BR", unitCount: 2, rentMonthly: 2400, reason: "Two larger units on the top floor" });
    expect(add.status).toBe(200);
    const mine = (await items(usr, ud)).filter((a: any) => a.itemKey === "3BR");
    expect(mine.map((a: any) => [a.fieldKey, a.value, a.status]).sort()).toEqual([["unit_count", 2, "approved"], ["unit_rent_monthly", 2400, "approved"]]);
    const r = (await call(usr, "GET", `/api/deals/${ud}/review`)).json;
    expect(r.readiness.status).toBe("ready");
    expect((await gpr(usr, ud)) - before).toBeCloseTo(2 * 2400 * 12, 2);
    const [{ snap }] = (await db.query<any>(`select input_snapshot as snap from runs where deal_id = $1 order by run_number desc limit 1`, [ud])) as [{ snap: any }];
    expect(snap.input.revenue.map((x: any) => x.key).sort()).toEqual(["2BR", "3BR"]);
  });

  test("3-bed when 3BR exists is refused under the canonical name, and nothing is written", async () => {
    const n = (await items(usr, ud)).length;
    const dup = await call(usr, "POST", `/api/deals/${ud}/items`, { name: "3-bed", unitCount: 1, rentMonthly: 2500, reason: "Same type written another way" });
    expect(dup.status).toBe(409);
    expect(dup.json.error).toBe("This deal already has 3BR; change its values instead.");
    expect((await items(usr, ud)).length).toBe(n);
  });

  test("a space is added by area and rent per sf, with an occupancy; the two ways are never mixed", async () => {
    const add = await call(usr, "POST", `/api/deals/${ud}/items`, { name: "Retail", areaSf: 1200, rentPsfAnnual: 30, occupancyPct: 90, reason: "Ground-floor shop, not in the documents" });
    expect(add.status).toBe(200);
    const mine = (await items(usr, ud)).filter((a: any) => a.itemKey === "Retail");
    expect(mine.map((a: any) => a.fieldKey).sort()).toEqual(["item_occupancy_pct", "rent_psf_annual", "rentable_area_sf"]);
    const body = { reason: "Checking what is refused" };
    const bad = [
      { name: "Mixed", unitCount: 2, rentMonthly: 2000, areaSf: 800, rentPsfAnnual: 20 },
      { name: "Half", unitCount: 2 },
      { name: "HalfSf", areaSf: 800 },
      { name: "Pipe|Name", unitCount: 2, rentMonthly: 2000 },
      { name: "  ", unitCount: 2, rentMonthly: 2000 },
      { name: "Short", unitCount: 2, rentMonthly: 2000, reason: "short" },
    ];
    for (const b of bad) expect((await call(usr, "POST", `/api/deals/${ud}/items`, { ...body, ...b })).status).toBe(422);
  });

  test("a value the database refuses rolls the whole type back", async () => {
    const before = (await items(usr, ud)).length;
    const r = await call(usr, "POST", `/api/deals/${ud}/items`, { name: "Penthouse", unitCount: 1.5, rentMonthly: 5000, reason: "A half unit is not a unit" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.status).not.toBe(404);
    expect((await items(usr, ud)).length).toBe(before);
  });

  test("in team review, the entries are governed as a typed value is: by the person's role and recorded as hand entries", async () => {
    tsr = await signup("tobi@example.com", "Tobi Team", "team");
    const w = (await call(tsr, "GET", "/api/me")).json.workspaces[0].id;
    td2 = await make(tsr, w, "Team Added Type");
    const add = await call(tsr, "POST", `/api/deals/${td2}/items`, { name: "1BR", unitCount: 3, rentMonthly: 1800, reason: "Three one-bedrooms we plan to add" });
    expect(add.status).toBe(200);
    const direct = await call(tsr, "POST", `/api/deals/${td2}/values`, { fieldKey: "unit_count", itemKey: "2BR", value: 3, reason: "Typed one value by hand" });
    const rows = await db.query<any>(`select field_key, item_key, status, source_kind from assumptions where deal_id = $1 and item_key = '1BR' order by field_key`, [td2]);
    expect(rows.map((x: any) => x.source_kind)).toEqual(["analyst", "analyst"]);
    expect(rows.map((x: any) => x.status)).toEqual(Array(2).fill(direct.json.status));
  });

  test("someone outside the deal cannot add a type to it", async () => {
    const outsider = await signup("vera@example.com", "Vera Viewer", "solo");
    const r = await call(outsider, "POST", `/api/deals/${td2}/items`, { name: "Studio", unitCount: 1, rentMonthly: 1200, reason: "Not my deal at all" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await db.query<any>(`select 1 from assumptions where deal_id = $1 and item_key = 'Studio'`, [td2])).length).toBe(0);
  });
});

describe("audit of task 60c: a type written another way is the same type", () => {
  test("a name that differs only in case or spacing is refused, naming the type the deal has", async () => {
    const s = await signup("wren@example.com", "Wren Writer", "solo");
    const w = (await call(s, "GET", "/api/me")).json.workspaces[0].id;
    const d = (await call(s, "POST", `/api/workspaces/${w}/deals`, { name: "Spelling Check", assetType: "Mixed use", location: "Regina", province: "SK" })).json.id as string;
    expect((await call(s, "POST", `/api/deals/${d}/items`, { name: "Office space", areaSf: 900, rentPsfAnnual: 22, reason: "Second-floor office, typed in" })).status).toBe(200);
    for (const name of ["office space", "OFFICE   SPACE", " Office space "]) {
      const r = await call(s, "POST", `/api/deals/${d}/items`, { name, areaSf: 900, rentPsfAnnual: 22, reason: "The same office written another way" });
      expect(r.status, name).toBe(409);
      expect(r.json.error, name).toBe("This deal already has Office space; change its values instead.");
    }
    const rows = await db.query<any>(`select distinct item_key from assumptions where deal_id = $1`, [d]);
    expect(rows.map((x: any) => x.item_key)).toEqual(["Office space"]);
  });

  test("a name typed with extra spaces is stored with single spaces", async () => {
    const s = await signup("yuki@example.com", "Yuki Spacer", "solo");
    const w = (await call(s, "GET", "/api/me")).json.workspaces[0].id;
    const d = (await call(s, "POST", `/api/workspaces/${w}/deals`, { name: "Space Check", assetType: "Retail", location: "Regina", province: "SK" })).json.id as string;
    const r = await call(s, "POST", `/api/deals/${d}/items`, { name: "Corner   shop", areaSf: 700, rentPsfAnnual: 28, reason: "Corner unit, typed with extra spaces" });
    expect(r.json.itemKey).toBe("Corner shop");
  });
});

describe("card 60d: a person's entry and a document meet in one row however the name is written", () => {
  let pat: Session, pw: string;
  const make = async (name: string) => (await call(pat, "POST", `/api/workspaces/${pw}/deals`, { name, assetType: "Mixed use", location: "Regina", province: "SK" })).json.id as string;
  const put = async (d: string, fieldKey: string, value: number, itemKey?: string) =>
    expect((await call(pat, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
  const base = async (d: string) => {
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "2BR"], ["unit_rent_monthly", 2000, "2BR"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) await put(d, f, v, i);
    expect((await call(pat, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
  };
  const gpr = async (d: string) => {
    const r = await call(pat, "POST", `/api/deals/${d}/runs`);
    expect(r.status).toBe(200);
    const view = (await call(pat, "GET", `/api/runs/${r.json.id}`)).json;
    return view.result.scenarios[0].metrics.find((m: any) => m.key === "gross_potential_rent").value as number;
  };
  const retailRows = async (d: string) => (await call(pat, "GET", `/api/deals/${d}/review`)).json.assumptions.filter((a: any) => /^retail$/i.test(a.itemKey ?? ""));
  const sheet = (rent: number) => new TextEncoder().encode(`Unit type,Units,Rent ($/mo)\nretail,2,${rent}\n`);

  test("a person's 'Retail' and a document's 'retail' at the same rent are one row each, with the document as a source", async () => {
    pat = await signup("pia@example.com", "Pia Folder", "solo");
    pw = (await call(pat, "GET", "/api/me")).json.workspaces[0].id;
    const d = await make("Fold Same");
    await base(d);
    expect((await call(pat, "POST", `/api/deals/${d}/items`, { name: "Retail", unitCount: 2, rentMonthly: 3000, reason: "Two shops on the ground floor" })).status).toBe(200);
    const before = await gpr(d);
    expect((await call(pat, "PUT", `/api/deals/${d}/documents?name=roll.csv`, undefined, sheet(3000))).status).toBe(200);
    await work();
    const rows = await retailRows(d);
    expect(rows.map((a: any) => [a.fieldKey, a.itemKey, a.status, a.value]).sort()).toEqual([["unit_count", "Retail", "approved", 2], ["unit_rent_monthly", "Retail", "approved", 3000]]);
    expect(rows.find((a: any) => a.fieldKey === "unit_rent_monthly").sources.map((s: any) => s.document_name)).toEqual(["roll.csv"]);
    expect((await call(pat, "GET", `/api/deals/${d}/review`)).json.readiness.status).toBe("ready");
    expect(await gpr(d)).toBeCloseTo(before, 2);
  });

  test("at a different rent the row is conflicting and names both values", async () => {
    const d = await make("Fold Differ");
    await base(d);
    expect((await call(pat, "POST", `/api/deals/${d}/items`, { name: "Retail", unitCount: 2, rentMonthly: 3000, reason: "Two shops on the ground floor" })).status).toBe(200);
    expect((await call(pat, "PUT", `/api/deals/${d}/documents?name=roll.csv`, undefined, sheet(3200))).status).toBe(200);
    await work();
    const rent = (await retailRows(d)).find((a: any) => a.fieldKey === "unit_rent_monthly");
    expect(await retailRows(d)).toHaveLength(2);
    expect(rent).toMatchObject({ itemKey: "Retail", status: "conflicting" });
    expect(rent.conflictValues.map((c: any) => c.value).sort()).toEqual([3000, 3200]);
  });

  test("two older rows that fold equal take no proposal and block the run until one is rejected", async () => {
    const d = await make("Fold Old Pair");
    await base(d);
    for (const name of ["Retail", "retail"]) {
      await put(d, "unit_count", 2, name);
      await put(d, "unit_rent_monthly", 3000, name);
    }
    const r = (await call(pat, "GET", `/api/deals/${d}/review`)).json;
    expect(r.readiness.status).toBe("blocked");
    expect(r.readiness.impossible.map((i: any) => i.label)).toContain("Retail and retail are one item written two ways");
    expect((await call(pat, "GET", `/api/deals/${d}`)).json.status.text).toBe("Blocked · 1 to correct");
    expect((await call(pat, "POST", `/api/deals/${d}/runs`)).status).toBeGreaterThanOrEqual(400);
  });

  test("audit: a document's value a person rejected stays rejected, and does not reopen the person's own entry written another way", async () => {
    // The person rejects the roll's 'retail' rent, then adds 'Retail' at the rent they know. The roll's figure meets its own rejected row, as before card 60d.
    const d = await make("Fold Rejected");
    await base(d);
    expect((await call(pat, "PUT", `/api/deals/${d}/documents?name=roll.csv`, undefined, sheet(3200))).status).toBe(200);
    await work();
    for (const a of await retailRows(d)) {
      expect(a.itemKey).toBe("retail");
      expect((await call(pat, "POST", `/api/assumptions/${a.id}/review`, { action: "reject", reason: "The roll's retail rent is out of date", version: a.version })).status).toBe(200);
    }
    expect((await call(pat, "POST", `/api/deals/${d}/items`, { name: "Retail", unitCount: 2, rentMonthly: 3000, reason: "Signed leases, two shops" })).status).toBe(200);
    // Any later document reconciles the deal again.
    expect((await call(pat, "PUT", `/api/deals/${d}/documents?name=notes.txt`, undefined, new TextEncoder().encode("Site visit notes, nothing priced.\n"))).status).toBe(200);
    await work();
    const rows = (await retailRows(d)).map((a: any) => [a.fieldKey, a.itemKey, a.status, a.value]).sort();
    expect(rows).toEqual([["unit_count", "Retail", "approved", 2], ["unit_count", "retail", "rejected", 2], ["unit_rent_monthly", "Retail", "approved", 3000], ["unit_rent_monthly", "retail", "rejected", 3200]]);
    expect((await call(pat, "GET", `/api/deals/${d}/review`)).json.readiness.status).toBe("ready");
    // 2BR: 4 x 2,000 x 12 = 96,000; Retail: 2 x 3,000 x 12 = 72,000.
    expect(await gpr(d)).toBeCloseTo(168_000, 2);
  });
});

describe("card 61: Canadian cost lines and a mortgage insurance premium are entered by a person", () => {
  let nina: Session, nw: string;
  const make = async (name: string) =>
    (await call(nina, "POST", `/api/workspaces/${nw}/deals`, { name, assetType: "Multifamily", location: "Halifax", province: "NS" })).json.id as string;
  const put = async (d: string, fieldKey: string, value: number, itemKey?: string) => {
    const r = await call(nina, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) });
    expect(r.status, fieldKey).toBe(200);
    return r;
  };
  // Invented round numbers: no rate, table or rebate is cited anywhere.
  const base = async (d: string) => {
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) await put(d, f, v, i);
    expect((await call(nina, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
  };
  const choices = async (d: string) => (await call(nina, "GET", `/api/deals/${d}/review`)).json.choices as { fieldKey: string; unit: string; help: string | null; detail: string }[];
  const metrics = async (runId: string) => (await call(nina, "GET", `/api/runs/${runId}`)).json.result.scenarios[0].metrics as { key: string; value: number | null; status: string }[];
  const snapshot = async (runId: string) => ((await db.query<any>(`select input_snapshot as snap from runs where id = $1`, [runId])) as [{ snap: any }])[0].snap;

  test("review offers GST/HST net and property tax as choices and the other two lines as not found, and the premium only once a refinance month is stated", async () => {
    nina = await signup("nina@example.com", "Nina Builder", "solo");
    nw = (await call(nina, "GET", "/api/me")).json.workspaces[0].id;
    const d = await make("Halifax Fourplex");
    const before = await choices(d);
    const by = new Map(before.map((c) => [c.fieldKey, c]));
    expect(by.get("gst_hst_net")).toMatchObject({ unit: "$", help: "If your soft or other costs already include it, leave this out.", detail: "none stated" });
    expect(by.has("development_charges")).toBe(false);
    expect(by.has("land_transfer_tax")).toBe(false);
    expect(by.get("property_tax_annual")).toMatchObject({ unit: "$", help: "Leave this out if your expense ratio or fixed operating costs already include it." });
    expect(by.has("refinance_insurance_premium_pct")).toBe(false);
    await put(d, "refinance_month", 24);
    const after = await choices(d);
    expect(after.find((c) => c.fieldKey === "refinance_insurance_premium_pct")).toMatchObject({ unit: "%", detail: "no mortgage insurance" });
    const nf = (await call(nina, "GET", `/api/deals/${d}/review`)).json.notFound.map((n: any) => n.fieldKey);
    for (const k of ["development_charges", "land_transfer_tax"]) expect(nf, k).toContain(k);
    for (const k of ["gst_hst_net", "property_tax_annual", "refinance_insurance_premium_pct"]) expect(nf, k).not.toContain(k);
  });

  test("a run with the lines records them, shows the metric, and builds its lender package", async () => {
    const d = await make("Halifax Fourplex With Lines");
    await base(d);
    for (const [f, v] of [["refinance_month", 24], ["refinance_ltv_pct", 65], ["refinance_rate_pct", 5], ["refinance_amort_years", 30],
      ["development_charges", 50000], ["land_transfer_tax", 20000], ["gst_hst_net", 30000], ["property_tax_annual", 12000], ["refinance_insurance_premium_pct", 4]] as [string, number][]) await put(d, f, v);
    const r = await call(nina, "POST", `/api/deals/${d}/runs`);
    expect(r.status).toBe(200);
    const snap = await snapshot(r.json.id);
    expect(snap.input.budget).toMatchObject({ developmentCharges: 50000, landTransferTax: 20000, gstHstNet: 30000 });
    expect(snap.input.propertyTaxAnnual).toBe(12000);
    expect(snap.input.refinance.insurancePremiumPct).toBe(4);
    expect(Object.keys(snap)).not.toContain("choices");
    const premium = (await metrics(r.json.id)).find((m) => m.key === "refinance_premium_added")!;
    expect(premium.status).toBe("VALID");
    expect(premium.value!).toBeGreaterThan(0);
    expect((await call(nina, "GET", `/api/runs/${r.json.id}`)).json.fresh).toBe(true);
    expect((await call(nina, "POST", `/api/runs/${r.json.id}/artifacts`, { kind: "lender_package", format: "docx" })).status).toBe(200);
    await work();
    const arts = (await call(nina, "GET", `/api/deals/${d}/artifacts`)).json;
    expect(arts.map((a: any) => a.status)).toEqual(["ready"]);
    expect((await call(nina, "GET", `/api/runs/${r.json.id}/audit-package`)).json.validation.status).toBe("passed");
  }, 120_000);

  test("0 is accepted for each, is recorded as a stated value, and changes no number", async () => {
    const zero = await make("Halifax Fourplex Zero");
    const plain = await make("Halifax Fourplex Plain");
    await base(zero);
    await base(plain);
    for (const k of ["development_charges", "property_tax_annual", "land_transfer_tax", "gst_hst_net"]) expect((await put(zero, k, 0)).json.status, k).toBe("approved");
    const a = await call(nina, "POST", `/api/deals/${zero}/runs`);
    const b = await call(nina, "POST", `/api/deals/${plain}/runs`);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const snap = await snapshot(a.json.id);
    expect(snap.input.budget).toMatchObject({ developmentCharges: 0, landTransferTax: 0, gstHstNet: 0 });
    expect(snap.input.propertyTaxAnnual).toBe(0);
    const plainSnap = await snapshot(b.json.id);
    expect(JSON.stringify(plainSnap.input)).not.toMatch(/developmentCharges|landTransferTax|gstHstNet|propertyTaxAnnual|insurancePremiumPct/);
    const pick = async (id: string) => Object.fromEntries((await metrics(id)).filter((m) => ["total_development_cost", "stabilized_noi", "sizing_dscr"].includes(m.key)).map((m) => [m.key, m.value]));
    expect(await pick(a.json.id)).toEqual(await pick(b.json.id));
  });

  test("a premium above 10 percent or a negative cost line is refused", async () => {
    const d = await make("Halifax Fourplex Refused");
    await put(d, "refinance_month", 24);
    for (const [fieldKey, value] of [["refinance_insurance_premium_pct", 10.5], ["development_charges", -1]] as const) {
      const r = await call(nina, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Checking what is refused" });
      expect(r.status, fieldKey).toBeGreaterThanOrEqual(400);
      expect(r.status, fieldKey).toBeLessThan(500);
    }
  });
  describe("card 61b: a document's line goes to the field the person entered", () => {
    const upload = async (d: string, name: string, text: string) => {
      expect((await call(nina, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
      await work();
    };
    const rowsOf = async (d: string, k: string) => ((await call(nina, "GET", `/api/deals/${d}/review`)).json.assumptions as any[]).filter((a) => a.fieldKey === k);

    test("development charges entered and then stated in a document are counted once", async () => {
      const d = await make("Halifax Fourplex Charges");
      await base(d);
      await put(d, "development_charges", 85000);
      await upload(d, "budget.txt", "Budget\nDevelopment charges: $85,000\n");
      const dc = await rowsOf(d, "development_charges");
      expect(dc).toHaveLength(1);
      expect(dc[0]).toMatchObject({ status: "approved", value: 85000 });
      expect(dc[0].sources.map((s: any) => s.document_name)).toEqual(["budget.txt"]);
      expect(await rowsOf(d, "other_cost")).toEqual([]);
      const r = await call(nina, "POST", `/api/deals/${d}/runs`);
      expect(r.status).toBe(200);
      expect((await metrics(r.json.id)).find((m) => m.key === "hard_and_soft_cost")!.value).toBe(3_705_000);
    });

    test("a document at a different value reopens the entry as a named conflict", async () => {
      const d = await make("Halifax Fourplex Charges Differ");
      await put(d, "development_charges", 85000);
      await upload(d, "budget.txt", "Budget\nDevelopment charges: $90,000\n");
      const dc = await rowsOf(d, "development_charges");
      expect(dc).toHaveLength(1);
      expect(dc[0]).toMatchObject({ status: "conflicting" });
      expect(dc[0].conflictValues.map((c: any) => c.value).sort()).toEqual([85000, 90000]);
      expect(await rowsOf(d, "other_cost")).toEqual([]);
    });

    test("a person can label a figure as land transfer tax", async () => {
      const d = await make("Halifax Fourplex Labelled");
      await upload(d, "notes.txt", "Project notes\nBanner allowance: $7,000\n");
      const review = async () => (await call(nina, "GET", `/api/deals/${d}/review`)).json;
      const fig = (await review()).other.find((o: any) => o.raw === "$7,000");
      const body = { documentId: fig.documentId, figureId: fig.figureId, fieldKey: "land_transfer_tax" };
      expect((await call(nina, "POST", `/api/deals/${d}/figure-labels`, body)).status).toBe(200);
      await work();
      expect(await rowsOf(d, "land_transfer_tax")).toMatchObject([{ status: "needs_review", value: 7000 }]);
    });

    test("a deal read before the split loses its other-cost row to the source-removed rule and waits on the new value", async () => {
      const d = await make("Halifax Fourplex Before");
      await upload(d, "budget.txt", "Budget\nDevelopment charges: $85,000\n");
      // What the reader used to file: the same line under other costs, approved.
      await db.query(`update assumptions set field_key = 'other_cost', status = 'approved' where deal_id = $1 and field_key = 'development_charges'`, [d]);
      expect(await rowsOf(d, "development_charges")).toEqual([]);
      await upload(d, "notes.txt", "Site visit notes, nothing priced.\n");
      expect(await rowsOf(d, "other_cost")).toMatchObject([{ status: "needs_review", value: 85000, reason: "Its source document was removed; confirm or reject it" }]);
      expect(await rowsOf(d, "development_charges")).toMatchObject([{ status: "needs_review", value: 85000 }]);
    });
  });
});

describe("card 62: a deal is copied as a variant, in exactly the state of its source", () => {
  let vw: string, src: string, copyA: string, copyB: string, qw: string;
  const nameOf = "Variant Heights";
  const upload = async (d: string, name: string, text: string) => {
    expect((await call(alice, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
  };
  const review = async (d: string, s = alice) => (await call(s, "GET", `/api/deals/${d}/review`)).json;
  const byField = async (d: string, k: string, item: string | null = null) => (await review(d)).assumptions.find((a: any) => a.fieldKey === k && a.itemKey === item);
  const hashOf = async (d: string) => ((await db.query<any>(`select fn_assumptions_hash($1) as h`, [d])) as [{ h: string }])[0].h;
  const stored = (d: string) =>
    db.query<any>(
      `select field_key, item_key, status, value, pending_value, source_kind, reason, conflict_values, decided_by, decided_at, second_approver, second_approved_at from assumptions where deal_id = $1 order by field_key, item_key`,
      [d],
    );
  const reconciled = async (d: string) => {
    await reconcileDeal(db, d);
    const [ev] = await db.query<any>(`select payload from audit_events where action = 'assumptions.reconciled' and deal_id = $1 order by seq desc limit 1`, [d]);
    return ev.payload;
  };
  const runRow = async (id: string) => ((await db.query<any>(`select input_hash, result_hash from runs where id = $1`, [id])) as [{ input_hash: string; result_hash: string }])[0];
  const copyOf = (s: Session, d: string, name: string) => call(s, "POST", `/api/deals/${d}/copy`, { name });

  test("a deal with two documents and every kind of value is set up", async () => {
    vw = (await call(alice, "POST", "/api/workspaces", { name: "Variants" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${vw}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
    src = (await call(alice, "POST", `/api/workspaces/${vw}/deals`, { name: nameOf, assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    await upload(src, "budget.txt", "Budget\nLand cost: $800,000\nHard costs: $2,400,000\nSoft costs: $300,000\nContingency: $120,000\nExit cap rate: 5.5%\n");
    await upload(src, "notes.txt", "Project notes\nLand cost: $850,000\nBanner allowance: $7,000\nSignage kit: $3,000\n");
    await work();
    const docs = (await call(alice, "GET", `/api/deals/${src}/documents`)).json;
    expect(docs.map((d: any) => d.stage)).toEqual(["extracted", "extracted"]);
    for (const k of ["hard_cost", "soft_cost", "contingency", "exit_cap_rate_pct"]) {
      const a = await byField(src, k);
      expect(a, k).toMatchObject({ status: "needs_review" });
      expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status, k).toBe(200);
    }
    expect(await byField(src, "land_cost")).toMatchObject({ status: "conflicting" });
    for (const [f, v, i] of [["construction_months", 12], ["lease_up_months", 6], ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["senior_loan_amount", 0]] as [string, number, string?][]) {
      const r = await call(alice, "POST", `/api/deals/${src}/values`, { fieldKey: f, value: v, reason: "Quick start answer", ...(i ? { itemKey: i } : {}) });
      expect(r.status, f).toBe(200);
    }
    expect((await call(alice, "POST", `/api/deals/${src}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
    // A person's label, and a model's stored suggestion for another figure.
    const fig = (raw: string) => review(src).then((r) => r.other.find((o: any) => o.raw === raw));
    const banner = await fig("$7,000");
    expect((await call(alice, "POST", `/api/deals/${src}/figure-labels`, { documentId: banner.documentId, figureId: banner.figureId, fieldKey: "other_cost" })).status).toBe(200);
    await work();
    const sign = await fig("$3,000");
    await db.query(
      `insert into label_suggestions (document_id, deal_id, workspace_id, model, prompt_hash, request, response, stop_reason, outcome) values ($1, $2, $3, 'claude-fake-served', 'hash-kept-as-sent', $4, $5, 'end_turn', 'ok')`,
      [sign.documentId, src, vw, JSON.stringify({ figures: [{ id: sign.figureId }] }), JSON.stringify([{ id: sign.figureId, fieldKey: "other_cost", itemKey: null }])],
    );
    const statuses = (await review(src)).assumptions.map((a: any) => a.status);
    for (const s of ["approved", "default_accepted", "conflicting", "awaiting_second_approval", "needs_review"]) expect(statuses, s).toContain(s);
    expect((await byField(src, "other_cost")).sources[0]).toMatchObject({ rule: "labelled" });
  });

  test("a viewer cannot copy, a member of another workspace cannot see the deal, and a name is required", async () => {
    // Carol is in no workspace of this deal until she is added as a viewer.
    expect((await copyOf(carol, src, "Nope")).status).toBe(404);
    expect((await call(alice, "POST", `/api/workspaces/${vw}/members`, { email: "carol@example.com", role: "viewer" })).status).toBe(200);
    expect((await copyOf(carol, src, "Nope")).status).toBe(403);
    expect((await copyOf(alice, src, "")).status).toBe(422);
    expect((await copyOf(alice, src, "x".repeat(161))).status).toBe(422);
    expect((await call(alice, "GET", `/api/workspaces/${vw}/deals`)).json).toHaveLength(1);
  });

  test("a deal with a document still being read cannot be copied", async () => {
    const busy = (await call(alice, "POST", `/api/workspaces/${vw}/deals`, { name: "Busy Heights", assetType: "Multifamily", location: "Burnaby", province: "BC" })).json.id;
    await upload(busy, "unread.txt", "Notes\nLand cost: $1,000,000\n");
    const r = await copyOf(alice, busy, "Busy variant");
    expect(r.status).toBe(409);
    expect(r.json.error).toBe("Wait until every document is read, then copy the deal.");
    await work();
    expect((await copyOf(alice, busy, "Busy variant")).status).toBe(200);
  });

  test("the copy has the source's values, approvals, documents and labels, remapped to its own documents", async () => {
    const r = await copyOf(alice, src, `${nameOf}, variant`);
    expect(r.status).toBe(200);
    copyA = r.json.id;
    expect(copyA).not.toBe(src);
    expect(await hashOf(copyA)).toBe(await hashOf(src));
    expect(await stored(copyA)).toEqual(await stored(src));
    const [a, b] = await Promise.all([call(alice, "GET", `/api/deals/${src}`), call(alice, "GET", `/api/deals/${copyA}`)]);
    expect(a.json.copiedFrom).toBeNull();
    expect(b.json.copiedFrom).toEqual({ id: src, name: nameOf });
    expect(b.json.deal).toMatchObject({ name: `${nameOf}, variant`, workspace_id: vw, asset_type: "Multifamily", location: "Burnaby", province: "BC", currency: "CAD", country: "CA" });
    // Documents: new rows over the same stored bytes.
    const docs = (d: string) => db.query<any>(`select id, name, kind, sha256, storage_key, stage, uploaded_by, candidate_count from documents where deal_id = $1 and retired_at is null order by name`, [d]);
    const [sd, cd] = [await docs(src), await docs(copyA)];
    expect(cd).toHaveLength(2);
    expect(cd.map(({ id, ...x }: any) => x)).toEqual(sd.map(({ id, ...x }: any) => x));
    const own = new Set(cd.map((d: any) => d.id));
    for (const d of sd) expect(own.has(d.id)).toBe(false);
    for (const d of cd) {
      const n = (x: string) => db.query<any>(`select count(*)::int as n from candidates where document_id = $1`, [x]).then((q) => q[0].n);
      expect(await n(d.id)).toBe(await n(sd.find((s: any) => s.name === d.name).id));
    }
    // Every document id the copy holds is one of its own.
    const copyReview = await review(copyA);
    for (const x of copyReview.assumptions) for (const s of x.sources) expect(own.has(s.document_id), x.fieldKey).toBe(true);
    const labels = await db.query<any>(`select document_id, figure_id, field_key, created_by from figure_labels where deal_id = $1`, [copyA]);
    const sourceLabels = await db.query<any>(`select figure_id, field_key, created_by from figure_labels where deal_id = $1`, [src]);
    expect(labels).toHaveLength(1);
    expect(own.has(labels[0].document_id)).toBe(true);
    expect(labels[0].figure_id.startsWith(`${labels[0].document_id}|`)).toBe(true);
    expect(labels[0].figure_id.split("|").slice(1)).toEqual(sourceLabels[0].figure_id.split("|").slice(1));
    expect(labels[0]).toMatchObject({ field_key: sourceLabels[0].field_key, created_by: sourceLabels[0].created_by });
    // The model's suggestion: request and hash as sent, the figure ids in the response remapped.
    const [ss] = await db.query<any>(`select * from label_suggestions where deal_id = $1`, [src]);
    const [cs] = await db.query<any>(`select * from label_suggestions where deal_id = $1`, [copyA]);
    expect(cs).toMatchObject({ prompt_hash: "hash-kept-as-sent", model: "claude-fake-served", outcome: "ok", stop_reason: "end_turn", request: ss.request });
    expect(own.has(cs.document_id)).toBe(true);
    expect(cs.response[0].id).toBe(ss.response[0].id.replace(ss.document_id, cs.document_id));
    expect(JSON.stringify(cs.response)).not.toContain(ss.document_id);
  });

  test("a reconcile of the copy changes nothing, and its review lists the same unused figures with the label shown", async () => {
    const before = await stored(copyA);
    expect(await reconciled(copyA)).toMatchObject({ changed: 0 });
    expect(await stored(copyA)).toEqual(before);
    expect(await reconciled(src)).toMatchObject({ changed: 0 });
    const [s, c] = [await review(src), await review(copyA)];
    const shape = (r: any) => r.other.map((o: any) => ({ document_name: o.document_name, raw: o.raw, value: o.value, location: o.location, label: o.label && { fieldKey: o.label.fieldKey, by: o.label.by } }));
    expect(shape(c)).toEqual(shape(s));
    expect(shape(c).find((o: any) => o.raw === "$7,000").label).toEqual({ fieldKey: "other_cost", by: "Alice Analyst" });
    expect(c.assumptions.map((a: any) => [a.fieldKey, a.itemKey, a.status, a.value, a.pendingValue, a.decidedBy, a.version])).toEqual(
      s.assumptions.map((a: any) => [a.fieldKey, a.itemKey, a.status, a.value, a.pendingValue, a.decidedBy, 1]),
    );
  });

  test("each copied value has a copied event, and the audit names both deals", async () => {
    const events = await db.query<any>(`select action, from_status, to_status, reason from assumption_events where deal_id = $1`, [copyA]);
    const rows = await stored(copyA);
    expect(events).toHaveLength(rows.length);
    for (const e of events) expect(e).toMatchObject({ action: "copied", from_status: null, reason: `Copied from ${nameOf}` });
    expect(events.map((e: any) => e.to_status).sort()).toEqual(rows.map((r: any) => r.status).sort());
    const [copied] = await db.query<any>(`select payload from audit_events where action = 'deal.copied' and deal_id = $1`, [src]);
    expect(copied.payload).toMatchObject({ copy: copyA });
    const [made] = await db.query<any>(`select payload from audit_events where action = 'deal.created_as_copy' and deal_id = $1`, [copyA]);
    expect(made.payload).toMatchObject({ source: src, name: nameOf, documents: 2, values: rows.length, labels: 1 });
    const audit = (await call(alice, "GET", `/api/deals/${copyA}/audit`)).json.map((e: any) => e.action);
    expect(audit).toContain("deal.created_as_copy");
    // Runs, decisions and history stay with the source.
    expect(await db.query(`select 1 from runs where deal_id = $1`, [copyA])).toHaveLength(0);
    expect(await db.query(`select 1 from decisions where deal_id = $1`, [copyA])).toHaveLength(0);
  });

  test("in team review a material value changed in the copy waits for a second person, and the source is untouched", async () => {
    const a = await byField(copyA, "exit_cap_rate_pct");
    expect(a).toMatchObject({ status: "approved", value: 5.5 });
    const r = await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "modify", value: 6.25, reason: "The lender wants a wider cap rate", version: a.version });
    expect(r.status).toBe(200);
    expect(await byField(copyA, "exit_cap_rate_pct")).toMatchObject({ status: "awaiting_second_approval", pendingValue: 6.25 });
    expect(await byField(src, "exit_cap_rate_pct")).toMatchObject({ status: "approved", value: 5.5, pendingValue: null, version: 2 });
  });

  test("once the source is clear, a second copy runs to the same input and result hashes as the source", async () => {
    const land = await byField(src, "land_cost");
    expect((await call(alice, "POST", `/api/assumptions/${land.id}/review`, { action: "modify", value: 800000, reason: "The budget is the later document", version: land.version })).status).toBe(200);
    const senior = await byField(src, "senior_loan_amount");
    expect((await call(bob, "POST", `/api/assumptions/${senior.id}/review`, { action: "second_approve", version: senior.version })).status).toBe(200);
    const label = await byField(src, "other_cost");
    expect((await call(bob, "POST", `/api/assumptions/${label.id}/review`, { action: "approve", version: label.version })).status).toBe(200);
    copyB = (await copyOf(bob, src, "Variant Heights, second")).json.id;
    expect(copyB).toEqual(expect.any(String));
    expect(await hashOf(copyB)).toBe(await hashOf(src));
    // The approvals travel: the second approver is still Bob, and the entry is still Alice's.
    const [s, c] = [await stored(src), await stored(copyB)];
    expect(c).toEqual(s);
    expect(c.find((x: any) => x.field_key === "senior_loan_amount").second_approver).toEqual(expect.any(String));
    expect(await reconciled(copyB)).toMatchObject({ changed: 0 });
    expect(await stored(copyB)).toEqual(s);
    const runSrc = await call(alice, "POST", `/api/deals/${src}/runs`);
    const runCopy = await call(alice, "POST", `/api/deals/${copyB}/runs`);
    expect(runSrc.status).toBe(200);
    expect(runCopy.status).toBe(200);
    expect(await runRow(runCopy.json.id)).toEqual(await runRow(runSrc.json.id));
    expect((await call(alice, "GET", `/api/runs/${runCopy.json.id}`)).json.fresh).toBe(true);
    expect((await call(alice, "GET", `/api/deals/${src}`)).json.run.fresh).toBe(true);
  }, 60_000);

  test("a quick-start deal with values and no documents copies too", async () => {
    qw = (await call(alice, "POST", "/api/workspaces", { name: "Quick starts" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${qw}/review-mode`, { mode: "solo" })).status).toBe(200);
    const d = (await call(alice, "POST", `/api/workspaces/${qw}/deals`, { name: "Quick Fourplex", assetType: "Multifamily", location: "Halifax", province: "NS" })).json.id;
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) {
      expect((await call(alice, "POST", `/api/deals/${d}/values`, { fieldKey: f, value: v, reason: "Quick start answer", ...(i ? { itemKey: i } : {}) })).status, f).toBe(200);
    }
    expect((await call(alice, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
    const c = await call(alice, "POST", `/api/deals/${d}/copy`, { name: "Quick Fourplex, kept" });
    expect(c.status).toBe(200);
    expect(await hashOf(c.json.id)).toBe(await hashOf(d));
    expect(await stored(c.json.id)).toEqual(await stored(d));
    expect(await db.query(`select 1 from documents where deal_id = $1`, [c.json.id])).toHaveLength(0);
    expect(await reconciled(c.json.id)).toMatchObject({ changed: 0 });
    expect(await stored(c.json.id)).toEqual(await stored(d));
    const [a, b] = [await call(alice, "POST", `/api/deals/${d}/runs`), await call(alice, "POST", `/api/deals/${c.json.id}/runs`)];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await runRow(b.json.id)).toEqual(await runRow(a.json.id));
  });

  // Card 62 audit: a reconcile the source still has queued (after a document is read or retired, or a label changes) is the copy's too.
  test("a copy taken while its source waits for a reconcile is reconciled as its source is", async () => {
    const d = (await call(alice, "POST", `/api/workspaces/${qw}/deals`, { name: "Queued Fourplex", assetType: "Multifamily", location: "Halifax", province: "NS" })).json.id;
    await upload(d, "notes.txt", "Notes\nSoft costs: $300,000\n");
    await work();
    const soft = await byField(d, "soft_cost");
    expect((await call(alice, "POST", `/api/assumptions/${soft.id}/review`, { action: "approve", version: soft.version })).status).toBe(200);
    // Retired, and read, with each reconcile still queued when the deal is copied.
    const [notes] = (await call(alice, "GET", `/api/deals/${d}/documents`)).json;
    expect((await call(alice, "POST", `/api/documents/${notes.id}/retire`)).status).toBe(200);
    const retired = (await call(alice, "POST", `/api/deals/${d}/copy`, { name: "Queued Fourplex, retired" })).json.id;
    await upload(d, "budget.txt", "Budget\nHard costs: $2,400,000\n");
    // One job at a time until the budget is read; the reconcile its reading queued has not run.
    const stage = async () => (await call(alice, "GET", `/api/deals/${d}/documents`)).json.find((x: any) => x.name === "budget.txt").stage;
    while ((await stage()) !== "extracted") expect(await drain({ db, store }, 1)).toBe(1);
    expect(await byField(d, "hard_cost")).toBeUndefined();
    const read = (await call(alice, "POST", `/api/deals/${d}/copy`, { name: "Queued Fourplex, read" })).json.id;
    await work();
    // The first copy had one reconcile, as the source had before the budget came.
    expect(await byField(retired, "soft_cost")).toMatchObject({ status: "needs_review", value: 300000, sources: [], reason: "Its source document was removed; confirm or reject it" });
    expect(await db.query(`select 1 from documents where deal_id = $1`, [retired])).toHaveLength(0);
    // The second had the reconcile its source had after it.
    const s = await byField(d, "soft_cost");
    expect(await byField(read, "soft_cost")).toMatchObject({ status: s.status, value: s.value, sources: [], reason: s.reason });
    expect(await byField(read, "hard_cost")).toMatchObject({ status: "needs_review", value: 2400000 });
    expect(await hashOf(read)).toBe(await hashOf(d));
    expect(await stored(read)).toEqual(await stored(d));
  });
});

describe("card 58b: undoing a label puts back the value the label reopened, when the label was the only disagreement", () => {
  let sw: string, tw: string;
  const mkDeal = async (w: string, name: string) =>
    (await call(alice, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", location: "Regina", province: "SK" })).json.id as string;
  const upload = async (d: string, name: string, text: string) => {
    expect((await call(alice, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
    await work();
  };
  const review = async (d: string) => (await call(alice, "GET", `/api/deals/${d}/review`)).json;
  const byField = async (d: string, k: string, item: string | null = null) => (await review(d)).assumptions.find((a: any) => a.fieldKey === k && a.itemKey === item);
  const figure = async (d: string, raw: string) => (await review(d)).other.find((o: any) => o.raw === raw);
  const label = async (d: string, raw: string, fieldKey: string, itemKey?: string) => {
    const f = await figure(d, raw);
    expect((await call(alice, "POST", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId, fieldKey, ...(itemKey ? { itemKey } : {}) })).status, raw).toBe(200);
    await work();
  };
  const undo = async (d: string, raw: string) => {
    const f = await figure(d, raw);
    expect((await call(alice, "DELETE", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId })).status, raw).toBe(200);
    await work();
  };
  const hashOf = async (d: string) => ((await db.query<any>(`select fn_assumptions_hash($1) as h`, [d])) as [{ h: string }])[0].h;
  const settled = async (d: string, k: string, item = "") =>
    ((await db.query<any>(
      `select status, value, reason, sources, source_kind, decided_by, decided_at, second_approver, second_approved_at, conflict_values from assumptions where deal_id = $1 and field_key = $2 and item_key = $3`,
      [d, k, item],
    )) as any[])[0];
  const events = (d: string, k: string, action: string) =>
    db.query<any>(`select e.* from assumption_events e join assumptions a on a.id = e.assumption_id where a.deal_id = $1 and a.field_key = $2 and e.action = $3 order by e.id`, [d, k, action]);
  const reconciled = async (d: string) => ((await db.query<any>(`select payload from audit_events where action = 'assumptions.reconciled' and deal_id = $1 order by seq desc limit 1`, [d])) as any[])[0].payload;
  const enter = async (d: string, fieldKey: string, value: number, itemKey?: string) =>
    expect((await call(alice, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);

  test("a workspace in solo review and one in team review are set up", async () => {
    sw = (await call(alice, "POST", "/api/workspaces", { name: "Undo solo", reviewMode: "solo" })).json.id;
    tw = (await call(alice, "POST", "/api/workspaces", { name: "Undo team", reviewMode: "team" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${tw}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
  });

  test("a hand entry comes back as it was, the hash matches the one before the label, and the events say so", async () => {
    const d = await mkDeal(sw, "Undo Hand");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    const before = await settled(d, "exit_cap_rate_pct");
    expect(before).toMatchObject({ status: "approved", value: 5.5, source_kind: "analyst" });
    const hash = await hashOf(d);
    await label(d, "5.25%", "exit_cap_rate_pct");
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    expect(await hashOf(d)).not.toBe(hash);
    const [reopened] = await events(d, "exit_cap_rate_pct", "reopened");
    expect(reopened.restore_to).toEqual({ status: "approved", value: 5.5, reason: before.reason, sources: before.sources, by_label: true });
    expect((await events(d, "exit_cap_rate_pct", "extracted")).concat(await events(d, "exit_cap_rate_pct", "entered")).every((e: any) => e.restore_to === null)).toBe(true);
    await undo(d, "5.25%");
    const after = await settled(d, "exit_cap_rate_pct");
    expect(after).toEqual(before);
    expect(await hashOf(d)).toBe(hash);
    const [restored] = await events(d, "exit_cap_rate_pct", "restored");
    expect(restored).toMatchObject({ actor: null, from_status: "conflicting", to_status: "approved", restore_to: null });
    expect(restored.reason).toBe("The label that disagreed was removed; the value is back as it was approved");
    expect(await reconciled(d)).toMatchObject({ restored: 1 });
    // A reconcile with nothing to restore has no `restored` key, and writes no second event.
    await reconcileDeal(db, d);
    expect(Object.keys(await reconciled(d))).not.toContain("restored");
    expect(await events(d, "exit_cap_rate_pct", "restored")).toHaveLength(1);
  });

  test("a document value that was approved and second-approved comes back with both approvals, not as needs_review", async () => {
    const d = await mkDeal(tw, "Undo Team");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\nQuota: 5.75%\n");
    await label(d, "5.25%", "exit_cap_rate_pct");
    const a = await byField(d, "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "approve", version: a.version })).status).toBe(200);
    const waiting = await byField(d, "exit_cap_rate_pct");
    expect(waiting.status).toBe("awaiting_second_approval");
    expect((await call(bob, "POST", `/api/assumptions/${a.id}/review`, { action: "second_approve", version: waiting.version })).status).toBe(200);
    const before = await settled(d, "exit_cap_rate_pct");
    expect(before).toMatchObject({ status: "approved", value: 5.25, source_kind: "document" });
    expect(before.second_approver).not.toBeNull();
    await label(d, "5.75%", "exit_cap_rate_pct");
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    await undo(d, "5.75%");
    const after = await settled(d, "exit_cap_rate_pct");
    expect(after).toMatchObject({ status: "approved", value: 5.25 });
    expect(after).toEqual(before);
  });

  test("an accepted default comes back as default_accepted", async () => {
    const d = await mkDeal(sw, "Undo Default");
    await upload(d, "notes.txt", "Notes\nSpan: 7 years\n");
    expect((await call(alice, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years"] })).status).toBe(200);
    const before = await settled(d, "hold_years");
    expect(before).toMatchObject({ status: "default_accepted", value: 5 });
    await label(d, "7 years", "hold_years");
    expect(await settled(d, "hold_years")).toMatchObject({ status: "conflicting" });
    await undo(d, "7 years");
    expect(await settled(d, "hold_years")).toEqual(before);
    const [restored] = await events(d, "hold_years", "restored");
    expect(restored).toMatchObject({ from_status: "conflicting", to_status: "default_accepted", reason: "The label that disagreed was removed; the value is back as it was accepted" });
  });

  test("a value a person has acted on since the reopen is not restored", async () => {
    const d = await mkDeal(sw, "Undo Acted");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\nQuota: 5.75%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await label(d, "5.25%", "exit_cap_rate_pct");
    const c = await byField(d, "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${c.id}/review`, { action: "modify", value: 5.0, reason: "Lender's term sheet says five", version: c.version })).status).toBe(200);
    await undo(d, "5.25%");
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "approved", value: 5.0, source_kind: "analyst" });
    expect(await events(d, "exit_cap_rate_pct", "restored")).toHaveLength(0);
    // A person who settles the conflict and reopens it has acted too: the value stays conflicting.
    const e = await mkDeal(sw, "Undo Reopened");
    await upload(e, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(e, "exit_cap_rate_pct", 5.5);
    await label(e, "5.25%", "exit_cap_rate_pct");
    const r = await byField(e, "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${r.id}/review`, { action: "resolve", value: 5.5, reason: "Keep mine", version: r.version })).status).toBe(200);
    const settledAgain = await byField(e, "exit_cap_rate_pct");
    expect((await call(alice, "POST", `/api/assumptions/${r.id}/review`, { action: "reopen", version: settledAgain.version })).status).toBe(200);
    expect(await settled(e, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    await undo(e, "5.25%");
    expect(await settled(e, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    expect(await events(e, "exit_cap_rate_pct", "restored")).toHaveLength(0);
  });

  test("a document that still disagrees keeps the value conflicting", async () => {
    const d = await mkDeal(sw, "Undo Document");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await label(d, "5.25%", "exit_cap_rate_pct");
    await upload(d, "budget.txt", "Budget\nExit cap rate: 5.0%\n");
    await undo(d, "5.25%");
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting", value: 5.5 });
    expect(await events(d, "exit_cap_rate_pct", "restored")).toHaveLength(0);
  });

  test("with two labels, undoing one leaves the value conflicting and undoing both restores it", async () => {
    const d = await mkDeal(sw, "Undo Two");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\nQuota: 5.75%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    const before = await settled(d, "exit_cap_rate_pct");
    await label(d, "5.25%", "exit_cap_rate_pct");
    await label(d, "5.75%", "exit_cap_rate_pct");
    await undo(d, "5.25%");
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    await undo(d, "5.75%");
    expect(await settled(d, "exit_cap_rate_pct")).toEqual(before);
  });

  test("a label that spells the item another way restores the row it reopened", async () => {
    const d = await mkDeal(sw, "Undo Item");
    await upload(d, "notes.txt", "Notes\nShop rent: $3,200\n");
    expect((await call(alice, "POST", `/api/deals/${d}/items`, { name: "Retail", unitCount: 2, rentMonthly: 3000, reason: "Two shops on the ground floor" })).status).toBe(200);
    const before = await settled(d, "unit_rent_monthly", "Retail");
    expect(before).toMatchObject({ status: "approved", value: 3000 });
    await label(d, "$3,200", "unit_rent_monthly", "retail");
    expect(await settled(d, "unit_rent_monthly", "Retail")).toMatchObject({ status: "conflicting" });
    await undo(d, "$3,200");
    expect(await settled(d, "unit_rent_monthly", "Retail")).toEqual(before);
    const rows = (await review(d)).assumptions.filter((a: any) => a.fieldKey === "unit_rent_monthly");
    expect(rows.map((a: any) => a.itemKey)).toEqual(["Retail"]);
  });

  test("a copy has no reopened event, so a label undone in the copy leaves its value conflicting", async () => {
    const d = await mkDeal(sw, "Undo Variant");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await label(d, "5.25%", "exit_cap_rate_pct");
    const copy = (await call(alice, "POST", `/api/deals/${d}/copy`, { name: "Undo Variant, copy" })).json.id as string;
    await work();
    expect(await settled(copy, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    expect(await events(copy, "exit_cap_rate_pct", "reopened")).toHaveLength(0);
    await undo(copy, "5.25%");
    expect(await settled(copy, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    expect(await events(copy, "exit_cap_rate_pct", "restored")).toHaveLength(0);
    expect(Object.keys(await reconciled(copy))).not.toContain("restored");
    // The source still has its label and its reopened value.
    expect(await settled(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
  });

  test("audit of card 58b: the reconcile's audit entry names each value it put back", async () => {
    const d = await mkDeal(sw, "Undo Audit");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await label(d, "5.25%", "exit_cap_rate_pct");
    expect(Object.keys(await reconciled(d))).not.toContain("restored_values");
    await undo(d, "5.25%");
    expect(await reconciled(d)).toMatchObject({ restored: 1, restored_values: [{ field: "exit_cap_rate_pct", item: "" }] });
    await reconcileDeal(db, d);
    expect(Object.keys(await reconciled(d))).not.toContain("restored_values");
  });
});

describe("card 63: a person's decision stands through a later, unrelated reconcile", () => {
  let sw: string, tw: string;
  const mkDeal = async (w: string, name: string) =>
    (await call(alice, "POST", `/api/workspaces/${w}/deals`, { name, assetType: "Multifamily", location: "Regina", province: "SK" })).json.id as string;
  const upload = async (d: string, name: string, text: string) => {
    expect((await call(alice, "PUT", `/api/deals/${d}/documents?name=${name}`, undefined, new TextEncoder().encode(text))).status).toBe(200);
    await work();
  };
  const retire = async (d: string, name: string) => {
    const doc = (await call(alice, "GET", `/api/deals/${d}/documents`)).json.find((x: any) => x.name === name);
    expect((await call(alice, "POST", `/api/documents/${doc.id}/retire`)).status).toBe(200);
    await work();
  };
  const review = async (d: string) => (await call(alice, "GET", `/api/deals/${d}/review`)).json;
  const byField = async (d: string, k: string) => (await review(d)).assumptions.find((a: any) => a.fieldKey === k && a.itemKey === null);
  const act = async (s: Session, a: any, body: Record<string, unknown>) => {
    const r = await call(s, "POST", `/api/assumptions/${a.id}/review`, { version: a.version, ...body });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const stored = async (d: string, k: string) =>
    ((await db.query<any>(`select status, value, version, source_kind, sources, conflict_values, reason from assumptions where deal_id = $1 and field_key = $2`, [d, k])) as any[])[0];
  const events = (d: string, k: string) =>
    db.query<any>(`select e.action from assumption_events e join assumptions a on a.id = e.assumption_id where a.deal_id = $1 and a.field_key = $2 order by e.id`, [d, k]);
  const label = async (d: string, raw: string, fieldKey: string) => {
    const f = (await review(d)).other.find((o: any) => o.raw === raw);
    expect((await call(alice, "POST", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId, fieldKey })).status, raw).toBe(200);
    await work();
  };
  const unlabel = async (d: string, raw: string) => {
    const f = (await review(d)).other.find((o: any) => o.raw === raw);
    expect((await call(alice, "DELETE", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId })).status, raw).toBe(200);
    await work();
  };
  const enter = async (d: string, fieldKey: string, value: number) =>
    expect((await call(alice, "POST", `/api/deals/${d}/values`, { fieldKey, value, reason: "Quick start answer" })).status, fieldKey).toBe(200);
  const unrelated = (d: string, n: number) => upload(d, `site-${n}.txt`, `Site notes ${n}\nParking stalls: ${100 + n}\n`);
  // A land cost the budget states, approved, and the budget then retired: the value waits to be confirmed or rejected.
  const waiting = async (w: string, name: string) => {
    const d = await mkDeal(w, name);
    await upload(d, "budget.txt", "Budget\nLand cost: $800,000\n");
    await act(alice, await byField(d, "land_cost"), { action: "approve" });
    await retire(d, "budget.txt");
    expect(await byField(d, "land_cost")).toMatchObject({ status: "needs_review", value: 800000, sources: [], reason: "Its source document was removed; confirm or reject it" });
    return d;
  };

  test("a workspace in solo review and one in team review are set up", async () => {
    sw = (await call(alice, "POST", "/api/workspaces", { name: "Stands solo", reviewMode: "solo" })).json.id;
    tw = (await call(alice, "POST", "/api/workspaces", { name: "Stands team", reviewMode: "team" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${tw}/members`, { email: "bob@example.com", role: "admin" })).status).toBe(200);
  });

  test("a resolved conflict stands through an unrelated upload, and a third value reopens it with every value named", async () => {
    const d = await mkDeal(sw, "Stands Resolved");
    await upload(d, "budget.txt", "Budget\nLand cost: $800,000\n");
    await upload(d, "purchase.txt", "Purchase agreement\nLand cost: $850,000\n");
    await act(alice, await byField(d, "land_cost"), { action: "resolve", value: 850000, reason: "The agreement governs" });
    const before = await stored(d, "land_cost");
    const eventsBefore = await events(d, "land_cost");
    expect(before).toMatchObject({ status: "approved", value: 850000, source_kind: "document" });
    await unrelated(d, 1);
    expect(await stored(d, "land_cost")).toEqual(before);
    expect(await events(d, "land_cost")).toEqual(eventsBefore);
    await upload(d, "appraisal.txt", "Appraisal\nLand cost: $900,000\n");
    const after = await byField(d, "land_cost");
    expect(after.status).toBe("conflicting");
    expect(after.conflictValues.map((v: any) => v.value).sort((a: number, b: number) => a - b)).toEqual([800000, 850000, 900000]);
  });

  test("a resolved conflict whose chosen document is retired reopens, naming the settled value", async () => {
    const d = await mkDeal(sw, "Stands Retired");
    await upload(d, "budget.txt", "Budget\nLand cost: $800,000\n");
    await upload(d, "purchase.txt", "Purchase agreement\nLand cost: $850,000\n");
    await act(alice, await byField(d, "land_cost"), { action: "resolve", value: 850000, reason: "The agreement governs" });
    await retire(d, "purchase.txt");
    const a = await byField(d, "land_cost");
    expect(a).toMatchObject({ status: "conflicting", value: 850000 });
    expect(a.conflictValues).toEqual([{ value: 850000, documents: ["Approved earlier"] }, { value: 800000, documents: ["budget.txt"] }]);
  });

  test("a document value approved from review still reopens when a document states another value", async () => {
    const d = await mkDeal(sw, "Stands Review");
    await upload(d, "budget.txt", "Budget\nLand cost: $800,000\n");
    await act(alice, await byField(d, "land_cost"), { action: "approve" });
    await upload(d, "purchase.txt", "Purchase agreement\nLand cost: $850,000\n");
    const a = await byField(d, "land_cost");
    expect(a.status).toBe("conflicting");
    expect(a.conflictValues.map((v: any) => v.value).sort((x: number, y: number) => x - y)).toEqual([800000, 850000]);
  });

  test("a value waiting after its document went stays waiting through an unrelated upload, at the same version", async () => {
    const d = await waiting(sw, "Stands Waiting");
    const before = await stored(d, "land_cost");
    const eventsBefore = await events(d, "land_cost");
    await unrelated(d, 1);
    await unrelated(d, 2);
    expect(await stored(d, "land_cost")).toEqual(before);
    expect(await events(d, "land_cost")).toEqual(eventsBefore);
  });

  test("a value confirmed with no source set up directly in the database stays approved through two unrelated uploads", async () => {
    const d = await waiting(sw, "Stands Direct");
    await db.query(`update assumptions set status = 'approved' where deal_id = $1 and field_key = 'land_cost'`, [d]);
    const before = await stored(d, "land_cost");
    expect(before).toMatchObject({ status: "approved", source_kind: "document", sources: [] });
    await unrelated(d, 1);
    await unrelated(d, 2);
    expect(await stored(d, "land_cost")).toEqual(before);
  });

  test("a value waiting after its document went takes the new document's value and sources when a document states the field again", async () => {
    const d = await waiting(sw, "Stands Again");
    await upload(d, "purchase.txt", "Purchase agreement\nLand cost: $850,000\n");
    const a = await byField(d, "land_cost");
    expect(a).toMatchObject({ status: "needs_review", value: 850000 });
    expect(a.sources).toHaveLength(1);
    expect(a.sources[0]).toMatchObject({ document_name: "purchase.txt", value: 850000 });
  });

  test("a value that came only from a person's label waits after the label is undone, through an unrelated upload", async () => {
    const d = await mkDeal(sw, "Stands Label");
    await upload(d, "notes.txt", "Notes\nBanner allowance: $7,000\n");
    await label(d, "$7,000", "other_cost");
    await act(alice, await byField(d, "other_cost"), { action: "approve" });
    await unlabel(d, "$7,000");
    expect(await byField(d, "other_cost")).toMatchObject({ status: "needs_review", value: 7000, reason: "The label a person gave its figure was removed; confirm or reject it" });
    const before = await stored(d, "other_cost");
    await unrelated(d, 1);
    expect(await stored(d, "other_cost")).toEqual(before);
  });

  test("a reopened document value keeps naming the settled value through an unrelated upload", async () => {
    const d = await mkDeal(sw, "Stands Reopened Document");
    await upload(d, "notes.txt", "Notes\nExit cap rate: 5.25%\nQuota: 5.75%\n");
    await act(alice, await byField(d, "exit_cap_rate_pct"), { action: "approve" });
    await label(d, "5.75%", "exit_cap_rate_pct");
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting", value: 5.25 });
    await unrelated(d, 1);
    const a = await byField(d, "exit_cap_rate_pct");
    expect(a).toMatchObject({ status: "conflicting", value: 5.25 });
    expect(a.conflictValues).toEqual([{ value: 5.25, documents: ["Approved earlier"] }, { value: 5.75, documents: ["notes.txt"] }]);
  });

  test("a reopened hand entry follows the documents: a new value joins its conflict, and a value no document states leaves it", async () => {
    const d = await mkDeal(sw, "Stands Reopened Hand");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await upload(d, "first.txt", "First\nExit cap rate: 5.25%\n");
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting", value: 5.5 });
    await upload(d, "second.txt", "Second\nExit cap rate: 5.0%\n");
    const both = await byField(d, "exit_cap_rate_pct");
    expect(both).toMatchObject({ status: "conflicting", value: 5.5 });
    expect(both.conflictValues).toEqual([{ value: 5.5, documents: ["Entered by an analyst"] }, { value: 5.0, documents: ["second.txt"] }, { value: 5.25, documents: ["first.txt"] }]);
    await retire(d, "first.txt");
    const one = await byField(d, "exit_cap_rate_pct");
    expect(one).toMatchObject({ status: "conflicting", value: 5.5 });
    expect(one.conflictValues).toEqual([{ value: 5.5, documents: ["Entered by an analyst"] }, { value: 5.0, documents: ["second.txt"] }]);
    // A reconcile that only updates a conflict writes no second reopened event.
    expect((await events(d, "exit_cap_rate_pct")).filter((e: any) => e.action === "reopened")).toHaveLength(1);
  });
  // card 63 rule 3 tests
  // Rule 3: confirming a value no document states any more makes it the person's own.
  const exitCapWaiting = async (w: string, name: string) => {
    const d = await mkDeal(w, name);
    await upload(d, "notes.txt", "Notes\nExit cap rate: 5.25%\n");
    await act(alice, await byField(d, "exit_cap_rate_pct"), { action: "approve" });
    await retire(d, "notes.txt");
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "needs_review", value: 5.25, sources: [] });
    return d;
  };

  test("confirming a value whose document went, in solo review, records the person's own value, sponsor-stated, and it stays", async () => {
    const d = await exitCapWaiting(sw, "Stands Confirm Solo");
    await act(alice, await byField(d, "exit_cap_rate_pct"), { action: "approve", reason: "Confirmed with the lender" });
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "approved", value: 5.25, sponsorStated: true });
    expect(await stored(d, "exit_cap_rate_pct")).toMatchObject({ source_kind: "analyst", reason: "Confirmed with the lender" });
    const before = await stored(d, "exit_cap_rate_pct");
    await unrelated(d, 1);
    await unrelated(d, 2);
    expect(await stored(d, "exit_cap_rate_pct")).toEqual(before);
  });

  test("confirming such a material value in team review waits for a second person, and then stands", async () => {
    const d = await exitCapWaiting(tw, "Stands Confirm Team");
    await act(alice, await byField(d, "exit_cap_rate_pct"), { action: "approve", reason: "Confirmed with the lender" });
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "awaiting_second_approval", pendingValue: 5.25 });
    await act(bob, await byField(d, "exit_cap_rate_pct"), { action: "second_approve" });
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "approved", value: 5.25 });
    const before = await stored(d, "exit_cap_rate_pct");
    await unrelated(d, 1);
    expect(await stored(d, "exit_cap_rate_pct")).toEqual(before);
  });

  test("confirming such a value that is not material in team review approves it at once, as the person's own", async () => {
    const d = await waiting(tw, "Stands Confirm Team Plain");
    await act(alice, await byField(d, "land_cost"), { action: "approve", reason: "Seen in the closing statement" });
    expect(await byField(d, "land_cost")).toMatchObject({ status: "approved", value: 800000 });
    expect(await stored(d, "land_cost")).toMatchObject({ source_kind: "analyst" });
  });

  test("a document that states another value reopens a confirmed value as a hand entry, naming it", async () => {
    const d = await waiting(sw, "Stands Confirm Reopen");
    await act(alice, await byField(d, "land_cost"), { action: "approve", reason: "Seen in the closing statement" });
    await upload(d, "purchase.txt", "Purchase agreement\nLand cost: $850,000\n");
    const a = await byField(d, "land_cost");
    expect(a).toMatchObject({ status: "conflicting", value: 800000 });
    expect(a.conflictValues).toEqual([{ value: 800000, documents: ["Entered by an analyst"] }, { value: 850000, documents: ["purchase.txt"] }]);
  });

  test("audit of card 63: keeping a value no document states needs a written reason, as any hand entry does", async () => {
    const d = await exitCapWaiting(sw, "Stands Confirm No Reason");
    const a = await byField(d, "exit_cap_rate_pct");
    for (const reason of [undefined, "", "ok"]) {
      const r = await call(alice, "POST", `/api/assumptions/${a.id}/review`, { version: a.version, action: "approve", ...(reason === undefined ? {} : { reason }) });
      expect(r.status, String(reason)).toBe(422);
    }
    expect(await stored(d, "exit_cap_rate_pct")).toMatchObject({ status: "needs_review", source_kind: "document", version: a.version });
    // A value its document still states is approved with no reason, as before.
    const d2 = await mkDeal(sw, "Stands Approve Plain");
    await upload(d2, "notes.txt", "Notes\nExit cap rate: 5.25%\n");
    await act(alice, await byField(d2, "exit_cap_rate_pct"), { action: "approve" });
    expect(await byField(d2, "exit_cap_rate_pct")).toMatchObject({ status: "approved" });
  });

  // Extension of rule 4: put back after a document went.
  const whole = async (d: string, k: string) =>
    ((await db.query<any>(`select status, value, reason, sources, source_kind, decided_by, decided_at, second_approver, second_approved_at, conflict_values from assumptions where deal_id = $1 and field_key = $2`, [d, k])) as any[])[0];
  const lastReconcile = async (d: string) => ((await db.query<any>(`select payload from audit_events where action = 'assumptions.reconciled' and deal_id = $1 order by seq desc limit 1`, [d])) as any[])[0].payload;

  test("a value a document reopened comes back as it was when that document is retired, and the audit trail says why", async () => {
    const d = await mkDeal(sw, "Stands Put Back");
    await enter(d, "exit_cap_rate_pct", 5.5);
    const before = await whole(d, "exit_cap_rate_pct");
    await upload(d, "appraisal.txt", "Appraisal\nExit cap rate: 5.25%\n");
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "conflicting" });
    await retire(d, "appraisal.txt");
    expect(await whole(d, "exit_cap_rate_pct")).toEqual(before);
    expect(await lastReconcile(d)).toMatchObject({ restored: 1, restored_values: [{ field: "exit_cap_rate_pct", item: "", by: "document" }] });
    const [restored] = ((await db.query<any>(`select e.reason, e.actor from assumption_events e join assumptions a on a.id = e.assumption_id where a.deal_id = $1 and e.action = 'restored'`, [d])) as any[]);
    expect(restored).toMatchObject({ actor: null, reason: "The document that disagreed was removed; the value is back as it was approved" });
  });

  test("a value a person rejected after a document reopened it stays rejected when that document is retired", async () => {
    const d = await mkDeal(sw, "Stands Put Back Rejected");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await upload(d, "appraisal.txt", "Appraisal\nExit cap rate: 5.25%\n");
    await act(alice, await byField(d, "exit_cap_rate_pct"), { action: "reject", reason: "Neither is right" });
    await retire(d, "appraisal.txt");
    expect(await byField(d, "exit_cap_rate_pct")).toMatchObject({ status: "rejected" });
    expect(((await db.query<any>(`select 1 from assumption_events e join assumptions a on a.id = e.assumption_id where a.deal_id = $1 and e.action = 'restored'`, [d])) as any[])).toHaveLength(0);
  });

  test("a value a label reopened is named as put back by a label", async () => {
    const d = await mkDeal(sw, "Stands Put Back Label");
    await upload(d, "notes.txt", "Notes\nGauge: 5.25%\n");
    await enter(d, "exit_cap_rate_pct", 5.5);
    await label(d, "5.25%", "exit_cap_rate_pct");
    await unlabel(d, "5.25%");
    expect(await lastReconcile(d)).toMatchObject({ restored_values: [{ field: "exit_cap_rate_pct", item: "", by: "label" }] });
  });
});

describe("card 58c: the deal overview says while a reconcile is still to run", () => {
  let sw: string, d: string;
  const updating = async () => (await call(alice, "GET", `/api/deals/${d}`)).json.updating;
  const review = async () => (await call(alice, "GET", `/api/deals/${d}/review`)).json;

  test("a deal with nothing queued is not updating", async () => {
    sw = (await call(alice, "POST", "/api/workspaces", { name: "Updating solo", reviewMode: "solo" })).json.id;
    d = (await call(alice, "POST", `/api/workspaces/${sw}/deals`, { name: "Updating Fourplex", assetType: "Multifamily", location: "Regina", province: "SK" })).json.id;
    expect(await updating()).toBe(false);
    expect((await call(alice, "PUT", `/api/deals/${d}/documents?name=notes.txt`, undefined, new TextEncoder().encode("Notes\nGauge: 5.25%\n"))).status).toBe(200);
    await work();
    expect(await updating()).toBe(false);
  });

  test("it is true after a label is saved and before the worker has run, and false after", async () => {
    const f = (await review()).other.find((o: any) => o.raw === "5.25%");
    expect((await call(alice, "POST", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId, fieldKey: "exit_cap_rate_pct" })).status).toBe(200);
    expect(await updating()).toBe(true);
    await work();
    expect(await updating()).toBe(false);
    expect((await call(alice, "DELETE", `/api/deals/${d}/figure-labels`, { documentId: f.documentId, figureId: f.figureId })).status).toBe(200);
    expect(await updating()).toBe(true);
    await work();
    expect(await updating()).toBe(false);
  });

  test("it is true after a document is retired and before the worker has run, and false after", async () => {
    const doc = (await call(alice, "GET", `/api/deals/${d}/documents`)).json.find((x: any) => x.name === "notes.txt");
    expect((await call(alice, "POST", `/api/documents/${doc.id}/retire`)).status).toBe(200);
    expect(await updating()).toBe(true);
    await work();
    expect(await updating()).toBe(false);
  });

  test("it is true while the job is running, and a finished or dead job does not count", async () => {
    await db.query(`insert into jobs (kind, payload, status) values ('reconcile_deal', jsonb_build_object('deal_id', $1::text), 'running')`, [d]);
    expect(await updating()).toBe(true);
    await db.query(`update jobs set status = 'dead' where payload->>'deal_id' = $1 and status = 'running'`, [d]);
    expect(await updating()).toBe(false);
    await db.query(`insert into jobs (kind, payload, status) values ('reconcile_deal', jsonb_build_object('deal_id', $1::text), 'done')`, [d]);
    await db.query(`insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', $1::text))`, [randomUUID()]);
    expect(await updating()).toBe(false);
  });

  test("a person outside the workspace cannot ask whether another workspace's deal is updating", async () => {
    await db.query(`insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', $1::text))`, [d]);
    const [erin] = await db.query<{ id: string }>(`select id from users where email = 'carol@example.com'`);
    const [alicia] = await db.query<{ id: string }>(`select id from users where email = 'alice@example.com'`);
    const ask = (u: string) => asUser(db, u, (tx) => tx.query<{ u: boolean }>(`select fn_deal_updating($1::uuid) as u`, [d]));
    await expect(ask(erin!.id)).rejects.toThrow();
    expect((await ask(alicia!.id))[0]!.u).toBe(true);
    // The app role still cannot read the queue itself.
    await expect(asUser(db, alicia!.id, (tx) => tx.query(`select * from jobs`))).rejects.toThrow();
    await work();
  });
});

describe("trying changes on a stored sale (task 82)", () => {
  test("uses sale drivers, rejects rental axes and shocks, and writes nothing", async () => {
    const sw = (await call(alice, "POST", "/api/workspaces", { name: "Sale exploration", reviewMode: "solo" })).json.id;
    const d = (await call(alice, "POST", `/api/workspaces/${sw}/deals`, { name: "Sale scratch", assetType: "Townhomes" })).json.id;
    const values: [string, number, string?][] = [
      ["sell_units", 1], ["land_cost", 100_000], ["hard_cost", 300_000], ["soft_cost", 20_000], ["contingency", 10_000],
      ["construction_months", 12], ["senior_loan_amount", 0], ["unit_count", 2, "TH"], ["unit_sale_price", 400_000, "TH"],
      ["presold_units_pct", 50], ["deposit_pct", 10], ["absorption_units_per_month", 1], ["sales_commission_pct", 4],
      ["closing_lag_months", 0], ["unsold_carry_monthly", 100],
    ];
    for (const [fieldKey, value, itemKey] of values) expect((await call(alice, "POST", `/api/deals/${d}/values`,
      { fieldKey, value, reason: "Quick start answer", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);
    const made = await call(alice, "POST", `/api/deals/${d}/runs`);
    expect(made.status).toBe(200);
    const id = made.json.id;
    const stored = async () => canonicalJson(await db.query(`select r.*, (select count(*) from audit_events) as audit, (select count(*) from run_metrics) as metrics, (select count(*) from runs) as runs from runs r where r.id = $1`, [id]));
    const before = await stored();
    expect((await call(alice, "GET", `/api/runs/${id}/drivers`)).json).toEqual(SALE_DRIVERS);
    expect((await call(alice, "GET", `/api/runs/${run}/drivers`)).json).toEqual(DRIVERS);
    expect((await call(alice, "GET", "/api/sensitivity/drivers")).json).toEqual(DRIVERS);
    for (const shock of [{ exitCapBps: 25 }, { exitCapBps: 5000 }, { leaseUpMonths: 1 }, { unknown: 1 }]) {
      const res = await call(alice, "POST", `/api/runs/${id}/explore`, { shock });
      expect(res.status).toBe(422);
      expect(res.json.error).toBe("This driver does not apply to this deal.");
    }
    const invalidAxis = await call(alice, "POST", `/api/runs/${id}/grid`, { metric: "profit_on_cost_for_sale", x: "rateBps", y: "rentPct" });
    expect(invalidAxis.status).toBe(422);
    expect(invalidAxis.json.error).toBe("This driver does not apply to this deal.");
    const unknownAxis = await call(alice, "POST", `/api/runs/${id}/grid`, { metric: "profit_on_cost_for_sale", x: "rateBps", y: "unknown" });
    expect(unknownAxis.status).toBe(422);
    expect(unknownAxis.json.error).toBe("This driver does not apply to this deal.");
    expect((await call(alice, "POST", `/api/runs/${run}/explore`, { shock: { pricePct: 10 } })).status).toBe(422);
    for (const [endpoint, body] of [["explore", { shock: { pricePct: -10, absorptionPct: 10, presalesPts: 5 } }],
      ["tornado", { metric: "profit_on_cost_for_sale" }], ["breakeven", {}],
      ["grid", { metric: "profit_on_cost_for_sale", x: "rateBps", y: "pricePct" }]] as const) {
      const res = await call(alice, "POST", `/api/runs/${id}/${endpoint}`, body);
      expect(res.status, endpoint).toBe(200);
      expect(res.json.scratch).toBe(true);
    }
    expect(await stored()).toBe(before);
  });
});

describe("requesting the partner memo (task 84d)", () => {
  let partnerRun: string, partnerDeal: string, heldRun: string;
  beforeAll(async () => {
    const workspace = (await call(alice, "POST", "/api/workspaces", { name: "Partners", reviewMode: "solo" })).json.id;
    for (const held of [false, true]) {
      const d = (await call(alice, "POST", `/api/workspaces/${workspace}/deals`, { name: held ? "Held partners" : "Sold partners", assetType: "Multifamily" })).json.id;
      const fields: [string, number, string?][] = [
        ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
        ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
        ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"], ["lp_share_pct", 90], ["preferred_return_pct", 8], ["gp_promote_pct", 20],
        ...(held ? [["refinance_and_hold", 1], ["refinance_month", 1], ["refinance_amount", 500_000], ["refinance_rate_pct", 5], ["refinance_amort_years", 30]] as [string, number][] : []),
      ];
      for (const [fieldKey, value, itemKey] of fields) expect((await call(alice, "POST", `/api/deals/${d}/values`,
        { fieldKey, value, reason: "Partner memo test", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);
      const made = await call(alice, "POST", `/api/deals/${d}/runs`);
      expect(made.status).toBe(200);
      if (held) heldRun = made.json.id; else { partnerRun = made.json.id; partnerDeal = d; }
    }
  });
  test("accepts PDF, generates it through the worker, and records the kind", async () => {
    const request = await call(alice, "POST", `/api/runs/${partnerRun}/artifacts`, { kind: "partner_memo", format: "pdf" });
    expect(request.status).toBe(200);
    await work();
    const artifact = (await call(alice, "GET", `/api/deals/${partnerDeal}/artifacts`)).json.find((a: any) => a.kind === "partner_memo");
    expect(artifact).toMatchObject({ id: request.json.id, status: "ready" });
    const file = await app.request(`/api/artifacts/${artifact.id}/file`, { headers: { cookie: alice.cookie } });
    expect(new Uint8Array(await file.arrayBuffer()).slice(0, 4)).toEqual(new TextEncoder().encode("%PDF"));
    expect(file.headers.get("content-disposition")).toContain("Partner%20memo");
    const events = (await call(alice, "GET", `/api/deals/${partnerDeal}/audit`)).json;
    expect(events.some((e: any) => e.action === "artifact.requested" && e.payload.kind === "partner_memo")).toBe(true);
  }, 120_000);
  test("unsplit runs are rejected before any artifact job is created", async () => {
    const count = async () => canonicalJson(await db.query(`select (select count(*) from artifacts) as artifacts, (select count(*) from jobs) as jobs, (select count(*) from audit_events) as audit`));
    const before = await count();
    for (const id of [run]) {
      const response = await call(alice, "POST", `/api/runs/${id}/artifacts`, { kind: "partner_memo", format: "pdf" });
      expect(response.status).toBe(422);
      expect(response.json.error).toBe("This deal has no LP/GP split, so it has no partner memo.");
    }
    expect(await count()).toBe(before);
  });
  test("a held run with a split is accepted and its memo is generated (task 87a)", async () => {
    const request = await call(alice, "POST", `/api/runs/${heldRun}/artifacts`, { kind: "partner_memo", format: "pdf" });
    expect(request.status).toBe(200);
    await work();
    const [artifact] = await db.query<{ status: string; kind: string; deal_id: string }>(`select status, kind, deal_id from artifacts where id = $1`, [request.json.id]);
    expect(artifact).toMatchObject({ status: "ready", kind: "partner_memo" });
    const events = (await call(alice, "GET", `/api/deals/${artifact!.deal_id}/audit`)).json;
    expect(events.some((e: any) => e.action === "artifact.requested" && e.payload.kind === "partner_memo")).toBe(true);
  }, 120_000);
  test("the held run with a split carries its partner returns; the sold and unsplit runs do not (task 88b)", async () => {
    const [stored] = await db.query<{ result: any; input_snapshot: any }>(`select result, input_snapshot from runs where id = $1`, [heldRun]);
    const h = heldPartnerReturns(stored!.result.equityFlows, stored!.input_snapshot.input.waterfall);
    const positive = (flows: { amount: number }[]) => flows.filter((f) => f.amount > 0).reduce((n, f) => n + f.amount, 0);
    const view = await call(alice, "GET", `/api/runs/${heldRun}`);
    expect(view.status).toBe(200);
    expect(view.json.heldPartners).toEqual({ lpIrr: h.withValue.lpIrr, gpIrr: h.withValue.gpIrr, promote: h.withValue.promote,
      paidLp: positive(h.paid.lp), paidGp: positive(h.paid.gp), paidPromote: h.paid.promote });
    for (const id of [partnerRun, run]) {
      const other = await call(alice, "GET", `/api/runs/${id}`);
      expect(other.status).toBe(200);
      expect("heldPartners" in other.json).toBe(false);
    }
  });
  test("fresh migrations include 0016 and its kind check still refuses an unknown kind", async () => {
    expect(await db.query(`select name from schema_migrations where name = '0016_partner_memo.sql'`)).toHaveLength(1);
    const me = (await call(alice, "GET", "/api/me")).json.user.id;
    await expect(asUser(db, me, (tx) => tx.query(`select fn_request_artifact($1, $2, $3)`, [partnerRun, "unknown", "pdf"]))).rejects.toThrow(/artifacts_kind_check/);
  });
});


describe("share links (task 86a)", () => {
  let workspace: string, sharedDeal: string, sharedRun: string, artifact: string, queued: string;
  let outsider: Session, ownerId: string, viewerId: string;
  const unavailable = "This link is not available. It may have expired or been revoked.";
  const privacy = (headers: Headers) => {
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-robots-tag")).toBe("noindex");
  };
  const make = async (who = alice, term = "7d") => {
    const made = await call(who, "POST", `/api/artifacts/${artifact}/share-links`, { term });
    expect(made.status).toBe(200);
    const secret = String(made.json.url).slice(3);
    expect(/^[A-Za-z0-9_-]{43}$/.test(secret)).toBe(true);
    return { id: made.json.id as string, secret, expiresAt: made.json.expiresAt as string | null };
  };
  beforeAll(async () => {
    app = createApp({ db, store, secureCookies: false });
    outsider = await signup("share-outsider@example.com", "Share Outsider");
    ownerId = (await call(alice, "GET", "/api/me")).json.user.id;
    viewerId = (await call(carol, "GET", "/api/me")).json.user.id;
    workspace = (await call(alice, "POST", "/api/workspaces", { name: "Share test", reviewMode: "solo" })).json.id;
    for (const [email, role] of [["bob@example.com", "analyst"], ["carol@example.com", "viewer"]]) {
      expect((await call(alice, "POST", `/api/workspaces/${workspace}/members`, { email, role })).status).toBe(200);
    }
    sharedDeal = (await call(alice, "POST", `/api/workspaces/${workspace}/deals`, { name: "Shared reference", assetType: "Multifamily" })).json.id;
    const values: [string, number, string?][] = [["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0],
      ["construction_months", 0], ["lease_up_months", 0], ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0],
      ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0], ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1000, "A"]];
    for (const [fieldKey, value, itemKey] of values) expect((await call(alice, "POST", `/api/deals/${sharedDeal}/values`,
      { fieldKey, value, reason: "Share link fixture", ...(itemKey ? { itemKey } : {}) })).status).toBe(200);
    sharedRun = (await call(alice, "POST", `/api/deals/${sharedDeal}/runs`)).json.id;
    artifact = (await call(alice, "POST", `/api/runs/${sharedRun}/artifacts`, { kind: "ic_memo", format: "pdf" })).json.id;
    await work();
    expect((await call(alice, "GET", `/api/deals/${sharedDeal}/artifacts`)).json.find((a: any) => a.id === artifact).status).toBe("ready");
    queued = (await call(alice, "POST", `/api/runs/${sharedRun}/artifacts`, { kind: "ic_memo", format: "docx" })).json.id;
  }, 120_000);
  test.each(["owner", "analyst", "viewer"])("%s can make a link", async (role) => {
    const who = role === "owner" ? alice : role === "analyst" ? bob : carol;
    const link = await make(who);
    const [stored] = await db.query<{ token_hash: string }>(`select token_hash from share_links where id = $1`, [link.id]);
    expect(stored!.token_hash === sha256(link.secret)).toBe(true);
  });
  test("outsiders, queued reports and invalid terms are refused; mutations retain CSRF", async () => {
    expect((await call(outsider, "POST", `/api/artifacts/${artifact}/share-links`, { term: "7d" })).status).toBe(403);
    const waiting = await call(alice, "POST", `/api/artifacts/${queued}/share-links`, { term: "7d" });
    expect(waiting.status).toBe(422);
    expect(waiting.json.error).toBe("Only a finished report can be shared.");
    expect((await call(alice, "POST", `/api/artifacts/${artifact}/share-links`, { term: "bad" })).status).toBe(422);
    expect((await call(alice, "POST", `/api/artifacts/${randomUUID()}/share-links`, { term: "7d" })).status).toBe(404);
    expect((await app.request(`/api/artifacts/${artifact}/share-links`, { method: "POST", headers: { cookie: alice.cookie } })).status).toBe(403);
  });
  test("public page, bytes and audit package match the signed-in views and record only anonymous openings", async () => {
    const link = await make();
    const page = await call(null, "GET", `/api/share/${link.secret}`);
    expect(page.status).toBe(200);
    privacy(page.headers);
    expect(page.json).toEqual({ deal: "Shared reference", kind: "ic_memo", format: "pdf", runNumber: 1, expiresAt: link.expiresAt });
    const file = await app.request(`/api/share/${link.secret}/file?inline=1`);
    const signed = await app.request(`/api/artifacts/${artifact}/file?inline=1`, { headers: { cookie: alice.cookie } });
    privacy(file.headers);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe(signed.headers.get("content-type"));
    expect(file.headers.get("content-disposition")).toBe(signed.headers.get("content-disposition"));
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(await signed.arrayBuffer()));
    const pkg = await call(null, "GET", `/api/share/${link.secret}/audit-package`);
    privacy(pkg.headers);
    expect(pkg.status).toBe(200);
    const signedPkg = await call(alice, "GET", `/api/runs/${sharedRun}/audit-package`);
    delete pkg.json.validation.checkedAt; delete signedPkg.json.validation.checkedAt;
    expect(pkg.json).toEqual(signedPkg.json);
    const opened = await db.query(`select actor, payload, entity, entity_id from audit_events where action = 'share.opened' and entity_id = $1 order by seq`, [link.id]);
    expect(opened).toEqual(["page", "file", "audit_package"].map((what) => ({ actor: null, payload: { what }, entity: "share_link", entity_id: link.id })));
    const list = await call(carol, "GET", `/api/deals/${sharedDeal}/share-links`);
    expect(list.status).toBe(200);
    expect(list.json.find((l: any) => l.id === link.id)).toMatchObject({ artifact_id: artifact, kind: "ic_memo", format: "pdf", run_number: 1,
      term: "7d", created_by: "Alice Analyst", openings: 3, revoked_at: null, revoked_by: null });
    expect(list.json.find((l: any) => l.id === link.id).last_opened_at).toBeTruthy();
    expect(JSON.stringify(list.json).includes("token_hash")).toBe(false);
    expect(JSON.stringify(list.json).includes(link.secret)).toBe(false);
    const times = list.json.map((l: any) => new Date(l.created_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
  test.each(["unknown", "revoked", "expired", "departed", "expired membership"])("%s gives the same private 404 without an opening", async (mode) => {
    const link = await make(mode === "departed" || mode === "expired membership" ? carol : alice);
    if (mode === "revoked") expect((await call(alice, "POST", `/api/share-links/${link.id}/revoke`)).status).toBe(200);
    if (mode === "expired") await db.query(`update share_links set expires_at = now() - interval '1 minute' where id = $1`, [link.id]);
    if (mode === "departed") await db.query(`delete from workspace_members where workspace_id = $1 and user_id = $2`, [workspace, viewerId]);
    if (mode === "expired membership") await db.query(`update workspace_members set role = 'reviewer', expires_at = now() - interval '1 minute' where workspace_id = $1 and user_id = $2`, [workspace, viewerId]);
    try {
      const before = (await db.query<{ n: number }>(`select count(*) as n from audit_events where action = 'share.opened'`))[0]!.n;
      const secret = mode === "unknown" ? randomUUID() : link.secret;
      for (const suffix of ["", "/file", "/audit-package"]) {
        const response = await call(null, "GET", `/api/share/${secret}${suffix}`);
        expect(response.status).toBe(404);
        expect(response.json).toEqual({ error: unavailable }); privacy(response.headers);
      }
      const after = (await db.query<{ n: number }>(`select count(*) as n from audit_events where action = 'share.opened'`))[0]!.n;
      expect(after).toBe(before);
    } finally {
      if (mode === "departed") await call(alice, "POST", `/api/workspaces/${workspace}/members`, { email: "carol@example.com", role: "viewer" });
      if (mode === "expired membership") await db.query(`update workspace_members set role = 'viewer', expires_at = null where workspace_id = $1 and user_id = $2`, [workspace, viewerId]);
    }
  });
  test.each([["24h", 86400], ["7d", 604800], ["30d", 2592000], ["none", null]] as const)("%s has the specified expiry", async (term, seconds) => {
    const link = await make(alice, term);
    const [stored] = await db.query<{ expires_at: string | null }>(`select expires_at from share_links where id = $1`, [link.id]);
    if (seconds === null) { expect(link.expiresAt).toBeNull(); expect(stored!.expires_at).toBeNull(); }
    else expect(Math.abs(new Date(link.expiresAt!).getTime() - Date.now() - seconds * 1000)).toBeLessThan(60_000);
    expect((await call(null, "GET", `/api/share/${link.secret}`)).status).toBe(200);
  });
  test.each(["owner", "analyst", "viewer"])("%s can revoke; outsiders and a second revocation are refused", async (role) => {
    const link = await make();
    expect((await call(outsider, "POST", `/api/share-links/${link.id}/revoke`)).status).toBe(403);
    const who = role === "owner" ? alice : role === "analyst" ? bob : carol;
    expect((await call(who, "POST", `/api/share-links/${link.id}/revoke`)).status).toBe(200);
    const again = await call(who, "POST", `/api/share-links/${link.id}/revoke`);
    expect(again.status).toBe(422); expect(again.json.error).toBe("This link is already revoked.");
    const events = await db.query(`select action, payload from audit_events where entity_id = $1 order by seq`, [link.id]);
    expect(events.map((e) => e.action)).toEqual(["share.created", "share.revoked"]);
    expect(events[1]!.payload).toEqual({ artifact_id: artifact });
    expect(Object.keys(events[0]!.payload as object).sort()).toEqual(["artifact_id", "run_id", "kind", "format", "term", "expires_at"].sort());
  });
  test("secrets are absent from stored rows, audit payloads and forced-error logs", async () => {
    const link = await make();
    const rows = await db.query(`select * from share_links`);
    const payloads = await db.query(`select payload from audit_events`);
    expect(JSON.stringify(rows).includes(link.secret)).toBe(false);
    expect(JSON.stringify(payloads).includes(link.secret)).toBe(false);
    const tables = await db.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`);
    for (const { tablename } of tables) {
      const [found] = await db.query<{ leaked: boolean }>(`select exists (select 1 from "${tablename.replaceAll('"', '""')}" r where position($1 in to_jsonb(r)::text) > 0) as leaked`, [link.secret]);
      expect(found!.leaked).toBe(false);
    }
    const broken = createApp({ db, secureCookies: false, store: { ...store, get: async () => { throw new Error(link.secret); } } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await broken.request(`/api/share/${link.secret}/file`);
      expect(response.status).toBe(500); privacy(response.headers);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls).includes(link.secret)).toBe(false);
      expect(JSON.parse(String(log.mock.calls[0]![0])).path).toBe("/api/share/…");
    } finally { log.mockRestore(); }
  });
  test("the 61st public request is limited and retains privacy headers", async () => {
    const limited = createApp({ db, store, secureCookies: false });
    const secret = randomUUID();
    for (let n = 1; n <= 61; n++) {
      const response = await limited.request(`/api/share/${secret}`);
      expect(response.status).toBe(n <= 60 ? 404 : 429); privacy(response.headers);
      if (n === 61) expect(await response.json()).toEqual({ error: "Too many requests. Wait a minute." });
    }
    expect((await limited.request(`/api/share/${secret}`, { headers: { "x-forwarded-for": "another-client" } })).status).toBe(404);
  });
  test("the new table has member-read RLS and no direct write grants", async () => {
    expect(await db.query(`select name from schema_migrations where name = '0017_share_links.sql'`)).toHaveLength(1);
    const link = await make();
    const outsiderId = (await call(outsider, "GET", "/api/me")).json.user.id;
    expect(await asUser(db, outsiderId, (tx) => tx.query(`select id from share_links where id = $1`, [link.id]))).toEqual([]);
    for (const sql of ["insert into share_links default values", "update share_links set revoked_at = now()", "delete from share_links"]) {
      await expect(asUser(db, ownerId, (tx) => tx.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
    const grants = await db.query(`select p.proname from pg_proc p,
      lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.proname in ('fn_create_share_link', 'fn_revoke_share_link', 'fn_open_share_link') and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
    expect(grants).toEqual([]);
  });
});

describe("clients see and confirm only their own deals (task 89a)", () => {
  let cw: string, dealA: string, dealB: string, runA: string, runB: string, artifactA: string;
  let dana: Session, erin: Session, frank: Session, gus: Session;
  const ids: Record<string, string> = {};
  const fields: [string, number, string?][] = [
    ["land_cost", 1_000_000], ["hard_cost", 0], ["soft_cost", 0], ["contingency", 0], ["construction_months", 0], ["lease_up_months", 0],
    ["hold_years", 1], ["stabilized_occupancy_pct", 100], ["expense_ratio_pct", 0], ["exit_cap_rate_pct", 10], ["selling_costs_pct", 0],
    ["senior_loan_amount", 0], ["unit_count", 10, "A"], ["unit_rent_monthly", 1_000, "A"],
  ];
  const review = async (s: Session, d: string) => (await call(s, "GET", `/api/deals/${d}/review`)).json;
  const stated = async (d: string) => (await review(alice, d)).assumptions.find((a: any) => a.sponsorStated && a.fieldKey === "exit_cap_rate_pct");
  const hash = async (d: string) => (await db.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [d]))[0]!.h;
  beforeAll(async () => {
    dana = await signup("dana.client@example.com", "Dana Client");
    erin = await signup("erin.client@example.com", "Erin Client");
    frank = await signup("frank.staff@example.com", "Frank Staff");
    gus = await signup("gus.stranger@example.com", "Gus Stranger");
    for (const [name, s] of [["dana", dana], ["erin", erin], ["frank", frank], ["gus", gus], ["alice", alice]] as const) ids[name] = (await call(s, "GET", "/api/me")).json.user.id;
    cw = (await call(alice, "POST", "/api/workspaces", { name: "Broker", reviewMode: "solo" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${cw}/members`, { email: "frank.staff@example.com", role: "analyst" })).status).toBe(200);
    for (const which of ["A", "B"]) {
      const d = (await call(alice, "POST", `/api/workspaces/${cw}/deals`, { name: `Client deal ${which}`, assetType: "Multifamily" })).json.id;
      for (const [fieldKey, value, itemKey] of fields) expect((await call(alice, "POST", `/api/deals/${d}/values`,
        { fieldKey, value, reason: "Client test value", ...(itemKey ? { itemKey } : {}) })).status, fieldKey).toBe(200);
      const made = await call(alice, "POST", `/api/deals/${d}/runs`);
      expect(made.status).toBe(200);
      expect((await call(alice, "POST", `/api/runs/${made.json.id}/decision`, { decision: "return_to_underwriting", rationale: "Client test decision" })).status).toBe(200);
      const artifact = await call(alice, "POST", `/api/runs/${made.json.id}/artifacts`, { kind: "model_export", format: "xlsx" });
      expect(artifact.status).toBe(200);
      if (which === "A") { dealA = d; runA = made.json.id; artifactA = artifact.json.id; } else { dealB = d; runB = made.json.id; }
    }
    await work();
    expect((await call(alice, "POST", `/api/artifacts/${artifactA}/share-links`, { term: "7d" })).status).toBe(200);
    expect((await call(alice, "POST", `/api/deals/${dealA}/clients`, { email: "dana.client@example.com" })).status).toBe(200);
    expect((await call(alice, "POST", `/api/deals/${dealB}/clients`, { email: "erin.client@example.com" })).status).toBe(200);
  }, 120_000);

  const DEAL_TABLES = ["documents", "candidates", "assumptions", "assumption_events", "runs", "decisions", "artifacts", "figure_labels", "label_suggestions", "share_links", "audit_events"];
  const counts = (user: string, deal: string) => asUser(db, user, async (tx) => {
    const out: Record<string, number> = {};
    out.deals = (await tx.query<{ n: number }>(`select count(*)::int as n from deals where id = $1`, [deal]))[0]!.n;
    for (const t of DEAL_TABLES) out[t] = (await tx.query<{ n: number }>(`select count(*)::int as n from ${t} where deal_id = $1`, [deal]))[0]!.n;
    for (const t of ["run_metrics", "run_gates", "run_checks"]) out[t] = (await tx.query<{ n: number }>(`select count(*)::int as n from ${t} x join runs r on r.id = x.run_id where r.deal_id = $1`, [deal]))[0]!.n;
    return out;
  });

  test("a client sees their deal and its rows, and nothing of another deal", async () => {
    const staff = await counts(ids.frank!, dealA);
    const mine = await counts(ids.dana!, dealA);
    for (const t of ["deals", "assumptions", "assumption_events", "runs", "decisions", "artifacts", "audit_events", "run_metrics", "run_gates", "run_checks"]) {
      expect(staff[t], t).toBeGreaterThan(0);
      expect(mine[t], t).toBe(staff[t]);
    }
    expect(staff.share_links).toBe(1);
    expect(mine.share_links).toBe(0);
    expect(Object.values(await counts(ids.dana!, dealB)).every((n) => n === 0)).toBe(true);
    expect(Object.values(await counts(ids.erin!, dealA)).every((n) => n === 0)).toBe(true);
    expect(Object.values(await counts(ids.gus!, dealA)).every((n) => n === 0)).toBe(true);
    expect((await call(dana, "GET", `/api/workspaces/${cw}/deals`)).json.map((d: any) => d.deal.id)).toEqual([dealA]);
    expect((await call(frank, "GET", `/api/workspaces/${cw}/deals`)).json.map((d: any) => d.deal.id).sort()).toEqual([dealA, dealB].sort());
    expect((await call(dana, "GET", `/api/deals/${dealB}`)).status).toBe(404);
  });

  test("a client sees the staff and themself, never another client or a workspace event", async () => {
    const people = await asUser(db, ids.dana!, (tx) => tx.query<{ user_id: string; role: string }>(`select user_id, role from workspace_members where workspace_id = $1 order by role`, [cw]));
    expect(people.map((p) => p.user_id).sort()).toEqual([ids.alice!, ids.frank!, ids.dana!].sort());
    const users = await asUser(db, ids.dana!, (tx) => tx.query<{ id: string }>(`select id from users where id = any($1::uuid[])`, [[ids.erin, ids.alice, ids.frank, ids.gus]]));
    expect(users.map((u) => u.id).sort()).toEqual([ids.alice!, ids.frank!].sort());
    const members = (await call(dana, "GET", `/api/workspaces/${cw}/members`)).json.map((m: any) => m.email);
    expect(members).not.toContain("erin.client@example.com");
    const staffSees = (await call(frank, "GET", `/api/workspaces/${cw}/members`)).json.map((m: any) => m.email);
    expect(staffSees).toEqual(expect.arrayContaining(["dana.client@example.com", "erin.client@example.com"]));
    const events = await asUser(db, ids.dana!, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from audit_events where workspace_id = $1 and deal_id is null`, [cw]));
    expect(events[0]!.n).toBe(0);
    expect((await asUser(db, ids.frank!, (tx) => tx.query<{ n: number }>(`select count(*)::int as n from audit_events where workspace_id = $1 and deal_id is null`, [cw])))[0]!.n).toBeGreaterThan(0);
  });

  test("a client is refused every change", async () => {
    const a = await stated(dealA);
    const refused: [string, string, unknown?][] = [
      ["POST", `/api/deals/${dealA}/values`, { fieldKey: "hold_years", value: 2, reason: "Client trying to edit" }],
      ["POST", `/api/assumptions/${a.id}/review`, { action: "modify", value: 9, reason: "Client trying to modify", version: a.version }],
      ["POST", `/api/deals/${dealA}/runs`],
      ["POST", `/api/runs/${runA}/artifacts`, { kind: "ic_memo", format: "pdf" }],
      ["POST", `/api/runs/${runA}/decision`, { decision: "reject", rationale: "Client trying to decide" }],
      ["POST", `/api/artifacts/${artifactA}/share-links`, { term: "7d" }],
      ["POST", `/api/deals/${dealA}/copy`, { name: "Client copy" }],
      ["POST", `/api/workspaces/${cw}/members`, { email: "gus.stranger@example.com", role: "viewer" }],
      ["POST", `/api/deals/${dealA}/clients`, { email: "gus.stranger@example.com" }],
      ["GET", `/api/deals/${dealA}/clients`],
    ];
    for (const [method, path, body] of refused) expect((await call(dana, method, path, body)).status, path).toBe(403);
    expect((await call(dana, "GET", `/api/deals/${dealA}/share-links`)).json).toEqual([]);
  });

  test("assigning a client: admin and up, an existing account, never a staff member", async () => {
    expect((await call(frank, "POST", `/api/deals/${dealA}/clients`, { email: "gus.stranger@example.com" })).status).toBe(403);
    expect((await call(alice, "POST", `/api/deals/${dealA}/clients`, { email: "frank.staff@example.com" })).status).toBe(422);
    expect((await call(alice, "POST", `/api/deals/${dealA}/clients`, { email: "nobody.here@example.com" })).status).toBe(404);
    expect((await call(alice, "POST", `/api/deals/${dealA}/clients`, { email: "dana.client@example.com" })).status).toBe(200);
    const list = (await call(alice, "GET", `/api/deals/${dealA}/clients`)).json;
    expect(list.map((c: any) => [c.name, c.email])).toEqual([["Dana Client", "dana.client@example.com"]]);
    await expect(asUser(db, ids.alice!, (tx) => tx.query(`select fn_add_member($1, $2, 'client')`, [cw, "gus.stranger@example.com"]))).rejects.toThrow(/A client is added to a deal/);
  });

  test("a client confirms a value the broker stated; the run goes out of date", async () => {
    const before = await hash(dealA);
    const a = await stated(dealA);
    expect((await call(dana, "POST", `/api/assumptions/${a.id}/client-confirm`, { version: a.version })).status).toBe(200);
    expect(await hash(dealA)).not.toBe(before);
    const after = await stated(dealA);
    expect(after).toMatchObject({ sponsorStated: true, clientConfirmedBy: "Dana Client" });
    expect(after.clientConfirmedAt).toEqual(expect.any(String));
    expect(after.clientConfirmedById).toBe((await call(dana, "GET", "/api/me")).json.user.id); // task 89c: "Confirmed by you"
    expect((await call(dana, "GET", `/api/runs/${runA}`)).json.fresh).toBe(false);
    expect((await call(dana, "POST", `/api/assumptions/${a.id}/client-confirm`, { version: after.version })).status).toBe(422);
    const other = (await review(alice, dealA)).assumptions.find((x: any) => !x.sponsorStated && x.status === "approved");
    expect((await call(dana, "POST", `/api/assumptions/${other.id}/client-confirm`, { version: other.version })).status).toBe(422);
    const b = await stated(dealB);
    expect((await call(dana, "POST", `/api/assumptions/${b.id}/client-confirm`, { version: b.version })).status).toBe(403);
    expect((await call(frank, "POST", `/api/assumptions/${b.id}/client-confirm`, { version: b.version })).status).toBe(403);
    const events = (await call(alice, "GET", `/api/deals/${dealA}/audit`)).json;
    expect(events.some((e: any) => e.action === "assumption.client_confirm")).toBe(true);
    // The new run records the client's confirmation; older snapshots have no such key.
    const rerun = await call(alice, "POST", `/api/deals/${dealA}/runs`);
    const snap = (await call(alice, "GET", `/api/runs/${rerun.json.id}`)).json.inputs.find((i: any) => i.fieldKey === "exit_cap_rate_pct");
    expect(snap).toMatchObject({ clientConfirmedBy: "Dana Client", clientConfirmedAt: expect.any(String) });
    expect((await call(alice, "GET", `/api/runs/${runB}`)).json.inputs.every((i: any) => !("clientConfirmedBy" in i))).toBe(true);
  });

  test("changing the value clears the client's confirmation; a reviewer's confirmation keeps it", async () => {
    let a = await stated(dealA);
    expect((await call(alice, "POST", `/api/assumptions/${a.id}/review`, { action: "modify", value: 9, reason: "The broker revised the cap rate", version: a.version })).status).toBe(200);
    a = await stated(dealA);
    expect(a.clientConfirmedBy ?? null).toBeNull();
    expect((await call(dana, "POST", `/api/assumptions/${a.id}/client-confirm`, { version: a.version })).status).toBe(200);
    a = (await review(alice, dealA)).assumptions.find((x: any) => x.id === a.id);
    expect((await call(frank, "POST", `/api/assumptions/${a.id}/review`, { action: "second_approve", version: a.version })).status).toBe(200);
    const done = (await review(alice, dealA)).assumptions.find((x: any) => x.id === a.id);
    expect(done).toMatchObject({ sponsorStated: false, secondApprover: "Frank Staff", clientConfirmedBy: "Dana Client" });
  });

  test("a deal without a client confirmation keeps the assumptions hash it had before 0018", async () => {
    const [{ h }] = await db.query<{ h: string }>(`select encode(sha256(convert_to(coalesce((
        select jsonb_agg(jsonb_build_array(field_key, item_key, status, value)
          || case when agir_sponsor_stated(a) then '["sponsor_stated"]'::jsonb else '[]'::jsonb end order by field_key, item_key)
        from assumptions a where deal_id = $1 and status in ('approved', 'default_accepted')
      ), '[]'::jsonb)::text, 'UTF8')), 'hex') as h`, [dealB]) as [{ h: string }];
    expect(await hash(dealB)).toBe(h);
    expect((await call(alice, "GET", `/api/runs/${runB}`)).json.fresh).toBe(true);
  });

  test("unassigning a client hides the deal again", async () => {
    expect((await call(alice, "DELETE", `/api/deals/${dealA}/clients/${ids.dana}`)).status).toBe(200);
    expect((await call(dana, "GET", `/api/workspaces/${cw}/deals`)).json).toEqual([]);
    expect(Object.values(await counts(ids.dana!, dealA)).every((n) => n === 0)).toBe(true);
    const events = (await call(alice, "GET", `/api/deals/${dealA}/audit`)).json.map((e: any) => e.action);
    expect(events).toEqual(expect.arrayContaining(["client.assigned", "client.unassigned"]));
  });
});

describe("invite links for clients (task 89b)", () => {
  let iw: string, dealX: string, hana: Session;
  const secrets: string[] = [];
  const errors = vi.spyOn(console, "error");
  const invite = async (s: Session = alice) => {
    const made = await call(s, "POST", `/api/deals/${dealX}/invites`);
    expect(made.status).toBe(200);
    const secret = (made.json.url as string).slice(3);
    secrets.push(secret);
    return { id: made.json.id as string, secret };
  };
  const join = (body: object) => app.request("/api/auth/signup", { method: "POST", headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ password: "correct horse battery", ...body }) });
  const gone = { error: "This invitation is not available. It may have been used, revoked or expired." };
  beforeAll(async () => {
    hana = await signup("hana.viewer@example.com", "Hana Viewer");
    iw = (await call(alice, "POST", "/api/workspaces", { name: "Invites", reviewMode: "solo" })).json.id;
    expect((await call(alice, "POST", `/api/workspaces/${iw}/members`, { email: "hana.viewer@example.com", role: "viewer" })).status).toBe(200);
    dealX = (await call(alice, "POST", `/api/workspaces/${iw}/deals`, { name: "Invite deal", assetType: "Multifamily" })).json.id;
  });

  test("an admin makes a link; it is shown once and listed without its secret", async () => {
    const made = await call(alice, "POST", `/api/deals/${dealX}/invites`);
    expect(made.status).toBe(200);
    expect(made.json.url).toMatch(/^\/i\/[A-Za-z0-9_-]{43}$/);
    secrets.push(made.json.url.slice(3));
    const list = await call(alice, "GET", `/api/deals/${dealX}/invites`);
    expect(list.json).toEqual([expect.objectContaining({ id: made.json.id, created_by: "Alice Analyst", used_at: null, used_by: null, revoked_at: null, expires_at: expect.any(String) })]);
    const text = JSON.stringify(list.json);
    expect(text).not.toContain(made.json.url.slice(3));
    expect(text).not.toContain(sha256(made.json.url.slice(3)));
    expect((await call(hana, "POST", `/api/deals/${dealX}/invites`)).status).toBe(403);
    expect((await call(hana, "GET", `/api/deals/${dealX}/invites`)).json).toEqual([]);
  });

  test("signed out, the link names the workspace and the deal", async () => {
    const { secret } = await invite();
    const page = await call(null, "GET", `/api/invite/${secret}`);
    expect(page.status).toBe(200);
    expect(page.json).toEqual({ workspace: "Invites", deal: "Invite deal" });
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("signing up through the link makes a client of that deal only, once", async () => {
    const { id, secret } = await invite();
    const res = await join({ email: "ida.client@example.com", name: "Ida Client", invite: secret });
    expect(res.status).toBe(200);
    const ida = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
    const me = (await call(ida, "GET", "/api/me")).json;
    expect(me.workspaces.map((w: any) => [w.name, w.role])).toEqual([["Invites", "client"]]);
    expect((await call(ida, "GET", `/api/workspaces/${iw}/deals`)).json.map((d: any) => d.deal.id)).toEqual([dealX]);
    expect((await call(alice, "GET", `/api/deals/${dealX}/invites`)).json.find((i: any) => i.id === id)).toMatchObject({ used_by: "Ida Client", used_at: expect.any(String) });
    expect((await call(null, "GET", `/api/invite/${secret}`))).toMatchObject({ status: 404, json: gone });
    const again = await join({ email: "ida.twice@example.com", name: "Ida Twice", invite: secret });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual(gone);
    expect(await db.query(`select 1 from users where email = 'ida.twice@example.com'`)).toEqual([]);
    expect((await call(ida, "POST", `/api/deals/${dealX}/invites`)).status).toBe(403);
  });

  test("a revoked or expired link is refused the same way, and a taken email leaves the link unused", async () => {
    const revoked = await invite();
    expect((await call(hana, "POST", `/api/invites/${revoked.id}/revoke`)).status).toBe(403);
    expect((await call(alice, "POST", `/api/invites/${revoked.id}/revoke`)).status).toBe(200);
    expect((await call(alice, "POST", `/api/invites/${revoked.id}/revoke`)).status).toBe(422);
    const expired = await invite();
    await db.query(`update client_invites set expires_at = now() - interval '1 minute' where id = $1`, [expired.id]);
    for (const { secret } of [revoked, expired]) {
      expect(await call(null, "GET", `/api/invite/${secret}`)).toMatchObject({ status: 404, json: gone });
      expect((await join({ email: `late.${secret.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, "x")}@example.com`, name: "Too Late", invite: secret })).status).toBe(404);
    }
    expect(await call(null, "GET", `/api/invite/not-a-real-secret`)).toMatchObject({ status: 404, json: gone });
    const fresh = await invite();
    expect((await join({ email: "alice@example.com", name: "Alice Again", invite: fresh.secret })).status).toBe(409);
    expect((await call(alice, "GET", `/api/deals/${dealX}/invites`)).json.find((i: any) => i.id === fresh.id).used_at).toBeNull();
  });

  test("a signed-in person accepts; a member of the workspace cannot", async () => {
    const jo = await signup("jo.existing@example.com", "Jo Existing");
    const { secret } = await invite();
    expect((await call(null, "POST", `/api/invite/${secret}/accept`)).status).toBe(401);
    expect((await call(jo, "POST", `/api/invite/${secret}/accept`)).status).toBe(200);
    const me = (await call(jo, "GET", "/api/me")).json;
    expect(me.workspaces.map((w: any) => [w.name, w.role])).toEqual(expect.arrayContaining([["Invites", "client"]]));
    expect(me.workspaces).toHaveLength(2);
    const staff = await invite();
    const refused = await call(hana, "POST", `/api/invite/${staff.secret}/accept`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("You are already a member of this workspace.");
    expect(await call(null, "GET", `/api/invite/${staff.secret}`)).toMatchObject({ status: 200 });
  });

  test("no secret or its hash reaches an audit payload or a log line", async () => {
    const actions = (await call(alice, "GET", `/api/deals/${dealX}/audit`)).json.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["invite.created", "invite.revoked", "invite.used"]));
    const payloads = (await db.query<{ p: string }>(`select payload::text as p from audit_events`)).map((r) => r.p).join("\n");
    const logs = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(secrets.length).toBeGreaterThan(5);
    for (const s of secrets) {
      expect(payloads).not.toContain(s);
      expect(payloads).not.toContain(sha256(s));
      expect(logs).not.toContain(s);
    }
  });
});

describe("the broker's logo (task 89d)", () => {
  const png = (w: number, h: number) => {
    const { deflateSync, crc32 } = zlib;
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.alloc((w * 3 + 1) * h))), chunk("IEND", Buffer.alloc(0))]));
  };
  // A JPEG's size is in its start-of-frame marker, after any other segment.
  const jpeg = (w: number, h: number, sof = true) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ...(sof ? [0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01] : []), 0xff, 0xd9]);
  const upload = (s: Session, bytes: Uint8Array) => call(s, "POST", `/api/workspaces/${ws}/logo`, undefined, bytes);
  const logoEvents = () => db.query<{ action: string; payload: any }>(`select action, payload from audit_events where workspace_id = $1 and action like 'logo.%' order by seq`, [ws]);
  const media = async (kind: string) => {
    const r = await call(alice, "POST", `/api/runs/${run}/artifacts`, { kind, format: "docx" });
    expect(r.status).toBe(200);
    await work();
    const file = await app.request(`/api/artifacts/${r.json.id}/file`, { headers: { cookie: alice.cookie } });
    expect(file.status).toBe(200);
    return Buffer.from(await file.arrayBuffer()).includes("word/media/");
  };

  test("refuses SVG, GIF, an oversized file, an unreadable size, and anyone but the owner", async () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`);
    expect((await upload(alice, svg)).status).toBe(415);
    expect((await upload(alice, new TextEncoder().encode("GIF89a\x01\x00\x01\x00"))).status).toBe(415);
    const big = new Uint8Array(500 * 1024 + 1); big.set(png(10, 10));
    expect((await upload(alice, big)).status).toBe(413);
    expect((await upload(alice, png(10, 10).slice(0, 12))).status).toBe(422);
    expect((await upload(alice, jpeg(10, 10, false))).status).toBe(422);
    expect((await upload(alice, png(0, 10))).status).toBe(422);
    expect((await upload(bob, png(10, 10))).status).toBe(403);
    expect((await upload(carol, png(10, 10))).status).toBe(403);
    const [w] = await db.query<{ logo_key: string | null }>(`select logo_key from workspaces where id = $1`, [ws]);
    expect(w!.logo_key).toBeNull();
    expect(await logoEvents()).toEqual([]);
  });

  test("the owner sets a JPEG, then a PNG; members read it, others do not; the audit has no storage key", async () => {
    const j = await upload(alice, jpeg(300, 100));
    expect(j.status).toBe(200);
    expect(j.json).toEqual({ mime: "image/jpeg", width: 300, height: 100 });
    const p = await upload(alice, png(120, 40));
    expect(p.json).toEqual({ mime: "image/png", width: 120, height: 40 });
    expect((await call(alice, "GET", "/api/me")).json.workspaces.find((x: any) => x.id === ws).has_logo).toBe(true);
    const got = await app.request(`/api/workspaces/${ws}/logo`, { headers: { cookie: bob.cookie } });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(png(120, 40)))).toBe(true);
    expect((await app.request(`/api/workspaces/${ws}/logo`, { headers: { cookie: carol.cookie } })).status).toBe(404);
    const [w] = await db.query<{ logo_key: string }>(`select logo_key from workspaces where id = $1`, [ws]);
    const events = await logoEvents();
    expect(events.map((e) => e.action)).toEqual(["logo.set", "logo.set"]);
    expect(events[1]!.payload).toEqual({ mime: "image/png", width: 120, height: 40 });
    expect(JSON.stringify(events)).not.toContain(w!.logo_key.slice(3, 20));
  });

  test("the Word lender package carries the logo; the IC memo does not", async () => {
    expect(await media("lender_package")).toBe(true);
    expect(await media("ic_memo")).toBe(false);
  }, 120_000);

  test("the owner removes it; then the lender package has no image", async () => {
    expect((await call(bob, "DELETE", `/api/workspaces/${ws}/logo`, {})).status).toBe(403);
    expect((await call(alice, "DELETE", `/api/workspaces/${ws}/logo`, {})).status).toBe(200);
    expect((await call(alice, "GET", "/api/me")).json.workspaces.find((x: any) => x.id === ws).has_logo).toBe(false);
    expect((await app.request(`/api/workspaces/${ws}/logo`, { headers: { cookie: alice.cookie } })).status).toBe(404);
    expect((await logoEvents()).map((e) => e.action)).toEqual(["logo.set", "logo.set", "logo.cleared"]);
    expect((await logoEvents()).at(-1)!.payload).toEqual({});
    expect(await media("lender_package")).toBe(false);
  }, 120_000);
});
