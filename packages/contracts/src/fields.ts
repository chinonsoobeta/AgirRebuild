// The field catalog: every input Agir underwrites, declared once.
//
// A field is either a scalar (one value per deal) or itemized (one value per
// revenue component, keyed by an item key such as "1BR" or "Retail").
// Extraction maps document candidates onto these keys, review approves them,
// and the engine input is assembled from approved rows of these keys only.

export type FieldUnit =
  | "$"
  | "%"
  | "months"
  | "years"
  | "units"
  | "sf"
  | "$/unit/mo"
  | "$/sf/yr"
  | "x"
  | "flag";

export type FieldGroup =
  | "budget"
  | "revenue"
  | "timeline"
  | "operations"
  | "exit"
  | "senior"
  | "mezzanine"
  | "equity"
  | "refinance"
  | "waterfall"
  | "stated";

/** Which way is "more conservative" when two documents disagree. */
export type ConservativeDirection = "max" | "min" | null;

export type FieldDef = {
  key: string;
  label: string;
  group: FieldGroup;
  unit: FieldUnit;
  /** One value per revenue component rather than per deal. */
  itemized?: boolean;
  /**
   * `true`: always required. `false`: optional (absence has a stated meaning,
   * given in `absentMeans`). A string names another field whose presence makes
   * this one required (e.g. the mezzanine rate once a mezzanine amount exists).
   */
  required: boolean | string;
  absentMeans?: string;
  /** Overriding an extracted value needs a second, different approver. */
  material: boolean;
  conservative: ConservativeDirection;
  /** A static default an analyst may accept explicitly. Never applied silently. */
  default?: number;
  min?: number;
  max?: number;
  /** Must the value be a whole number? */
  integer?: boolean;
  /** Can a document state it, or is it a modelling choice made in review? */
  extractable: boolean;
  /** Label phrases the extractor matches, lower case. */
  aliases: string[];
  help?: string;
};

const pct = { min: 0, max: 100 };

export const FIELDS: readonly FieldDef[] = [
  // ---- Budget -------------------------------------------------------------
  { key: "land_cost", label: "Land cost", group: "budget", unit: "$", required: true, material: false, conservative: "max", min: 0, extractable: true, aliases: ["land cost", "land acquisition", "land purchase", "land", "acquisition cost", "site acquisition", "cout du terrain", "couts du terrain", "acquisition du terrain", "achat du terrain", "terrain", "lot", "site"] },
  { key: "hard_cost", label: "Hard costs", group: "budget", unit: "$", required: true, material: false, conservative: "max", min: 0, extractable: true, aliases: ["hard costs", "hard cost", "construction costs", "construction cost", "building costs", "hard construction", "couts de construction", "cout de construction", "couts directs", "cout direct", "building budget", "construction", "stipulated price", "revised stipulated price", "fixed price", "lump sum price", "lump-sum contract", "contract price", "gc price", "construction contract", "prix forfaitaire", "prix forfaitaire revise", "contrat a forfait", "prix du contrat"] },
  { key: "soft_cost", label: "Soft costs", group: "budget", unit: "$", required: true, material: false, conservative: "max", min: 0, extractable: true, aliases: ["soft costs", "soft cost", "professional fees", "design and permits", "couts indirects", "cout indirect", "honoraires professionnels", "frais indirects"] },
  { key: "contingency", label: "Contingency", group: "budget", unit: "$", required: true, material: false, conservative: "max", min: 0, extractable: true, aliases: ["contingency", "hard cost contingency", "construction contingency", "contingence", "contingences", "imprevus"], help: "Enter 0 if the budget carries none." },
  { key: "other_cost", label: "Other costs", group: "budget", unit: "$", required: false, absentMeans: "no other costs", material: false, conservative: "max", min: 0, extractable: true, aliases: ["other costs", "other development costs", "developer fee", "autres couts", "autres frais", "autres couts de developpement", "frais du promoteur", "honoraires du promoteur", "other", "autres", "development charges", "development cost charges", "dccs", "dcs", "land transfer tax", "ltt", "taxe de bienvenue", "droits de mutation", "permit levies"] },

  // ---- Revenue (itemized per component) -----------------------------------
  { key: "unit_count", label: "Units", group: "revenue", unit: "units", itemized: true, required: true, material: false, conservative: "min", min: 0, integer: true, extractable: true, aliases: ["units", "unit count", "number of units", "# units", "count", "nombre de logements", "nombre d unites", "logements", "unites", "appartements"] },
  { key: "unit_rent_monthly", label: "Rent per unit per month", group: "revenue", unit: "$/unit/mo", itemized: true, required: false, absentMeans: "rent is per square foot", material: false, conservative: "min", min: 0, extractable: true, aliases: ["monthly rent", "rent per unit", "rent/unit", "market rent", "avg rent", "average rent", "loyer", "loyer mensuel", "loyer par logement", "loyer du marche"] },
  { key: "rentable_area_sf", label: "Rentable area", group: "revenue", unit: "sf", itemized: true, required: false, absentMeans: "rent is per unit", material: false, conservative: "min", min: 0, extractable: true, aliases: ["rentable area", "leasable area", "nrsf", "gla", "square feet", "area", "superficie locative", "superficie louable", "surface locative", "aire locative"] },
  { key: "rent_psf_annual", label: "Rent per SF per year", group: "revenue", unit: "$/sf/yr", itemized: true, required: false, absentMeans: "rent is per unit", material: false, conservative: "min", min: 0, extractable: true, aliases: ["rent psf", "rent per sf", "rent per square foot", "$/sf", "base rent", "loyer", "loyer au pi2", "loyer par pi2"] },
  { key: "item_occupancy_pct", label: "Component occupancy", group: "revenue", unit: "%", itemized: true, required: false, absentMeans: "use the deal's stabilized occupancy", material: false, conservative: "min", ...pct, extractable: true, aliases: ["occupancy", "occupation", "taux d occupation"] },

  // ---- Timeline -----------------------------------------------------------
  { key: "construction_months", label: "Construction period", group: "timeline", unit: "months", required: true, material: false, conservative: "max", min: 0, max: 120, integer: true, extractable: true, aliases: ["construction period", "construction duration", "build period", "construction months", "construction term", "duree des travaux", "duree de construction", "duree de la construction", "periode de construction", "construction", "build", "construction schedule", "travaux", "la construction durera"] },
  { key: "lease_up_months", label: "Lease-up period", group: "timeline", unit: "months", required: true, material: false, conservative: "max", min: 0, max: 120, integer: true, extractable: true, aliases: ["lease-up period", "lease up period", "lease-up", "absorption period", "lease-up months", "periode d absorption", "mise en location", "lease-up to stabilization", "periode de location", "location"], help: "Enter 0 if the asset is stabilized at completion." },
  { key: "hold_years", label: "Hold period", group: "timeline", unit: "years", required: true, material: false, conservative: null, default: 5, min: 1, max: 40, integer: true, extractable: true, aliases: ["hold period", "holding period", "investment horizon", "hold", "periode de detention", "duree de detention", "hold after stabilization", "hold for", "detention apres stabilisation", "horizon de detention"] },

  // ---- Operations ---------------------------------------------------------
  { key: "stabilized_occupancy_pct", label: "Stabilized occupancy", group: "operations", unit: "%", required: true, material: false, conservative: "min", ...pct, extractable: true, aliases: ["stabilized occupancy", "stabilised occupancy", "occupancy", "economic occupancy", "taux d occupation", "taux d occupation stabilise", "occupation stabilisee", "occupied"] },
  { key: "expense_ratio_pct", label: "Operating expense ratio", group: "operations", unit: "%", required: "!fixed_opex_annual", material: false, conservative: "max", default: 35, ...pct, extractable: true, aliases: ["operating costs", "total operating costs", "expense ratio", "operating expense ratio", "opex ratio", "operating expenses", "ratio des depenses", "depenses d exploitation", "frais d exploitation", "charges d exploitation", "opex", "depenses"], help: "A share of year-one EGI, held as fixed dollars and grown at expense growth." },
  { key: "fixed_opex_annual", label: "Fixed operating costs", group: "operations", unit: "$", required: false, absentMeans: "use the expense ratio", material: false, conservative: "max", min: 0, extractable: true, aliases: ["fixed operating expenses", "fixed opex", "fixed expenses", "depenses fixes", "frais fixes", "charges fixes", "depenses d exploitation fixes", "frais d exploitation fixes", "charges d exploitation fixes", "operating costs", "operating expenses", "total operating costs", "fixed operating costs", "frais d exploitation", "depenses d exploitation", "charges d exploitation", "opex"] },
  { key: "variable_expense_pct", label: "Variable expenses (share of EGI)", group: "operations", unit: "%", required: false, absentMeans: "no variable expenses", material: false, conservative: "max", ...pct, extractable: true, aliases: ["management fee", "variable expenses", "variable opex", "frais de gestion", "frais de gestion immobiliere", "depenses variables", "frais variables", "charges variables", "variable operating costs", "variable costs", "management", "gestion"] },
  { key: "other_income_annual", label: "Other income", group: "operations", unit: "$", required: false, absentMeans: "no other income", material: false, conservative: "min", min: 0, extractable: true, aliases: ["other income", "ancillary income", "parking income", "autres revenus", "revenus accessoires", "revenus de stationnement", "parking", "laundry", "storage", "stationnement", "buanderie", "rangement", "recoveries", "cam and tax recoveries", "cam recoveries", "tax recoveries", "recuperations"] },
  { key: "rent_growth_pct", label: "Rent growth", group: "operations", unit: "%", required: false, absentMeans: "flat rents", material: false, conservative: "min", min: -20, max: 20, extractable: true, aliases: ["rent growth", "rental growth", "revenue growth", "croissance des loyers", "croissance annuelle des loyers", "croissance du loyer", "augmentation des loyers", "hausse des loyers", "croissance des revenus"] },
  { key: "expense_growth_pct", label: "Expense growth", group: "operations", unit: "%", required: false, absentMeans: "flat expenses", material: false, conservative: "max", min: -20, max: 20, extractable: true, aliases: ["expense growth", "opex growth", "expense inflation", "croissance des depenses", "croissance annuelle des depenses", "croissance des depenses d exploitation", "croissance annuelle des depenses d exploitation", "croissance des frais d exploitation", "croissance des charges d exploitation", "augmentation des depenses", "inflation des depenses"] },
  { key: "lease_up_ramp", label: "Credit income during lease-up", group: "operations", unit: "flag", required: false, absentMeans: "no income before stabilization", material: false, conservative: "min", min: 0, max: 1, integer: true, extractable: false, aliases: ["lease-up ramp", "lease up ramp", "income during lease-up", "income during lease up", "credit income during lease-up", "rampe de location", "revenus pendant la location", "revenus pendant la mise en location"] },
  { key: "s_curve_draws", label: "S-curve construction draws", group: "operations", unit: "flag", required: false, absentMeans: "straight-line draws", material: false, conservative: null, min: 0, max: 1, integer: true, extractable: false, aliases: ["s-curve", "s curve", "s-curve draws", "s curve draws", "courbe en s", "tirages en courbe en s", "tirages de construction en courbe en s"] },

  // ---- Exit ---------------------------------------------------------------
  { key: "exit_cap_rate_pct", label: "Exit cap rate", group: "exit", unit: "%", required: true, material: true, conservative: "max", min: 0.01, max: 30, extractable: true, aliases: ["exit cap rate", "exit cap", "terminal cap rate", "reversion cap rate", "exit capitalization rate", "terminal capitalization rate", "taux de capitalisation a la sortie", "taux de capitalisation de sortie", "taux de capitalisation terminal"] },
  { key: "selling_costs_pct", label: "Selling costs", group: "exit", unit: "%", required: true, material: false, conservative: "max", default: 2, ...pct, extractable: true, aliases: ["selling costs", "disposition costs", "sale costs", "cost of sale", "frais de vente", "frais de disposition", "couts de vente", "couts de disposition", "cout de vente", "frais de cession"] },

  // ---- Senior loan --------------------------------------------------------
  { key: "senior_loan_amount", label: "Senior loan amount", group: "senior", unit: "$", required: true, material: true, conservative: "min", min: 0, extractable: true, aliases: ["senior loan amount", "loan amount", "senior loan", "construction loan", "loan commitment", "senior debt", "construction debt", "senior construction debt", "senior facility", "montant du pret", "pret hypothecaire", "pret de construction", "pret senior", "loan", "pret", "mortgage", "term loan", "construction/term loan", "construction term loan", "facility amount", "montant autorise", "authorized amount", "authorised amount"], help: "Enter 0 for an all-equity deal." },
  { key: "senior_rate_pct", label: "Senior interest rate", group: "senior", unit: "%", required: "senior_loan_amount", material: true, conservative: "max", min: 0, max: 30, extractable: true, aliases: ["interest rate", "loan rate", "senior rate", "all-in rate", "coupon", "taux d interet", "taux hypothecaire", "rate", "taux", "au taux de"] },
  { key: "senior_amort_years", label: "Senior amortization", group: "senior", unit: "years", required: "senior_loan_amount", material: true, conservative: "min", min: 1, max: 50, integer: true, extractable: true, aliases: ["amortization", "amortization period", "amortisation", "amortization term", "amortissement", "periode d amortissement", "duree d amortissement", "amortizes over", "amortizing over", "amortissement de"] },
  { key: "senior_io_months", label: "Senior interest-only period", group: "senior", unit: "months", required: false, absentMeans: "amortizing from stabilization", material: true, conservative: "min", min: 0, max: 600, integer: true, extractable: true, aliases: ["interest-only period", "interest only period", "io period", "interest-only", "interest only", "io", "periode d interet seulement", "periode d interets seulement", "interet seulement", "interets seulement"] },
  { key: "min_dscr_covenant", label: "Minimum DSCR covenant", group: "senior", unit: "x", required: false, absentMeans: "no stated covenant", material: true, conservative: "max", min: 0, max: 5, extractable: true, aliases: ["minimum dscr", "min dscr", "dscr covenant", "debt service coverage covenant", "rcd minimal", "rcd minimum", "ccd minimal", "ccd minimum", "rcsd minimal", "rcsd minimum", "ratio de couverture de la dette minimal", "ratio de couverture de la dette minimum", "coefficient de couverture de la dette minimal", "coefficient de couverture de la dette minimum", "minimum debt service coverage", "minimum debt service coverage ratio", "minimum dcr", "dcr covenant", "debt service coverage ratio of at least", "ratio de couverture du service de la dette minimal", "ratio de couverture du service de la dette minimum", "debt service coverage of not less than", "debt service coverage of at least", "debt service coverage of no less than", "dscr of not less than", "dscr of at least", "dscr of no less than", "ratio de couverture du service de la dette d au moins", "ratio de couverture de la dette d au moins", "rcd d au moins", "rcsd d au moins", "ccd d au moins"] },

  // ---- Mezzanine ----------------------------------------------------------
  { key: "mezz_loan_amount", label: "Mezzanine amount", group: "mezzanine", unit: "$", required: false, absentMeans: "no mezzanine loan", material: true, conservative: "min", min: 0, extractable: true, aliases: ["mezzanine loan", "mezzanine amount", "mezz loan", "mezzanine debt", "montant du pret mezzanine", "pret mezzanine", "dette mezzanine"] },
  { key: "mezz_rate_pct", label: "Mezzanine rate", group: "mezzanine", unit: "%", required: "mezz_loan_amount", material: true, conservative: "max", min: 0, max: 40, extractable: true, aliases: ["mezzanine rate", "mezz rate", "mezzanine interest rate", "taux d interet mezzanine", "taux d interet du pret mezzanine", "taux mezzanine"] },
  { key: "mezz_amort_years", label: "Mezzanine amortization", group: "mezzanine", unit: "years", required: "mezz_loan_amount", material: true, conservative: "min", min: 1, max: 50, integer: true, extractable: true, aliases: ["mezzanine amortization", "mezz amortization", "amortissement mezzanine", "amortissement du pret mezzanine"] },
  { key: "mezz_io_months", label: "Mezzanine interest-only period", group: "mezzanine", unit: "months", required: false, absentMeans: "amortizing from stabilization", material: true, conservative: "min", min: 0, max: 600, integer: true, extractable: true, aliases: ["mezzanine interest-only", "mezz io", "periode d interet seulement mezzanine", "periode d interets seulement mezzanine", "interet seulement mezzanine", "interets seulement mezzanine", "periode d interet seulement du pret mezzanine", "periode d interets seulement du pret mezzanine", "interet seulement du pret mezzanine", "interets seulement du pret mezzanine", "mezzanine interets seulement"] },

  // ---- Equity -------------------------------------------------------------
  { key: "equity_amount", label: "Stated equity", group: "equity", unit: "$", required: false, absentMeans: "equity is whatever the debt does not fund", material: true, conservative: "min", min: 0, extractable: true, aliases: ["equity", "equity contribution", "sponsor equity", "common equity", "total equity", "fonds propres", "apport en fonds propres", "mise de fonds", "capitaux propres", "apport en capital", "own money", "cash equity", "contribute", "will contribute", "invest", "will invest", "putting in", "apport", "investira"] },

  // ---- Refinance ----------------------------------------------------------
  { key: "refinance_month", label: "Refinance month", group: "refinance", unit: "months", required: false, absentMeans: "no refinance", material: true, conservative: null, min: 1, max: 600, integer: true, extractable: true, aliases: ["refinance month", "refinancing month", "refinance in month", "mois du refinancement", "mois de refinancement", "refinancement au mois"] },
  { key: "refinance_amount", label: "Refinance loan amount", group: "refinance", unit: "$", required: false, absentMeans: "sized by loan-to-value", material: true, conservative: "min", min: 0, extractable: true, aliases: ["take-out loan", "take out loan", "refinance amount", "takeout loan", "permanent loan amount", "refinance loan", "montant du refinancement", "pret de refinancement", "montant du pret de refinancement"] },
  { key: "refinance_ltv_pct", label: "Refinance loan-to-value", group: "refinance", unit: "%", required: false, absentMeans: "sized by amount", material: true, conservative: "min", ...pct, extractable: true, aliases: ["refinance ltv", "takeout ltv", "permanent loan ltv", "ratio pret valeur du refinancement", "ratio pret-valeur du refinancement", "ratio pret valeur de refinancement", "ratio pret-valeur de refinancement", "rpv du refinancement"] },
  { key: "refinance_rate_pct", label: "Refinance rate", group: "refinance", unit: "%", required: "refinance_month", material: true, conservative: "max", min: 0, max: 30, extractable: true, aliases: ["take-out interest rate", "take out interest rate", "take-out rate", "take out rate", "refinance rate", "permanent loan rate", "takeout rate", "taux d interet du refinancement", "taux de refinancement"] },
  { key: "refinance_amort_years", label: "Refinance amortization", group: "refinance", unit: "years", required: "refinance_month", material: true, conservative: "min", min: 1, max: 50, integer: true, extractable: true, aliases: ["take-out amortization", "take out amortization", "refinance amortization", "permanent loan amortization", "amortissement du refinancement", "amortissement du pret de refinancement"] },
  { key: "refinance_io_months", label: "Refinance interest-only period", group: "refinance", unit: "months", required: false, absentMeans: "amortizing from the refinance", material: true, conservative: "min", min: 0, max: 600, integer: true, extractable: true, aliases: ["refinance interest-only", "permanent loan io", "periode d interet seulement du refinancement", "periode d interets seulement du refinancement", "interet seulement du refinancement", "interets seulement du refinancement", "periode d interet seulement de refinancement", "periode d interets seulement de refinancement", "interet seulement de refinancement", "interets seulement de refinancement", "periode d interet seulement du pret de refinancement", "periode d interets seulement du pret de refinancement", "interet seulement du pret de refinancement", "interets seulement du pret de refinancement", "refinancement interets seulement"] },

  // ---- LP/GP waterfall ----------------------------------------------------
  { key: "lp_share_pct", label: "LP share of equity", group: "waterfall", unit: "%", required: false, absentMeans: "no LP/GP split", material: true, conservative: null, ...pct, extractable: true, aliases: ["lp share", "lp equity", "limited partner share", "investor share", "part des commanditaires", "part du commanditaire", "participation des commanditaires", "part des investisseurs", "limited partners share", "limited partners share of equity", "limited partners contribute", "lp share of equity", "limited partners", "lp", "lps", "commanditaires"] },
  { key: "preferred_return_pct", label: "Preferred return", group: "waterfall", unit: "%", required: "lp_share_pct", material: true, conservative: null, min: 0, max: 50, extractable: true, aliases: ["preferred return", "pref", "hurdle rate", "rendement privilegie", "rendement prefere", "taux de rendement privilegie", "taux de rendement prefere", "seuil de rendement", "preferred return of"] },
  { key: "gp_promote_pct", label: "GP promote above the preferred return", group: "waterfall", unit: "%", required: "lp_share_pct", material: true, conservative: null, ...pct, extractable: true, aliases: ["promote", "carried interest", "gp promote", "prime de performance", "interet reporte", "prime du commandite", "general partner promote", "promote of", "the general partner receives"] },

  // ---- Stated figures (checks, never inputs to the model) -----------------
  { key: "stated_total_cost", label: "Stated total project cost", group: "stated", unit: "$", required: false, absentMeans: "nothing to check against", material: true, conservative: null, min: 0, extractable: true, aliases: ["total project cost", "total development cost", "tdc", "total cost", "project cost", "all-in cost", "cout du projet", "cout total du projet", "cout total reconnu"] },
  { key: "stated_ltc_pct", label: "Stated loan-to-cost", group: "stated", unit: "%", required: false, absentMeans: "nothing to check against", material: false, conservative: null, ...pct, extractable: true, aliases: ["loan to cost", "loan-to-cost", "ltc"] },
  { key: "stated_interest_reserve", label: "Stated interest reserve", group: "stated", unit: "$", required: false, absentMeans: "nothing to check against", material: false, conservative: null, min: 0, extractable: true, aliases: ["interest reserve", "financing costs", "financing interest", "capitalized interest", "construction interest", "capitalized interest reserve", "capitalised interest reserve", "reserve d interets", "reserve d interet"] },
];

export const FIELD_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(FIELDS.map((f) => [f.key, f]));

export function fieldDef(key: string): FieldDef {
  const def = FIELD_BY_KEY.get(key);
  if (!def) throw new Error(`Unknown field "${key}"`);
  return def;
}

/**
 * Phrases that name an OUTPUT of underwriting. A number next to one of these
 * in a document (a broker's projected NOI, a target IRR, an indicative value)
 * is never mapped to an input field, however well it matches an alias.
 */
export const OUTPUT_LIKE_PHRASES: readonly string[] = [
  "noi",
  "net operating income",
  "irr",
  "internal rate of return",
  "equity multiple",
  "yield on cost",
  "valuation",
  "indicative value",
  "market value",
  "as-stabilized value",
  "projected",
  "target",
  "profit",
  "cash-on-cash",
  "cash on cash",
  // French, accent-folded like a normalized label.
  "rne",
  "revenu net d exploitation",
  "tri",
  "taux de rendement interne",
  "multiple sur capitaux propres",
  "multiple sur fonds propres",
  "multiple des capitaux propres",
  "rendement sur cout",
  "valorisation",
  "valeur indicative",
  "valeur marchande",
  "valeur du marche",
  "valeur stabilisee",
  "valeur de sortie",
  "valeur de revente",
  "valeur a la revente",
  "projete",
  "projetee",
  "projetes",
  "projetees",
  "cible",
  "benefice",
  "rendement en especes",
];

/** Fields a person may enter without a document (all of them), grouped for display. */
export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  budget: "Budget",
  revenue: "Revenue",
  timeline: "Timeline",
  operations: "Operations",
  exit: "Exit",
  senior: "Senior loan",
  mezzanine: "Mezzanine loan",
  equity: "Equity",
  refinance: "Refinance",
  waterfall: "LP/GP split",
  stated: "Stated figures (checks)",
};

// ---- Quick-start templates ------------------------------------------------------------------
// Structure only; the wording lives in the web i18n. Each answer is entered through fn_enter_value
// and the named defaults are accepted explicitly through fn_accept_defaults, never applied silently.

export type TemplateQuestion = { field: string; item?: string; optional?: true; repeatable?: true; zeroAllowed?: true; skipsIfZero?: string[] };
export type Template = { key: "multiplex" | "apartment"; minUnits: number; maxUnits: number; questions: TemplateQuestion[]; defaults: string[] };

const q = (field: string, o: Omit<TemplateQuestion, "field"> = {}): TemplateQuestion => ({ field, ...o });
const DEFAULTS = ["hold_years", "selling_costs_pct", "expense_ratio_pct"];
const loan = [
  q("senior_loan_amount", { zeroAllowed: true, skipsIfZero: ["senior_rate_pct", "senior_amort_years"] }),
  q("senior_rate_pct"),
  q("senior_amort_years"),
];
const timeline = [q("construction_months", { zeroAllowed: true }), q("lease_up_months", { zeroAllowed: true })];

export const TEMPLATES: readonly Template[] = [
  {
    key: "multiplex",
    minUnits: 2,
    maxUnits: 4,
    questions: [
      q("land_cost"), q("hard_cost"), q("soft_cost"), q("contingency", { zeroAllowed: true }),
      ...timeline,
      q("unit_count", { item: "Residential" }), q("unit_rent_monthly", { item: "Residential" }),
      q("stabilized_occupancy_pct"), q("exit_cap_rate_pct"), ...loan,
    ],
    defaults: DEFAULTS,
  },
  {
    key: "apartment",
    minUnits: 5,
    maxUnits: 30,
    questions: [
      q("land_cost"), q("hard_cost"), q("soft_cost"), q("contingency", { zeroAllowed: true }), q("other_cost", { optional: true }),
      ...timeline,
      q("unit_count", { repeatable: true }), q("unit_rent_monthly", { repeatable: true }),
      q("stabilized_occupancy_pct"), q("other_income_annual", { optional: true }), q("exit_cap_rate_pct"), ...loan,
    ],
    defaults: DEFAULTS,
  },
];
