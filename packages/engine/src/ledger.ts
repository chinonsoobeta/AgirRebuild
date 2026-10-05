// The one monthly ledger. Every figure Agir shows or decides on is a projection
// of what this module builds. Conventions (docs/spec/economic-model.md):
//
// Time      Month m covers [m, m+1) from t0. Construction is [0, C), lease-up
//           [C, S) with S = C + L, the hold [S, S + 12H). The sale is struck at
//           month T = S + 12H - 1. Each phase length is a whole number.
// Funding   Equity first, then mezzanine, then senior. Interest on each
//           tranche accrues on its opening balance every month before S and is
//           capitalized into that tranche while it has commitment left; any
//           senior shortfall is paid by equity, while mezzanine interest beyond
//           its commitment accrues on the mezzanine balance (owner decision,
//           2026-10-05). Required equity is solved so that the debt is exactly
//           fully drawn at S (or is zero if debt alone suffices), and an equity
//           overrun never coexists with unused commitment.
// Revenue   Rent grows by hold year. Occupancy ramps linearly through lease-up
//           only when the deal opts in; otherwise there is no income before S.
//           With the ramp off the fixed operating costs are still paid every
//           month of lease-up, as a cost funded like any other and part of TDC;
//           with the ramp on they are netted against the lease-up income.
// Expenses  Decision 8: the fixed part grows at expense growth; the variable
//           part is a share of that month's EGI. A single ratio is fixed
//           dollars equal to that share of year-1 stabilized EGI.
// Debt      No cash debt service before S (the interest reserve is in TDC).
//           Interest-only until the later of the IO period and S, then a level
//           payment over the amortization term on the balance at that moment.
// Sizing    Decision 1: sizing debt service is the level amortizing payment on
//           each tranche's sized principal (its balance at S, or the refinance
//           amount), for every month the tranche is in force.
// Refinance At the start of month R the senior balance is paid off and replaced.
// Sale      Exit value = final hold-year NOI / exit cap. Debt is paid off at T.
//           The non-recourse floor applies to the sale leg only.
// Flows     Contributions are dated when paid (t = m/12). Operating cash is
//           distributed per hold year at its end; lease-up income at t = S/12;
//           a refinance at t = R/12; the sale at t = (T + 1)/12.

import type { AnnualRow, EngineInput, EquityFlow, LedgerRow, LoanTerms } from "@agir/contracts";
import { allocate, drawShares, levelPayment, sum } from "./math.ts";

type TrancheKey = "mezzanine" | "senior";

type ConstructionResult = {
  costByMonth: number[];
  equityDraw: number[];
  debtDraw: number[];
  capitalizedInterest: number[];
  interestPaidByEquity: number[];
  balances: Record<TrancheKey, number>;
  interestByTranche: Record<TrancheKey, number>;
  unusedCommitment: number;
  equityOverrun: number;
  mezzAccruedBeyondCommitment: number;
};

export type Ledger = {
  S: number;
  T: number;
  rows: LedgerRow[];
  costsBeforeFinancing: number;
  capitalizedInterest: number;
  tdc: number;
  /** Fixed operating cost paid in the lease-up months with the ramp off, inside tdc (0 when there is none). */
  leaseupOperatingCost: number;
  commitments: number;
  drawnDebtAtS: number;
  requiredEquity: number;
  equityContributed: number;
  converged: boolean;
  /** Mezzanine interest before S above its commitment, added to the mezzanine balance. */
  mezzAccruedBeyondCommitment: number;
  balancesAtS: Record<TrancheKey, number>;
  /** Year-1 interest on the balances in force at S, at their own rates. */
  ioDebtServiceAtS: number;
  /** Sum over the hold of the negative monthly cash flow after debt service, as a positive amount. */
  cumulativeCashShortfall: number;
  annual: AnnualRow[];
  year1: { gpr: number; egi: number; opex: number; fixedOpex: number; variableShare: number; noi: number };
  finalYearNoi: number;
  exitValue: number | null;
  netSale: number | null;
  payoffAtSale: number;
  saleLeg: number;
  wipeout: boolean;
  refinance: { month: number; newAmount: number; payoff: number; net: number } | null;
  sizingDsByYear: number[];
  contractualDsByYear: number[];
  seniorSizingYear1: number;
  mezzSizingYear1: number;
  equityFlows: EquityFlow[];
  units: number;
};

function componentAnnualRent(c: EngineInput["revenue"][number]): number {
  return c.basis === "per_unit" ? c.units * (c.rentMonthly ?? 0) * 12 : (c.areaSf ?? 0) * (c.rentPsfAnnual ?? 0);
}

/** Revenue and operating cost in month m, independent of debt. */
function operationsAt(input: EngineInput, m: number, S: number, fixedBase: number, variableShare: number) {
  const C = input.constructionMonths;
  const L = input.leaseUpMonths;
  let ramp: number;
  if (m >= S) ramp = 1;
  else if (input.leaseUpRamp && L > 0 && m >= C) ramp = (m - C + 0.5) / L;
  else return { gpr: 0, egi: 0, opex: 0 };
  const year = m >= S ? Math.floor((m - S) / 12) + 1 : 1;
  const rentGrowth = Math.pow(1 + input.rentGrowthPct / 100, year - 1);
  const expenseGrowth = Math.pow(1 + input.expenseGrowthPct / 100, year - 1);
  let gpr = 0;
  let egi = 0;
  for (const c of input.revenue) {
    const monthly = (componentAnnualRent(c) / 12) * rentGrowth;
    const occ = (c.occupancyPct ?? input.stabilizedOccupancyPct) / 100;
    gpr += monthly;
    egi += monthly * occ * ramp;
  }
  egi += (input.otherIncomeAnnual / 12) * rentGrowth * ramp;
  // Fixed costs do not lease up: they are due in full from the first operating month.
  const opex = (fixedBase / 12) * expenseGrowth + variableShare * egi;
  return { gpr, egi, opex };
}

function stabilizedYear1Egi(input: EngineInput): number {
  let egi = input.otherIncomeAnnual;
  for (const c of input.revenue) egi += componentAnnualRent(c) * ((c.occupancyPct ?? input.stabilizedOccupancyPct) / 100);
  return egi;
}

function tranches(input: EngineInput): { key: TrancheKey; terms: LoanTerms }[] {
  const out: { key: TrancheKey; terms: LoanTerms }[] = [];
  if (input.mezzanine && input.mezzanine.amount > 0) out.push({ key: "mezzanine", terms: input.mezzanine });
  if (input.senior.amount > 0) out.push({ key: "senior", terms: input.senior });
  return out;
}

function simulateConstruction(input: EngineInput, S: number, costByMonth: number[], equityBudget: number): ConstructionResult {
  const stack = tranches(input);
  const remaining: Record<TrancheKey, number> = { mezzanine: 0, senior: 0 };
  const balances: Record<TrancheKey, number> = { mezzanine: 0, senior: 0 };
  const interestByTranche: Record<TrancheKey, number> = { mezzanine: 0, senior: 0 };
  for (const t of stack) remaining[t.key] = t.terms.amount;
  let equityLeft = equityBudget;
  let overrun = 0;
  let mezzAccrued = 0;
  const equityDraw: number[] = [];
  const debtDraw: number[] = [];
  const capInt: number[] = [];
  const intByEquity: number[] = [];
  for (let m = 0; m < S; m++) {
    let eq = 0;
    let debt = 0;
    let capitalized = 0;
    let paidByEquity = 0;
    // Interest on opening balances, capitalized while commitment lasts.
    for (const t of stack) {
      const interest = (balances[t.key] * t.terms.ratePct) / 100 / 12;
      interestByTranche[t.key] += interest;
      const cap = Math.min(interest, remaining[t.key]);
      remaining[t.key] -= cap;
      balances[t.key] += cap;
      capitalized += cap;
      const shortfall = interest - cap;
      if (shortfall > 0 && t.key === "mezzanine") {
        // Paid in kind: it grows the mezzanine balance, and is neither a draw nor an equity overrun.
        balances.mezzanine += shortfall;
        mezzAccrued += shortfall;
        capitalized += shortfall;
      } else if (shortfall > 0) {
        const fromBudget = Math.min(shortfall, equityLeft);
        equityLeft -= fromBudget;
        eq += fromBudget;
        overrun += shortfall - fromBudget;
        eq += shortfall - fromBudget;
        paidByEquity += shortfall;
      }
    }
    // Costs: equity first, then mezzanine, then senior, then equity overrun.
    let need = costByMonth[m] ?? 0;
    const fromEquity = Math.min(need, equityLeft);
    equityLeft -= fromEquity;
    eq += fromEquity;
    need -= fromEquity;
    for (const t of stack) {
      if (need <= 0) break;
      const draw = Math.min(need, remaining[t.key]);
      remaining[t.key] -= draw;
      balances[t.key] += draw;
      debt += draw;
      need -= draw;
    }
    if (need > 0) {
      overrun += need;
      eq += need;
    }
    equityDraw.push(eq);
    debtDraw.push(debt);
    capInt.push(capitalized);
    intByEquity.push(paidByEquity);
  }
  // Equity budgeted but never needed is simply not contributed.
  const unusedBudget = equityLeft;
  if (unusedBudget > 0) {
    // Walk back the last equity draws by the unused amount (they were never called).
    let left = unusedBudget;
    for (let m = equityDraw.length - 1; m >= 0 && left > 0; m--) {
      const take = Math.min(left, equityDraw[m] ?? 0);
      equityDraw[m] = (equityDraw[m] ?? 0) - take;
      left -= take;
    }
  }
  return {
    costByMonth,
    equityDraw,
    debtDraw,
    capitalizedInterest: capInt,
    interestPaidByEquity: intByEquity,
    balances,
    interestByTranche,
    unusedCommitment: remaining.mezzanine + remaining.senior,
    equityOverrun: overrun,
    mezzAccruedBeyondCommitment: mezzAccrued,
  };
}

export function buildLedger(input: EngineInput): Ledger {
  const C = input.constructionMonths;
  const S = C + input.leaseUpMonths;
  const H = input.holdYears;
  const T = S + 12 * H - 1;
  const months = T + 1;

  // ---- Cost placement ------------------------------------------------------
  const b = input.budget;
  const y1Egi = stabilizedYear1Egi(input);
  const fixedBase = input.fixedOpexAnnual ?? ((input.expenseRatioPct ?? 0) / 100) * y1Egi;
  const variableShare = (input.variableExpensePct ?? 0) / 100;
  const costsBeforeFinancing = b.land + b.hard + b.soft + b.contingency + b.other;
  const spread = allocate(b.hard + b.soft + b.contingency + b.other, drawShares(C, input.sCurveDraws));
  const costByMonth: number[] = new Array(Math.max(S, 1)).fill(0);
  costByMonth[0] = (costByMonth[0] ?? 0) + b.land;
  spread.forEach((amt, i) => (costByMonth[i] = (costByMonth[i] ?? 0) + amt));
  // Fixed operating costs at year-1 levels in every lease-up month. With the ramp on they are already netted
  // against lease-up income (operationsAt), so they are charged here only when the ramp is off.
  const leaseupMonthly = !input.leaseUpRamp && input.leaseUpMonths > 0 ? fixedBase / 12 : 0;
  for (let m = C; m < S && leaseupMonthly > 0; m++) costByMonth[m] = (costByMonth[m] ?? 0) + leaseupMonthly;
  const leaseupOperatingCost = leaseupMonthly * (leaseupMonthly > 0 ? input.leaseUpMonths : 0);

  // ---- Solve required equity so the debt is exactly fully drawn at S --------
  const stack = tranches(input);
  const commitments = sum(stack.map((t) => t.terms.amount));
  let equityBudget = Math.max(0, costsBeforeFinancing + leaseupOperatingCost - commitments);
  let sim = simulateConstruction(input, Math.max(S, 1), costByMonth, equityBudget);
  let converged = false;
  for (let i = 0; i < 200; i++) {
    const gap = sim.equityOverrun - sim.unusedCommitment;
    // An overrun and unused commitment must not both remain: that is a gap of zero reached the wrong way.
    if (Math.abs(gap) < 0.005 && Math.min(sim.equityOverrun, sim.unusedCommitment) < 0.005) {
      converged = true;
      break;
    }
    const next = Math.max(0, equityBudget + gap);
    if (next === 0 && equityBudget === 0) {
      converged = true; // debt alone covers everything; equity cannot go below zero
      break;
    }
    equityBudget = next;
    sim = simulateConstruction(input, Math.max(S, 1), costByMonth, equityBudget);
  }
  const capitalizedInterest = sum(sim.capitalizedInterest) + sum(sim.interestPaidByEquity);
  const tdc = costsBeforeFinancing + leaseupOperatingCost + capitalizedInterest;
  const equityContributed = sum(sim.equityDraw);
  const drawnDebtAtS = sim.balances.mezzanine + sim.balances.senior;

  // ---- Operations ------------------------------------------------------------

  // ---- Debt after stabilization ---------------------------------------------
  type Live = {
    key: TrancheKey;
    balance: number;
    ratePct: number;
    amortMonths: number;
    amortStart: number;
    payment: number | null;
    sizingPayment: number;
  };
  const live: Live[] = stack.map((t) => {
    const balance = sim.balances[t.key];
    return {
      key: t.key,
      balance,
      ratePct: t.terms.ratePct,
      amortMonths: t.terms.amortYears * 12,
      amortStart: Math.max(S, t.terms.ioMonths),
      payment: null,
      sizingPayment: levelPayment(balance, t.terms.ratePct, t.terms.amortYears * 12),
    };
  });

  const rows: LedgerRow[] = [];
  const ops = (m: number) => operationsAt(input, m, S, fixedBase, variableShare);
  let refinance: Ledger["refinance"] = null;
  const annual: AnnualRow[] = [];
  for (let y = 0; y <= H; y++) {
    annual.push({ year: y, gpr: 0, egi: 0, opex: 0, noi: 0, debtService: 0, sizingDebtService: 0, cashFlow: 0 });
  }
  let cumulativeCashShortfall = 0;
  const seniorSizingMonths: number[] = [];
  const mezzSizingMonths: number[] = [];

  for (let m = 0; m < months; m++) {
    const o = ops(m);
    const noi = o.egi - o.opex;
    const phase: LedgerRow["phase"] = m < C ? "construction" : m < S ? "lease_up" : "hold";
    const yearIdx = m < S ? 0 : Math.floor((m - S) / 12) + 1;
    const a = annual[yearIdx]!;
    let debtService = 0;
    let sizing = 0;
    let refinanceNet = 0;
    if (m >= S) {
      if (input.refinance && m === input.refinance.month) {
        const r = input.refinance;
        let fwdNoi = 0;
        for (let k = m; k < m + 12; k++) {
          const ok = ops(k);
          fwdNoi += ok.egi - ok.opex;
        }
        const value = fwdNoi > 0 ? fwdNoi / (input.exitCapPct / 100) : 0;
        const newAmount = r.amount ?? ((r.ltvPct ?? 0) / 100) * value;
        const senior = live.find((l) => l.key === "senior");
        const payoff = senior ? senior.balance : 0;
        const replacement: Live = {
          key: "senior",
          balance: newAmount,
          ratePct: r.ratePct,
          amortMonths: r.amortYears * 12,
          amortStart: m + r.ioMonths,
          payment: null,
          sizingPayment: levelPayment(newAmount, r.ratePct, r.amortYears * 12),
        };
        if (senior) live.splice(live.indexOf(senior), 1, replacement);
        else live.push(replacement);
        refinanceNet = newAmount - payoff;
        refinance = { month: m, newAmount, payoff, net: refinanceNet };
      }
      for (const l of live) {
        if (l.balance <= 0) continue;
        const interest = (l.balance * l.ratePct) / 100 / 12;
        let paid: number;
        if (m < l.amortStart) {
          paid = interest;
        } else {
          if (l.payment === null) l.payment = levelPayment(l.balance, l.ratePct, l.amortMonths);
          const principal = Math.min(l.balance, l.payment - interest);
          l.balance -= principal;
          paid = interest + principal;
        }
        debtService += paid;
        sizing += l.sizingPayment;
        if (yearIdx === 1) {
          if (l.key === "senior") seniorSizingMonths.push(l.sizingPayment);
          else mezzSizingMonths.push(l.sizingPayment);
        }
      }
    }
    a.gpr += o.gpr;
    a.egi += o.egi;
    a.opex += o.opex;
    a.noi += noi;
    a.debtService += debtService;
    a.sizingDebtService += sizing;
    a.cashFlow += noi - debtService;
    if (m >= S && noi - debtService < 0) cumulativeCashShortfall += debtService - noi;
    rows.push({
      month: m,
      phase,
      costDraw: m < S ? (costByMonth[m] ?? 0) : 0,
      equityDraw: m < S ? (sim.equityDraw[m] ?? 0) : 0,
      debtDraw: m < S ? (sim.debtDraw[m] ?? 0) : 0,
      capitalizedInterest: m < S ? (sim.capitalizedInterest[m] ?? 0) : 0,
      egi: o.egi,
      opex: o.opex,
      noi,
      debtService,
      debtBalance: m < S ? NaN : sum(live.map((l) => l.balance)),
      refinanceNet,
      saleNet: 0,
    });
  }
  // Balances before S are the running sum of draws and capitalized interest.
  let running = 0;
  for (let m = 0; m < S && m < rows.length; m++) {
    running += (rows[m]!.debtDraw ?? 0) + (rows[m]!.capitalizedInterest ?? 0);
    rows[m]!.debtBalance = running;
  }

  // ---- Sale -----------------------------------------------------------------
  const finalYearNoi = annual[H]!.noi;
  const payoffAtSale = sum(live.map((l) => Math.max(0, l.balance)));
  const exitValue = finalYearNoi > 0 ? finalYearNoi / (input.exitCapPct / 100) : null;
  const netSale = exitValue === null ? null : exitValue * (1 - input.sellingCostsPct / 100);
  const saleLeg = netSale === null ? 0 : Math.max(0, netSale - payoffAtSale);
  const wipeout = netSale !== null && netSale < payoffAtSale;
  const last = rows[T]!;
  last.saleNet = saleLeg;

  // ---- Equity flows ---------------------------------------------------------
  const equityFlows: EquityFlow[] = [];
  for (let m = 0; m < S; m++) {
    const c = sim.equityDraw[m] ?? 0;
    if (c > 0) equityFlows.push({ month: m, t: m / 12, amount: -c, kind: "contribution" });
  }
  if (S === 0 && (sim.equityDraw[0] ?? 0) > 0) {
    equityFlows.push({ month: 0, t: 0, amount: -(sim.equityDraw[0] ?? 0), kind: "contribution" });
  }
  const preStab = annual[0]!.cashFlow;
  if (Math.abs(preStab) > 0.005) equityFlows.push({ month: S, t: S / 12, amount: preStab, kind: "operating" });
  if (refinance && Math.abs(refinance.net) > 0.005) {
    equityFlows.push({ month: refinance.month, t: refinance.month / 12, amount: refinance.net, kind: "refinance" });
  }
  for (let y = 1; y <= H; y++) {
    const cf = annual[y]!.cashFlow;
    if (Math.abs(cf) > 0.005) equityFlows.push({ month: S + 12 * y - 1, t: (S + 12 * y) / 12, amount: cf, kind: "operating" });
  }
  if (saleLeg > 0) equityFlows.push({ month: T, t: (T + 1) / 12, amount: saleLeg, kind: "sale" });
  equityFlows.sort((x, y) => x.t - y.t);

  const y1 = annual[1]!;
  return {
    S,
    T,
    rows,
    costsBeforeFinancing,
    capitalizedInterest,
    tdc,
    leaseupOperatingCost,
    commitments,
    drawnDebtAtS,
    requiredEquity: equityContributed,
    equityContributed,
    converged,
    mezzAccruedBeyondCommitment: sim.mezzAccruedBeyondCommitment,
    balancesAtS: sim.balances,
    ioDebtServiceAtS: stack.reduce((acc, t) => acc + (sim.balances[t.key] * t.terms.ratePct) / 100, 0),
    cumulativeCashShortfall,
    annual,
    year1: {
      gpr: y1.gpr,
      egi: y1.egi,
      opex: y1.opex,
      fixedOpex: fixedBase,
      variableShare,
      noi: y1.noi,
    },
    finalYearNoi,
    exitValue,
    netSale,
    payoffAtSale,
    saleLeg,
    wipeout,
    refinance,
    sizingDsByYear: annual.slice(1).map((r) => r.sizingDebtService),
    contractualDsByYear: annual.slice(1).map((r) => r.debtService),
    seniorSizingYear1: sum(seniorSizingMonths),
    mezzSizingYear1: sum(mezzSizingMonths),
    equityFlows,
    units: sum(input.revenue.filter((c) => c.basis === "per_unit").map((c) => c.units)),
  };
}
