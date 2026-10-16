// Policy v1: every threshold that can move a verdict. Changing any value here
// changes the policy hash, which makes every affected run stale.
//
// maxLtcPct is provisional: it awaits credit sign-off (plan task S4).
//
// A deal that is kept and refinanced runs under rental-hold-v1-draft (card 60), a draft whose thresholds are
// proposals for credit. POLICY_V1 is never edited for it: its hash keeps every existing run fresh.

import type { EngineInput } from "./results.ts";

export type StressPreset = {
  key: string;
  label: string;
  exitCapBps?: number;
  costPct?: number;
  rateBps?: number;
  rentPct?: number;
  occupancyPts?: number;
  expensePts?: number;
};

export const STRESSES: readonly StressPreset[] = [
  { key: "exit_cap", label: "Exit cap +75 bps", exitCapBps: 75 },
  { key: "cost", label: "Costs +10%", costPct: 10 },
  { key: "rate", label: "Interest rate +150 bps", rateBps: 150 },
  { key: "rent", label: "Rent -10%", rentPct: -10 },
  { key: "occupancy", label: "Occupancy -5 pts", occupancyPts: -5 },
  { key: "expense", label: "Operating costs +5 pts", expensePts: 5 },
  {
    key: "combined",
    label: "Combined",
    exitCapBps: 75,
    costPct: 10,
    rateBps: 150,
    rentPct: -10,
    occupancyPts: -5,
    expensePts: 5,
  },
];

export const POLICY_V1 = {
  version: "policy-v1",
  gates: {
    equityMultipleMin: 1.5,
    profitOnCostMinPct: 15,
    developmentSpreadMinBps: 100,
    stressedSizingDscrMin: 1.2,
    stressedEquityMultipleMin: 1.0,
  },
  /** An absolute bound, independent of any document. Provisional. */
  maxLtcPct: 85,
  /** Base-case coverage below this is a warning, not a gate. */
  baseSizingDscrFloor: 1.2,
  /** More than this many failed gates is a rejection. */
  maxFailedGatesForConditions: 2,
  /** Relative tolerance when a stated figure is compared with a computed one. */
  agreementTolerancePct: 1,
  /** Source ranking shown as a hint when documents conflict. Never auto-applied. */
  sourcePrecedence: ["lender_term_sheet", "appraisal", "budget", "rent_roll", "sponsor_summary", "market_study", "other"],
  stresses: STRESSES,
} as const;

/** A policy, of any version. Thresholds are named; `gateKeys` says which gates it uses, in order (absent: v1's five). */
export type Policy = {
  version: string;
  /** A draft: its thresholds are proposals that credit has not signed. */
  draft?: true;
  gates: Readonly<Record<string, number>>;
  gateKeys?: readonly string[];
  maxLtcPct: number;
  baseSizingDscrFloor: number;
  maxFailedGatesForConditions: number;
  agreementTolerancePct: number;
  sourcePrecedence: readonly string[];
  stresses: readonly StressPreset[];
};

const { version: _v, gates: _g, ...SHARED } = POLICY_V1;

/** For a deal that is kept and refinanced. Draft: the gate thresholds are proposals for credit, not decisions. */
export const RENTAL_HOLD_V1_DRAFT: Policy = {
  ...SHARED,
  version: "rental-hold-v1-draft",
  draft: true,
  gates: {
    developmentSpreadMinBps: 100,
    dcrAfterRefinanceMin: 1.2,
    stressedSizingDscrMin: 1.2,
    stressedUnrealizedMultipleMin: 1.0,
  },
  gateKeys: ["development_spread", "dcr_after_refinance", "stressed_sizing_dscr", "stressed_unrealized_equity_multiple"],
};

/** Every policy a run can have been made under, by version. A new policy is added, never edited. */
export const POLICIES: Readonly<Record<string, Policy>> = {
  [POLICY_V1.version]: POLICY_V1,
  [RENTAL_HOLD_V1_DRAFT.version]: RENTAL_HOLD_V1_DRAFT,
};

/** The policy that fits a deal: a held deal gets the draft, every other deal v1. */
export function policyFor(input: EngineInput): Policy {
  return input.exit === "refinance_hold" ? RENTAL_HOLD_V1_DRAFT : POLICY_V1;
}
