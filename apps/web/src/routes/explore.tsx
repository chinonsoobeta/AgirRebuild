import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, type Metric, type RunView } from "../api";
import { Banner, DealHeader, ErrorText, MetricValue, useDeal, useSession, VerdictBadge } from "../components/ui";
import * as I from "../components/icons";
import { checkText, useI18n, verdictText } from "../i18n";
import { GateOutcome, layoutFor, useRun } from "./run";

type Driver = { key: string; label: string; unit: "bps" | "%" | "pts" | "months"; min: number; max: number; step: number; swing: number; direction: 1 | -1 };
type Exploration = { scenarios: RunView["result"]["scenarios"]; verdict: RunView["result"]["verdict"]; checks: RunView["result"]["checks"] };
type Tornado = { base: number | null; rows: { driver: string; low: number | null; high: number | null; lowShock: number; highShock: number }[] };
type BreakevenRow = { gate: string; driver: string; state: string; shock: number | null; limit: number; actual: number | null; to: { key: string; item?: string; to: number; unit: string }[] };
type Breakeven = { rows: BreakevenRow[]; hardFails: string[] };
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

const INK_DOWN = "#454a55";
const INK_UP = "#9c978a";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

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
        <DealHeader o={deal.data} active="run" />
        <Banner tone="neutral" title={t("explore.noRun")}><Link to="/deals/$dealId/run" params={{ dealId }}>{t("decision.goRun")}</Link></Banner>
      </>
    );
  }
  const runData = run.data;
  const metricOf = (scenarios: Exploration["scenarios"] | undefined, key: string) => scenarios?.[0]?.metrics.find((m) => m.key === key);
  const unitOf = (key: string) => metricOf(runData?.result.scenarios, key)?.unit ?? "x";
  const threshold = (key: string) => runData?.result.verdict.gates.find((x) => x.metricKey === key)?.threshold ?? null;
  const changed = Object.values(shock).some((v) => v !== 0);
  const vt = explored.data ? verdictText(i, explored.data.verdict, explored.data.checks, solo) : null;

  const change = (a: Metric | undefined, b: Metric | undefined) => {
    if (!a || !b || a.value === null || b.value === null) return "—";
    const d = b.value - a.value;
    if (Math.abs(d) < 1e-9) return t("explore.unchanged");
    if (a.unit === "%") return f.delta(d, "pts");
    if (a.unit === "bps") return f.delta(d, "bps");
    const sign = d > 0 ? "+" : "-";
    return `${sign}${f.value(Math.abs(d), a.unit)}`;
  };

  return (
    <>
      <DealHeader o={deal.data} active="run" />
      <Banner tone="review" title={t("explore.banner")}>{t("explore.bannerBody", { n: deal.data.run!.number })}</Banner>

      <div className="two-col">
        <section className="panel stack" style={{ gap: 18 }} aria-labelledby="drivers-h">
          <div className="spread">
            <h2 id="drivers-h" className="h-section">{t("explore.drivers")}</h2>
            <button className="btn quiet small" type="button" disabled={!changed} onClick={() => setShock({})}>{t("explore.reset")}</button>
          </div>
          {(drivers.data ?? []).map((d) => {
            const v = shock[d.key] ?? 0;
            const id = `drv-${d.key}`;
            return (
              <div key={d.key} className="stack" style={{ gap: 4 }}>
                <div className="spread">
                  <label htmlFor={id} style={{ fontWeight: 600, fontSize: 14 }}>{L.driver(d.key)}</label>
                  <output htmlFor={id} className="num" style={{ fontSize: 14, color: v === 0 ? "var(--ink-3)" : "var(--ink)" }}>{v === 0 ? t("explore.unchanged") : f.delta(v, d.unit)}</output>
                </div>
                <input
                  id={id}
                  type="range"
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  value={v}
                  onChange={(e) => setShock({ ...shock, [d.key]: Number(e.target.value) })}
                  style={{ width: "100%", accentColor: "var(--ink)", height: 28 }}
                  aria-valuetext={v === 0 ? t("explore.unchanged") : f.delta(v, d.unit)}
                />
                <div className="spread small faint num"><span>{f.delta(d.min, d.unit)}</span><span>{f.delta(d.max, d.unit)}</span></div>
              </div>
            );
          })}
        </section>

        <section className="stack" style={{ gap: 20, position: "sticky", top: 24, alignSelf: "start" }} aria-live="polite" aria-busy={explored.isFetching}>
          <div className="panel stack" style={{ gap: 10 }}>
            <div className="spread">
              <span className="label">{t("explore.verdictNow")}</span>
              {explored.isFetching && <span className="small faint">{t("explore.working")}</span>}
            </div>
            {explored.data && vt && (
              <>
                <VerdictBadge code={explored.data.verdict.code} />
                <p className="serif" style={{ fontSize: 24, lineHeight: 1.25 }}>{vt.headline}</p>
                <p className="small muted">{vt.explanation}</p>
                <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 6 }}>
                  {explored.data.verdict.gates.map((gate) => (
                    <li key={gate.key} className="small" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 12, alignItems: "center" }}>
                      <span>{L.gate(gate.key, gate.label)}</span>
                      <span className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                        <span className="num">{gate.actual === null ? "—" : f.value(gate.actual, gate.unit)}</span>
                        <GateOutcome status={gate.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <ErrorText error={explored.error} />
          </div>
        </section>
      </div>

      <section className="stack" style={{ gap: 12 }}>
        <h2 className="h-section">{t("explore.results")}</h2>
        <table className="tbl">
          <thead><tr><th>{t("explore.col.metric")}</th><th className="r">{t("explore.col.run")}</th><th className="r">{t("explore.col.explored")}</th><th className="r">{t("explore.col.change")}</th></tr></thead>
          <tbody>
            {layout.compare.map((k) => {
              const a = metricOf(runData?.result.scenarios, k);
              const b = metricOf(explored.data?.scenarios, k);
              return (
                <tr key={k}>
                  <th scope="row">{L.metric(k)}</th>
                  <td className="r">{a && <MetricValue {...a} />}</td>
                  <td className="r" style={{ fontWeight: 600 }}>{b && <MetricValue {...b} />}</td>
                  <td className="r num small muted">{change(a, b)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

      <BreakevenTables data={breakeven.data} gates={runData?.result.verdict.gates ?? []} checks={runData?.result.checks ?? []} error={breakeven.error} />

      <section className="stack" style={{ gap: 12 }} aria-labelledby="grid-h">
        <h2 id="grid-h" className="h-section">{t("explore.grid")}</h2>
        <div className="row" style={{ alignItems: "flex-end" }}>
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
        <p className="small muted">
          {threshold(g.metric) !== null ? t("explore.gridBody", { t: f.value(threshold(g.metric)!, unitOf(g.metric)) }) : t("explore.gridBodyNone")}
        </p>
        {grid.data && (
          <GridTable grid={grid.data} drivers={drivers.data ?? []} unit={unitOf(g.metric)} threshold={threshold(g.metric)} metric={g.metric} />
        )}
        <ErrorText error={grid.error} />
      </section>
    </>
  );
}

function BreakevenTables({ data, gates, checks, error }: { data?: Breakeven; gates: RunView["result"]["verdict"]["gates"]; checks: RunView["result"]["checks"]; error: unknown }) {
  const i = useI18n();
  const { t, f, L } = i;
  const failing = gates.filter((x) => x.status === "failed");
  return (
    <section className="stack" style={{ gap: 12 }} aria-labelledby="be-h">
      <div className="stack" style={{ gap: 4 }}>
        <h2 id="be-h" className="h-section">{t("explore.be.title")}</h2>
        <p className="small muted" style={{ maxWidth: 720 }}>{t("explore.be.body")}</p>
      </div>
      <ErrorText error={error} />
      {data && data.hardFails.length > 0 && (
        <Banner tone="stop" title={t("explore.be.hardFail")}>{checks.filter((c) => c.severity === "error").map((c) => checkText(i, c)).join(" ")}</Banner>
      )}
      {data && failing.length === 0 && <p className="small muted">{t("explore.be.none")}</p>}
      {data && failing.map((gate) => (
        <table key={gate.key} className="tbl">
          <caption className="small muted" style={{ captionSide: "top", textAlign: "left", paddingBottom: 6 }}>
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
      ))}
    </section>
  );
}

function TornadoChart({ data, drivers, chartMetrics, metric, unit, onMetric, error }: { data?: Tornado; chartMetrics: string[]; drivers: Driver[]; metric: string; unit: string; onMetric: (m: string) => void; error: unknown }) {
  const { t, f, L } = useI18n();
  const [hover, setHover] = useState<string | null>(null);
  const unitOfDriver = (key: string) => drivers.find((d) => d.key === key)?.unit ?? "%";
  const scale = useMemo(() => {
    if (!data || data.base === null) return 1;
    const devs = data.rows.flatMap((r) => [r.low, r.high].filter((v): v is number => v !== null).map((v) => Math.abs(v - data.base!)));
    return Math.max(...devs, 1e-9);
  }, [data]);
  return (
    <section className="stack" style={{ gap: 12 }} aria-labelledby="tornado-h">
      <div className="spread" style={{ alignItems: "flex-end" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h2 id="tornado-h" className="h-section">{t("explore.tornado")}</h2>
          <p className="small muted" style={{ maxWidth: 720 }}>{t("explore.tornadoBody")}</p>
        </div>
        <div className="field"><label htmlFor="t-metric">{t("explore.metric")}</label>
          <select className="select" id="t-metric" value={metric} onChange={(e) => onMetric(e.target.value)}>{chartMetrics.map((m) => <option key={m} value={m}>{L.metric(m)}</option>)}</select>
        </div>
      </div>
      <ErrorText error={error} />
      {data && data.base !== null && (
        <div className="panel stack" style={{ gap: 6 }}>
          <div className="row small muted" style={{ gap: 18 }}>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, background: INK_DOWN, borderRadius: 2 }} />{t("explore.lowers")}</span>
            <span className="row" style={{ gap: 6 }}><span style={{ width: 12, height: 12, background: INK_UP, borderRadius: 2 }} />{t("explore.raises")}</span>
            <span className="num">{t("explore.base", { v: f.value(data.base, unit) })}</span>
          </div>
          {data.rows.map((r) => {
            const du = unitOfDriver(r.driver);
            const side = (v: number | null, shockV: number) => {
              if (v === null) return null;
              const d = v - data.base!;
              const w = (Math.abs(d) / scale) * 50;
              const down = d < 0;
              return { w, down, v, shockV };
            };
            const lo = side(r.low, r.lowShock);
            const hi = side(r.high, r.highShock);
            const bar = (b: ReturnType<typeof side>, key: string) =>
              b && b.w > 0 ? (
                <div
                  key={key}
                  title={`${L.driver(r.driver)} ${f.delta(b.shockV, du)}: ${f.value(b.v, unit)}`}
                  style={{
                    position: "absolute",
                    top: 6,
                    height: 16,
                    [b.down ? "right" : "left"]: "50%",
                    width: `${b.w}%`,
                    background: b.down ? INK_DOWN : INK_UP,
                    borderRadius: b.down ? "4px 0 0 4px" : "0 4px 4px 0",
                  }}
                />
              ) : null;
            const label = (b: ReturnType<typeof side>) => (b ? `${f.delta(b.shockV, du)} → ${f.value(b.v, unit)}` : t("common.notMeaningful"));
            const left = [lo, hi].find((b) => b?.down) ?? null;
            const right = [lo, hi].find((b) => b && !b.down) ?? null;
            return (
              <div
                key={r.driver}
                style={{ display: "grid", gridTemplateColumns: "180px minmax(0, 1fr)", alignItems: "center", gap: 12, padding: "4px 0", background: hover === r.driver ? "var(--sunken)" : undefined, borderRadius: 4 }}
                onMouseEnter={() => setHover(r.driver)}
                onMouseLeave={() => setHover(null)}
              >
                <span style={{ fontSize: 14 }}>{L.driver(r.driver)}</span>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 3fr) minmax(0, 1fr)", alignItems: "center", gap: 8 }}>
                  <span className="num small muted" style={{ textAlign: "right" }}>{left ? label(left) : ""}</span>
                  <div style={{ position: "relative", height: 28 }}>
                    <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--ink)" }} />
                    {bar(lo, "lo")}
                    {bar(hi, "hi")}
                  </div>
                  <span className="num small muted">{right ? label(right) : ""}</span>
                </div>
              </div>
            );
          })}
          <details style={{ marginTop: 8 }}>
            <summary style={{ fontSize: 14 }}>{t("explore.table")}</summary>
            <table className="tbl" style={{ marginTop: 10 }}>
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
          </details>
        </div>
      )}
    </section>
  );
}

function GridTable({ grid, drivers, unit, threshold, metric }: { grid: Grid; drivers: Driver[]; unit: string; threshold: number | null; metric: string }) {
  const { t, f, L } = useI18n();
  const du = (key: string) => drivers.find((d) => d.key === key)?.unit ?? "%";
  const mid = Math.floor(grid.xs.length / 2);
  return (
    <table className="tbl" style={{ width: "auto" }}>
      <thead>
        <tr>
          <th scope="col">{L.driver(grid.y)} \ {L.driver(grid.x)}</th>
          {grid.xs.map((x) => <th key={x} scope="col" className="r num">{x === 0 ? "0" : f.delta(x, du(grid.x))}</th>)}
        </tr>
      </thead>
      <tbody>
        {grid.ys.map((y, r) => (
          <tr key={y}>
            <th scope="row" className="num">{y === 0 ? "0" : f.delta(y, du(grid.y))}</th>
            {grid.cells[r]!.map((v, c) => {
              const below = threshold !== null && v !== null && v < threshold;
              const isBase = r === mid && c === mid;
              return (
                <td
                  key={c}
                  className="r num"
                  title={`${L.driver(grid.x)} ${f.delta(grid.xs[c]!, du(grid.x))}, ${L.driver(grid.y)} ${f.delta(y, du(grid.y))}: ${v === null ? t("common.notMeaningful") : f.value(v, unit)}`}
                  style={{
                    background: below ? "var(--stop-tint)" : undefined,
                    color: below ? "var(--stop-text)" : undefined,
                    outline: isBase ? "2px solid var(--ink)" : undefined,
                    outlineOffset: -2,
                    minWidth: 110,
                  }}
                >
                  {below && <span className="sr-only">{t("explore.belowGate")}: </span>}
                  {below && <I.Cross size={11} />} {v === null ? <span className="not-meaningful">{t("common.notMeaningful")}</span> : f.value(v, unit)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
      <caption className="small faint" style={{ captionSide: "bottom", textAlign: "left", paddingTop: 8 }}>{L.metric(metric)}</caption>
    </table>
  );
}
