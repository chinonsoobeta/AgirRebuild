import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import Anthropic from "@anthropic-ai/sdk";
import { drain, reconcileDeal, type SuggestRequest, type SuggestReply } from "@agir/worker";
import { documentBytes, loadOracle } from "@agir/testkit";
import { createApp } from "../src/app.ts";
import { POLICY_V1, RENTAL_HOLD_V1_DRAFT } from "@agir/contracts";
import { canonicalJson } from "@agir/engine";
import { sha256, sourceLabel } from "../src/services.ts";

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
    expect(view).toMatchObject({ policyVersion: "rental-hold-v1-draft", fresh: true, staleReasons: [] });
    expect(view.result.verdict.gates).toHaveLength(4);
    expect(view.result.scenarios[0].metrics.some((m: any) => m.key === "refinance_cash_returned")).toBe(true);
    const [row] = await db.query<any>(`select policy_version, policy_hash from runs where id = $1`, [holdRun]);
    expect(row).toMatchObject({ policy_version: "rental-hold-v1-draft", policy_hash: sha(RENTAL_HOLD_V1_DRAFT) });
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
    expect(e.policyVersion).toBe("rental-hold-v1-draft");
    expect(e.verdict.gates).toHaveLength(4);
    const b = await call(hal, "POST", `/api/runs/${holdRun}/breakeven`, {});
    expect(b.status).toBe(200);
  });

  test("the catalog exposes the registry so the web can label a draft policy", async () => {
    const cat = (await call(hal, "GET", "/api/catalog")).json;
    expect(cat.policy.version).toBe("policy-v1");
    expect(cat.policies["policy-v1"].draft).toBeUndefined();
    expect(cat.policies["rental-hold-v1-draft"].draft).toBe(true);
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
    expect(Object.keys(snap).sort()).toEqual(["assumptions", "input", "notFound"]);
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
  let vw: string, src: string, copyA: string, copyB: string, dan: Session, quin: Session, qw: string;
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
    expect((await call(alice, "POST", `/api/workspaces/${vw}/members`, { email: "carol@example.com", role: "viewer" })).status).toBe(200);
    dan = await signup("dan@example.com", "Dan Outsider");
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
    expect((await copyOf(carol, src, "Nope")).status).toBe(403);
    expect((await copyOf(dan, src, "Nope")).status).toBe(404);
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
    quin = await signup("quin@example.com", "Quin Builder", "solo");
    qw = (await call(quin, "GET", "/api/me")).json.workspaces[0].id;
    const d = (await call(quin, "POST", `/api/workspaces/${qw}/deals`, { name: "Quick Fourplex", assetType: "Multifamily", location: "Halifax", province: "NS" })).json.id;
    for (const [f, v, i] of [["land_cost", 800000], ["hard_cost", 2400000], ["soft_cost", 300000], ["contingency", 120000], ["construction_months", 12], ["lease_up_months", 6],
      ["unit_count", 4, "Residential"], ["unit_rent_monthly", 2400, "Residential"], ["stabilized_occupancy_pct", 95], ["exit_cap_rate_pct", 5.5], ["senior_loan_amount", 2000000],
      ["senior_rate_pct", 6], ["senior_amort_years", 30]] as [string, number, string?][]) {
      expect((await call(quin, "POST", `/api/deals/${d}/values`, { fieldKey: f, value: v, reason: "Quick start answer", ...(i ? { itemKey: i } : {}) })).status, f).toBe(200);
    }
    expect((await call(quin, "POST", `/api/deals/${d}/defaults`, { fields: ["hold_years", "selling_costs_pct", "expense_ratio_pct"] })).status).toBe(200);
    const c = await call(quin, "POST", `/api/deals/${d}/copy`, { name: "Quick Fourplex, kept" });
    expect(c.status).toBe(200);
    expect(await hashOf(c.json.id)).toBe(await hashOf(d));
    expect(await stored(c.json.id)).toEqual(await stored(d));
    expect(await db.query(`select 1 from documents where deal_id = $1`, [c.json.id])).toHaveLength(0);
    expect(await reconciled(c.json.id)).toMatchObject({ changed: 0 });
    expect(await stored(c.json.id)).toEqual(await stored(d));
    const [a, b] = [await call(quin, "POST", `/api/deals/${d}/runs`), await call(quin, "POST", `/api/deals/${c.json.id}/runs`)];
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await runRow(b.json.id)).toEqual(await runRow(a.json.id));
  });
});
