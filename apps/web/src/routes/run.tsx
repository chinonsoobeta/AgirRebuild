import { stressLabel, tableSourceLabel, tableStaleWarning, pbrhExplanation } from "@agir/contracts";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Figure, Figures } from "../components/kit";
import { FIELD_BY_KEY } from "@agir/contracts";
import { api, type Metric, type RunView } from "../api";
import { Banner, canEdit, DealFrame, ErrorText, Glossary, MetricValue, StatusTag, useDeal, useSession, VerdictBadge } from "../components/ui";
import { Thresholds, StandardVerdict } from "../components/thresholds";
import * as I from "../components/icons";
import { checkText, dealStatus, useI18n, verdictText } from "../i18n";

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

export function useRun(runId: string | undefined) {
  return useQuery({ queryKey: ["run", runId], queryFn: () => api.get<RunView>(`/runs/${runId}`), enabled: Boolean(runId) });
}

const STALE: Record<string, "run.stale.inputs" | "run.stale.policy" | "run.stale.engine"> = {
  "An approved input changed after this run.": "run.stale.inputs",
  "The policy thresholds changed after this run.": "run.stale.policy",
  "The engine was updated after this run.": "run.stale.engine",
};

export function GateOutcome({ status }: { status: string }) {
  const { t } = useI18n();
  if (status === "passed") return <StatusTag tone="pass" glyph={I.Check}>{t("run.passes")}</StatusTag>;
  if (status === "failed") return <StatusTag tone="stop" glyph={I.Cross}>{t("run.fails")}</StatusTag>;
  return <StatusTag tone="neutral" glyph={I.Dashed}>{status === "not_applicable" ? t("common.notApplicable") : t("run.notEvaluated")}</StatusTag>;
}

const STEPS = ["run.step.check", "run.step.ledger", "run.step.underwrite", "run.step.stress", "run.step.gates", "run.step.record"] as const;
/** Operating years shown before "Show all". */
const FIRST_YEARS = 5;

export function Run({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { t, f, L } = i;
  const { role, solo } = useSession();
  const qc = useQueryClient();
  const deal = useDeal(dealId);
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["runs", dealId], queryFn: () => api.get<{ id: string; run_number: number; verdict_code: string; created_at: string; created_by: string }[]>(`/deals/${dealId}/runs`) });
  const runId = selected ?? deal.data?.run?.id;
  const run = useRun(runId);
  const [trace, setTrace] = useState<Metric | null>(null);
  const [allYears, setAllYears] = useState(false);
  const start = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/deals/${dealId}/runs`),
    onSuccess: async (r) => {
      setSelected(r.id);
      await Promise.all([qc.invalidateQueries({ queryKey: ["deal", dealId] }), qc.invalidateQueries({ queryKey: ["runs", dealId] }), qc.invalidateQueries({ queryKey: ["run"] })]);
    },
  });
  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  const o = deal.data;
  const blocked = o.review.status === "blocked";
  const why = dealStatus(i, o, solo).blockedParts.join(", ");
  const runBtn = (label: string, kind = "primary") => (
    <button className={`btn ${kind}`} type="button" disabled={blocked || start.isPending || !canEdit(role)} onClick={() => start.mutate()}>
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
    const next = Math.max(0, o.run?.number ?? 0, ...(runs.data ?? []).map((r) => r.run_number)) + 1;
    return (
      <>
        <DealFrame o={o} active="run" />
        <div className="with-aside">
          <section className="card card-pad stack tight" role="status" aria-busy="true">
            <div className="row"><span className="spin" aria-hidden="true" /><h2 className="h1">{t("run.inProgress", { n: next })}</h2></div>
            <p className="lead">{t("run.inProgressLead")}</p>
            <ol className="runlist" aria-label={t("run.stepsLabel")}>
              {STEPS.map((k) => <li key={k}>{t(k)}</li>)}
            </ol>
          </section>
          <aside className="card card-pad stack tight">
            <h2 className="h3">{t("run.neverTitle")}</h2>
            <p className="muted">{t("run.neverBody")}</p>
          </aside>
        </div>
      </>
    );
  }

  if (!runId) {
    return (
      <>
        <DealFrame o={o} active="run" />
        <section className="card card-pad stack run-empty">
          <h2 className="h2">{t("run.noRun")}</h2>
          <p className="lead">{t("run.noRunBody")}</p>
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
  const { sale, headline, stressKeys } = layoutFor(base.metrics);
  const stale = v.staleReasons.map((r) => (STALE[r] ? t(STALE[r]) : r)).join(" ");
  const scenarioLabel = (key: string) => L.stress(key, v.result.scenarios.find((s) => s.key === key)?.label ?? key);
  const gateFor = (k: string) => v.result.verdict.gates.find((g) => g.metricKey === k && g.scenario === base.key);
  const operating = v.result.annual.filter((y) => y.year > 0).length;
  const years = allYears ? v.result.annual : v.result.annual.filter((y) => y.year <= FIRST_YEARS);
  const notPassing = v.result.checks.filter((c) => c.severity !== "pass").length;
  return (
    <>
      <DealFrame o={o} active="run" />
      <div className="stack">
        {!v.fresh && (
          <Banner tone="review" title={t("run.outOfDate", { n: v.number })}>
            <span>{stale} {t("run.outOfDateBody")}</span>
          </Banner>
        )}
        <ErrorText error={start.error} />

        <section className="card" aria-label={t("run.verdictAria")}>
          <div className="card-pad run-verdict">
            <div className="run-verdict-text">
              <div className="row">
                <VerdictBadge code={v.result.verdict.code} />
                {v.policyCustom && <span>{t("threshold.withYours")}</span>}
                <span className="muted">{t("run.verdictLine", { n: v.number, policy: v.policyVersion, draft: v.policyDraft })}</span>
              </div>
              <p className="run-headline">{vt.headline}</p>
              <p className="muted">{vt.explanation}</p>
              <p className="small muted">{v.fresh ? t("run.currentLine") : t("run.staleLine", { reasons: stale })}</p>
              <StandardVerdict custom={v.policyCustom ?? false} standard={v.result.standard} />
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

        <div className="card card-pad"><Thresholds scope="deals" id={dealId} initialVersion={v.policyVersion} /></div>

        <section className="section">
          <h2 className="h2">{t("run.keyFigures")}</h2>
          <Figures>
            {headline.map((k) => {
              const m = metric(k);
              const g = gateFor(k);
              const p = k === "unrealized_equity_irr" ? v.heldPartners : undefined;
              const sub = m.status !== "VALID" && m.reason ? i.msg(m.reason) : g ? t("run.gateNeeds", { v: f.value(g.threshold, g.unit) }) : undefined;
              return (
                <Fragment key={k}>
                  <Figure k={<button type="button" className="run-fig-btn" aria-pressed={trace?.key === k} onClick={() => setTrace(m)}>{L.metric(k)}</button>} v={<MetricValue {...m} />} s={sub} />
                  {/* A held deal's partner returns (card 88): report arithmetic, not metrics, so they have no formula trace. */}
                  {p && ([["run.heldLpIrr", p.lpIrr, "%"], ["run.heldGpIrr", p.gpIrr, "%"], ["run.heldPromote", p.promote, "$"]] as const).map(([label, value, unit]) => (
                    <Figure key={label} k={t(label)} v={<MetricValue value={value} unit={unit} status={value === null ? "NOT_MEANINGFUL" : "VALID"} />} />
                  ))}
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
          <div><h2 className="h2">{t("run.underStress")}</h2><p className="muted">{t("run.underStressLead")}</p></div>
          <div className="card scroll">
            <table className="table">
              <thead><tr><th scope="col">{t("run.col.scenario")}</th>{stressKeys.map((k) => <th scope="col" key={k} className="r">{L.metric(k)}</th>)}</tr></thead>
              <tbody>
                {v.result.scenarios.map((s) => (
                  <tr key={s.key} className={s.key === "combined" ? "run-combined" : undefined}>
                    <th scope="row" className="run-rowhead">
                      {v.policy?.custom && v.policy.stresses.some((stress) => stress.key === s.key) ? stressLabel(v.policy.stresses.find((stress) => stress.key === s.key)!, i.lang, v.standardPolicy?.stresses.find((stress) => stress.key === s.key)) : L.stress(s.key, s.label)}{s.key === "combined" && <span className="muted">{t("run.readByGates")}</span>}
                    </th>
                    {stressKeys.map((k) => { const m = metric(k, s); return <td key={k} className="r"><MetricValue {...m} /></td>; })}
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
              <dt>{t("run.kv.policy")}</dt><dd>{v.policyVersion}{v.policyDraft && <> · {t("run.draftPolicy")}</>}</dd>
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
                  <thead><tr><th scope="col">{t("run.historyCol.run")}</th><th scope="col">{t("run.historyCol.verdict")}</th><th scope="col">{t("run.historyCol.shown")}</th></tr></thead>
                  <tbody>
                    {runs.data!.map((r) => (
                      <tr key={r.id}>
                        <th scope="row" className="run-rowhead">
                          <button type="button" className="btn ghost sm" aria-pressed={r.id === v.id} onClick={() => setSelected(r.id)}>{t("common.run", { n: r.run_number })}</button>
                          <span className="sub">{f.date(r.created_at)}</span>
                        </th>
                        <td><VerdictBadge code={r.verdict_code} /></td>
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
