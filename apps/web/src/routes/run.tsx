import { stressLabel, tableSourceLabel, tableStaleWarning, pbrhExplanation } from "@agir/contracts";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { FIELD_BY_KEY } from "@agir/contracts";
import { api, type Metric, type RunView } from "../api";
import { Banner, canEdit, DealHeader, ErrorText, Glossary, MetricValue, StatusTag, useDeal, useSession, VerdictBadge } from "../components/ui";
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
  const runButton = (label: string) => (
    <div className="stack" style={{ gap: 6, alignItems: "flex-start" }}>
      <button className="btn primary" type="button" disabled={blocked || start.isPending || !canEdit(role)} onClick={() => start.mutate()}>
        {start.isPending ? t("run.running") : label}
      </button>
      {blocked && <span className="why">{t("run.blockedWhy", { why })}</span>}
      {!canEdit(role) && <span className="why">{t(role === "client" ? "run.clientWhy" : "run.viewerWhy")}</span>}
    </div>
  );

  if (!runId) {
    return (
      <>
        <DealHeader o={o} active="run" />
        <div className="panel stack" style={{ gap: 16, maxWidth: 720 }}>
          <h2 className="h-section">{t("run.noRun")}</h2>
          <p className="muted">{t("run.noRunBody")}</p>
          {runButton(t("run.run"))}
          <ErrorText error={start.error} />
        </div>
      </>
    );
  }
  if (!run.data) return (<><DealHeader o={o} active="run" /><p className="muted">{t("run.loading")}</p></>);
  const v = run.data;
  const base = v.result.scenarios[0]!;
  const metric = (k: string, s = base) => s.metrics.find((m) => m.key === k)!;
  const vt = verdictText(i, v.result.verdict, v.result.checks, solo);
  const { sale, headline, stressKeys } = layoutFor(base.metrics);
  return (
    <>
      <DealHeader o={o} active="run" />
      {!v.fresh && (
        <Banner tone="review" title={t("run.outOfDate", { n: v.number })}>
          <span>{v.staleReasons.map((r) => (STALE[r] ? t(STALE[r]) : r)).join(" ")} {t("run.outOfDateBody")}</span>
          <div style={{ marginTop: 8 }}>{runButton(t("run.again"))}</div>
        </Banner>
      )}
      <ErrorText error={start.error} />
      <section className="panel spread" aria-label="Verdict" style={{ padding: "28px 32px", alignItems: "flex-end", gap: 32 }}>
        <div className="stack" style={{ gap: 12, maxWidth: 760 }}>
          <div className="row"><VerdictBadge code={v.result.verdict.code} />{v.policyCustom && <span>{t("threshold.withYours")}</span>}<span className="label">{t("run.verdictLabel", { n: v.number, policy: v.policyVersion })}</span></div>
          <StandardVerdict custom={v.policyCustom ?? false} standard={v.result.standard} />
          <Thresholds scope="deals" id={dealId} initialVersion={v.policyVersion} />
          {v.policyDraft && <p className="label">{t("run.draftPolicy")}</p>}
          <p className="h-display">{vt.headline}</p>
          <p className="muted" style={{ fontSize: 16 }}>{vt.explanation}</p>
        </div>
        <div className="row">
          <Link to="/deals/$dealId/explore" params={{ dealId }} className="btn quiet">{t("run.explore")}</Link>
          <Link to="/deals/$dealId/reports" params={{ dealId }} className="btn">{t("run.memo")}</Link>
          <Link to="/deals/$dealId/decision" params={{ dealId }} className="btn primary">{t("run.decide")}</Link>
        </div>
      </section>

      <div className="two-col">
        <div className="stack" style={{ gap: 28 }}>
          <div className="stack">
            <h2 className="h-section">{t("run.gates")}</h2>
            <table className="tbl">
              <thead><tr><th>{t("run.col.gate")}</th><th className="r">{t("run.col.needs")}</th><th className="r">{t("run.col.result")}</th><th>{t("run.col.outcome")}</th></tr></thead>
              <tbody>
                {v.result.verdict.gates.map((g) => (
                  <tr key={g.key}>
                    <td>{L.gate(g.key, g.label)}</td>
                    <td className="r num muted">≥ {f.value(g.threshold, g.unit)}</td>
                    <td className="r">{g.actual === null ? <span className="not-meaningful">{g.status === "not_applicable" ? t("common.notApplicable") : t("common.notMeasured")}</span> : <span className="num">{f.value(g.actual, g.unit)}</span>}</td>
                    <td><GateOutcome status={g.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <span className="small faint">{t("run.gatesNote")}</span>
          </div>

          <Glossary />

          <div className="stack">
            <h2 className="h-section">{t("run.stresses")}</h2>
            <table className="tbl">
              <thead><tr><th>{t("run.col.scenario")}</th>{stressKeys.map((k) => <th key={k} className="r">{L.metric(k)}</th>)}</tr></thead>
              <tbody className="num">
                {v.result.scenarios.map((s) => (
                  <tr key={s.key} className={s.key === "combined" ? "emph" : ""}>
                    <th scope="row" style={{ fontFamily: "var(--sans)", fontWeight: s.key === "base" || s.key === "combined" ? 600 : 400 }}>
                      {v.policy?.custom && v.policy.stresses.some((stress) => stress.key === s.key) ? stressLabel(v.policy.stresses.find((stress) => stress.key === s.key)!, i.lang, v.standardPolicy?.stresses.find((stress) => stress.key === s.key)) : L.stress(s.key, s.label)}{s.key === "combined" && <span className="faint" style={{ fontWeight: 400 }}>{t("run.readByGates")}</span>}
                    </th>
                    {stressKeys.map((k) => { const m = metric(k, s); return <td key={k} className="r"><MetricValue {...m} /></td>; })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {sale ? <p className="muted">{t("run.saleCashFlows")}</p> : <div className="stack">
            <h2 className="h-section">{t("run.annual")}</h2>
            <table className="tbl">
              <thead><tr><th>{t("run.col.period")}</th><th className="r">{t("run.col.egi")}</th><th className="r">{t("run.col.opex")}</th><th className="r">{t("run.col.noi")}</th><th className="r">{t("run.col.ds")}</th><th className="r">{t("run.col.cf")}</th></tr></thead>
              <tbody className="num">
                {v.result.annual.map((y) => (
                  <tr key={y.year}>
                    <th scope="row" style={{ fontFamily: "var(--sans)" }}>{y.year === 0 ? t("run.beforeStab") : t("run.year", { n: y.year })}</th>
                    {[y.egi, y.opex, y.noi, y.debtService, y.cashFlow].map((n, k) => <td key={k} className="r">{f.value(n, "$")}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}

          {trace && (
            <div className="stack">
              <h2 className="h-section">{t("run.howMade", { label: L.metric(trace.key).toLowerCase() })}</h2>
              <div className="formula">
                <div>{L.metric(trace.key)} = {L.formula(trace.key)}</div>
                <div className="muted">= <MetricValue {...trace} /></div>
                {trace.status !== "VALID" && <div className="muted">{i.msg(trace.reason)}</div>}
              </div>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 28 }}>
          <div className="stack">
            <h2 className="h-section">{t("run.keyFigures")}</h2>
            <table className="tbl">
              <tbody>
                {headline.map((k) => {
                  const m = metric(k);
                  const p = k === "unrealized_equity_irr" ? v.heldPartners : undefined;
                  return (
                    <Fragment key={k}>
                      <tr>
                        <th scope="row"><button type="button" className="btn quiet small" style={{ padding: 0, height: "auto", textAlign: "left", whiteSpace: "normal" }} onClick={() => setTrace(m)}>{L.metric(k)}</button></th>
                        <td className="r"><MetricValue {...m} />{m.status !== "VALID" && m.reason && <div className="small faint">{i.msg(m.reason)}</div>}</td>
                      </tr>
                      {/* A held deal's partner returns (card 88): report arithmetic, not metrics, so they have no formula trace. */}
                      {p && ([["run.heldLpIrr", p.lpIrr, "%"], ["run.heldGpIrr", p.gpIrr, "%"], ["run.heldPromote", p.promote, "$"]] as const).map(([label, value, unit]) => (
                        <tr key={label}>
                          <th scope="row">{t(label)}</th>
                          <td className="r"><MetricValue value={value} unit={unit} status={value === null ? "NOT_MEANINGFUL" : "VALID"} /></td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            <span className="small faint">{t("run.selectFigure")}</span>
          </div>

          <div className="stack">
            <h2 className="h-section">{t("run.checks")}</h2>
            <ul className="tbl" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {v.result.checks.map((c) => (
                <li key={c.key} className="row" style={{ alignItems: "flex-start", padding: "12px 18px", borderBottom: "1px solid var(--sunken)", flexWrap: "nowrap" }}>
                  <StatusTag tone={c.severity === "pass" ? "pass" : c.severity === "warning" ? "review" : "stop"} glyph={c.severity === "pass" ? I.Check : c.severity === "warning" ? I.Eye : I.Stop}>
                    {c.severity === "pass" ? t("run.pass") : c.severity === "warning" ? t("run.check") : t("run.fails")}
                  </StatusTag>
                  <span style={{ fontSize: 14 }}>{checkText(i, c)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="panel stack" style={{ gap: 10 }}>
            <span className="label">{t("run.record")}</span>
            <span className="row" style={{ gap: 8, fontWeight: 600 }}>{v.fresh ? <><I.Check />{t("run.current")}</> : <><I.Eye />{t("run.stale")}</>}</span>
            <span className="num small muted" style={{ lineHeight: 1.7 }}>
              {t("run.recordLine", { n: v.number, engine: v.engineVersion, policy: v.policyVersion })}<br />
              {f.date(v.createdAt)}{v.createdBy ? ` · ${v.createdBy}` : ""}<br />
              {t("run.hashes", { i: v.inputHash.slice(0, 16), r: v.resultHash.slice(0, 16) })}<br />
              {t("run.signed", { key: v.signed === "development key" ? t("run.devKey") : t("run.prodKey") })}
            </span>
            <a className="btn small" href={`/api/runs/${v.id}/audit-package`} style={{ alignSelf: "flex-start" }}><I.Download />{t("run.package")}</a>
          </div>

          <details>
            <summary>{t("run.inputs")} <span className="num faint" style={{ fontWeight: 400 }}>{v.inputs.length}</span></summary>
            <table className="tbl" style={{ marginTop: 12 }}>
              <tbody>
                {v.inputs.map((x, n) => (
                  <tr key={n}><td className="small">{L.field(x.fieldKey, x.itemKey)}<div className="faint">{x.tableSource ? tableSourceLabel(x.tableSource,i.lang) : i.msg(x.source)}{x.sponsorStated ? ` · ${t("run.notConfirmed")}` : x.confirmedByReview ? ` · ${t("run.confirmedByReview", { date: f.date(x.confirmedAt!) })}` : x.confirmedBy ? ` · ${t("run.confirmedBy", { who: x.confirmedBy })}` : ""}</div>{x.tableStale && x.tableSource?.recheckBy && <div className="small">{tableStaleWarning(x.tableSource.recheckBy,i.lang)}</div>}{x.tableSource?.tableId === "gst-hst-pbrh" && x.tableSource.optionKey === "pbrh" && <div className="small">{pbrhExplanation(x.tableSource.readOn,i.lang)}</div>}</td><td className="r num small">{f.value(x.value, FIELD_BY_KEY.get(x.fieldKey)?.unit ?? "count")}</td></tr>
                ))}
              </tbody>
            </table>
          </details>

          {(runs.data?.length ?? 0) > 1 && (
            <div className="stack">
              <h2 className="h-section">{t("run.history")}</h2>
              <ul className="stack" style={{ margin: 0, padding: 0, listStyle: "none", gap: 6 }}>
                {runs.data!.map((r) => (
                  <li key={r.id} className="row">
                    <button type="button" className={`btn small ${r.id === v.id ? "primary" : ""}`} onClick={() => setSelected(r.id)}>{t("common.run", { n: r.run_number })}</button>
                    <span className="small muted">{L.verdict(r.verdict_code)} · {f.date(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
