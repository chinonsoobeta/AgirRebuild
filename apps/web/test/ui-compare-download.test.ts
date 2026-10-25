/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import type { RunView } from "../src/api";
import { Compare, comparisonFile, comparisonRows, diffRuns, saveFile } from "../src/routes/compare.tsx";
import { RefinanceTrace, Run } from "../src/routes/run.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card R3: download a comparison, the refinance loan on Run and Compare. Mocks follow ui-compare-2 and ui-run-2.
const state = vi.hoisted(() => ({ lang: "en" as Lang, runsOf: {} as Record<string, unknown>, byId: {} as Record<string, unknown> }));
const lookup = (queryKey: unknown[]) => {
  const [key, id] = queryKey as [string, string];
  if (key === "deals") return { data: [] };
  if (key === "runs") return { data: state.runsOf[id] };
  if (key === "run") return { data: state.byId[id] };
  return {};
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => lookup(options.queryKey),
  useQueries: (options: { queries: { queryKey: unknown[] }[] }) => options.queries.map((q) => lookup(q.queryKey)),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { deal: { id: "d1", name: "Tamarack Six" }, copiedFrom: null, run: { id: "r2", number: 2 }, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: "owner", workspaceId: "ws", me: { user: { id: "u", email: "u@example.test", name: "Invented starter" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, className }: { children: unknown; className?: string }) => createElement("a", { className }, children as string) };
});

const decode = (s: string) => s.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
/** The table's body rows as cell texts; the first cell split into its label and its sub-line. */
function tableRows(html: string) {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map(([, row]) => {
    const cells = [...row!.matchAll(/<t[hd][^>]*>(.*?)<\/t[hd]>/g)].map((c) => c[1]!);
    const first = cells[0]!;
    const sub = first.match(/<span class="sub">(.*)<\/span>/)?.[1];
    return { label: text(sub === undefined ? first : first.slice(0, first.indexOf('<span class="sub">'))), sub: sub === undefined ? undefined : text(sub), cells: cells.slice(1).map(text) };
  });
}
/** A small CSV reader: quoted fields, doubled quotes, CRLF lines. */
function parseCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let k = 0; k < csv.length; k++) {
    const c = csv[k]!;
    if (quoted) {
      if (c === '"' && csv[k + 1] === '"') { field += '"'; k++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r" && csv[k + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; k++; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const metric = (key: string, value: number, unit = "$") => ({ key, label: key, unit, value, status: "VALID", formula: "" });
const refi = (loan: number, extra: Partial<NonNullable<RunView["refinance"]>> = {}) => ({ loan, value: loan / 0.65, month: 12, ltvPct: 65, stated: false, ...extra });
const compareView = (id: string, number: number, tax: number, dcr: number, loan: number | null, extra: Partial<RunView> = {}): RunView => ({
  id, dealId: "d1", number, createdAt: `2026-10-2${number}T12:00:00Z`, createdBy: "Morgan Owner", engineVersion: "2.3.0", policyVersion: "rental-v1", policyDraft: false,
  inputHash: "i", resultHash: "r", signed: "development key", fresh: true, staleReasons: [], isLatest: number === 2,
  result: {
    scenarios: [{ key: "base", label: "Base", metrics: [metric("stabilized_noi", 115_020 - tax), metric("dcr_after_refinance", dcr, "x"), metric("refinance_cash_returned", 259_327 - tax),
      metric("stated_value", 2_000_000), metric("total_development_cost", 1_667_571)] }],
    verdict: { code: "APPROVE", headline: "", explanation: "", hardFailReasons: [], gates: [] },
    checks: [], annual: [], warnings: [],
  },
  inputs: [{ fieldKey: "property_tax_annual", itemKey: null, label: "Property tax", value: tax, sourceKind: "document", source: number === 2 ? "assessment notice, \"2026\".pdf, page 1" : "budget.pdf, page 2",
    sponsorStated: false, confirmedBy: null, confirmedByReview: false, confirmedAt: null }],
  decisions: [],
  ...(loan === null ? {} : { refinance: refi(loan) }),
  ...extra,
});
const runRow = (r: RunView) => ({ id: r.id, run_number: r.number, verdict_code: "APPROVE", created_at: r.createdAt, created_by: "Morgan Owner" });
const setRuns = (...views: RunView[]) => {
  state.runsOf = { d1: views.map(runRow) };
  state.byId = Object.fromEntries(views.map((v) => [v.id, v]));
};
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => decode(renderToStaticMarkup(el));

beforeEach(() => {
  state.lang = "en";
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("the refinance loan on Compare", () => {
  it("puts the loan in what it moved, after the coverage after refinancing, with how it was sized", () => {
    const one = compareView("r1", 1, 7200, 1.35, 1_359_327), two = compareView("r2", 2, 8000, 1.34, 1_349_873);
    setRuns(two, one);
    const rows = tableRows(render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" })));
    const labels = rows.map((r) => r.label);
    const at = labels.indexOf("Refinance loan");
    expect(at).toBeGreaterThan(labels.indexOf("What it moved"));
    expect(labels[at - 1]).toBe("Coverage after refinancing");
    const en = build("en", () => {});
    expect(rows[at]!.sub).toBe(`${en.f.value(65, "%")} of the stabilized value`);
    // The change column says that it moved; the screen does not subtract the two loans.
    expect(rows[at]!.cells).toEqual(["$1,359,327", "$1,349,873", "changed"]);
  });

  it("puts an unchanged loan under what did not move, says As stated for a stated amount, and leaves it out when a run has none", () => {
    const stated = { refinance: refi(1_500_000, { ltvPct: null, stated: true }) };
    setRuns(compareView("r2", 2, 8000, 1.34, null, stated), compareView("r1", 1, 7200, 1.34, null, stated));
    let rows = tableRows(render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" })));
    const at = rows.findIndex((r) => r.label === "Refinance loan");
    expect(at).toBeGreaterThan(rows.findIndex((r) => r.label === "What did not move"));
    expect(rows[at]).toMatchObject({ sub: "As stated", cells: ["$1,500,000", "$1,500,000", "same"] });
    setRuns(compareView("r2", 2, 8000, 1.34, 1_349_873), compareView("r1", 1, 7200, 1.35, null));
    const html = render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" }));
    rows = tableRows(html);
    expect(rows.some((r) => r.label === "Refinance loan")).toBe(false);
    // Without the loan, nothing on the screen is worked out again, and the footer says so as before.
    expect(text(html)).toContain("Figures are as each run recorded them. Nothing here is recomputed.");
  });

  it("names the refinance loan as the one figure worked out again, in the footer", () => {
    setRuns(compareView("r2", 2, 8000, 1.34, 1_349_873), compareView("r1", 1, 7200, 1.35, 1_359_327));
    const t = text(render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" })));
    expect(t).not.toContain("Nothing here is recomputed");
    expect(t).toContain("Figures are as each run recorded them, except the refinance loan");
  });
});

describe("downloading a comparison", () => {
  const one = compareView("r1", 1, 7200, 1.35, 1_359_327), two = compareView("r2", 2, 8000, 1.34, 1_349_873);
  const heads = (i: ReturnType<typeof build>): [string, string] => [i.t("compare.col.run", { n: 1, date: i.f.date(one.createdAt) }), i.t("compare.col.run", { n: 2, date: i.f.date(two.createdAt) })];

  it("offers a download beside the links that open each run", () => {
    setRuns(two, one);
    const html = render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" }));
    const foot = html.slice(html.indexOf('class="card-foot'));
    expect(foot).toMatch(/<button type="button" class="btn ghost sm"[^>]*>Download this comparison<\/button>/);
    expect(text(foot)).toContain("Open run 2");
  });

  it("writes exactly the table's rows, each figure as the screen prints it, with its source", () => {
    setRuns(two, one);
    const html = render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" }));
    const table = tableRows(html);
    const en = build("en", () => {});
    const file = comparisonFile(en, "Tamarack Six", two, one, heads(en));
    expect(file.text.startsWith("﻿")).toBe(true);
    const csv = parseCsv(file.text.slice(1));
    // The deal, the summary sentence, the footer sentence, a blank line, then the header.
    expect(csv[0]![0]).toBe("Tamarack Six");
    const summary = text(html.slice(html.indexOf('role="status"'))).split(" Figure ")[0]!;
    expect(summary).toContain(csv[1]![0]!);
    expect(csv[1]![0]).toMatch(/^One input changed between these runs\. Property tax \(per year\) went from \$7,200 to \$8,000\./);
    expect(csv[2]![0]).toBe(en.t("compare.footRefinance"));
    expect(text(html)).toContain(csv[2]![0]!);
    expect(csv[3]!.every((c) => c === "")).toBe(true);
    expect(csv[4]).toEqual(["Figure", ...heads(en), "Change", "Source"]);
    const data = csv.slice(5);
    expect(data).toHaveLength(table.length);
    data.forEach((row, n) => {
      const shown = table[n]!;
      expect(row).toHaveLength(5);
      if (shown.cells.length === 0) { expect(row).toEqual([shown.label, "", "", "", ""]); return; }
      expect(row[0]).toBe(shown.label === "Refinance loan" ? `${shown.label} (${shown.sub})` : shown.label);
      expect(row.slice(1, 4)).toEqual(shown.cells);
    });
    const tax = data.find((r) => r[0] === "Property tax (per year)")!;
    expect(tax[4]).toBe(table.find((r) => r.label === "Property tax (per year)")!.sub);
    expect(tax[4]).toContain('assessment notice, "2026".pdf, page 1');
    expect(data.find((r) => r[0] === "Stabilized net operating income" || r[0] === "Net operating income")![4]).toBe("Run 1 and run 2, recorded");
    expect(data.find((r) => r[0]!.startsWith("Refinance loan"))![4]).toBe("Worked out by engine 2.3.0 from each run's recorded inputs; not stored with the runs");
  });

  it("quotes values as CSV needs and keeps a cell from starting a formula", () => {
    const en = build("en", () => {});
    const file = comparisonFile(en, "=Tamarack, \"Six\"", two, one, heads(en));
    const lines = file.text.slice(1).split("\r\n");
    expect(lines[0]).toBe(`"'=Tamarack, ""Six"""`.concat(",,,,"));
    expect(lines.some((l) => l.includes(`"Before: budget.pdf, page 2"`) || l.includes(`"assessment notice, ""2026"".pdf, page 1`))).toBe(true);
    expect(file.text.endsWith("\r\n")).toBe(true);
  });

  it("names the file after the deal and the two runs", () => {
    const en = build("en", () => {});
    expect(comparisonFile(en, "Tamarack Six", two, one, heads(en)).name).toBe("agir-comparison-tamarack-six-run-1-run-2.csv");
    expect(comparisonFile(en, "Les Érables / phase 2: «nord»", two, one, heads(en)).name).toBe("agir-comparison-les-erables-phase-2-nord-run-1-run-2.csv");
    expect(comparisonFile(en, "???", two, one, heads(en)).name).toBe("agir-comparison-deal-run-1-run-2.csv");
  });

  it("writes the French file in French", () => {
    state.lang = "fr";
    setRuns(two, one);
    const html = render(createElement(Compare, { dealId: "d1", a: "r2", b: "r1" }));
    const table = tableRows(html);
    const fr = build("fr", () => {});
    const csv = parseCsv(comparisonFile(fr, "Tamarack Six", two, one, heads(fr)).text.slice(1));
    expect(csv[1]![0]).toMatch(/^Une donnée a changé entre ces analyses\./);
    expect(csv[4]).toEqual(["Chiffre", ...heads(fr), "Écart", "Source"]);
    const data = csv.slice(5);
    expect(data.map((r) => (r[0]!.startsWith("Prêt de refinancement") ? "Prêt de refinancement" : r[0]))).toEqual(table.map((r) => r.label));
    // The file keeps the screen's no-break spaces; the table text here has them folded into plain spaces.
    const loan = data.find((r) => r[0]!.startsWith("Prêt de refinancement"))![1]!;
    expect(loan).toContain("\u00a0$");
    expect(loan.replace(/\s/g, " ")).toBe(table.find((r) => r.label === "Prêt de refinancement")!.cells[0]);
    expect(data.find((r) => r[0] === "Ce que ça a fait bouger")).toBeTruthy();
  });

  it("matches comparisonRows, the rows the table is built from", () => {
    const en = build("en", () => {});
    const rows = comparisonRows(en, diffRuns(two, one), two, one);
    const csv = parseCsv(comparisonFile(en, "Tamarack Six", two, one, heads(en)).text.slice(1)).slice(5);
    expect(csv.map((r) => r[0])).toEqual(rows.map((r) => (r.kind === "group" ? r.label : r.note ? `${r.label} (${r.note})` : r.label)));
  });

  it("saves the file from a blob URL and then lets the URL go", async () => {
    const made: Blob[] = [];
    const revoked: string[] = [];
    const clicked: { href: string; download: string }[] = [];
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => { made.push(b); return "blob:invented"; }, revokeObjectURL: (u: string) => revoked.push(u) });
    const anchor = { href: "", download: "", click() { clicked.push({ href: this.href, download: this.download }); }, remove: () => {} };
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: () => {} } });
    saveFile("agir-comparison-x-run-1-run-2.csv", "﻿a,b\r\n");
    await new Promise((r) => setTimeout(r, 0));
    expect(clicked).toEqual([{ href: "blob:invented", download: "agir-comparison-x-run-1-run-2.csv" }]);
    expect(made[0]!.type).toBe("text/csv;charset=utf-8");
    expect(new Uint8Array(await made[0]!.arrayBuffer()).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    expect(revoked).toEqual(["blob:invented"]);
  });
});

describe("the refinance loan on Run", () => {
  const heldInput: EngineInput = { ...developmentDeal(), exit: "refinance_hold", refinance: { month: 36, ltvPct: 65, ratePct: 5, amortYears: 30, ioMonths: 0 } };
  const held = underwrite(heldInput, policyFor(heldInput));
  const runView = (refinance?: RunView["refinance"]) => ({ id: "r2", number: 2, result: held, fresh: true, staleReasons: [], inputs: [], isLatest: true,
    policyVersion: "invented-policy", policyDraft: true, engineVersion: "invented-engine", createdAt: "2026-10-24T15:58:00Z", createdBy: "Invented author",
    inputHash: "a".repeat(64), resultHash: "b".repeat(64), signed: "development key", decisions: [], ...(refinance ? { refinance } : {}) });
  const figures = (html: string) => {
    const dl = html.slice(html.indexOf('<dl class="figs">'), html.indexOf("</dl>", html.indexOf('<dl class="figs">')));
    return [...dl.matchAll(/<div class="fig">(.*?)<\/div>/g)].map((m) => text(m[1]!));
  };
  const show = (refinance?: RunView["refinance"]) => {
    state.runsOf = { d1: [] };
    state.byId = { r2: runView(refinance) };
    return figures(render(createElement(Run, { dealId: "d1" })));
  };

  it("shows the loan after the coverage after refinancing, with its loan-to-value, value and month", () => {
    const figs = show({ loan: 1_349_873, value: 2_076_727, month: 12, ltvPct: 65, stated: false });
    const at = figs.findIndex((f) => f.startsWith("Refinance loan"));
    expect(figs[at - 1]).toMatch(/^Coverage after refinancing/);
    expect(figs[at + 1]).toMatch(/^Cash returned at refinancing/);
    const en = build("en", () => {});
    expect(figs[at]).toBe(`Refinance loan $1,349,873 ${en.f.value(65, "%")} of a $2,076,727 value at month 12`);
  });

  it("says As stated when the amount was given, and shows no loan for a run without one", () => {
    expect(show({ loan: 1_500_000, value: 2_076_727, month: 12, ltvPct: null, stated: true })).toContain("Refinance loan $1,500,000 As stated, against a $2,076,727 value at month 12");
    expect(show().some((f) => f.startsWith("Refinance loan"))).toBe(false);
  });

  it("explains how the engine sized it, and that it is worked out again, not stored", () => {
    const t = text(render(createElement(RefinanceTrace, { refinance: { loan: 1_349_873, value: 2_076_727, month: 12, ltvPct: 65, stated: false }, engine: "2.3.0" })));
    expect(t).toContain("next 12 months' net operating income over the exit cap rate");
    expect(t).toContain("$2,076,727 at month 12");
    expect(t).toContain("by the same engine version (2.3.0)");
    expect(t).toContain("not stored with the run");
    state.lang = "fr";
    const f = text(render(createElement(RefinanceTrace, { refinance: { loan: 1_500_000, value: 2_076_727, month: 12, ltvPct: null, stated: true }, engine: "2.3.0" })));
    expect(f).toContain("Le prêt est le montant indiqué");
    expect(f).toContain("n'est pas conservé avec l'analyse");
  });
});
