// Policy v1: every threshold that can move a verdict. Changing any value here
// changes the policy hash, which makes every affected run stale.
//
// maxLtcPct is provisional: it awaits credit sign-off (plan task S4).
//
// A held deal runs under rental-hold-draft, or rental-hold-insured-draft when insured. The drafts propose
// thresholds for credit and are edited in place until credit signs them; a signed policy is frozen.
// Every run stores the policy it ran under, so editing a draft makes its runs stale but never unreplayable.

import type { EngineInput } from "./results.ts";
import { STRESS } from "./fr.ts";

export type StressPreset = {
  key: string;
  label: string;
  exitCapBps?: number;
  costPct?: number;
  rateBps?: number;
  rentPct?: number;
  occupancyPts?: number;
  expensePts?: number;
  pricePct?: number;
  absorptionPct?: number;
  presalesPts?: number;
  constructionMonths?: number;
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
  /** Owner-set thresholds; the strategy version remains unchanged. */
  custom?: true;
  gates: Readonly<Record<string, number>>;
  gateKeys?: readonly string[];
  maxLtcPct: number;
  baseSizingDscrFloor: number;
  maxFailedGatesForConditions: number;
  agreementTolerancePct: number;
  sourcePrecedence: readonly string[];
  stresses: readonly StressPreset[];
  refinanceLimits?: { select: readonly { minPoints: number; maxLtvPct: number; maxLtcPct?: number; maxAmortYears: number }[]; standard: { maxLtvPct: number; maxLtcPct?: number; maxAmortYears: number }; minUnits: number };
};

const { version: _v, gates: _g, ...SHARED } = POLICY_V1;

/** For a deal that is kept and refinanced. Draft: the gate thresholds are proposals for credit, not decisions. */
export const RENTAL_HOLD_DRAFT: Policy = {
  ...SHARED,
  version: "rental-hold-draft",
  draft: true,
  gates: {
    developmentSpreadMinBps: 100,
    dcrAfterRefinanceMin: 1.2,
    stressedSizingDscrMin: 1.2,
    stressedUnrealizedMultipleMin: 1.0,
  },
  gateKeys: ["development_spread", "dcr_after_refinance", "stressed_sizing_dscr", "stressed_unrealized_equity_multiple"],
};

// CMHC sources signed by the owner on 2026-10-24:
// Multi-unit Fees and Premiums 66798 20250513-002A:
// https://assets.cmhc-schl.gc.ca/sites/cmhc/media-newsroom/notices/2025/cmhc-to-update-multi-unit-mortgage-loan-insurance-premiums/fees-and-premiums.pdf
// MLI Select page and Standard Rental Housing fact sheet 69107 20251110-005A:
// https://www.cmhc-schl.gc.ca/professionals/project-funding-and-mortgage-financing/mortgage-loan-insurance/multi-unit-insurance/mliselect
// https://assets.cmhc-schl.gc.ca/sf/project/cmhc/pdfs/content/en/standard-rental-housing.pdf
// Owner decision 7 (2026-10-23): the stricter of CMHC's two columns. The loan before premium fits both the
// existing-property LTV against the refinance value and the new-construction LTC against total development cost;
// amortization uses the existing-property limits.
const REFINANCE_LIMITS: NonNullable<Policy["refinanceLimits"]> = {
  select: [{ minPoints: 50, maxLtvPct: 85, maxLtcPct: 95, maxAmortYears: 40 }, { minPoints: 70, maxLtvPct: 95, maxLtcPct: 95, maxAmortYears: 45 }, { minPoints: 100, maxLtvPct: 95, maxLtcPct: 95, maxAmortYears: 50 }],
  standard: { maxLtvPct: 85, maxLtcPct: 100, maxAmortYears: 40 }, minUnits: 5,
};
/** MLI Select: at least 50 stated points, with a 1.10x DCR floor. */
export const RENTAL_HOLD_INSURED_DRAFT: Policy = {
  ...RENTAL_HOLD_DRAFT,
  version: "rental-hold-insured-draft",
  gates: { ...RENTAL_HOLD_DRAFT.gates, dcrAfterRefinanceMin: 1.1 },
  baseSizingDscrFloor: 1.1,
  refinanceLimits: REFINANCE_LIMITS,
};

export const RENTAL_HOLD_INSURED_STANDARD_DRAFT: Policy = {
  ...RENTAL_HOLD_INSURED_DRAFT,
  version: "rental-hold-insured-standard-draft",
  gates: { ...RENTAL_HOLD_DRAFT.gates, dcrAfterRefinanceMin: 1.2 }, baseSizingDscrFloor: 1.2,
};
export const RENTAL_HOLD_INSURED_STANDARD_SHORT_DRAFT: Policy = {
  ...RENTAL_HOLD_INSURED_STANDARD_DRAFT,
  version: "rental-hold-insured-standard-short-draft",
  gates: { ...RENTAL_HOLD_DRAFT.gates, dcrAfterRefinanceMin: 1.3 }, baseSizingDscrFloor: 1.3,
};

/** Selling units: the owner's seven shocks and four proposed credit gates. */
export const FOR_SALE_DRAFT: Policy = {
  ...SHARED,
  version: "for-sale-draft",
  draft: true,
  gates: { profitOnCostForSaleMinPct: 15, marginOnRevenueMinPct: 12, stressedProfitOnCostForSaleMinPct: 0, stressedEquityMultipleMin: 1 },
  gateKeys: ["profit_on_cost_for_sale", "margin_on_revenue", "stressed_profit_on_cost_for_sale", "stressed_equity_multiple"],
  stresses: [
    { key: "prices", label: "Prices -10%", pricePct: -10 },
    { key: "absorption", label: "Absorption -30%", absorptionPct: -30 },
    { key: "costs", label: "Costs +10%", costPct: 10 },
    { key: "rates", label: "Interest rates +100 bps", rateBps: 100 },
    { key: "construction", label: "Construction +6 months", constructionMonths: 6 },
    { key: "presales", label: "Presales -15 pts", presalesPts: -15 },
    { key: "combined", label: "Combined", pricePct: -10, absorptionPct: -30, costPct: 10, rateBps: 100, constructionMonths: 6, presalesPts: -15 },
  ],
};

/** The policies of this build, by version. A run made under any other version, or an earlier edit of a draft, replays under the policy it stored. */
export const POLICIES: Readonly<Record<string, Policy>> = {
  [POLICY_V1.version]: POLICY_V1,
  [RENTAL_HOLD_DRAFT.version]: RENTAL_HOLD_DRAFT,
  [RENTAL_HOLD_INSURED_DRAFT.version]: RENTAL_HOLD_INSURED_DRAFT,
  [RENTAL_HOLD_INSURED_STANDARD_DRAFT.version]: RENTAL_HOLD_INSURED_STANDARD_DRAFT,
  [RENTAL_HOLD_INSURED_STANDARD_SHORT_DRAFT.version]: RENTAL_HOLD_INSURED_STANDARD_SHORT_DRAFT,
  [FOR_SALE_DRAFT.version]: FOR_SALE_DRAFT,
};

/** The policy a stored run was made under: the copy it stored, else (a run made before runs stored it) this build's policy of that version. */
export function runPolicy(snapshot: { policy?: Policy }, version: string): Policy | undefined {
  return snapshot.policy ?? POLICIES[version];
}

/** A held run gets the insured draft for a positive premium, otherwise the conventional draft. Every other deal gets v1. */
export function policyFor(input: EngineInput): Policy {
  if (input.exit === "for_sale") return FOR_SALE_DRAFT;
  if (input.exit !== "refinance_hold") return POLICY_V1;
  // A stated premium identifies an insured refinance; there is no financing-type field.
  const premium = input.refinance?.insurancePremiumPct;
  if (!(typeof premium === "number" && premium > 0)) return RENTAL_HOLD_DRAFT;
  if ((input.refinance?.mliSelectPoints ?? 0) >= 50) return RENTAL_HOLD_INSURED_DRAFT;
  const units = input.revenue.reduce((n, r) => n + r.units, 0);
  return units <= 6 || (input.refinance?.termYears ?? 0) >= 10 ? RENTAL_HOLD_INSURED_STANDARD_DRAFT : RENTAL_HOLD_INSURED_STANDARD_SHORT_DRAFT;
}

/** Render the actual stress sizes. Unchanged presets retain their existing labels exactly. */
export function stressLabel(preset: StressPreset, lang: "en" | "fr" = "en", standard: StressPreset = preset): string {
  const labels: Record<string, [string, string, string]> = {
    exitCapBps: ["exit cap", "taux de sortie", "bps"], costPct: ["costs", "coûts", "%"],
    rateBps: ["rate", "taux", "bps"], rentPct: ["rent", "loyers", "%"],
    occupancyPts: ["occupancy", "occupation", "pts"], expensePts: ["operating costs", "charges d'exploitation", "pts"],
    pricePct: ["prices", "prix", "%"], absorptionPct: ["absorption", "rythme de vente", "%"],
    presalesPts: ["presales", "préventes", "pts"], constructionMonths: ["construction", "construction", "months"],
  };
  const idx = lang === "fr" ? 1 : 0;
  const sizes = Object.entries(preset).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  const signed = (value: number) => `${value > 0 ? "+" : ""}${String(value).replace(".", lang === "fr" ? "," : ".")}`;
  if (preset.key === "combined") {
    if (sizes.every(([field, value]) => standard[field as keyof StressPreset] === value)) return lang === "fr" ? "Combiné" : "Combined";
    const pieces = sizes.map(([field, value]) => {
      const [en, fr, unit] = labels[field]!;
      const suffix = unit === "%" ? (lang === "fr" ? " %" : "%") : ` ${lang === "fr" ? (unit === "bps" ? "pb" : unit === "months" ? "mois" : unit) : unit}`;
      return `${idx ? fr : en} ${signed(value)}${suffix}`;
    });
    return `${lang === "fr" ? "Combiné : " : "Combined: "}${pieces.join(", ")}`;
  }
  const template = STRESS[preset.key]?.[idx] ?? preset.label;
  return sizes.length ? template.replace(/[+-]\d+(?:[.,]\d+)?/, signed(sizes[0]![1])) : template;
}

export type Threshold = {
  path: string; label: { en: string; fr: string }; unit: string; standard: number;
  min: number; max: number; integer: boolean; looserDirection: "lower" | "higher" | "magnitude"; lenderCited: boolean;
};
export type PolicyValue = { value: number; setBy: string; setAt: string; reason: string };
export type PolicyOverrides = Record<string, Record<string, PolicyValue>>;
export type PolicyChange = { path: string; label: { en: string; fr: string }; unit: string; value: number; standard: number; layer: "workspace" | "deal"; setById: string; setAt: string; reason: string; looser: boolean; lenderCited: boolean; stressRemoved: boolean; setBy?: string };
/** A stored value the policy no longer allows (a draft was edited after it was set). It is left out, and a run is refused until it is changed or cleared. */
export type InvalidPolicyValue = { path: string; layer: "workspace" | "deal"; value: number; setById: string; setAt: string; reason: string; error: { en: string; fr: string } };

// The owner's inclusive bounds, approved 2026-10-19. No unlisted field is inferred.
const THRESHOLD_RULES: Record<string, [string, string, string, number, number, boolean]> = {
  equityMultipleMin: ["Equity multiple", "Multiple des fonds propres", "x", 0, 5, false],
  stressedEquityMultipleMin: ["Stressed equity multiple", "Multiple des fonds propres sous stress", "x", 0, 5, false],
  stressedUnrealizedMultipleMin: ["Stressed unrealized multiple", "Multiple non réalisé sous stress", "x", 0, 5, false],
  stressedSizingDscrMin: ["Stressed sizing DCR", "CCD de dimensionnement sous stress", "x", .5, 3, false],
  dcrAfterRefinanceMin: ["DCR after refinance", "CCD après refinancement", "x", .5, 3, false],
  baseSizingDscrFloor: ["Base sizing DCR floor", "Plancher du CCD de dimensionnement de base", "x", .5, 3, false],
  profitOnCostMinPct: ["Profit on cost", "Profit sur coût", "%", -50, 100, false],
  profitOnCostForSaleMinPct: ["Profit on cost, units sold", "Profit sur coût, logements vendus", "%", -50, 100, false],
  marginOnRevenueMinPct: ["Margin on sales revenue", "Marge sur le revenu des ventes", "%", -50, 100, false],
  stressedProfitOnCostForSaleMinPct: ["Stressed profit on cost", "Profit sur coût sous stress", "%", -50, 100, false],
  developmentSpreadMinBps: ["Development spread", "Écart de développement", "bps", -500, 1000, true],
  maxLtcPct: ["Maximum loan-to-cost", "Ratio prêt-coût maximal", "%", 0, 100, false],
  maxFailedGatesForConditions: ["Failed gates allowed for conditions", "Critères non respectés admis avec conditions", "gates", 0, 0, true],
  agreementTolerancePct: ["Agreement tolerance", "Tolérance de concordance", "%", 0, 0, false],
  maxLtvPct: ["Maximum loan-to-value", "Ratio prêt-valeur maximal", "%", 0, 100, false],
  maxAmortYears: ["Maximum amortization", "Amortissement maximal", "years", 1, 50, true],
  minUnits: ["Minimum units", "Nombre minimal de logements", "units", 1, 100, true],
  exitCapBps: ["Exit cap shock", "Choc du taux de sortie", "bps", 0, 300, true],
  rateBps: ["Interest rate shock", "Choc du taux d'intérêt", "bps", 0, 500, true],
  costPct: ["Cost shock", "Choc des coûts", "%", 0, 50, false],
  expensePts: ["Operating expense shock", "Choc des charges d'exploitation", "pts", 0, 30, false],
  rentPct: ["Rent shock", "Choc des loyers", "%", -50, 0, false],
  pricePct: ["Price shock", "Choc des prix", "%", -50, 0, false],
  occupancyPts: ["Occupancy shock", "Choc de l'occupation", "pts", -50, 0, false],
  absorptionPct: ["Absorption shock", "Choc du rythme de vente", "%", -90, 0, false],
  presalesPts: ["Presales shock", "Choc des préventes", "pts", -100, 0, false],
  constructionMonths: ["Construction delay", "Retard de construction", "months", 0, 36, true],
};
function thresholdPaths(policy: Policy): string[] {
  return [...Object.keys(policy.gates).map((key) => `gates.${key}`), "maxLtcPct", "baseSizingDscrFloor", "maxFailedGatesForConditions", "agreementTolerancePct",
    ...policy.stresses.flatMap((stress) => Object.entries(stress).filter(([, value]) => typeof value === "number").map(([field]) => `stresses.${stress.key}.${field}`)),
    ...(policy.refinanceLimits ? ["refinanceLimits.minUnits", ...["maxLtvPct", "maxLtcPct", "maxAmortYears"].flatMap((field) => [`refinanceLimits.standard.${field}`, ...policy.refinanceLimits!.select.map((tier) => `refinanceLimits.select.${tier.minPoints}.${field}`)])] : [])];
}
function thresholdLocation(policy: Policy, path: string): { object: Record<string, unknown>; field: string } {
  const parts = path.split(".");
  if (parts[0] === "stresses") return { object: policy.stresses.find((stress) => stress.key === parts[1])! as unknown as Record<string, unknown>, field: parts[2]! };
  if (parts[0] === "refinanceLimits" && parts[1] === "select") return { object: policy.refinanceLimits!.select.find((tier) => tier.minPoints === Number(parts[2]))! as unknown as Record<string, unknown>, field: parts[3]! };
  let object = policy as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) object = object[part] as Record<string, unknown>;
  return { object, field: parts.at(-1)! };
}
export const THRESHOLDS: Readonly<Record<string, readonly Threshold[]>> = Object.fromEntries(Object.values(POLICIES).map((policy) => [policy.version, thresholdPaths(policy).map((path): Threshold => {
  const field = path.split(".").at(-1)!;
  const rule = THRESHOLD_RULES[field];
  if (!rule) throw new Error(`Unlisted threshold: ${policy.version}/${path}`);
  const [en, fr, unit, min, max, integer] = rule;
  const location = thresholdLocation(policy, path);
  const standard = location.object[location.field] as number;
  const stress = path.startsWith("stresses.");
  // A stress is named by its STRESS name with the size taken off; French puts a no-break space before the colon.
  const stressName = (lang: 0 | 1) => STRESS[path.split(".")[1]!]?.[lang].replace(/\s*[+-]\d.*$/, "") ?? path.split(".")[1]!;
  const mli = path.includes(".select.") ? `MLI Select ${path.split(".")[2]}` : path.includes(".standard.") ? "MLI Standard" : undefined;
  const name: [string, string] | undefined = stress ? [stressName(0), stressName(1)] : mli ? [mli, mli] : undefined;
  const lenderCited = path.startsWith("refinanceLimits.") || (policy.version.startsWith("rental-hold-insured") && ["gates.dcrAfterRefinanceMin", "baseSizingDscrFloor"].includes(path));
  return { path, label: { en: name ? `${name[0]}: ${en}` : en, fr: name ? `${name[1]}\u00a0: ${fr}` : fr }, unit, standard, min,
    max: field === "maxFailedGatesForConditions" ? Object.keys(policy.gates).length : field === "agreementTolerancePct" ? standard : max,
    integer, lenderCited, looserDirection: stress ? "magnitude" : field === "agreementTolerancePct" || field.startsWith("max") ? "higher" : "lower" };
})]));

/** A change's label and unit as the run stored them; for an older snapshot, from today's table, else from the field's rule, so a report never fails on a path a draft edit removed. */
export function changeMeta(version: string, change: Pick<PolicyChange, "path"> & Partial<Pick<PolicyChange, "label" | "unit">>): { label: { en: string; fr: string }; unit: string } {
  if (change.label && change.unit !== undefined) return { label: change.label, unit: change.unit };
  const known = Object.hasOwn(THRESHOLDS, version) ? THRESHOLDS[version]!.find((threshold) => threshold.path === change.path) : undefined;
  if (known) return { label: known.label, unit: known.unit };
  const rule = THRESHOLD_RULES[change.path.split(".").at(-1)!];
  return rule ? { label: { en: rule[0], fr: rule[1] }, unit: rule[2] } : { label: { en: change.path, fr: change.path }, unit: "" };
}

export function validateThreshold(version: string, path: string, value: unknown): { en: string; fr: string } | null {
  if (!Object.hasOwn(POLICIES, version)) return { en: "Unknown policy version.", fr: "Version de politique inconnue." };
  const threshold = THRESHOLDS[version]!.find((threshold) => threshold.path === path);
  if (!threshold) return { en: "This policy path cannot be changed.", fr: "Ce paramètre de politique ne peut pas être modifié." };
  if (typeof value !== "number" || !Number.isFinite(value)) return { en: "Enter a finite number.", fr: "Saisissez un nombre fini." };
  if (threshold.integer && !Number.isInteger(value)) return { en: "Enter a whole number.", fr: "Saisissez un nombre entier." };
  if (path.startsWith("stresses.") && value !== 0 && Math.sign(value) !== Math.sign(threshold.standard)) return { en: "Keep the standard stress direction, or enter zero to remove it.", fr: "Conservez le sens du stress standard, ou saisissez zéro pour le retirer." };
  if (path === "agreementTolerancePct" && value > threshold.standard) return { en: "Agreement tolerance may only get stricter.", fr: "La tolérance de concordance peut seulement être resserrée." };
  if (value < threshold.min || value > threshold.max) return { en: "This value is outside the allowed range.", fr: "Cette valeur est hors de la plage autorisée." };
  return null;
}

export function effectivePolicy(base: Policy, workspace: PolicyOverrides = {}, deal: PolicyOverrides = {}): { policy: Policy; changes: PolicyChange[]; invalid: InvalidPolicyValue[] } {
  // Workspace first, then deal; a value that no longer fits is reported and skipped, so the layer under it applies.
  const values: Record<string, PolicyValue & { layer: "workspace" | "deal" }> = {};
  const invalid: InvalidPolicyValue[] = [];
  for (const [layer, stored] of [["workspace", workspace], ["deal", deal]] as const) {
    for (const [path, note] of Object.entries(stored[base.version] ?? {})) {
      const error = validateThreshold(base.version, path, note.value);
      if (error) invalid.push({ path, layer, value: note.value, setById: note.setBy, setAt: note.setAt, reason: note.reason, error });
      else values[path] = { ...note, layer };
    }
  }
  const policy = structuredClone(base) as Policy;
  const changes: PolicyChange[] = [];
  for (const [path, note] of Object.entries(values)) {
    const threshold = THRESHOLDS[base.version]!.find((threshold) => threshold.path === path)!;
    const location = thresholdLocation(policy, path), original = thresholdLocation(base, path);
    const standard = original.object[original.field] as number;
    location.object[location.field] = note.value;
    if (note.value !== standard) changes.push({ path, label: threshold.label, unit: threshold.unit, value: note.value, standard, layer: note.layer, setById: note.setBy, setAt: note.setAt, reason: note.reason,
      looser: threshold.looserDirection === "magnitude" ? Math.abs(note.value) < Math.abs(standard) : threshold.looserDirection === "lower" ? note.value < standard : note.value > standard,
      lenderCited: threshold.lenderCited, stressRemoved: path.startsWith("stresses.") && note.value === 0 });
  }
  // Every value at its standard is no override: the base policy itself, with its hash, and no standard comparison.
  if (changes.length === 0) return { policy: base, changes, invalid };
  policy.custom = true;
  for (const stress of policy.stresses) if (changes.some((change) => change.path.startsWith(`stresses.${stress.key}.`))) stress.label = stressLabel(stress, "en", base.stresses.find((s) => s.key === stress.key));
  return { policy, changes, invalid };
}
