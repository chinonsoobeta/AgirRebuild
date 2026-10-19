// The document model shared by every renderer. It is built from a stored run
// and the inputs that run used, and from nothing else: it never recomputes a
// verdict, a gate or a metric.

import { CURRENCY_NAMES, FIELD_BY_KEY, placeLabel, type Currency, type EngineInput, type FieldUnit, type Policy, type RunResult, type VerdictCode } from "@agir/contracts";
import { createHash } from "node:crypto";
import { runWaterfall, irrRoots, breakeven, canonicalJson, ENGINE_VERSION, type BreakevenEcho, type BreakevenRow } from "@agir/engine";
import { Formatter, formatValue } from "./format.ts";

export type ArtifactKind = "ic_memo" | "lender_package" | "build_decision" | "partner_memo" | "model_export";

export type ArtifactInput = {
  kind: ArtifactKind;
  /** Currency and province as the deal stated them when it was created; null when it never did. */
  deal: { name: string; assetType: string; location: string; currency: Currency | null; province: string | null };
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
  /** The policy the run was made under (the run stores its version and hash); only the build decision reads it. */
  policy: Policy;
  assumptions: {
    fieldKey: string;
    itemKey: string | null;
    label: string;
    unit: FieldUnit;
    value: number;
    sourceKind: "document" | "analyst" | "default";
    source: string;
    /** Absent on runs made before solo review: read as false and null. */
    sponsorStated?: boolean;
    confirmedBy?: string | null;
    confirmedByReview?: boolean;
    confirmedAt?: string | null;
  }[];
  /** Optional lines no document gave, as the run recorded them; absent on runs made before the list existed. */
  notFound?: { fieldKey: string; itemKey?: string; label: string; detail?: string }[];
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
  else if (i.budget.other < 0) rows.push(["Other costs (credit)", f.input(i.budget.other, "$", "other_cost")]);
  // The entered cost lines, each by name and only when a person stated it.
  if (i.budget.developmentCharges !== undefined) rows.push(["Development charges", f.input(i.budget.developmentCharges, "$", "development_charges")]);
  if (i.budget.landTransferTax !== undefined) rows.push(["Land transfer tax", f.input(i.budget.landTransferTax, "$", "land_transfer_tax")]);
  if (i.budget.gstHstNet !== undefined) rows.push(["GST/HST net of rebates", f.input(i.budget.gstHstNet, "$", "gst_hst_net")]);
  if (!isSale(x) && x.result.scenarios[0]?.metrics.find((m) => m.key === "leaseup_operating_cost")?.status === "VALID") {
    rows.push(["Operating costs during lease-up", f.metric("base", "leaseup_operating_cost")]);
  }
  rows.push(isSale(x) ? ["Interest during construction", f.metric("base", "interest_before_completion")] : ["Capitalized interest", f.metric("base", "capitalized_interest")]);
  rows.push(["Total uses", f.metric("base", "total_development_cost")]);
  const usesEnd = rows.length - 1;
  if (i.senior.amount > 0) rows.push(["Senior loan", f.input(i.senior.amount, "$", "senior_loan_amount")]);
  if (i.mezzanine && i.mezzanine.amount > 0) rows.push(["Mezzanine loan", f.input(i.mezzanine.amount, "$", "mezz_loan_amount")]);
  if (x.result.checks.some((c) => c.key === "mezz_interest_accrued")) rows.push(["Mezzanine interest accrued (paid in kind)", f.metric("base", "mezz_interest_accrued")]);
  rows.push(["Equity", f.metric("base", "required_equity")]);
  rows.push(["Total sources", f.metric("base", "total_development_cost")]);
  return { type: "table", caption: "Sources and uses", columns: [{ label: "Line" }, { label: "Amount", numeric: true }], rows, strong: [usesEnd, rows.length - 1] };
}

/** Where the mezzanine loan is described: the run's own sentence, when its interest ran past the commitment. */
function mezzAccrual(f: Formatter, r: RunResult): Block[] {
  const c = r.checks.find((k) => k.key === "mezz_interest_accrued");
  return c ? [{ type: "paragraph", text: f.text(c.message, `check.${c.key}`) }] : [];
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

function operations(f: Formatter, x: ArtifactInput): Block {
  // Year-1 property tax is the entered amount: it has not yet grown.
  const tax = x.input.propertyTaxAnnual;
  return {
    type: "table",
    caption: "Stabilized operations, year 1",
    columns: [{ label: "Line" }, { label: "Amount", numeric: true }],
    rows: [
      ["Gross potential rent", f.metric("base", "gross_potential_rent")],
      ["Effective gross income", f.metric("base", "effective_gross_income")],
      ["Operating expenses", f.metric("base", "operating_expenses")],
      ...(tax !== undefined ? [["Property tax (fixed, within operating expenses)", f.input(tax, "$", "property_tax_annual")]] : []),
      ["Net operating income", f.metric("base", "stabilized_noi")],
    ],
    strong: [tax !== undefined ? 4 : 3],
  };
}

export const DRAFT_POLICY_LINE = "Draft policy, not signed by credit";

/** A deal that sells its units has no rental operations: its reports show the unit sales and the sale results instead. */
const isSale = (x: ArtifactInput) => x.input.exit === "for_sale";
/** A deal kept and refinanced has no sale: its reports lead with the hold measures and show the unrealized ones under their label. */
const isHeld = (x: ArtifactInput) => x.input.exit === "refinance_hold";

/** Under a draft policy, said once beside the verdict. */
function draftLine(x: ArtifactInput): Block[] {
  return x.policy.draft ? [{ type: "paragraph", text: DRAFT_POLICY_LINE }] : [];
}

/** The hold measures, then the unrealized multiple and IRR with the stated value, each under its own label. */
function heldStats(f: Formatter, unrealized = true): { label: string; value: string }[] {
  const item = (key: string) => ({ label: f.metricOf("base", key).label, value: f.metric("base", key) });
  const hold = ["refinance_cash_returned", "cash_left_in_deal", "dcr_after_refinance", "cash_on_cash_after_refinance"].map(item);
  return unrealized ? [...hold, ...["unrealized_equity_multiple", "unrealized_equity_irr", "stated_value"].map(item)] : hold;
}

function saleStats(f: Formatter, full = true): { label: string; value: string }[] {
  const keys = full ? ["total_development_cost", "profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple", "equity_irr"]
    : ["profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple"];
  return keys.map((key) => ({ label: key === "total_development_cost" ? "Total cost" : f.metricOf("base", key).label, value: f.metric("base", key) }));
}

function unitSales(f: Formatter, x: ArtifactInput): Block {
  const sale = x.input.forSale!;
  const rows = sale.units.map((u) => [f.ident(u.label, `forSale.${u.key}.label`), f.input(u.units, "units", `unit_count|${u.key}`) + " units", f.input(u.price, "$", `unit_sale_price|${u.key}`)]);
  const field = (key: string, value: number, unit: Parameters<Formatter["input"]>[1]) => [FIELD_BY_KEY.get(key)!.label, f.input(value, unit, key), ""];
  rows.push(
    field("presold_units_pct", sale.presoldPct, "%"),
    field("deposit_pct", sale.depositPct, "%"),
    field("absorption_units_per_month", sale.absorptionPerMonth, "units"),
    field("sales_commission_pct", sale.commissionPct, "%"),
    field("closing_lag_months", sale.closingLagMonths, "months"),
    field("unsold_carry_monthly", sale.carryMonthly, "$"),
  );
  if (sale.presaleThresholdPct !== undefined) rows.push(field("senior_presale_threshold_pct", sale.presaleThresholdPct, "%"));
  return { type: "table", caption: "Unit sales", columns: [{ label: "Unit type or field" }, { label: "Count or value", numeric: true }, { label: "Sale price per unit", numeric: true }], rows };
}

function saleResults(f: Formatter, x: ArtifactInput): Block {
  const keys = ["gross_sales_revenue", "net_sales_revenue", "carry_total", "interest_after_completion", "development_profit_for_sale", "profit_on_cost_for_sale",
    "margin_on_revenue", "sellout_month", "sellout_years", "deposits_held_at_completion", "senior_balance_at_completion",
    ...(x.input.mezzanine && x.input.mezzanine.amount > 0 ? ["mezz_balance_at_completion"] : [])];
  return { type: "table", caption: "Sale results", columns: [{ label: "Figure" }, { label: "Value", numeric: true }],
    rows: keys.map((key) => [f.metricOf("base", key).label, f.metric("base", key)]) };
}

const SALE_OPERATIONS: Block = { type: "paragraph", muted: true, text: "A deal that sells its units has no years of operations. Each month's costs, loans and closings are in the Excel export." };

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

function stresses(f: Formatter, r: RunResult, held = false, sale = false, keys?: readonly string[]): Block {
  // A held deal has no sale, so its stress table reads coverage after the refinance and the unrealized multiple instead.
  const read = keys ?? (sale ? ["profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple"] : held ? ["sizing_dscr", "dcr_after_refinance", "unrealized_equity_multiple"] : ["sizing_dscr", "equity_multiple", "profit_on_cost"]);
  return {
    type: "table",
    caption: "Stresses (each a full re-run of the model)",
    columns: [{ label: "Scenario" }, ...read.map((k) => ({ label: k === "sizing_dscr" ? "Sizing DSCR" : f.metricOf("base", k).label, numeric: true }))],
    rows: r.scenarios.map((s) => [f.ident(s.label, `policy.stress.${s.key}`), ...read.map((k) => f.metric(s.key, k))]),
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

type Assumption = ArtifactInput["assumptions"][number];

/** How an input was confirmed, in words; "" when it was approved the ordinary way. `id` prints the date or name. */
export function confirmationLabel(a: Assumption, id: (text: string, ref: string) => string = (t) => t): string {
  if (a.sponsorStated) return "Stated by the sponsor, not independently confirmed";
  if (a.confirmedByReview) return `Confirmed by Agir review on ${id((a.confirmedAt ?? "").slice(0, 10), `confirmedAt.${a.fieldKey}`)}`;
  if (a.confirmedBy) return `Confirmed by ${id(a.confirmedBy, `confirmedBy.${a.fieldKey}`)}`;
  return "";
}

function inputRow(f: Formatter, a: Assumption): string[] {
  const note = confirmationLabel(a, (t, ref) => f.ident(t, ref));
  return [f.ident(a.itemKey ? `${a.label} (${a.itemKey})` : a.label, `field.${a.fieldKey}`), inputValue(f, a), f.ident(a.source, `source.${a.fieldKey}`) + (note ? ` · ${note}` : "")];
}

const INPUT_COLUMNS = [{ label: "Input" }, { label: "Value", numeric: true }, { label: "Source" }];

function inputsAppendix(f: Formatter, x: ArtifactInput): Block {
  return { type: "table", caption: "Approved inputs and where each came from", columns: INPUT_COLUMNS, rows: x.assumptions.map((a) => inputRow(f, a)) };
}

/** The inputs a sponsor stated and nobody else confirmed, up front; nothing when there are none. */
function sponsorStatedBlocks(f: Formatter, x: ArtifactInput): Block[] {
  const stated = x.assumptions.filter((a) => a.sponsorStated);
  if (stated.length === 0) return [];
  const material = x.assumptions.filter((a) => a.sponsorStated || a.confirmedBy || a.confirmedByReview || FIELD_BY_KEY.get(a.fieldKey)?.material).length;
  const n = f.ident(String(stated.length), "sponsorStated.count");
  const m = f.ident(String(material), "materialInputs.count");
  return [
    { type: "heading", text: "Stated by the sponsor, not independently confirmed" },
    {
      type: "paragraph",
      text: `${n} of the ${m} material inputs this run used ${stated.length === 1 ? "was" : "were"} stated by the sponsor and not confirmed by anyone else. Check them before relying on this ${x.kind === "ic_memo" ? "memo" : (x.kind === "build_decision" || x.kind === "partner_memo") ? "report" : "package"}.`,
    },
    { type: "table", columns: INPUT_COLUMNS, rows: stated.map((a) => inputRow(f, a)) },
  ];
}

/** The one sentence for a line no document gave: a template, with no number. */
export const notFoundSentence = (n: { label: string; detail?: string }) => `${n.label} \u2014 not found. The run treats this as: ${n.detail ?? "nothing"}.`;

function notFoundBlocks(x: ArtifactInput): Block[] {
  const list = x.notFound ?? [];
  if (list.length === 0) return [];
  return [{ type: "heading", text: "Not found in the documents" }, ...list.map((n): Block => ({ type: "paragraph", text: notFoundSentence(n) }))];
}

const STATE_WORDS = { out_of_range: "Out of range", no_effect: "No effect", not_monotonic: "Not monotonic" } as const;
const DRIVER_NAME: Partial<Record<BreakevenRow["driver"], string>> = { pricePct: "Sale prices", absorptionPct: "Sales pace", presalesPts: "Presales", rentPct: "Rent", exitCapBps: "Exit cap rate", costPct: "Project cost", rateBps: "Loan interest rates", occupancyPts: "Stabilized occupancy" };
const ECHO_NAME: Record<BreakevenEcho["key"], string> = { price: "Sale price", absorption: "Sales pace", presales: "Presold units", rent: "Rent", cost: "Project cost", exit_cap: "Exit cap rate", senior_rate: "Senior loan rate", mezzanine_rate: "Mezzanine loan rate", refinance_rate: "Refinance rate", occupancy: "Stabilized occupancy" };
const ECHO_UNIT = { units: "units/mo", "$/unit/mo": "$/mo", "$/sf/yr": "$/sf", $: "$", "%": "%" } as const;

/** Which way each break-even echo rounds to keep passing, and to what step, at the precision this report prints. */
const PASSING_ROUND: Record<BreakevenEcho["key"], (unit: BreakevenEcho["unit"]) => [1 | -1, number]> = {
  price: () => [1, 1],
  absorption: () => [1, 0.01],
  presales: () => [1, 0.01],
  rent: (u) => [1, u === "$/sf/yr" ? 0.01 : 1],
  cost: () => [-1, 1],
  exit_cap: () => [-1, 0.01],
  senior_rate: () => [-1, 0.01],
  mezzanine_rate: () => [-1, 0.01],
  refinance_rate: () => [-1, 0.01],
  occupancy: () => [1, 0.01],
};

/** Round toward passing on a grid; a value already on the grid (within a hair) stays put. */
export function roundToward(value: number, dir: 1 | -1, step: number): number {
  const q = value / step;
  return (dir > 0 ? Math.ceil(q - 1e-6) : Math.floor(q + 1e-6)) / Math.round(1 / step);
}

/** The stress with the most failed gates; a tie goes to the lower stressed sizing DSCR (for a sale, the lower profit on cost). One sentence, from the stored gates. */
function weakestStress(f: Formatter, r: RunResult, sale = false): Block[] {
  const metricKey = sale ? "profit_on_cost_for_sale" : "sizing_dscr";
  const stresses = r.scenarios.filter((s) => s.key !== "base");
  const failed = (key: string) => r.verdict.gates.filter((g) => g.scenario === key && g.status === "failed");
  const dscr = (key: string) => {
    const m = r.scenarios.find((s) => s.key === key)?.metrics.find((k) => k.key === metricKey);
    return m?.status === "VALID" && m.value !== null ? m.value : Infinity;
  };
  const w = [...stresses].sort((a, b) => failed(b.key).length - failed(a.key).length || (dscr(a.key) < dscr(b.key) ? -1 : dscr(a.key) > dscr(b.key) ? 1 : 0))[0];
  if (!w) return [];
  const gates = failed(w.key);
  const fails = gates.length
    ? `It fails ${f.ident(String(gates.length), "stress.failedGates")} ${gates.length === 1 ? "gate" : "gates"}: ${gates.map((g) => g.label).join("; ")}.`
    : "It fails no gate.";
  return [{ type: "paragraph", text: `Weakest stress: ${f.ident(w.label, `policy.stress.${w.key}`)}. ${fails} Its ${sale ? "profit on cost" : "sizing DSCR"}: ${f.metric(w.key, metricKey)}.` }];
}

/** For each failing gate, the one input that would make it pass, from `breakeven()` over the run's stored input and policy. */
function changeTheAnswer(f: Formatter, x: ArtifactInput): Block[] {
  const heading: Block = { type: "heading", text: "What would change the answer" };
  const failing = x.result.verdict.gates.filter((g) => g.status === "failed");
  const hardFail: Block[] = x.result.verdict.hardFailReasons.length > 0
    ? [{ type: "paragraph", text: "This run fails a check that no gate can offset. Passing the gates alone would not change the verdict while it stands." }] : [];
  if (x.result.verdict.code === "APPROVE" || (failing.length === 0 && hardFail.length === 0)) return [];
  if (x.run.engineVersion !== ENGINE_VERSION) return [heading, { type: "paragraph", muted: true, text: "Not shown: this run was made by an earlier engine." }, ...hardFail];
  const intro: Block[] = [heading];
  // The run stores its policy's hash: a policy edited under the same version name is a different policy.
  if (x.run.policyHash !== createHash("sha256").update(canonicalJson(x.policy)).digest("hex")) {
    // Break-evens worked out under another policy would not be this run's, so none are shown.
    return [heading, { type: "paragraph", muted: true, text: "Not shown: this run was made under a different policy." }, ...hardFail];
  }
  intro.push(...hardFail);
  if (failing.length === 0) return intro;
  const { rows } = breakeven(x.input, x.policy);
  const body: string[][] = [];
  let ratesTogether = false;
  for (const g of failing) {
    const needs = f.run(g.threshold, g.unit, `gate.${g.key}.threshold`);
    const has = g.actual === null ? "Not measured" : f.run(g.actual, g.unit, `gate.${g.key}.actual`);
    // The gate's name, need and result print on its first row only.
    let first = true;
    const add = (cells: string[]) => {
      body.push([...(first ? [g.label, needs, has] : ["", "", ""]), ...cells]);
      first = false;
    };
    for (const row of rows.filter((k) => k.gate === g.key)) {
      if (row.state !== "value") {
        add([DRIVER_NAME[row.driver] ?? row.driver, "\u2014", STATE_WORDS[row.state]]);
        continue;
      }
      if (row.driver === "rentPct" && row.to.length > 1) {
        // Rents move together by one share: the row says so, and the engine's own shock is the figure.
        add([`Rent, all ${f.ident(String(row.to.length), `breakeven.${g.key}.rent.count`)} unit types (same share)`, "\u2014", `+${f.run(row.shock, "%", `breakeven.${g.key}.rent.shock`)}`]);
        continue;
      }
      if (row.driver === "pricePct" && row.to.length > 1) {
        add([`Sale prices, all ${f.ident(String(row.to.length), `breakeven.${g.key}.price.count`)} unit types (same share)`, "—", `+${f.run(row.shock, "%", `breakeven.${g.key}.price.shock`)}`]);
        continue;
      }
      const allRates = row.driver === "rateBps" && row.to.length > 1;
      if (allRates) {
        add([`Loan interest rates, all ${f.ident(String(row.to.length), `breakeven.${g.key}.rate.count`)} together (same move)`, "\u2014", `${row.shock! > 0 ? "+" : ""}${f.run(row.shock, "bps", `breakeven.${g.key}.rate.shock`)}`]);
        ratesTogether = true;
      }
      for (const e of row.to) {
        const ref = `breakeven.${g.key}.${e.key}${e.item ? "|" + e.item : ""}`;
        const name = (e.item ? `${ECHO_NAME[e.key]}, ${e.item}` : ECHO_NAME[e.key]) + (allRates ? ", in the same move" : "");
        const unit = ECHO_UNIT[e.unit];
        const [dir, step] = PASSING_ROUND[e.key](e.unit);
        add([f.ident(name, `${ref}.label`), f.run(e.from, unit, `${ref}.from`), f.derived(roundToward(e.to, dir, step), unit, `${dir > 0 ? "ceil" : "floor"}(${ref}.to, ${step})`)]);
      }
    }
  }
  return [
    ...intro,
    {
      type: "table",
      columns: [{ label: "Gate" }, { label: "Needs", numeric: true }, { label: "This run", numeric: true }, { label: "Input moved" }, { label: "In this run", numeric: true }, { label: "Passes at", numeric: true }],
      rows: body,
    },
    { type: "paragraph", muted: true, text: "One input is moved at a time. Everything else is held." + (ratesTogether ? " Loan interest rates move together by the same amount." : "") },
  ];
}

class PartnerMemoUnavailableError extends Error {
  constructor() {
    super("This deal has no LP/GP split, so it has no partner memo.");
    this.name = "PartnerMemoUnavailableError";
  }
}

/**
 * The partner sections of a held deal's memo (card 87, owner decision 2026-10-19): the existing waterfall over the
 * run's stored equity flows, with the stated value (unrealized, not a sale) and without it (cash paid out).
 * Report arithmetic over the base case's flows, not engine metrics, so no stored result changes.
 */
function heldPartnerBlocks(f: Formatter, x: ArtifactInput): Block[] {
  const r = x.result;
  const terms = x.input.waterfall!;
  const w = runWaterfall(r.equityFlows, terms);
  const paid = runWaterfall(r.equityFlows.filter((flow) => flow.kind !== "unrealized"), terms);
  const irr = (flows: { t: number; amount: number }[], ref: string) => {
    const roots = irrRoots(flows);
    return f.derived(roots.length === 1 ? roots[0]! * 100 : null, "%", `irr(${ref})`);
  };
  const totals = (flows: { amount: number }[]) => ({
    contributed: -flows.filter((flow) => flow.amount < 0).reduce((n, flow) => n + flow.amount, 0),
    distributed: flows.filter((flow) => flow.amount > 0).reduce((n, flow) => n + flow.amount, 0),
  });
  const lpIrr = irr(w.lp, "waterfall.LP.flows"), gpIrr = irr(w.gp, "waterfall.GP.flows");
  const metricItem = (key: string) => ({ label: f.metricOf("base", key).label, value: f.metric("base", key) });
  const blocks: Block[] = [{ type: "stats", items: [
    metricItem("unrealized_equity_multiple"), metricItem("unrealized_equity_irr"),
    { label: "LP IRR (unrealized, not a sale)", value: lpIrr },
    { label: "GP IRR (unrealized, not a sale)", value: gpIrr },
  ] }];
  blocks.push({ type: "table", caption: "Partnership terms", columns: [{ label: "Term" }, { label: "Value", numeric: true }],
    rows: [["lp_share_pct", terms.lpSharePct], ["preferred_return_pct", terms.preferredReturnPct], ["gp_promote_pct", terms.gpPromotePct]]
      .map(([key, value]) => [FIELD_BY_KEY.get(String(key))!.label, f.input(Number(value), "%", String(key))]),
  });
  const lp = totals(w.lp), gp = totals(w.gp);
  const has = (key: string) => r.scenarios.find((s) => s.key === "base")!.metrics.some((m) => m.key === key);
  const capital = ([["LP", lp, lpIrr], ["GP", gp, gpIrr]] as const).map(([label, cash, partnerIrr]) => [
    f.ident(label, `waterfall.${label}.label`),
    f.derived(cash.contributed, "$", `sum(-waterfall.${label}.negativeFlows)`),
    f.derived(cash.distributed, "$", `sum(waterfall.${label}.positiveFlows)`),
    f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `waterfall.${label}.distributed / waterfall.${label}.contributed`),
    partnerIrr,
  ]);
  capital.push(["Total",
    has("equity_contributed") ? f.metric("base", "equity_contributed") : f.derived(lp.contributed + gp.contributed, "$", "waterfall.LP.contributed + waterfall.GP.contributed"),
    has("equity_distributed") ? f.metric("base", "equity_distributed") : f.derived(lp.distributed + gp.distributed, "$", "waterfall.LP.distributed + waterfall.GP.distributed"),
    f.metric("base", "unrealized_equity_multiple"), f.metric("base", "unrealized_equity_irr"),
  ]);
  capital.push(["GP promote (unrealized, not a sale)", "", f.derived(w.promote, "$", "waterfall.promote"), "", ""]);
  blocks.push({ type: "table", caption: "Capital and distributions, with the stated value (unrealized, not a sale)",
    columns: [{ label: "Partner" }, { label: "Contributed", numeric: true }, { label: "Distributed", numeric: true }, { label: "Multiple", numeric: true }, { label: "IRR", numeric: true }],
    rows: capital,
  });
  const plp = totals(paid.lp), pgp = totals(paid.gp);
  const paidRows = ([["LP", plp], ["GP", pgp]] as const).map(([label, cash]) => [
    f.ident(label, `paid.${label}.label`),
    f.derived(cash.contributed, "$", `sum(-paid.${label}.negativeFlows)`),
    f.derived(cash.distributed, "$", `sum(paid.${label}.positiveFlows)`),
    f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `paid.${label}.distributed / paid.${label}.contributed`),
  ]);
  const contributed = plp.contributed + pgp.contributed, paidOut = plp.distributed + pgp.distributed;
  paidRows.push(["Total",
    f.derived(contributed, "$", "paid.LP.contributed + paid.GP.contributed"),
    f.derived(paidOut, "$", "paid.LP.distributed + paid.GP.distributed"),
    f.derived(contributed > 0 ? paidOut / contributed : null, "x", "paid.distributed / paid.contributed"),
  ]);
  paidRows.push(["GP promote paid", "", f.derived(paid.promote, "$", "paid.promote"), ""]);
  blocks.push({ type: "table", caption: "Cash paid out before the stated value",
    columns: [{ label: "Partner" }, { label: "Contributed", numeric: true }, { label: "Paid out", numeric: true }, { label: "Paid out / contributed", numeric: true }],
    rows: paidRows,
  });
  blocks.push(
    { type: "paragraph", muted: true, text: "Distributions go pro rata until the LP has received its capital and its preferred return, compounded annually on what is unreturned. After that the GP takes its promote share of each dollar and the rest is split pro rata." },
    { type: "paragraph", muted: true, text: "Nothing is sold. The stated value is final-year NOI over the exit cap rate, less the debt outstanding; returns that include it are unrealized. Cash paid out is the operating and refinance cash only." },
    sourcesAndUses(f, x),
    stresses(f, r, true, false, ["dcr_after_refinance", "unrealized_equity_multiple", "unrealized_equity_irr"]),
    ...notFoundBlocks(x),
    { type: "paragraph", muted: true, text: "Every input and its source is listed in the IC memo and the lender package." },
  );
  return blocks;
}

export function buildModel(x: ArtifactInput): DocModel {
  if (x.kind === "partner_memo") {
    const lp = x.result.scenarios.find((s) => s.key === "base")?.metrics.find((m) => m.key === "lp_irr");
    const heldSplit = isHeld(x) && x.input.waterfall !== undefined;
    if (!heldSplit && (!lp || lp.status === "NOT_APPLICABLE")) throw new PartnerMemoUnavailableError();
  }
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
  const sale = isSale(x);
  const held = !sale && isHeld(x);
  if (x.kind === "ic_memo") {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    blocks.push({
      type: "stats",
      items: sale ? saleStats(f) : held
        ? heldStats(f)
        : [
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
    blocks.push(sourcesAndUses(f, x), ...mezzAccrual(f, r), ...(sale ? [unitSales(f, x), saleResults(f, x), SALE_OPERATIONS] : [revenueProgram(f, x), operations(f, x)]), gates(f, r), stresses(f, r, held, sale), ...(sale ? [] : [annual(f, r, false)]));
    blocks.push({ type: "heading", text: "Checks" }, checks(f, r));
    blocks.push(...notFoundBlocks(x), inputsAppendix(f, x));
  } else if (x.kind === "partner_memo" && held) {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x), ...heldPartnerBlocks(f, x));
  } else if (x.kind === "partner_memo") {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    blocks.push({ type: "stats", items: ["equity_multiple", "equity_irr", "lp_irr", "gp_irr"].map((key) => ({
      label: f.metricOf("base", key).label, value: f.metric("base", key),
    })) });
    const terms = x.input.waterfall!;
    blocks.push({ type: "table", caption: "Partnership terms", columns: [{ label: "Term" }, { label: "Value", numeric: true }],
      rows: [["lp_share_pct", terms.lpSharePct], ["preferred_return_pct", terms.preferredReturnPct], ["gp_promote_pct", terms.gpPromotePct]]
        .map(([key, value]) => [FIELD_BY_KEY.get(String(key))!.label, f.input(Number(value), "%", String(key))]),
    });
    const w = runWaterfall(r.equityFlows, terms);
    const totals = (flows: { amount: number }[]) => ({
      contributed: -flows.filter((flow) => flow.amount < 0).reduce((n, flow) => n + flow.amount, 0),
      distributed: flows.filter((flow) => flow.amount > 0).reduce((n, flow) => n + flow.amount, 0),
    });
    const lp = totals(w.lp), gp = totals(w.gp);
    const partnerRows = ([["LP", lp, "lp_irr"], ["GP", gp, "gp_irr"]] as const).map(([label, cash, irr]) => [
      f.ident(label, `waterfall.${label}.label`),
      f.derived(cash.contributed, "$", `sum(-waterfall.${label}.negativeFlows)`),
      f.derived(cash.distributed, "$", `sum(waterfall.${label}.positiveFlows)`),
      f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `waterfall.${label}.distributed / waterfall.${label}.contributed`),
      f.metric("base", irr),
    ]);
    const has = (key: string) => r.scenarios.find((s) => s.key === "base")!.metrics.some((m) => m.key === key);
    partnerRows.push(["Total",
      has("equity_contributed") ? f.metric("base", "equity_contributed") : f.derived(lp.contributed + gp.contributed, "$", "waterfall.LP.contributed + waterfall.GP.contributed"),
      has("equity_distributed") ? f.metric("base", "equity_distributed") : f.derived(lp.distributed + gp.distributed, "$", "waterfall.LP.distributed + waterfall.GP.distributed"),
      f.metric("base", "equity_multiple"), f.metric("base", "equity_irr"),
    ]);
    partnerRows.push(["GP promote", "", f.metric("base", "gp_promote"), "", ""]);
    blocks.push({ type: "table", caption: "Capital and distributions",
      columns: [{ label: "Partner" }, { label: "Contributed", numeric: true }, { label: "Distributed", numeric: true }, { label: "Multiple", numeric: true }, { label: "IRR", numeric: true }],
      rows: partnerRows,
    });
    blocks.push({ type: "paragraph", muted: true, text: "Distributions go pro rata until the LP has received its capital and its preferred return, compounded annually on what is unreturned. After that the GP takes its promote share of each dollar and the rest is split pro rata." });
    blocks.push(sourcesAndUses(f, x), stresses(f, r, false, false, ["equity_multiple", "lp_irr", "gp_irr"]));
    if (sale) blocks.push(SALE_OPERATIONS);
    blocks.push(...notFoundBlocks(x), { type: "paragraph", muted: true, text: "Every input and its source is listed in the IC memo and the lender package." });
  } else if (x.kind === "build_decision") {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    blocks.push({
      type: "stats",
      items: sale ? saleStats(f, false) : held
        ? [
            ...heldStats(f, false),
            { label: "Yield on cost", value: f.metric("base", "yield_on_cost") },
            { label: "Sizing DSCR (weakest year)", value: f.metric("base", "sizing_dscr") },
          ]
        : [
            { label: "Yield on cost", value: f.metric("base", "yield_on_cost") },
            { label: "Sizing DSCR (weakest year)", value: f.metric("base", "sizing_dscr") },
            { label: "Equity multiple", value: f.metric("base", "equity_multiple") },
          ],
    });
    blocks.push(...weakestStress(f, r, sale));
    // An approved deal has no gate to move; its stresses stand in for the section.
    blocks.push(...(r.verdict.code === "APPROVE" ? [stresses(f, r, held, sale)] : changeTheAnswer(f, x)));
    if (r.verdict.code !== "APPROVE" && r.verdict.hardFailReasons.length > 0 && !r.verdict.gates.some((g) => g.status === "failed")) {
      blocks.push(stresses(f, r, held, sale));
    }
    blocks.push(...notFoundBlocks(x), { type: "paragraph", muted: true, text: "Every input and its source is listed in the IC memo and the lender package." });
  } else {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    if (held) blocks.push({ type: "stats", items: heldStats(f) });
    const i = x.input;
    const debtRows: string[][] = [];
    if (i.senior.amount > 0) {
      debtRows.push(
        ["Senior loan", f.input(i.senior.amount, "$", "senior_loan_amount")],
        ["Senior rate", f.input(i.senior.ratePct, "%", "senior_rate_pct")],
        ...(sale ? [] : [
          ...(i.senior.amortYears === undefined ? [] : [["Amortization", f.input(i.senior.amortYears, "years", "senior_amort_years")]]),
          ["Interest-only period", f.input(i.senior.ioMonths, "months", "senior_io_months")],
        ]),
      );
    }
    if (i.mezzanine && i.mezzanine.amount > 0) {
      debtRows.push(["Mezzanine loan", f.input(i.mezzanine.amount, "$", "mezz_loan_amount")], ["Mezzanine rate", f.input(i.mezzanine.ratePct, "%", "mezz_rate_pct")], ["Mezzanine interest accrued above commitment", f.metric("base", "mezz_interest_accrued")]);
    }
    debtRows.push(["Loan to cost", f.metric("base", "loan_to_cost")]);
    if (sale) {
      if (i.forSale!.presaleThresholdPct !== undefined) debtRows.push(
        [FIELD_BY_KEY.get("senior_presale_threshold_pct")!.label, f.input(i.forSale!.presaleThresholdPct, "%", "senior_presale_threshold_pct")],
        [FIELD_BY_KEY.get("presold_units_pct")!.label, f.input(i.forSale!.presoldPct, "%", "presold_units_pct")],
      );
      for (const key of ["interest_after_completion", "senior_balance_at_completion", ...(i.mezzanine && i.mezzanine.amount > 0 ? ["mezz_balance_at_completion"] : [])]) {
        debtRows.push([f.metricOf("base", key).label, f.metric("base", key)]);
      }
    } else debtRows.push(
      ["Debt yield", f.metric("base", "debt_yield")],
      ["Sizing DSCR (weakest year)", f.metric("base", "sizing_dscr")],
      ["Contractual DSCR (weakest year)", f.metric("base", "contractual_dscr")],
      ["Interest-only DSCR (year 1)", f.metric("base", "io_dscr_year1")],
      ["Cumulative cash shortfall after stabilization", f.metric("base", "cumulative_cash_shortfall")],
      ["Break-even occupancy", f.metric("base", "break_even_occupancy")],
    );
    const refinanceDcr = r.verdict.gates.find((g) => g.key === "dcr_after_refinance");
    if (refinanceDcr) debtRows.push(["Coverage after refinance (DCR), minimum", f.run(refinanceDcr.threshold, refinanceDcr.unit, "gate.dcr_after_refinance.threshold")]);
    blocks.push({ type: "table", caption: sale ? "Debt" : "Debt and coverage", columns: [{ label: "Term" }, { label: "Value", numeric: true }], rows: debtRows });
    // Beside the refinance loan: the premium is added to it, not paid in cash.
    if (i.refinance?.insurancePremiumPct !== undefined) {
      blocks.push({ type: "paragraph", text: `Mortgage insurance premium: ${f.input(i.refinance.insurancePremiumPct, "%", "refinance_insurance_premium_pct")} (${f.metric("base", "refinance_premium_added")} added to the loan)` });
    }
    blocks.push(sourcesAndUses(f, x), ...mezzAccrual(f, r), ...(sale ? [unitSales(f, x), saleResults(f, x), SALE_OPERATIONS] : [operations(f, x), annual(f, r, true)]), stresses(f, r, held, sale));
    blocks.push({ type: "heading", text: "Checks" }, checks(f, r));
    blocks.push(...notFoundBlocks(x), inputsAppendix(f, x));
  }
  const footer =
    `Every figure traces to an approved input or to ${runLabel} of this deal. ` +
    `Engine ${f.ident(x.run.engineVersion, "run.engine")}, ${f.ident(x.run.policyVersion, "run.policy")}. ` +
    `Inputs ${f.ident(x.run.inputHash.slice(0, 16), "run.inputHash")}, result ${f.ident(x.run.resultHash.slice(0, 16), "run.resultHash")}.`;
  // Every amount prints with "$"; the deal says once which dollar that is.
  const currency = x.deal.currency ? `All amounts in ${CURRENCY_NAMES[x.deal.currency][0]} (${x.deal.currency})` : "Currency not stated";
  return {
    title: f.ident(x.deal.name, "deal.name"),
    kicker: { ic_memo: "Investment Committee memorandum", build_decision: "Build decision", partner_memo: "Partner memo" }[x.kind as string] ?? "Lender package",
    meta: [
      f.ident(x.deal.assetType, "deal.assetType"),
      f.ident(placeLabel(x.deal.location, x.deal.province), "deal.location"),
      runLabel,
      date,
      f.ident(currency, "deal.currency"),
    ]
      .filter(Boolean)
      .join(" · "),
    blocks,
    footer,
    formatter: f,
  };
}
