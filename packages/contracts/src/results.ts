import type { CheckSeverity, GateStatus, MetricStatus, VerdictCode } from "./statuses.ts";
import type { MetricUnit } from "./metrics.ts";

// ---- Engine input (canonical units: dollars, percent, months, years, SF) ----

export type RevenueComponent = {
  /** Stable item key, e.g. "1BR" or "Retail". */
  key: string;
  label: string;
  basis: "per_unit" | "per_sf";
  /** Units (per_unit basis) or leasable spaces; may be 0 for per_sf. */
  units: number;
  /** per_unit: dollars per unit per month. */
  rentMonthly?: number;
  /** per_sf: total rentable area. */
  areaSf?: number;
  /** per_sf: dollars per SF per year. */
  rentPsfAnnual?: number;
  /** Falls back to the deal's stabilized occupancy when absent. */
  occupancyPct?: number;
};

export type LoanTerms = {
  amount: number;
  ratePct: number;
  amortYears: number;
  ioMonths: number;
};

export type EngineInput = {
  budget: { land: number; hard: number; soft: number; contingency: number; other: number };
  revenue: RevenueComponent[];
  otherIncomeAnnual: number;
  constructionMonths: number;
  leaseUpMonths: number;
  holdYears: number;
  stabilizedOccupancyPct: number;
  /** Decision 8: a single ratio is fixed dollars (share of year-1 EGI). */
  expenseRatioPct?: number;
  fixedOpexAnnual?: number;
  variableExpensePct?: number;
  rentGrowthPct: number;
  expenseGrowthPct: number;
  leaseUpRamp: boolean;
  sCurveDraws: boolean;
  exitCapPct: number;
  sellingCostsPct: number;
  senior: LoanTerms;
  mezzanine?: LoanTerms;
  refinance?: { month: number; amount?: number; ltvPct?: number; ratePct: number; amortYears: number; ioMonths: number };
  /** The deal is kept and refinanced, not sold. Set only when the flag is 1; absent otherwise, so a sale deal's input hashes as before. */
  exit?: "refinance_hold";
  waterfall?: { lpSharePct: number; preferredReturnPct: number; gpPromotePct: number };
  stated: {
    equity?: number;
    totalCost?: number;
    ltcPct?: number;
    interestReserve?: number;
    minDscrCovenant?: number;
  };
};

// ---- Engine output ----------------------------------------------------------

export type Metric = {
  key: string;
  label: string;
  unit: MetricUnit;
  value: number | null;
  status: MetricStatus;
  /** Why a non-VALID metric has no value, in plain words; a valid one may carry a note on how it was measured. */
  reason?: string;
  formula: string;
};

export type ScenarioResult = {
  key: string;
  label: string;
  metrics: Metric[];
};

export type Gate = {
  key: string;
  label: string;
  metricKey: string;
  scenario: string;
  threshold: number;
  unit: MetricUnit;
  actual: number | null;
  status: GateStatus;
};

export type Check = {
  key: string;
  kind: "agreement" | "bound";
  severity: CheckSeverity;
  message: string;
  expected?: number;
  actual?: number;
};

export type Verdict = {
  code: VerdictCode;
  gates: Gate[];
  hardFailReasons: string[];
  headline: string;
  explanation: string;
};

export type AnnualRow = {
  /** 0 = before stabilization (construction and lease-up); 1..H = hold years. */
  year: number;
  gpr: number;
  egi: number;
  opex: number;
  noi: number;
  debtService: number;
  sizingDebtService: number;
  cashFlow: number;
};

export type EquityFlow = {
  month: number;
  /** Years from t0. */
  t: number;
  amount: number;
  /** `unrealized` is a stated value less debt at the end of a held deal: not a sale. */
  kind: "contribution" | "operating" | "refinance" | "sale" | "unrealized";
};

export type LedgerRow = {
  month: number;
  phase: "construction" | "lease_up" | "hold";
  costDraw: number;
  equityDraw: number;
  debtDraw: number;
  capitalizedInterest: number;
  egi: number;
  opex: number;
  noi: number;
  debtService: number;
  debtBalance: number;
  refinanceNet: number;
  saleNet: number;
};

export type RunResult = {
  engineVersion: string;
  policyVersion: string;
  /** Base case first, then each stress. */
  scenarios: ScenarioResult[];
  verdict: Verdict;
  checks: Check[];
  annual: AnnualRow[];
  equityFlows: EquityFlow[];
  ledger: LedgerRow[];
  irrRoots: number[];
  warnings: { key: string; message: string }[];
};

// ---- Readiness --------------------------------------------------------------

export type ReadinessItem = { fieldKey: string; itemKey?: string; label: string; detail?: string };

export type Readiness = {
  status: "ready" | "blocked";
  missing: ReadinessItem[];
  conflicting: ReadinessItem[];
  pending: ReadinessItem[];
  impossible: ReadinessItem[];
  /** Optional lines no document gave; `detail` is what the run treats each as. A disclosure with no number: it never blocks. */
  notFound: ReadinessItem[];
  /** Fields never read from documents (a flag only a person sets) that are not stated; `detail` is what the run treats each as. Offered on review, never stored in a run. */
  choices: ReadinessItem[];
  /** Missing fields that have a static default the analyst may accept. */
  defaultable: string[];
};
