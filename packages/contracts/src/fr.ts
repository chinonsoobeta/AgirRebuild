// Shared display text and number formats, moved from the web without changing wording.
type Lang = "en" | "fr";
const s = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const FR_FIELDS: Record<string, string> = {
  sell_units: "Vendre les logements (sans location)", unit_sale_price: "Prix de vente par logement", presold_units_pct: "Logements prévendus",
  deposit_pct: "Dépôt de l'acheteur", absorption_units_per_month: "Rythme de vente (logements par mois)", sales_commission_pct: "Commission de vente",
  closing_lag_months: "Mois entre l'achèvement et la première conclusion de vente", unsold_carry_monthly: "Frais de possession par logement non vendu par mois",
  senior_presale_threshold_pct: "Seuil de préventes du prêteur",
  land_cost: "Coût du terrain", hard_cost: "Coûts directs", soft_cost: "Coûts indirects", contingency: "Provision pour imprévus", other_cost: "Autres coûts",
  unit_count: "Logements", unit_rent_monthly: "Loyer par logement par mois", rentable_area_sf: "Superficie locative", rent_psf_annual: "Loyer par pi² par an",
  item_occupancy_pct: "Occupation de la composante", construction_months: "Durée de construction", lease_up_months: "Période de location",
  hold_years: "Période de détention", stabilized_occupancy_pct: "Occupation stabilisée", expense_ratio_pct: "Ratio des charges d'exploitation",
  fixed_opex_annual: "Charges d'exploitation fixes", variable_expense_pct: "Charges variables (part du RBE)", other_income_annual: "Autres revenus",
  rent_growth_pct: "Croissance des loyers", expense_growth_pct: "Croissance des charges", lease_up_ramp: "Revenus pendant la période de location",
  s_curve_draws: "Tirages de construction en courbe en S", exit_cap_rate_pct: "Taux de capitalisation à la sortie", selling_costs_pct: "Frais de vente",
  senior_loan_amount: "Montant du prêt principal", senior_rate_pct: "Taux du prêt principal", senior_amort_years: "Amortissement du prêt principal",
  senior_io_months: "Période d'intérêts seulement (prêt principal)", min_dscr_covenant: "Clause de RCSD minimal", mezz_loan_amount: "Montant du prêt mezzanine",
  mezz_rate_pct: "Taux du prêt mezzanine", mezz_amort_years: "Amortissement du prêt mezzanine", mezz_io_months: "Période d'intérêts seulement (mezzanine)",
  equity_amount: "Fonds propres déclarés", refinance_month: "Mois du refinancement", refinance_amount: "Montant du refinancement",
  refinance_ltv_pct: "Ratio prêt-valeur du refinancement", refinance_rate_pct: "Taux du refinancement", refinance_amort_years: "Amortissement du refinancement",
  refinance_and_hold: "Conserver et refinancer (sans vente)", refinance_io_months: "Période d'intérêts seulement (refinancement)", lp_share_pct: "Part des commanditaires", preferred_return_pct: "Rendement privilégié",
  gp_promote_pct: "Intéressement du commandité au-delà du rendement privilégié", stated_total_cost: "Coût total déclaré du projet",
  stated_ltc_pct: "Ratio prêt-coût déclaré", stated_interest_reserve: "Réserve d'intérêts déclarée",
  development_charges: "Redevances de développement", land_transfer_tax: "Droits de mutation immobilière", gst_hst_net: "TPS/TVH nette des remboursements",
  refinance_mli_select_points: "Points MLI Select", refinance_term_years: "Durée du prêt de refinancement",
  refinance_premium_tax_pct: "Taxe provinciale sur la prime d'assurance hypothécaire",
  property_tax_annual: "Taxe foncière (par année)", refinance_insurance_premium_pct: "Prime d'assurance hypothécaire du refinancement",
};

export const FR_METRICS: Record<string, [string, string]> = {
  gross_sales_revenue: ["Revenu brut des ventes", "logements × prix de vente, pour chaque type de logement"],
  net_sales_revenue: ["Revenu net des ventes", "revenu brut des ventes − commission de vente"],
  interest_before_completion: ["Intérêts pendant la construction", "intérêts sur les prêts avant l'achèvement, peu importe qui les paie"],
  interest_after_completion: ["Intérêts après l'achèvement", "intérêts ajoutés aux prêts de l'achèvement jusqu'à leur remboursement"],
  carry_total: ["Frais de possession des logements non vendus", "frais par logement par mois × logements achevés dont la vente n'est pas encore conclue"],
  development_profit_for_sale: ["Profit de développement (logements vendus)", "revenu net des ventes − coût total de développement − frais de possession − intérêts après l'achèvement"],
  profit_on_cost_for_sale: ["Profit sur coût (logements vendus)", "profit de développement / (coût total de développement + frais de possession + intérêts après l'achèvement)"],
  margin_on_revenue: ["Marge sur le revenu des ventes", "profit de développement / revenu net des ventes"],
  equity_contributed: ["Fonds propres apportés", "chaque apport de fonds propres, frais de possession compris"],
  equity_distributed: ["Fonds propres récupérés", "produit des ventes restant après le remboursement des prêts"],
  completion_month: ["Achèvement (mois)", "la durée de construction"],
  sellout_month: ["Dernière conclusion de vente (mois)", "le mois où la vente du dernier logement est conclue"],
  sellout_years: ["Durée pour tout vendre", "(mois de la dernière conclusion de vente + 1) / 12"],
  deposits_held_at_completion: ["Dépôts des acheteurs en fiducie à l'achèvement", "logements prévendus × prix moyen × pourcentage de dépôt ; en fiducie, jamais utilisés pour les coûts"],
  senior_balance_at_completion: ["Solde du prêt principal à l'achèvement", "dette principale tirée et ses intérêts à l'achèvement"],
  mezz_balance_at_completion: ["Solde de la mezzanine à l'achèvement", "dette mezzanine tirée et ses intérêts à l'achèvement"],
  total_development_cost: ["Coût total de développement", "terrain + coûts directs + coûts indirects + imprévus + autres coûts + intérêts capitalisés"],
  capitalized_interest: ["Intérêts capitalisés", "intérêts courus sur la dette tirée avant la stabilisation"],
  hard_and_soft_cost: ["Coûts avant financement", "terrain + coûts directs + coûts indirects + imprévus + autres coûts"],
  gross_potential_rent: ["Loyer brut potentiel (année 1)", "somme des loyers des composantes sur la première année stabilisée"],
  effective_gross_income: ["Revenu brut effectif (année 1)", "loyers x occupation + autres revenus, première année stabilisée"],
  operating_expenses: ["Charges d'exploitation (année 1)", "part fixe + part variable du RBE, première année stabilisée"],
  stabilized_noi: ["RNE stabilisé", "RBE - charges d'exploitation, première année stabilisée"],
  yield_on_cost: ["Rendement sur coût", "RNE stabilisé / coût total de développement"],
  development_spread: ["Écart de développement", "(rendement sur coût - taux de sortie) x 100"],
  exit_value: ["Valeur de sortie", "RNE de la dernière année de détention / taux de sortie"],
  net_sale_proceeds: ["Produit net de la vente", "valeur de sortie x (1 - frais de vente)"],
  development_profit: ["Profit de développement", "produit net de la vente - coût total de développement"],
  profit_on_cost: ["Profit sur coût", "profit de développement / coût total de développement"],
  total_debt: ["Dette totale à la stabilisation", "soldes du prêt principal et mezzanine, intérêts capitalisés compris"],
  leaseup_operating_cost: ["Coûts d'exploitation pendant la location initiale", "coûts d'exploitation fixes, aux niveaux de l'année 1, pour chaque mois de location initiale, imputés au coût total de développement lorsque les revenus de la location initiale ne sont pas comptés"],
  io_dscr_year1: ["RCSD à intérêts seulement (année 1)", "RNE de l'année 1 / service de la dette à intérêts seulement sur les soldes du prêt principal et mezzanine à la stabilisation"],
  cumulative_cash_shortfall: ["Déficit de trésorerie cumulé après la stabilisation", "somme, sur la période de détention, des flux mensuels négatifs après le service de la dette, en montant positif"],
  mezz_interest_accrued: ["Intérêts de la mezzanine courus au-delà de l'engagement", "intérêts de la mezzanine avant la stabilisation, au-delà de son engagement, ajoutés au solde de la mezzanine"],
  loan_to_cost: ["Ratio prêt-coût", "engagements de dette / coût total de développement"],
  required_equity: ["Fonds propres requis", "coût total de développement - engagements de dette"],
  debt_yield: ["Rendement de la dette", "RNE stabilisé / dette totale à la stabilisation"],
  sizing_dscr: ["RCSD de dimensionnement (pire année)", "minimum, sur les années de détention, du RNE / service de la dette amorti en vigueur"],
  sizing_dscr_year1: ["RCSD de dimensionnement (année 1)", "RNE de l'année 1 / service de la dette amorti en vigueur"],
  contractual_dscr: ["RCSD contractuel (pire année)", "minimum, sur les années de détention, du RNE / service de la dette réellement dû"],
  senior_dscr_year1: ["RCSD du prêt principal (année 1)", "RNE de l'année 1 / service amorti du prêt principal"],
  mezz_dscr_year1: ["RCSD global avec mezzanine (année 1)", "RNE de l'année 1 / service amorti du prêt principal et mezzanine"],
  break_even_occupancy: ["Occupation au seuil de rentabilité (année 1)", "(coûts fixes + service de la dette) / (loyers x (1 - part variable))"],
  cash_on_cash_year1: ["Rendement en espèces (année 1)", "flux de l'année 1 après service de la dette / fonds propres requis"],
  equity_multiple: ["Multiple des fonds propres", "total des distributions / total des apports"],
  equity_irr: ["TRI des fonds propres", "taux qui annule la VAN des flux datés des fonds propres"],
  peak_equity: ["Fonds propres maximaux engagés", "plus grand apport net cumulé"],
  refinance_net_proceeds: ["Produit net du refinancement", "nouveau prêt - remboursement du solde du prêt principal"],
  refinance_premium_added: ["Prime d'assurance hypothécaire ajoutée au prêt de refinancement", "montant du prêt de refinancement x prime en %"],
  cost_per_unit: ["Coût par logement", "coût total de développement / logements"],
  lp_irr: ["TRI des commanditaires", "TRI de la part des commanditaires après la cascade"],
  gp_irr: ["TRI du commandité", "TRI de la part du commandité après la cascade"],
  gp_promote: ["Intéressement du commandité", "distributions du commandité au-delà de sa quote-part"],
  stabilization_month: ["Mois de stabilisation", "construction + période de location"],
  sale_month: ["Mois de la vente", "stabilisation + 12 x années de détention - 1"],
  refinance_cash_returned: ["Encaisse remise au refinancement", "nouveau prêt - remboursement du solde du prêt principal ; un montant négatif signifie qu'il a fallu injecter des fonds"],
  cash_left_in_deal: ["Encaisse restée dans le projet", "fonds propres requis - encaisse remise au refinancement ; 0 ou moins signifie que tous les fonds propres ont été récupérés"],
  dcr_after_refinance: ["Couverture après refinancement (RCSD)", "RNE des 12 mois suivant le mois du refinancement / service de la dette amortissable de toute la dette en vigueur durant ces mois"],
  cash_on_cash_after_refinance: ["Rendement en espèces après refinancement", "(RNE - service de la dette réellement dû) sur les 12 mois suivant le refinancement / encaisse restée dans le projet"],
  stated_value: ["Valeur déclarée (non réalisée, pas une vente)", "RNE de la dernière année de détention / taux de sortie, sans frais de vente"],
  unrealized_equity_multiple: ["Multiple des fonds propres (non réalisé, pas une vente)", "(distributions d'exploitation + refinancement + distribution non réalisée) / apports"],
  unrealized_equity_irr: ["TRI des fonds propres (non réalisé, pas une vente)", "taux qui annule la VAN des flux datés des fonds propres, avec le flux non réalisé"],
};

export const STRESS: Record<string, [string, string]> = {
  base: ["Base case", "Scénario de base"],
  exit_cap: ["Exit cap +75 bps", "Taux de sortie +75\u00a0pb"],
  cost: ["Costs +10%", "Coûts +10\u00a0%"],
  rate: ["Interest rate +150 bps", "Taux d'intérêt +150\u00a0pb"],
  rent: ["Rent -10%", "Loyers -10\u00a0%"],
  occupancy: ["Occupancy -5 pts", "Occupation -5\u00a0pts"],
  expense: ["Operating costs +5 pts", "Charges d'exploitation +5\u00a0pts"],
  combined: ["Combined", "Combiné"],
  // Selling the units (card 77).
  prices: ["Prices -10%", "Prix -10\u00a0%"],
  absorption: ["Absorption -30%", "Rythme de vente -30\u00a0%"],
  costs: ["Costs +10%", "Coûts +10\u00a0%"],
  rates: ["Interest rates +100 bps", "Taux d'intérêt +100\u00a0pb"],
  construction: ["Construction +6 months", "Construction +6\u00a0mois"],
  presales: ["Presales -15 pts", "Préventes -15\u00a0pts"],
};

export const GATES: Record<string, [string, string]> = {
  equity_multiple: ["Equity multiple", "Multiple des fonds propres"],
  profit_on_cost: ["Profit on cost", "Profit sur coût"],
  development_spread: ["Development spread", "Écart de développement"],
  stressed_sizing_dscr: ["Sizing DSCR, combined stress", "RCSD de dimensionnement, stress combiné"],
  stressed_equity_multiple: ["Equity multiple, combined stress", "Multiple des fonds propres, stress combiné"],
  dcr_after_refinance: ["Coverage after refinance (DCR)", "Couverture après refinancement (RCSD)"],
  stressed_unrealized_equity_multiple: ["Equity multiple (unrealized, not a sale), combined stress", "Multiple des fonds propres (non réalisé, pas une vente), stress combiné"],
  profit_on_cost_for_sale: ["Profit on cost, units sold", "Profit sur coût, logements vendus"],
  margin_on_revenue: ["Margin on sales revenue", "Marge sur le revenu des ventes"],
  stressed_profit_on_cost_for_sale: ["Profit on cost, units sold, combined stress", "Profit sur coût, logements vendus, stress combiné"],
};

export const plainTerm = (lang: Lang, text: string) => (lang === "fr" ? text.replace(/\bRCSD\b/g, "CCD") : text.replace(/\bDSCR\b/g, "DCR"));

/**
 * A sale's stress names in plain words (card F2): how much slower the sales pace is, the rate move and presales in points.
 * Display only: the policy's labels, stored with every run and in its hash, stay as they are. Keyed on the sale's own
 * stress keys, so a rental stress ("rate", "Interest rate +150 bps") is never touched.
 */
export function plainStress(lang: Lang, key: string, label: string): string {
  const fr = lang === "fr";
  const num = (text: string) => Number(text.replace(",", "."));
  const dec = (value: number) => String(value).replace(".", fr ? "," : ".");
  const size = /([+-]\d+(?:[.,]\d+)?)[  ]?/.source;
  if (key === "absorption") return label.replace(new RegExp(`^(?:Absorption|Rythme de vente) ${size}%`), (_, v: string) => {
    const pct = num(v);
    return `${fr ? "Rythme de vente" : "Sales pace"} ${dec(Math.abs(pct))}${fr ? "\u00a0" : ""}% ${pct < 0 ? (fr ? "plus lent" : "slower") : (fr ? "plus rapide" : "faster")}`;
  });
  if (key === "rates") return label.replace(new RegExp(`${size}(?:bps|pb)$`), (_, v: string) => {
    const points = num(v) / 100;
    // French keeps "point" in the singular below 2.
    return `${points > 0 ? "+" : ""}${dec(points)}${fr ? " " : " "}${Math.abs(points) === 1 || (fr && Math.abs(points) < 2) ? "point" : "points"}`;
  });
  if (key === "presales") return label.replace(/[  ]pts$/, fr ? " points" : " points");
  return label;
}

export function numberFormat(lang: Lang) {
  const loc = lang === "fr" ? "fr-CA" : "en-US";
  const n0 = new Intl.NumberFormat(loc, { maximumFractionDigits: 0 });
  const n2 = new Intl.NumberFormat(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nMax2 = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  const fr = lang === "fr";
  const nm = fr ? "Non significatif" : "Not meaningful";
  const money = (v: number) => (fr ? `${v < 0 ? "-" : ""}${n0.format(Math.abs(Math.round(v)))} $` : `${v < 0 ? "-" : ""}$${n0.format(Math.abs(Math.round(v)))}`);
  // French puts a space before units and currency; it must not break, so "51 962 556 $" stays on one line.
  const keep = (text: string) => (fr ? text.replace(/ /g, "\u00a0") : text);
  const value = (v: number | null | undefined, unit: string): string => (v === null || v === undefined || !Number.isFinite(v) ? nm : keep(plain(v, unit)));
  const plain = (v: number, unit: string): string => {
    switch (unit) {
      case "$": return money(v);
      case "%": return fr ? `${n2.format(v)} %` : `${n2.format(v)}%`;
      case "x": return `${n2.format(v)}x`;
      case "bps": return fr ? `${n0.format(Math.round(v))} pb` : `${n0.format(Math.round(v))} bps`;
      case "months": return fr ? `${n0.format(v)} mois` : `${n0.format(v)} mo`;
      case "years": return fr ? `${nMax2.format(v)} ${v === 1 ? "an" : "ans"}` : `${nMax2.format(v)} yr`;
      case "points": case "units": case "count": return n0.format(v);
      case "sf": return fr ? `${n0.format(Math.round(v))} pi²` : `${n0.format(Math.round(v))} SF`;
      // Whole dollars stay whole; a rent with cents shows both digits ($3,095.20, not $3,095.2).
      case "$/unit/mo": case "$/mo": { const n = Number.isInteger(v) ? n0 : n2; return fr ? `${n.format(v)} $/mois` : `$${n.format(v)}/mo`; }
      case "$/sf/yr": case "$/sf": return fr ? `${n2.format(v)} $/pi²/an` : `$${n2.format(v)}/SF/yr`;
      case "flag": return v === 1 ? (fr ? "Oui" : "Yes") : fr ? "Non" : "No";
      case "pts": return fr ? `${nMax2.format(v)} pts` : `${nMax2.format(v)} pts`;
      default: return nMax2.format(v);
    }
  };
  /** A signed change, e.g. +75 bps or -10%. */
  const delta = (v: number, unit: string): string => keep(signed(v, unit));
  const signed = (v: number, unit: string): string => {
    const sign = v > 0 ? "+" : v < 0 ? "-" : "±";
    const a = Math.abs(v);
    if (unit === "%") return `${sign}${fr ? `${nMax2.format(a)} %` : `${nMax2.format(a)}%`}`;
    if (unit === "bps") return `${sign}${n0.format(a)} ${fr ? "pb" : "bps"}`;
    if (unit === "pts") return `${sign}${nMax2.format(a)} pts`;
    if (unit === "months") return `${sign}${n0.format(a)} ${fr ? "mois" : "mo"}`;
    return `${sign}${plain(a, unit)}`;
  };
  const suffix = (unit: string): string =>
    (fr
      ? { "%": "%", months: "mois", years: "ans", units: "logements", sf: "pi²", "$/unit/mo": "$/mois", "$/sf/yr": "$/pi²/an", x: "x", $: "$" }
      : { "%": "%", months: "months", years: "years", units: "units", sf: "SF", "$/unit/mo": "$/mo", "$/sf/yr": "$/SF/yr", x: "x", $: "$" })[unit] ?? "";
  const date = (iso: string) => new Date(iso).toLocaleString(fr ? "fr-CA" : "en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const bytes = (b: number) => (b < 1024 ? `${b} ${fr ? "o" : "B"}` : b < 1048576 ? `${n0.format(b / 1024)} ${fr ? "Ko" : "KB"}` : `${new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(b / 1048576)} ${fr ? "Mo" : "MB"}`);
  /** Read a number typed in this language: "5,25" in French, "1,250,000" in English. */
  const parse = (raw: FormDataEntryValue | string | null): number => {
    let t = String(raw ?? "").replace(/[\s  $%]/g, "");
    t = fr ? t.replace(/,/g, ".") : t.replace(/,/g, "");
    const n = Number(t);
    if (!t || !Number.isFinite(n)) throw new Error(fr ? "Saisissez un nombre." : "Enter a number.");
    return n;
  };
  return { value, delta, suffix, date, bytes, parse, money: (v: number) => keep(money(v)) };
}

export type VerdictLike = {
  code: string;
  hardFailReasons: string[];
  gates: { key: string; label: string; status: string }[];
};

export type CheckLike = { key: string; kind: string; severity: string; message: string; expected?: number; actual?: number };

const countWord = (n: number, total: number) => (n === 5 ? "five" : n === 4 && total === 4 ? "four" : String(n));

const frCount = (n: number, total: number) => (n === 5 ? "cinq" : n === 4 && total === 4 ? "quatre" : String(n));

export function verdictText(lang: Lang, f: ReturnType<typeof numberFormat>, gate: (key: string, en: string) => string, v: VerdictLike, checks: CheckLike[], solo = false): { headline: string; explanation: string } {
  if (lang === "en") {
    const failed = v.gates.filter((g) => g.status === "failed");
    const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
    const ne = v.gates.filter((g) => g.status === "not_evaluated");
    const errors = checks.filter((c) => c.severity === "error");
    switch (v.code) {
      case "APPROVE":
        return { headline: measured === v.gates.length ? `All ${countWord(measured, v.gates.length)} gates pass.` : `All ${measured} applicable gates pass.`, explanation: "The deal clears every return hurdle and holds its coverage under combined stress." };
      case "APPROVE_WITH_CONDITIONS":
        return { headline: `${failed.length} ${s(failed.length, "gate fails", "gates fail")}. ${solo ? "You set the conditions." : "The committee sets conditions."}`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
      case "NOT_EVALUATED":
        return { headline: "Not evaluated. Nothing was decided.", explanation: `These gates could not be measured: ${ne.map((g) => g.label).join("; ")}.` };
      default:
        if (v.hardFailReasons.length) {
          return {
            headline: errors.length === 1 ? "The deal fails a check that no gate can offset." : `The deal fails ${errors.length} checks that no gate can offset.`,
            explanation: v.hardFailReasons.join(" "),
          };
        }
        return { headline: failed.length === measured ? `All ${countWord(measured, v.gates.length)} gates fail.` : `${failed.length} of ${measured} gates fail.`, explanation: `Failing: ${failed.map((g) => g.label).join("; ")}.` };
    }
  }
  const failed = v.gates.filter((g) => g.status === "failed").map((g) => gate(g.key, g.label));
  const measured = v.gates.filter((g) => g.status !== "not_applicable").length;
  const ne = v.gates.filter((g) => g.status === "not_evaluated").map((g) => gate(g.key, g.label));
  const errors = checks.filter((c) => c.severity === "error");
  switch (v.code) {
    case "APPROVE":
      return {
        headline: measured === v.gates.length ? `Les ${frCount(measured, v.gates.length)} seuils sont respectés.` : `Les ${measured} seuils applicables sont respectés.`,
        explanation: "Le projet franchit tous les seuils de rendement et maintient sa couverture sous le stress combiné.",
      };
    case "APPROVE_WITH_CONDITIONS":
      return {
        headline: `${failed.length} ${s(failed.length, "seuil n'est pas respecté", "seuils ne sont pas respectés")}. ${solo ? "Vous fixez les conditions." : "Le comité fixe des conditions."}`,
        explanation: `Non respectés : ${failed.join(" ; ")}.`,
      };
    case "NOT_EVALUATED":
      return { headline: "Non évalué. Aucune décision n'a été prise.", explanation: `Ces seuils n'ont pas pu être mesurés : ${ne.join(" ; ")}.` };
    default:
      if (v.hardFailReasons.length) {
        return {
          headline: errors.length === 1 ? "Le projet échoue à un contrôle qu'aucun seuil ne peut compenser." : `Le projet échoue à ${errors.length} contrôles qu'aucun seuil ne peut compenser.`,
          explanation: errors.map((c) => plainTerm(lang, checkText(lang, f, gate, c))).join(" "),
        };
      }
      return {
        headline: failed.length === measured ? `Aucun des ${frCount(measured, v.gates.length)} seuils n'est respecté.` : `${failed.length} seuils sur ${measured} ne sont pas respectés.`,
        explanation: `Non respectés : ${failed.join(" ; ")}.`,
      };
  }
}

export function checkText(lang: Lang, f: ReturnType<typeof numberFormat>, gate: (key: string, en: string) => string, c: CheckLike, ltcCeiling = 85): string {
  if (lang === "en") return c.message;
  const $ = (v?: number) => f.value(v ?? NaN, "$");
  const pct = (v?: number) => f.value(v ?? NaN, "%");
  const x = (v?: number) => f.value(v ?? NaN, "x");
  const e = c.expected;
  const a = c.actual;
  switch (c.key) {
    case "insured_min_units": return `L’assurance multilogement de la SCHL exige au moins ${f.value(e,"units")} ; le projet en compte ${f.value(a,"units")}.`;
    case "refinance_ltv_limit": return `Le prêt de refinancement avant la prime dépasse le plafond prêt-valeur de ${pct(e)}.`;
    case "refinance_ltc_limit": return `Le prêt de refinancement avant la prime dépasse le plafond prêt-coût de ${pct(e)}.`;
    case "refinance_amort_limit": return `L’amortissement du refinancement dépasse le plafond de ${f.value(e,"years")}.`;
    case "debt_exceeds_cost":
      return `Les engagements de dette de ${$(a)} couvrent la totalité du coût de ${$(e)}. Les fonds propres seraient nuls ou négatifs : cette structure de capital ne peut pas exister.`;
    case "ltc_ceiling":
      return c.severity === "error"
        ? `Le ratio prêt-coût de ${pct(a)} dépasse le plafond de la politique, fixé à ${pct(e)}.`
        : `Le ratio prêt-coût de ${pct(a)} respecte le plafond de la politique, fixé à ${pct(ltcCeiling)}.`;
    case "noi_not_positive":
      return `Le RNE stabilisé est de ${$(a)}. Un projet déficitaire à la stabilisation ne peut pas être évalué par capitalisation.`;
    case "equity_wipeout":
      if (c.message.startsWith("The stated value")) return `La valeur déclarée, ${$(a)}, ne couvre pas les ${$(e)} de dette en cours. Les fonds propres n'ont aucune valeur à la fin de la détention.`;
      return `Le produit net de la vente, ${$(a)}, ne rembourse pas les ${$(e)} de dette en cours. Les fonds propres sont anéantis à la sortie.`;
    case "mezz_interest_accrued":
      return `Des intérêts de ${$(a)} sur la mezzanine s'ajoutent à son solde une fois son engagement de ${$(e)} utilisé ; le solde de la mezzanine à la stabilisation est de ${$((e ?? NaN) + (a ?? NaN))}.`;
    case "presale_threshold_unmet":
      return `Le prêt de construction exige ${pct(e)} de logements prévendus ; ${pct(a)} sont déclarés.`;
    case "for_sale_debt_unpaid":
      return `Scénario de base : une dette de ${$(a)} reste à rembourser après la dernière conclusion de vente.`;
    case "funding_not_converged":
      return "Les fonds propres requis n'ont pas pu être déterminés ; le plan de financement est incohérent.";
    case "sources_cover_uses":
      if (c.severity === "error") return `Les fonds propres déclarés de ${$(a)} ne couvrent pas les ${$(e)} requis (écart de ${$((e ?? 0) - (a ?? 0))}).`;
      if (c.severity === "warning") return `Les fonds propres déclarés de ${$(a)} dépassent de ${$((a ?? 0) - (e ?? 0))} le besoin ; le modèle n'apporte que ${$(e)}.`;
      return a === undefined ? "Aucun montant de fonds propres n'est indiqué ; les fonds propres correspondent à la part que la dette ne finance pas." : "Les sources égalent les emplois.";
    case "stated_total_cost":
      return c.severity === "pass" ? `Le coût total déclaré de ${$(a)} concorde avec le modèle.` : `Les documents indiquent un coût total de ${$(a)} ; le modèle calcule ${$(e)}.`;
    case "stated_ltc":
      return c.severity === "pass" ? `Le ratio prêt-coût déclaré de ${pct(a)} concorde avec le modèle.` : `Les documents indiquent un ratio prêt-coût de ${pct(a)} ; le modèle calcule ${pct(e)}.`;
    case "interest_reserve_before_completion":
      return c.severity === "pass"
        ? `La réserve d'intérêts déclarée de ${$(a)} couvre les ${$(e)} d'intérêts pendant la construction calculés par le modèle.`
        : `Le budget prévoit une réserve d'intérêts de ${$(a)} ; le modèle calcule ${$(e)} d'intérêts pendant la construction. La réserve semble insuffisante de ${$((e ?? 0) - (a ?? 0))}.`;
    case "interest_reserve":
      return c.severity === "pass"
        ? `La réserve d'intérêts déclarée de ${$(a)} couvre les ${$(e)} calculés par le modèle.`
        : `Le budget prévoit une réserve d'intérêts de ${$(a)} ; le modèle calcule ${$(e)} d'intérêts avant la stabilisation. La réserve semble insuffisante de ${$((e ?? 0) - (a ?? 0))}.`;
    case "dscr_covenant":
      return c.severity === "pass"
        ? `Le RCSD contractuel de ${x(a)} respecte la clause de ${x(e)} chaque année de détention.`
        : `Le RCSD contractuel descend à ${x(a)}, sous la clause de ${x(e)}.`;
    case "base_sizing_dscr":
      return `Le RCSD de dimensionnement du scénario de base, ${x(a)}, est sous le plancher de ${x(e)}.`;
    default:
      return c.message;
  }
}

export const FR_ABSENT: Record<string, string> = {
  sell_units: "les logements sont loués",
  senior_presale_threshold_pct: "aucune condition de préventes déclarée",
  other_cost: "aucun autre coût",
  unit_rent_monthly: "le loyer est au pied carré",
  rentable_area_sf: "le loyer est par logement",
  rent_psf_annual: "le loyer est par logement",
  item_occupancy_pct: "utiliser l'occupation stabilisée du projet",
  fixed_opex_annual: "utiliser le ratio des charges",
  variable_expense_pct: "aucune charge variable",
  other_income_annual: "aucun autre revenu",
  rent_growth_pct: "loyers stables",
  expense_growth_pct: "charges stables",
  lease_up_ramp: "aucun revenu avant la stabilisation",
  s_curve_draws: "tirages linéaires",
  senior_io_months: "amortissement dès la stabilisation",
  min_dscr_covenant: "aucune clause déclarée",
  mezz_loan_amount: "aucun prêt mezzanine",
  mezz_io_months: "amortissement dès la stabilisation",
  equity_amount: "les fonds propres couvrent ce que la dette ne finance pas",
  refinance_month: "aucun refinancement",
  refinance_amount: "établi selon le ratio prêt-valeur",
  refinance_ltv_pct: "établi selon le montant",
  refinance_io_months: "amortissement dès le refinancement",
  refinance_and_hold: "le projet est vendu à la fin de la détention",
  development_charges: "aucune redevance déclarée",
  land_transfer_tax: "aucun droit déclaré",
  gst_hst_net: "aucune déclarée",
  property_tax_annual: "comprise dans les charges d'exploitation, ou aucune",
  refinance_premium_tax_pct: "aucune taxe provinciale sur la prime",
  refinance_insurance_premium_pct: "aucune assurance hypothécaire",
  refinance_mli_select_points: "MLI Standard (sans points MLI Select)",
  refinance_term_years: "non précisée",
  lp_share_pct: "aucun partage entre commanditaires et commandité",
  stated_total_cost: "rien à vérifier",
  stated_ltc_pct: "rien à vérifier",
  stated_interest_reserve: "rien à vérifier",
};

/** Checks beside document-sourced field values in review (card 125). */
export const FR_VERIFY: Record<string, string> = {
  gst_hst_net: "À vérifier : la TPS/TVH nette dépend des remboursements auxquels ce projet a droit.",
  property_tax_annual: "Vérifiez qu'elle n'est pas déjà comprise dans vos charges d'exploitation ou votre ratio des charges.",
};

export const PREMIUM_TAX_HELP_FR = "L'Ontario, le Québec et la Saskatchewan taxent la prime. Elle est payée comptant au refinancement, sans être ajoutée au prêt.";
