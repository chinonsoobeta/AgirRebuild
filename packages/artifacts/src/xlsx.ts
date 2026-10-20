import { plainTerm, FIELD_BY_KEY, placeLabel } from "@agir/contracts";
import { heldPartnerReturns, runWaterfall } from "@agir/engine";
import { confirmationLabel, DRAFT_POLICY_LINE, notFoundSentence, type ArtifactInput } from "./model.ts";

/**
 * The model export: every number of the run as a number, never as text, so an
 * analyst can check it in a spreadsheet. Values are read from the stored run;
 * partner flows use the existing waterfall over the stored equity flows.
 */
export async function renderXlsx(x: ArtifactInput): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Agir";
  wb.created = new Date(x.run.createdAt);
  const r = x.result;
  const sale = x.input.exit === "for_sale";
  const fmt = (unit: string) => (unit === "$" ? '"$"#,##0;[Red]-"$"#,##0' : unit === "%" ? '0.00"%"' : unit === "x" ? '0.00"x"' : unit === "bps" ? '0" bps"' : "#,##0");
  const head = (ws: import("exceljs").Worksheet, cols: string[]) => {
    const row = ws.addRow(cols);
    row.font = { bold: true };
    row.border = { bottom: { style: "thin" } };
    ws.views = [{ state: "frozen", ySplit: ws.rowCount }];
  };

  const summary = wb.addWorksheet("Summary");
  summary.addRow([x.deal.name]).font = { bold: true, size: 14 };
  summary.addRow([[x.deal.assetType, placeLabel(x.deal.location, x.deal.province)].filter(Boolean).join(" · ")]);
  summary.addRow(["Currency", x.deal.currency ?? "Not stated"]);
  summary.addRow([`Run ${x.run.runNumber}`, x.run.createdAt]);
  summary.addRow(["Engine", x.run.engineVersion, "Policy", x.run.policyVersion]);
  if (x.policy.draft) summary.addRow([DRAFT_POLICY_LINE]);
  summary.addRow(["Input hash", x.run.inputHash]);
  summary.addRow(["Result hash", x.run.resultHash]);
  summary.addRow([]);
  summary.addRow(["Verdict", r.verdict.code, plainTerm("en",r.verdict.headline)]).font = { bold: true };
  summary.addRow([]);
  head(summary, ["Gate", "Scenario", "Threshold", "Actual", "Outcome"]);
  for (const g of r.verdict.gates) {
    const row = summary.addRow([plainTerm("en",g.label), g.scenario, g.threshold, g.actual, g.status]);
    row.getCell(3).numFmt = fmt(g.unit);
    row.getCell(4).numFmt = fmt(g.unit);
  }
  const tableValues=x.assumptions.filter(a=>a.sourceKind === "table");
  if (tableValues.length) {
    summary.addRow([]); summary.addRow(["Taken from published tables"]);
    for (const a of tableValues) summary.addRow([plainTerm("en",FIELD_BY_KEY.get(a.fieldKey)?.label ?? a.fieldKey),a.value,a.source]);
  }
  summary.columns.forEach((c) => (c.width = 26));

  const metrics = wb.addWorksheet("Metrics");
  head(metrics, ["Metric", "Unit", ...r.scenarios.map((s) => s.label), "Formula"]);
  if (sale) metrics.addRow(["Metrics marked not applicable are omitted: The units are sold; there is no rental income."]);
  for (const m of r.scenarios[0]!.metrics) {
    if (sale && m.status === "NOT_APPLICABLE" && m.reason === "The units are sold; there is no rental income.") continue;
    const row = metrics.addRow([
      plainTerm("en",m.label),
      m.unit,
      ...r.scenarios.map((s) => {
        const v = s.metrics.find((z) => z.key === m.key)!;
        return v.status === "VALID" ? v.value : v.status === "NOT_APPLICABLE" ? "Not applicable" : "Not meaningful";
      }),
      m.formula,
    ]);
    r.scenarios.forEach((_, i) => (row.getCell(3 + i).numFmt = fmt(m.unit)));
  }
  metrics.columns.forEach((c, i) => (c.width = i === 0 ? 34 : 16));

  if (!sale) {
    const annual = wb.addWorksheet("Annual");
    head(annual, ["Year", "GPR", "EGI", "Operating costs", "NOI", "Debt service", "Sizing debt service", "Cash flow"]);
    for (const y of r.annual) {
      const row = annual.addRow([y.year === 0 ? "Before stabilization" : y.year, y.gpr, y.egi, y.opex, y.noi, y.debtService, y.sizingDebtService, y.cashFlow]);
      for (let c = 2; c <= 8; c++) row.getCell(c).numFmt = fmt("$");
    }
    annual.columns.forEach((c) => (c.width = 18));
  }

  const ledger = wb.addWorksheet("Monthly ledger");
  // A held deal has no sale, so its ledger has no sale column.
  const held = x.input.exit === "refinance_hold";
  head(ledger, sale ? ["Month", "Phase", "Cost draw", "Equity draw", "Debt draw", "Capitalized interest", "Loan repayment", "Debt balance", "Sale to equity"] : ["Month", "Phase", "Cost draw", "Equity draw", "Debt draw", "Capitalized interest", "EGI", "Operating costs", "NOI", "Debt service", "Debt balance", "Refinance net", ...(held ? [] : ["Sale to equity"])]);
  for (const m of r.ledger) {
    // A sale's months after completion are selling completed units, not a hold.
    const row = ledger.addRow(sale ? [m.month, m.phase === "hold" ? "selling" : m.phase, m.costDraw, m.equityDraw, m.debtDraw, m.capitalizedInterest, m.debtService, m.debtBalance, m.saleNet] : [m.month, m.phase, m.costDraw, m.equityDraw, m.debtDraw, m.capitalizedInterest, m.egi, m.opex, m.noi, m.debtService, m.debtBalance, m.refinanceNet, ...(held ? [] : [m.saleNet])]);
    for (let c = 3; c <= (sale ? 9 : held ? 12 : 13); c++) row.getCell(c).numFmt = fmt("$");
  }
  ledger.columns.forEach((c) => (c.width = 15));

  const flows = wb.addWorksheet("Equity flows");
  head(flows, ["Month", "Years from start", "Kind", "Amount"]);
  for (const f of r.equityFlows) {
    const row = flows.addRow([f.month, f.t, f.kind === "unrealized" ? "Unrealized, not a sale" : f.kind, f.amount]);
    row.getCell(4).numFmt = fmt("$");
  }

  const lpIrr = r.scenarios.find((s) => s.key === "base")!.metrics.find((m) => m.key === "lp_irr");
  // A held run with a split has the sheet too (card 88); its partner returns are unrealized, not a sale.
  const heldSplit = x.input.exit === "refinance_hold" && x.input.waterfall ? heldPartnerReturns(r.equityFlows, x.input.waterfall) : null;
  if (heldSplit || (lpIrr && lpIrr.status !== "NOT_APPLICABLE")) {
    const partners = wb.addWorksheet("Partners");
    const terms = x.input.waterfall!;
    for (const [key, value] of [["lp_share_pct", terms.lpSharePct], ["preferred_return_pct", terms.preferredReturnPct], ["gp_promote_pct", terms.gpPromotePct]] as const) {
      const row = partners.addRow([FIELD_BY_KEY.get(key)!.label, value]);
      row.getCell(2).numFmt = fmt("%");
    }
    head(partners, ["Month (cash date)", "Year", "Kind", "Deal flow", "LP flow", "GP flow"]);
    const months = new Map<number, { t: number; kinds: string[]; deal: number; lp: number; gp: number }>();
    for (const flow of r.equityFlows) {
      const key = Math.round(flow.t * 12);
      const month = months.get(key) ?? { t: flow.t, kinds: [], deal: 0, lp: 0, gp: 0 };
      const kind = flow.kind === "unrealized" ? "Unrealized, not a sale" : flow.kind;
      if (!month.kinds.includes(kind)) month.kinds.push(kind);
      month.deal += flow.amount;
      months.set(key, month);
    }
    const waterfall = heldSplit ? heldSplit.withValue : runWaterfall(r.equityFlows, terms);
    for (const [key, entries] of [["lp", waterfall.lp], ["gp", waterfall.gp]] as const) {
      for (const flow of entries) months.get(Math.round(flow.t * 12))![key] += flow.amount;
    }
    const totals = [0, 0, 0];
    for (const [key, month] of [...months].sort(([a], [b]) => a - b)) {
      const amounts = [month.deal, month.lp, month.gp];
      const row = partners.addRow([key, month.t, month.kinds.join(", "), ...amounts]);
      amounts.forEach((amount, n) => { totals[n]! += amount; row.getCell(n + 4).numFmt = fmt("$"); });
    }
    const total = partners.addRow(["Total", null, null, ...totals]);
    for (const col of [4, 5, 6]) total.getCell(col).numFmt = fmt("$");
    if (heldSplit) {
      const positive = (flows: { amount: number }[]) => flows.filter((flow) => flow.amount > 0).reduce((n, flow) => n + flow.amount, 0);
      const rows: [string, number | null, "%" | "$"][] = [
        ["LP IRR (unrealized, not a sale)", heldSplit.withValue.lpIrr, "%"],
        ["GP IRR (unrealized, not a sale)", heldSplit.withValue.gpIrr, "%"],
        ["GP promote (unrealized, not a sale)", heldSplit.withValue.promote, "$"],
        ["", null, "$"],
        ["Paid out to the LP", positive(heldSplit.paid.lp), "$"],
        ["Paid out to the GP", positive(heldSplit.paid.gp), "$"],
        ["GP promote paid", heldSplit.paid.promote, "$"],
      ];
      for (const [label, value, unit] of rows) {
        if (!label) { partners.addRow([]); continue; }
        const row = partners.addRow([label, value ?? "Not meaningful"]);
        if (value !== null) row.getCell(2).numFmt = fmt(unit);
      }
    } else {
      for (const key of ["lp_irr", "gp_irr", "gp_promote"]) {
        const metric = r.scenarios.find((s) => s.key === "base")!.metrics.find((m) => m.key === key)!;
        const row = partners.addRow([plainTerm("en",metric.label), metric.status === "VALID" ? metric.value : metric.reason]);
        row.getCell(2).numFmt = fmt(metric.unit);
      }
    }
    partners.columns.forEach((c) => (c.width = 24));
  }

  const inputs = wb.addWorksheet("Inputs");
  head(inputs, ["Field", "Component", "Value", "Unit", "Source", "Confirmation"]);
  for (const a of x.assumptions) {
    inputs.addRow([plainTerm("en",FIELD_BY_KEY.get(a.fieldKey)?.label ?? a.fieldKey), a.itemKey ?? "", a.value, a.unit, a.source, confirmationLabel(a)]);
  }
  inputs.columns.forEach((c, i) => (c.width = i === 4 ? 60 : 22));

  if (x.notFound?.length) {
    const nf = wb.addWorksheet("Not found");
    head(nf, ["Not found in the documents"]);
    for (const n of x.notFound) nf.addRow([notFoundSentence(n)]);
    nf.getColumn(1).width = 100;
  }

  const checks = wb.addWorksheet("Checks");
  head(checks, ["Check", "Kind", "Severity", "Message"]);
  for (const c of r.checks) checks.addRow([c.key, c.kind, c.severity, plainTerm("en",c.message)]);
  checks.getColumn(4).width = 100;

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
