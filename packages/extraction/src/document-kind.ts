import type { NormalizedDocument } from "./document.ts";
import type { ExtractionResult } from "./candidates.ts";
import { foldText } from "./mapping.ts";

type Fingerprint = { kind: string; role: "deal source" | "evidence" | "context"; title: RegExp; support?: RegExp; structure?: "contents" | "addresses" | "blank"; heading?: boolean };
/** Title words and a separate content/structure signal are required for every context kind. */
export const FINGERPRINTS: Fingerprint[] = [
  { kind: "term sheet", role: "deal source", title: /\b(?:term sheet|fiche de modalites)\b/ },
  { kind: "commitment letter", role: "deal source", title: /\b(?:commitment letter|letter of commitment|(?:takeout|financing|mortgage|loan|construction) commitment|lettre d.engagement|engagement de (?:financement|pret))\b/ },
  { kind: "credit letter", role: "deal source", title: /\b(?:credit (?:letter|agreement)|convention de credit|lettre de credit)\b/ },
  { kind: "cost budget", role: "deal source", title: /\b(?:project cost budget|construction budget|cost budget|budget des couts|budget de construction)\b/ },
  { kind: "rent roll", role: "deal source", title: /\b(?:rent roll|etat des loyers|market rent survey for \d+)\b/ },
  { kind: "pro forma", role: "deal source", title: /\bpro\s*forma\b/ },
  { kind: "application form", role: "deal source", title: /\b(?:application form|submission request form|formulaire de demande)\b/ },
  { kind: "email or letter", role: "deal source", title: /^(?:from|to|subject|objet|de|a)\s*:|\b(?:dear|madame|monsieur)\b/m },
  { kind: "mortgage-fund offering", role: "context", title: /\b(?:mortgage investment corporation|mortgage fund|fonds hypothecaire)\b/, support: /\b(?:mortgage (?:investment )?portfolio|portefeuille de prets hypothecaires)\b/ },
  { kind: "portfolio offering", role: "context", title: /\b(?:offering memorandum|offering statement|notice d.offre)\b/, support: /\b(?:invest in a portfolio of (?:projects|properties)|investissons dans un portefeuille de projets)\b/ },
  { kind: "portfolio business plan", role: "context", title: /\b(?:business plan|plan d.affaires)\b/, support: /\b(?:future acquisitions|acquisitions and expansions|acquisitions futures|acquisitions et expansions)\b/ },
  { kind: "portfolio listing", role: "context", title: /\b(?:for sale|a vendre)\b/, support: /\b(?:properties|buildings|immeubles)\b[\s\S]{0,100}\b(?:separately|individually|separement)\b/ },
  { kind: "market report", role: "context", title: /\b(?:market (?:report|update)|rental apartment review|rapport (?:de|du) marche|bulletin du marche)\b/, support: /\b(?:vacancy rate|market trends|sales volume|statistiques locatives|taux d.inoccupation)\b/ },
  { kind: "organization budget", role: "context", title: /\b(?:budget notes|financial plan|plan financier|budget de l.organisme)\b/, support: /\b(?:operating portfolios|portfolio of social housing|consolidated operations|operations consolidees|portefeuilles d.exploitation)\b/ },
  { kind: "strategy", role: "context", title: /\b(?:development design strategy|housing strategy|strategie de logement)\b/, support: /\b(?:(?:several|five|multiple) (?:[a-z]+ ){0,4}projects|plusieurs projets)\b/ },
  { kind: "guidebook", role: "context", title: /\b(?:guidebook|guide|manual|manuel)\b/, structure: "contents" },
  { kind: "audit", role: "context", title: /\b(?:auditor general|verificateur general)\b/, structure: "contents" },
  { kind: "policy research", role: "context", title: /\b(?:research|recherche)\b/, support: /\b(?:asset class|census metropolitan|classe d.actifs|region metropolitaine)\b/ },
  { kind: "prototype feasibility study", role: "context", title: /\b(?:feasibility study|regulatory changes|zoning rules|etude de faisabilite|changements reglementaires)\b/, support: /\b(?:prototypes?|whitecard|pro forma scenarios|batiments types)\b/ },
  { kind: "multi-property court record", role: "context", title: /\b(?:court file|superior court|dossier de cour|cour superieure)\b/, structure: "addresses" },
  { kind: "blank template", role: "context", title: /\b(?:application form|submission request form|formulaire de demande)\b/, structure: "blank" },
  // "Subject to a satisfactory appraisal" is a condition, not a title: an appraisal names itself in a heading.
  { kind: "appraisal", role: "evidence", heading: true, title: /^(?:(?:narrative |summary )?appraisal(?: report)?(?: of\b)?|rapport d.evaluation|evaluation (?:de la propriete|immobiliere))\b/ },
  { kind: "offering memorandum for one project", role: "evidence", title: /\b(?:offering memorandum|offering statement|notice d.offre|45-106|subscription|units of the partnership|the issuer|risk factors|souscription)\b/ },
  { kind: "broker brochure", role: "evidence", heading: true, title: /^(?:for sale|forward sale|offering|a vendre|investment opportunity|broker brochure|brochure immobiliere)\b/, support: /\b(?:exclusive listing|listed by|advisors|asking price|pricing guidance|offers will be|prix demande|inscription exclusive)\b|(?=[\s\S]*\b(?:real estate corporation|brokerage|courtier immobilier|agence immobiliere)\b)(?=[\s\S]*(?:@|\d{3}[- .]\d{3}[- .]\d{4}))/ },
  { kind: "single-project court record", role: "evidence", title: /\b(?:court file|superior court|receiver.s report|dossier de cour|cour superieure|rapport du sequestre)\b/ },
  { kind: "council report", role: "evidence", title: /\b(?:council report|loan approval recommendation|rapport au conseil)\b/ },
  { kind: "business plan", role: "evidence", title: /\b(?:business plan|plan d.affaires)\b/ },
];

const CONTEXT_PREFIX = /^This document looks like a [^;]+; its figures are shown, not read\. /;
/** Keep the previous refusal/suggestion boundary in the existing persisted note. */
export const originalKindNote = (note: string | null | undefined): string => (note ?? "").replace(CONTEXT_PREFIX, "");
const contextNote = (kind: string, note?: string) => `This document looks like a ${kind}; its figures are shown, not read. ${note ?? "No field matches this label"}`;

export function documentKind(doc: NormalizedDocument): Pick<Fingerprint, "kind" | "role"> {
  const first = doc.lines.filter(l => Number(/page (\d+)/.exec(l.location)?.[1] ?? 1) <= 3).slice(0, 120);
  const head = foldText(first.map(l => l.text).join("\n") + "\n" + doc.tables.map(t => t.name).join("\n"));
  const primary = foldText(doc.lines.slice(0, 16).map(l => l.text).join("\n") + "\n" + doc.tables.map(t => t.name).join("\n"));
  const body = foldText(doc.fullText || doc.lines.map(l => l.text).join("\n"));
  const source = FINGERPRINTS.find(f => f.role === "deal source" && f.title.test(primary));
  const fallback = source ?? { kind: "unrecognized document", role: "deal source" as const };
  // An email, bank case or other brief text has insufficient structure for a context verdict.
  if (body.split(/\s+/).length < 80) return fallback;
  if (source && !["application form", "email or letter"].includes(source.kind)) return source;
  const addressPattern = /\b\d{1,5}[ \t]+(?:[\p{L}'’-]+[ \t]+){1,4}(?:street|road|avenue|lane|drive|boulevard|parkway|crescent|court|terrace|st|rd|ave|dr|blvd)\b|\b\d{1,5}[ \t]+(?:rue|chemin)[ \t]+(?:[\p{L}'’-]+[ \t]*){1,4}/gu;
  const addressKey = (address: string) => address.replace(/\b(?:street|road|avenue|drive|boulevard)$/, word => ({street: "st", road: "rd", avenue: "ave", drive: "dr", boulevard: "blvd"})[word]!);
  const mentions = new Map<string, number>(), offices = new Set<string>();
  for (const line of doc.lines) {
    const text = foldText(line.text);
    for (const match of text.matchAll(addressPattern)) {
      const address = addressKey(match[0]);
      // Suite-number contact blocks identify an office, not the subject property.
      if (/\b(?:suite|bureau|counsel|solicitors?|avocats?)\b/.test(text)) offices.add(address);
      mentions.set(address, (mentions.get(address) ?? 0) + 1);
    }
  }
  for (const office of offices) mentions.delete(office);
  const counts = [...mentions.values()].sort((a, b) => a - b);
  const median = counts.length ? (counts[Math.floor((counts.length - 1) / 2)]! + counts[Math.floor(counts.length / 2)]!) / 2 : 0;
  const projectNames = doc.lines.map(l => /^(?:project|property|projet|immeuble)\s*:\s*([^\d:]{3,80})$/u.exec(foldText(l.text.trim()))?.[1]?.trim()).filter((name): name is string => Boolean(name));
  // A repeatedly named subject remains one deal despite incidental addresses.
  const dominant = counts.some(n => n >= 3 * median) || projectNames.some(name => body.split(name).length - 1 >= Math.max(3, 3 * median));
  const headings = first.filter(l => l.text.trim().split(/\s+/).length <= 14 && !/[.!?]$/.test(l.text.trim())).map(l => foldText(l.text.trim()));
  const structure = {
    contents: /\b(?:table of contents|contents|table des matieres|sommaire)\b/.test(body),
    addresses: /\b(?:the properties|portfolio|les immeubles|portefeuille immobilier)\b/.test(headings.join("\n")) || mentions.size >= 6 && !dominant,
    blank: doc.lines.filter(l => /^[\p{L}][^\d$]{1,80}:\s*$/u.test(l.text.trim())).length >= 3 && !/\b(?:purchase price|prix d.achat)\b/.test(body),
  };
  return FINGERPRINTS.find(f => f.role === "context" && f.title.test(head) && (!f.support || f.support.test(body)) && (!f.structure || structure[f.structure]))
    ?? FINGERPRINTS.find(f => f.role === "evidence" && (f.heading ? headings.some(h => f.title.test(h)) : f.title.test(head)) && (!f.support || f.support.test(body))) ?? fallback;
}

const EXCLUDED_SECTION = /^(?:comparable (?:sales|rents)|market (?:overview|analysis)|demographics|about (?:the )?(?:broker|sponsor)|development team|track record|definitions|risk factors|(?:issuer.s? )?financial statements|balance sheet|table of contents|contents|ventes comparables|loyers comparables|apercu du marche|analyse du marche|demographie|a propos du (?:courtier|promoteur)|equipe de developpement|realisations|definitions|facteurs de risque|etats financiers|bilan|table des matieres)\b/;
const SUBJECT_SECTION = /^(?:project (?:budget|summary|description|financing)|property (?:summary|description)|development budget|construction costs|sources (?:and uses|of funds)|rent roll|suite mix|pro\s*forma|financial plan|executive summary|budget du projet|description du projet|sources de financement|etat des loyers|sommaire executif)\b/;

export function applyDocumentKind(doc: NormalizedDocument, result: ExtractionResult): void {
  const {kind, role} = documentKind(doc);
  result.notes.push(`Document kind: ${kind} (${role})`);
  for (const c of [...result.candidates, ...result.other]) if (c.region) c.region.kind = `${kind} (${role})`;
  if (role === "deal source") return;
  if (role === "context") {
    result.other = [...result.other.map(c => ({...c, note: contextNote(kind, c.note)})), ...result.candidates.map(c => ({...c, fieldKey: null, itemKey: null, note: contextNote(kind)}))];
    result.candidates = [];
    return;
  }
  const sections = new Map<string, string>();
  let section = "";
  for (const line of doc.lines) {
    const text = foldText(line.text.trim().replace(/^\d+(?:\.\d+)*[.)]?\s+/, ""));
    const heading = text.split(/\s+/).length <= 14 && !/[$%]|\d[,.]\d|[.!?]$/.test(text);
    const contents = /\.\s*\.\s*\./.test(text) && /\d\s*$/.test(text);
    if (heading && !contents) {
      const excluded = EXCLUDED_SECTION.exec(text);
      if (excluded) section = excluded[0];
      else if (SUBJECT_SECTION.test(text) || /^\d+(?:\.\d+)*[.)]?\s+/.test(line.text)) section = "";
    }
    // dealFigures already rejects contents entries using the audited dot-leader run rule.
    sections.set(line.location, section);
  }
  for (const table of doc.tables) {
    const section = EXCLUDED_SECTION.exec(foldText(table.name))?.[0] ?? (table.at ? sections.get(doc.lines[table.at - 1]?.location ?? "") : "");
    if (section) for (const row of table.rows) for (const cell of row) sections.set(cell.ref, section);
  }
  result.candidates = result.candidates.filter(c => {
    const section = sections.get(c.location);
    if (section) {
      result.other.push({...c, fieldKey: null, itemKey: null, note: `The ${section} section of a ${kind}; its figures are shown, not read`});
      return false;
    }
    c.note = `Read from a ${kind}; check it${c.note ? `. ${c.note}` : ""}`;
    return true;
  });
}
