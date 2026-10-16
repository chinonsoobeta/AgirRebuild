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
