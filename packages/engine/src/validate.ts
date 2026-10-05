import type { EngineInput } from "@agir/contracts";

export class EngineInputError extends Error {
  constructor(public readonly problems: string[]) {
    super(`The underwriting input is not valid: ${problems.join("; ")}`);
    this.name = "EngineInputError";
  }
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/**
 * Reject an input the model cannot price, naming every problem. Readiness
 * should make these unreachable from the product; the engine checks anyway,
 * because it is the last line before a number is produced.
 */
export function validateInput(input: EngineInput): void {
  const p: string[] = [];
  const b = input.budget;
  for (const k of ["land", "hard", "soft", "contingency", "other"] as const) {
    // Only a credit may take other costs below 0.
    if (!finite(b[k]) || (k !== "other" && b[k] < 0)) p.push(`budget ${k} must be a number of at least 0`);
  }
  if (finite(b.other) && b.other < 0) {
    if (b.land + b.hard + b.soft + b.contingency + b.other <= 0) p.push("a credit in other costs cannot take the total budget to 0 or below");
    // The credit is spread with hard, soft and contingency: a bigger one would make a month's construction spend negative.
    if (b.hard + b.soft + b.contingency + b.other < 0) p.push("a credit in other costs cannot be more than hard costs, soft costs and contingency together");
  }
  if (input.revenue.length === 0) p.push("at least one revenue component is required");
  for (const c of input.revenue) {
    const name = `revenue component "${c.label || c.key}"`;
    if (c.basis === "per_unit") {
      if (!finite(c.units) || c.units <= 0) p.push(`${name} needs a unit count above 0`);
      if (!finite(c.rentMonthly) || (c.rentMonthly ?? 0) < 0) p.push(`${name} needs a monthly rent`);
    } else {
      if (!finite(c.areaSf) || (c.areaSf ?? 0) <= 0) p.push(`${name} needs a rentable area above 0`);
      if (!finite(c.rentPsfAnnual) || (c.rentPsfAnnual ?? 0) < 0) p.push(`${name} needs a rent per SF`);
    }
    if (c.occupancyPct !== undefined && (!finite(c.occupancyPct) || c.occupancyPct < 0 || c.occupancyPct > 100)) {
      p.push(`${name} occupancy must be between 0 and 100`);
    }
  }
  const intIn = (x: number, lo: number, hi: number) => finite(x) && Number.isInteger(x) && x >= lo && x <= hi;
  if (!intIn(input.constructionMonths, 0, 120)) p.push("construction months must be a whole number from 0 to 120");
  if (!intIn(input.leaseUpMonths, 0, 120)) p.push("lease-up months must be a whole number from 0 to 120");
  if (!intIn(input.holdYears, 1, 40)) p.push("hold years must be a whole number from 1 to 40");
  if (!finite(input.stabilizedOccupancyPct) || input.stabilizedOccupancyPct < 0 || input.stabilizedOccupancyPct > 100) {
    p.push("stabilized occupancy must be between 0 and 100");
  }
  const hasRatio = input.expenseRatioPct !== undefined;
  const hasFixed = input.fixedOpexAnnual !== undefined;
  if (!hasRatio && !hasFixed) p.push("an expense ratio or fixed operating costs are required");
  if (hasRatio && hasFixed) p.push("give either an expense ratio or fixed operating costs, not both");
  if (!finite(input.exitCapPct) || input.exitCapPct <= 0) p.push("exit cap rate must be above 0");
  if (!finite(input.sellingCostsPct) || input.sellingCostsPct < 0 || input.sellingCostsPct >= 100) {
    p.push("selling costs must be from 0 to under 100 percent");
  }
  const loan = (name: string, l: { amount: number; ratePct: number; amortYears: number; ioMonths: number }) => {
    if (!finite(l.amount) || l.amount < 0) p.push(`${name} amount must be at least 0`);
    if (l.amount > 0) {
      if (!finite(l.ratePct) || l.ratePct < 0) p.push(`${name} rate must be at least 0`);
      if (!intIn(l.amortYears, 1, 50)) p.push(`${name} amortization must be 1 to 50 years`);
      if (!intIn(l.ioMonths, 0, 600)) p.push(`${name} interest-only months must be 0 to 600`);
    }
  };
  loan("senior loan", input.senior);
  if (input.mezzanine) loan("mezzanine loan", input.mezzanine);
  const S = input.constructionMonths + input.leaseUpMonths;
  const T = S + 12 * input.holdYears - 1;
  if (input.refinance) {
    const r = input.refinance;
    if (!intIn(r.month, S, T - 1)) p.push(`refinance month must fall from stabilization (month ${S}) to before the sale (month ${T})`);
    const hasAmount = r.amount !== undefined;
    const hasLtv = r.ltvPct !== undefined;
    if (hasAmount === hasLtv) p.push("give the refinance either a loan amount or a loan-to-value, not both or neither");
    loan("refinance loan", { amount: r.amount ?? 1, ratePct: r.ratePct, amortYears: r.amortYears, ioMonths: r.ioMonths });
  }
  if (input.waterfall) {
    const w = input.waterfall;
    if (!finite(w.lpSharePct) || w.lpSharePct <= 0 || w.lpSharePct >= 100) p.push("LP share must be above 0 and below 100");
    if (!finite(w.preferredReturnPct) || w.preferredReturnPct < 0) p.push("preferred return must be at least 0");
    if (!finite(w.gpPromotePct) || w.gpPromotePct < 0 || w.gpPromotePct > 100) p.push("GP promote must be from 0 to 100");
  }
  if (p.length > 0) throw new EngineInputError(p);
}
