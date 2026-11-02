// What Agir says a document looks like, keyed by the `kind` names in packages/extraction/src/document-kind.ts (card 189).
// Each label holds its article. "unrecognized document" has no entry: there is nothing useful to say about it.
export const DOCUMENT_KINDS: Record<string, { en: string; fr: string }> = {
  "term sheet": { en: "a term sheet", fr: "une lettre d'offre" },
  "commitment letter": { en: "a commitment letter", fr: "une lettre d'engagement" },
  "credit letter": { en: "a credit letter", fr: "une lettre de crédit" },
  "cost budget": { en: "a cost budget", fr: "un budget de coûts" },
  "rent roll": { en: "a rent roll", fr: "un état des loyers" },
  "pro forma": { en: "a pro forma", fr: "un pro forma" },
  "application form": { en: "an application form", fr: "un formulaire de demande" },
  "email or letter": { en: "an email or letter", fr: "un courriel ou une lettre" },
  "mortgage-fund offering": { en: "a mortgage fund offering", fr: "une offre de fonds hypothécaire" },
  "portfolio offering": { en: "a portfolio offering", fr: "une offre de portefeuille" },
  "portfolio business plan": { en: "a portfolio business plan", fr: "un plan d'affaires de portefeuille" },
  "portfolio listing": { en: "a portfolio listing", fr: "une annonce de portefeuille" },
  "market report": { en: "a market report", fr: "un rapport de marché" },
  "organization budget": { en: "an organization's budget", fr: "un budget d'organisme" },
  strategy: { en: "a strategy document", fr: "un document de stratégie" },
  guidebook: { en: "a guidebook", fr: "un guide" },
  audit: { en: "an audit", fr: "un rapport de vérification" },
  "policy research": { en: "policy research", fr: "une recherche sur les politiques" },
  "prototype feasibility study": { en: "a feasibility study for a prototype", fr: "une étude de faisabilité sur un prototype" },
  "multi-property court record": { en: "a court record covering several properties", fr: "un dossier judiciaire sur plusieurs immeubles" },
  "blank template": { en: "a blank template", fr: "un modèle vierge" },
  appraisal: { en: "an appraisal", fr: "une évaluation" },
  "offering memorandum for one project": { en: "an offering memorandum for one project", fr: "une notice d'offre pour un seul projet" },
  "broker brochure": { en: "a broker brochure", fr: "une brochure de courtier" },
  "single-project court record": { en: "a court record for one project", fr: "un dossier judiciaire sur un seul projet" },
  "council report": { en: "a council report", fr: "un rapport au conseil" },
  "business plan": { en: "a business plan", fr: "un plan d'affaires" },
  "geotechnical report": { en: "a geotechnical report", fr: "un rapport géotechnique" },
  "environmental report": { en: "an environmental report", fr: "un rapport environnemental" },
  "operating statement": { en: "an operating statement", fr: "un état des résultats d'exploitation" },
  "purchase agreement": { en: "a purchase agreement", fr: "une convention d'achat" },
  "cost report": { en: "a cost report", fr: "un rapport de coûts" },
  "tax assessment": { en: "a tax assessment", fr: "un avis d'évaluation foncière" },
  "draw schedule": { en: "a draw schedule", fr: "un calendrier de déboursés" },
};

export type ReadRole = { kind: string; role: "deal source" | "evidence" | "context"; byPerson: boolean };

/** `read_role` is stored as `market report (context)` or `market report (context, set by a person)`. */
export function parseReadRole(readRole: string | null | undefined): ReadRole | null {
  const m = /^(.*) \((deal source|evidence|context)(, set by a person)?\)$/.exec(readRole ?? "");
  return m ? { kind: m[1]!, role: m[2] as ReadRole["role"], byPerson: m[3] !== undefined } : null;
}
