import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api, type Metric, type RunView } from "../api";
import { Banner, DealFrame, ErrorText, MetricValue, useDeal, useSession } from "../components/ui";
import { Tag, type TagTone } from "../components/kit";
import * as I from "../components/icons";
import { checkText, useI18n, verdictText } from "../i18n";
import { GateOutcome, layoutFor, useRun } from "./run";

type Driver = { key: string; label: string; unit: "bps" | "%" | "pts" | "months"; min: number; max: number; step: number; swing: number; direction: 1 | -1 };
type Exploration = { scenarios: RunView["result"]["scenarios"]; verdict: RunView["result"]["verdict"]; checks: RunView["result"]["checks"] };
type Tornado = { base: number | null; rows: { driver: string; low: number | null; high: number | null; lowShock: number; highShock: number }[] };
type BreakevenRow = { gate: string; driver: string; state: string; shock: number | null; limit: number; actual: number | null; to: { key: string; item?: string; to: number; unit: string }[] };
type Breakeven = { rows: BreakevenRow[]; hardFails: string[] };
type Gate = RunView["result"]["verdict"]["gates"][number];
type Grid = { x: string; y: string; xs: number[]; ys: number[]; cells: (number | null)[][] };

const COMPARE = ["yield_on_cost", "development_spread", "profit_on_cost", "equity_multiple", "equity_irr", "sizing_dscr", "contractual_dscr", "total_development_cost", "required_equity", "exit_value"];
const CHART_METRICS = ["equity_multiple", "equity_irr", "profit_on_cost", "sizing_dscr", "yield_on_cost", "development_spread", "development_profit"];
export function exploreLayoutFor(sale: boolean) {
  return sale ? {
    compare: ["profit_on_cost_for_sale", "margin_on_revenue", "development_profit_for_sale", "equity_multiple", "equity_irr", "total_development_cost", "required_equity", "peak_equity", "loan_to_cost"],
    chartMetrics: ["profit_on_cost_for_sale", "margin_on_revenue", "development_profit_for_sale", "equity_multiple", "equity_irr"],
    tornadoMetric: "profit_on_cost_for_sale",
    grid: { metric: "profit_on_cost_for_sale", x: "rateBps", y: "pricePct" },
  } : { compare: COMPARE, chartMetrics: CHART_METRICS, tornadoMetric: "equity_multiple",
    grid: { metric: "sizing_dscr", x: "rateBps", y: "rentPct" } };
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}


const VERDICT_TONE: Record<string, TagTone> = { APPROVE: "pass", APPROVE_WITH_CONDITIONS: "review", REJECT: "stop" };

export function Explore({ dealId }: { dealId: string }) {
  const i = useI18n();
  const { solo } = useSession();
  const { t, f, L } = i;
  const deal = useDeal(dealId);
  const runId = deal.data?.run?.id;
  const run = useRun(runId);
  const sale = run.data ? layoutFor(run.data.result.scenarios[0]!.metrics).sale : false;
  const layout = exploreLayoutFor(sale);
  const canExplore = Boolean(run.data);
  const drivers = useQuery({ queryKey: ["drivers", runId], queryFn: () => api.get<Driver[]>(`/runs/${runId}/drivers`), staleTime: Infinity, enabled: canExplore });
  const [shock, setShock] = useState<Record<string, number>>({});
  const debounced = useDebounced(shock, 250);
  const explored = useQuery({
    queryKey: ["explore", runId, debounced],
    queryFn: () => api.post<Exploration>(`/runs/${runId}/explore`, { shock: debounced }),
    enabled: canExplore,
    placeholderData: (prev) => prev,
  });
  const [tChoice, setTChoice] = useState<{ sale: boolean; metric: string } | null>(null);
  const tMetric = tChoice?.sale === sale ? tChoice.metric : layout.tornadoMetric;
  const setTMetric = (metric: string) => setTChoice({ sale, metric });
  const tornado = useQuery({ queryKey: ["tornado", runId, tMetric], queryFn: () => api.post<Tornado>(`/runs/${runId}/tornado`, { metric: tMetric }), enabled: canExplore });
  const breakeven = useQuery({ queryKey: ["breakeven", runId], queryFn: () => api.post<Breakeven>(`/runs/${runId}/breakeven`, {}), enabled: canExplore });
  const [gChoice, setGChoice] = useState<{ sale: boolean; value: { metric: string; x: string; y: string } } | null>(null);
  const g = gChoice?.sale === sale ? gChoice.value : layout.grid;
  const setG = (value: typeof g) => setGChoice({ sale, value });
  const grid = useQuery({ queryKey: ["grid", runId, g], queryFn: () => api.post<Grid>(`/runs/${runId}/grid`, { ...g, steps: 5 }), enabled: canExplore && g.x !== g.y, placeholderData: (prev) => prev });

  if (!deal.data) return <p className="muted">{t("common.loading")}</p>;
  if (!runId) {
    return (
      <>
        <DealFrame o={deal.data} active="run" />
        <div className="stack">
          <Banner tone="neutral" title={t("explore.noRun")}><Link to="/deals/$dealId/run" params={{ dealId }}>{t("decision.goRun")}</Link></Banner>
        </div>
      </>
    );
  }
  const runNo = deal.data.run!.number;
  const runData = run.data;
  const metricOf = (scenarios: Exploration["scenarios"] | undefined, key: string) => scenarios?.[0]?.metrics.find((m) => m.key === key);
  const unitOf = (key: string) => metricOf(runData?.result.scenarios, key)?.unit ?? "x";
  const threshold = (key: string) => runData?.result.verdict.gates.find((x) => x.metricKey === key)?.threshold ?? null;
  const changed = Object.values(shock).some((v) => v !== 0);
  const vt = explored.data ? verdictText(i, explored.data.verdict, explored.data.checks, solo) : null;
  const baseKey = runData?.result.scenarios[0]?.key;
  const runGates = runData?.result.verdict.gates ?? [];
  const baseGate = (metricKey: string) => runGates.find((x) => x.scenario === baseKey && x.metricKey === metricKey);
  const exploredGate = (key: string) => explored.data?.verdict.gates.find((x) => x.key === key);
  const otherGates = runGates.filter((x) => !(x.scenario === baseKey && layout.compare.includes(x.metricKey)));

  const change = (a: number | null | undefined, b: number | null | undefined, unit: string) => {
    if (a === null || a === undefined || b === null || b === undefined) return "—";
    const d = b - a;
    if (Math.abs(d) < 1e-9) return t("explore.unchanged");
    if (unit === "%") return f.delta(d, "pts");
    if (unit === "bps") return f.delta(d, "bps");
    const sign = d > 0 ? "+" : "-";
    return `${sign}${f.value(Math.abs(d), unit)}`;
  };
  const needs = (gate: Gate) => <span className="sub">{t("explore.gateNeeds", { t: f.value(gate.threshold, gate.unit) })}</span>;
  const exploredCell = (gate: Gate | undefined, value: React.ReactNode) => (
    <td className={gate?.status === "failed" ? "r explore-fail" : "r"}>
      {value}
      {gate && <span className="explore-cell-gate"><GateOutcome status={gate.status} /></span>}
    </td>
  );

  return (
    <>
      <DealFrame o={deal.data} active="run" />
      <div className="stack explore">
        <div className="page-head explore-head">
          <div>
            <h2 className="h1">{t("explore.title")}</h2>
            <p className="lead">{t("explore.banner")} {t("explore.bannerBody", { n: runNo })}</p>
          </div>
          <Link className="btn quiet" to="/deals/$dealId/run" params={{ dealId }}>{t("explore.back", { n: runNo })}</Link>
        </div>

        <div className="with-aside explore-main">
          <section className="card card-pad stack explore-drivers" aria-labelledby="drivers-h">
            <div className="row between">
              <h3 id="drivers-h" className="h2">{t("explore.drivers")}</h3>
              <button className="btn ghost sm" type="button" disabled={!changed} onClick={() => setShock({})}>{t("explore.reset")}</button>
            </div>
            {(drivers.data ?? []).map((d) => {
              const v = shock[d.key] ?? 0;
              const id = `drv-${d.key}`;
              const now = v === 0 ? t("explore.unchanged") : f.delta(v, d.unit);
              return (
                <div key={d.key} className="field">
                  <div className="row between">
                    <label htmlFor={id}>{L.driver(d.key)}</label>
                    <output htmlFor={id} className="num">{now}{v !== 0 && <span className="muted"> {t("explore.runShock")}</span>}</output>
                  </div>
                  <input
                    id={id}
                    className="range"
                    type="range"
                    min={d.min}
                    max={d.max}
                    step={d.step}
                    value={v}
                    onChange={(e) => setShock({ ...shock, [d.key]: Number(e.target.value) })}
                    aria-valuetext={now}
                  />
                  <div className="explore-ends num"><span>{f.delta(d.min, d.unit)}</span><span>{f.delta(d.max, d.unit)}</span></div>
                </div>
              );
            })}
            <p className="small muted">{t("explore.helper")}</p>
          </section>

          <div className="stack">
            <section className="card" aria-labelledby="changes-h" aria-live="polite" aria-busy={explored.isFetching}>
              <div className="card-head">
                <h3 id="changes-h" className="h2">{t("explore.results")}</h3>
                <div className="row">
                  {explored.isFetching && <span className="small muted">{t("explore.working")}</span>}
                  {explored.data && <Tag tone={VERDICT_TONE[explored.data.verdict.code] ?? "neutral"}>{t("explore.verdictWith", { v: L.verdict(explored.data.verdict.code) })}</Tag>}
                </div>
              </div>
              <div className="scroll">
                <table className="table">
                  <thead><tr><th>{t("explore.col.metric")}</th><th className="r">{t("explore.col.run")}</th><th className="r">{t("explore.col.explored")}</th><th className="r">{t("explore.col.change")}</th></tr></thead>
                  <tbody>
                    {layout.compare.map((k) => {
                      const a = metricOf(runData?.result.scenarios, k);
                      const b = metricOf(explored.data?.scenarios, k);
                      const gate = baseGate(k);
                      return (
                        <tr key={k}>
                          <th scope="row">{L.metric(k)}{gate && needs(gate)}</th>
                          <td className="r">{a && <MetricValue {...a} />}</td>
                          {exploredCell(gate && exploredGate(gate.key), b && <MetricValue {...b} />)}
                          <td className="r num">{change(a?.value, b?.value, a?.unit ?? "x")}</td>
                        </tr>
                      );
                    })}
                    {otherGates.map((gate) => {
                      const eg = exploredGate(gate.key);
                      return (
                        <tr key={gate.key}>
                          <th scope="row">{L.gate(gate.key, gate.label)}{needs(gate)}</th>
                          <td className="r num">{gate.actual === null ? "—" : f.value(gate.actual, gate.unit)}</td>
                          {exploredCell(eg, eg && <span className="num">{eg.actual === null ? "—" : f.value(eg.actual, eg.unit)}</span>)}
                          <td className="r num">{change(gate.actual, eg?.actual, gate.unit)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(vt || explored.error) && (
                <div className="card-foot small muted">
                  {vt && <>{vt.headline} {vt.explanation}</>}
                  <ErrorText error={explored.error} />
                </div>
              )}
            </section>

            <TornadoChart
              data={tornado.data}
              drivers={drivers.data ?? []}
              chartMetrics={layout.chartMetrics}
              metric={tMetric}
              unit={unitOf(tMetric)}
              onMetric={setTMetric}
              error={tornado.error}
            />
          </div>
        </div>

        <section className="card card-pad stack tight" aria-labelledby="grid-h">
          <h3 id="grid-h" className="h2">{t("explore.grid")}</h3>
          <div className="explore-controls">
            <div className="field"><label htmlFor="g-metric">{t("explore.metric")}</label>
              <select className="select" id="g-metric" value={g.metric} onChange={(e) => setG({ ...g, metric: e.target.value })}>{layout.chartMetrics.map((m) => <option key={m} value={m}>{L.metric(m)}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="g-x">{t("explore.across")}</label>
              <select className="select" id="g-x" value={g.x} onChange={(e) => setG({ ...g, x: e.target.value })}>{(drivers.data ?? []).filter((d) => d.key !== g.y).map((d) => <option key={d.key} value={d.key}>{L.driver(d.key)}</option>)}</select>
            </div>
            <div className="field"><label htmlFor="g-y">{t("explore.down")}</label>
              <select className="select" id="g-y" value={g.y} onChange={(e) => setG({ ...g, y: e.target.value })}>{(drivers.data ?? []).filter((d) => d.key !== g.x).map((d) => <option key={d.key} value={d.key}>{L.driver(d.key)}</option>)}</select>
            </div>
          </div>
          <p className="muted">
            {threshold(g.metric) !== null ? t("explore.gridBody", { t: f.value(threshold(g.metric)!, unitOf(g.metric)) }) : t("explore.gridBodyNone")} {t("explore.gridBase", { n: runNo })}
          </p>
          {grid.data && (
            <GridTable grid={grid.data} drivers={drivers.data ?? []} unit={unitOf(g.metric)} threshold={threshold(g.metric)} metric={g.metric} />
          )}
          <ErrorText error={grid.error} />
        </section>

        <BreakevenTables data={breakeven.data} gates={runGates} checks={runData?.result.checks ?? []} runNo={runNo} error={breakeven.error} />
      </div>
    </>
  );
}

function BreakevenTables({ data, gates, checks, runNo, error }: { data?: Breakeven; gates: Gate[]; checks: RunView["result"]["checks"]; runNo: number; error: unknown }) {
  const i = useI18n();
  const { t, f, L } = i;
  const failing = gates.filter((x) => x.status === "failed");
  return (
    <section className="card card-pad stack tight" aria-labelledby="be-h">
      <h3 id="be-h" className="h2">{t("explore.be.title")}</h3>
      <ErrorText error={error} />
      {data && data.hardFails.length > 0 && (
        <Banner tone="stop" title={t("explore.be.hardFail")}>{checks.filter((c) => c.severity === "error").map((c) => checkText(i, c)).join(" ")}</Banner>
      )}
      {data && <p className="muted">{failing.length === 0 ? t("explore.be.noneRun", { n: runNo }) : t("explore.be.body")}</p>}
      {data && failing.map((gate) => (
        <div key={gate.key} className="scroll">
          <table className="table">
            <caption className="explore-caption">
              <strong>{L.gate(gate.key, gate.label)}</strong>. {t("explore.be.gateNow", { v: gate.actual === null ? f.value(null, gate.unit) : f.value(gate.actual, gate.unit), t: f.value(gate.threshold, gate.unit) })}
            </caption>
            <thead><tr><th>{t("explore.be.col.input")}</th><th>{t("explore.be.col.needs")}</th><th className="r">{t("explore.be.col.gate")}</th></tr></thead>
            <tbody>
              {data.rows.filter((r) => r.gate === gate.key).map((r) => (
                <tr key={r.driver}>
                  <th scope="row">{L.driver(r.driver)}</th>
                  <td>{L.breakeven(r, gate)}</td>
                  <td className="r num">{r.actual === null ? "—" : f.value(r.actual, gate.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function TornadoChart({ data, drivers, chartMetrics, metric, unit, onMetric, error }: { data?: Tornado; chartMetrics: string[]; drivers: Driver[]; metric: string; unit: string; onMetric: (m: string) => void; error: unknown }) {
  const { t, f, L } = useI18n();
  const unitOfDriver = (key: string) => drivers.find((d) => d.key === key)?.unit ?? "%";
  const scale = useMemo(() => {
    if (!data || data.base === null) return 1;
    const devs = data.rows.flatMap((r) => [r.low, r.high].filter((v): v is number => v !== null).map((v) => Math.abs(v - data.base!)));
    return Math.max(...devs, 1e-9);
  }, [data]);
  const base = data?.base ?? null;
  return (
    <section className="card card-pad stack tight" aria-labelledby="tornado-h">
      <div className="row between">
        <h3 id="tornado-h" className="h2">{t("explore.tornado")}</h3>
        <div className="row">
          <label htmlFor="t-metric" className="small muted">{t("explore.metric")}</label>
          <select className="select explore-select" id="t-metric" value={metric} onChange={(e) => onMetric(e.target.value)}>{chartMetrics.map((m) => <option key={m} value={m}>{L.metric(m)}</option>)}</select>
        </div>
      </div>
      <p className="muted">{t("explore.tornadoBody")}{base !== null && <> {t("explore.base", { v: f.value(base, unit) })}.</>}</p>
      <ErrorText error={error} />
      {data && base !== null && (
        <>
          <div className="tor">
            {data.rows.map((r) => {
              const du = unitOfDriver(r.driver);
              const devs = [r.low, r.high].filter((v): v is number => v !== null).map((v) => v - base);
              const down = Math.max(0, ...devs.filter((d) => d < 0).map((d) => (-d / scale) * 50));
              const up = Math.max(0, ...devs.filter((d) => d > 0).map((d) => (d / scale) * 50));
              const text = (v: number | null, s: number) => `${f.delta(s, du)} → ${v === null ? t("common.notMeaningful") : f.value(v, unit)}`;
              const label = t("explore.barLabel", { d: L.driver(r.driver), lo: text(r.low, r.lowShock), hi: text(r.high, r.highShock) });
              return (
                <Fragment key={r.driver}>
                  <span>{L.driver(r.driver)}<span className="small muted explore-block">{t("explore.swing", { lo: f.delta(r.lowShock, du), hi: f.delta(r.highShock, du) })}</span></span>
                  <span className="bar" role="img" aria-label={label} title={label}>
                    {down > 0 && <span className="lo" style={{ width: `${down}%` }} />}
                    {up > 0 && <span className="hi" style={{ width: `${up}%` }} />}
                    <span className="mid" />
                  </span>
                </Fragment>
              );
            })}
          </div>
          <div className="explore-legend">
            <span><span className="explore-swatch down" aria-hidden="true" />{t("explore.lowers")}</span>
            <span><span className="explore-swatch up" aria-hidden="true" />{t("explore.raises")}</span>
          </div>
          <details>
            <summary>{t("explore.table")}</summary>
            <div className="scroll">
              <table className="table">
                <thead><tr><th>{t("explore.be.col.input")}</th><th className="r">{t("explore.torLow")}</th><th className="r">{t("explore.torHigh")}</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.driver}>
                      <th scope="row">{L.driver(r.driver)}</th>
                      <td className="r num">{f.delta(r.lowShock, unitOfDriver(r.driver))}: {r.low === null ? t("common.notMeaningful") : f.value(r.low, unit)}</td>
                      <td className="r num">{f.delta(r.highShock, unitOfDriver(r.driver))}: {r.high === null ? t("common.notMeaningful") : f.value(r.high, unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function GridTable({ grid, drivers, unit, threshold, metric }: { grid: Grid; drivers: Driver[]; unit: string; threshold: number | null; metric: string }) {
  const { t, f, L } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const du = (key: string) => drivers.find((d) => d.key === key)?.unit ?? "%";
  const mid = Math.floor(grid.xs.length / 2);
  return (
    <>
      <div className="row">
        <button className="btn ghost sm" type="button" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{t(asTable ? "explore.showGrid" : "explore.table")}</button>
      </div>
      <div className="scroll">
        <table className={asTable ? "table" : "explore-heat"}>
          <caption className="explore-caption">{L.metric(metric)}</caption>
          <thead>
            <tr>
              <th scope="col">{L.driver(grid.y)} \ {L.driver(grid.x)}</th>
              {grid.xs.map((x) => <th key={x} scope="col" className="r num">{x === 0 ? t("explore.asRun") : f.delta(x, du(grid.x))}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.ys.map((y, r) => (
              <tr key={y}>
                <th scope="row" className="num">{y === 0 ? t("explore.asRun") : f.delta(y, du(grid.y))}</th>
                {grid.cells[r]!.map((v, c) => {
                  const below = threshold !== null && v !== null && v < threshold;
                  const isBase = r === mid && c === mid;
                  const cls = asTable ? `r num${below ? " explore-fail" : ""}${isBase ? " explore-base" : ""}` : `cell${below ? " fail" : ""}${isBase ? " base" : ""}`;
                  return (
                    <td
                      key={c}
                      className={cls}
                      title={`${L.driver(grid.x)} ${f.delta(grid.xs[c]!, du(grid.x))}, ${L.driver(grid.y)} ${f.delta(y, du(grid.y))}: ${v === null ? t("common.notMeaningful") : f.value(v, unit)}`}
                    >
                      {below && <><I.Cross size={11} /><span className="sr-only">{t("explore.belowGate")}: </span></>}
                      {v === null ? <span className="not-meaningful">{t("common.notMeaningful")}</span> : f.value(v, unit)}
                      {isBase && <span className="sr-only"> ({t("explore.col.run")})</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
