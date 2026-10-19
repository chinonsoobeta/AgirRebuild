// The document model shared by every renderer. It is built from a stored run
// and the inputs that run used, and from nothing else: it never recomputes a
// verdict, a gate or a metric.

import { FR_ABSENT, CURRENCY_NAMES, FIELD_BY_KEY, placeLabel, type Currency, type EngineInput, type FieldUnit, type Policy, type RunResult, type VerdictCode } from "@agir/contracts";
import { createHash } from "node:crypto";
import { runWaterfall, heldPartnerReturns, breakeven, canonicalJson, ENGINE_VERSION, type BreakevenEcho, type BreakevenRow } from "@agir/engine";
import { Formatter, formatValue } from "./format.ts";
import { reportText, reportSource } from "./text.ts";

export type ArtifactKind = "ic_memo" | "lender_package" | "build_decision" | "partner_memo" | "model_export";

export type ArtifactInput = {
  kind: ArtifactKind;
  lang?: "en" | "fr";
  /** The broker's workspace and logo (card 89d); printed on the lender package only. Absent, the package is unchanged. */
  broker?: { name: string; logo: { bytes: Uint8Array; mime: "image/png" | "image/jpeg"; width: number; height: number } };
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
    /** The deal's client confirmed the broker's value (card 89); present only when it did. Not an independent confirmation. */
    clientConfirmedBy?: string | null;
    clientConfirmedAt?: string | null;
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
  lang: "en" | "fr";
  banner?: string;
  /** The lender package's header logo and "Prepared by <workspace>" (card 89d); at most 48 px high, aspect kept. */
  brand?: { preparedBy: string; logo: { bytes: Uint8Array; mime: "image/png" | "image/jpeg"; width: number; height: number } };
  title: string;
  kicker: string;
  meta: string;
  blocks: Block[];
  footer: string;
  formatter: Formatter;
};

const VERDICT_LABEL = (lang: "en" | "fr"): Record<VerdictCode, string> => ({
  APPROVE: reportText(lang, "approve"),
  APPROVE_WITH_CONDITIONS: reportText(lang, "approveConditions"),
  REJECT: reportText(lang, "reject"),
  NOT_EVALUATED: reportText(lang, "notEvaluated"),
});

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
  if (u === "flag") return a.value === 1 ? reportText(f.lang, "yes") : reportText(f.lang, "no");
  return f.input(a.value, u, `${a.fieldKey}${a.itemKey ? "|" + a.itemKey : ""}`);
}

function sourcesAndUses(f: Formatter, x: ArtifactInput): Block {
  const i = x.input;
  const rows: string[][] = [
    [reportText(f.lang, "land"), f.input(i.budget.land, "$", "land_cost")],
    [reportText(f.lang, "hard"), f.input(i.budget.hard, "$", "hard_cost")],
    [reportText(f.lang, "soft"), f.input(i.budget.soft, "$", "soft_cost")],
    [reportText(f.lang, "contingency"), f.input(i.budget.contingency, "$", "contingency")],
  ];
  if (i.budget.other > 0) rows.push([reportText(f.lang, "other"), f.input(i.budget.other, "$", "other_cost")]);
  else if (i.budget.other < 0) rows.push([reportText(f.lang, "otherCredit"), f.input(i.budget.other, "$", "other_cost")]);
  // The entered cost lines, each by name and only when a person stated it.
  if (i.budget.developmentCharges !== undefined) rows.push([reportText(f.lang, "charges"), f.input(i.budget.developmentCharges, "$", "development_charges")]);
  if (i.budget.landTransferTax !== undefined) rows.push([reportText(f.lang, "transferTax"), f.input(i.budget.landTransferTax, "$", "land_transfer_tax")]);
  if (i.budget.gstHstNet !== undefined) rows.push([reportText(f.lang, "gst"), f.input(i.budget.gstHstNet, "$", "gst_hst_net")]);
  if (!isSale(x) && x.result.scenarios[0]?.metrics.find((m) => m.key === "leaseup_operating_cost")?.status === "VALID") {
    rows.push([reportText(f.lang, "leaseupCosts"), f.metric("base", "leaseup_operating_cost")]);
  }
  rows.push(isSale(x) ? [reportText(f.lang, "constructionInterest"), f.metric("base", "interest_before_completion")] : [reportText(f.lang, "capitalizedInterest"), f.metric("base", "capitalized_interest")]);
  rows.push([reportText(f.lang, "uses"), f.metric("base", "total_development_cost")]);
  const usesEnd = rows.length - 1;
  if (i.senior.amount > 0) rows.push([reportText(f.lang, "senior"), f.input(i.senior.amount, "$", "senior_loan_amount")]);
  if (i.mezzanine && i.mezzanine.amount > 0) rows.push([reportText(f.lang, "mezz"), f.input(i.mezzanine.amount, "$", "mezz_loan_amount")]);
  if (x.result.checks.some((c) => c.key === "mezz_interest_accrued")) rows.push([reportText(f.lang, "mezzAccrued"), f.metric("base", "mezz_interest_accrued")]);
  rows.push([reportText(f.lang, "equity"), f.metric("base", "required_equity")]);
  rows.push([reportText(f.lang, "sources"), f.metric("base", "total_development_cost")]);
  return { type: "table", caption: reportText(f.lang, "sourcesUses"), columns: [{ label: reportText(f.lang, "line") }, { label: reportText(f.lang, "amount"), numeric: true }], rows, strong: [usesEnd, rows.length - 1] };
}

/** Where the mezzanine loan is described: the run's own sentence, when its interest ran past the commitment. */
function mezzAccrual(f: Formatter, r: RunResult): Block[] {
  const c = r.checks.find((k) => k.key === "mezz_interest_accrued");
  return c ? [{ type: "paragraph", text: f.text(c.message, `check.${c.key}`) }] : [];
}

function revenueProgram(f: Formatter, x: ArtifactInput): Block {
  const rows = x.input.revenue.map((c) => [
    f.ident(c.label === "All units" ? reportText(f.lang, "allUnits") : c.label, `revenue.${c.key}.label`),
    c.basis === "per_unit" ? f.input(c.units, "units", `unit_count|${c.key}`) + reportText(f.lang, "unitsSuffix") : f.input(c.areaSf ?? 0, "sf", `rentable_area_sf|${c.key}`),
    c.basis === "per_unit" ? f.input(c.rentMonthly ?? 0, "$/mo", `unit_rent_monthly|${c.key}`) : f.input(c.rentPsfAnnual ?? 0, "$/sf", `rent_psf_annual|${c.key}`),
    c.occupancyPct !== undefined
      ? f.input(c.occupancyPct, "%", `item_occupancy_pct|${c.key}`)
      : f.input(x.input.stabilizedOccupancyPct, "%", "stabilized_occupancy_pct"),
  ]);
  return {
    type: "table",
    caption: reportText(f.lang, "revenue"),
    columns: [{ label: reportText(f.lang, "component") }, { label: reportText(f.lang, "size"), numeric: true }, { label: reportText(f.lang, "rent"), numeric: true }, { label: reportText(f.lang, "occupancy"), numeric: true }],
    rows,
  };
}

function operations(f: Formatter, x: ArtifactInput): Block {
  // Year-1 property tax is the entered amount: it has not yet grown.
  const tax = x.input.propertyTaxAnnual;
  return {
    type: "table",
    caption: reportText(f.lang, "stabilizedOperations"),
    columns: [{ label: reportText(f.lang, "line") }, { label: reportText(f.lang, "amount"), numeric: true }],
    rows: [
      [reportText(f.lang, "gpr"), f.metric("base", "gross_potential_rent")],
      [reportText(f.lang, "egi"), f.metric("base", "effective_gross_income")],
      [reportText(f.lang, "opex"), f.metric("base", "operating_expenses")],
      ...(tax !== undefined ? [[reportText(f.lang, "propertyTax"), f.input(tax, "$", "property_tax_annual")]] : []),
      [reportText(f.lang, "noi"), f.metric("base", "stabilized_noi")],
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
  return x.policy.draft ? [{ type: "paragraph", text: reportText(x.lang ?? "en", "draftPolicy") }] : [];
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
  return keys.map((key) => ({ label: key === "total_development_cost" ? reportText(f.lang, "totalCost") : f.metricOf("base", key).label, value: f.metric("base", key) }));
}

function unitSales(f: Formatter, x: ArtifactInput): Block {
  const sale = x.input.forSale!;
  const rows = sale.units.map((u) => [f.ident(u.label, `forSale.${u.key}.label`), f.input(u.units, "units", `unit_count|${u.key}`) + reportText(f.lang, "unitsSuffix"), f.input(u.price, "$", `unit_sale_price|${u.key}`)]);
  const field = (key: string, value: number, unit: Parameters<Formatter["input"]>[1]) => [f.field(key, FIELD_BY_KEY.get(key)!.label), f.input(value, unit, key), ""];
  rows.push(
    field("presold_units_pct", sale.presoldPct, "%"),
    field("deposit_pct", sale.depositPct, "%"),
    field("absorption_units_per_month", sale.absorptionPerMonth, "units"),
    field("sales_commission_pct", sale.commissionPct, "%"),
    field("closing_lag_months", sale.closingLagMonths, "months"),
    field("unsold_carry_monthly", sale.carryMonthly, "$"),
  );
  if (sale.presaleThresholdPct !== undefined) rows.push(field("senior_presale_threshold_pct", sale.presaleThresholdPct, "%"));
  return { type: "table", caption: reportText(f.lang, "unitSales"), columns: [{ label: reportText(f.lang, "unitOrField") }, { label: reportText(f.lang, "countValue"), numeric: true }, { label: reportText(f.lang, "salePriceUnit"), numeric: true }], rows };
}

function saleResults(f: Formatter, x: ArtifactInput): Block {
  const keys = ["gross_sales_revenue", "net_sales_revenue", "carry_total", "interest_after_completion", "development_profit_for_sale", "profit_on_cost_for_sale",
    "margin_on_revenue", "sellout_month", "sellout_years", "deposits_held_at_completion", "senior_balance_at_completion",
    ...(x.input.mezzanine && x.input.mezzanine.amount > 0 ? ["mezz_balance_at_completion"] : [])];
  return { type: "table", caption: reportText(f.lang, "saleResults"), columns: [{ label: reportText(f.lang, "figure") }, { label: reportText(f.lang, "value"), numeric: true }],
    rows: keys.map((key) => [f.metricOf("base", key).label, f.metric("base", key)]) };
}

const SALE_OPERATIONS = (lang: "en" | "fr"): Block => ({ type: "paragraph", muted: true, text: reportText(lang, "saleOperations") });

function gates(f: Formatter, r: RunResult): Block {
  const label = { passed: reportText(f.lang, "passes"), failed: reportText(f.lang, "fails"), not_applicable: reportText(f.lang, "notApplicable"), not_evaluated: reportText(f.lang, "notEvaluated") } as const;
  return {
    type: "table",
    caption: reportText(f.lang, "committeeGates"),
    columns: [{ label: reportText(f.lang, "gate") }, { label: reportText(f.lang, "needs"), numeric: true }, { label: reportText(f.lang, "result"), numeric: true }, { label: reportText(f.lang, "outcome") }],
    rows: r.verdict.gates.map((g) => [
      f.gate(g.key, g.label),
      reportText(f.lang, "atLeast") + f.run(g.threshold, g.unit, `gate.${g.key}.threshold`),
      g.actual === null ? (g.status === "not_applicable" ? reportText(f.lang, "notApplicable") : reportText(f.lang, "notMeasured")) : f.run(g.actual, g.unit, `gate.${g.key}.actual`),
      label[g.status],
    ]),
  };
}

function stresses(f: Formatter, r: RunResult, held = false, sale = false, keys?: readonly string[]): Block {
  // A held deal has no sale, so its stress table reads coverage after the refinance and the unrealized multiple instead.
  const read = keys ?? (sale ? ["profit_on_cost_for_sale", "margin_on_revenue", "equity_multiple"] : held ? ["sizing_dscr", "dcr_after_refinance", "unrealized_equity_multiple"] : ["sizing_dscr", "equity_multiple", "profit_on_cost"]);
  return {
    type: "table",
    caption: reportText(f.lang, "stresses"),
    columns: [{ label: reportText(f.lang, "scenario") }, ...read.map((k) => ({ label: k === "sizing_dscr" ? reportText(f.lang, "sizingDscr") : f.metricOf("base", k).label, numeric: true }))],
    rows: r.scenarios.map((s) => [f.ident(f.stress(s.key, s.label), `policy.stress.${s.key}`), ...read.map((k) => f.metric(s.key, k))]),
    strong: [r.scenarios.length - 1],
  };
}

function annual(f: Formatter, r: RunResult, withCoverage: boolean): Block {
  const rows = r.annual.map((y) => {
    const base = [
      y.year === 0 ? reportText(f.lang, "beforeStabilization") : f.ident(reportText(f.lang, "year", String(y.year)), `annual.${y.year}.label`),
      f.run(y.egi, "$", `annual.${y.year}.egi`),
      f.run(y.opex, "$", `annual.${y.year}.opex`),
      f.run(y.noi, "$", `annual.${y.year}.noi`),
      f.run(y.debtService, "$", `annual.${y.year}.debtService`),
      f.run(y.cashFlow, "$", `annual.${y.year}.cashFlow`),
    ];
    if (withCoverage) {
      base.push(
        y.year === 0 || y.sizingDebtService <= 0
          ? reportText(f.lang, "notApplicable")
          : f.derived(y.noi / y.sizingDebtService, "x", `annual.${y.year}.noi / annual.${y.year}.sizingDebtService`),
      );
    }
    return base;
  });
  const columns = [
    { label: reportText(f.lang, "period") },
    { label: reportText(f.lang, "egiShort"), numeric: true },
    { label: reportText(f.lang, "operatingCosts"), numeric: true },
    { label: reportText(f.lang, "noiShort"), numeric: true },
    { label: reportText(f.lang, "debtService"), numeric: true },
    { label: reportText(f.lang, "cashFlow"), numeric: true },
  ];
  if (withCoverage) columns.push({ label: reportText(f.lang, "sizingDscr"), numeric: true });
  return { type: "table", caption: reportText(f.lang, "annual"), columns, rows };
}

function checks(f: Formatter, r: RunResult): Block {
  return {
    type: "checks",
    items: r.checks.map((c) => ({ tone: c.severity, text: f.text(c.message, `check.${c.key}`) })),
  };
}

type Assumption = ArtifactInput["assumptions"][number];

/**
 * How an input was confirmed, in words; "" when it was approved the ordinary way. `id` prints the date or name.
 * A client's confirmation is dated, never named: every client of the deal can download the report (card 92).
 */
export function confirmationLabel(a: Assumption, id: (text: string, ref: string) => string = (t) => t, lang: "en" | "fr" = "en"): string {
  if (a.sponsorStated && a.clientConfirmedAt) {
    return reportText(lang, "clientConfirmed", id(a.clientConfirmedAt.slice(0, 10), `clientConfirmedAt.${a.fieldKey}`));
  }
  if (a.sponsorStated) return reportText(lang, "sponsorStated");
  if (a.confirmedByReview) return reportText(lang, "agirConfirmed", id((a.confirmedAt ?? "").slice(0, 10), `confirmedAt.${a.fieldKey}`));
  if (a.confirmedBy) return reportText(lang, "confirmedBy", id(a.confirmedBy, `confirmedBy.${a.fieldKey}`));
  return "";
}

function inputRow(f: Formatter, a: Assumption): string[] {
  const note = confirmationLabel(a, (t, ref) => f.ident(t, ref), f.lang);
  return [f.ident(a.itemKey ? `${f.field(a.fieldKey, a.label)} (${a.itemKey === "All units" ? reportText(f.lang, "allUnits") : a.itemKey})` : f.field(a.fieldKey, a.label), `field.${a.fieldKey}`), inputValue(f, a), f.ident(reportSource(f.lang, a.source), `source.${a.fieldKey}`) + (note ? ` · ${note}` : "")];
}

const INPUT_COLUMNS = (lang: "en" | "fr") => [{ label: reportText(lang, "input") }, { label: reportText(lang, "value"), numeric: true }, { label: reportText(lang, "source") }];

function inputsAppendix(f: Formatter, x: ArtifactInput): Block {
  return { type: "table", caption: reportText(f.lang, "approvedInputs"), columns: INPUT_COLUMNS(f.lang), rows: x.assumptions.map((a) => inputRow(f, a)) };
}

/** The inputs a sponsor stated and nobody else confirmed, up front; nothing when there are none. */
function sponsorStatedBlocks(f: Formatter, x: ArtifactInput): Block[] {
  const stated = x.assumptions.filter((a) => a.sponsorStated);
  if (stated.length === 0) return [];
  const material = x.assumptions.filter((a) => a.sponsorStated || a.confirmedBy || a.confirmedByReview || FIELD_BY_KEY.get(a.fieldKey)?.material).length;
  const n = f.ident(String(stated.length), "sponsorStated.count");
  const m = f.ident(String(material), "materialInputs.count");
  const byClient = stated.filter((a) => a.clientConfirmedAt).length;
  const client = byClient > 0 ? reportText(f.lang, "clientCount", f.ident(String(byClient), "clientConfirmed.count")) : "";
  return [
    { type: "heading", text: reportText(f.lang, "sponsorStated") },
    {
      type: "paragraph",
      text: reportText(f.lang, "sponsorSummary", n, m, stated.length === 1 ? "was" : "were", x.kind === "ic_memo" ? "memo" : (x.kind === "build_decision" || x.kind === "partner_memo") ? "report" : "package", client),
    },
    { type: "table", columns: INPUT_COLUMNS(f.lang), rows: stated.map((a) => inputRow(f, a)) },
  ];
}

/** The one sentence for a line no document gave: a template, with no number. */
export const notFoundSentence = (n: { label: string; detail?: string }, lang: "en" | "fr" = "en") => reportText(lang, "missingSentence", n.label, n.detail ?? reportText(lang, "nothing"));

function notFoundBlocks(f: Formatter, x: ArtifactInput): Block[] {
  const list = x.notFound ?? [];
  if (list.length === 0) return [];
  return [{ type: "heading", text: reportText(x.lang ?? "en", "notFound") }, ...list.map((n): Block => ({ type: "paragraph", text: notFoundSentence({ ...n, label: f.lang === "fr" ? (n.itemKey ? `${f.field(n.fieldKey, n.label)} (${n.itemKey === "All units" ? reportText(f.lang, "allUnits") : n.itemKey})` : f.field(n.fieldKey, n.label)) : n.label, detail: f.lang === "fr" ? FR_ABSENT[n.fieldKey] ?? n.detail : n.detail }, f.lang) }))];
}

const STATE_WORDS = (lang: "en" | "fr") => ({ out_of_range: reportText(lang, "outOfRange"), no_effect: reportText(lang, "noEffect"), not_monotonic: reportText(lang, "notMonotonic") } as const);
const DRIVER_NAME = (lang: "en" | "fr"): Partial<Record<BreakevenRow["driver"], string>> => ({ pricePct: reportText(lang, "salePrices"), absorptionPct: reportText(lang, "salesPace"), presalesPts: reportText(lang, "presales"), rentPct: reportText(lang, "rent"), exitCapBps: reportText(lang, "exitCap"), costPct: reportText(lang, "projectCost"), rateBps: reportText(lang, "loanRates"), occupancyPts: reportText(lang, "stabilizedOccupancy") });
const ECHO_NAME = (lang: "en" | "fr"): Record<BreakevenEcho["key"], string> => ({ price: reportText(lang, "salePrice"), absorption: reportText(lang, "salesPace"), presales: reportText(lang, "presoldUnits"), rent: reportText(lang, "rent"), cost: reportText(lang, "projectCost"), exit_cap: reportText(lang, "exitCap"), senior_rate: reportText(lang, "seniorRate"), mezzanine_rate: reportText(lang, "mezzRate"), refinance_rate: reportText(lang, "refinanceRate"), occupancy: reportText(lang, "stabilizedOccupancy") });
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
    ? reportText(f.lang, "failsSome", f.ident(String(gates.length), "stress.failedGates"), gates.length === 1 ? "gate" : "gates", gates.map((g) => f.gate(g.key, g.label)).join("; "))
    : reportText(f.lang, "failsNone");
  return [{ type: "paragraph", text: reportText(f.lang, "weakest", f.ident(f.stress(w.key, w.label), `policy.stress.${w.key}`), fails, reportText(f.lang, sale ? "profitOnCostPhrase" : "sizingDscrPhrase"), f.metric(w.key, metricKey)) }];
}

/** For each failing gate, the one input that would make it pass, from `breakeven()` over the run's stored input and policy. */
function changeTheAnswer(f: Formatter, x: ArtifactInput): Block[] {
  const heading: Block = { type: "heading", text: reportText(f.lang, "changeAnswer") };
  const failing = x.result.verdict.gates.filter((g) => g.status === "failed");
  const hardFail: Block[] = x.result.verdict.hardFailReasons.length > 0
    ? [{ type: "paragraph", text: reportText(f.lang, "hardFail") }] : [];
  if (x.result.verdict.code === "APPROVE" || (failing.length === 0 && hardFail.length === 0)) return [];
  if (x.run.engineVersion !== ENGINE_VERSION) return [heading, { type: "paragraph", muted: true, text: reportText(f.lang, "earlierEngine") }, ...hardFail];
  const intro: Block[] = [heading];
  // The run stores its policy's hash: a policy edited under the same version name is a different policy.
  if (x.run.policyHash !== createHash("sha256").update(canonicalJson(x.policy)).digest("hex")) {
    // Break-evens worked out under another policy would not be this run's, so none are shown.
    return [heading, { type: "paragraph", muted: true, text: reportText(f.lang, "differentPolicy") }, ...hardFail];
  }
  intro.push(...hardFail);
  if (failing.length === 0) return intro;
  const { rows } = breakeven(x.input, x.policy);
  const body: string[][] = [];
  let ratesTogether = false;
  for (const g of failing) {
    const needs = f.run(g.threshold, g.unit, `gate.${g.key}.threshold`);
    const has = g.actual === null ? reportText(f.lang, "notMeasured") : f.run(g.actual, g.unit, `gate.${g.key}.actual`);
    // The gate's name, need and result print on its first row only.
    let first = true;
    const add = (cells: string[]) => {
      body.push([...(first ? [f.gate(g.key, g.label), needs, has] : ["", "", ""]), ...cells]);
      first = false;
    };
    for (const row of rows.filter((k) => k.gate === g.key)) {
      if (row.state !== "value") {
        add([DRIVER_NAME(f.lang)[row.driver] ?? row.driver, "\u2014", STATE_WORDS(f.lang)[row.state]]);
        continue;
      }
      if (row.driver === "rentPct" && row.to.length > 1) {
        // Rents move together by one share: the row says so, and the engine's own shock is the figure.
        add([reportText(f.lang, "rentTogether", f.ident(String(row.to.length), `breakeven.${g.key}.rent.count`)), "\u2014", `+${f.run(row.shock, "%", `breakeven.${g.key}.rent.shock`)}`]);
        continue;
      }
      if (row.driver === "pricePct" && row.to.length > 1) {
        add([reportText(f.lang, "priceTogether", f.ident(String(row.to.length), `breakeven.${g.key}.price.count`)), "—", `+${f.run(row.shock, "%", `breakeven.${g.key}.price.shock`)}`]);
        continue;
      }
      const allRates = row.driver === "rateBps" && row.to.length > 1;
      if (allRates) {
        add([reportText(f.lang, "rateTogether", f.ident(String(row.to.length), `breakeven.${g.key}.rate.count`)), "\u2014", `${row.shock! > 0 ? "+" : ""}${f.run(row.shock, "bps", `breakeven.${g.key}.rate.shock`)}`]);
        ratesTogether = true;
      }
      for (const e of row.to) {
        const ref = `breakeven.${g.key}.${e.key}${e.item ? "|" + e.item : ""}`;
        const name = (e.item ? `${ECHO_NAME(f.lang)[e.key]}, ${e.item}` : ECHO_NAME(f.lang)[e.key]) + (allRates ? reportText(f.lang, "sameMove") : "");
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
      columns: [{ label: reportText(f.lang, "gate") }, { label: reportText(f.lang, "needs"), numeric: true }, { label: reportText(f.lang, "thisRun"), numeric: true }, { label: reportText(f.lang, "inputMoved") }, { label: reportText(f.lang, "inThisRun"), numeric: true }, { label: reportText(f.lang, "passesAt"), numeric: true }],
      rows: body,
    },
    { type: "paragraph", muted: true, text: reportText(f.lang, "oneInput") + (ratesTogether ? reportText(f.lang, "ratesTogether") : "") },
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
  const { withValue: w, paid } = heldPartnerReturns(r.equityFlows, terms);
  const totals = (flows: { amount: number }[]) => ({
    contributed: -flows.filter((flow) => flow.amount < 0).reduce((n, flow) => n + flow.amount, 0),
    distributed: flows.filter((flow) => flow.amount > 0).reduce((n, flow) => n + flow.amount, 0),
  });
  const lpIrr = f.derived(w.lpIrr, "%", "irr(waterfall.LP.flows)"), gpIrr = f.derived(w.gpIrr, "%", "irr(waterfall.GP.flows)");
  const metricItem = (key: string) => ({ label: f.metricOf("base", key).label, value: f.metric("base", key) });
  const blocks: Block[] = [{ type: "stats", items: [
    metricItem("unrealized_equity_multiple"), metricItem("unrealized_equity_irr"),
    { label: reportText(f.lang, "lpIrrHeld"), value: lpIrr },
    { label: reportText(f.lang, "gpIrrHeld"), value: gpIrr },
  ] }];
  blocks.push({ type: "table", caption: reportText(f.lang, "partnerTerms"), columns: [{ label: reportText(f.lang, "term") }, { label: reportText(f.lang, "value"), numeric: true }],
    rows: [["lp_share_pct", terms.lpSharePct], ["preferred_return_pct", terms.preferredReturnPct], ["gp_promote_pct", terms.gpPromotePct]]
      .map(([key, value]) => [f.field(String(key), FIELD_BY_KEY.get(String(key))!.label), f.input(Number(value), "%", String(key))]),
  });
  const lp = totals(w.lp), gp = totals(w.gp);
  const has = (key: string) => r.scenarios.find((s) => s.key === "base")!.metrics.some((m) => m.key === key);
  const capital = ([["LP", lp, lpIrr], ["GP", gp, gpIrr]] as const).map(([label, cash, partnerIrr]) => [
    f.ident(reportText(f.lang, label === "LP" ? "lp" : "gp"), `waterfall.${label}.label`),
    f.derived(cash.contributed, "$", `sum(-waterfall.${label}.negativeFlows)`),
    f.derived(cash.distributed, "$", `sum(waterfall.${label}.positiveFlows)`),
    f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `waterfall.${label}.distributed / waterfall.${label}.contributed`),
    partnerIrr,
  ]);
  capital.push([reportText(f.lang, "total"),
    has("equity_contributed") ? f.metric("base", "equity_contributed") : f.derived(lp.contributed + gp.contributed, "$", "waterfall.LP.contributed + waterfall.GP.contributed"),
    has("equity_distributed") ? f.metric("base", "equity_distributed") : f.derived(lp.distributed + gp.distributed, "$", "waterfall.LP.distributed + waterfall.GP.distributed"),
    f.metric("base", "unrealized_equity_multiple"), f.metric("base", "unrealized_equity_irr"),
  ]);
  capital.push([reportText(f.lang, "gpPromoteHeld"), "", f.derived(w.promote, "$", "waterfall.promote"), "", ""]);
  blocks.push({ type: "table", caption: reportText(f.lang, "capitalHeld"),
    columns: [{ label: reportText(f.lang, "partner") }, { label: reportText(f.lang, "contributed"), numeric: true }, { label: reportText(f.lang, "distributed"), numeric: true }, { label: reportText(f.lang, "multiple"), numeric: true }, { label: reportText(f.lang, "irr"), numeric: true }],
    rows: capital,
  });
  const plp = totals(paid.lp), pgp = totals(paid.gp);
  const paidRows = ([["LP", plp], ["GP", pgp]] as const).map(([label, cash]) => [
    f.ident(reportText(f.lang, label === "LP" ? "lp" : "gp"), `paid.${label}.label`),
    f.derived(cash.contributed, "$", `sum(-paid.${label}.negativeFlows)`),
    f.derived(cash.distributed, "$", `sum(paid.${label}.positiveFlows)`),
    f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `paid.${label}.distributed / paid.${label}.contributed`),
  ]);
  const contributed = plp.contributed + pgp.contributed, paidOut = plp.distributed + pgp.distributed;
  paidRows.push([reportText(f.lang, "total"),
    f.derived(contributed, "$", "paid.LP.contributed + paid.GP.contributed"),
    f.derived(paidOut, "$", "paid.LP.distributed + paid.GP.distributed"),
    f.derived(contributed > 0 ? paidOut / contributed : null, "x", "paid.distributed / paid.contributed"),
  ]);
  paidRows.push([reportText(f.lang, "gpPromotePaid"), "", f.derived(paid.promote, "$", "paid.promote"), ""]);
  blocks.push({ type: "table", caption: reportText(f.lang, "paidCapital"),
    columns: [{ label: reportText(f.lang, "partner") }, { label: reportText(f.lang, "contributed"), numeric: true }, { label: reportText(f.lang, "paidOut"), numeric: true }, { label: reportText(f.lang, "paidMultiple"), numeric: true }],
    rows: paidRows,
  });
  blocks.push(
    { type: "paragraph", muted: true, text: reportText(f.lang, "waterfall") },
    { type: "paragraph", muted: true, text: reportText(f.lang, "heldExplanation") },
    sourcesAndUses(f, x),
    stresses(f, r, true, false, ["dcr_after_refinance", "unrealized_equity_multiple", "unrealized_equity_irr"]),
    ...notFoundBlocks(f, x),
    { type: "paragraph", muted: true, text: reportText(f.lang, "inputSources") },
  );
  return blocks;
}

export function buildModel(x: ArtifactInput): DocModel {
  if (x.kind === "partner_memo") {
    const lp = x.result.scenarios.find((s) => s.key === "base")?.metrics.find((m) => m.key === "lp_irr");
    const heldSplit = isHeld(x) && x.input.waterfall !== undefined;
    if (!heldSplit && (!lp || lp.status === "NOT_APPLICABLE")) throw new PartnerMemoUnavailableError();
  }
  const f = new Formatter(x.result, x.lang ?? "en", x.policy.maxLtcPct);
  const r = x.result;
  const date = f.ident(x.run.createdAt.slice(0, 10), "run.date");
  const runLabel = f.ident(reportText(f.lang, "run", String(x.run.runNumber)), "run.number");
  const verdict: Block = {
    type: "verdict",
    code: r.verdict.code,
    label: VERDICT_LABEL(f.lang)[r.verdict.code],
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
            { label: reportText(f.lang, "totalCost"), value: f.metric("base", "total_development_cost") },
            { label: reportText(f.lang, "yieldOnCost"), value: f.metric("base", "yield_on_cost") },
            { label: reportText(f.lang, "sizingDscr"), value: f.metric("base", "sizing_dscr") },
            { label: reportText(f.lang, "equityMultiple"), value: f.metric("base", "equity_multiple") },
            { label: reportText(f.lang, "equityIrr"), value: f.metric("base", "equity_irr") },
          ],
    });
    if (x.decision) {
      blocks.push({ type: "heading", text: reportText(f.lang, "committeeDecision") });
      // Recorded human text: printed as written and listed in the manifest as such.
      blocks.push({ type: "paragraph", text: `${f.lang === "fr" ? ({ approve: reportText("fr", "approve"), approve_with_conditions: reportText("fr", "approveConditions"), reject: reportText("fr", "reject"), return_to_underwriting: reportText("fr", "returnToUnderwriting") }[x.decision.decision] ?? x.decision.decision) : x.decision.decision.replace(/_/g, " ")}: ${f.ident(x.decision.rationale, "decision.rationale")}` });
      if (x.decision.conditions) blocks.push({ type: "paragraph", text: reportText(f.lang, "conditions", f.ident(x.decision.conditions, "decision.conditions")) });
    }
    blocks.push(sourcesAndUses(f, x), ...mezzAccrual(f, r), ...(sale ? [unitSales(f, x), saleResults(f, x), SALE_OPERATIONS(f.lang)] : [revenueProgram(f, x), operations(f, x)]), gates(f, r), stresses(f, r, held, sale), ...(sale ? [] : [annual(f, r, false)]));
    blocks.push({ type: "heading", text: reportText(f.lang, "checks") }, checks(f, r));
    blocks.push(...notFoundBlocks(f, x), inputsAppendix(f, x));
  } else if (x.kind === "partner_memo" && held) {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x), ...heldPartnerBlocks(f, x));
  } else if (x.kind === "partner_memo") {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    blocks.push({ type: "stats", items: ["equity_multiple", "equity_irr", "lp_irr", "gp_irr"].map((key) => ({
      label: f.metricOf("base", key).label, value: f.metric("base", key),
    })) });
    const terms = x.input.waterfall!;
    blocks.push({ type: "table", caption: reportText(f.lang, "partnerTerms"), columns: [{ label: reportText(f.lang, "term") }, { label: reportText(f.lang, "value"), numeric: true }],
      rows: [["lp_share_pct", terms.lpSharePct], ["preferred_return_pct", terms.preferredReturnPct], ["gp_promote_pct", terms.gpPromotePct]]
        .map(([key, value]) => [f.field(String(key), FIELD_BY_KEY.get(String(key))!.label), f.input(Number(value), "%", String(key))]),
    });
    const w = runWaterfall(r.equityFlows, terms);
    const totals = (flows: { amount: number }[]) => ({
      contributed: -flows.filter((flow) => flow.amount < 0).reduce((n, flow) => n + flow.amount, 0),
      distributed: flows.filter((flow) => flow.amount > 0).reduce((n, flow) => n + flow.amount, 0),
    });
    const lp = totals(w.lp), gp = totals(w.gp);
    const partnerRows = ([["LP", lp, "lp_irr"], ["GP", gp, "gp_irr"]] as const).map(([label, cash, irr]) => [
      f.ident(reportText(f.lang, label === "LP" ? "lp" : "gp"), `waterfall.${label}.label`),
      f.derived(cash.contributed, "$", `sum(-waterfall.${label}.negativeFlows)`),
      f.derived(cash.distributed, "$", `sum(waterfall.${label}.positiveFlows)`),
      f.derived(cash.contributed > 0 ? cash.distributed / cash.contributed : null, "x", `waterfall.${label}.distributed / waterfall.${label}.contributed`),
      f.metric("base", irr),
    ]);
    const has = (key: string) => r.scenarios.find((s) => s.key === "base")!.metrics.some((m) => m.key === key);
    partnerRows.push([reportText(f.lang, "total"),
      has("equity_contributed") ? f.metric("base", "equity_contributed") : f.derived(lp.contributed + gp.contributed, "$", "waterfall.LP.contributed + waterfall.GP.contributed"),
      has("equity_distributed") ? f.metric("base", "equity_distributed") : f.derived(lp.distributed + gp.distributed, "$", "waterfall.LP.distributed + waterfall.GP.distributed"),
      f.metric("base", "equity_multiple"), f.metric("base", "equity_irr"),
    ]);
    partnerRows.push([reportText(f.lang, "gpPromote"), "", f.metric("base", "gp_promote"), "", ""]);
    blocks.push({ type: "table", caption: reportText(f.lang, "capital"),
      columns: [{ label: reportText(f.lang, "partner") }, { label: reportText(f.lang, "contributed"), numeric: true }, { label: reportText(f.lang, "distributed"), numeric: true }, { label: reportText(f.lang, "multiple"), numeric: true }, { label: reportText(f.lang, "irr"), numeric: true }],
      rows: partnerRows,
    });
    blocks.push({ type: "paragraph", muted: true, text: reportText(f.lang, "waterfall") });
    blocks.push(sourcesAndUses(f, x), stresses(f, r, false, false, ["equity_multiple", "lp_irr", "gp_irr"]));
    if (sale) blocks.push(SALE_OPERATIONS(f.lang));
    blocks.push(...notFoundBlocks(f, x), { type: "paragraph", muted: true, text: reportText(f.lang, "inputSources") });
  } else if (x.kind === "build_decision") {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    blocks.push({
      type: "stats",
      items: sale ? saleStats(f, false) : held
        ? [
            ...heldStats(f, false),
            { label: reportText(f.lang, "yieldOnCost"), value: f.metric("base", "yield_on_cost") },
            { label: reportText(f.lang, "sizingWorst"), value: f.metric("base", "sizing_dscr") },
          ]
        : [
            { label: reportText(f.lang, "yieldOnCost"), value: f.metric("base", "yield_on_cost") },
            { label: reportText(f.lang, "sizingWorst"), value: f.metric("base", "sizing_dscr") },
            { label: reportText(f.lang, "equityMultiple"), value: f.metric("base", "equity_multiple") },
          ],
    });
    blocks.push(...weakestStress(f, r, sale));
    // An approved deal has no gate to move; its stresses stand in for the section.
    blocks.push(...(r.verdict.code === "APPROVE" ? [stresses(f, r, held, sale)] : changeTheAnswer(f, x)));
    if (r.verdict.code !== "APPROVE" && r.verdict.hardFailReasons.length > 0 && !r.verdict.gates.some((g) => g.status === "failed")) {
      blocks.push(stresses(f, r, held, sale));
    }
    blocks.push(...notFoundBlocks(f, x), { type: "paragraph", muted: true, text: reportText(f.lang, "inputSources") });
  } else {
    blocks.push(verdict, ...draftLine(x), ...sponsorStatedBlocks(f, x));
    if (held) blocks.push({ type: "stats", items: heldStats(f) });
    const i = x.input;
    const debtRows: string[][] = [];
    if (i.senior.amount > 0) {
      debtRows.push(
        [reportText(f.lang, "senior"), f.input(i.senior.amount, "$", "senior_loan_amount")],
        [reportText(f.lang, "seniorRateShort"), f.input(i.senior.ratePct, "%", "senior_rate_pct")],
        ...(sale ? [] : [
          ...(i.senior.amortYears === undefined ? [] : [[reportText(f.lang, "amortization"), f.input(i.senior.amortYears, "years", "senior_amort_years")]]),
          [reportText(f.lang, "ioPeriod"), f.input(i.senior.ioMonths, "months", "senior_io_months")],
        ]),
      );
    }
    if (i.mezzanine && i.mezzanine.amount > 0) {
      debtRows.push([reportText(f.lang, "mezz"), f.input(i.mezzanine.amount, "$", "mezz_loan_amount")], [reportText(f.lang, "mezzRateShort"), f.input(i.mezzanine.ratePct, "%", "mezz_rate_pct")], [reportText(f.lang, "mezzExcess"), f.metric("base", "mezz_interest_accrued")]);
    }
    debtRows.push([reportText(f.lang, "ltc"), f.metric("base", "loan_to_cost")]);
    if (sale) {
      if (i.forSale!.presaleThresholdPct !== undefined) debtRows.push(
        [f.field("senior_presale_threshold_pct", FIELD_BY_KEY.get("senior_presale_threshold_pct")!.label), f.input(i.forSale!.presaleThresholdPct, "%", "senior_presale_threshold_pct")],
        [f.field("presold_units_pct", FIELD_BY_KEY.get("presold_units_pct")!.label), f.input(i.forSale!.presoldPct, "%", "presold_units_pct")],
      );
      for (const key of ["interest_after_completion", "senior_balance_at_completion", ...(i.mezzanine && i.mezzanine.amount > 0 ? ["mezz_balance_at_completion"] : [])]) {
        debtRows.push([f.metricOf("base", key).label, f.metric("base", key)]);
      }
    } else debtRows.push(
      [reportText(f.lang, "debtYield"), f.metric("base", "debt_yield")],
      [reportText(f.lang, "sizingWorst"), f.metric("base", "sizing_dscr")],
      [reportText(f.lang, "contractualWorst"), f.metric("base", "contractual_dscr")],
      [reportText(f.lang, "ioCoverage"), f.metric("base", "io_dscr_year1")],
      [reportText(f.lang, "cashShortfall"), f.metric("base", "cumulative_cash_shortfall")],
      [reportText(f.lang, "breakEvenOccupancy"), f.metric("base", "break_even_occupancy")],
    );
    const refinanceDcr = r.verdict.gates.find((g) => g.key === "dcr_after_refinance");
    if (refinanceDcr) debtRows.push([reportText(f.lang, "refiCoverageMin"), f.run(refinanceDcr.threshold, refinanceDcr.unit, "gate.dcr_after_refinance.threshold")]);
    blocks.push({ type: "table", caption: sale ? reportText(f.lang, "debt") : reportText(f.lang, "debtCoverage"), columns: [{ label: reportText(f.lang, "term") }, { label: reportText(f.lang, "value"), numeric: true }], rows: debtRows });
    // Beside the refinance loan: the premium is added to it, not paid in cash.
    if (i.refinance?.insurancePremiumPct !== undefined) {
      blocks.push({ type: "paragraph", text: reportText(f.lang, "premium", f.input(i.refinance.insurancePremiumPct, "%", "refinance_insurance_premium_pct"), f.metric("base", "refinance_premium_added")) });
    }
    blocks.push(sourcesAndUses(f, x), ...mezzAccrual(f, r), ...(sale ? [unitSales(f, x), saleResults(f, x), SALE_OPERATIONS(f.lang)] : [operations(f, x), annual(f, r, true)]), stresses(f, r, held, sale));
    blocks.push({ type: "heading", text: reportText(f.lang, "checks") }, checks(f, r));
    blocks.push(...notFoundBlocks(f, x), inputsAppendix(f, x));
  }
  const footer =
    reportText(f.lang, "footerTrace", runLabel) +
    reportText(f.lang, "footerEngine", f.ident(x.run.engineVersion, "run.engine"), f.ident(x.run.policyVersion, "run.policy")) +
    reportText(f.lang, "footerHashes", f.ident(x.run.inputHash.slice(0, 16), "run.inputHash"), f.ident(x.run.resultHash.slice(0, 16), "run.resultHash"));
  // Every amount prints with "$"; the deal says once which dollar that is.
  const currency = x.deal.currency ? reportText(f.lang, "currency", CURRENCY_NAMES[x.deal.currency][f.lang === "fr" ? 1 : 0], x.deal.currency) : reportText(f.lang, "currencyMissing");
  const logo = x.kind === "lender_package" ? x.broker?.logo : undefined;
  // At most 48 px high and 240 px wide, keeping its aspect.
  const scale = logo ? Math.min(1, 48 / logo.height, 240 / logo.width) : 1;
  return {
    lang: f.lang,
    ...(f.lang === "fr" ? { banner: reportText("fr", "banner") } : {}),
    ...(logo ? { brand: { preparedBy: reportText(f.lang, "preparedBy", f.ident(x.broker!.name, "broker.name")),
      logo: { ...logo, width: Math.max(1, Math.round(logo.width * scale)), height: Math.round(logo.height * scale) } } } : {}),
    title: f.ident(x.deal.name, "deal.name"),
    kicker: { ic_memo: reportText(f.lang, "icMemo"), build_decision: reportText(f.lang, "buildDecision"), partner_memo: reportText(f.lang, "partnerMemo") }[x.kind as string] ?? reportText(f.lang, "lenderPackage"),
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
