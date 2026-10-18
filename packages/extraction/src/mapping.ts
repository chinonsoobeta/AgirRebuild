// Mapping a label and a number onto a field. Deterministic: label aliases,
// unit compatibility and nothing else. A number that fits no field, or that
// sits next to an output figure, is kept as unmapped so the analyst can see it,
// but it never becomes an input.

import { FIELD_BY_KEY, FIELDS, OUTPUT_LIKE_PHRASES, type FieldDef } from "@agir/contracts";
import { canonicalItem, codeOf, parenType, SF_PER_M2, unitTypesIn, wholeUnitType, type CurrencyCode, type NumberToken } from "@agir/numbers";

// canonicalItem and itemFold live in @agir/numbers so the engine can use the same fold.
export { canonicalItem, itemFold } from "@agir/numbers";

export type LabelUnit = "$" | "%" | "months" | "years" | "sf" | "m2" | "x" | null;

export type Mapped =
  | { kind: "field"; fieldKey: string; itemKey: string | null; value: number; unitSeen: string; quote?: true; note?: string }
  | { kind: "ignored"; reason: string }
  | { kind: "unmapped" };

// Words that describe a figure rather than name a revenue component.
const GENERIC = new Set([
  "stabilized", "stabilised", "economic", "physical", "lender", "average", "avg", "annual", "total", "overall",
  "project", "portfolio", "minimum", "min", "target", "market", "gross", "net", "blended", "monthly", "base", "the",
  "of", "per", "unit", "all", "in", "place", "in-place", "asking", "effective", "current", "residential rental", "number", "nombre", "count",
  // The heading of a letter or email, not a component.
  "subject", "objet", "re", "note", "notes", "purpose",
  // Who the deal is with, not a component: "Borrower: Maple Court Inc. ... 10 units".
  "borrower", "emprunteur", "yearly", "annuel", "annuelle", "annually", "broker", "agent", "appraiser", "courtier", "evaluateur", "projet", "sponsor", "promoteur", "address", "adresse", "lender", "preteur", "property", "propriete",
]);

const ITEMIZED_ALIASES: Record<string, string[]> = {
  unit_count: ["rental units", "units", "unit count", "homes", "suites", "apartments", "doors", "logements", "unites", "appartements", "nombre de logements", "nombre d unites", "nombre de locaux", "locaux"],
  unit_rent_monthly: ["rent", "monthly rent", "rent per month", "rent monthly", "rent per unit", "rent per suite", "rent per door", "rent per home", "loyer par unite", "loyer par local", "loyer annuel par logement", "loyer annuel par unite", "loyer annuel par local", "loyer mensuel par logement", "loyer mensuel par unite", "loyer mensuel par local", "market rent", "loyer", "loyer mensuel", "loyer par mois", "loyer par logement", "loyer du marche"],
  rent_psf_annual: ["rent", "rent psf", "rent per sf", "rent per sq ft", "rent per square foot", "rent per square metre", "rent per square meter", "rent per m2", "base rent", "loyer", "loyer au pi2", "loyer par pi2", "loyer au pied carre", "loyer par pied carre", "loyer au metre carre", "loyer par metre carre", "loyer annuel au pi2", "loyer annuel par pi2", "loyer annuel au pied carre", "loyer annuel au metre carre", "loyer annuel par metre carre"],
  rentable_area_sf: ["area", "rentable area", "leasable area", "gla", "nrsf", "square feet", "sf", "superficie locative", "superficie louable", "superficie locative totale", "superficie louable totale", "surface locative", "aire locative"],
  item_occupancy_pct: ["occupancy", "occupation", "taux d occupation"],
};

/** Which loan a document, a section or a label is about. A generic label ("Rate", "Loan amount") means the loan in scope. */
export type Scope = "senior" | "mezzanine" | "refinance";

const SCOPE_WORDS: Record<Scope, RegExp> = {
  mezzanine: /\b(mezzanine|mezz|second mortgage|2nd mortgage|second charge|second[- ]ranking|second[- ]position|junior|subordinate loan|deuxieme rang|deuxieme hypotheque|pret de second rang|second rang|(?:mic|mortgage investment corporation) (?:second|2nd)|private second|(?<=\b(?:mortgages?|loans?|charges?|lenders?|hypotheques?|prets?)\b.{0,80})(?:the\s+)?second(?=\s*(?:is\b|:|\$))|^\s*second\s*$|preteur prive de second rang)\b/,
  refinance: /\b(take-?out|take out|refinanc\w*|permanent loan|permanent financing|exit financing|long[- ]term mortgage|pret permanent|financement permanent|financement de sortie|permanent (?:mortgage|debt|facility|lender)|permanent (?=(?:io|interest|amorti[sz]\w*|repayment|rate|term)\b)|conversion (?:rate|coupon)|converts? to (?:(?:an?|the) )?(?:\$|\d|(?:[a-z-]+ ){0,2}(?:loan|mortgage|debt|financing|facility|rate))|term[- ]out|hypotheque permanente|pret a terme|reprise(?!\s+(?:des?\s+|du\s+|de la\s+)?(?:travaux|chantier|construction|possession|bail|baux|terrain)))\b/,
  senior: /\b(senior|construction loan|first mortgage|premier rang|pret de construction)\b/,
};
const TERM_SHEET_RE = /\b(term sheet|feuille de modalites)\b/;
const foldText = (t: string) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, " ");

// "Postponed to X" / "subordinate to X": the document's loan is the second-ranking one; X, whatever follows, is not named.
const SUBORDINATE_RE = /\b(subordinate[ds]?|postponed|subordonnee?s?|postposee?s?)\s+(to|a|au|aux)\b/;

/** The one scope a title, heading or label names; null when it names none, or two or more. A term sheet that names no other is senior unless `generic` is false. */
export function scopeIn(text: string, generic = true): Scope | null {
  let f = foldText(text);
  const sub = SUBORDINATE_RE.exec(f);
  if (sub) f = f.slice(0, sub.index) + " mezzanine";
  const named = (Object.keys(SCOPE_WORDS) as Scope[]).filter((k) => SCOPE_WORDS[k].test(f));
  if (generic && named.length === 0 && TERM_SHEET_RE.test(f)) named.push("senior");
  return named.length === 1 ? named[0]! : null;
}

// A table row or line whose label states the loan's rank or facility; its value then names the loan the document or table is about.
const RANK_LABEL_RE = /^(facility|loan type|rank|ranking|priority|position|charge|security|mortgage position|rang|type de pret|nature du pret|priorite|hypotheque)$/;
export function rankScope(label: string, value: string): Scope | null {
  return RANK_LABEL_RE.test(foldText(label).replace(/[^a-z ]/g, " ").trim().replace(/\s+/g, " ")) ? scopeIn(value, false) : null;
}

// The scope's own field for each senior-loan field a generic label can reach. A field the scope's loan lacks has no entry.
const SCOPE_FIELD: Record<Exclude<Scope, "senior">, Record<string, string>> = {
  mezzanine: { senior_loan_amount: "mezz_loan_amount", senior_rate_pct: "mezz_rate_pct", senior_amort_years: "mezz_amort_years", senior_io_months: "mezz_io_months" },
  refinance: { senior_loan_amount: "refinance_amount", senior_rate_pct: "refinance_rate_pct", senior_amort_years: "refinance_amort_years", senior_io_months: "refinance_io_months" },
};
// What a loan-to-value is taken of: "of the lender's valuation", "of appraised value", "de la valeur établie par le prêteur".
export const LTV_BASIS = String.raw`(?:of|de|du)\s+(?:the\s+|la\s+|l['’\s]+)?(?:(?:lender|bank|preteur|banque)['’\s]+s?\s*)?(?:valuation|appraised value|appraisal|valeur\s+(?:etablie|determinee|fixee|evaluee)\s+par\s+(?:le\s+)?(?:preteur|banque)|valeur\s+d['’\s]+evaluation|valeur\s+evaluee)`;
const LTV_BASIS_AFTER_RE = new RegExp(String.raw`^\s*${LTV_BASIS}(?![a-z0-9]|\s+(?:of|at|is|was|de|a)?\s*[$\d])`);
const LTV_RE = /\b(loan to value|loan-to-value|ltv|ratio pret valeur|ratio pret-valeur|rpv)\b/;
const BARE_AMOUNT_RE = /^(amount|montant|principal)$/;
const REPAY_RE = /\b(repa\w+|refinanc\w*|take-?out|rembours\w+)\b/;
const FUNDING_RE = /\b(fund\w*|repa\w+|clos\w*|advance\w*|draw\w*|financement|remboursement|prise de possession)\b/;
const CAP_RE = /\b(cap rate|capitali[sz]ation rate|taux de capitalisation)\b/;
const EXIT_RE = /\b(sell|sale|sold|exit|reversion|disposition|sortie|vente|vendre|vendrons|vendons|revente)\b/;
const VALUE_RE = /\b(value|valeur)\b/;

// A yearly rent, a per-unit or per-area label, and the rent figures they refuse.
const ANNUAL_RE = /\b(annual|annually|yearly|per year|a year|each year|annuel|annuelle|par an|par annee)\b|\/\s?(yr|year|an|annee)\b/;
const PER_UNIT_RE = /\b(per (unit|suite|door|home|dwelling)|each|par (logement|unite|local))\b/;
const PER_AREA_RE = /\b(sf|psf|sq ft|square f\w+|pi2|pied carre|m2|psm|sqm|metre carre|square met(re|er))\b/;
const MONTHLY_RE = /\b(monthly|per month|mensuel|mensuelle|par mois)\b|\/\s?(mo|month|mois)\b/;
const RENT_WORD_RE = /\b(rents?|loyers?)\b/;
// A plain-language rent per unit (task 55): "monthly rent for each home", "annual lease per dwelling", "loyer demande par logement". "Price" and "asking" alone need a period word, and a sale, a fee or a per-area label is no rent.
const PLAIN_RENT_RE = /\b(?:rents?|leases?(?!-?\s?up)|prices?|asking|loyers?|locations?)\b(?:\s+[a-z0-9$%/-]+){0,5}?\s+(?:for each|each|per|par)\s+(?:home|unit|suite|dwelling|door|logement|unite|local|appartement)s?\b(?:\s+(?:monthly|per month|a month|mensuel(?:le)?|par mois|annual(?:ly)?|yearly|per year|a year|par an|par annee))?$/;
/** Whether a label is a plain-language rent per unit ("monthly rent for each home"), not a sale price, a fee or a rent per area. */
export function isPlainRentLabel(raw: string): boolean {
  const { label } = normalizeLabel(raw);
  return PLAIN_RENT_RE.test(label) && !NOT_PLAIN_RENT_RE.test(label) && !PER_AREA_RE.test(label) && (PLAIN_RENT_STRONG_RE.test(label) || PLAIN_RENT_PERIOD_RE.test(label));
}
const PLAIN_RENT_STRONG_RE = /\b(?:rents?|leases?|loyers?|locations?)\b/;
const PLAIN_RENT_PERIOD_RE = /\b(?:monthly|per month|a month|mensuel(?:le)?|par mois|annual(?:ly)?|yearly|per year|a year|par an|par annee)\b/;
const NOT_PLAIN_RENT_RE = /\b(?:free|deposits?|increases?|growth|escalat\w*|concessions?|reserves?|allowances?|commissions?|fees?|costs?|insurance|taxes|incentives?|sale|sold|purchase|paid|vente|achat|buyer|acheteur|renewal|vacancy|tenant|cout|frais)\b/;
const ANNUAL_TOTAL_NOTE = "An annual rent total, not a rent per unit";
const MONTHLY_AREA_NOTE = "A monthly rent per area is not an annual rate; it is not multiplied";
const REVENUE_LABEL_RE = /\b(rents?|loyers?|revenues?|revenus?)\b/;
const OPINION_RE = /\b(opinions?|possible|achievable|potentiel(?:le)?s?|potential|upside|avis|selon (?:le|l) \w+|(?:broker|agent|appraiser|courtier|evaluateur) s (?:view|opinion|estimate))\b/;
const OPINION_NOTE = "An opinion of rent, not the deal's assumption";

const AREA_WORD_RE = /\b(area|sf|sq ft|superficie|surface|gla|nrsf|rsf)\b/;
// A lender's condition, or a figure true only today, is not the stabilized assumption.
const LENDER_CONDITION = "A lender's condition, not the occupancy assumption";
const CONDITION_RE = /\b(minimum|min|at least|before|prior to|until|consecutive months?|in order to|as a condition|conversion|first advance|funding|conditions?|covenants?|required|requires?|au moins|minimale?|avant|prealable\w*|deboursement|advances?|draws?|drawdowns?|disbursements?|holdbacks?|releas(?:es?|ed|ing)|funded|avances?|tirages?|debourse\w*|retenues? de garantie|versements?|libere\w*)\b/;
// A leased or occupied share with a condition marker is the lender's condition, whatever field it names.
const LEASED_RE = /\b(pre-?leas\w*|leased|occupied|pre-?lou\w*|loue\w*|occupe\w*|occupancy|occupation)\b/;
const CURRENT_RE = /\b(current|currently|today|as of|actuel(?:le)?|en date du)\b/;
const STABILIZED_RE = /\b(stabili[sz]ed|stabilisee?|projected|pro forma|projete\w*)\b/;

// Words too common to name a field alone. Each loses to any longer alias in the label, must stand at the end of the label
// (or before "income"/"amount"), and never matches inside a longer word.
const LOOSE_ALIASES = new Set(["management", "gestion", "depenses", "limited partners", "lp", "lps", "commanditaires", "loan", "pret", "mortgage", "rate", "taux", "construction", "location", "build", "travaux", "leasing", "lot", "site", "contribute", "invest", "apport", "other", "autres", "parking", "laundry", "storage", "stationnement", "buanderie", "rangement"]);
// These name a field only for a money figure of at least $1,000: "lot 7" is a lot number, "storage $75" may be one locker.
const WEAK_MONEY = new Set(["lot", "site", "parking", "laundry", "storage", "stationnement", "buanderie", "rangement"]);
// These name a field only when the figure's own words say what it is a share of: "management 4% of EGI", never "management 1.5% of equity".
const EGI_BASE_ALIASES = new Set(["management", "gestion", "depenses"]);
const EGI_AFTER_RE = /^\s*(?:of|on|de|des|du|d)\s+(?:the\s+|les?\s+|la\s+)?(?:egi|effective gross|gross (?:revenue|income)|revenues?|revenus?)\b/;
// The limited partners' own share needs no word before it but an article: "return to limited partners 8%" is the return.
const LP_ALIASES = new Set(["limited partners", "lp", "lps", "commanditaires", ...FIELD_BY_KEY.get("lp_share_pct")!.aliases.filter((a) => /^(?:lps?|limited partners|commanditaires) (?:supply|supplies|provides?|funds?|contributes?|apportent|fournissent|financent)$/.test(a))]);
const LP_LEAD_RE = /^(?:\s|the|our|le|la|les|notre|nos)*$/;
// "Other" names a cost only in a budget table.
const BUDGET_ONLY = new Set(["other", "autres"]);
// The expense ratio written as a share: "variable" in the label makes it the variable-expense share, as before.
const EXPENSE_SHARE_ALIASES = new Set(FIELD_BY_KEY.get("expense_ratio_pct")!.aliases.filter((a) => /\bshare\b|\bas a (?:percentage|%)|\bratio des charges|(?:charges|depenses) en (?:%|pourcentage)/.test(a)));
const VARIABLE_RE = /\bvariables?\b/;
// A "rate" that is not a loan's.
const NOT_A_LOAN_RATE = /\b(vacancy|growth|discount|tax|exchange|inflation|return|occupancy) rate\b|\b(taux de (croissance|vacance|actualisation|change|rendement|capitalisation|taxation)|taux d (inflation|imposition|occupation))\b|\brate of return\b/;

// What a lender writes that looks like an input but is not. Words that are part of a field alias ("minimum DSCR", "construction term loan",
// "management fee") stay valid: each alias holding one is taken out of the label before the words are looked for.
const LIMIT_RE = /\b(maximum|max|not to exceed|not exceed|not more than|at most|up to|ceiling|cap of|minimum|min|at least|not less than|no less than|au plus|d au plus|maximale?|plafond|au moins|d au moins|minimale?|pas moins de)\b/;
// "Capped" limits a rate or a loan; a cost line capped at its fixed price ("hard costs are capped at $X under the contract") is that line's figure.
const CAPPED_RE = /\bcapped\b/;
const CAPPED_COST_RE = /\b(hard costs?|construction costs?|building costs?|contract|fixed price|price|budget|couts? de construction|travaux|prix)\b/;
const LOAN_WORD_RE = /\b(loan|loans|mortgage|financing|advance|pret|hypotheque|financement)\b/;
const COVERAGE_RE = /\b(dscr|dcr|debt service coverage|couverture|rcsd|rcd|ccd)\b/;
const TERM_RE = /\b(term|terme|maturity|matures?|echeance|duree du pret)\b/;
const TERM_AFTER_RE = /^\s*(loan |initial |renewal |fixed |conversion )?(term|terme)\b/;
const AMORT_RE = /\bamorti[sz]\w*/;
const IO_RE = /\b(interest[- ]only|io|interets? seulement)\b/;
// A partner's return, never a loan's rate; the preferred-return words read as that field, a promote is only shown.
const PARTNER_RE = /\b(?:prefs?|preference|preferred|hurdle|priority returns?|privilegie\w*|prefere\w*|seuil de rendement|rendement prioritaire|promote|prime de performance)\b/;
const PARTNER_PREF_RE = /\b(?:prefs?|preference|preferred|hurdle|priority returns?|privilegie\w*|prefere\w*|seuil de rendement|rendement prioritaire)\b/;
// "Preferred lender" and "banque privilégiée" name the lender, and preferred equity is a class of capital: neither is a preferred return.
const LENDER_PREF_RE = /\b(?:preferred|preference|priority|privilegie\w*|prefere\w*) (?:lenders?|banks?|loans?|mortgages?|financing|credit unions?|preteurs?|banques?|prets?)\b|\b(?:preteurs?|banques?|prets?) (?:privilegie|prefere)\w*/;
const PREF_EQUITY_RE = /\bpref(?:s|erred)? equity\b|\bactions? privilegiee?s?\b/;
const IO_START_RE = /^\s*(?:months?\s+|years?\s+|mois\s+|ans?\s+)?(?:of\s+|de\s+)?(?:interest[- ]only|io|interets? seulement)\b/;
const INCLUDING_RE = /\b(including|incl|includes|comprenant|incluant|inclut)\b/;
const BUDGET_NAME_RE = new RegExp(`\\b(${FIELDS.filter((f) => f.group === "budget").flatMap((f) => f.aliases).map((a) => a.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})\\b`);
// The interest reserve joined with a fee, cost or charge ("lender fees and interest reserve", "interest reserve + financing fees").
const COMBINED_RESERVE_RE = /(?:\b(?:interest reserve|reserve d\W?interets?)\s*(?:and|&|\+|et|plus)\s+(?:\w+\s+){0,3}?(?:fees?|costs?|charges?|frais|couts?)\b|\b(?:fees?|costs?|charges?|frais|couts?)\s*(?:and|&|\+|et|plus)\s+(?:\w+\s+){0,2}?(?:interest reserve|reserve d\W?interets?)\b)/;
const FEE_RE = /\b(fees?|frais|honoraires|premiums?|prime d assurance)\b/;
// A tenant improvement allowance is a landlord's contribution to the tenant's fit-out, never a rent: the words may stand in the label, the clause before the figure, or right after it.
// A bare "allowance" or "allocation" refuses only a rent-shaped figure: an interest-only allowance in months or a budget allowance in dollars is that line's own figure.
const TI_WORDS = String.raw`(?:ti|tis|tenant (?:improvements?|allowances?)|ameliorations? locatives?|amenagements? du locataire)`;
const TI_RE = new RegExp(String.raw`\b${TI_WORDS}\b`);
const ALLOWANCE_RE = /\b(?:allowances?|allocations?)\b/;
const TI_AFTER_RE = new RegExp(String.raw`^\s*(?:(?:of|for|de|d) )?${TI_WORDS}\b`);
const ALLOWANCE_AFTER_RE = /^\s*(?:(?:of|for|de|d) )?(?:allowances?|allocations?)\b/;
const FEE_AFTER_RE = /^\s*(de |d )?(commitment |lender |standby |structuring |broker |insurance |engagement |ouverture |dossier )?(fees?|premium|frais|honoraires|prime d assurance)\b/;
const PER_INVESTOR_RE = /\b(minimum investment|min investment|minimum subscription|investissement minimal|investissement minimum|souscription minimale|souscription minimum|per limited partner|per investor|par commanditaire|par investisseur)\b/;
const PER_INVESTOR_AFTER_RE = /^\s*(per|par)\s+(limited partner|investor|commanditaire|investisseur)\b/;
// The lender's own basis for sizing a loan; "we underwrite rents at ..." is the sponsor's and is not here.
const BASIS_CUE_RE = /\b(?:credit underwriting|underwritten by the (?:lender|bank)|the (?:lender|bank) underwrites|the bank sizes|sized on|lending value|aux fins du pret|valeur de pret|la banque retient)\b/;
const ALL_ALIASES = [...new Set(FIELDS.flatMap((f) => f.aliases))].sort((a, b) => b.length - a.length);

/** The label with every field alias that holds one of `words` taken out. */
function without(text: string, words: RegExp, aliases: readonly string[] = ALL_ALIASES): string {
  let out = text;
  for (const a of aliases) {
    if (!words.test(a)) continue;
    const esc = a.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, "g"), "$1 ");
  }
  return out;
}

/** Why a figure is a lender's limit, term, fee or per-investor amount, not an input; null when it is none of them. */
function lenderFigure(rawLabel: string, t: NumberToken, opts: MapOptions): string | null {
  const prose = opts.prose ?? false;
  // In prose the clause just before the number; in a label the whole label.
  const clause = prose ? (rawLabel.split(/[,;(]|\band\b|\bet\b/).pop() ?? "") : rawLabel;
  const words_ = (x: string) => foldText(x.replace(/\([^)]*\)/g, " ")).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  let plain = words_(clause);
  // The words just after the number in its sentence ("5-year term", "3.1% insurance premium", "$25,000 per investor").
  const ctx = foldText(opts.context ?? "");
  const raw = foldText(t.raw);
  const from = rawLabel.trim() ? ctx.indexOf(foldText(rawLabel).trim()) : -1;
  const at = from >= 0 ? ctx.indexOf(raw, from) : ctx.indexOf(raw) === ctx.lastIndexOf(raw) ? ctx.indexOf(raw) : -1;
  // A figure in an aside ("0.5% ($18,000)") has no label of its own: the clause before it names it.
  if (prose && plain === "" && at >= 0) plain = words_((ctx.slice(0, at).split(/[,;]|\band\b|\bet\b/).pop() ?? "").replace("(", " "));
  const tail = prose && at >= 0 ? ctx.slice(at + raw.length).replace(/^\s*[.,;]\s*/, "") : "";
  const money = t.unit === "$" || t.unit === "$/mo" || t.currency;

  if (money && (PER_INVESTOR_RE.test(plain) || PER_INVESTOR_AFTER_RE.test(tail))) return "A per-investor amount, not the deal's equity";
  // A cue after the figure qualifies a rate or an occupancy ("93% occupancy for credit underwriting"); after an amount it describes the loan ("$2M, sized on ...").
  if (BASIS_CUE_RE.test(money ? plain : `${plain} ${tail.split(/[,;.]|\band\b|\bet\b/)[0]}`)) return "The lender's underwriting basis, not the deal's assumption";
  const words = plain.split(" ");
  // The last four words before the figure; a ratio's name ("loan to cost") counts as one.
  const lastFour = (x: string[]) => (x.join(" ").match(/loan to (?:cost|value)|debt service coverage|\S+/g) ?? []).slice(-4);
  const near = (prose || opts.ahead ? lastFour([...words, ...words_(opts.ahead ?? "").split(" ")]) : words).join(" ");
  const capped = CAPPED_RE.test(near) && !(money && CAPPED_COST_RE.test(plain) && !LOAN_WORD_RE.test(plain));
  if ((LIMIT_RE.test(without(near, LIMIT_RE)) || capped) && !COVERAGE_RE.test(plain)) return "A lender's limit, not the deal's figure";
  // The figure's own noun decides: an interest-only word before it or right after it makes it the IO period; one further on in the sentence does not.
  const ownIo = IO_RE.test(plain) || IO_START_RE.test(prose && at >= 0 ? ctx.slice(at + raw.length) : foldText(opts.after ?? ""));
  if ((t.unit === "months" || t.unit === "years") && ((TERM_RE.test(without(plain, TERM_RE)) && !AMORT_RE.test(plain)) || TERM_AFTER_RE.test(tail)) && !ownIo) return "A loan's term, not the build period, hold or amortization";
  // A fee named after a budget field or inside an "including" list is a part of that cost, not the figure's label.
  const full = without(words_(rawLabel), FEE_RE);
  const before = full.slice(0, Math.max(full.search(FEE_RE), 0));
  const listed = INCLUDING_RE.test(before) || BUDGET_NAME_RE.test(before);
  const rentShaped = t.unit === "$/sf" || t.unit === "$/m2";
  if (t.unit !== "%" && (TI_RE.test(plain) || TI_AFTER_RE.test(tail) || (rentShaped && (ALLOWANCE_RE.test(plain) || ALLOWANCE_AFTER_RE.test(tail))))) return "A tenant improvement allowance, not rent";
  if (!opts.budget && ((FEE_RE.test(without(plain, FEE_RE)) && !listed) || FEE_AFTER_RE.test(tail))) return "A fee or premium, not an input";
  // A leased or occupied share (in its own label or right after it) with a condition marker in its clause is the lender's condition.
  const after = prose && at >= 0 ? (ctx.slice(at + raw.length).split(/[,;.]/)[0] ?? "") : "";
  if (t.unit === "%" && (LEASED_RE.test(plain) || LEASED_RE.test(after.split(" ").slice(0, 6).join(" "))) && CONDITION_RE.test(`${plain} ${after}`)) return LENDER_CONDITION;
  return null;
}

/**
 * A money figure that names its currency records it after the unit it was read in:
 * "$" becomes "USD", "$/mo" becomes "$/mo USD". Reconcile reads it back with currencyOf.
 */
export function withCurrency(unitSeen: string, code: CurrencyCode | null): string {
  if (!code || !unitSeen.startsWith("$")) return unitSeen;
  return unitSeen === "$" ? code : `${unitSeen} ${code}`;
}

export function currencyOf(unitSeen: string | null | undefined): CurrencyCode | null {
  return (/(?:^|\s)(CAD|USD|AUD)$/.exec(unitSeen ?? "")?.[1] as CurrencyCode | undefined) ?? null;
}

const FIELD_BEFORE_TYPE_RE = /\b(?:count|number|nombre|units?|homes?|doors?|suites?|logements?|rents?|leases?|price|loyer)\b/i;

/** "Unit count – one-bed": a count or rent field, a dash, then a whole unit type reads as "one-bed unit count" (task 55). */
function fieldThenType(raw: string): string {
  const m = /^(.+?)(?:\s*[–—]\s*|\s+[-‒]\s+)([^–—]+)$/.exec(raw);
  const before = m?.[1]!.trim() ?? "";
  const after = m?.[2]!.trim() ?? "";
  return m && wholeUnitType(after) && unitTypesIn(before).length === 0 && FIELD_BEFORE_TYPE_RE.test(before) ? `${after} ${before}` : raw;
}

export function normalizeLabel(raw: string): { label: string; labelUnit: LabelUnit; labelCode: CurrencyCode | null } {
  let labelUnit: LabelUnit = null;
  let labelCode: CurrencyCode | null = null;
  const paren = raw.match(/\(([^)]*)\)/g) ?? [];
  for (const p of paren) {
    const inner = p.slice(1, -1).trim().toLowerCase();
    // "(USD)", "($ US)", "(US$)" name a currency; "($)" and "(dollars)" name none.
    if (/^(\$|usd|cad|dollars|\$\s?(us|can?)|(us|ca)\$)$/.test(inner)) {
      labelUnit = "$";
      labelCode = codeOf(inner.toUpperCase());
    } else if (/^(%|percent|pct)$/.test(inner)) labelUnit = "%";
    else if (/^(months?|mos?|mois)$/.test(inner)) labelUnit = "months";
    else if (/^(years?|yrs?|ans?)$/.test(inner)) labelUnit = "years";
    else if (/^(sf|sq\.? ?ft|square feet|pi²|pi2|pi\.? ?ca\.?)$/.test(inner)) labelUnit = "sf";
    else if (/^(m²|m2|sq\.? ?m|sqm|square met(re|er)s)$/.test(inner)) labelUnit = "m2";
    else if (/^x$/.test(inner)) labelUnit = "x";
  }
  const label = fieldThenType(raw)
    .replace(/\([^)]*\)/g, " ")
    .replace(/²/g, "2")
    .toLowerCase()
    // Fold accents ("coût" is "cout") rather than drop the letter.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9/#$%&\s-]/g, " ")
    .replace(/\b(is|are|of|at|to|was|will be|approximately|approx|about)\s*$/g, " ")
    // "Coach house / count": a type, a slash and the field it holds name the item and the field, as "Coach house count" does.
    .replace(/(\S) \/ (?:count|number|nombre)\b/g, "$1 unit count")
    .replace(/(\S) \/ (?=(?:monthly rent|rent|area|occupancy|loyer|superficie|occupation)\b)/g, "$1 ")
    // A hyphen set apart by spaces is a separator, never part of a name ("Lane house - monthly rent").
    .replace(/\s[-‒]\s/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A short label may end with its unit: "Build period, months", "Lease-up months", "Amortissement, ans".
  if (!labelUnit && label.split(" ").length <= 6 && !/\d/.test(label)) {
    // ... or begin with it: "Months allowed for leasing".
    const w = /(?:^|[\s,])(months?|mos?|mois|years?|yrs?|ans?|annees?)$/.exec(label)?.[1] ?? /^(months|mois|years)\s/.exec(label)?.[1];
    if (w) labelUnit = /^(m|mo)/.test(w) ? "months" : "years";
  }
  return { label, labelUnit, labelCode };
}

export function hasPhrase(label: string, phrase: string): boolean {
  return phraseAt(label, phrase) !== null;
}

/** Where the phrase last occurs in the label, as [start, end). */
function phraseAt(label: string, phrase: string): [number, number] | null {
  const esc = phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  let found: [number, number] | null = null;
  for (const m of label.matchAll(new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`, "g"))) found = [m.index! + m[1]!.length, m.index! + m[0].length];
  return found;
}

// An alias right after one of these (and at most three words) is a reference, not what the number is: "above the preferred return".
const REFERENCE_RE = /\b(above|over|beyond|after|in excess of|au dela de|au dela du|au dela des|apres)\s+(?:\S+\s+){0,3}$/;

function endsWithPhrase(label: string, phrase: string): string | null {
  if (label === phrase) return "";
  if (label.endsWith(" " + phrase)) return label.slice(0, -phrase.length - 1).trim();
  return null;
}

const HEADING_NAME_RE = /^(summary|sommaire|totals?|subtotal|type|types|average|overall)\b/;

// A function word is never an item name ("the allowance of $65/SF as rent" names no item "As").
const FUNCTION_WORDS = new Set(["as", "of", "the", "a", "an", "at", "in", "on", "for", "to", "de", "du", "la", "le", "les", "des", "au", "en", "pour"]);

function itemName(prefix: string): string {
  const words = prefix.split(" ").filter((w) => w && !GENERIC.has(w));
  if (words.length === 0 || words.length > 4 || words.every((w) => FUNCTION_WORDS.has(w))) return "";
  return canonicalItem(words.map((w) => (/^\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" "));
}

/**
 * Convert a token to the field's canonical unit, or return null if they are not
 * compatible. Areas are canonical in square feet: m² is converted here, and
 * unitSeen keeps the unit the document used (decision 7). A currency named by
 * the label applies to a figure that names none of its own.
 */
function compatibleValue(def: FieldDef, t: NumberToken, label: string, labelUnit: LabelUnit, labelCode: CurrencyCode | null, prose = false): { value: number; unitSeen: string } | null {
  const c = convert(def, t, label, labelUnit, prose);
  return c && { ...c, unitSeen: withCurrency(c.unitSeen, t.currencyCode ?? labelCode) };
}

/** What a months figure was written as: a count of quarters says so, so the conversion shows. */
const monthsSeen = (t: NumberToken) => (t.quarters ? "months (stated in quarters; × 3)" : "months");

function convert(def: FieldDef, t: NumberToken, label: string, labelUnit: LabelUnit, prose: boolean): { value: number; unitSeen: string } | null {
  if (t.value === null) return null;
  // A parenthesised figure is negative only as money: "(16 months)" is 16.
  const v = t.paren && def.unit !== "$" ? Math.abs(t.value) : t.value;
  const u = t.unit;
  switch (def.unit) {
    case "$":
      if (u === "$" || labelUnit === "$") return { value: v, unitSeen: "$" };
      // A monthly figure for the whole of the other income is twelve months of it; one per stall or per unit is not stated as a total.
      if (u === "$/mo" && def.key === "other_income_annual" && /\b(income|revenues?|revenus?)\b/.test(label)) return { value: v * 12, unitSeen: "$/mo" };
      // In prose a bare number is never money (a year, a count): tables and label/value lines keep the rule.
      if (u === null && !prose && Math.abs(v) >= 1000) return { value: v, unitSeen: "number" };
      return null;
    case "%":
      if (u === "%" || (u === null && labelUnit === "%")) return { value: v, unitSeen: "%" };
      return null;
    case "months":
      // "Refinance month: 26": the label says it is a month number.
      if (def.key === "refinance_month" && u === null && /\b(month|mois)$/.test(label)) return { value: v, unitSeen: "months" };
      if (u === "months" || (u === null && labelUnit === "months")) return { value: v, unitSeen: monthsSeen(t) };
      if (u === "years" || (u === null && labelUnit === "years")) return { value: v * 12, unitSeen: "years" };
      return null;
    case "years":
      if (u === "years" || (u === null && labelUnit === "years")) return { value: v, unitSeen: "years" };
      if (u === "months" && Number.isInteger(v / 12)) return { value: v / 12, unitSeen: monthsSeen(t) };
      return null;
    case "units":
      if (u === "units") return { value: v, unitSeen: "units" };
      // An area is never a count.
      if (u === null && labelUnit === null && Number.isInteger(v) && v > 0 && !AREA_WORD_RE.test(label)) return { value: v, unitSeen: "number" };
      return null;
    case "sf":
      if (u === "sf" || (u === null && labelUnit === "sf")) return { value: v, unitSeen: "sf" };
      if (u === "m2" || (u === null && labelUnit === "m2")) return { value: v * SF_PER_M2, unitSeen: "m2" };
      if (u === null && labelUnit === null && hasPhrase(label, "area") && v >= 100) return { value: v, unitSeen: "number" };
      return null;
    case "$/unit/mo":
      // A yearly rent is a monthly one only per unit, and only as one twelfth of it. A label naming both periods is not read.
      if (u === "$" && ANNUAL_RE.test(`${label} ${foldText(t.raw)}`)) return MONTHLY_RE.test(`${label} ${foldText(t.raw)}`) ? null : PER_UNIT_RE.test(label) ? { value: Math.round((v / 12) * 100) / 100, unitSeen: "$ (stated as an annual rent per unit; divided by 12)" } : null;
      if (u === "$/mo") return { value: v, unitSeen: "$/mo" };
      if (u === "$" && /\b(monthly|per month|per unit|mensuel|mensuelle|par mois|par logement)\b/.test(label)) return { value: v, unitSeen: "$" };
      return null;
    case "$/sf/yr":
      if (u === "$/sf") return { value: v, unitSeen: "$/sf" };
      if (u === "$/m2") return { value: Math.round((v / SF_PER_M2) * 100) / 100, unitSeen: "$/m2" };
      if ((u === "$" || u === null) && /\b(psf|per sf|\/sf|per sq ft|per square foot|au pied carre|par pied carre)\b/.test(label)) return { value: v, unitSeen: "$" };
      if ((u === "$" || u === null) && /\b(psm|per m2|\/m2|per sq m|per square met(re|er)|au m2|par m2|au metre carre|par metre carre)\b/.test(label)) return { value: Math.round((v / SF_PER_M2) * 100) / 100, unitSeen: "$/m2" };
      return null;
    case "x":
      if (u === "x") return { value: v, unitSeen: "x" };
      if (u === null && (labelUnit === "x" || /\b(dscr|dcr|debt service coverage|couverture du service de la dette|rcsd|rcd|ccd)\b/.test(label))) return { value: v, unitSeen: "number" };
      return null;
    default:
      return null;
  }
}

export type MapOptions = {
  /** Prose: the alias nearest the number names it, and a bare number is never money. */
  prose?: boolean;
  /** The loan the document or section is about; a label that names its own loan overrides it. Default senior. */
  scope?: Scope;
  /** A budget table's row: "Other" names a cost here. */
  budget?: boolean;
  /** The sentence the label came from, for words about a sale that sit outside the label. */
  context?: string;
  /** The words just after the number in its line, for what the figure is a share of ("4% of EGI") or what it measures ("24 months IO"). */
  after?: string;
  /** The words between a label and its figure, in a label/value line. */
  gap?: string;
  /** A builder's quote: its Total, and its contract price, is the hard cost. */
  quote?: boolean;
  /** The words between a label and its number ("at least" in "Occupancy: at least 90%"), which may carry a limit. */
  ahead?: string;
};

// What may follow a loose alias before the number: "income", "amount", or a verb phrase ("is planned at", "should take", "est de").
const FILLER = "is|are|was|were|will|be|been|should|shall|to|take|takes|taking|planned|scheduled|expected|estimated|set|budgeted|for|at|of|about|approximately|around|a|an|the|total|only|currently|now|income|revenue|revenues|revenu|revenus|amount|montant|est|sont|sera|seront|durera|prevu|prevue|prevus|de|du|d|environ|devrait|dure|au|aux|fixe|fixee|represente";
const FILLER_RE = new RegExp(`^(\\s(${FILLER}))*$`);

// A sequencing word after a duration noun ("of lease-up afterwards", "de location ensuite") does not stop the noun labelling the number.
const SEQUENCE_TAIL_RE = /(\s(then|afterwards?|after that|after (completion|delivery|handover)|ensuite|puis|apres (la )?(livraison|completion)))+$/;

/** Where the loose alias stands in the label: at its end, or followed only by filler words and a sequencing word. */
function standsLast(label: string, at: [number, number]): boolean {
  return FILLER_RE.test(label.slice(at[1]).replace(SEQUENCE_TAIL_RE, ""));
}

const HEAD_CONNECTOR_RE = /\b(above|over|after|beyond|au[- ]dela|au[- ]dessus)\b/;

// A builder's quote total, once its revision words are taken out.
const QUOTE_TOTAL_RE = /^(?:grand )?(?:total(?: price| quote| bid| tender| estimate| contract(?: price)?| amount)?|contract total|quote total|contract price|montant total|prix total|total de la soumission|total soumission|total du devis|prix du contrat)$/;
const COVER_LIST_RE = /[\s,](?:covering|including|incl|comprising|such as|comprenant|incluant|dont)\b/;
const REVISION_WORDS_RE = /\b(?:revised|revisee?|revise|rev(?:ision)?\.? ?[a-z0-9]?|rev)\b/g;
// A loan named as the whole label: its scope words, the words that say "loan", and filler are all there is.
const LOAN_WORDS = /\b(loans?|debt|mortgage|facility|prets?|dette|hypotheque|hypothecaire)\b/g;
const LOAN_FILLER = /\b(from|with|at|de|du|des|d|avec|chez|a|au|aux|by|the|le|la|les|l|of|for|pour|is|est|are|sont|and|et)\b/g;
const IO_AFTER_RE = /^\s*(?:of\s+|d\s*)?(?:io\b|interest[- ]only|interets? seulement)/;
const AMORT_AFTER_RE = /^\s*(?:d\s*)?amorti[sz]/;
const BASIS_AFTER_RE = /^\s*(?:of|de|du|des|ltv|ltc|loan[- ]to|ratio|pret[- ]valeur|rpv|pret a)\b/;

/** The scope of a label that is only a loan's name ("Senior", "from Valleyline, mezz", "prêt de second rang"); null when it holds anything more. A lender's name is a title-case word. */
export function loanNameOnly(rawLabel: string): Scope | null {
  const clause = (rawLabel.split(/[,;]/).pop() ?? "").replace(/\([^)]*\)/g, " ");
  const scope = scopeIn(clause, false);
  if (!scope) return null;
  const names = new Set(clause.trim().split(/\s+/).slice(1).filter((w) => /^\p{Lu}/u.test(w)).map((w) => foldText(w).replace(/[^a-z0-9]/g, "")));
  let rest = foldText(clause);
  for (const r of Object.values(SCOPE_WORDS)) rest = rest.replace(new RegExp(r.source, "g"), " ");
  rest = rest.replace(LOAN_WORDS, " ").replace(/^\s*(?:our|your|my|their|this|notre|votre|ton|ta|mon|ma|nos|vos|leur|un|une)\b/, " ").replace(LOAN_FILLER, " ");
  return rest.split(/[^a-z0-9]+/).filter(Boolean).every((w) => names.has(w)) ? scope : null;
}

/** Every loan a text names by a scope word. */
export function scopesIn(text: string): Scope[] {
  const f = foldText(text);
  return (Object.keys(SCOPE_WORDS) as Scope[]).filter((k) => SCOPE_WORDS[k].test(f));
}

// Inside a sentence that names a loan: the words that put a money figure first as the loan's amount, and the filler a clause may hold around a bare term.
const AMOUNT_WORD_RE = /\b(?:advances?|advancing|principal|will lend|lends?|lending|commits?|committing|commitment of|facility of|avance|avancera|avancent|prete|pretera|pretent|consent|consentira)\s*(?:(?:de|of|d|an?|un|une|up to|jusqu a|to)\s+)*$/;
const TERM_FILLER = /\b(?:at|a|au|aux|taux|de|du|d|of|rate|interest|interet|coupon|fixed|fixe|bearing|carrying|portant|with|avec|the|le|la|an|un|une|per annum|annual|annually|stays?|remains?|is|are|will|be|while|whereas|and|but|reste|demeure|est|sera|alors que|tandis que|lenders?|preteurs?)\b/g;
const RATE_NOT_RE = /\b(?:fees?|frais|ltv|ltc|loan to|ratio|prime|spread|premium|prix|price|of|de|du|des)\b/;
const IO_BEFORE_RE = /(?:interest[- ]only|\bio\b|interets? seulement)\s*(?:(?:for|pour|of|de|d|during|pendant|the|first|initial|les?|premiers?|premieres?)\s+)*$/;
const AMORT_BEFORE_RE = /amorti(?:[sz]\w*)?\s*(?:(?:over|sur|of|de|d|on)\s+)*$/;

function withoutLoanNames(text: string): string {
  let rest = text;
  for (const r of Object.values(SCOPE_WORDS)) rest = rest.replace(new RegExp(r.source, "g"), " ");
  return rest.replace(LOAN_WORDS, " ");
}

/**
 * A figure in a sentence that names a loan, whose own clause holds nothing but a term of it ("will advance $240,000", "at 11.5% fixed",
 * "amortized over 15 years", "6 months IO"): the loan's amount, rate, amortization or interest-only period, read as that label would be.
 * `tail` is the words of the figure's clause before it; `after` the words after it up to the clause's end. A fee, a term and a loan-to-value are none of these.
 */
export function loanTerm(tail: string, after: string, t: NumberToken, scope: Scope): Mapped | null {
  const before = foldText(tail).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const next = foldText(after).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  const duration = t.unit === "months" || t.unit === "years";
  const term =
    t.value === null ? null
    : (t.unit === "$" || t.currency) && AMOUNT_WORD_RE.test(`${before} `) ? "loan amount"
    : t.unit === "%" && withoutLoanNames(before).replace(TERM_FILLER, " ").trim() === "" && !RATE_NOT_RE.test(next) && !LTV_RE.test(`${before} ${next}`) ? "interest rate"
    : duration && (IO_BEFORE_RE.test(`${before} `) || IO_AFTER_RE.test(` ${next}`)) ? "interest-only period"
    : duration && (AMORT_BEFORE_RE.test(`${before} `) || AMORT_AFTER_RE.test(` ${next}`)) ? "amortization"
    : null;
  if (!term) return null;
  const m = mapToken(`${scope === "refinance" ? "take-out" : scope} ${term}`, t, { prose: true, scope });
  return m.kind === "field" ? m : null;
}

// A percentage "to the investors" is a share of distributions; to the GP or sponsor it is read as it always was.
const SHARE_TO_RE = /^\s*(?:to|aux)\s+(?:the\s+|our\s+|les\s+|nos\s+)?(?:partners|investors|lps?|limited partners|members|commanditaires|investisseurs|associes)\b/;
// "Sale at a 6.1% cap": the word "cap" right after the percentage, not "cap of", "cap on" or "capped".
const CAP_AFTER_RE = /^\s*cap\b(?!\s+(?:of|on)\b)/;
// A promote tier from the second up.
const LATER_TIER_RE = /\b(?:tier\s*(?:[2-9]|ii|iii|iv|two|three|four)|(?:2nd|3rd|[4-9]th|second|third|fourth)\s+tier|palier\s*(?:[2-9]|ii|iii|iv|deux|trois|quatre)|(?:[2-9]e|[2-9]eme|deuxieme|troisieme|quatrieme)\s+palier)\b/;
const VACANCY_RE = /\b(vacancy(?! rate)|(?<!taux de )vacance|inoccupation)\b/;
// A duration labelled by the words right after it: "16 months to build", "huit mois pour louer".
const BUILD_AFTER_RE = /^\s*to build\b/;
const LEASE_AFTER_RE = /^\s*(?:to lease(?: up)?|pour louer)\b/;
// A figure about the market, not the deal.
const MARKET_RE = /\b(market|submarket|sub-market|city|area|zone|neighbou?rhood|region|cmhc|average|avg|comparables?|comps?|marche|secteur|quartier|schl|moyenne|moyen)\b/;
const MARKET_NOTE = "A market statistic, not the deal's assumption";
const NOT_STABILIZED_RE = /\b(lease[- ]?up|opening|ouverture|absorption|mise en location|during|pendant|initial|current|currently|today|actual|actuel\w*|existing|as of|en date du)\b/;

/** A "Yes"/"Oui"/"True" (1) or "No"/"Non"/"False" (0) answer, however many words follow, beside the label of a flag field; anything else reads no flag. */
export function flagRead(rawLabel: string, answer: string): { fieldKey: string; value: 0 | 1 } | null {
  const a = foldText(answer).trim();
  const value = /^(yes|oui|true)\b/.test(a) ? 1 : /^(no|non|false)\b/.test(a) ? 0 : null;
  if (value === null) return null;
  const label = normalizeLabel(rawLabel).label;
  const def = FIELDS.find((f) => f.unit === "flag" && f.aliases.some((al) => hasPhrase(label, al)));
  return def ? { fieldKey: def.key, value } : null;
}

/** Map one labelled number onto a field. In prose the alias nearest the number names it, and a bare number is never money. */
export const CREDIT_NOTE = "A credit: reduces total cost";
export const NEGATIVE_NOTE = "A negative figure that does not say it is a credit";

// A label that says the figure is a credit. Folded (no accents, lower case) text.
const CREDIT_WORD_RE = /(?:^|[^a-z])(?:credits?|credited|rebates?|refunds?|refunded|reimbursements?|reimbursed|remises?|remboursements?|rembourse|ristournes?|subvention deduite|subventions? (?:nette )?(?:deduite|qui reduit les couts)|aide financiere (?:deduite|qui reduit les couts)|grant applied)(?![a-z])/;
// Credit words that are not a credit against the cost: a loan line, a rating, a loss allowance, a tax credit, a restoration.
const NOT_CREDIT_RE = /(?:line|lines|letter|letters|facility|facilities|marge|ligne|lettre|facilite|carte|card|tax|taxe|impot|impots)\s+(?:of\s+|de\s+|d\s+)?credits?(?![a-z])|credits?\s+(?:facility|facilities|union|rating|check|checks|score|loss|losses|risk|agreement|committee|card|bureau|enhancement|insurance|line|lines|support|policy|quality|worthiness|de risque|d impot)|cooperative de credit|remises?\s+(?:en etat|a neuf|en forme|des cles|de cles|des plans|de prix)/;
// A cost waived or exempted, and the words that make a figure what is paid after it. Folded text.
export const WAIVED_NOTE = "Waived or exempt, so not what the deal pays; enter 0 if nothing is due";
const WAIVED_RE = /(?:^|[^a-z])(?:waived|exempt|exempted|exemption|forgiven|not payable|exoneree?s?|exoneration|exemptee?s?|non exigibles?)(?![a-z])/;
// "HST exempt" and "exempt from GST" say what tax a cost bears, not that the cost is waived.
const SALES_TAX_EXEMPT_RE = /(?:^|[^a-z])(?:hst|gst|pst|qst|tps|tvq|tvh|tva|vat|sales tax|tax|taxes|taxe)[\s-]+(?:exempt|exempted|exemptee?s?|exoneree?s?)(?![a-z])|(?:^|[^a-z])(?:exempt|exempted|exemptee?s?|exoneree?s?)\s+(?:from|of|de|de la|des)\s+(?:hst|gst|pst|qst|tps|tvq|tvh|tva|vat|sales tax|tax|taxes|taxe)(?![a-z])/;
// Card 61d: a line about a tax, interest, a fee or a carrying cost is not the item it names. Folded text.
export const SALES_TAX_NOTE = "A sales tax line; enter GST/HST net of rebates, or label it";
export const INTEREST_NOTE = "Interest on this item, not the item; label it if it belongs to a cost line";
export const CARRYING_NOTE = "A carrying cost; label it under the cost line it belongs to";
const SALES_TAX_WORD = String.raw`(?:hst|gst|pst|qst|tps|tvq|tvh|sales tax|taxe de vente)`;
const SALES_TAX_RE = new RegExp(String.raw`(?:^|[^a-z])${SALES_TAX_WORD}(?![a-z])`);
// The tax as the basis of a cost: "incl. HST", "net of GST/HST", "HST extra".
const SALES_TAX_BASIS_RE = new RegExp(String.raw`(?:^|[^a-z])(?:incl|including|includes|inclusive|excl|excluding|exclusive|ex|before|after|net of|plus|with|without|no|inclus|incluant|avant|apres|sans|avec|hors|pas de)\s+(?:the\s+|of\s+|de\s+|la\s+|des\s+)?(?:(?:gst|pst|qst|hst)/)?${SALES_TAX_WORD}(?![a-z])|${SALES_TAX_WORD}\s+(?:included|extra|excluded|not applicable|n/a|nil|free|zero rated|inclus\w*|en sus|non applicable|sans objet)(?![a-z])`);
const INTEREST_WORD_RE = /(?:^|[^a-z])(?:interests?|interets?)(?![a-z])/;
// Fees are soft costs, so a soft-cost line about fees is that line. In French "frais" is mostly a cost ("frais de construction"),
// so it is a fee only on a loan ("frais du prêt").
const FEE_WORD_RE = /(?:^|[^a-z])fees?(?![a-z])/;
const LOAN_FEE_WORD_RE = /(?:^|[^a-z])(?:fees?|frais)(?![a-z])/;
const LOAN_AMOUNTS = new Set(["senior_loan_amount", "mezz_loan_amount", "refinance_amount"]);
const INTEREST_ONLY_RE = /interest[- ]only|interets? seulement/g;
const CARRYING_RE = /(?:^|[^a-z])(?:insurance|assurances?|utilities|services publics|property taxes?|taxes|taxe fonciere|taxes foncieres|carrying costs?|holding costs?|couts? de portage)(?![a-z])/;
const TAXES_BASIS_RE = /(?:^|[^a-z])taxes\s+(?:included|extra|inclus\w*|en sus)(?![a-z])/;
const TRANSFER_TAX_RE = /(?:land|property) transfer taxes?/g;
const INTEREST_FEE_FIELDS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "development_charges", "land_transfer_tax", "senior_loan_amount", "mezz_loan_amount", "refinance_amount"]);
const CARRYING_FIELDS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "development_charges", "land_transfer_tax"]);
const NET_OF_RE = /(?:^|[^a-z])(?:net of|after|less|minus|nette? de|nets de|apres|deduction faite)(?![a-z])/;
// The budget lines a credit may be written against: it is read as the other costs, never as a reduction of one of these.
const CREDITABLE = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost"]);

const OLD_LABEL_RE = /(?:^|[^a-z])(?:ancien(?:ne)?s?|old|superseded|previous(?:ly)?|precedent\w*|formerly|original(?:ly)?|earlier)\s+(?:[a-z]+\s+){0,2}?(?:total|price|priced|prix|quote|quoted|cost|costs|couts?|budget|montant|travaux|land|terrain|contract|soumission|estimate|estimated)(?![a-z])/;
// A sheet whose name says it is old holds no current figures.
export const OLD_SHEET_RE = /\b(?:ancien(?:ne)?s?|old|superseded|previous|precedent\w*|formerly|original|earlier|prior|archiv\w*)\b/;
// A sheet named for a scenario holds that scenario's figures, not the deal's base case.
export const SCENARIO_SHEET_RE = /\b(?:downside|upside|sensitivit\w*|sensibilite|stress|scenarios?|what[- ]?if|(?:credit|lender|bank|worst|best) case|cas defavorable)\b/;
export const SCENARIO_SHEET_NOTE = "A scenario sheet, not the deal's base case";
export const SUPERSEDED_LABEL_NOTE = "An earlier figure, named old or original by its own label; a later figure for the line replaces it";

// Card 61c. Folded text.
export const DEPOSIT_NOTE = "A deposit or an amount already paid, not a budget line";
export const TWO_LINES_NOTE = "Two budget lines in one figure; enter each, or label it";
export const REBATE_NOTE = "A rebate or credit; enter it as a negative other cost if it reduces the cost";
const PAID_SO_FAR_RE = /(?:^|[^a-z])(?:(?<!up )to date|so far|a ce jour|jusqu a present|deja (?:paye|depense|verse)e?s?)(?![a-z])/;
const PAID_SO_FAR_AFTER_RE = /^[\s,;(-]*(?:(?:paid|spent|incurred|payee?s?|depensee?s?)\s+)?(?:(?<!up )to date|so far|a ce jour|jusqu a present)(?![a-z])/;
// A credit word does not make the figure a credit when the label says it is net of, or before, it.
const BASIS_OF_CREDIT_RE = /(?:^|[^a-z])(?:net of|after|less|minus|before|without|excluding|excl|nette? de|nets de|apres|avant|sans|hors|deduction faite)(?![a-z])/;
const JOINER_RE = /\s*[&+/]\s*|\s+(?:and|plus|et)\s+/;
const HAS_JOINER_RE = /[&+/]|\s(?:and|plus|et)\s/;
const JOINED_ALIASES = [...new Set(FIELDS.flatMap((f) => f.aliases))].filter((a) => HAS_JOINER_RE.test(a)).sort((a, b) => b.length - a.length);
const SHARED_NOUN_RE = /^(?:costs?|couts?|frais|expenses?|depenses|charges?)$/;
// The price of the land is a land line, though no alias says so alone.
const PURCHASE_PRICE_RE = /^(?:the\s+)?(?:land\s+)?(?:purchase|acquisition)\s+price$|^prix\s+d\s+(?:achat|acquisition)(?:\s+du\s+terrain)?$/;
const LINE_PROBE: NumberToken = { raw: "1000000", start: 0, end: 7, value: 1_000_000, currency: true, currencyCode: null, unit: "$", scaled: false };
const LINE_FIELDS = new Set(FIELDS.filter((f) => f.group === "budget" && f.key !== "gst_hst_net").map((f) => f.key));

/** The budget field a phrase names alone; null when it names none. */
function lineOf(phrase: string): string | null {
  const p = phrase.replace(/\u0001/g, " ").trim();
  if (PURCHASE_PRICE_RE.test(p)) return "land_cost";
  const m = p ? mapLabel(p, LINE_PROBE, { prose: true, budget: true }) : null;
  return m && m.kind === "field" && m.itemKey === null && LINE_FIELDS.has(m.fieldKey) ? m.fieldKey : null;
}

/** Whether a label names two different budget fields joined by "and", "plus", "&", "+", "/" or "et", the first borrowing the second's noun ("hard and soft costs"). */
function twoLines(folded: string): boolean {
  let text = folded.replace(/\([^)]*\)/g, " ");
  const cover = COVER_LIST_RE.exec(text);
  if (cover && cover.index > 0) text = text.slice(0, cover.index);
  // An alias that holds a joiner ("design and permits") is one phrase.
  for (const a of JOINED_ALIASES) text = text.replace(new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=$|[^a-z0-9])`, "g"), (_, lead: string) => lead + a.replace(/ /g, "\u0001"));
  const parts = text.split(JOINER_RE).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const words = parts.map((x) => x.replace(/\u0001/g, " ").split(/\s+/));
  const keys = parts.map((p, i) => {
    const own = lineOf(p);
    if (own) return own;
    // "Hard and soft costs", "coûts directs et indirects": the noun of another part completes this one.
    for (const [j, w] of words.entries()) {
      if (j === i) continue;
      const tail = w[w.length - 1]!;
      const head = w[0]!;
      const done = (SHARED_NOUN_RE.test(tail) ? lineOf(`${p} ${tail}`) : null) ?? (SHARED_NOUN_RE.test(head) ? lineOf(`${head} ${p}`) : null);
      if (done) return done;
    }
    return null;
  });
  return new Set(keys.filter((k) => k !== null)).size >= 2;
}

/** The note for a budget label that is not one budget line's figure; null when it is. */
function budgetShapeNote(rawLabel: string, after: string, value: number): string | null {
  const folded = foldText(rawLabel);
  let label = folded;
  const cover = COVER_LIST_RE.exec(label);
  if (cover && cover.index > 0) label = label.slice(0, cover.index);
  if (PAID_SO_FAR_RE.test(label) || PAID_SO_FAR_AFTER_RE.test(foldText(after))) return DEPOSIT_NOTE;
  if (twoLines(folded)) return TWO_LINES_NOTE;
  // A positive rebate; not one when the label is a line of credit, a tax credit, a figure net of the rebate, or a sales tax line.
  if (value >= 0 && CREDIT_WORD_RE.test(label) && !NOT_CREDIT_RE.test(label) && !BASIS_OF_CREDIT_RE.test(label) && !SALES_TAX_RE.test(label)) return REBATE_NOTE;
  return null;
}

/**
 * A negative other cost is read only when its own label says it is a credit (then it is the other costs, with a note);
 * a negative figure that does not say so is refused. Nothing is inferred from a sign, and no sign is flipped.
 */
export function mapToken(rawLabel: string, t: NumberToken, opts: MapOptions = {}): Mapped {
  // A sales tax line, or a rebate of one, is refused before any credit rule reads it; a cost that only states its tax basis is read.
  const folded = foldText(rawLabel);
  if (t.value !== null && (t.unit === "$" || t.currency || t.unit === null) && SALES_TAX_RE.test(folded) && !SALES_TAX_BASIS_RE.test(folded.replace(/\+/g, " plus ").replace(/[^a-z0-9/]+/g, " ")) && !SALES_TAX_EXEMPT_RE.test(folded)) return { kind: "ignored", reason: SALES_TAX_NOTE };
  const m = mapSigned(rawLabel, t, opts);
  // A figure its field could never hold is shown, never read: nothing is flipped, rescaled or clamped.
  if (m.kind !== "field") return m;
  const def = FIELD_BY_KEY.get(m.fieldKey);
  // Interest, a fee or a carrying cost named after an item is not the item. A word inside the matched field's own alias, or in a list of what the head covers, is that field's.
  if (def && m.itemKey === null && def.unit === "$" && (INTEREST_FEE_FIELDS.has(def.key) || CARRYING_FIELDS.has(def.key))) {
    let label = normalizeLabel(rawLabel).label;
    const cover = COVER_LIST_RE.exec(label);
    if (cover && cover.index > 0 && BUDGET_NAME_RE.test(label.slice(0, cover.index))) label = label.slice(0, cover.index);
    const own = (re: RegExp) => without(label.replace(INTEREST_ONLY_RE, " "), re, def.aliases);
    if (INTEREST_FEE_FIELDS.has(def.key) && INTEREST_WORD_RE.test(own(INTEREST_WORD_RE))) return { kind: "ignored", reason: INTEREST_NOTE };
    const fee = LOAN_AMOUNTS.has(def.key) ? LOAN_FEE_WORD_RE : FEE_WORD_RE;
    if (INTEREST_FEE_FIELDS.has(def.key) && def.key !== "soft_cost" && fee.test(own(fee))) return { kind: "ignored", reason: "A fee or premium, not an input" };
    const carrying = label.replace(TRANSFER_TAX_RE, " ");
    if (CARRYING_FIELDS.has(def.key) && CARRYING_RE.test(without(carrying, CARRYING_RE, def.aliases)) && !TAXES_BASIS_RE.test(carrying)) return { kind: "ignored", reason: CARRYING_NOTE };
  }
  // Card 61c: a budget label that is two lines, a rebate, or an amount paid so far is shown, never read as the line it names.
  if (def?.group === "budget" && m.itemKey === null) {
    const shape = budgetShapeNote(rawLabel, opts.after ?? "", m.value);
    if (shape) return { kind: "ignored", reason: shape };
  }
  // A cost the city waived or exempted is not what the deal pays; $0 is, and so is a figure net of the exemption.
  if (def?.group === "budget" && m.value !== 0) {
    const words = foldText(`${rawLabel} ${opts.after ?? ""}`);
    if (WAIVED_RE.test(words) && !NET_OF_RE.test(words) && (m.fieldKey === "land_transfer_tax" || !SALES_TAX_EXEMPT_RE.test(words))) return { kind: "ignored", reason: WAIVED_NOTE };
  }
  return def && outsideBounds(def, m.value) ? { kind: "ignored", reason: `The figure is outside what ${def.label} can hold` } : m;
}

/** Whether a value is outside the field's own `integer`, `min` and `max`; one check for the reader and for suggestions. */
export function outsideBounds(def: FieldDef, v: number): boolean {
  return (def.integer === true && !Number.isInteger(v)) || (def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max);
}

function mapSigned(rawLabel: string, t: NumberToken, opts: MapOptions = {}): Mapped {
  const m = mapLabel(rawLabel, t, opts);
  // A budget line whose own label calls the figure the old, original or earlier one is shown: a later figure for the line replaces it.
  if (m.kind === "field" && m.itemKey === null && CREDITABLE.has(m.fieldKey) && OLD_LABEL_RE.test(normalizeLabel(rawLabel).label)) return { kind: "ignored", reason: SUPERSEDED_LABEL_NOTE };
  if (t.value === null || t.value >= 0 || m.kind === "ignored") return m;
  const { label, labelUnit, labelCode } = normalizeLabel(rawLabel);
  const credit = CREDIT_WORD_RE.test(label) && !NOT_CREDIT_RE.test(label);
  if (m.kind === "field") {
    if (m.itemKey !== null || !CREDITABLE.has(m.fieldKey) || m.value >= 0) return m;
    return credit ? { ...m, fieldKey: "other_cost", note: CREDIT_NOTE } : m.fieldKey === "other_cost" ? { kind: "ignored", reason: NEGATIVE_NOTE } : m;
  }
  // A credit named by its own words maps to no field by itself; a bare number counts as money only because of those words.
  if (!credit || t.unit === "%" || t.unit === "months" || t.unit === "years") return m;
  const c = compatibleValue(FIELD_BY_KEY.get("other_cost")!, t, label, labelUnit, labelCode);
  return c && c.value < 0 ? { kind: "field", fieldKey: "other_cost", itemKey: null, value: c.value, unitSeen: c.unitSeen, note: CREDIT_NOTE } : m;
}

function mapLabel(rawLabel: string, t: NumberToken, opts: MapOptions = {}): Mapped {
  const prose = opts.prose ?? false;
  const norm = normalizeLabel(rawLabel);
  const { labelUnit, labelCode } = norm;
  let label = norm.label;
  // A budget field at the head of a label and a list of what it covers: the head names the figure, the list never does.
  const cover = COVER_LIST_RE.exec(label);
  if (cover && cover.index > 0 && BUDGET_NAME_RE.test(label.slice(0, cover.index))) label = label.slice(0, cover.index).trim();
  const output = OUTPUT_LIKE_PHRASES.find((p) => hasPhrase(label, p));
  if (output) return { kind: "ignored", reason: `"${rawLabel.trim()}" is an output figure, which is never taken as an input` };
  if (t.value === null) return { kind: "ignored", reason: t.refusal ?? "The number could not be read without guessing" };
  if (COMBINED_RESERVE_RE.test(foldText(rawLabel).replace(/\s+/g, " "))) return { kind: "ignored", reason: "A combined figure; the interest reserve is not stated alone" };
  const lender = lenderFigure(rawLabel, t, opts);
  if (lender) return { kind: "ignored", reason: lender };
  // Unless the figure's own clause names the preferred return ("a preferred return of 8% to the investors").
  const prefLead = () => FIELD_BY_KEY.get("preferred_return_pct")!.aliases.some((a) => hasPhrase(normalizeLabel(rawLabel.split(/[,;]/).pop() ?? "").label, a));
  if (t.unit === "%" && SHARE_TO_RE.test(foldText(opts.after ?? "")) && !prefLead()) return { kind: "ignored", reason: "A share of distributions, not the preferred return" };
  // A broker's, agent's or appraiser's view of the rent, or a possible or potential one, is an opinion, not the sponsor's assumption.
  if (REVENUE_LABEL_RE.test(foldText(rawLabel)) && OPINION_RE.test(foldText(rawLabel))) return { kind: "ignored", reason: OPINION_NOTE };
  // A rent per area is yearly; a monthly one is refused. A yearly rent with no per-unit word is a total.
  if (RENT_WORD_RE.test(label) && (t.currency || t.unit === "$" || t.unit === "$/sf" || t.unit === "$/m2")) {
    const area = t.unit === "$/sf" || t.unit === "$/m2" || PER_AREA_RE.test(label);
    if (area && (MONTHLY_RE.test(label) || /^\s*(\/\s?(mo|month|mois)\b|per month|par mois|monthly|mensuel)/i.test(opts.after ?? ""))) return { kind: "ignored", reason: MONTHLY_AREA_NOTE };
    if (!area && ANNUAL_RE.test(`${label} ${foldText(t.raw)}`) && !MONTHLY_RE.test(`${label} ${foldText(t.raw)}`) && !PER_UNIT_RE.test(label)) return { kind: "ignored", reason: ANNUAL_TOTAL_NOTE };
  }
  const where = prose && opts.context ? normalizeLabel(opts.context).label : label;
  const scope: Scope = scopeIn(label) ?? opts.scope ?? "senior";
  const scoped = (key: string): FieldDef => FIELD_BY_KEY.get(scope === "senior" ? key : (SCOPE_FIELD[scope][key] ?? key))!;
  const asField = (def: FieldDef): Mapped | null => {
    const c = compatibleValue(def, t, label, labelUnit, labelCode, prose);
    return c && { kind: "field", fieldKey: def.key, itemKey: null, value: c.value, unitSeen: c.unitSeen };
  };

  // A percentage "of the lender's valuation" is a loan-to-value, the refinance loan's when that is the loan in scope; the valuation itself is not an input.
  if (t.unit === "%" && LTV_BASIS_AFTER_RE.test(foldText(opts.after ?? ""))) {
    if (scope === "refinance") return asField(FIELD_BY_KEY.get("refinance_ltv_pct")!) ?? { kind: "unmapped" };
    return { kind: "ignored", reason: `A loan-to-value on the lender's valuation, but the ${scope === "mezzanine" ? "mezzanine" : "senior"} loan has no loan-to-value field; the figure is not an input` };
  }
  // "Interest" is the rate only as the whole label of a label/value line: "promoted interest of 20%" is not.
  if (!prose && /^(interest|interet)$/.test(label)) {
    const m = asField(scoped("senior_rate_pct"));
    if (m) return m;
  }
  // A builder's quote: its Total (or contract price), revision words aside, is the hard cost.
  if (opts.quote && QUOTE_TOTAL_RE.test(label.replace(REVISION_WORDS_RE, " ").replace(/\s+/g, " ").trim())) {
    const m = asField(FIELD_BY_KEY.get("hard_cost")!);
    if (m?.kind === "field") return { ...m, quote: true };
  }
  // A label that is only a loan's name: money is that loan's amount, a percentage its rate, and a duration its interest-only period or amortization.
  const named = loanNameOnly(rawLabel);
  // Not when words come between the label and its figure ("Take-out: a credit union at 4.4%"): that line is a sentence.
  if (named && foldText(opts.gap ?? "").replace(LOAN_FILLER, " ").replace(/[^a-z0-9]+/g, " ").trim() === "") {
    const own = (key: string) => FIELD_BY_KEY.get(named === "senior" ? key : SCOPE_FIELD[named][key] ?? key)!;
    const after = foldText(opts.after ?? "");
    const field =
      t.unit === "$" || t.currency || (!prose && t.unit === null && Math.abs(t.value) >= 1000) ? own("senior_loan_amount")
      : t.unit === "%" && !BASIS_AFTER_RE.test(after) ? own("senior_rate_pct")
      : (t.unit === "months" || t.unit === "years") && IO_AFTER_RE.test(after) ? own("senior_io_months")
      : (t.unit === "months" || t.unit === "years") && AMORT_AFTER_RE.test(after) ? own("senior_amort_years")
      : null;
    const m = field && asField(field);
    if (m) return m;
  }

  if (t.unit === "months" || t.unit === "years") {
    const after = foldText((opts.after ?? "").split(/[,;.]/)[0] ?? "");
    const key = BUILD_AFTER_RE.test(after) ? "construction_months" : LEASE_AFTER_RE.test(after) ? "lease_up_months" : null;
    const m = key && asField(FIELD_BY_KEY.get(key)!);
    if (m) return m;
  }
  // A vacancy percentage states the stabilized occupancy as its complement; one tied to lease-up, opening or today is not the stabilized figure.
  if (VACANCY_RE.test(label) && (t.unit === "%" || (t.unit === null && labelUnit === "%")) && t.value >= 0 && t.value <= 100) {
    const clause = `${label} ${normalizeLabel((opts.after ?? "").split(/[,;.]/)[0] ?? "").label}`;
    if (MARKET_RE.test(clause)) return { kind: "ignored", reason: MARKET_NOTE };
    if (NOT_STABILIZED_RE.test(clause)) return { kind: "ignored", reason: "A vacancy during lease-up, at opening or today is not the stabilized occupancy" };
    return { kind: "field", fieldKey: "stabilized_occupancy_pct", itemKey: null, value: Number((100 - t.value).toFixed(10)), unitSeen: "% vacancy" };
  }

  // A cap rate is the exit rate only when the sentence is about a sale; alone it may be the going-in rate.
  if ((CAP_RE.test(label) || (t.unit === "%" && CAP_AFTER_RE.test(foldText(opts.after ?? "")))) && !FIELD_BY_KEY.get("exit_cap_rate_pct")!.aliases.some((a) => hasPhrase(label, a))) {
    const ctx = normalizeLabel(opts.context ?? rawLabel).label;
    // A sale that already happened ("the duplex next door sold at a 4.9% cap") is a comparable, not this deal's exit.
    if (/\b(?:sold|traded|vendue?s?)\b/.test(foldText(rawLabel.split(/[.;]/).pop() ?? ""))) return { kind: "ignored", reason: "A completed sale's cap rate, not this deal's exit" };
    if (EXIT_RE.test(ctx) && VALUE_RE.test(ctx)) return { kind: "ignored", reason: "This sentence names a value as well as a cap rate; the figure is not taken as an input" };
    if (EXIT_RE.test(ctx)) return asField(FIELD_BY_KEY.get("exit_cap_rate_pct")!) ?? { kind: "unmapped" };
    return { kind: "ignored", reason: "A cap rate with no word about a sale or an exit may be the going-in rate; enter it by hand if it is the exit rate" };
  }
  // The month a loan is repaid or refinanced ("repaid at month 26"), whichever loan the section is about.
  const ordinalMonth = t.unit === "months" && (/^\d+$/.test(t.raw) || /^\d+(e|er|eme)\s+mois/i.test(t.raw));
  if (ordinalMonth && REPAY_RE.test(label)) return asField(FIELD_BY_KEY.get("refinance_month")!) ?? { kind: "unmapped" };
  if (scope !== "senior") {
    // Under the mezzanine or refinance loan: a loan-to-value, a bare amount or the month the loan funds are the scope's own.
    if (LTV_RE.test(label)) {
      if (scope === "refinance") return asField(FIELD_BY_KEY.get("refinance_ltv_pct")!) ?? { kind: "unmapped" };
      return { kind: "ignored", reason: "The mezzanine loan has no loan-to-value field; the figure is not given to the senior loan" };
    }
    if (BARE_AMOUNT_RE.test(label)) return asField(scoped("senior_loan_amount")) ?? { kind: "unmapped" };
    if (scope === "refinance" && ordinalMonth && FUNDING_RE.test(label)) return asField(FIELD_BY_KEY.get("refinance_month")!) ?? { kind: "unmapped" };
  }

  // Scalars: longest alias found anywhere in the label, among compatible fields (in prose: the alias ending nearest the number).
  type Hit = { def: FieldDef; alias: string; at: [number, number]; c: { value: number; unitSeen: string } | null };
  const hits: Hit[] = [];
  for (const def of FIELDS) {
    if (def.itemized || !def.extractable) continue;
    for (const alias of def.aliases) {
      const at = phraseAt(label, alias);
      if (!at || (prose && REFERENCE_RE.test(label.slice(0, at[0])))) continue;
      if (BUDGET_ONLY.has(alias) && !opts.budget) continue;
      if (EXPENSE_SHARE_ALIASES.has(alias) && VARIABLE_RE.test(label)) continue;
      if (LP_ALIASES.has(alias) && !LP_LEAD_RE.test(label.slice(0, at[0]))) continue;
      if (EGI_BASE_ALIASES.has(alias) && !(t.unit === "%" && EGI_AFTER_RE.test(foldText(opts.after ?? "")))) continue;
      let c = compatibleValue(def, t, label, labelUnit, labelCode, prose);
      if (c && WEAK_MONEY.has(alias) && !((t.currency || t.unit === "$" || t.unit === "$/mo" || labelUnit === "$") && c.value >= 1000)) c = null;
      hits.push({ def, alias, at, c });
    }
  }
  // A field named inside another field's label: the one at the head, before "above"/"over"/..., names the figure; the one after only qualifies it.
  const connector = HEAD_CONNECTOR_RE.exec(label);
  if (connector && hits.some((h) => h.c && h.at[1] <= connector.index)) {
    for (let i = hits.length - 1; i >= 0; i--) if (hits[i]!.at[0] >= connector.index + connector[0].length) hits.splice(i, 1);
  }
  // A loose alias gives way to any other alias in the label that reads the figure ("Imprévus de construction" is the contingency).
  const specific = hits.some((h) => !LOOSE_ALIASES.has(h.alias) && h.c);
  const blocked = NOT_A_LOAN_RATE.test(label) || LTV_RE.test(label);
  let best: { def: FieldDef; alias: string; end: number; value: number; unitSeen: string } | null = null;
  let aliasOnly: { def: FieldDef; alias: string } | null = null;
  for (const { def, alias, at, c } of hits) {
    if (LOOSE_ALIASES.has(alias) && (blocked || specific || !standsLast(label, at))) continue;
    if (!c) {
      if (!aliasOnly || alias.length > aliasOnly.alias.length) aliasOnly = { def, alias };
      continue;
    }
    if (best && (prose ? at[1] < best.end || (at[1] === best.end && alias.length <= best.alias.length) : alias.length <= best.alias.length)) continue;
    best = { def, alias, end: at[1], ...c };
  }
  // A label naming a partner's return never maps to a loan field.
  const partner = label.replace(LENDER_PREF_RE, " ");
  if (t.unit === "%" && best && best.def.group === "senior" && PARTNER_RE.test(partner)) {
    return PARTNER_PREF_RE.test(partner) && !PREF_EQUITY_RE.test(partner) ? asField(FIELD_BY_KEY.get("preferred_return_pct")!) ?? { kind: "unmapped" } : { kind: "ignored", reason: "A partner's return, not a loan's rate" };
  }
  // A generic senior-loan label under another loan's scope is that loan's; a term it has no field for is shown, not given to the senior loan.
  if (best && best.def.group === "senior" && scope !== "senior") {
    const own = SCOPE_FIELD[scope][best.def.key];
    if (!own) return { kind: "ignored", reason: `This is a senior-loan term, but the section is about the ${scope === "mezzanine" ? "mezzanine" : "refinance"} loan, which has no such field; it is not given to the senior loan` };
    const def = FIELD_BY_KEY.get(own)!;
    best = { ...best, def };
  }
  // Itemized: an alias at the end of the label, with a component name before it.
  let item: { def: FieldDef; alias: string; itemKey: string; value: number; unitSeen: string } | null = null;
  for (const def of FIELDS) {
    if (!def.itemized) continue;
    for (const alias of ITEMIZED_ALIASES[def.key] ?? []) {
      const prefix = endsWithPhrase(label, alias);
      if (prefix === null) continue;
      const name = itemName(prefix);
      const c = compatibleValue(def, t, label, labelUnit, labelCode, prose);
      if (!c) continue;
      if (!item || alias.length > item.alias.length || (name && !item.itemKey)) {
        item = { def, alias, itemKey: name, ...c };
      }
    }
  }
  // A rent per unit written in plain words names no alias but is the rent; a type in the label names the item.
  if (!item && isPlainRentLabel(rawLabel)) {
    const def = FIELD_BY_KEY.get("unit_rent_monthly")!;
    const c = compatibleValue(def, t, label, labelUnit, labelCode, prose);
    const types = unitTypesIn(label);
    if (c) item = { def, alias: label, itemKey: types.length === 1 ? types[0]! : "", ...c };
  }
  // An occupancy that is a lender's condition, or true only today, is not the stabilized assumption.
  const notAssumed = (key: string): Mapped | null => {
    if (key === "gp_promote_pct" && LATER_TIER_RE.test(foldText(rawLabel))) return { kind: "ignored", reason: "A later promote tier; the field holds the first tier only" };
    if (key !== "stabilized_occupancy_pct" && key !== "item_occupancy_pct") return null;
    // In prose only the clause the figure stands in counts, not a condition elsewhere in the sentence.
    const lead = foldText(rawLabel.split(/[,;]/).pop() ?? "").trim();
    const clauseText = prose && opts.context && lead ? (foldText(opts.context).split(/[,;]/).find((c) => c.includes(lead)) ?? where) : where;
    if (MARKET_RE.test(`${where} ${normalizeLabel((opts.after ?? "").split(/[,;.]/)[0] ?? "").label}`)) return { kind: "ignored", reason: MARKET_NOTE };
    if (CONDITION_RE.test(normalizeLabel(clauseText).label)) return { kind: "ignored", reason: LENDER_CONDITION };
    return CURRENT_RE.test(where) && !STABILIZED_RE.test(label) ? { kind: "ignored", reason: "A current occupancy is not the stabilized assumption" } : null;
  };
  // A unit type in parentheses ("End units (3 bed)") names the item.
  const typed = parenType(rawLabel);
  if (item && item.itemKey && (!best || item.alias.length >= best.alias.length)) {
    return notAssumed(item.def.key) ?? { kind: "field", fieldKey: item.def.key, itemKey: typed ?? item.itemKey, value: item.value, unitSeen: item.unitSeen };
  }
  if (best) return notAssumed(best.def.key) ?? { kind: "field", fieldKey: best.def.key, itemKey: null, value: best.value, unitSeen: best.unitSeen };
  if (item) {
    return notAssumed(item.def.key) ?? { kind: "field", fieldKey: item.def.key, itemKey: "All units", value: item.value, unitSeen: item.unitSeen };
  }
  // A component named by itself with a self-describing unit: "Retail: 9,000 SF".
  const name = itemName(label);
  // In prose the words before a number are a clause ("Pinegate, 12 suites"), not a name.
  // A heading word ("Summary", "Total", "Type") names no item.
  if (name && label.split(" ").length <= 3 && !prose && !aliasOnly && !HEADING_NAME_RE.test(label)) {
    const byUnit: Record<string, string> = {
      units: "unit_count",
      sf: "rentable_area_sf",
      m2: "rentable_area_sf",
      "$/mo": "unit_rent_monthly",
      "$/sf": "rent_psf_annual",
      "$/m2": "rent_psf_annual",
    };
    // A label names an item for an area or a rent only when it holds a unit type; a count may be named by any short label.
    const key = t.unit && (t.unit === "units" || unitTypesIn(rawLabel).length > 0) ? byUnit[t.unit] : undefined;
    const c = key ? compatibleValue(FIELD_BY_KEY.get(key)!, t, label, labelUnit, labelCode, prose) : null;
    if (key && c) return { kind: "field", fieldKey: key, itemKey: typed ?? name, value: c.value, unitSeen: c.unitSeen };
  }
  if (aliasOnly) {
    const want: Record<string, string> = {
      "%": "a % sign",
      "$": "a dollar amount",
      months: "months",
      years: "years",
      x: "an x multiple",
      sf: "square feet or square metres",
      units: "a unit count",
    };
    return {
      kind: "ignored",
      reason: `Looks like ${aliasOnly.def.label.toLowerCase()}, but the number is not written as ${want[aliasOnly.def.unit] ?? aliasOnly.def.unit}. Enter it by hand if it is.`,
    };
  }
  return { kind: "unmapped" };
}


// ---- Budget lines written as sentences with verbs ---------------------------------------------------
// A verb gives a field only together with its object noun: "pay ... to buy the lot", "the contractor will do the work for", "set aside ... for other costs".
const OTHER_PROJECT_RE = /\b(?:another|other|previous|prior|last|earlier|comparable|similar)\s+(?:project|job|building|property|development|contract|site|deal)s?\b(?!\s+(?:costs?|expenses?|couts?|frais))|\bautres?\s+(?:projets?|immeubles?|proprietes?)\b/;
// A deposit, a down payment or an amount already paid: not a budget line. Text is folded (lower case, no accents).
export const DEPOSIT_RE = /\b(?:deposits?|down payments?|acomptes?|depots?|already (?:paid|put down|deposited)|put down|paid down|paid\b[^.;]*\balready|deja (?:paye|verse)e?s?)\b/;
const LAND_RE = /\b(?:pay|pays|paying|paid|purchase\w*|acquir\w*|buy\w*|bought|paie\w*|payer|payons|acquer\w*|achet\w+|acquis\w*)\b.*?\b(?:(?:the|our|this|that|a|le|la|l|notre|ce|cet|cette|un|une)\s+)(?:[a-z]+\s+){0,2}(?:lot|land|site|building|property|terrain|immeuble|propriete|batiment)\b(?:\s+(?:at|on|in|from|du|de|au|a|sur)\s+(?:[a-z0-9]+\s+){0,4}?)?(?:\s+(?:for|pour))?\s*(?:#|$)/;
const WHO_HARD = /\b(?:contractor|builder|gc|general contractor|entrepreneur(?: general)?|constructeur)\b/;
const VERB_HARD = /\b(?:do|does|doing|carry out|carries out|build|builds|execute|executes|perform|performs|deliver|delivers|realis\w+|realiz\w+|execut\w+|effectu\w+)\b/;
const NOUN_HARD = /\b(?:work|works|construction|conversion|renovations?|travaux)\b/;
const WHO_SOFT = /\b(?:design team|designers?|advis[eo]rs?|consultants?|professionals?|architects?|engineers?|conseillers?|professionnels?|architectes?|ingenieurs?)\b/;
const SERVICES_AFTER = /^(?:for|pour)\s+(?:(?:its|their|his|her|our|the|ses|leurs?|des|les)\s+)?(?:professional\s+)?(?:services?|fees?|honoraires)\b/;
const HOLD_VERB = /\b(?:hold back|holds back|keep|keeps|retain|retains|set aside|sets aside|put aside|reserve|reserves|earmark\w*|garder|gardons|conserver|reserver|reservons|retenir|retenons|met de cote|mettons de cote|mettre de cote|prevoit|prevoyons|prevoir)\b/;
const CONTINGENCY_AFTER = /^(?:for|pour)\s+(?:the\s+|les?\s+|la\s+)?(?:contingenc\w+|unforeseen|imprevus?|inattendus?)\b/;
const OTHER_AFTER = /^(?:for|pour)\s+(?:the\s+|les\s+|des\s+)?(?:other|miscellaneous|autres?|divers)\s+(?:(?:project|development|du projet|de projet)\s+)?(?:costs?|expenses?|couts?|frais)\b/;
const FIXED_AFTER = /^(?:for|pour)\s+(?:the\s+|its\s+|our\s+|les\s+|ses\s+)?(?:fixed\s+(?:operating\s+)?(?:costs?|expenses?|operations?|opex)|(?:charges|frais|couts|depenses)\s+fixes)\b/;
const YEARLY_RE = /(?:a year|annually|per year|par an|par annee|annuellement|\/\s?(?:yr|year|an))\s*$/i;

/**
 * A money figure in a sentence with a verb ("We will pay $910,000 to buy the lot", "The design team needs $380,000 for its services"),
 * read when its own clause holds the verb and the noun the field is named by; a verb alone, another project and a deposit read nothing.
 * `before`: the words since the previous figure; `after`: the words up to the next one.
 */
export function costSentence(sentence: string, before: string, after: string, t: NumberToken): Mapped | null {
  if (t.value === null || t.value <= 0 || !(t.unit === "$" || t.currency)) return null;
  const f = (x: string) => foldText(x).replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const clause = (x: string, last: boolean) => {
    const parts = x.split(/[,;]|\band\b|\bet\b/i);
    return parts[last ? parts.length - 1 : 0] ?? "";
  };
  const b = f(clause(before, true));
  const a = f(clause(after, false));
  const whole = f(sentence);
  if (OTHER_PROJECT_RE.test(whole) || DEPOSIT_RE.test(whole)) return null;
  const holds = HOLD_VERB.test(b);
  const label =
    LAND_RE.test(`${b} # ${a}`) ? "land cost"
    : WHO_HARD.test(b) && VERB_HARD.test(b) && NOUN_HARD.test(b) && /\b(?:for|pour|at)(?: (?:a|un) (?:total|prix|montant)(?: of| de)?)?$/.test(b) ? "hard costs"
    : WHO_SOFT.test(b) && SERVICES_AFTER.test(a) ? "soft costs"
    : holds && CONTINGENCY_AFTER.test(a) ? "contingency"
    : (holds || /\b(?:provide|provides|allow|allows|include|includes)\b/.test(b)) && OTHER_AFTER.test(a) ? "other costs"
    : FIXED_AFTER.test(a) && YEARLY_RE.test(t.raw) ? "fixed operating costs"
    : null;
  if (!label) return null;
  const m = mapToken(label, t, { prose: true });
  return m.kind === "field" ? m : null;
}

// ---- Flags stated in a sentence ------------------------------------------------------------------
const FLAG_NEGATION_RE = /\b(?:not|never|neither|nor|if|unless|may|might|could|should|whether|pas|jamais|si|sauf)\b|\bn t\b|\?/;
const FLAG_RULES: { fieldKey: string; value: 0 | 1; re: RegExp; negatable?: true }[] = [
  { fieldKey: "lease_up_ramp", value: 1, re: /\b(?:rents?|income|revenues?)\s+(?:is|are|will be)\s+(?:credited|counted|recognized|recognised|included|earned)\s+(?:during|throughout|while|in)\s+(?:the\s+)?(?:lease[- ]?up|leasing)\b/ },
  { fieldKey: "lease_up_ramp", value: 1, re: /\bwe\s+(?:count|credit|include|recognize|recognise)\s+(?:rental\s+)?(?:income|rents?|revenues?)\s+(?:during|while|throughout)\s+(?:the\s+)?(?:lease[- ]?up|leasing)\b/ },
  { fieldKey: "lease_up_ramp", value: 1, re: /\b(?:loyers|revenus)\s+(?:sont|seront)\s+(?:comptes|comptabilises|credites)\s+pendant\s+(?:la\s+)?(?:mise en location|periode de location|location)\b/ },
  { fieldKey: "lease_up_ramp", value: 0, re: /^no\s+(?:rental\s+)?(?:income|rents?|revenues?)\s+(?:until|before|prior to)\s+(?:the\s+)?(?:stabili[sz]ation|stabili[sz]ed)\s*$/, negatable: true },
  { fieldKey: "lease_up_ramp", value: 0, re: /^(?:aucun|pas de)\s+(?:revenus?|loyers?)\s+avant\s+(?:la\s+)?stabilisation\s*$/, negatable: true },
  { fieldKey: "s_curve_draws", value: 1, re: /\b(?:construction\s+)?(?:draws?|drawdowns?)\s+(?:will\s+)?follows?\s+(?:an?\s+)?s[- ]?curve\b/ },
  { fieldKey: "s_curve_draws", value: 1, re: /^(?:les\s+)?tirages(?:\s+de\s+construction)?\s+(?:en|suivent\s+une)\s+courbe\s+en\s+s\s*$/ },
  { fieldKey: "s_curve_draws", value: 0, re: /^(?:construction\s+)?(?:draws?\s+(?:are|will be)\s+)?straight[- ]line(?:\s+(?:construction\s+)?draws?)?\s*$/ },
  { fieldKey: "s_curve_draws", value: 0, re: /^(?:les\s+)?tirages(?:\s+de\s+construction)?\s+(?:sont|seront)\s+lineaires\s*$/ },
];

/**
 * A flag a whole sentence states outright: "Rent is credited during lease-up", "No income until stabilization", "Draws follow an S-curve",
 * "Straight-line draws". A hedge, a negation or a question reads no flag, and nothing is inferred from a passing mention.
 */
export function flagSentence(sentence: string): { fieldKey: string; value: 0 | 1; raw: string } | null {
  const f = foldText(sentence).replace(/[^a-z0-9\s?-]/g, " ").replace(/\s+/g, " ").trim();
  for (const r of FLAG_RULES) {
    const m = r.re.exec(f);
    if (m && (r.negatable || !FLAG_NEGATION_RE.test(f))) return { fieldKey: r.fieldKey, value: r.value, raw: sentence.trim().slice(0, 120) };
  }
  return null;
}
