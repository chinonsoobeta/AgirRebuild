import { isSigned, stressLabel, tableSourceLabel, tableStaleWarning, pbrhExplanation } from "@agir/contracts";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import { Figure, Figures, Notice } from "../components/kit";
import { FIELD_BY_KEY } from "@agir/contracts";
import { api, type Metric, type Review, type RunLine, type RunProgress, type RunStage, type RunView } from "../api";
import { Banner, canEdit, DealFrame, ErrorText, Glossary, MetricValue, StatusTag, useDeal, useSession, VerdictBadge } from "../components/ui";
import { policyName, StandardVerdict } from "../components/thresholds";
import * as I from "../components/icons";
import { checkText, dealStatus, useI18n, verdictText } from "../i18n";
import "../strings/run";

export const HEADLINE = [
  "total_development_cost", "capitalized_interest", "stabilized_noi", "yield_on_cost", "development_spread", "exit_value", "development_profit",
  "profit_on_cost", "loan_to_cost", "required_equity", "debt_yield", "sizing_dscr", "contractual_dscr", "equity_multiple", "equity_irr", "cost_per_unit",
];

/** A deal that is kept and refinanced leads with its hold measures; the sale figures are not applicable. */
const HELD_HEADLINE = [
  "total_development_cost", "capitalized_interest", "stabilized_noi", "yield_on_cost", "development_spread", "refinance_cash_returned", "cash_left_in_deal",
  "dcr_after_refinance", "cash_on_cash_after_refinance", "stated_value", "unrealized_equity_multiple", "unrealized_equity_irr",
  "loan_to_cost", "required_equity", "debt_yield", "sizing_dscr", "contractual_dscr", "cost_per_unit",
];

const SALE_HEADLINE = [
  "total_development_cost", "interest_before_completion", "gross_sales_revenue", "net_sales_revenue", "carry_total", "interest_after_completion",
  "development_profit_for_sale", "profit_on_cost_for_sale", "margin_on_revenue", "loan_to_cost", "required_equity", "peak_equity", "equity_multiple",
  "equity_irr", "deposits_held_at_completion", "completion_month", "sellout_month", "cost_per_unit",
];

export function layoutFor(metrics: readonly Pick<Metric, "key" | "status">[]) {
  const lp = metrics.find((m) => m.key === "lp_irr");
  const withPartners = (keys: string[]) => lp && lp.status !== "NOT_APPLICABLE"
    ? keys.flatMap((key) => key === "equity_irr" ? [key, "lp_irr", "gp_irr", "gp_promote"] : [key]) : keys;
  if (metrics.some((m) => m.key === "gross_sales_revenue")) {
    return { sale: true, headline: withPartners(SALE_HEADLINE), stressKeys: ["profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple"] };
  }
  const held = metrics.some((m) => m.key === "stated_value");
  return { sale: false, headline: held ? HELD_HEADLINE : withPartners(HEADLINE),
    stressKeys: held ? ["sizing_dscr", "dcr_after_refinance", "unrealized_equity_multiple"] : ["sizing_dscr", "equity_multiple", "profit_on_cost"] };
}

/** The key figures the board leads with, in its order (card X3); every other figure of the layout follows them. */
const HELD_LEAD = ["total_development_cost", "required_equity", "stabilized_noi", "yield_on_cost", "development_spread", "dcr_after_refinance",
  "refinance_cash_returned", "cash_on_cash_after_refinance", "break_even_occupancy", "unrealized_equity_multiple", "unrealized_equity_irr"];
const RENTAL_LEAD = ["total_development_cost", "required_equity", "stabilized_noi", "yield_on_cost", "development_spread"];
const SALE_LEAD = ["total_development_cost", "required_equity", "net_sales_revenue"];

function figureOrder(metrics: readonly Pick<Metric, "key">[], layout: { sale: boolean; headline: string[] }) {
  const held = !layout.sale && metrics.some((m) => m.key === "stated_value");
  const lead = (layout.sale ? SALE_LEAD : held ? HELD_LEAD : RENTAL_LEAD).filter((k) => metrics.some((m) => m.key === k));
  return [...lead, ...layout.headline.filter((k) => !lead.includes(k))];
}

/** The stress table: income (or sales), cost and spread first, then the layout's keys, then anything else a gate reads under stress. */
function stressColumns(sale: boolean, stressKeys: string[], gates: readonly { metricKey: string; scenario: string }[], baseKey: string) {
  const first = sale ? ["net_sales_revenue", "total_development_cost"] : ["stabilized_noi", "total_development_cost", "development_spread"];
  return [...new Set([...first, ...stressKeys, ...gates.filter((g) => g.scenario !== baseKey).map((g) => g.metricKey)])];
}

const INPUTS_CHANGED = "An approved input changed after this run.";
type Change = { fieldKey: string; itemKey: string | null; now?: { value: number; unit: string }; was?: { value: number; unit: string } };
/** Approved values that differ from the ones the run used, matched on field and item. Both are shown as recorded; nothing is subtracted. */
function changedInputs(inputs: RunView["inputs"], assumptions: Review["assumptions"]): Change[] {
  const key = (field: string, item: string | null) => `${field}\u0000${item || ""}`;
  const unit = (field: string, fallback: string) => FIELD_BY_KEY.get(field)?.unit ?? fallback;
  const ran = new Map(inputs.map((x) => [key(x.fieldKey, x.itemKey), x]));
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const a of assumptions) {
    if ((a.status !== "approved" && a.status !== "default_accepted") || a.value === null) continue;
    const k = key(a.fieldKey, a.itemKey);
    seen.add(k);
    const x = ran.get(k);
    const now = { value: a.value, unit: unit(a.fieldKey, a.unit) };
    if (!x) out.push({ fieldKey: a.fieldKey, itemKey: a.itemKey || null, now });
    else if (x.value !== a.value) out.push({ fieldKey: a.fieldKey, itemKey: a.itemKey || null, now, was: { value: x.value, unit: unit(x.fieldKey, "count") } });
  }
  for (const x of inputs) {
    if (!seen.has(key(x.fieldKey, x.itemKey))) out.push({ fieldKey: x.fieldKey, itemKey: x.itemKey || null, was: { value: x.value, unit: unit(x.fieldKey, "count") } });
  }
  return out;
}
/** Changes named in the out-of-date banner before "and N more". */
const SHOWN_CHANGES = 5;
/** Runs in the history whose own status is fetched. */
const CHECKED_RUNS = 10;

export function useRun(runId: string | undefined) {
  return useQuery({ queryKey: ["run", runId], queryFn: () => api.get<RunView>(`/runs/${runId}`), enabled: Boolean(runId) });
}

const STALE: Record<string, "run.stale.inputs" | "run.stale.policy" | "run.stale.engine"> = {
  [INPUTS_CHANGED]: "run.stale.inputs",
  "The policy thresholds changed after this run.": "run.stale.policy",
  "The engine was updated after this run.": "run.stale.engine",
};

const staleText = (t: ReturnType<typeof useI18n>["t"], reasons: readonly string[]) => reasons.map((r) => (STALE[r] ? t(STALE[r]) : r)).join(" ");

/** A run's status in the history, from its own record: current, or out of date and why. */
function HistoryStatus({ id }: { id: string }) {
  const { t } = useI18n();
  const r = useRun(id);
  if (!r.data) return <span className="muted">{r.isError ? t("run.historyOpen") : t("run.historyChecking")}</span>;
  if (r.data.fresh) return <>{t("run.historyCurrent")}</>;
  const reasons = staleText(t, r.data.staleReasons);
  return <>{reasons ? t("run.staleLine", { reasons }) : t("run.stale")}</>;
}

export function GateOutcome({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === "passed") return <StatusTag tone="pass" glyph={I.Check}>{t("run.passes")}</StatusTag>;
  if (status === "failed") return <StatusTag tone="stop" glyph={I.Cross}>{t("run.fails")}</StatusTag>;
  return <StatusTag tone="neutral" glyph={I.Dashed}>{status === "not_applicable" ? t("common.notApplicable") : t("run.notEvaluated")}</StatusTag>;
}

type Refinance = NonNullable<RunView["refinance"]>;
const refinanceLine = (i: ReturnType<typeof useI18n>, r: Refinance) => {
  const p = { value: i.f.value(r.value, "$"), month: i.f.value(r.month, "count") };
  return r.stated || r.ltvPct === null ? i.t("run.refi.stated", p) : i.t("run.refi.ltv", { ...p, pct: i.f.value(r.ltvPct, "%") });
};

/** The trace panel for the refinance loan: how the engine sized it, and that it is worked out again, not stored (card R3). */
export function RefinanceTrace({ refinance: r, engine }: { refinance: Refinance; engine: string }) {
  const { t, f } = useI18n();
  const p = { value: f.value(r.value, "$"), month: f.value(r.month, "count") };
  return (
    <>
      <strong>{t("run.refi.howTitle")}</strong>
      <div>{r.stated || r.ltvPct === null ? t("run.refi.howStated", p) : t("run.refi.howLtv", { ...p, pct: f.value(r.ltvPct, "%") })}</div>
      <div>{t("run.refi.notStored", { engine })}</div>
    </>
  );
}

const STAGES: readonly RunStage[] = ["inputs", "ledger", "loans", "stresses", "gates", "record"];

/** A run token (card R1): 32 random bytes in base64url, made here and held only by this browser; it is what can stop the run. */
function runToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A run in progress, stage by stage, as the run's own answer streams in (card R1). */
export function RunInProgress({ n, startedAt, by, progress, stopping, onStop }: {
  n: number; startedAt?: number | undefined; by?: string | undefined; progress: RunProgress; stopping: boolean; onStop: () => void;
}) {
  const i = useI18n();
  const { t } = i;
  const locale = i.lang === "fr" ? "fr-CA" : "en-CA";
  const time = startedAt ? new Date(startedAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : undefined;
  const clock = (at: string) => new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const x = progress.facts;
  const policy = x && policyName(i, x.policyVersion);
  const current = STAGES.find((k) => !progress.stages[k]);
  const words = { exit: x?.exit, months: x?.constructionMonths ?? 0, years: x?.holdYears, n: x?.stresses };
  const hash = x && `${x.inputHash.slice(0, 4)} ${x.inputHash.slice(4, 8)} …`;
  return (
    <div className="with-aside">
      <section className="card card-pad stack tight" aria-busy="true">
        <div className="row"><span className="spin" aria-hidden="true" /><h2 className="h1">{t("run.inProgress", { n })}</h2></div>
        <p className="small muted">{t("run.startedAt", { time })}</p>
        <p className="lead">{x ? t("run.leadFacts", { approved: x.approved, defaults: x.defaults, policy, draft: x.policyDraft }) : t("run.inProgressLead")}</p>
        <ol className="runlist" aria-label={t("run.stepsLabel")} aria-live="polite">
          {STAGES.map((k) => {
            const at = progress.stages[k];
            return (
              <li key={k} className={at ? "done" : k === current ? "on" : undefined}>
                <span className="marker">{at && <I.Check size={10} />}</span>
                {t(`run.stage.${k}`, { ...words, done: Boolean(at) })}
                {at ? <span className="when num">{clock(at)}</span> : k === current && <span className="when">{t("run.now")}</span>}
              </li>
            );
          })}
        </ol>
        <div className="card-foot row between">
          <span className="small muted">{t("run.leave")}</span>
          <button className="btn quiet sm" type="button" disabled={stopping} onClick={onStop}>{stopping ? t("run.stopping") : t("run.stop")}</button>
        </div>
      </section>
      <aside className="stack">
        <div className="card card-pad stack tight">
          <h2 className="h3">{t("run.neverTitle")}</h2>
          <p className="muted">{t("run.neverBody")}</p>
        </div>
        <div className="card card-pad stack tight">
          <h2 className="h3">{t("run.inRun")}</h2>
          <dl className="kv">
            {x && <>
              <dt>{t("run.kv.inputs")}</dt><dd className="hash">{hash}</dd>
              <dt>{t("run.kv.policy")}</dt><dd>{policyValue(i, x.policyVersion, x.policyDraft)}</dd>
              <dt>{t("run.kv.engine")}</dt><dd>{x.engineVersion}</dd>
            </>}
            {by && <><dt>{t("run.kv.startedBy")}</dt><dd>{by}</dd></>}
          </dl>
          {n > 1 && <p className="small muted">{t("run.previousStays", { n: n - 1 })}</p>}
        </div>
      </aside>
    </div>
  );
}

/** After a stop: the run rolled back, so there is nothing to show but this. */
export function RunStopped({ n }: { n: number }) {
  const { t } = useI18n();
  return <Notice tone="review" role="status">{t("run.stopped", { n })}</Notice>;
}

/** With nothing changed since the latest run, the server gives that run back instead of recording a new one
 * (migration 0005). Its number when that happened, else null. */
export function reusedRun(latest: { id: string; number: number } | null | undefined, doneId: string): number | null {
  return latest && latest.id === doneId ? latest.number : null;
}

/** After a run that gave the latest run back: say so, rather than show it as if it were new. */
export function RunReused({ n }: { n: number }) {
  const { t } = useI18n();
  return <Notice role="status">{t("run.reused", { n })}</Notice>;
}
/** Operating years shown before "Show all". */
const FIRST_YEARS = 5;

export function Run({ dealId, run: fromAddress }: { dealId: string; run?: string | undefined }) {
  const i = useI18n();
  const { t, f, L } = i;
  const { role, solo, me } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const [selected, setSelected] = useState<string | null>(fromAddress ?? null);
  const runs = useQuery({ queryKey: ["runs", dealId], queryFn: () => api.get<{ id: string; run_number: number; verdict_code: string; created_at: string; created_by: string }[]>(`/deals/${dealId}/runs`) });
  const runId = selected ?? deal.data?.run?.id;
  const run = useRun(runId);
  // The approved values, only to name what changed when the shown run is out of date because of them.
  const inputsChanged = run.data?.staleReasons.includes(INPUTS_CHANGED) ?? false;
  const review = useQuery({ queryKey: ["review", dealId], queryFn: () => api.get<Review>(`/deals/${dealId}/review`), enabled: inputsChanged });
  const [trace, setTrace] = useState<Metric | null>(null);
  const [refiTrace, setRefiTrace] = useState(false);
  const [allYears, setAllYears] = useState(false);
  // A streamed run (card R1): its token, the stages as they finish, and whether a stop is being asked for.
  const token = useRef("");
  const [progress, setProgress] = useState<RunProgress>({ stages: {} });
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState<number | null>(null);
  const [reused, setReused] = useState<number | null>(null);
  const start = useMutation({
    mutationFn: (_n: number) => {
      token.current = runToken();
      setProgress({ stages: {} }); setStopping(false); setStopped(null); setReused(null);
      return api.stream<RunLine>(`/deals/${dealId}/runs?progress=1`, { "x-run-token": token.current }, (line) => {
        if ("stage" in line) setProgress((p) => ({ stages: { ...p.stages, [line.stage]: line.at }, facts: line.facts ?? p.facts }));
      });
    },
    onSuccess: async (last, n) => {
      if (!("done" in last)) { setStopped(n); return; }
      setReused(reusedRun(deal.data?.run, last.done.id));
      setSelected(last.done.id);
      await Promise.all([qc.invalidateQueries({ queryKey: ["deal", dealId] }), qc.invalidateQueries({ queryKey: ["runs", dealId] }), qc.invalidateQueries({ queryKey: ["run"] })]);
    },
  });
  const stop = () => {
    setStopping(true);
    // A refused stop (the run had just finished) needs no message: the run's own answer says how it ended.
    api.post("/runs/stop", { token: token.current }).catch(() => setStopping(false));
  };
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const next = Math.max(0, o.run?.number ?? 0, ...(runs.data ?? []).map((r) => r.run_number)) + 1;
  const blocked = o.review.status === "blocked";
  const why = dealStatus(i, o, solo).blockedParts.join(", ");
  const runBtn = (label: string, kind = "primary") => (
    <button className={`btn ${kind}`} type="button" disabled={blocked || start.isPending || !canEdit(role)} onClick={() => start.mutate(next)}>
      {start.isPending ? t("run.running") : label}
    </button>
  );
  const reasons = (blocked || !canEdit(role)) && (
    <div className="stack tight">
      {blocked && <p className="hint">{t("run.blockedWhy", { why })}</p>}
      {!canEdit(role) && <p className="hint">{t(role === "client" ? "run.clientWhy" : "run.viewerWhy")}</p>}
    </div>
  );

  if (start.isPending) {
    return (
      <>
        <DealFrame o={o} active="run" />
        <RunInProgress n={next} startedAt={start.submittedAt || undefined} by={me?.user.name} progress={progress} stopping={stopping} onStop={stop} />
      </>
    );
  }
  const stoppedNotice = stopped !== null ? <RunStopped n={stopped} /> : reused !== null && <RunReused n={reused} />;

  if (!runId) {
    return (
      <>
        <DealFrame o={o} active="run" />
        <section className="card card-pad stack run-empty">
          <h2 className="h2">{t("run.noRun")}</h2>
          <p className="lead">{t("run.noRunBody")}</p>
          {stoppedNotice}
          <div className="row">{runBtn(t("run.run"))}</div>
          {reasons}
          <ErrorText error={start.error} />
        </section>
      </>
    );
  }
  if (!run.data) return (<><DealFrame o={o} active="run" /><p className="muted">{t("run.loading")}</p></>);
  const v = run.data;
  const base = v.result.scenarios[0]!;
  const metric = (k: string, s = base) => s.metrics.find((m) => m.key === k)!;
  const vt = verdictText(i, v.result.verdict, v.result.checks, solo);
  const layout = layoutFor(base.metrics);
  const { sale } = layout;
  const figures = figureOrder(base.metrics, layout);
  const columns = stressColumns(sale, layout.stressKeys, v.result.verdict.gates, base.key);
  const stale = staleText(t, v.staleReasons);
  const changes = inputsChanged && review.data ? changedInputs(v.inputs, review.data.assumptions) : [];
  const changeText = (c: Change) => {
    const label = L.field(c.fieldKey, c.itemKey);
    const now = c.now && f.value(c.now.value, c.now.unit), was = c.was && f.value(c.was.value, c.was.unit);
    return now && was ? t("run.changed.value", { label, now, was }) : now ? t("run.changed.added", { label, now }) : t("run.changed.removed", { label, was });
  };
  // A sub-line shows a recorded value as it is, and only when that value is valid or the input is present; never 0 in its place.
  const valid = (k: string) => { const m = base.metrics.find((x) => x.key === k); return m && m.status === "VALID" && m.value !== null ? f.value(m.value, m.unit) : undefined; };
  const given = (k: string, unit?: string) => { const x = v.inputs.find((y) => y.fieldKey === k); return x && Number.isFinite(x.value) ? f.value(x.value, unit ?? FIELD_BY_KEY.get(k)?.unit ?? "count") : undefined; };
  const so = (value: string | undefined, line: (v: string) => string) => (value === undefined ? undefined : line(value));
  const context: Record<string, () => string | undefined> = {
    total_development_cost: () => so(valid("cost_per_unit"), (x) => t("run.sub.perUnit", { v: x })),
    required_equity: () => so(valid("loan_to_cost"), (x) => t("run.sub.loanToCost", { v: x })),
    stabilized_noi: () => so(valid("effective_gross_income"), (x) => t("run.sub.income", { v: x })),
    yield_on_cost: () => so(given("exit_cap_rate_pct"), (x) => t("run.sub.capRate", { v: x })),
    refinance_cash_returned: () => so(valid("cash_left_in_deal"), (x) => t("run.sub.leftIn", { v: x })),
    cash_on_cash_after_refinance: () => so(valid("cash_on_cash_year1"), (x) => t("run.sub.year1", { v: x })),
    break_even_occupancy: () => so(given("stabilized_occupancy_pct"), (x) => t("run.sub.occupancy", { v: x })),
    unrealized_equity_multiple: () => t("run.sub.stated"),
    unrealized_equity_irr: () => so(given("hold_years", ""), (x) => t("run.sub.hold", { n: x })),
    net_sales_revenue: () => so(valid("gross_sales_revenue"), (x) => t("run.sub.sales", { v: x })),
  };
  const scenarioLabel = (key: string) => L.stress(key, v.result.scenarios.find((s) => s.key === key)?.label ?? key);
  const gateFor = (k: string) => v.result.verdict.gates.find((g) => g.metricKey === k && g.scenario === base.key);
  const operating = v.result.annual.filter((y) => y.year > 0).length;
  const years = allYears ? v.result.annual : v.result.annual.filter((y) => y.year <= FIRST_YEARS);
  const notPassing = v.result.checks.filter((c) => c.severity !== "pass").length;
  // The refinance loan follows the coverage after refinancing, or ends the figures when the layout has no such figure.
  const refi = v.refinance;
  const refiAfter = figures.includes("dcr_after_refinance") ? "dcr_after_refinance" : figures[figures.length - 1];
  return (
    <>
      <DealFrame o={o} active="run" />
      <div className="stack">
        {!v.fresh && (
          <Banner tone="review" title={t("run.outOfDate", { n: v.number })}>
            <span>{stale} {t("run.outOfDateBody")}</span>
            {changes.length > 0 && (
              <ul className="run-changes">
                {changes.slice(0, SHOWN_CHANGES).map((c) => <li key={`${c.fieldKey}:${c.itemKey ?? ""}`}>{changeText(c)}</li>)}
                {changes.length > SHOWN_CHANGES && <li>{t("run.changed.more", { n: changes.length - SHOWN_CHANGES })}</li>}
              </ul>
            )}
          </Banner>
        )}
        {stoppedNotice}
        <ErrorText error={start.error} />

        <section className="card" aria-label={t("run.verdictAria")}>
          <div className="card-pad run-verdict">
            <div className="run-verdict-text">
              <div className="row">
                <VerdictBadge code={v.result.verdict.code} />
                {v.policyCustom && <span>{t("threshold.withYours")}</span>}
                <span className="muted">{t("run.verdictLine", { n: v.number, policy: policyName(i, v.policyVersion), draft: v.policyDraft, unsigned: !isSigned(v.policyVersion) })}</span>
              </div>
              <p className="run-headline">{vt.headline}</p>
              <p className="muted">{vt.explanation}</p>
              <p className="small muted">{v.fresh ? t("run.currentLine") : t("run.staleLine", { reasons: stale })}</p>
              <StandardVerdict custom={v.policyCustom ?? false} standard={v.result.standard} />
              <p className="small muted">{t("run.thresholdsLine")} <Link to="/deals/$dealId/review" params={{ dealId }} hash="thresholds">{t("run.thresholdsLink")}</Link></p>
            </div>
            <div className="stack tight run-verdict-actions">
              {/* An out-of-date run cannot be decided on, so running again comes first. */}
              <div className="actions">
                {!v.fresh && runBtn(t("run.again"))}
                <Link to="/deals/$dealId/decision" params={{ dealId }} className={v.fresh ? "btn primary" : "btn quiet"}>{t("run.decide")}</Link>
                <Link to="/deals/$dealId/reports" params={{ dealId }} className="btn quiet">{t("run.memoAction")}</Link>
                <Link to="/deals/$dealId/explore" params={{ dealId }} className="btn quiet">{t("run.explore")}</Link>
                {v.fresh && runBtn(t("run.again"), "ghost")}
              </div>
              {reasons}
            </div>
          </div>
        </section>

        <section className="section">
          <h2 className="h2">{t("run.keyFigures")}</h2>
          <Figures>
            {figures.map((k) => {
              const m = metric(k);
              const g = gateFor(k);
              const p = k === "unrealized_equity_irr" ? v.heldPartners : undefined;
              const sub = m.status !== "VALID" && m.reason ? i.msg(m.reason) : g ? t("run.gateNeeds", { v: f.value(g.threshold, g.unit) })
                : m.status === "VALID" ? context[k]?.() : undefined;
              return (
                <Fragment key={k}>
                  <Figure k={<button type="button" className="run-fig-btn" aria-pressed={trace?.key === k} onClick={() => { setTrace(m); setRefiTrace(false); }}>{L.metric(k)}</button>} v={<MetricValue {...m} />} s={sub} />
                  {/* A held deal's partner returns (card 88): report arithmetic, not metrics, so they have no formula trace. */}
                  {p && ([["run.heldLpIrr", p.lpIrr, "%"], ["run.heldGpIrr", p.gpIrr, "%"], ["run.heldPromote", p.promote, "$"]] as const).map(([label, value, unit]) => (
                    <Figure key={label} k={t(label)} v={<MetricValue value={value} unit={unit} status={value === null ? "NOT_MEANINGFUL" : "VALID"} />} />
                  ))}
                  {refi && k === refiAfter && (
                    <Figure k={<button type="button" className="run-fig-btn" aria-pressed={refiTrace} onClick={() => { setTrace(null); setRefiTrace(true); }}>{t("run.refi.label")}</button>}
                      v={<span className="num">{f.value(refi.loan, "$")}</span>} s={refinanceLine(i, refi)} />
                  )}
                </Fragment>
              );
            })}
          </Figures>
          <div className="quote" aria-live="polite">
            {trace && <>
              <strong>{t("run.howMade", { label: L.metric(trace.key).toLowerCase() })}</strong>
              <div>{L.metric(trace.key)} = {L.formula(trace.key)}</div>
              <div>= <MetricValue {...trace} /></div>
              {trace.status !== "VALID" && <div>{i.msg(trace.reason)}</div>}
            </>}
            {refiTrace && refi && <RefinanceTrace refinance={refi} engine={v.engineVersion} />}
            <span className="src">{t("run.selectFigure")}</span>
          </div>
          <Glossary />
        </section>

        <section className="section">
          <h2 className="h2">{t("run.gates")}</h2>
          <div className="card scroll">
            <table className="table">
              <thead><tr><th scope="col">{t("run.col.gate")}</th><th scope="col">{t("run.col.needs")}</th><th scope="col" className="r">{t("run.col.result")}</th><th scope="col">{t("run.col.outcome")}</th></tr></thead>
              <tbody>
                {v.result.verdict.gates.map((g) => (
                  <tr key={g.key}>
                    <th scope="row" className="run-rowhead">{L.gate(g.key, g.label)}<span className="sub">{scenarioLabel(g.scenario)}</span></th>
                    <td>{t("run.atLeast", { v: f.value(g.threshold, g.unit) })}</td>
                    <td className="r">{g.actual === null ? <span className="not-meaningful">{g.status === "not_applicable" ? t("common.notApplicable") : t("common.notMeasured")}</span> : <span className="num">{f.value(g.actual, g.unit)}</span>}</td>
                    <td><GateOutcome status={g.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-foot small muted">{t("run.gatesNote")}</div>
          </div>
        </section>

        <section className="section">
          <div><h2 className="h2" id="run-stress-h">{t("run.underStress")}</h2><p className="muted">{t("run.underStressLead")}</p></div>
          {/* The table is wider than the page: the box takes focus so the keyboard can scroll it. */}
          <div className="card scroll run-stress" tabIndex={0} role="region" aria-labelledby="run-stress-h">
            <table className="table">
              <thead><tr><th scope="col">{t("run.col.scenario")}</th>{columns.map((k) => <th scope="col" key={k} className="r">{L.metric(k)}</th>)}</tr></thead>
              <tbody>
                {v.result.scenarios.map((s) => (
                  <tr key={s.key} className={s.key === "combined" ? "run-combined" : undefined}>
                    <th scope="row" className="run-rowhead">
                      {v.policy?.custom && v.policy.stresses.some((stress) => stress.key === s.key) ? stressLabel(v.policy.stresses.find((stress) => stress.key === s.key)!, i.lang, v.standardPolicy?.stresses.find((stress) => stress.key === s.key)) : L.stress(s.key, s.label)}{s.key === "combined" && <span className="muted">{t("run.readByGates")}</span>}
                    </th>
                    {columns.map((k) => {
                      const m = s.metrics.find((x) => x.key === k);
                      return <td key={k} className="r">{m ? <MetricValue {...m} /> : <span className="not-meaningful">{t("common.notMeasured")}</span>}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {sale ? <p className="muted">{t("run.saleCashFlows")}</p> : (
          <section className="section">
            <h2 className="h2">{t("run.annual")}</h2>
            <div className="card scroll">
              <table className="table">
                <thead><tr><th scope="col">{t("run.col.period")}</th><th scope="col" className="r">{t("run.col.egi")}</th><th scope="col" className="r">{t("run.col.opex")}</th><th scope="col" className="r">{t("run.col.noi")}</th><th scope="col" className="r">{t("run.col.ds")}</th><th scope="col" className="r">{t("run.col.cf")}</th></tr></thead>
                <tbody>
                  {years.map((y) => (
                    <tr key={y.year}>
                      <th scope="row" className="run-rowhead">{y.year === 0 ? t("run.beforeStab") : t("run.year", { n: y.year })}</th>
                      {[y.egi, y.opex, y.noi, y.debtService, y.cashFlow].map((n, k) => <td key={k} className="r num">{f.value(n, "$")}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {operating > FIRST_YEARS && (
                <div className="card-foot row">
                  <button type="button" className="btn ghost sm" aria-expanded={allYears} onClick={() => setAllYears(!allYears)}>{allYears ? t("run.showFirstYears") : t("run.showAllYears", { n: operating })}</button>
                </div>
              )}
            </div>
          </section>
        )}

        <div className="grid2">
          <section className="card card-pad stack tight">
            <h2 className="h2">{t("run.checks")}</h2>
            <p className="muted">{t("run.checksLead", { n: v.result.checks.length, k: notPassing })}</p>
            <ul className="run-checks">
              {v.result.checks.map((c) => (
                <li key={c.key}>
                  <StatusTag tone={c.severity === "pass" ? "pass" : c.severity === "warning" ? "review" : "stop"} glyph={c.severity === "pass" ? I.Check : c.severity === "warning" ? I.Eye : I.Stop}>
                    {c.severity === "pass" ? t("run.pass") : c.severity === "warning" ? t("run.check") : t("run.fails")}
                  </StatusTag>
                  <span>{checkText(i, c)}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card card-pad stack tight">
            <h2 className="h2">{t("run.record")}</h2>
            <p className="row small">{v.fresh ? <><I.Check />{t("run.current")}</> : <><I.Eye />{t("run.stale")}</>}</p>
            <dl className="kv">
              <dt>{t("run.kv.run")}</dt><dd>{t("run.kv.runValue", { n: v.number, date: f.date(v.createdAt), by: v.createdBy })}</dd>
              <dt>{t("run.kv.engine")}</dt><dd>{v.engineVersion}</dd>
              <dt>{t("run.kv.policy")}</dt><dd>{policyValue(i, v.policyVersion, v.policyDraft)}</dd>
              <dt>{t("run.kv.inputs")}</dt><dd className="hash">{v.inputHash.slice(0, 16)}</dd>
              <dt>{t("run.kv.result")}</dt><dd className="hash">{v.resultHash.slice(0, 16)}</dd>
              <dt>{t("run.kv.signed")}</dt><dd>{t("run.kv.signedValue", { key: v.signed === "development key" ? t("run.devKey") : t("run.prodKey") })}</dd>
            </dl>
            <div className="row"><a className="btn quiet sm" href={`/api/runs/${v.id}/audit-package`}><I.Download />{t("run.package")}</a></div>

            <details>
              <summary>{t("run.inputs")} <span className="num muted">{v.inputs.length}</span></summary>
              <div className="scroll">
                <table className="table run-inputs">
                  <tbody>
                    {v.inputs.map((x, n) => (
                      <tr key={n}><td>{L.field(x.fieldKey, x.itemKey)}<span className="sub">{x.tableSource ? tableSourceLabel(x.tableSource,i.lang) : i.msg(x.source)}{x.sponsorStated ? ` · ${t("run.notConfirmed")}` : x.confirmedByReview ? ` · ${t("run.confirmedByReview", { date: f.date(x.confirmedAt!) })}` : x.confirmedBy ? ` · ${t("run.confirmedBy", { who: x.confirmedBy })}` : ""}</span>{x.tableStale && x.tableSource?.recheckBy && <span className="sub">{tableStaleWarning(x.tableSource.recheckBy,i.lang)}</span>}{x.tableSource?.tableId === "gst-hst-pbrh" && x.tableSource.optionKey === "pbrh" && <span className="sub">{pbrhExplanation(x.tableSource.readOn,i.lang)}</span>}</td><td className="r num">{f.value(x.value, FIELD_BY_KEY.get(x.fieldKey)?.unit ?? "count")}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>

            {(runs.data?.length ?? 0) > 1 && <>
              <h3 className="h3">{t("run.history")}</h3>
              <div className="scroll">
                <table className="table run-history">
                  <thead><tr><th scope="col">{t("run.historyCol.run")}</th><th scope="col">{t("run.historyCol.verdict")}</th><th scope="col">{t("run.historyCol.status")}</th><th scope="col">{t("run.historyCol.shown")}</th></tr></thead>
                  <tbody>
                    {runs.data!.map((r, n) => (
                      <tr key={r.id}>
                        <th scope="row" className="run-rowhead">
                          <button type="button" className="btn ghost sm" aria-pressed={r.id === v.id} onClick={() => setSelected(r.id)}>{t("common.run", { n: r.run_number })}</button>
                          <span className="sub">{f.date(r.created_at)}</span>
                        </th>
                        <td><VerdictBadge code={r.verdict_code} /></td>
                        <td className="run-status">{n < CHECKED_RUNS || r.id === v.id ? <HistoryStatus id={r.id} /> : <span className="muted">{t("run.historyOpen")}</span>}</td>
                        <td className="muted">{r.id === v.id ? t("run.historyShown") : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>}
          </section>
        </div>
      </div>
    </>
  );
}

/** The run's policy by name, saying when it is a draft or otherwise not yet signed by credit (card E). */
function policyValue(i: ReturnType<typeof useI18n>, version: string, draft: boolean): string {
  const p = policyName(i, version);
  return draft ? i.t("run.kv.policyDraft", { p }) : isSigned(version) ? p : i.t("run.kv.policyUnsigned", { p });
}
