// The document model shared by every renderer. It is built from a stored run
// and the inputs that run used, and from nothing else: it never recomputes a
// verdict, a gate or a metric.

import type { EngineInput, FieldUnit, RunResult, VerdictCode } from "@agir/contracts";
import { Formatter, formatValue } from "./format.ts";

export type ArtifactKind = "ic_memo" | "lender_package" | "model_export";

export type ArtifactInput = {
  kind: ArtifactKind;
  deal: { name: string; assetType: string; location: string };
  run: {
    id: string;
    runNumber: number;
    createdAt: string;
    engineVersion: string;
    policyVersion: string;
    policyHash: string;
    inputHash: string;
    resultHash: string;
  };
  result: RunResult;
  input: EngineInput;
  assumptions: {
    fieldKey: string;
    itemKey: string | null;
    label: string;
    unit: FieldUnit;
    value: number;
    sourceKind: "document" | "analyst" | "default";
    source: string;
  }[];
  decision: { decision: string; rationale: string; conditions: string | null; decidedBy: string; createdAt: string } | null;
};

export type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string; muted?: boolean }
  | { type: "verdict"; code: VerdictCode; label: string; headline: string; explanation: string }
  | { type: "stats"; items: { label: string; value: string }[] }
  | { type: "table"; columns: { label: string; numeric?: boolean }[]; rows: string[][]; strong?: number[]; caption?: string }
  | { type: "checks"; items: { tone: "pass" | "warning" | "error"; text: string }[] };

export type DocModel = {
  title: string;
  kicker: string;
  meta: string;
  blocks: Block[];
  footer: string;
  formatter: Formatter;
};

const VERDICT_LABEL: Record<VerdictCode, string> = {
  APPROVE: "Approve",
  APPROVE_WITH_CONDITIONS: "Approve with conditions",
  REJECT: "Reject",
  NOT_EVALUATED: "Not evaluated",
};

const UNIT_MAP: Record<FieldUnit, Parameters<typeof formatValue>[1] | "flag"> = {
  $: "$",
  "%": "%",
  months: "months",
  years: "years",
  units: "units",
  sf: "sf",
  "$/unit/mo": "$/mo",
  "$/sf/yr": "$/sf",
  x: "x",
  flag: "flag",
};

function inputValue(f: Formatter, a: ArtifactInput["assumptions"][number]): string {
  const u = UNIT_MAP[a.unit];
  if (u === "flag") return a.value === 1 ? "Yes" : "No";
  return f.input(a.value, u, `${a.fieldKey}${a.itemKey ? "|" + a.itemKey : ""}`);
}

function sourcesAndUses(f: Formatter, x: ArtifactInput): Block {
  const i = x.input;
  const rows: string[][] = [
    ["Land", f.input(i.budget.land, "$", "land_cost")],
    ["Hard costs", f.input(i.budget.hard, "$", "hard_cost")],
    ["Soft costs", f.input(i.budget.soft, "$", "soft_cost")],
    ["Contingency", f.input(i.budget.contingency, "$", "contingency")],
  ];
  if (i.budget.other > 0) rows.push(["Other costs", f.input(i.budget.other, "$", "other_cost")]);
  rows.push(["Capitalized interest", f.metric("base", "capitalized_interest")]);
  rows.push(["Total uses", f.metric("base", "total_development_cost")]);
  const usesEnd = rows.length - 1;
  if (i.senior.amount > 0) rows.push(["Senior loan", f.input(i.senior.amount, "$", "senior_loan_amount")]);
  if (i.mezzanine && i.mezzanine.amount > 0) rows.push(["Mezzanine loan", f.input(i.mezzanine.amount, "$", "mezz_loan_amount")]);
  rows.push(["Equity", f.metric("base", "required_equity")]);
  rows.push(["Total sources", f.metric("base", "total_development_cost")]);
  return { type: "table", caption: "Sources and uses", columns: [{ label: "Line" }, { label: "Amount", numeric: true }], rows, strong: [usesEnd, rows.length - 1] };
}

function revenueProgram(f: Formatter, x: ArtifactInput): Block {
  const rows = x.input.revenue.map((c) => [
    f.ident(c.label, `revenue.${c.key}.label`),
    c.basis === "per_unit" ? f.input(c.units, "units", `unit_count|${c.key}`) + " units" : f.input(c.areaSf ?? 0, "sf", `rentable_area_sf|${c.key}`),
    c.basis === "per_unit" ? f.input(c.rentMonthly ?? 0, "$/mo", `unit_rent_monthly|${c.key}`) : f.input(c.rentPsfAnnual ?? 0, "$/sf", `rent_psf_annual|${c.key}`),
    c.occupancyPct !== undefined
      ? f.input(c.occupancyPct, "%", `item_occupancy_pct|${c.key}`)
      : f.input(x.input.stabilizedOccupancyPct, "%", "stabilized_occupancy_pct"),
  ]);
  return {
    type: "table",
    caption: "Revenue program",
    columns: [{ label: "Component" }, { label: "Size", numeric: true }, { label: "Rent", numeric: true }, { label: "Occupancy", numeric: true }],
    rows,
  };
}

function operations(f: Formatter): Block {
  return {
    type: "table",
    caption: "Stabilized operations, year 1",
    columns: [{ label: "Line" }, { label: "Amount", numeric: true }],
    rows: [
      ["Gross potential rent", f.metric("base", "gross_potential_rent")],
      ["Effective gross income", f.metric("base", "effective_gross_income")],
      ["Operating expenses", f.metric("base", "operating_expenses")],
      ["Net operating income", f.metric("base", "stabilized_noi")],
    ],
    strong: [3],
  };
}

function gates(f: Formatter, r: RunResult): Block {
  const label = { passed: "Passes", failed: "Fails", not_applicable: "Not applicable", not_evaluated: "Not evaluated" } as const;
  return {
    type: "table",
    caption: "Committee gates",
    columns: [{ label: "Gate" }, { label: "Needs", numeric: true }, { label: "Result", numeric: true }, { label: "Outcome" }],
    rows: r.verdict.gates.map((g) => [
      g.label,
      "at least " + f.run(g.threshold, g.unit, `gate.${g.key}.threshold`),
      g.actual === null ? (g.status === "not_applicable" ? "Not applicable" : "Not measured") : f.run(g.actual, g.unit, `gate.${g.key}.actual`),
      label[g.status],
    ]),
  };
}

function stresses(f: Formatter, r: RunResult): Block {
  return {
    type: "table",
    caption: "Stresses (each a full re-run of the model)",
    columns: [{ label: "Scenario" }, { label: "Sizing DSCR", numeric: true }, { label: "Equity multiple", numeric: true }, { label: "Profit on cost", numeric: true }],
    rows: r.scenarios.map((s) => [f.ident(s.label, `policy.stress.${s.key}`), f.metric(s.key, "sizing_dscr"), f.metric(s.key, "equity_multiple"), f.metric(s.key, "profit_on_cost")]),
    strong: [r.scenarios.length - 1],
  };
}

function annual(f: Formatter, r: RunResult, withCoverage: boolean): Block {
  const rows = r.annual.map((y) => {
    const base = [
      y.year === 0 ? "Before stabilization" : f.ident(`Year ${y.year}`, `annual.${y.year}.label`),
      f.run(y.egi, "$", `annual.${y.year}.egi`),
      f.run(y.opex, "$", `annual.${y.year}.opex`),
      f.run(y.noi, "$", `annual.${y.year}.noi`),
      f.run(y.debtService, "$", `annual.${y.year}.debtService`),
      f.run(y.cashFlow, "$", `annual.${y.year}.cashFlow`),
    ];
    if (withCoverage) {
      base.push(
        y.year === 0 || y.sizingDebtService <= 0
          ? "Not applicable"
          : f.derived(y.noi / y.sizingDebtService, "x", `annual.${y.year}.noi / annual.${y.year}.sizingDebtService`),
      );
    }
    return base;
  });
  const columns = [
    { label: "Period" },
    { label: "EGI", numeric: true },
    { label: "Operating costs", numeric: true },
    { label: "NOI", numeric: true },
    { label: "Debt service", numeric: true },
    { label: "Cash flow", numeric: true },
  ];
  if (withCoverage) columns.push({ label: "Sizing DSCR", numeric: true });
  return { type: "table", caption: "Annual cash flows", columns, rows };
}

function checks(f: Formatter, r: RunResult): Block {
  return {
    type: "checks",
    items: r.checks.map((c) => ({ tone: c.severity, text: f.text(c.message, `check.${c.key}`) })),
  };
}

function inputsAppendix(f: Formatter, x: ArtifactInput): Block {
  return {
    type: "table",
    caption: "Approved inputs and where each came from",
    columns: [{ label: "Input" }, { label: "Value", numeric: true }, { label: "Source" }],
    rows: x.assumptions.map((a) => [f.ident(a.itemKey ? `${a.label} (${a.itemKey})` : a.label, `field.${a.fieldKey}`), inputValue(f, a), f.ident(a.source, `source.${a.fieldKey}`)]),
  };
}

export function buildModel(x: ArtifactInput): DocModel {
  const f = new Formatter(x.result);
  const r = x.result;
  const date = f.ident(x.run.createdAt.slice(0, 10), "run.date");
  const runLabel = f.ident(`Run ${x.run.runNumber}`, "run.number");
  const verdict: Block = {
    type: "verdict",
    code: r.verdict.code,
    label: VERDICT_LABEL[r.verdict.code],
    headline: f.text(r.verdict.headline, "verdict.headline"),
    explanation: f.text(r.verdict.explanation, "verdict.explanation"),
  };
  const blocks: Block[] = [];
  if (x.kind === "ic_memo") {
    blocks.push(verdict);
    blocks.push({
      type: "stats",
      items: [
        { label: "Total cost", value: f.metric("base", "total_development_cost") },
        { label: "Yield on cost", value: f.metric("base", "yield_on_cost") },
        { label: "Sizing DSCR", value: f.metric("base", "sizing_dscr") },
        { label: "Equity multiple", value: f.metric("base", "equity_multiple") },
        { label: "Equity IRR", value: f.metric("base", "equity_irr") },
      ],
    });
    if (x.decision) {
      blocks.push({ type: "heading", text: "Committee decision" });
      // Recorded human text: printed as written and listed in the manifest as such.
      blocks.push({ type: "paragraph", text: `${x.decision.decision.replace(/_/g, " ")}: ${f.ident(x.decision.rationale, "decision.rationale")}` });
      if (x.decision.conditions) blocks.push({ type: "paragraph", text: `Conditions: ${f.ident(x.decision.conditions, "decision.conditions")}` });
    }
    blocks.push(sourcesAndUses(f, x), revenueProgram(f, x), operations(f), gates(f, r), stresses(f, r), annual(f, r, false));
    blocks.push({ type: "heading", text: "Checks" }, checks(f, r));
    blocks.push(inputsAppendix(f, x));
  } else {
    blocks.push(verdict);
    const i = x.input;
    const debtRows: string[][] = [];
    if (i.senior.amount > 0) {
      debtRows.push(
        ["Senior loan", f.input(i.senior.amount, "$", "senior_loan_amount")],
        ["Senior rate", f.input(i.senior.ratePct, "%", "senior_rate_pct")],
        ["Amortization", f.input(i.senior.amortYears, "years", "senior_amort_years")],
        ["Interest-only period", f.input(i.senior.ioMonths, "months", "senior_io_months")],
      );
    }
    if (i.mezzanine && i.mezzanine.amount > 0) {
      debtRows.push(["Mezzanine loan", f.input(i.mezzanine.amount, "$", "mezz_loan_amount")], ["Mezzanine rate", f.input(i.mezzanine.ratePct, "%", "mezz_rate_pct")]);
    }
    debtRows.push(
      ["Loan to cost", f.metric("base", "loan_to_cost")],
      ["Debt yield", f.metric("base", "debt_yield")],
      ["Sizing DSCR (weakest year)", f.metric("base", "sizing_dscr")],
      ["Contractual DSCR (weakest year)", f.metric("base", "contractual_dscr")],
      ["Break-even occupancy", f.metric("base", "break_even_occupancy")],
    );
    blocks.push({ type: "table", caption: "Debt and coverage", columns: [{ label: "Term" }, { label: "Value", numeric: true }], rows: debtRows });
    blocks.push(sourcesAndUses(f, x), operations(f), annual(f, r, true), stresses(f, r));
    blocks.push({ type: "heading", text: "Checks" }, checks(f, r));
    blocks.push(inputsAppendix(f, x));
  }
  const footer =
    `Every figure traces to an approved input or to ${runLabel} of this deal. ` +
    `Engine ${f.ident(x.run.engineVersion, "run.engine")}, ${f.ident(x.run.policyVersion, "run.policy")}. ` +
    `Inputs ${f.ident(x.run.inputHash.slice(0, 16), "run.inputHash")}, result ${f.ident(x.run.resultHash.slice(0, 16), "run.resultHash")}.`;
  return {
    title: f.ident(x.deal.name, "deal.name"),
    kicker: x.kind === "ic_memo" ? "Investment Committee memorandum" : "Lender package",
    meta: [f.ident(x.deal.assetType, "deal.assetType"), f.ident(x.deal.location, "deal.location"), runLabel, date].filter(Boolean).join(" · "),
    blocks,
    footer,
    formatter: f,
  };
}
