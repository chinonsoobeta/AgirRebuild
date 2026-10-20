// Folded words for a concept read. Aliases and their refusals always run first.
// "Principal" is an amount word, not a loan: "Principal: $X" alone names no loan.
export const LOAN_NOUN = /\b(?:loans?|facilit(?:y|ies)|advances?|mortgages?|lenders?|banks?|credits?|financing|borrowing|prets?|financements?|hypotheques?|preteurs?|banques?|avances?)\b/;
// The main lender is the senior loan, whatever the document's own loan is: "le prêteur principal", "our main lender".
export const MAIN_LENDER = /\b(?:preteur principal|banque principale|premier preteur|principal lender|main lender|lead lender|first lender)\b/;
// "The lender", "a bank", "le prêteur": a loan named before, whose rank this line does not state.
export const LOAN_ANAPHOR = /\b(?:the|a|an|this|that|our|their|its|le|la|les|l|un|une|ce|cette|notre|leur)\s+(?:loans?|facility|lenders?|banks?|mortgages?|prets?|preteurs?|banques?|hypotheques?)\b/;
// A figure said to be uncommitted or an alternative is not the loan: "…, never committed".
export const NOT_THE_LOAN_AFTER = /^\W*(?:(?:which|that|but)\s+(?:was|is)\s+)?(?:never|not (?:yet )?committed|uncommitted|jamais|non engage)/;

export const CONCEPTS: readonly {
  fieldKey: string;
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
];
