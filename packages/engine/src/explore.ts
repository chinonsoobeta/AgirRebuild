// Interactive sensitivity (a scratch mode). Every figure here is a real re-run
// of the engine on a shocked copy of a stored run's input. Nothing is saved,
// nothing is signed, and none of it can become a memo, a report or a decision:
// the API returns it to the screen and forgets it.

import type { EngineInput, Metric, Policy, RunResult } from "@agir/contracts";
import { runChecks } from "./checks.ts";
import { buildLedger } from "./ledger.ts";
import { computeMetrics } from "./metrics.ts";
import { applyStress } from "./stress.ts";
import { underwrite } from "./underwrite.ts";
import { validateInput } from "./validate.ts";
import { gateSpecs, gateStatusOf, type GateSpec } from "./verdict.ts";

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
  return shockWithin(input, shock, {});
}

/** `shockInput` with its own clamps for some drivers (breakeven searches wider than the charts do). */
function shockWithin(input: EngineInput, shock: Shock, limits: Partial<Record<DriverKey, [number, number]>>): EngineInput {
  const s: Required<Shock> = {
    exitCapBps: 0, rentPct: 0, occupancyPts: 0, costPct: 0, expensePts: 0, rateBps: 0, constructionMonths: 0, leaseUpMonths: 0,
  };
  for (const [k, v] of Object.entries(shock) as [DriverKey, number | undefined][]) {
    const d = DRIVER_BY_KEY.get(k);
    if (!d || v === undefined || !Number.isFinite(v)) continue;
    s[k] = clamp(v, ...(limits[k] ?? [d.min, d.max]));
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

// ---- Breakeven ------------------------------------------------------------------------------
// For each gate that fails, the smallest move in one driver's good direction that makes it pass,
// everything else held. Scratch mode like the rest: real reruns on a shocked copy, nothing kept.

export type BreakevenState = "value" | "out_of_range" | "no_effect" | "not_monotonic";
export type BreakevenEcho = { key: "rent" | "cost" | "exit_cap" | "senior_rate" | "mezzanine_rate" | "refinance_rate" | "occupancy"; item?: string; from: number; to: number; unit: "$/unit/mo" | "$/sf/yr" | "$" | "%" };
export type BreakevenRow = {
  gate: string;
  driver: DriverKey;
  state: BreakevenState;
  /** The signed move, in the driver's unit: a number only for `value`. */
  shock: number | null;
  /** The furthest signed move searched. */
  limit: number;
  /** The gate's own figure at the move: a number only for `value`. */
  actual: number | null;
  /** The shocked inputs in the deal's own terms. Empty unless `value`. */
  to: BreakevenEcho[];
  /** Why there is no number, for every state but `value`. */
  reason?: string;
};

const BREAKEVEN_DRIVERS = ["rentPct", "exitCapBps", "costPct", "rateBps", "occupancyPts"] as const;
const BREAKEVEN_STEP: Record<(typeof BREAKEVEN_DRIVERS)[number], number> = { rentPct: 0.1, exitCapBps: 1, costPct: 0.1, rateBps: 1, occupancyPts: 0.1 };
const UNIT_SUFFIX = { "%": "%", bps: " bps", pts: " pts" } as const;
const NOT_STEADY = "The gate does not move steadily with this input; use the grid.";

type Probe = (n: number) => { pass: boolean; value: number | null };

/**
 * Find the first step `n` in 1..N where `probe` passes. Samples eighths of the range to look for a gate
 * that does not move steadily, bisects between the last failing and first passing sample, then checks the
 * answer: it passes, and one step short of it fails.
 */
export function solveBreakeven(probe: Probe, N: number): { state: BreakevenState; n?: number } {
  if (N < 1) return { state: "no_effect" };
  const ns = [...new Set(Array.from({ length: 9 }, (_, k) => Math.round((N * k) / 8)))];
  const at = ns.map((n) => ({ n, ...probe(n) }));
  const first = at.findIndex((a) => a.pass);
  if (first === 0) return { state: "not_monotonic" };
  if (first < 0) return at.every((a) => a.value === at[0]!.value) ? { state: "no_effect" } : { state: "out_of_range" };
  if (at.slice(first).some((a) => !a.pass)) return { state: "not_monotonic" };
  let lo = at[first - 1]!.n;
  let hi = at[first]!.n;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (probe(mid).pass) hi = mid;
    else lo = mid;
  }
  return probe(hi).pass && !probe(hi - 1).pass ? { state: "value", n: hi } : { state: "not_monotonic" };
}

function echoes(driver: DriverKey, before: EngineInput, after: EngineInput): BreakevenEcho[] {
  const cost = (i: EngineInput) => i.budget.land + i.budget.hard + i.budget.soft + i.budget.contingency + i.budget.other;
  switch (driver) {
    case "rentPct":
      return after.revenue.flatMap((c, k): BreakevenEcho[] => {
        const b = before.revenue[k]!;
        return c.rentMonthly !== undefined
          ? [{ key: "rent" as const, item: c.label, from: b.rentMonthly!, to: c.rentMonthly, unit: "$/unit/mo" as const }]
          : c.rentPsfAnnual !== undefined
            ? [{ key: "rent" as const, item: c.label, from: b.rentPsfAnnual!, to: c.rentPsfAnnual, unit: "$/sf/yr" as const }]
            : [];
      });
    case "costPct":
      return [{ key: "cost", from: cost(before), to: cost(after), unit: "$" }];
    case "exitCapBps":
      return [{ key: "exit_cap", from: before.exitCapPct, to: after.exitCapPct, unit: "%" }];
    case "occupancyPts":
      return [{ key: "occupancy", from: before.stabilizedOccupancyPct, to: after.stabilizedOccupancyPct, unit: "%" }];
    default:
      return [
        ...(before.senior.amount > 0 ? [{ key: "senior_rate" as const, from: before.senior.ratePct, to: after.senior.ratePct, unit: "%" as const }] : []),
        ...(before.mezzanine ? [{ key: "mezzanine_rate" as const, from: before.mezzanine.ratePct, to: after.mezzanine!.ratePct, unit: "%" as const }] : []),
        ...(before.refinance ? [{ key: "refinance_rate" as const, from: before.refinance.ratePct, to: after.refinance!.ratePct, unit: "%" as const }] : []),
      ];
  }
}

/** One gate's metric on the input, in the scenario the gate reads, and nothing else. */
function gateMetric(input: EngineInput, policy: Policy, spec: GateSpec): Metric | undefined {
  const stress = policy.stresses.find((s) => s.key === spec.scenario);
  if (spec.scenario !== "base" && !stress) return undefined;
  try {
    // A move the engine would refuse (validateInput throws) never counts as passing.
    validateInput(input);
    return baseMetrics(stress ? applyStress(input, stress) : input).find((m) => m.key === spec.metricKey);
  } catch {
    return undefined;
  }
}

/** Rows for every failing gate and each of five drivers, and the error-severity checks that no gate can offset. */
export function breakeven(input: EngineInput, policy: Policy, specs: GateSpec[] = gateSpecs(policy)): { rows: BreakevenRow[]; hardFails: string[] } {
  validateInput(input);
  const base = buildLedger(input);
  const contractual = computeMetrics(input, base).metrics.find((m) => m.key === "contractual_dscr");
  const hardFails = runChecks(input, base, policy, contractual?.status === "VALID" ? contractual.value : null)
    .filter((c) => c.severity === "error")
    .map((c) => c.message);
  const loanRates = [input.senior.amount > 0 ? input.senior.ratePct : 0, input.mezzanine?.ratePct ?? 0, input.refinance?.ratePct ?? 0];
  // The furthest each driver may move in its good direction, in steps.
  const reach: Record<(typeof BREAKEVEN_DRIVERS)[number], number> = {
    rentPct: 100,
    exitCapBps: Math.max(0, Math.min(300, Math.floor((input.exitCapPct - 0.25) * 100 + 1e-9))),
    costPct: 50,
    rateBps: Math.round(Math.max(...loanRates) * 100),
    occupancyPts: Math.ceil((100 - input.stabilizedOccupancyPct) * 10 - 1e-9) / 10,
  };
  const rows: BreakevenRow[] = [];
  for (const spec of specs) {
    if (gateStatusOf(gateMetric(input, policy, spec), spec.threshold) !== "failed") continue;
    for (const key of BREAKEVEN_DRIVERS) {
      const d = DRIVER_BY_KEY.get(key)!;
      const step = BREAKEVEN_STEP[key];
      const N = Math.round(reach[key] / step);
      const sign = d.direction;
      const move = (n: number) => Math.round(sign * n * step * 1000) / 1000;
      const limit = move(N);
      const limits = { [key]: [Math.min(0, limit), Math.max(0, limit)] as [number, number] };
      const shocked = (n: number) => shockWithin(input, { [key]: move(n) }, limits);
      const metricAt = (n: number) => gateMetric(shocked(n), policy, spec);
      const probe: Probe = (n) => {
        const m = metricAt(n);
        return { pass: gateStatusOf(m, spec.threshold) === "passed", value: m?.status === "VALID" ? m.value : null };
      };
      const r = solveBreakeven(probe, N);
      const row: BreakevenRow = { gate: spec.key, driver: key, state: r.state, shock: null, limit, actual: null, to: [] };
      if (r.state === "value") {
        row.shock = move(r.n!);
        row.actual = probe(r.n!).value;
        row.to = echoes(key, input, shocked(r.n!));
      } else {
        row.reason =
          r.state === "out_of_range" ? `Not within ${limit > 0 ? "+" : "-"}${Math.abs(limit)}${UNIT_SUFFIX[d.unit as keyof typeof UNIT_SUFFIX]}`
          : r.state === "no_effect" ? `Within ${limit > 0 ? "+" : "-"}${Math.abs(limit)}${UNIT_SUFFIX[d.unit as keyof typeof UNIT_SUFFIX]}, this input does not change the gate's figure.`
          : NOT_STEADY;
      }
      rows.push(row);
    }
  }
  return { rows, hardFails };
}
