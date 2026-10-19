// Provenance by construction (plan task A2). An artifact never formats a raw
// number. Every figure is printed through this formatter, which records the
// printed text together with where the number came from: a run metric, an
// approved input, a gate threshold, or simple arithmetic over those. The
// final scan (provenance.ts) then refuses any digit the manifest cannot explain.

import type { Metric, MetricUnit, RunResult } from "@agir/contracts";

export type ProvenanceEntry = { text: string; ref: string };

const money0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatValue(value: number, unit: MetricUnit | "$" | "%" | "x" | "sf" | "units" | "months" | "years" | "$/mo" | "$/sf"): string {
  switch (unit) {
    case "$":
      return (value < 0 ? "-$" : "$") + money0.format(Math.abs(Math.round(value)));
    case "%":
      return value.toFixed(2) + "%";
    case "x":
      return value.toFixed(2) + "x";
    case "bps":
      return Math.round(value) + " bps";
    case "count":
    case "units":
      return money0.format(Math.round(value));
    case "months":
      return `${Math.round(value)} months`;
    case "years":
      return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} years`;
    case "sf":
      return money0.format(Math.round(value)) + " SF";
    case "$/mo":
      return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + "/mo";
    case "$/sf":
      return "$" + value.toFixed(2) + "/SF";
    default:
      return String(value);
  }
}

export class Formatter {
  readonly manifest: ProvenanceEntry[] = [];

  constructor(private readonly result: RunResult) {}

  private record(text: string, ref: string): string {
    this.manifest.push({ text, ref });
    return text;
  }

  metricOf(scenario: string, key: string): Metric {
    const s = this.result.scenarios.find((x) => x.key === scenario);
    const m = s?.metrics.find((x) => x.key === key);
    if (!m) throw new Error(`The run has no metric ${scenario}.${key}`);
    return m;
  }

  /** A run metric: its value, or the words that say why it has none. Never zero. */
  metric(scenario: string, key: string): string {
    const m = this.metricOf(scenario, key);
    if (m.status !== "VALID" || m.value === null) {
      return m.status === "NOT_APPLICABLE" ? "Not applicable" : "Not meaningful";
    }
    return this.record(formatValue(m.value, m.unit), `metric:${scenario}.${key}`);
  }

  /** A number read from the run record (annual rows, gates, flows). */
  run(value: number | null, unit: Parameters<typeof formatValue>[1], ref: string): string {
    if (value === null || !Number.isFinite(value)) return "Not meaningful";
    return this.record(formatValue(value, unit), `run:${ref}`);
  }

  /** An approved input. */
  input(value: number, unit: Parameters<typeof formatValue>[1], ref: string): string {
    return this.record(formatValue(value, unit), `input:${ref}`);
  }

  /** Arithmetic over recorded values; the formula is kept with the figure. */
  derived(value: number | null, unit: Parameters<typeof formatValue>[1], formula: string): string {
    if (value === null || !Number.isFinite(value)) return "Not meaningful";
    return this.record(formatValue(value, unit), `derived:${formula}`);
  }

  /** Text taken whole from the run record (a check message, a verdict line). */
  text(text: string, ref: string): string {
    return this.record(text, `run:${ref}`);
  }

  /** An identifier (hash, run number, date) printed for traceability. */
  ident(text: string, ref: string): string {
    return this.record(text, `ident:${ref}`);
  }
}
