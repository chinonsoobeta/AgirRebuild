// Policy v1: every threshold that can move a verdict. Changing any value here
// changes the policy hash, which makes every affected run stale.
//
// maxLtcPct is provisional: it awaits credit sign-off (plan task S4).

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

export type Policy = typeof POLICY_V1;
