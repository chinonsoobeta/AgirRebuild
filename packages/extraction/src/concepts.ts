// Folded words for a concept read. Aliases and their refusals always run first.
// "Principal" is an amount word, not a loan: "Principal: $X" alone names no loan.
export const LOAN_NOUN = /\b(?:loans?|facilit(?:y|ies)|advances?|mortgages?|lenders?|banks?|credits?|financing|borrowing|prets?|financements?|hypotheques?|preteurs?|banques?|avances?)\b/;
// The main lender is the senior loan, whatever the document's own loan is: "le prêteur principal", "our main lender".
export const MAIN_LENDER = /\b(?:preteur principal|banque principale|premier preteur|principal lender|main lender|lead lender|first lender)\b/;
// "The lender", "a bank", "le prêteur": a loan named before, whose rank this line does not state.
export const LOAN_ANAPHOR = /\b(?:the|a|an|this|that|our|their|its|le|la|les|l|un|une|ce|cette|notre|leur)\s+(?:loans?|facility|lenders?|banks?|mortgages?|prets?|preteurs?|banques?|hypotheques?)\b/;
// A figure said to be uncommitted or an alternative is not the loan: "…, never committed".
export const NOT_THE_LOAN_AFTER = /^\W*(?:(?:which|that|but)\s+(?:was|is)\s+)?(?:never|not (?:yet )?committed|uncommitted|jamais|non engage)/;

// Words that make a budget line something else: a total of several lines, a loan named with a cost word ("Construction principal"),
// a municipal levy, or an amount already counted or settled elsewhere.
export const NOT_A_BUDGET_LINE = /\b(?:total|totals|totale?s?|subtotal|sub-total|sous-total|overall|all-in|grand|principal|lev(?:y|ies|ied)|redevances?|already|deja)\b/;
// A cost word after "in", "within" or "included in" says where the figure sits, not what it is ("service charges already in consultants").
export const WHERE_IT_SITS = /\s+(?:already|included|inclu\w*|compris\w*|deja|within|in|into|part of|dans)\b.*$/;

export const CONCEPTS: readonly {
  fieldKey: string;
  budget?: true;
  unit: "$" | "%" | "years" | "months";
  words: readonly RegExp[];
  exclude: RegExp;
}[] = [
  {
    fieldKey: "senior_loan_amount", unit: "$",
    words: [LOAN_NOUN, /\b(?:amount|principal|advance|size|commitment|granted|montant|capital|accord\w*)\b/],
    exclude: /\b(?:apprais\w*|evalu\w*|alternat\w*|rough|uncommitted|hypothetical|indicative|floated|(?:sub|sous-)?totals?|line of credit|credit line|marge de credit|ligne de credit|fees?|interests?|reserves?|holdbacks?|draw\w*|to date|balances?|payments?|deposits?|equity|officer|union|valuation|valued|value|frais|interets?|retenues?|soldes?|versements?|depots?|capitaux propres|capital propre|tire\w*|a ce jour)\b/,
  },
  {
    fieldKey: "senior_rate_pct", unit: "%",
    words: [/\b(?:rate|interest|int|coupon|charge|cost of borrowing|taux|interet)\b/],
    exclude: /\b(?:to[- ]value|to[- ]cost|ltv|ltc|fees?|spread|over prime|premium|insurance|dscr|dcr|holdbacks?|frais|prime d assurance|ratio|partners?|investors?|commanditaires?|associes?|investisseurs?|retard|arrerages|defaut|deposits?|depots?|ownership|carried|partnership|pret[- ](?:valeur|cout)|ecart|au dessus du taux preferentiel)\b/,
  },
  {
    fieldKey: "senior_amort_years", unit: "years",
    words: [/\b(?:amort\w*|repay\w*|repaid|paid down|rembours\w*)\b/],
    exclude: /\b(?:terms?|maturity|renewal|echeance|termes?|duree du pret|renouvellement)\b/,
  },
  {
    fieldKey: "senior_io_months", unit: "months",
    words: [/\b(?:interest[- ]only|io|before repayment begins|before amortization|interets? seulement|sans remboursement de capital)\b/],
    exclude: /\b(?:terms?|maturity|draw\w*|echeance|termes?|tirage\w*)\b/,
  },
  // Card 109: v8/v9 labels informed the build/travaux, acquisition, design and contingency vocabulary.
  // Vague paraphrases in those sets are not concept words. Tax, finance and operating items remain excluded.
  {
    fieldKey: "land_cost", unit: "$", budget: true,
    words: [/\b(?:(?:building|property|site) (?:purchase|acquisition)|land|lots?(?! de travaux)|parcels?|site acquisition|acquisition|property purchase|purchase of (?:the )?(?:site|building|property)|ground|terrain|parcelle|achat du (?:terrain|lot|immeuble)|achat de l immeuble)\b/],
    exclude: /\b(?:transfer tax|ltt|droits de mutation|interest|interets?|carrying|value|apprais\w*|deposit|depot|survey|arpentage|loan|lender|financing|pret|preteur|financement)\b/,
  },
  {
    fieldKey: "hard_cost", unit: "$", budget: true,
    words: [/\b(?:construction|build|works|trades|framing|envelope|finishes|fit-out|fitout|shell|contractor|structure|site services|servicing|sitework|travaux|charpente|enveloppe|finitions|entrepreneur|chantier)\b/, /(?<!purchase of the )(?<!purchase of )\bbuilding\b(?!\s+(?:purchase|acquisition|price|basis))/],
    exclude: /\b(?:loans?|interest|insurance|management|supervision|fees?|permits?|design|drawings|period|months?|prets?|interets?|assurance|gestion|honoraires|permis)\b/,
  },
  {
    fieldKey: "soft_cost", unit: "$", budget: true,
    words: [/\b(?:architect\w*|engineer\w*|design|drawings|plans|consultants?|permits?|approvals?|legal|accounting|surveys?|studies|project management|development management|professional fees|honoraires|etudes|permis|conception|juridique\w*|comptable\w*)\b/],
    exclude: /\b(?:development charges|dc|levies|interest|financing|frais de financement|redevances|interets?|loan|lender|pret|preteur|courtage|courtiers?|garanties?|gestion|dossier|engagement|banques?|financements?|hypothecaires?)\b/,
  },
  {
    fieldKey: "contingency", unit: "$", budget: true,
    words: [/\b(?:contingenc(?:y|ies)|buffer|cushion|overrun allowance|allowance for (?:overruns|unknowns)|unallocated|unforeseen|risk allowance|imprevus|aleas|provision pour (?:depassements|imprevus)|marge pour imprevus)\b/],
    exclude: /\b(?:operating|replacement|interest|lease-up|deficit|exploitation|remplacement|interets?|mise en location)\b/,
  },
];
