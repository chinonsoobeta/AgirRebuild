import type { EquityFlow } from "@agir/contracts";
import { irrRoots } from "./irr.ts";

/**
 * A two-tier LP/GP waterfall over the deal's dated equity flows.
 *
 * Contributions are split by share. Distributions go pro rata until the LP has
 * received its capital plus the preferred return, compounded annually on its
 * unreturned balance; after that the GP takes its promote share of every
 * dollar and the rest is split pro rata.
 */
export function runWaterfall(
  flows: readonly EquityFlow[],
  w: { lpSharePct: number; preferredReturnPct: number; gpPromotePct: number },
) {
  const lpShare = w.lpSharePct / 100;
  const pref = w.preferredReturnPct / 100;
  const promote = w.gpPromotePct / 100;
  const lp: { t: number; amount: number }[] = [];
  const gp: { t: number; amount: number }[] = [];
  let hurdle = 0; // what the LP must still receive to clear the preferred return
  let lastT = 0;
  let promoteTotal = 0;
  for (const f of [...flows].sort((a, b) => a.t - b.t)) {
    hurdle *= Math.pow(1 + pref, f.t - lastT);
    lastT = f.t;
    if (f.amount < 0) {
      lp.push({ t: f.t, amount: f.amount * lpShare });
      gp.push({ t: f.t, amount: f.amount * (1 - lpShare) });
      hurdle += -f.amount * lpShare;
      continue;
    }
    let cash = f.amount;
    // Tier 1: pro rata until the LP hurdle is met.
    const tier1Needed = hurdle / lpShare;
    const tier1 = Math.min(cash, tier1Needed);
    lp.push({ t: f.t, amount: tier1 * lpShare });
    gp.push({ t: f.t, amount: tier1 * (1 - lpShare) });
    hurdle -= tier1 * lpShare;
    cash -= tier1;
    if (cash > 0) {
      // Tier 2: promote to the GP, the rest pro rata.
      const gpPromote = cash * promote;
      const rest = cash - gpPromote;
      lp.push({ t: f.t, amount: rest * lpShare });
      gp.push({ t: f.t, amount: rest * (1 - lpShare) + gpPromote });
      promoteTotal += gpPromote + rest * (1 - lpShare) - cash * (1 - lpShare);
    }
  }
  return { lp, gp, promote: promoteTotal };
}

/**
 * A held deal's partner returns (card 87): report arithmetic over a run's stored equity flows, not a metric, so no
 * result changes. `withValue` includes the unrealized flow (unrealized, not a sale); `paid` is the cash paid out so
 * far. Paid filters by kind, not by date, because the last operating flow shares its date with the unrealized flow.
 * A partner IRR follows the roots rule: one root is a value in percent, none or several is null.
 */
export function heldPartnerReturns(
  flows: readonly EquityFlow[],
  terms: { lpSharePct: number; preferredReturnPct: number; gpPromotePct: number },
) {
  const irr = (partner: { t: number; amount: number }[]) => {
    const roots = irrRoots(partner);
    return roots.length === 1 ? roots[0]! * 100 : null;
  };
  const w = runWaterfall(flows, terms);
  return {
    withValue: { ...w, lpIrr: irr(w.lp), gpIrr: irr(w.gp) },
    paid: runWaterfall(flows.filter((flow) => flow.kind !== "unrealized"), terms),
  };
}

