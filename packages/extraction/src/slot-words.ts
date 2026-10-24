// Folded English and French loan slot vocabulary. Patterns preserved from concepts.ts.
export const LOAN_NOUN = /\b(?:loans?|facilit(?:y|ies)|advances?|mortgages?|lenders?|banks?|credit union|member(?= (?:loans?|mortgages?|amort\w*|rates?|interest|io)\b)|credits?|financing|borrowing|prets?|financements?|hypotheques?|preteurs?|banques?|caisses?|avances?)\b/;
export const LENDING_WORD = /\b(?:lends?|will finance|to finance|finances|financed|financera|financer|advances?|commits?|provides?|puts? up|signs? for|funds?|funding|approves?|approved|sanctions?|sanctioned|amount|sum|prete\w*|accord\w*|consent\w*|montant)\b/;
export const PRICE_WORD = /\b(?:a year|per annum|par an|rates?|interest|coupon|charges?|bills?|priced|fixed|annual|yearly|taux|interets?)\b/;
export const REPAYMENT_WORD = /\b(?:amort\w*|paid off|pays? off|payback|pays? down|repaid|repayment|rembours\w*)\b/;
export const IO_WORD = /\b(?:interest[- ]only|only interest|seul\w* (?:les )?interets?|io|no[- ]principal|without principal|interets? seulement|sans remboursement de capital|franchise)\b/;
export const NOT_SENIOR_LENDER = /\b(?:vendor take[- ]back|vtb|equity|fonds propres|capitaux propres)\b/;
export const OTHER_LENDER = /\b(?:rival|other|another|competing|competitor|concurrent\w*|alternative|autre banque|declined|refused|rejected|turned (?:it )?down|offre refusee|not taken|last year|seller s|previous owner|existing loan being repaid|ancien proprietaire|annee derniere)\b/;
export const DECLINED_AFTER = /\b(?:declined|refused|rejected|turned (?:it |them )?down|passed on it|said no|walked away|dit non|refus\w*|decline\w*|rejet\w*|pas retenu\w*)\b/;
export const LENDER_TEST = /\b(?:caps?|limits?|no more than|will not exceed|up to|at most|stress[- ]test|qualifying|debt yield|dscr|coverage|plafonne\w*|au plus|taux de qualification)\b/;
export const OTHER_RATE = /\b(?:vacancy|occupancy|inoccupation|occupation|cap rate|growth|inflation|debt yield)\b/;
export const SENIOR_RANK = /\b(?:sr|senior|first[- ](?:charge|ranking)|first (?=(?:money|principal|amort\w*|io|interest|rate|coupon|charge|lender|loan|mortgage)\b)|the first is|(?:dette|pret|interet|taux|amort\w*)\s+prioritaire|prioritaire\s+(?:dette|pret|interet|taux|amort\w*))\b/;
export const LOAN_PERIOD = /\b(?:repayment (?:schedule|years|horizon|after conversion)|years to repay (?:the )?principal|months free of principal|principal-free|int-only|free-principal|no-principal|principal holiday|franchise de capital|interets? seuls|periode sans capital)\b/;

// Additional slot words and the conservative plain-label vocabulary.
export const LOAN_SLOTS = {
  ltc: /\b(?:ltc|loan[- /]to[- /]cost|pret[- /]cout)\b/,
  coverage: /\b(?:dscr|dcr|rcd|rcsd|ccd|coverage|couverture)\b/,
  covenant: /\b(?:min\w*|covenant|promise|engagement)\b/,
  ltv: /\b(?:ltv|loan[- ]to[- ]value|pret[- ]valeur|rpv|quotite|dimensionnement)\b/,
  principalPeriod: /\b(?:principal|capital|int-only|interets?)\b/,
  term: /\b(?:terms?|termes?|maturity|echeance)\b/,
  amount: /\b(?:principal|capital|cash|proceeds)\b/,
  declined: /\b(?:declin\w*|refus\w*|reject\w*)\b/,
  amortizationTerm: /\b(?:terms?|termes?|renewal|renouvellement)\b/,
  coverageType: /\b(?:dscr|dcr|rcd|rcsd|ccd)\b/,
  plainAttributes: /\b(?:loan[- /]to[- /]cost|ltc|ltv|minimum|dscr|covenant|term(?:e)?s?)\b/g,
  plainSubjects: /\b(?:second|junior|mezzanine|refinance|refinancement|rang|de|du|d|la|le|the)\b/g,
};

export const PLAIN_LOAN_WORDS = [IO_WORD, LOAN_PERIOD, REPAYMENT_WORD, OTHER_LENDER, DECLINED_AFTER, LENDER_TEST, OTHER_RATE, NOT_SENIOR_LENDER, SENIOR_RANK, LOAN_NOUN, LENDING_WORD, PRICE_WORD].map(words => new RegExp(words.source, "g"));
