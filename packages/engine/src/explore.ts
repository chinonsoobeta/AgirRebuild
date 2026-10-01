// Interactive sensitivity (a scratch mode). Every figure here is a real re-run
// of the engine on a shocked copy of a stored run's input. Nothing is saved,
// nothing is signed, and none of it can become a memo, a report or a decision:
// the API returns it to the screen and forgets it.

import type { EngineInput, Metric, Policy, RunResult } from "@agir/contracts";
import { buildLedger } from "./ledger.ts";
import { computeMetrics } from "./metrics.ts";
import { applyStress } from "./stress.ts";
import { underwrite } from "./underwrite.ts";

export type Shock = {
  exitCapBps?: number;
  rentPct?: number;
  occupancyPts?: number;
  costPct?: number;
  expensePts?: number;
  rateBps?: number;
  constructionMonths?: number;
  leaseUpMonths?: number;
};

export type DriverKey = keyof Shock;

export type Driver = {
  key: DriverKey;
  label: string;
  unit: "bps" | "%" | "pts" | "months";
  min: number;
  max: number;
  step: number;
  /** The swing a tornado chart applies each way. */
  swing: number;
  /** +1 when raising the driver is good for the deal, -1 when it hurts. */
  direction: 1 | -1;
};

export const DRIVERS: readonly Driver[] = [
  { key: "exitCapBps", label: "Exit cap rate", unit: "bps", min: -100, max: 200, step: 25, swing: 50, direction: -1 },
  { key: "rentPct", label: "Rents", unit: "%", min: -20, max: 20, step: 2.5, swing: 10, direction: 1 },
  { key: "occupancyPts", label: "Occupancy", unit: "pts", min: -15, max: 5, step: 1, swing: 5, direction: 1 },
  { key: "costPct", label: "Development costs", unit: "%", min: -10, max: 25, step: 2.5, swing: 10, direction: -1 },
  { key: "expensePts", label: "Operating costs", unit: "pts", min: -10, max: 10, step: 1, swing: 5, direction: -1 },
  { key: "rateBps", label: "Interest rates", unit: "bps", min: -200, max: 300, step: 25, swing: 100, direction: -1 },
  { key: "constructionMonths", label: "Construction period", unit: "months", min: -6, max: 12, step: 1, swing: 6, direction: -1 },
  { key: "leaseUpMonths", label: "Lease-up period", unit: "months", min: -6, max: 12, step: 1, swing: 6, direction: -1 },
];

const DRIVER_BY_KEY = new Map(DRIVERS.map((d) => [d.key, d]));

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The stored input with the shock applied. Out-of-range shocks are clamped to each driver's range. */
export function shockInput(input: EngineInput, shock: Shock): EngineInput {
  const s: Required<Shock> = {
    exitCapBps: 0, rentPct: 0, occupancyPts: 0, costPct: 0, expensePts: 0, rateBps: 0, constructionMonths: 0, leaseUpMonths: 0,
  };
  for (const [k, v] of Object.entries(shock) as [DriverKey, number | undefined][]) {
    const d = DRIVER_BY_KEY.get(k);
    if (!d || v === undefined || !Number.isFinite(v)) continue;
    s[k] = clamp(v, d.min, d.max);
  }
  const out = applyStress(input, {
    key: "explore",
    label: "Exploration",
    exitCapBps: s.exitCapBps,
    costPct: s.costPct,
    rateBps: s.rateBps,
    rentPct: s.rentPct,
    occupancyPts: s.occupancyPts,
    expensePts: s.expensePts,
  });
  out.exitCapPct = Math.max(0.25, out.exitCapPct);
  out.senior = { ...out.senior, ratePct: Math.max(0, out.senior.ratePct) };
  if (out.mezzanine) out.mezzanine = { ...out.mezzanine, ratePct: Math.max(0, out.mezzanine.ratePct) };
  const c = clamp(input.constructionMonths + Math.round(s.constructionMonths), 0, 120);
  const l = clamp(input.leaseUpMonths + Math.round(s.leaseUpMonths), 0, 120);
  out.constructionMonths = c;
  out.leaseUpMonths = l;
  // A refinance moves with the timeline so it still falls after stabilization.
  if (input.refinance) {
    const shift = c + l - (input.constructionMonths + input.leaseUpMonths);
    const T = c + l + 12 * input.holdYears - 1;
    out.refinance = { ...out.refinance!, ratePct: Math.max(0, out.refinance!.ratePct), month: clamp(input.refinance.month + shift, c + l, T - 1) };
  }
  return out;
}

/** Base-case metrics only: one ledger, no stresses. Fast enough for charts. */
export function baseMetrics(input: EngineInput): Metric[] {
  return computeMetrics(input, buildLedger(input)).metrics;
}

export type Exploration = Omit<RunResult, "ledger" | "equityFlows">;

/** The whole model, stresses and verdict included, on the shocked input. */
export function explore(input: EngineInput, policy: Policy, shock: Shock): Exploration {
  const r = underwrite(shockInput(input, shock), policy);
  const { ledger: _l, equityFlows: _e, ...rest } = r;
  return rest;
}

export type TornadoRow = { driver: DriverKey; label: string; low: number | null; high: number | null; lowShock: number; highShock: number };

/** Each driver swung down and up by its tornado swing, everything else held. */
export function tornado(input: EngineInput, metricKey: string): { base: number | null; rows: TornadoRow[] } {
  const value = (i: EngineInput) => {
    const m = baseMetrics(i).find((x) => x.key === metricKey);
    if (!m) throw new Error(`Unknown metric "${metricKey}"`);
    return m.status === "VALID" ? m.value : null;
  };
  const base = value(input);
  const rows = DRIVERS.map((d) => ({
    driver: d.key,
    label: d.label,
    lowShock: -d.swing,
    highShock: d.swing,
    low: value(shockInput(input, { [d.key]: -d.swing })),
    high: value(shockInput(input, { [d.key]: d.swing })),
  }));
  const spread = (r: TornadoRow) => Math.abs((r.high ?? base ?? 0) - (r.low ?? base ?? 0));
  rows.sort((a, b) => spread(b) - spread(a));
  return { base, rows };
}

/** A grid of one metric over two drivers, each at `steps` evenly spaced values. */
export function grid(input: EngineInput, metricKey: string, x: DriverKey, y: DriverKey, steps = 5) {
  if (x === y) throw new Error("Choose two different drivers");
  const dx = DRIVER_BY_KEY.get(x)!;
  const dy = DRIVER_BY_KEY.get(y)!;
  const n = Math.max(3, Math.min(9, Math.round(steps)));
  const axis = (d: Driver) => Array.from({ length: n }, (_, i) => -d.swing + (2 * d.swing * i) / (n - 1));
  const xs = axis(dx);
  const ys = axis(dy);
  const cells = ys.map((yv) =>
    xs.map((xv) => {
      const m = baseMetrics(shockInput(input, { [x]: xv, [y]: yv })).find((z) => z.key === metricKey)!;
      return m.status === "VALID" ? m.value : null;
    }),
  );
  return { x, y, xs, ys, cells };
}
