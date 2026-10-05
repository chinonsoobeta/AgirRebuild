import type { Check, EngineInput, Policy } from "@agir/contracts";
import type { Ledger } from "./ledger.ts";

const money = (x: number) => "$" + Math.round(x).toLocaleString("en-US");
const pct = (x: number, d = 1) => x.toFixed(d) + "%";

function agrees(stated: number, computed: number, tolPct: number): boolean {
  if (computed === 0) return stated === 0;
  return Math.abs(stated - computed) / Math.abs(computed) <= tolPct / 100;
}

/**
 * Checks on the base case. Agreement checks compare a figure a document
 * states with the one the model computes. Bound checks hold on every deal,
 * whatever its documents say: they are what catches a capital stack that
 * cannot exist.
 */
export function runChecks(input: EngineInput, L: Ledger, policy: Policy, contractualDscr: number | null): Check[] {
  const out: Check[] = [];
  const tol = policy.agreementTolerancePct;

  // ---- Bounds -----------------------------------------------------------------
  if (L.commitments > 0 && L.commitments >= L.tdc) {
    out.push({
      key: "debt_exceeds_cost",
      kind: "bound",
      severity: "error",
      message: `Debt commitments of ${money(L.commitments)} cover the whole cost of ${money(L.tdc)}. Equity would be zero or negative, so this capital stack cannot exist.`,
      expected: L.tdc,
      actual: L.commitments,
    });
  }
  const ltc = L.tdc > 0 ? (L.commitments / L.tdc) * 100 : 0;
  if (ltc > policy.maxLtcPct) {
    out.push({
      key: "ltc_ceiling",
      kind: "bound",
      severity: "error",
      message: `Loan to cost of ${pct(ltc)} is above the policy ceiling of ${pct(policy.maxLtcPct, 0)}.`,
      expected: policy.maxLtcPct,
      actual: ltc,
    });
  } else if (L.commitments > 0) {
    out.push({ key: "ltc_ceiling", kind: "bound", severity: "pass", message: `Loan to cost of ${pct(ltc)} is within the policy ceiling of ${pct(policy.maxLtcPct, 0)}.`, actual: ltc });
  }
  if (L.year1.noi <= 0) {
    out.push({
      key: "noi_not_positive",
      kind: "bound",
      severity: "warning",
      message: `Stabilized NOI is ${money(L.year1.noi)}. A deal that loses money at stabilization cannot be valued by capitalization.`,
      actual: L.year1.noi,
    });
  }
  if (L.wipeout) {
    out.push({
      key: "equity_wipeout",
      kind: "bound",
      severity: "error",
      message: `Net sale proceeds of ${money(L.netSale ?? 0)} do not repay the ${money(L.payoffAtSale)} of debt outstanding. Equity is wiped out at exit.`,
      expected: L.payoffAtSale,
      actual: L.netSale ?? 0,
    });
  }
  if (!L.converged) {
    out.push({ key: "funding_not_converged", kind: "bound", severity: "error", message: "Required equity could not be solved; the funding plan is inconsistent." });
  }
  if (input.mezzanine && input.mezzanine.amount > 0 && L.mezzAccruedBeyondCommitment > 0) {
    out.push({
      key: "mezz_interest_accrued",
      kind: "bound",
      severity: "warning",
      message: `Mezzanine interest of ${money(L.mezzAccruedBeyondCommitment)} accrues on the mezzanine balance after its ${money(input.mezzanine.amount)} commitment is used; the mezzanine balance at stabilization is ${money(L.balancesAtS.mezzanine)}.`,
      expected: input.mezzanine.amount,
      actual: L.mezzAccruedBeyondCommitment,
    });
  }

  // ---- Sources and uses ---------------------------------------------------------
  const s = input.stated;
  if (s.equity !== undefined) {
    const gap = L.requiredEquity - s.equity;
    if (gap > (L.tdc * tol) / 100) {
      out.push({
        key: "sources_cover_uses",
        kind: "agreement",
        severity: "error",
        message: `Stated equity of ${money(s.equity)} plus debt of ${money(L.commitments + L.mezzAccruedBeyondCommitment)} falls ${money(gap)} short of the ${money(L.tdc)} total cost.`,
        expected: L.requiredEquity,
        actual: s.equity,
      });
    } else if (-gap > (L.tdc * tol) / 100) {
      out.push({
        key: "sources_cover_uses",
        kind: "agreement",
        severity: "warning",
        message: `Stated equity of ${money(s.equity)} is ${money(-gap)} more than the deal needs; the model contributes only ${money(L.requiredEquity)}.`,
        expected: L.requiredEquity,
        actual: s.equity,
      });
    } else {
      out.push({ key: "sources_cover_uses", kind: "agreement", severity: "pass", message: `Sources equal uses at ${money(L.tdc)}.`, actual: s.equity });
    }
  } else {
    out.push({
      key: "sources_cover_uses",
      kind: "agreement",
      severity: "pass",
      message: `No equity amount is stated, so equity is the ${money(L.requiredEquity)} the debt does not fund.`,
    });
  }
  if (s.totalCost !== undefined) {
    out.push({
      key: "stated_total_cost",
      kind: "agreement",
      severity: agrees(s.totalCost, L.tdc, tol) ? "pass" : "warning",
      message: agrees(s.totalCost, L.tdc, tol)
        ? `The stated total cost of ${money(s.totalCost)} matches the model.`
        : `The documents state a total cost of ${money(s.totalCost)}; the model computes ${money(L.tdc)}.`,
      expected: L.tdc,
      actual: s.totalCost,
    });
  }
  if (s.ltcPct !== undefined) {
    out.push({
      key: "stated_ltc",
      kind: "agreement",
      severity: Math.abs(s.ltcPct - ltc) <= 1 ? "pass" : "warning",
      message:
        Math.abs(s.ltcPct - ltc) <= 1
          ? `The stated loan to cost of ${pct(s.ltcPct)} matches the model.`
          : `The documents state a loan to cost of ${pct(s.ltcPct)}; the model computes ${pct(ltc)}.`,
      expected: ltc,
      actual: s.ltcPct,
    });
  }
  if (s.interestReserve !== undefined) {
    const under = s.interestReserve < L.capitalizedInterest * (1 - tol / 100);
    out.push({
      key: "interest_reserve",
      kind: "agreement",
      severity: under ? "warning" : "pass",
      message: under
        ? `The budget states a ${money(s.interestReserve)} interest reserve; the model calculates ${money(L.capitalizedInterest)} of interest before stabilization. The reserve looks underfunded by ${money(L.capitalizedInterest - s.interestReserve)}.`
        : `The stated interest reserve of ${money(s.interestReserve)} covers the ${money(L.capitalizedInterest)} the model calculates.`,
      expected: L.capitalizedInterest,
      actual: s.interestReserve,
    });
  }
  if (s.minDscrCovenant !== undefined && contractualDscr !== null) {
    const ok = contractualDscr >= s.minDscrCovenant;
    out.push({
      key: "dscr_covenant",
      kind: "agreement",
      severity: ok ? "pass" : "warning",
      message: ok
        ? `Contractual DSCR of ${contractualDscr.toFixed(2)}x meets the ${s.minDscrCovenant.toFixed(2)}x covenant in every hold year.`
        : `Contractual DSCR falls to ${contractualDscr.toFixed(2)}x, under the ${s.minDscrCovenant.toFixed(2)}x covenant.`,
      expected: s.minDscrCovenant,
      actual: contractualDscr,
    });
  }
  return out;
}
