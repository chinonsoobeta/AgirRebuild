import { beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, migrate, openPglite, type Db } from "@agir/db";
import { drain } from "@agir/worker";
import { documentBytes, loadOracle } from "@agir/testkit";
import { createApp } from "../src/app.ts";
import { sourceLabel } from "../src/services.ts";

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
async function signup(email: string, name: string): Promise<Session> {
  const res = await app.request("/api/auth/signup", {
    method: "POST",
    headers: { "x-agir": "1", "content-type": "application/json" },
    body: JSON.stringify({ email, name, password: "correct horse battery" }),
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
    expect(view.result.verdict.code).toBe("APPROVE_WITH_CONDITIONS");
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
    const ok = await call(bob, "POST", `/api/runs/${run}/decision`, { decision: "approve_with_conditions", rationale: "Strong location and sponsor", conditions: "Lender to confirm a 25-year amortization before close" });
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

  test("the audit package validates itself, including an exact replay of the run", async () => {
    const pkg = (await call(alice, "GET", `/api/runs/${run}/audit-package`)).json;
    expect(pkg.validation.status).toBe("passed");
    expect(pkg.validation.checks.map((c: any) => c.name)).toEqual(["input_hash", "result_hash", "signature", "replay", "decisions_bound", "audit_chain"]);
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
