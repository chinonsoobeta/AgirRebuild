// Folded words for a concept read. Aliases and their refusals always run first.
// "Principal" is an amount word, not a loan: "Principal: $X" alone names no loan.
export const LOAN_NOUN = /\b(?:loans?|facilit(?:y|ies)|advances?|mortgages?|lenders?|banks?|credits?|financing|borrowing|prets?|financements?|hypotheques?|preteurs?|banques?|avances?)\b/;
// The main lender is the senior loan, whatever the document's own loan is: "le prêteur principal", "our main lender".
export const MAIN_LENDER = /\b(?:preteur principal|banque principale|premier preteur|principal lender|main lender|lead lender|first lender)\b/;
// "The lender", "a bank", "le prêteur": a loan named before, whose rank this line does not state.
export const LOAN_ANAPHOR = /\b(?:the|a|an|this|that|our|their|its|le|la|les|l|un|une|ce|cette|notre|leur)\s+(?:loans?|facility|lenders?|banks?|mortgages?|prets?|preteurs?|banques?|hypotheques?)\b/;
// A figure said to be uncommitted or an alternative is not the loan: "…, never committed".
export const NOT_THE_LOAN_AFTER = /^\W*(?:(?:which|that|but)\s+(?:was|is)\s+)?(?:never|not (?:yet )?committed|uncommitted|jamais|non engage)/;

// Card 115: v5/v8/v9/v10 loan labels informed rank and plain loan vocabulary.
// First phase/draw/year/floor and a partner's priority are not loan ranks.
export const SENIOR_RANK = /\b(?:sr|senior|first[- ]charge|first (?=(?:money|principal|amort\w*|io|interest|rate|coupon|charge|lender|loan|mortgage)\b)|the first is|(?:dette|pret|interet|taux|amort\w*)\s+prioritaire|prioritaire\s+(?:dette|pret|interet|taux|amort\w*))\b/;
export const LOAN_PERIOD = /\b(?:repayment (?:schedule|years)|years to repay (?:the )?principal|free-principal|no-principal|principal holiday|franchise de capital|interets? seuls|periode sans capital)\b/;
// v6/v8/v9/v10 totals: a named cost subtotal still belongs to that cost.
// Card 115 audit: "stated total" and "total déclaré" alone, or of the project or its costs; "Stated total rent" is not the project's.
export const STATED_TOTAL = /\b(?:stated project subtotal|project subtotal|(?:stated total|total declare)(?=\s*$|\s+(?:project|cost|costs|of (?:the )?(?:project|uses|costs)|budget|du projet|des couts|des emplois)\b)|total uses|all-in uses|sum of uses|total des emplois|somme des emplois)\b/;
// Card 116: project total words qualify the budget, never a loan, rent or equity total.
export const PROJECT_TOTAL = /\b(?:(?:whole|entire|total|complete|all-in|global)\s+(?:(?:project|job|investment)\s+)?(?:budget|envelope|investment|project cost|job cost)|(?:project|job)\s+(?:whole|entire|total|complete|all-in|global)\s+(?:budget|envelope|cost)|uses\s+(?:at (?:close|closing)|closed|brought forward|carried forward|stated)|closing uses total|enveloppe\s+(?:complete|globale|budgetaire)|cout global|total investissement)\b/;
export const NOT_PROJECT_TOTAL = /\b(?:loans?|prets?|rents?|loyers?|equity|capitaux propres|fonds propres|mise de fonds|operating|exploitation)\b/;
export const PROPERTY_WORD = /\b(?:sites?|lots?|land|dirt|ground|parcels?|property|house|building|shell|immeuble|fonds|propriete|batisse|terrain)\b/;
export const ACQUISITION_WORD = /\b(?:purchas\w*|acquisition|acquir\w*|buy|buying|bought|paid for|closing|consideration|allocation|cheque|price|basis|under contract|achat|achet\w*|acquis\w*|prix|cloture)\b/;
export const RISK_WORD = /\b(?:risk|surprises?|unknown\w*|unforeseen\w*|spare|just-in-case|unspent|uncommitted|extra work|imprevus|aleas)\b/;
export const HOLDING_WORD = /\b(?:allowance|money|pot|provision|sleeve|cushion|buffer|held back|fund|sum|somme|reserve|coussin)\b/;
export const RESIDUAL_COST = /\b(?:everything else|miscellaneous|misc|sundry|odd costs?|non-GC|non-?trade|(?:other|remaining) project (?:charges|bills|cash|spend|costs)|unallocated(?: project)? (?:charges|bills|costs)|autres debours|frais divers)\b/i;
export const NOT_THIS_COST = /\b(?:values?(?![- ]engineered)|apprais\w*|assess\w*|valuation|valeur|land lease|ground rent|bail foncier|loyer du terrain|another (?:project|job)|other (?:project|job)(?! (?:charges|bills|cash|spend|costs))|autre projet|last year|prior year|previous year|an dernier|annee (?:derniere|precedente)|neighbou?r|voisin\w*|previous owner|ancien proprietaire|paid to date|payes? a ce jour|payee?s? a ce jour|to complete|a terminer|deposits?|depots?)\b/;
export const NOT_RISK_COST = /\b(?:du marche|(?:cushion|buffer|coussin) (?:on|sur) (?:the |le |les )?(?:prices?|prix)|rent|loyers?|ratios?|rates?|taux|dscr|dcr|months?|years?|mois|ans?|(?:per|par) (?:units?|suites?|lots?|doors?|unites?|logements?|months?|years?|mois|ans?)|insurance|assurance|claim|operating|replacement|interest|lease-up|deficit|exploitation|remplacement|interets?|mise en location)\b/;

export const DEBT_SERVICE = /\b(?:debt service|service de la dette|annual payment|mortgage payment)\b/;

// Words that make a budget line something else: a total of several lines, a loan named with a cost word ("Construction principal"),
// a municipal levy, or an amount already counted or settled elsewhere.
export const NOT_A_BUDGET_LINE = /\b(?:total|totals|totale?s?|subtotal|sub-total|sous-total|overall|all-in|grand|principal|lev(?:y|ies|ied)|redevances?|already|deja)\b/;
// A cost word after "in", "within" or "included in" says where the figure sits, not what it is ("service charges already in consultants").
export const WHERE_IT_SITS = /\s+(?:already|included|inclu\w*|compris\w*|deja|within|in|into|part of|dans)\b.*$/;

// Card 110 audit. An assumption concept never takes: an alternative, rejected or earlier figure; a loan's period
// (repayment, amortization, a lender's requirement); or a month number, which is a point in time, not a duration.
export const NOT_THE_DEALS_ASSUMPTION = /\b(?:alternat\w*|option(?:al)?|declined|rejected|abandon\w*|earlier|previous|prior|former|old|sketch|instead|faster|accelerated?|accelere\w*|refus\w*|ancien\w*|precedent\w*|variante|repa(?:y|id)\w*|repayment|rembours\w*|amort\w*|principal|visits?|visite|inspections?|tours?|meetings?|reunion|(?:has|have|had)\s+(?:\w+\s+)?(?:held|kept|owned)|experience|track record|portfolio|since|last|dernier\w*|existing|actuel\w*|current|vacate|move out|evict\w*|relocat\w*|quitter|demenag\w*)\b/;
export const NOT_CHOSEN_AFTER = /^\W*(?:[a-z]+\s+){0,4}(?:declined|rejected|dropped|abandoned|not (?:adopted|used|chosen|retained)|refus\w*|abandonn\w*|ecart\w*)/;
// Card 111 audit: a sitting tenant's time to leave ("6 months to vacate") is a notice, not the lease-up.
export const LEAVING_AFTER = /^\W*(?:[a-z]+\s+){0,2}(?:vacate|move out|leave|quitter|demenag\w*)\b/;
export const MONTH_INDEX = /\b(?:month|mois)\s*:?\s*$|\b(?:at|in|by|from|until|au|en|du|des le)\s+(?:(?:the|project|le)\s+)?(?:month|mois)\b/;

// Card 117: settled occupancy and growth words apply in either order.
export const OCCUPANCY_WORD = /\b(?:occupancy|occupied|filled|fill|let|letting|leasing|leased|rented|occupation)\b/;
export const SETTLED_WORD = /\b(?:stabili[sz]\w*|stab|settled|steady|mature|normal|long-run|long-term|target|planned|a maturite|de croisiere|a terme|retenue|regime(?: stable| etabli)?)\b/;
export const GROWTH_WORD = /\b(?:growth|uplift|steps?|drift|increase|escalation|grown(?: at)?|indexation|hausse|croissance)\b/;
// Card 117 audit: "actual" or "réelle" beside a stabilization word is this building's stabilized state (card 105), not history.
export const ASSUMPTION_HISTORY = /\b(?:actual(?! stabili)|historic(?:al)?|last year|prior year|seller s|previous owner|old owner|old building|comparables?|market|area|neighbou?rhood|peak|(?<!stabilisee )reel(?:le)?s?(?! stabili)|l an dernier|historique|marche)\b/;

export const CONCEPTS: readonly {
  fieldKey: string;
  budget?: true;
  assumption?: true;
  with?: readonly RegExp[];
  basisAfter?: RegExp;
  unit: "$" | "%" | "years" | "months";
  words: readonly RegExp[];
  exclude: RegExp;
}[] = [
  {
    fieldKey: "senior_loan_amount", unit: "$",
    words: [LOAN_NOUN, /\b(?:amount|principal|advance|size|commitment|granted|dollars|funds|money|cash|authorization|committed|dette|montant|capital|accord\w*)\b/],
    exclude: /\b(?:apprais\w*|evalu\w*|alternat\w*|rough|uncommitted|hypothetical|indicative|floated|(?:sub|sous-)?totals?|line of credit|credit line|marge de credit|ligne de credit|fees?|interests?|reserves?|holdbacks?|draw\w*|to date|balances?|payments?|deposits?|equity|officer|union|valuation|valued|value|frais|interets?|retenues?|soldes?|versements?|depots?|capitaux propres|capital propre|tire\w*|a ce jour|partners?|sponsors?|own|investors?|promoteurs?|associes?|commanditaires?|investisseurs?)\b/,
  },
  {
    fieldKey: "senior_rate_pct", unit: "%",
    words: [/\b(?:rate|interest|int|coupon|pricing|charge|cost of borrowing|taux|interet)\b/],
    exclude: /\b(?:to[- ]value|to[- ]cost|ltv|ltc|fees?|spread|over prime|premium|insurance|dscr|dcr|holdbacks?|frais|prime d assurance|ratio|partners?|investors?|commanditaires?|associes?|investisseurs?|retard|arrerages|defaut|deposits?|depots?|ownership|carried|partnership|pret[- ](?:valeur|cout)|ecart|au dessus du taux preferentiel|resets?|renewal|renouvel\w*|revision|step[- ]?ups?)\b/,
  },
  {
    fieldKey: "senior_amort_years", unit: "years",
    words: [/\b(?:amort\w*|repay\w*|repaid|paid down|rembours\w*)\b/],
    exclude: /\b(?:terms?|maturity|renewal|draw\w*|deposits?|depots?|rent-free|echeance|termes?|duree du pret|renouvellement)\b/,
  },
  {
    fieldKey: "senior_io_months", unit: "months",
    words: [/\b(?:interest[- ]only|io|before repayment begins|before amortization|free-principal|no-principal|principal holiday|franchise de capital|interets? seuls|periode sans capital|interets? seulement|sans remboursement de capital)\b/],
    exclude: /\b(?:terms?|maturity|draw\w*|deposits?|depots?|rent-free|echeance|termes?|tirage\w*)\b/,
  },
  // Card 109: v8/v9 labels informed the build/travaux, acquisition, design and contingency vocabulary.
  // Vague paraphrases in those sets are not concept words. Tax, finance and operating items remain excluded.
  {
    fieldKey: "land_cost", unit: "$", budget: true,
    words: [/\b(?:purchase (?:basis|consideration|allocation)|the purchase|(?:dirt|ground) (?:cost|deal|price|basis))\b/, new RegExp(`^(?=.*${PROPERTY_WORD.source})(?=.*${ACQUISITION_WORD.source})`), /\b(?:(?:building|property|site) (?:purchase|acquisition)|land|lots?(?! de travaux)|parcels?|site acquisition|acquisition|property purchase|purchase of (?:the )?(?:site|building|property)|ground|terrain|parcelle|achat du (?:terrain|lot|immeuble)|achat de l immeuble)\b/],
    exclude: /\b(?:transfer tax|ltt|droits de mutation|interest|interets?|carrying|extras?|value|apprais\w*|deposit|depot|survey|arpentage|loan|lender|financing|pret|preteur|financement)\b/,
  },
  {
    fieldKey: "hard_cost", unit: "$", budget: true,
    words: [/\b(?:interior finish package|work order|suite installation|ouvrage|transformation|marche de travaux)\b/, /^(?=.*\b(?:gc|general contractor|crew|builder|trades?|conversion|renovation|installation|fit-up)\b)(?=.*\b(?:contracts?|lump sum|payments?|bill|price|spend|envelope|sum|cost)\b)/, /\b(?:construction|build|works|trades|framing|envelope|finishes|fit-out|fitout|shell|contractor|structure|site services|servicing|sitework|travaux|charpente|enveloppe|finitions|entrepreneur|chantier)\b/, /(?<!purchase of the )(?<!purchase of )\bbuilding\b(?!\s+(?:purchase|acquisition|price|basis))/],
    exclude: /\b(?:unallocated|loans?|rents?|monthly|loyers?|mensuel\w*|quotes?|interest|insurance|management|supervision|fees?|permits?|design|drawings|period|months?|prets?|interets?|assurance|gestion|honoraires|permis)\b/,
  },
  {
    fieldKey: "soft_cost", unit: "$", budget: true,
    words: [/\b(?:paper side|paperwork|advis[eo]rs?|outside services|professional[- ]services|development services|advice|consents|fees outside (?:the )?gc|soft (?:spend|charges)|services professionnels|demarches|frais (?:de )?professionnels|professional(?: and)? (?:approval|people|spend))\b/, /\b(?:architect\w*|engineer(?!ed\b)\w*|design|drawings|plans|consultants?|permits?|approvals?|legal|accounting|surveys?|studies|project management|development management|professional fees|honoraires|etudes|permis|conception|juridique\w*|comptable\w*)\b/],
    exclude: /\b(?:development charges|dc|levies|interest|financing|frais de financement|redevances|interets?|loan|lender|pret|preteur|commissions?|loss(?:es)?|pertes?|courtage|courtiers?|garanties?|gestion|dossier|engagement|banques?|financements?|hypothecaires?)\b/,
  },
  {
    fieldKey: "contingency", unit: "$", budget: true,
    words: [new RegExp(`^(?=.*${RISK_WORD.source})(?=.*${HOLDING_WORD.source})`), /\b(?:contingenc(?:e|es|y|ies)|buffer|cushion|overrun allowance|allowance for (?:overruns|unknowns)|unforeseen|risk allowance|imprevus|aleas|provision pour (?:depassements|imprevus)|marge pour imprevus)\b/],
    exclude: /\b(?:operating|replacement|interest|lease-up|deficit|exploitation|remplacement|interets?|mise en location)\b/,
  },
  {
    fieldKey: "other_cost", unit: "$", budget: true,
    words: [RESIDUAL_COST],
    exclude: /\b(?:income|revenue|proceeds|revenus?|recettes?|produit|cash (?:left |remaining )?after closing|loan|lender|financing|interest|pret|preteur|financement|interets?|reserve|provision|allowance|fund)\b/,
  },
  // Card 110 sources: v8/v9 for construction, lease-up, occupancy, exit cap and expense ratio;
  // v8 for hold and both growth fields. Card 111: in prose, words after a figure with a stated unit may name an assumption (never a loan or budget line).
  {
    fieldKey: "construction_months", unit: "months", assumption: true,
    // Card 111 (v4, v5): a span from the foundations to occupancy is the build.
    words: [/\b(?:build|construction|works|work period|trades|installation|fit-up|site|crew|delivery|program(?:me)?|conversion|renovation|fit-out|chantier|travaux|transformation)\b/, /\bfrom (?:the )?(?:foundations?|shovels?(?: in the ground)?|ground-?breaking|excavation|mobili[sz]ation) to (?:the )?(?:occupancy|completion|handover|delivery|substantial completion)\b|\b(?:de|des|du) (?:la |les )?(?:fondations?|excavation|mobilisation|debut des travaux) (?:a|au|jusqu a) (?:la |l )?(?:occupation|livraison|fin des travaux)\b/],
    exclude: /\b(?:loans?|interest|reserves?|terms?|lock|permits?|approval|wait|holdbacks?|warranty|lease|let|tenants?|prets?|interets?|permis|attente|garantie|retenue|insurance|assurance|starts?|debut|avant|commencement|fixed through|post-completion|construction month|fill|tenanting|remplissage|reviews?|examen|revue|(?:re-?)?zoning|zonage|draws?|tirages?|take-?out|relais|deadline|echeance)\b/,
  },
  {
    fieldKey: "lease_up_months", unit: "months", assumption: true,
    // Card 111 (v4): "pour remplir les logements"; "locataires" is the French for tenants.
    words: [/\b(?:lease-up|leasing|letting|tenanting|let-up|fill|tenants?|tenant-finding|absorption|rent-up|mise en location|location|remplir|remplissage|to lease|to let|locataires?)\b/],
    exclude: /\b(?:loans?|terms?|permits?|permis|lock|free rent|rent-free|notice|lease term|bail|prets?|loyer gratuit|franchise de loyer|preavis|location du terrain|free|incentives?|gratuite?s?|incitati\w*)\b/,
  },
  {
    fieldKey: "stabilized_occupancy_pct", unit: "%", assumption: true,
    words: [OCCUPANCY_WORD],
    with: [SETTLED_WORD],
    exclude: /\b(?:covenant|lender|condition|market|area|comparable|current|today|existing|in[- ]place|breakeven|vacancy|actuel\w*|marche|preteur|clause|seuil de rentabilite)\b/,
  },
  {
    fieldKey: "exit_cap_rate_pct", unit: "%", assumption: true,
    words: [/\b(?:cap|capitali[sz](?:ation|ing))\b/],
    with: [/\b(?:end|exit|sale|sell|disposal|disposition|cession|reversion|terminale?|outgoing|going-out|eventual|revente|sortie|vente|depart)\b/],
    exclude: /\b(?:going-in|entry|purchase|acquisition|in[- ]place|current|market|comparable|sold|traded|achat|entree|actuel\w*|marche)\b/,
  },
  {
    fieldKey: "expense_ratio_pct", unit: "%", assumption: true,
    words: [/\b(?:operating|opex|running|maintenance|upkeep|frais courants|run (?:the |a |this )?building|expenses?|costs?|charges|exploitation|depenses)\b/],
    with: [/\b(?:share|fraction|ratio|percentage|proportion|take|slice|load|deduction|allowance|pourcentage|part|(?:against|of|rapportees? aux|rapportes? aux|sur (?:les )?) (?:egi|effective income|income|receipts|revenue|collections|recettes|revenus))\b/],
    basisAfter: /^\s*(?:of (?:the )?(?:egi|income|collections|revenue|receipts)|(?:des?|du|sur les) (?:recettes|revenus))\b/,
    exclude: /\b(?:management fee|vacancy|tax|insurance|growth|increase|escalation|inflation|frais de gestion|assurance|taxes?|croissance|hausse|vacance|recurring|sell\w*|sale|exit|brokerage|commissions?|disposition|vente|courtage)\b/,
  },
  {
    fieldKey: "hold_years", unit: "years", assumption: true,
    // Card 111 (v4): selling after a period, or keeping the building for it, is the hold.
    words: [/\b(?:hold|held|holding|ownership|own|horizon|keep|detention|conserver|garder|(?:sell|sale|selling|exit|resale) after|(?:revente|vente|sortie) apres|vendre (?:apres|au bout de)|(?:garde|gardons|garderons|conserve|conservons|conserverons) (?:l|le|la) (?:immeuble|batiment|propriete|actif|projet))\b/],
    exclude: /\b(?:loans?|terms?|amort\w*|warranty|lease|bail|prets?|garantie)\b/,
  },
  {
    fieldKey: "rent_growth_pct", unit: "%", assumption: true,
    words: [/\b(?:rents?|asking|loyers?)\b/],
    with: [GROWTH_WORD],
    exclude: /\b(?:expenses?|costs?|charges|market|comparable|cap|depenses|couts?|marche)\b/,
  },
  {
    fieldKey: "expense_growth_pct", unit: "%", assumption: true,
    words: [/\b(?:expenses?|costs?|overhead|running-bill|frais courants|opex|charges|depenses|couts?)\b/],
    with: [new RegExp(`${GROWTH_WORD.source}|\\binflation\\b`)],
    exclude: /\b(?:rents?|loyers?|market|comparable|construction|hard|build|marche)\b/,
  },
  {
    fieldKey: "fixed_opex_annual", unit: "$", assumption: true,
    words: [/\b(?:overhead|operating|opex|running bill|operating pot|charges|exploitation|frais d exploitation)\b/],
    with: [/\b(?:fixed|annual|yearly|per year|fixes?|annuels?|annuelles?|par an)\b/],
    exclude: /\b(?:tax(?:es)?|insurance|management fee|fees?|reserve|debt|impot|assurance|frais de gestion|dette)\b/,
  },
  {
    fieldKey: "other_income_annual", unit: "$", assumption: true,
    words: [/\b(?:parking|laundry|storage|lockers?|extras|ancillary|side|accessoires|stationnement|buanderie|entreposage)\b/],
    with: [/\b(?:income|revenue|cash|proceeds|receipts|collected|add|revenus|recettes|yearly|annual|par annee|par mois)\b/],
    exclude: /\b(?:per|par|each|chaque) (?:stall|locker|unit|place|casier|unite)s?\b/,
  },
  {
    fieldKey: "selling_costs_pct", unit: "%", assumption: true,
    words: [/\b(?:sale|sell|selling|disposal|exit|cession|vente)\b/],
    with: [/\b(?:friction|transaction|costs?|allowance|couts?|frais)\b/],
    exclude: /\b(?:purchase|lease|leasing|brokerage|commission|achat|location)\b/,
  },
];
