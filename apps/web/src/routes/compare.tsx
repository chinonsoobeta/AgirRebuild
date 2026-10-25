import { FIELD_BY_KEY, tableSourceLabel } from "@agir/contracts";
import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { api, type DealOverview, type Metric, type RunView } from "../api";
import { DealFrame, MetricValue, useDeal, useSession } from "../components/ui";
import { Notice } from "../components/kit";
import { useI18n, type I18n } from "../i18n";
import { layoutFor, useRun } from "./run";
import { policyName } from "../components/thresholds";

type Input = RunView["inputs"][number];
export type InputChange = { key: string; from: Input; to: Input };
export type MetricPair = { key: string; unit: string; from: Metric | null; to: Metric | null };
type Count = { passed: number; total: number };
type Fired = { fired: number; total: number };
export type RunDiff = {
  inputs: { changed: InputChange[]; added: Input[]; removed: Input[]; same: number };
  moved: MetricPair[];
  still: MetricPair[];
  gates: { from: Count; to: Count };
  checks: { from: Fired; to: Fired };
};

const inputKey = (x: Input) => `${x.fieldKey}|${x.itemKey ?? ""}`;
const sourceKey = (x: Input) => `${x.source}|${JSON.stringify(x.tableSource ?? null)}`;
// Equal, or apart only by the engine's floating-point noise (31,000,000 against 31,000,000.00000001): such a figure did not move.
const near = (x: number | null, y: number | null) => x === y || (x !== null && y !== null && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)));
const sameMetric = (a: Metric | null, b: Metric | null) => Boolean(a && b && a.status === b.status && near(a.value, b.value));
const gatesOf = (r: RunView): Count => ({ passed: r.result.verdict.gates.filter((g) => g.status === "passed").length, total: r.result.verdict.gates.length });
const checksOf = (r: RunView): Fired => ({ fired: r.result.checks.filter((c) => c.severity !== "pass").length, total: r.result.checks.length });

/** What differs between two recorded runs, read from what each one stored: nothing is recomputed. `to` is this run, `from` the one it is compared against. */
export function diffRuns(to: RunView, from: RunView): RunDiff {
  const before = new Map(from.inputs.map((x) => [inputKey(x), x]));
  const after = new Map(to.inputs.map((x) => [inputKey(x), x]));
  const changed: InputChange[] = [];
  let same = 0;
  for (const [key, x] of after) {
    const old = before.get(key);
    if (!old) continue;
    if (old.value !== x.value || sourceKey(old) !== sourceKey(x)) changed.push({ key, from: old, to: x });
    else same++;
  }
  const baseFrom = from.result.scenarios[0]?.metrics ?? [];
  const baseTo = to.result.scenarios[0]?.metrics ?? [];
  const headline = layoutFor(baseTo).headline;
  const keys = [...new Set([...headline.filter((k) => baseTo.some((m) => m.key === k) || baseFrom.some((m) => m.key === k)), ...baseTo.map((m) => m.key), ...baseFrom.map((m) => m.key)])];
  const pairs = keys.map((key): MetricPair => {
    const a = baseFrom.find((m) => m.key === key) ?? null;
    const b = baseTo.find((m) => m.key === key) ?? null;
    return { key, unit: (b ?? a)!.unit, from: a, to: b };
  });
  return {
    inputs: { changed, added: to.inputs.filter((x) => !before.has(inputKey(x))), removed: from.inputs.filter((x) => !after.has(inputKey(x))), same },
    moved: pairs.filter((p) => !sameMetric(p.from, p.to)),
    still: pairs.filter((p) => sameMetric(p.from, p.to)),
    gates: { from: gatesOf(from), to: gatesOf(to) },
    checks: { from: checksOf(from), to: checksOf(to) },
  };
}

const unitOf = (x: Input) => FIELD_BY_KEY.get(x.fieldKey)?.unit ?? "count";
const policyKey = (r: RunView) => `${r.policyVersion}|${JSON.stringify(r.policy ?? null)}`;

/** The sentence above the table, built only from the diff and the two runs' records. */
export function compareSummary(i: I18n, d: RunDiff, to: RunView, from: RunView): { title: string; body: string } {
  const { t, f, L } = i;
  const { changed, added, removed, same } = d.inputs;
  const n = changed.length + added.length + removed.length;
  const title = n === 0 ? t("compare.title.none") : n === 1 ? t("compare.title.one") : t("compare.title.many", { n });
  const parts: string[] = [];
  const only = changed[0];
  if (n === 1 && only) parts.push(t("compare.oneMoved", { label: L.field(only.to.fieldKey, only.to.itemKey), from: f.value(only.from.value, unitOf(only.from)), to: f.value(only.to.value, unitOf(only.to)) }));
  else if (n > 1) parts.push(t("compare.counts", { changed: changed.length, added: added.length, removed: removed.length }));
  if (same > 0) parts.push(t("compare.othersSame", { n: same, all: n === 0 }));
  const policySame = policyKey(from) === policyKey(to);
  if (policySame && from.engineVersion === to.engineVersion) parts.push(t("compare.bothSame"));
  if (!policySame) parts.push(t("compare.policyDiffers", { from: policyName(i, from.policyVersion), to: policyName(i, to.policyVersion) }));
  if (from.engineVersion !== to.engineVersion) parts.push(t("compare.engineDiffers", { from: from.engineVersion, to: to.engineVersion }));
  const va = from.result.verdict.code;
  const vb = to.result.verdict.code;
  parts.push(va === vb ? t("compare.verdictSame", { v: L.verdict(vb) }) : t("compare.verdictMoved", { from: L.verdict(va), to: L.verdict(vb) }));
  return { title, body: parts.join(" ") };
}

/** One cell of a value column: its printed text, or a stored metric printed by `MetricValue`, or absent from that run. */
type Cell = { text: string; metric?: Metric; absent?: true };
/** A row of the comparison table: a group heading, or a figure with both runs' values, the change and where it comes from. */
export type CompareRow =
  | { kind: "group"; label: string }
  | { kind: "row"; key: string; label: string; note?: string; source: string; showSource: boolean; a: Cell; b: Cell; change: string; numeric: boolean };

const sourceOf = (i: I18n, x: Input) => (x.tableSource ? tableSourceLabel(x.tableSource, i.lang) : i.msg(x.source));
const metricText = (i: I18n, m: Metric) => (m.status !== "VALID" || m.value === null ? i.t(m.status === "NOT_APPLICABLE" ? "common.notApplicable" : "common.notMeaningful") : i.f.value(m.value, m.unit));

/**
 * The comparison table's rows, built once for the screen and for the downloaded file. Every value is one a run or the API recorded;
 * the change column is the screen's existing one (an open decision for the owner), and the refinance loan's says only whether it moved.
 */
export function comparisonRows(i: I18n, d: RunDiff, to: RunView, from: RunView): CompareRow[] {
  const { t, f, L } = i;
  const absent: Cell = { text: t("compare.absent"), absent: true };
  const recorded = t("compare.csv.recorded", { a: from.number, b: to.number });
  const delta = (x: number, y: number, unit: string) =>
    x === y ? t("compare.same") : unit === "%" ? f.delta((y - x) * 100, "bps") : unit === "flag" ? t("compare.changed") : f.delta(y - x, unit);
  const shown = (text: string, same: boolean) => (same ? t("compare.same") : text);
  const inputRow = (key: string, x: Input | null, y: Input | null, source: string): CompareRow => {
    const z = (y ?? x)!;
    return { kind: "row", key, label: L.field(z.fieldKey, z.itemKey), source, showSource: true, numeric: true,
      a: x ? { text: f.value(x.value, unitOf(x)) } : absent, b: y ? { text: f.value(y.value, unitOf(y)) } : absent,
      change: x && y ? delta(x.value, y.value, unitOf(y)) : t("compare.changed") };
  };
  const metricRow = (p: MetricPair): CompareRow => {
    const numeric = p.from?.status === "VALID" && p.to?.status === "VALID" && p.from.value !== null && p.to.value !== null;
    return { kind: "row", key: p.key, label: L.metric(p.key), source: recorded, showSource: false, numeric: false,
      a: p.from ? { text: metricText(i, p.from), metric: p.from } : absent, b: p.to ? { text: metricText(i, p.to), metric: p.to } : absent,
      change: shown(numeric ? delta(p.from!.value!, p.to!.value!, p.unit) : t("compare.changed"), sameMetric(p.from, p.to)) };
  };
  const countRow = (key: string, label: string, x: string, y: string): CompareRow =>
    ({ kind: "row", key, label, source: recorded, showSource: false, numeric: true, a: { text: x }, b: { text: y }, change: shown(t("compare.changed"), x === y) });
  // The refinance loan, when both runs have it: worked out again from each run's recorded input by the engine that recorded it.
  const ra = from.refinance, rb = to.refinance;
  const refi = ra && rb ? {
    moved: !near(ra.loan, rb.loan),
    row: { kind: "row", key: "refinance_loan", label: t("compare.refinance"), showSource: false, numeric: true,
      note: rb.stated || rb.ltvPct === null ? t("compare.refinanceStated") : t("compare.refinanceLtv", { pct: f.value(rb.ltvPct, "%") }),
      source: t("compare.csv.refinance", { engine: to.engineVersion }),
      a: { text: f.value(ra.loan, "$") }, b: { text: f.value(rb.loan, "$") }, change: shown(t("compare.changed"), near(ra.loan, rb.loan)) } as CompareRow,
  } : null;
  // It follows the coverage after refinancing, as on the Run screen, or ends its group's figures.
  const withRefi = (pairs: MetricPair[], moved: boolean) => {
    const rows = pairs.map(metricRow);
    if (!refi || refi.moved !== moved) return rows;
    const at = pairs.findIndex((p) => p.key === "dcr_after_refinance");
    return at < 0 ? [...rows, refi.row] : [...rows.slice(0, at + 1), refi.row, ...rows.slice(at + 1)];
  };
  const gates = countRow("gates", t("compare.gates"), t("compare.ofTotal", { n: d.gates.from.passed, total: d.gates.from.total }), t("compare.ofTotal", { n: d.gates.to.passed, total: d.gates.to.total }));
  const checks = countRow("checks", t("compare.checks"), t("compare.ofTotal", { n: d.checks.from.fired, total: d.checks.from.total }), t("compare.ofTotal", { n: d.checks.to.fired, total: d.checks.to.total }));
  const verdict = countRow("verdict", t("compare.verdict"), L.verdict(from.result.verdict.code), L.verdict(to.result.verdict.code));
  const gatesSame = JSON.stringify(d.gates.from) === JSON.stringify(d.gates.to);
  const checksSame = JSON.stringify(d.checks.from) === JSON.stringify(d.checks.to);
  const verdictSame = from.result.verdict.code === to.result.verdict.code;
  const movedRows = [...withRefi(d.moved, true), ...(gatesSame ? [] : [gates]), ...(checksSame ? [] : [checks]), ...(verdictSame ? [] : [verdict])];
  const stillRows = [...withRefi(d.still, false), ...(gatesSame ? [gates] : []), ...(checksSame ? [checks] : []), ...(verdictSame ? [verdict] : [])];
  const group = (label: string): CompareRow => ({ kind: "group", label });
  const { changed, added, removed } = d.inputs;
  return [
    ...(changed.length ? [group(t("compare.group.changed"))] : []),
    ...changed.map((c) => inputRow(c.key, c.from, c.to, sourceKey(c.from) !== sourceKey(c.to) ? `${sourceOf(i, c.to)} · ${t("compare.was", { source: sourceOf(i, c.from) })}` : sourceOf(i, c.to))),
    ...(added.length ? [group(t("compare.group.added"))] : []),
    ...added.map((x) => inputRow(`+${inputKey(x)}`, null, x, sourceOf(i, x))),
    ...(removed.length ? [group(t("compare.group.removed"))] : []),
    ...removed.map((x) => inputRow(`-${inputKey(x)}`, x, null, sourceOf(i, x))),
    ...(movedRows.length ? [group(t("compare.group.moved")), ...movedRows] : []),
    ...(stillRows.length ? [group(t("compare.group.still")), ...stillRows] : []),
  ];
}

/** The footer sentence: every figure is as recorded, and the refinance loan, when shown, is named as the one worked out again. */
export const compareFoot = (i: I18n, rows: readonly CompareRow[]) => i.t(rows.some((r) => r.kind === "row" && r.key === "refinance_loan") ? "compare.footRefinance" : "compare.foot");

/** One CSV field, quoted when it needs to be; a cell that a spreadsheet would read as a formula starts with an apostrophe. */
const csvField = (value: string) => {
  const safe = /^[=@\t\r]/.test(value) || /^[+-](?![\d$])/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || /^\s|\s$/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const fileSafe = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "deal";

/** The comparison as a CSV file: the deal, the summary and footer sentences, then exactly the table's rows with a source for each. */
export function comparisonFile(i: I18n, deal: string, to: RunView, from: RunView, heads: [string, string]): { name: string; text: string } {
  const d = diffRuns(to, from);
  const rows = comparisonRows(i, d, to, from);
  const s = compareSummary(i, d, to, from);
  const line = (cells: string[]) => [...cells, "", "", "", "", ""].slice(0, 5).map(csvField).join(",");
  const lines = [
    line([deal]), line([`${s.title} ${s.body}`]), line([compareFoot(i, rows)]), line([]),
    line([i.t("compare.col.figure"), heads[0], heads[1], i.t("compare.col.change"), i.t("compare.col.source")]),
    ...rows.map((r) => (r.kind === "group" ? line([r.label]) : line([r.note ? `${r.label} (${r.note})` : r.label, r.a.text, r.b.text, r.change, r.source]))),
  ];
  return { name: `agir-comparison-${fileSafe(deal)}-run-${from.number}-run-${to.number}.csv`, text: `\uFEFF${lines.join("\r\n")}\r\n` };
}

/** Saves a text file built in the browser, then lets its URL go. */
export function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

type RunRow = { id: string; run_number: number; verdict_code: string; created_at: string };
/** A deal whose runs the pickers offer: this one, a deal copied from it, or the deal it was copied from. */
type Group = { id: string; name: string; kind: "this" | "variant" | "original"; runs: RunRow[] };
/** How many of each deal's newest runs the pickers mark current or out of date. */
const FRESH_PER_DEAL = 10;

export function Compare({ dealId, a, b, onPick }: { dealId: string; a?: string | undefined; b?: string | undefined; onPick?: (next: { a: string; b: string }) => void }) {
  const i = useI18n();
  const { t, f, L } = i;
  const deal = useDeal(dealId);
  const { workspaceId } = useSession();
  const runs = useQuery({ queryKey: ["runs", dealId], queryFn: () => api.get<RunRow[]>(`/deals/${dealId}/runs`) });
  const list = runs.data ?? [];
  // The other deals: those copied from this one that have run, then the one this deal was copied from.
  const deals = useQuery({ queryKey: ["deals", workspaceId], queryFn: () => api.get<DealOverview[]>(`/workspaces/${workspaceId}/deals`) });
  const copiedFrom = deal.data?.copiedFrom ?? null;
  const others: Omit<Group, "runs">[] = [
    ...(deals.data ?? []).filter((d) => d.run && d.deal.id !== dealId && d.copiedFrom?.id === dealId).map((d) => ({ id: d.deal.id, name: d.deal.name, kind: "variant" as const })),
    ...(copiedFrom && copiedFrom.id !== dealId ? [{ id: copiedFrom.id, name: copiedFrom.name, kind: "original" as const }] : []),
  ];
  const otherRuns = useQueries({ queries: others.map((d) => ({ queryKey: ["runs", d.id], queryFn: () => api.get<RunRow[]>(`/deals/${d.id}/runs`) })) });
  const groups: Group[] = [{ id: dealId, name: deal.data?.deal.name ?? "", kind: "this", runs: list }, ...others.map((d, k) => ({ ...d, runs: otherRuns[k]?.data ?? [] }))];
  const elsewhere = groups.slice(1).flatMap((g) => g.runs);
  // Current or out of date, from each listed run's own record; the newest few per deal only.
  const listed = groups.flatMap((g) => g.runs.slice(0, FRESH_PER_DEAL));
  const records = useQueries({ queries: listed.map((r) => ({ queryKey: ["run", r.id], queryFn: () => api.get<RunView>(`/runs/${r.id}`) })) });
  const freshOf = new Map(listed.map((r, k) => [r.id, records[k]?.data?.fresh]));
  // Default: the latest run against the one before it (the list is newest first); with one run here, against another deal's newest.
  const thisId = a ?? list[0]?.id;
  const againstId = b ?? list.find((r) => r.id !== thisId)?.id ?? elsewhere.find((r) => r.id !== thisId)?.id;
  const to = useRun(thisId);
  const from = useRun(againstId);
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const othersLoading = !deals.data || otherRuns.some((q) => !q.data);
  const head = (
    <div className="page-head compare-head">
      <div>
        <h2 className="h1">{t("compare.title")}</h2>
        <p className="lead">{t("compare.lead")}</p>
      </div>
    </div>
  );
  if (!runs.data || (list.length === 1 && othersLoading && elsewhere.length === 0)) return (<><DealFrame o={o} active="compare" /><div className="stack compare">{head}<p className="muted">{t("common.loading")}</p></div></>);
  // Comparing needs two runs of this deal, or one here and one of a variant or of the original.
  if (list.length === 0 || list.length + elsewhere.length < 2) {
    return (
      <>
        <DealFrame o={o} active="compare" />
        <div className="stack compare">
          {head}
          <Notice title={t("compare.needTwo")}>{t("compare.needTwoBody")}</Notice>
        </div>
      </>
    );
  }
  const option = (g: Group, r: RunRow) => {
    const p = { n: r.run_number, date: f.date(r.created_at), verdict: L.verdict(r.verdict_code), name: g.name };
    const label = g.kind === "this" ? t("compare.option", p) : t(g.kind === "variant" ? "compare.optionVariant" : "compare.optionOriginal", p);
    const fresh = freshOf.get(r.id);
    return <option key={r.id} value={r.id}>{fresh === undefined ? label : t("compare.withState", { label, state: t(fresh ? "compare.current" : "compare.outOfDate") })}</option>;
  };
  const groupLabel = (g: Group) => (g.kind === "this" ? t("compare.groupThis", { name: g.name }) : t(g.kind === "variant" ? "compare.groupVariant" : "compare.groupOriginal", { name: g.name }));
  const options = groups.filter((g) => g.runs.length > 0).map((g) => <optgroup key={g.id} label={groupLabel(g)}>{g.runs.map((r) => option(g, r))}</optgroup>);
  const pick = (
    <div className="card card-pad pick">
      <div className="field">
        <label htmlFor="compare-a">{t("compare.this")}</label>
        <select id="compare-a" className="select" value={thisId} onChange={(e) => onPick?.({ a: e.target.value, b: againstId! })}>{options}</select>
      </div>
      <span className="muted compare-against" aria-hidden="true">{t("compare.against")}</span>
      <div className="field">
        <label htmlFor="compare-b" className="sr-only">{t("compare.againstLabel")}</label>
        <select id="compare-b" className="select" value={againstId} onChange={(e) => onPick?.({ a: thisId!, b: e.target.value })}>{options}</select>
      </div>
    </div>
  );
  const body = (): ReactNode => {
    if (thisId === againstId) return <Notice tone="review">{t("compare.sameRun")}</Notice>;
    if (!to.data || !from.data) return <p className="muted">{t("run.loading")}</p>;
    const vb = to.data;
    const va = from.data;
    const d = diffRuns(vb, va);
    const s = compareSummary(i, d, vb, va);
    const absent = <span className="muted">{t("compare.absent")}</span>;
    // Across two deals, each column head and the out-of-date notice name the run's deal.
    const across = va.dealId !== vb.dealId;
    const nameOf = (r: RunView) => groups.find((g) => g.id === r.dealId)?.name;
    const colHead = (r: RunView) => {
      const name = across ? nameOf(r) : undefined;
      return name === undefined ? t("compare.col.run", { n: r.number, date: f.date(r.createdAt) }) : t("compare.col.runOf", { name, n: r.number, date: f.date(r.createdAt) });
    };
    const staleRun = !va.fresh ? va : !vb.fresh ? vb : null;
    const staleName = staleRun && across ? nameOf(staleRun) : undefined;
    const stale = !va.fresh && !vb.fresh ? t("compare.staleBoth")
      : staleRun ? (staleName === undefined ? t("compare.staleOne", { n: staleRun.number }) : t("compare.staleOneOf", { n: staleRun.number, name: staleName })) : null;
    const rows = comparisonRows(i, d, vb, va);
    const heads: [string, string] = [colHead(va), colHead(vb)];
    const cell = (c: Cell, numeric: boolean) => (c.absent ? <td className="r">{absent}</td>
      : c.metric ? <td className="r"><MetricValue {...c.metric} /></td> : <td className={numeric ? "num r" : "r"}>{c.text}</td>);
    return (
      <>
        {stale && <Notice tone="review" title={stale}>{t(!va.fresh && !vb.fresh ? "compare.staleBothBody" : "compare.staleOneBody")}</Notice>}
        <Notice tone="accent" title={s.title} role="status">{s.body}</Notice>
        <div className="card scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("compare.col.figure")}</th>
                <th scope="col" className="r">{heads[0]}</th>
                <th scope="col" className="r">{heads[1]}</th>
                <th scope="col" className="r">{t("compare.col.change")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => r.kind === "group"
                ? <tr key={`group:${r.label}`} className="compare-group"><th colSpan={4} scope="colgroup">{r.label}</th></tr>
                : (
                  <tr key={r.key}>
                    <td>{r.label}{(r.note ?? (r.showSource ? r.source : undefined)) !== undefined && <span className="sub">{r.note ?? r.source}</span>}</td>
                    {cell(r.a, r.numeric)}
                    {cell(r.b, r.numeric)}
                    <td className="r"><span className="delta same">{r.change}</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="card-foot row between">
            <span className="small muted">{compareFoot(i, rows)}</span>
            <div className="row">
              {/* Each run opens at its own address on its own deal's Run page; another deal's run is named after that deal. */}
              {[vb, va].map((r) => {
                const other = r.dealId !== dealId ? nameOf(r) : undefined;
                return (
                  <Link key={r.id} to="/deals/$dealId/run" params={{ dealId: r.dealId }} search={{ run: r.id }} className="btn quiet sm">
                    {other === undefined ? t("compare.open", { n: r.number }) : t("compare.openOf", { n: r.number, name: other })}
                  </Link>
                );
              })}
              <button type="button" className="btn ghost sm" onClick={() => { const file = comparisonFile(i, o.deal.name, vb, va, heads); saveFile(file.name, file.text); }}>
                {t("compare.download")}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  };
  return (
    <>
      <DealFrame o={o} active="compare" />
      <div className="stack compare">
        {head}
        {pick}
        {body()}
      </div>
    </>
  );
}
