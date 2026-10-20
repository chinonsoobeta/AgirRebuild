import { GROWTH_WORD, CONCEPTS, LOAN_NOUN, STATED_TOTAL } from "./concepts.ts";
import { FIELD_BY_KEY, OUTPUT_LIKE_PHRASES } from "@agir/contracts";
import { detectFormat, normalizeText, SF_PER_M2, tokenize, unitTypesIn, wholeUnitType, type CurrencyCode, type DocumentFormat, type NumberToken } from "@agir/numbers";
import type { Cell, NormalizedDocument, Table } from "./document.ts";
import { BASIS_AFTER_RE, CREDIT_NOTE, REPLACED_LOAN, DEPOSIT_NOTE, DEPOSIT_RE, LTV_BASIS, canonicalItem, costSentence, currencyOf, flagRead, flagSentence, hasPhrase, isOperatingTarget, isExitCapLabel, isTakeoutTimingLabel, isPlainRentLabel, loanNameOnly, loanTerm, mapToken, normalizeLabel, withoutTaxBasis, OLD_SHEET_RE, rankScope, SCENARIO_SHEET_NOTE, SCENARIO_SHEET_RE, SUPERSEDED_LABEL_NOTE, scopeIn, scopesIn, withCurrency, type MapOptions, type Mapped, type Scope } from "./mapping.ts";

/** One value found in one document, with where it came from and why it was (or was not) mapped. */
export type Candidate = {
  fieldKey: string | null;
  itemKey: string | null;
  value: number | null;
  raw: string;
  unitSeen: string | null;
  location: string;
  context: string;
  rule: string;
  note?: string;
};

export type ExtractionResult = {
  format: DocumentFormat;
  candidates: Candidate[];
  /** Numbers found that map to nothing, or that were refused. Shown, never used. */
  other: Candidate[];
  /** What the parser could not read from the document as a whole. */
  notes: string[];
};

const TOTAL_RE = /^\s*(grand\s+)?(sub-?\s*|sous-?\s*)?total\b/i;
// A row labelled only "Total": it closes a uses table when budget lines above it name at least two budget fields and none is the stated total yet.
const BARE_TOTAL_RE = /^\s*total(?:\s+(?:uses|des\s+(?:couts|emplois)))?\s*:?\s*$/;
const closesUses = (label: string, read: Iterable<string>) => {
  const keys = new Set(read);
  return BARE_TOTAL_RE.test(fold(label)) && !keys.has("stated_total_cost") && [...keys].filter((k) => BUDGET_FIELDS.has(k)).length >= 2;
};

/** A whole year written as a bare number (1900 to 2100): the header of a row of years, not an amount. */
function isYearToken(t: NumberToken): boolean {
  return t.value !== null && t.unit === null && !t.currency && Number.isInteger(t.value) && t.value >= 1900 && t.value <= 2100;
}

function cellToken(cell: Cell, format: DocumentFormat): NumberToken | null {
  if (cell.number !== undefined) {
    return {
      raw: cell.stored === undefined ? cell.text : `${cell.text} (cell value ${cell.stored})`,
      start: 0,
      end: cell.text.length,
      value: cell.number,
      currency: cell.unit === "$",
      currencyCode: cell.currency ?? null,
      unit: cell.unit ?? null,
      scaled: false,
    };
  }
  const t = tokenize(cell.text, format, true)[0];
  if (!t || isAddress(cell.text, t)) return null;
  // A floating rate's spread is shown, never read as the rate.
  return floating(cell.text, [t])?.spreads.includes(t) ? { ...t, value: null, refusal: SPREAD_NOTE } : t;
}

// A number that is part of a street address: before a street word (with up to two capitalised name words between), or after "rue", "civic" or "no.".
const STREETS = ["road", "rd", "street", "st", "avenue", "ave", "boulevard", "blvd", "drive", "dr", "lane", "way", "crescent", "place", "rue", "chemin", "rang", "montée"];
const STREET_AFTER = new RegExp(`^\\s+(?:[A-ZÀ-Ý][\\p{L}'’-]*\\s+){0,2}(?:${STREETS.flatMap((w) => [w, w[0]!.toUpperCase() + w.slice(1)]).join("|")})(?![\\p{L}])`, "u");
const STREET_BEFORE = /(?:^|[\s,;:(])(?:rue|civic|no\.)\s*$/i;
const ADDRESS_NOTE = "A number in a street address is not a value";

function isAddress(text: string, t: NumberToken): boolean {
  return t.unit === null && !t.currency && (STREET_AFTER.test(text.slice(t.end)) || STREET_BEFORE.test(text.slice(0, t.start)));
}

// "prime + 1.25%", "P + 1.25", "CORRA + 2.1%", "taux préférentiel + 1,25 %", "préférentiel majoré de 1,25 %": an index and a spread.
const FLOAT_RE = /(?<![\p{L}\p{N}])(prime|corra|sofr|ba|p|pr[ée]f[ée]rentiel)\s*(?:\+|plus\b|major[ée]\s+de|majoration\s+de)\s*/giu;
const ALL_IN_RE = /\b(all-in|today|currently|aujourd.hui|soit|which is)\b|\bi\.e\./;
const SPREAD_NOTE = "A floating rate's spread is not the rate; enter the all-in rate";

/** The spreads (the numbers right after an index and a plus) in a text, and where the first index starts. */
function floating(text: string, tokens: NumberToken[]): { spreads: NumberToken[]; index: string; at: number } | null {
  const spreads: NumberToken[] = [];
  let first: { index: string; at: number } | null = null;
  for (const m of text.matchAll(FLOAT_RE)) {
    // A token's start may include the space before it.
    const from = m.index! + m[0].trimEnd().length;
    const t = tokens.find((x) => x.start >= from && /^\s*$/.test(text.slice(from, x.start)));
    if (!t) continue;
    spreads.push(t);
    first ??= { index: m[1]!, at: m.index! };
  }
  return first && { spreads, ...first };
}

type Base = { raw: string; location: string; context: string; rule: string };

/** The documents that are a builder's quote: there, a Total is the hard cost. */
const quoteDocs = new WeakSet<ExtractionResult>();
const QUOTE_WORD_RE = /\b(quote|quotation|estimate|tender|bid|soumission|devis)\b/;
const BUILDER_WORD_RE = /\b(builders?|contractors?|contracting|entrepreneurs?|constructeurs?|constructions?|general contractor)\b/;

/** A document whose title or first lines call it a quote, estimate, tender, bid, soumission or devis, and name a builder or contractor. */
function isBuilderQuote(doc: NormalizedDocument): boolean {
  const head = [...doc.lines.slice(0, 6).map((l) => l.text), ...doc.tables.flatMap((t) => [t.name, ...t.rows.slice(0, 2).flatMap((r) => r.map((c) => c.text))])].join(" ");
  const f = fold(head);
  return QUOTE_WORD_RE.test(f) && BUILDER_WORD_RE.test(f);
}

/** The revision a text names: "Rev B" is 2, "Rev. 3" is 3, "revised" or "révisée" alone is a half; 0 when it names none. */
function revisionOf(text: string): number {
  const f = fold(text);
  const m = /\brev(?:ision)?\.?\s*([a-z]|\d{1,2})\b/.exec(f);
  if (m) return /\d/.test(m[1]!) ? Number(m[1]) : m[1]!.charCodeAt(0) - 96;
  return /\b(revised|revisee?|revise)\b/.test(f) ? 0.5 : 0;
}
const SUPERSEDED_NOTE = "Superseded by a later revision of this quote";

function record(result: ExtractionResult, mapped: Mapped, token: NumberToken, base: Base) {
  if (mapped.kind === "field") {
    result.candidates.push({ ...base, rule: mapped.concept ? "concept" : mapped.quote ? base.rule.replace(/:[^:]*$/, ":quote-total") : base.rule, fieldKey: mapped.fieldKey, itemKey: mapped.itemKey, value: mapped.value, unitSeen: mapped.unitSeen, ...(mapped.note ? { note: mapped.note } : {}) });
  } else {
    result.other.push({
      ...base,
      fieldKey: null,
      itemKey: null,
      value: token.value,
      unitSeen: token.unit,
      note: mapped.kind === "ignored" ? mapped.reason : "No field matches this label",
    });
  }
}

function push(result: ExtractionResult, label: string, token: NumberToken, location: string, context: string, rule: string, opts: MapOptions = {}) {
  record(result, mapToken(label, token, quoteDocs.has(result) ? { quote: true, ...opts } : opts), token, { raw: token.raw, location, context: context.slice(0, 240), rule });
}

/** The [start, end) of every balanced "( ... )" in a line. */
function parenSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const open: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") open.push(i);
    else if (text[i] === ")" && open.length > 0) {
      const from = open.pop()!;
      if (open.length === 0) spans.push([from, i + 1]);
    }
  }
  return spans;
}

type Paragraph = { text: string; segs: { start: number; location: string }[]; scope: Scope | undefined; excluded: boolean };

const SUBJECT_RE = /^(subject|re|objet|object)\s*:/i;
const REPLY_PREFIX_RE = /^\s*(subject|re|objet|object|fwd?|tr|réf|ref)\s*:\s*/i;
/** A line ends a sentence unless its last word is an abbreviation ("S.E.C.", "Corp.", "Ltd."). */
const endsSentence = (text: string) => /[.!?]$/.test(text) && !/(\b\p{L}(\.\p{L})+\.|\b(corp|inc|ltd|co|cie|s\.a)\.)$/iu.test(text);

/** The first rank row among label/value lines or table rows: the loan the document is about when nothing else names one. */
function rankIn(doc: NormalizedDocument): Scope | null {
  for (const line of doc.lines) {
    const m = /^([^:|\t]{1,40})[:|\t]\s*(.+)$/.exec(line.text.trim());
    const r = m ? rankScope(m[1]!, m[2]!) : null;
    if (r) return r;
  }
  for (const t of doc.tables) {
    const r = tableRank(t);
    if (r) return r;
  }
  return null;
}
const tableRank = (t: Table): Scope | null => {
  for (const row of t.rows) {
    const cells = row.filter((c) => c.text);
    const r = cells.length >= 2 ? rankScope(cells[0]!.text, cells.slice(1).map((c) => c.text).join(" ")) : null;
    if (r) return r;
  }
  return null;
};

// A loan named only inside a condition does not establish a sentence or document scope.
const unconditioned = (x: string) => x.replace(/(?:^|[\s,;(])(?:if|unless|should|until|in case|si|sauf si|à moins qu\S*|a moins qu\S*)\s[^,;]*/giu, " ");

/**
 * The loan each line is about, set by a title or heading: one of the first three lines or a "Subject:" / "Re:" / "Objet :" line
 * (forward and reply prefixes stripped, any length, numbers allowed), or a short line with no number and no sentence end.
 * A heading that names two loans sets none. A document whose headings name no loan uses its rank row, if any.
 * Only without either, two distinct unconditional refinance lines establish refinance scope, provided no line names
 * a senior/mezzanine loan or a use of construction other than a date/milestone. Otherwise scope stays unstated (generic terms default to senior).
 * Inline labels and per-sentence loan names still take precedence over this document fallback.
 */
function lineScopes(doc: NormalizedDocument, format: DocumentFormat, rank: Scope | null): (Scope | undefined)[] {
  let first = 0;
  const headings = doc.lines.map((line) => {
    const text = line.text.trim();
    if (!text) return null;
    const near = first++ < 3;
    const subject = SUBJECT_RE.test(text);
    let body = text;
    if (subject) while (REPLY_PREFIX_RE.test(body)) body = body.replace(REPLY_PREFIX_RE, "");
    const words = body.split(/\s+/).length;
    const plain = !endsSentence(text) && !/:\s*\S/.test(body) && tokenize(text, format).length === 0;
    // "Take-out: Prairie Credit Union permanent loan": a short label that names the refinance, with words but no number, opens that section.
    const label = /^([^:]{1,40})\s*:\s*(\S.*)$/.exec(text);
    if (!subject && label && label[1]!.trim().split(/\s+/).length <= 4 && !endsSentence(text) && tokenize(label[2]!, format).length === 0) {
      const name = fold(label[1]!).trim();
      if (name === "sortie" || scopeIn(name, false) === "refinance") return "take-out";
    }
    const h = subject ? (!endsSentence(text) ? body : null) : (near && words <= 14 && plain) || (words <= 8 && plain) ? body : null;
    // "Sortie" on its own line is the take-out; "exit" alone is not (an exit cap rate is not a loan).
    return h !== null && fold(h).trim() === "sortie" ? "take-out" : h;
  });
  const named = headings.some((h) => h !== null && scopeIn(h, false) !== null);
  let scope: Scope | undefined = named ? undefined : (rank ?? undefined);
  if (!named && !rank) {
    const refinanceLines = doc.lines.filter((line) => scopesIn(unconditioned(line.text)).includes("refinance")).length;
    const blocked = doc.lines.some((line) => scopesIn(line.text).some((loan) => loan !== "refinance")
      || /\bconstruction\b/.test(fold(line.text).replace(
        /\b(?:construction\s+(?:start(?:s|ed)?|begins|completion|completes|completed|commencement|end)|(?:debut|fin|achevement)\s+de la construction)\b/g, " ")));
    if (refinanceLines >= 2 && !blocked) scope = "refinance";
  }
  return headings.map((h) => {
    if (h !== null) scope = scopeIn(h, !rank || named) ?? scope;
    return scope;
  });
}

/** A line joins the next when it does not end a sentence and the next continues it (lower case, a number or a currency sign). */
function continues(prev: string, next: string): boolean {
  // A list item ("2) ...", "- ...") starts its own paragraph.
  if (/[.!?:]\s*$/.test(prev) || !/^(\p{Ll}|\d|[$€£])/u.test(next) || /^(\d{1,2}[.)]|[-•*])\s/.test(next)) return false;
  return !(/[\d%](?:\s*(?:\$?\/(?:mo|month|yr|year|sf|mois)|per (?:month|year)|sf|units|suites|doors|par (?:mois|an)|logements|pi²|m²))?\s*$/.test(fold(prev)) && /^[\d$€£]/.test(next));
}

/** The lines the table reader did not consume, with a sentence wrapped across lines made one paragraph. */
function paragraphs(doc: NormalizedDocument, skip: Set<number>, scopes: (Scope | undefined)[], excluded: boolean[]): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  let prev = "";
  doc.lines.forEach((line, li) => {
    if (skip.has(li)) {
      cur = null;
      return;
    }
    const text = line.text.trim();
    if (cur && continues(prev, text)) {
      cur.segs.push({ start: cur.text.length + 1, location: line.location });
      cur.text += " " + text;
    } else {
      cur = { text, segs: [{ start: 0, location: line.location }], scope: scopes[li], excluded: excluded[li]! };
      out.push(cur);
    }
    prev = text;
  });
  return out;
}

const ABBREVIATIONS = new Set(["ltd", "inc", "approx", "incl", "excl", "st", "ste", "no", "corp", "co", "cie", "ave", "dr", "mr", "mrs", "ms", "mme", "vs", "etc", "est", "apt", "blvd", "rev", "rév"]);

/** Split on . ! ? followed by a space and an upper-case letter or the end, never after a one-letter initial or an abbreviation; a ";" always ends a clause, so a label in one clause never labels a number in another. */
function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let from = 0;
  const add = (to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), start: from + lead });
    from = to;
  };
  for (const m of text.matchAll(/[.!?](?=\s+\p{Lu}|\s*$)|;/gu)) {
    const word = /(\p{L}+)$/u.exec(text.slice(0, m.index!))?.[1] ?? "";
    if (m[0] === "." && (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase()))) continue;
    add(m.index! + 1);
  }
  add(text.length);
  return out;
}

const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const REPLACED_LOAN_AFTER_RE = new RegExp(String.raw`^\s+${REPLACED_LOAN}`);
// "Replaces the construction loan estimate of $4,600,000" replaces a figure.
const FIGURE_NOUN_RE = /\b(?:estimates?|amounts?|figures?|quotes?|budgets?|rates?|numbers?|costs?|montants?|estimations?|taux|chiffres?|couts?|soumissions?)\b/;
const NOT_PART_NOTE = "Marked as not part of this deal";
const MEMO_SECTION_RE = /^(?:memos?|notes?|info|for information|pour memoire|pour information)\s*:?$/;
// "Notes" or "Info" alone may be a sheet's only category column, holding its inputs; it marks rows only beside another category.
const WEAK_MEMO_SECTION_RE = /^(?:notes?|info)\s*:?$/;
// "taxes excluded" and "excluded: HST" describe an amount's basis, not the row.
const TAX_WORDS = String.raw`(?:taxes?|hst|gst|pst|qst|tps|tvq|tva|vat|sales tax)`;
const EXCLUDED_WORD = String.raw`exclu(?:ded|e?s?)`;
const TAX_BASIS_RE = new RegExp(String.raw`\b${TAX_WORDS}\s+(?:(?:is|are|est|sont)\s+)?${EXCLUDED_WORD}\b|\b${EXCLUDED_WORD}\s*(?:de\s+|of\s+|:\s*)?(?:les\s+)?${TAX_WORDS}\b`, "g");
const NOT_PART_RE = new RegExp(
  [
    String.raw`\b${EXCLUDED_WORD}\b`,
    String.raw`\b(?:retired|replaced)\b`,
    // Folded "retiré" and "remplacé" are also the verbs "retire" and "remplace"; a label ending is the exclusion, not "to retire the loan".
    String.raw`\b(?:retiree?s?|remplacee?s?)\b(?=\s*(?:$|[:;,)]))`,
    String.raw`\billustrati(?:ve|fs?|ves|ons?)\b`,
    // A scenario other than the base case: "not the base case", a lender's, downside or alternate case, a sensitivity.
    String.raw`\bnot (?:the |our |a )?base(?: |-)?case\b`,
    String.raw`\b(?:lender|bank|downside|upside|alternate|alternative|stress(?:ed)?|sensitivity|worst|best)(?: |-)(?:case|scenario)s?\b`,
    String.raw`\b(?:pas le|hors du?|autre que le) (?:cas|scenario) de base\b`,
    String.raw`\b(?:cas|scenario) (?:du preteur|de la banque|pessimiste|optimiste|alternatif|de rechange|de sensibilite)\b`,
    String.raw`\b(?:for|pour) illustrat\w*`,
    String.raw`\b(?:for (?:reference|comparison)|(?:reference|comparison) only|pour (?:reference|comparaison)|(?:reference|comparaison) seulement)\b`,
    String.raw`\ba titre (?:indicatif|illustratif|d['’]exemple|de reference|de comparaison)\b`,
    String.raw`\bnot (?:a |an )?(?:currently )?(?:modell?ed )?input\b`,
    String.raw`\bnot currently modell?ed\b`,
    String.raw`\b(?:for (?:information|reference) only|memo items?|pour information seulement)\b`,
    String.raw`\bmemo only\b|\(\s*memo\s*\)|^\s*memo\s*:|\bpour memoire\b|(?<!\d\s?)(?<![\w.@/])p\.m\.(?![\w@/])`,
    String.raw`\bnot (?:included in the total|in (?:the )?total)\b|\bhors total\b|\bnon inclus(?:e|es|s)? dans le total\b`,
    String.raw`\bnot (?:a )?part of\b`,
    String.raw`\bnot included in (?:the |this |our |that )?(?:project|deal|transaction|budget|scope)\b`,
    String.raw`\bne (?:fait|font) pas partie\b`,
    String.raw`\bnon retenu(?:e|s|es)?\b`,
    // An unused scenario or a discarded option.
    String.raw`\bunused scenarios?\b|\bscenarios? not (?:used|pursued)\b|\bnot pursued\b|\b(?:rejected option|option rejected)\b|\boptions?(?: [a-z0-9])?\s*\(?rejected\b|\bdiscarded\b|\bsuperseded\b(?! by)|\bno longer applies\b`,
    String.raw`\boption ecartee?s?\b|\babandonne(?:e|s|es)?\b|(?:[(:;,]\s*|\b(?:est|sont|ete) )remplace(?:e|s|es)?\b`,
    String.raw`\bnon inclus(?:e|es)? (?:dans|au) (?:le |ce |la |cette )?(?:projet|budget|transaction)\b`,
    String.raw`\bhypothe(?:tical|tiques?)\b`,
    String.raw`\bnot (?:yet )?committed\b`,
    String.raw`\bnon engage(?:e|s|es)?\b`,
  ].join("|"),
);
const EXAMPLE_RE = /\b(?:examples?|exemples?)\b/g;
// An address ("Example Street", "rue de l'Exemple"), a company name ("Example Corp"), "for example" and "par exemple" are no marker.
const EXAMPLE_BEFORE = /(?:\bfor|\bpar|\b(?:rue|avenue|av|boulevard|boul|chemin|route|place|rang)(?:\s+(?:de l['’]|de la |du |des |d['’]))?)\s*$/;
const EXAMPLE_AFTER = /^\s+(?:street|st|ave|avenue|road|rd|drive|dr|way|blvd|boulevard|lane|ln|crescent|court|place|plaza|park|square|building|tower|inc|corp|ltd|llc|group|holdings|properties|developments|capital|realty|homes)\b/;

const ADDRESS_LIKE_RE = /\S*@\S*|(?<![\p{L}\p{N}])[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+(?:\/\S*)?/gu;

/** Whether a row, line or heading says, in English or French, that its figures are an example, for reference, or not part of the deal. */
function markedNotPart(text: string): boolean {
  // A word joined to a dot or an @ with no space is part of an e-mail address, a domain or a web address, not a marker (task 55).
  const f = fold(text).replace(TAX_BASIS_RE, " ").replace(ADDRESS_LIKE_RE, (s, at: number, all: string) => s === "p.m" && all[at + s.length] === "." ? s : " ");
  if (NOT_PART_RE.test(f)) return true;
  return [...f.matchAll(EXAMPLE_RE)].some((m) => !EXAMPLE_BEFORE.test(f.slice(0, m.index)) && !EXAMPLE_AFTER.test(f.slice(m.index! + m[0].length)));
}

/** Per line: it falls under a heading (a short line with no number or sentence end) that marks its section as not part of the deal; the next heading ends the section. */
function excludedLines(doc: NormalizedDocument, format: DocumentFormat): boolean[] {
  let on = false;
  return doc.lines.map((line) => {
    const text = line.text.trim().replace(/^#+\s*/, "");
    const heading = text !== "" && text.split(/\s+/).length <= 10 && !endsSentence(text) && !/:\s*\S/.test(text) && tokenize(text, format).length === 0;
    if (heading) on = markedNotPart(text);
    return on;
  });
}

const HEDGE_RE = /\b(i.?d guess|i guess|or so|probably|maybe|perhaps|roughly|ballpark|not confirmed|unconfirmed|to be confirmed|tbc|a confirmer|je pense|peut-etre|somewhere|around about|give or take|or thereabouts|quelque part|environ [^.;]*ou plus)\b|(?:\d|-)ish\b/;
const BORROWED_RE = /\b(my other (?:building|property)s?|another (?:property|building)|comparables?|comps|autres? immeubles?|(?:the )?(?:neighbou?ring|nearby|adjacent) (?:building|property|project|tower|block)s?|(?:the )?(?:building|property|project) next door|immeubles? voisins?|projets? voisins?)\b/;
const YEAR_BEFORE = /\b(the|for|pour|fiscal|fy|budget|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|in|en|since|depuis)\.?[,\s]*$/;
const YEAR_AFTER = /^\s*(budget|premium|taxes|operating)\b/;

/** A bare four-digit number from 1900 to 2100 is a year when the line has a currency mark, or a word around it says so. Tables keep their own rule. */
function isYear(text: string, tokens: NumberToken[], t: NumberToken): boolean {
  if (t.unit !== null || t.currency || t.value === null || !/^\d{4}$/.test(t.raw) || t.value < 1900 || t.value > 2100) return false;
  return tokens.some((o) => o !== t && o.currency) || YEAR_BEFORE.test(fold(text.slice(0, t.start))) || YEAR_AFTER.test(fold(text.slice(t.end)));
}
const RANGE_NOTE = "A range is not a value; enter the figure to use";

/** Why a sentence's numbers are no inputs, when it says so: a hedge, another property or an output figure. */
function sentenceRefusal(text: string): string | null {
  // An output figure comes first: it is the oldest reason, and the one the review screen explains.
  // "65% of the lender's valuation" names what a loan-to-value is taken of, not a valuation; one with an amount after it still does.
  const basis = new RegExp(String.raw`(?<=\d\s?%\s+)${LTV_BASIS}(?![a-z0-9]|\s+(?:of|at|is|was|de|a)?\s*[$\d])`, "g");
  const label = normalizeLabel(fold(text).replace(basis, " ")).label;
  const capLabel = text.includes(":") && isExitCapLabel(text.slice(0, text.indexOf(":")));
  const output = OUTPUT_LIKE_PHRASES.find((p) => hasPhrase(label, p) && !(p === "valuation" && capLabel) && !((p === "target" || p === "cible") && (isTakeoutTimingLabel(text) || isOperatingTarget(text))));
  if (output) return `This sentence names an output figure ("${output}"), which is never taken as an input`;
  const f = fold(text);
  if (/^footnote\s+\d+\s*:/.test(f)) return "A numbered footnote, not an assumption label";
  const hedge = HEDGE_RE.exec(f);
  if (hedge) return `A hedged figure ("${hedge[0]}") is not a value; enter the figure to use`;
  const other = BORROWED_RE.exec(f);
  return other ? `This sentence speaks of another property ("${other[0]}"); its figures are not inputs` : null;
}

/** Tokens that are the two ends of a range ("between X and Y", "from X to Y", "X - Y", "X to Y"), by index. */
// A date ("2026-09-30") or a phone number ("604-555-1234") joins numbers with dashes; it is no range.
const CODE_RE = /(?<![\d-])(?:(?:19|20)\d{2}-\d{2}(?:-\d{2})?|\d{3}-\d{3}-\d{4}|\d{3}-\d{4})(?![\d-])/g;

function rangeEnds(text: string, tokens: NumberToken[]): Set<number> {
  const out = new Set<number>();
  const codes = [...text.matchAll(CODE_RE)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const inCode = (t: NumberToken) => codes.some(([from, to]) => t.start >= from && t.end <= to);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (a.value === null || b.value === null || inCode(a) || inCode(b)) continue;
    const between = text.slice(a.end, b.start);
    const before = text.slice(0, a.start);
    const lead = /\b(from|de|d['’])\s*$/i.test(before);
    const same = a.unit === b.unit && a.currency === b.currency;
    const monthIndex = /\b(?:months?|mois)\s*$/i.test(before) && !a.currency && !b.currency && (a.unit === null || a.unit === "months") && (b.unit === null || b.unit === "months");
    const open = same || (a.unit === null && !a.currency) || monthIndex;
    // "5 - 7": the tokenizer read the dash as the second number's minus sign.
    const spaced = /^\s+[-–—]\s*$/.test(between) || (/^[-−]/.test(b.raw) && /^\s+$/.test(between));
    const isRange =
      (/^[-–—]$/.test(between) && open) ||
      (spaced && open) ||
      (/^\s+through\s*$/i.test(between) && monthIndex) ||
      (/^\s+(to|à)\s*$/i.test(between) && (open || lead)) ||
      (/^\s+(and|et)\s*$/i.test(between) && /\b(between|entre)\s*$/i.test(before));
    if (isRange) {
      out.add(i);
      out.add(i + 1);
    }
  }
  return out;
}

/** The itemized unit fields: an item for them is a unit type, never a place or a heading. */
const UNIT_FIELDS = new Set(["unit_count", "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual"]);
/** The per-unit figures of a line whose count names its unit type. */
const LINE_TYPE_FIELDS = new Set(["unit_rent_monthly", "rent_psf_annual"]);

/**
 * The words right after a number and its unit, up to a comma, semicolon, slash, bar, "and"/"et" or the end of the sentence.
 * With `nextFollows`, words that run on into the next number with no such break give none.
 */
function followingLabel(rest: string, nextFollows = false): string | null {
  if (!/^\s+\S/.test(rest)) return null;
  let cut = rest.length;
  for (const re of [/[,;:]/, /\s[/|]\s|\s[/|]$|[/|]\s/, /\s(?:and|et|then|puis)\s/i, /\s[-–—]\s/, /[.!?](?:\s|$)/]) {
    const m = re.exec(rest);
    if (m && m.index < cut) cut = m.index;
  }
  if (nextFollows && cut === rest.length) return null;
  return rest.slice(0, cut).trim() ? rest.slice(0, cut) : null;
}

// Card 111. A number of months or years at a point in time is not a duration: "six months ago", "il y a deux ans", "depuis 3 ans",
// "since", "for the past", and a sentence that opens "Three months after completion the lender ...".
const POINT_IN_TIME_NOTE = "A point in time, not a duration";
const POINT_BEFORE_RE = /(?:^|[^a-z])(?:il y a|depuis|since|for the past)\s*$/;
const AFTER_EVENT_RE = /^\s+(?:after|following|before|apres|avant)\s+(?:(?:the|la|le|l|les)\s+)?[a-z]+(?:\s+(?:of|de|du|des)\s+(?:(?:the|la|le|l|les)\s+)?[a-z]+)?\s*,?\s+(?:the|a|an|our|we|they|it|le|la|les|l|nous|on|ils|elles|il|elle|notre|un|une)\s+[a-z]/;
function pointInTime(text: string, t: NumberToken): boolean {
  if (t.unit !== "months" && t.unit !== "years") return false;
  const before = fold(text.slice(0, t.start)).replace(/[’']/g, " ");
  const after = fold(text.slice(t.end)).replace(/[’']/g, " ");
  // "Il y a 18 mois de travaux": there are eighteen months of works.
  if (/(?:^|[^a-z])il y a\s*$/.test(before) && /^\s*(?:de|d)\s/.test(after)) return false;
  return /^\s*ago\b/.test(after) || POINT_BEFORE_RE.test(before) || (/^[\s\-–—•*]*$/.test(before) && AFTER_EVENT_RE.test(after));
}

/** The clause of a sentence a number stands in: between commas, semicolons and "and" (but not after a hanging hyphen, "one- and two-bedroom"). */
function clauseOf(text: string, t: NumberToken): string {
  let from = 0;
  for (const m of text.matchAll(/[,;:]|(?<!-)\s(?:and|et|but|mais)\s/g)) {
    if (m.index! + m[0].length <= t.start) from = m.index! + m[0].length;
    else if (m.index! >= t.end) return text.slice(from, m.index!);
  }
  return text.slice(from);
}

/** A count or a monthly rent in prose, named by the one unit type its clause names ("two-bedroom", "studio", "4½"); none or several name nothing. */
function clauseItem(text: string, t: NumberToken, lead: string | null = null): Mapped | null {
  const count = t.unit === "units";
  if (t.value === null || (!count && t.unit !== "$/mo")) return null;
  const types = unitTypesIn(clauseOf(text, t));
  if (types.length === 0 && lead) types.push(lead);
  if (types.length !== 1) return null;
  return count
    ? { kind: "field", fieldKey: "unit_count", itemKey: types[0]!, value: t.value, unitSeen: "units" }
    : { kind: "field", fieldKey: "unit_rent_monthly", itemKey: types[0]!, value: t.value, unitSeen: withCurrency("$/mo", t.currencyCode) };
}

const SHARE_NOTE = "A share of another figure, not that figure";
// "Construction loan: $X at Y%": a percentage right after a loan's amount, joined by "at", "à" or "au taux de", is that loan's rate unless a basis follows it.
const AMOUNT_SCOPE: Record<string, Scope> = { senior_loan_amount: "senior", mezz_loan_amount: "mezzanine", refinance_amount: "refinance" };
const RATE_BESIDE_RE = /^\s*(?:at|à|a|au taux de)\s*$/i;
// An interest-only word after it ("at 11% interest only") leaves the figure unread, as before.
const RATE_BASIS_RE = /^\s*(?:of|de|du|des|d)\b|\b(?:ltv|ltc|loan[- ]to|ratio|dcr|dscr|pret[- ]valeur|rpv|interest[- ]only|io|interets? seulement)\b/;
const LATER_FIGURE_NOTE = "A later figure in this row; Agir reads one figure per row. Label it if it is the one to use";
const PER_UNIT_NOTE = "A per-door share of a cost, not the line's total; enter the total";
const STRUCK_NOTE = "Struck through in the document; the figure written in its place replaces it";
const PER_UNIT_REFUSED_NOTE = "The line's first figure is a price per unit; this number is not stated as its total";
const SHARE_OF_RE = /^\s*(?:of|de|du|des)\s+((?:(?:the|les?|la)\s+)?[\p{L}][\p{L}'’&/-]*(?:\s+[\p{L}'’&/-]+)*)/iu;
const SHARE_PROBE: NumberToken = { raw: "1", start: 0, end: 1, value: 1, currency: true, currencyCode: null, unit: "$", scaled: false };
const isMoney = (t: NumberToken) => t.value !== null && (t.currency || t.unit === "$");

const COMMERCIAL_RE = /\b(?:retail|commercial|office|crus?|storefronts?|commerces?|bureaux)\b/;
const BUDGET_FIELDS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost", "stated_interest_reserve"]);
const SEVERAL_NOTE = "A total of several costs, not one of them";
const NOT_SHOWN_NOTE = "Not shown to add up to the subtotal below it";
const COVERS_RE = /^\s*(?:\(\s*(?:(?:including|incl\.?|covering|comprenant|incluant|soit)\s+)?|[,;]?\s*(?:including|incl\.?|covering|comprenant|incluant|soit)\s+)/i;
const PART_CUE = String.raw`(?:included in|within|part of|already in|inclus dans|compris dans|fait partie de)`;
const budgetFieldOf = (phrase: string): string | null => {
  const m = mapToken(phrase, SHARE_PROBE, { prose: true, budget: true });
  return m.kind === "field" && m.itemKey === null && BUDGET_FIELDS.has(m.fieldKey) ? m.fieldKey : null;
};

/** The note for a figure that is part of a budget field the words name ("included in soft costs"); `anchored`: the cue starts the text, as in the words right after a figure. */
function partOfNote(text: string, anchored: boolean): string | null {
  const re = new RegExp(String.raw`${anchored ? String.raw`^[\s,;)–—-]*\(?\s*` : String.raw`(?:^|[\s(,;])`}${PART_CUE}\s+(?:(?:the|les?|la|l['’]|du|des)\s+)?([^,;)]*)`);
  const m = re.exec(fold(text));
  const key = m ? budgetFieldOf(m[1]!.replace(/-/g, " ").split(/\s(?:and|et|but|mais|which|that|qui)\b/)[0]!) : null;
  return key && `Already counted in ${FIELD_BY_KEY.get(key)!.label}`;
}

/** The budget fields a list after a figure names ("(land, construction and soft costs)"); the list is what the figure covers. */
function coveredFields(after: string): number {
  const m = COVERS_RE.exec(after);
  if (!m) return 0;
  const rest = after.slice(m[0].length);
  const list = m[0].includes("(") ? rest.split(")")[0]! : rest.split(/[.!?](?:\s|$)/)[0]!;
  return new Set(list.split(/\s*(?:[,;&+/]|\band\b|\bet\b)\s*/i).map(budgetFieldOf).filter((k) => k !== null)).size;
}

/** The base of each "X% of <field>" as [start, end): a field alias right after "of", "de", "du" or "des" following a percentage is what the share is of. */
function shareBases(text: string, tokens: NumberToken[], scope: Scope): [number, number][] {
  const bases: [number, number][] = [];
  for (const t of tokens) {
    if (t.unit !== "%") continue;
    const rest = text.slice(t.end);
    const m = SHARE_OF_RE.exec(rest);
    if (!m) continue;
    const phrase = m[1]!.split(/\s(?:and|et|but|mais|which|that|qui)\b/i)[0]!;
    const mapped = mapToken(phrase, SHARE_PROBE, { prose: true, scope });
    if (mapped.kind === "field" && mapped.itemKey === null && FIELD_BY_KEY.get(mapped.fieldKey)?.unit === "$") {
      const start = t.end + m[0].length - m[1]!.length;
      bases.push([start, start + phrase.length]);
    }
  }
  return bases;
}

// A dwelling named before or after a price makes it a share of the line's total.
const PER_DOOR_WORD = String.raw`(?:lots?|doors?|units?|suites?|homes?|houses?|townhouses?|townhomes?|row[\s-]+(?:houses?|homes?)|semis?(?:-detached)?|duplex(?:es)?|triplex(?:es)?|fourplex(?:es)?|plex|jumel[ée]s?|maisons?[\s-]+jumel[ée]es?|unifamiliales?|dwellings?|apartments?|condos?|portes?|logements?|unit[ée]s?|maisons?(?:[\s-]+(?:en[\s-]+rang[ée]es?|de[\s-]+ville))?|appartements?|terrains?)`;
const PER_DOOR_FORM = String.raw`(?:(?:per|par|each|chaque|for\s+each|pour\s+chaque)[\s-]*(?!lot\s+of\b)${PER_DOOR_WORD}|${PER_DOOR_WORD}\s+(?:each|chacune?))`;
const EACH_RE = new RegExp(String.raw`^\s*\(?\s*(?:${PER_DOOR_FORM}|each|apiece|chacune?|(?:an?|/)[\s-]*(?!lot\s+of\b)${PER_DOOR_WORD})(?![\p{L}])\)?`, "iu");
const PER_DOOR_LABEL_RE = new RegExp(String.raw`(?:(?<![\p{L}])${PER_DOOR_FORM}|/${PER_DOOR_WORD})(?![\p{L}])`, "iu");
const BUDGET_LINES = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost"]);
const PER_UNIT_FIELDS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost", "senior_loan_amount", "mezz_loan_amount", "refinance_amount", "equity_amount"]);
const TOTAL_WORD = String.raw`(?:for(?:\s+a)?(?:\s+total)?(?:\s+of)?|pour(?:\s+un\s+total\s+de)?|soit|totall?ing|in\s+total|total(?:\s+of)?|=)`;
const TOTAL_BETWEEN = [/^\s*\(\s*(?:total|soit|=)?\s*:?\s*$/i, new RegExp(String.raw`^\s*[,;]?\s*${TOTAL_WORD}\s*:?\s*\(?\s*$`, "i")];
const TOTAL_AFTER_RE = /^\s*(?:in\s+|au\s+)?total\b/i;

/** A money figure priced for one lot, door or unit: "$160,000 each", "95 000 $ par porte". */
function perUnit(text: string, t: NumberToken, label = ""): boolean {
  return t.value !== null && ((t.unit === "$" && EACH_RE.test(text.slice(t.end))) || ((t.unit === "$" || t.unit === null) && PER_DOOR_LABEL_RE.test(label)));
}

/** The clause a figure is in: from the last comma, semicolon, parenthesis or "and" before it to the first one after it. */
function clauseAround(text: string, t: NumberToken): string {
  const edge = /[,;()]|\b(?:and|et|but|mais)\b/giu;
  const before = [...text.slice(0, t.start).matchAll(edge)].at(-1);
  edge.lastIndex = 0;
  const after = edge.exec(text.slice(t.end));
  return text.slice(before ? before.index! + before[0].length : 0, after ? t.end + after.index : text.length);
}

/** A budget-line figure whose own clause says it is a deposit or an amount already paid. */
// A total that says it includes the deposit ("$900,000 including the deposit") is the total, not the deposit.
const PART_OF_RE = /\b(?:including|includes|included|incl|inclusive of|of which|y compris|incluant|comprenant|inclut|dont)\b/;
const INCLUDES_DEPOSIT_RE = /\b(?:including|includes|included|incl|inclusive of|with|y compris|incluant|comprenant|inclus)\b(?:\s+(?:the|our|a|le|la|notre|un|une)|\s+l\s*['’])?\s*(?:deposits?|down payments?|acomptes?|depots?)\b/;
const isDeposit = (text: string, t: NumberToken) => {
  if (!isMoney(t) || t.value === null || t.value <= 0) return false;
  const clause = fold(clauseAround(text, t));
  return DEPOSIT_RE.test(clause) && !INCLUDES_DEPOSIT_RE.test(clause);
};

/** The total a per-unit price states for itself: the next money figure when it sits in parentheses after the price, follows "total", "for", "soit" or "pour un total de", or is followed by "total". */
function totalOf(text: string, t: NumberToken, tokens: NumberToken[]): NumberToken | null {
  const next = tokens.find((x) => x.start >= t.end && isMoney(x));
  if (!next) return null;
  // A parenthesised token's own text starts at its "(".
  const between = (text.slice(t.end, next.start) + (next.raw.startsWith("(") ? "(" : "")).replace(EACH_RE, "");
  return TOTAL_BETWEEN.some((re) => re.test(between)) || (/^\s*[,;]?\s*$/.test(between) && TOTAL_AFTER_RE.test(text.slice(next.end))) ? next : null;
}

/** One sentence: "Label: value" gives the label to the numbers after the colon; anything else is prose. */
// A capitalised label (one to five words, title case or capitals) ending in a full stop and then a number, or a label and a run of three or more dots.
const CAP_WORD = String.raw`\p{Lu}[\p{L}'’&/-]*`;
const FULL_STOP_LABEL_RE = new RegExp(String.raw`^(${CAP_WORD}(?:\s+(?:${CAP_WORD}|of|and|de|du|des|et|la|le|les)){0,4})\.\s+(?=[-−(]?[$€£]?\s?\d)`, "u");
const LEADER_RE = /^(.*?\p{L}[^.]*?)\s*(?:\.\s*){3,}(?=\S)/u;

/** "Amount. $3,400,000" and "Reserve ..... $190,000" are written as "label: value", the same length so every position still holds. */
function labelValueForm(text: string): string {
  const stop = FULL_STOP_LABEL_RE.exec(text);
  if (stop && stop[1]!.split(/\s+/).length <= 5 && !ABBREVIATIONS.has(/(\p{L}+)$/u.exec(stop[1]!)?.[1]?.toLowerCase() ?? "")) return stop[1]! + ":" + text.slice(stop[1]!.length + 1);
  const leader = LEADER_RE.exec(text);
  return leader ? leader[1]! + ":" + " ".repeat(leader[0].length - leader[1]!.length - 1) + text.slice(leader[0].length) : text;
}

const BASE_SCENARIO_RE = /\b(?:base|selected|chosen|proposed|retenu)\s+scenarios?\b|\bscenarios?\s+(?:de base|retenu|selected|chosen|proposed)\b/g;
// A figure that follows one of these words in the same line corrects the figure before it (task 56).
const CORRECTION_RE = /\b(?:corrected|revised|amended|updated|restated|corrige\w*|revise\w*|modifie\w*|mis a jour)\b/;
// "now" corrects only the figure right after it ("now $1,030,000"), not one it merely introduces ("now including the $90,000 site prep").
const NOW_RE = /\bnow(?: at| to| is)?\s*:?\s*$/;
const corrects = (gap: string, prev: NumberToken, t: NumberToken) => (CORRECTION_RE.test(fold(gap)) || NOW_RE.test(fold(gap))) && prev.unit === t.unit && !!prev.currency === !!t.currency;

const CHANGE_FROM_RE = /(?<![\p{L}])(?:moved|went|increased|decreased|revised|changed|rose|fell|passe|pass[ée]e?s?)\s+(?:from|de|d['’])\s*$/iu;

const DASH_REMARK_RE = /^(?:that|this|which|it|these|those|ce|cela|ceci|c['’ ]?est|qui|soit)\b|\b(?:not|pas|non|n['’]t)\b/;
/** A figure-first dash item (or run of items), never a correction after a labelled amount. */
function figureDashItems(text: string, format: DocumentFormat): { token: NumberToken; label: string }[] | null {
  const tokens = tokenize(text, format);
  if (!tokens.length) return null;
  const bullet = /^[—–-]$/.test(text.slice(0, tokens[0]!.start).trim());
  if (bullet && tokens.every((t) => t.currency || t.unit === "$")) {
    const items = tokens.map((token, i) => ({ token, label: text.slice(token.end, tokens[i + 1]?.start ?? text.length).replace(/\s*[—–-]\s*$/, "").trim() }));
    return items.every((x) => /^\p{L}/u.test(x.label) && !DASH_REMARK_RE.test(fold(x.label))) ? items : null;
  }
  if (text.slice(0, tokens[0]!.start).trim()) return null;
  const items = tokens.map((token, i) => ({ token, label: /^\s+[—–]\s+(\p{L}.*)$/u.exec(text.slice(token.end, tokens[i + 1]?.start ?? text.length))?.[1]?.trim() }));
  // A clause after the dash ("that is what the lender asked for", "pas la durée des travaux") is a remark, not the figure's label.
  const remark = (label: string) => DASH_REMARK_RE.test(fold(label));
  return items.every((x) => x.label && !remark(x.label)) ? items as { token: NumberToken; label: string }[] : null;
}

function readSentence(sentence: { text: string; start: number }, para0: Paragraph, result: ExtractionResult, carried: string | null = null) {
  const text = labelValueForm(normalizeText(sentence.text));
  const quote = quoteDocs.has(result);
  // A short label that names a loan ("Take-out: ...") scopes every number on its line, the prose after the colon too; the next line is back under the document's scope.
  const label = text.slice(0, Math.max(text.indexOf(":"), 0));
  const inline = label.split(/\s+/).length <= 8 ? scopeIn(label, false) : null;
  const para = inline ? { ...para0, scope: inline } : para0;
  const conceptScope = scopeIn(para0.text.slice(0, Math.max(para0.text.indexOf(":"), 0)), false) ?? undefined;
  const locationOf = (pos: number) => para.segs.reduce((loc, g) => (g.start <= sentence.start + pos ? g.location : loc), para.segs[0]!.location);
  // A Yes/No answer after a flag's label is the flag.
  const colonAt = text.indexOf(":");
  const flag = colonAt > 0 ? flagRead(text.slice(0, colonAt), text.slice(colonAt + 1)) : null;
  if (flag) {
    result.candidates.push({ fieldKey: flag.fieldKey, itemKey: null, value: flag.value, raw: text.slice(colonAt + 1).trim(), unitSeen: "flag", location: locationOf(colonAt), context: sentence.text.slice(0, 240), rule: "line:flag" });
    return;
  }
  // A whole sentence that states a flag outright ("Draws follow an S-curve") is the flag; numbers in it are read as usual.
  const stated = para0.excluded || markedNotPart(text) ? null : flagSentence(text);
  if (stated) result.candidates.push({ fieldKey: stated.fieldKey, itemKey: null, value: stated.value, raw: stated.raw, unitSeen: "flag", location: locationOf(0), context: sentence.text.slice(0, 240), rule: "line:flag" });
  // An explicit absence of an interest-only period is zero months, in the loan's own scope.
  if (colonAt > 0 && /^\s*none[.!]?\s*$/i.test(text.slice(colonAt + 1)) && !para.excluded && !markedNotPart(text)) {
    const zero: NumberToken = { raw: text.slice(colonAt + 1).trim(), start: colonAt + 1, end: text.length, value: 0, unit: "months", currency: false, currencyCode: null, scaled: false };
    const mapped = mapToken(label, zero, { scope: para.scope });
    if (mapped.kind === "field" && /^(senior|mezz|refinance)_io_months$/.test(mapped.fieldKey)) {
      record(result, mapped, zero, { raw: zero.raw, location: locationOf(colonAt), context: sentence.text.slice(0, 240), rule: "line:label-value" });
      return;
    }
  }
  let tokens = tokenize(text, result.format);
  // A number that is part of a street address is not a value.
  const addresses = tokens.filter((t) => isAddress(text, t));
  tokens = tokens.filter((t) => !addresses.includes(t));
  // A number inside parentheses before the first number outside them is part of the label ("Parking (14 stalls) $8,400").
  const spans = parenSpans(text);
  const inParen = (t: NumberToken) => spans.some(([a, b]) => t.start >= a && t.end <= b);
  const firstOutside = tokens.find((t) => !inParen(t));
  if (firstOutside) tokens = tokens.filter((t) => !(inParen(t) && t.start < firstOutside.start));
  if (tokens.length === 0 && addresses.length === 0) return;
  const context = sentence.text.slice(0, 240);
  // A range's "5 - 7" is read with the dash as the second number's sign: shown as written, positive.
  const shown = (t: NumberToken, note: string) => (t.value !== null && t.value < 0 && note === RANGE_NOTE && /^[-−]\s*[$\d]/.test(t.raw) ? -t.value : t.value);
  const other = (t: NumberToken, rule: string, note: string) =>
    result.other.push({ fieldKey: null, itemKey: null, value: shown(t, note), raw: t.raw, unitSeen: t.unit, location: locationOf(t.start), context, rule, note });
  for (const t of addresses) other(t, "line:prose", ADDRESS_NOTE);
  const refusal = para0.excluded || markedNotPart(text) ? NOT_PART_NOTE : sentenceRefusal(text);
  if (refusal) {
    for (const t of tokens) other(t, "line:prose", refusal);
    return;
  }
  const dashItems = figureDashItems(text, result.format);
  if (dashItems) {
    for (const { token, label } of dashItems) {
      const mapped = mapToken(label, token, { scope: para.scope, budgetConcept: true, context: label, quote });
      record(result, mapped, token, { raw: token.raw, location: locationOf(token.start), context: `${token.raw} — ${label}`, rule: "line:prose" });
    }
    return;
  }
  // A year is never money: it is shown as a year.
  const years = tokens.filter((t) => isYear(text, tokens, t));
  for (const t of years) other(t, "line:prose", "This is a year, not an amount");
  tokens = tokens.filter((t) => !years.includes(t));
  // Returned equity and the equity retained afterward are not the amount contributed. "Return on equity", a return as a yield
  // ("to return 1.9x") and "the remaining $X of equity" are not a return of equity (card 71 audit).
  const returnedEquity = tokens.filter((t, i) => {
    if (!isMoney(t)) return false;
    const start = tokens[i - 1]?.end ?? 0;
    const end = tokens[i + 1]?.start ?? text.length;
    const clause = fold(clauseAround(text.slice(start, end), { ...t, start: t.start - start, end: t.end - start }));
    return /\b(?:equity|fonds propres|capitaux propres)\b/.test(clause) && /\b(?:reimburs\w*|repay\w*|repaid|return(?:s|ed|ing)?(?!\s+on\b)\s+(?:\S+\s+){0,3}?(?:to|of|equity|capital)|distribu\w*|cash(?:es|ed|ing)?[- ]outs?|tak(?:e[sn]?|ing)[- ]out|took[- ]out|leaving|left in|remaining (?:\w+ )?equity|retain(?:s|ed|ing)?|rembours\w*|remet\w*|restants?|laissant)\b/.test(clause);
  });
  for (const t of returnedEquity) other(t, "line:prose", "Equity returned or left in after a refinance, not the equity contributed");
  tokens = tokens.filter((t) => !returnedEquity.includes(t));
  if (tokens.length === 0) return;
  // A figure the sentence says is replaced by another is shown, not read.
  const folded = fold(text);
  const replacing = /\b(replaces?|replacing|supersedes?|remplace(?:nt)?)\b/.exec(folded);
  const replacedBy = /\b(replaced by|superseded by|remplacee? par)\b/.exec(folded);
  // "Passe de X à Y", "moved from X to Y" and "X → Y" say a figure was revised: Y is the current one. A bare "from X to Y" is a range.
  const revised = tokens.filter((a, i) => {
    const b = tokens[i + 1];
    if (!b || a.value === null || b.value === null || !(a.unit === b.unit && a.currency === b.currency) && !(a.unit === null && !a.currency)) return false;
    const between = text.slice(a.end, b.start);
    return /^\s*(?:→|->)\s*$/.test(between) || (/^\s+(?:to|à)\s*$/i.test(between) && CHANGE_FROM_RE.test(text.slice(0, a.start)));
  });
  // When the verb replaces a loan ("replaces the construction loan at month 28"), the figures after it are read normally.
  const loanReplaced = (t: NumberToken) => { const between = folded.slice(replacing!.index + replacing![0].length, t.start); return REPLACED_LOAN_AFTER_RE.test(between) && !FIGURE_NOUN_RE.test(between); };
  const replaced = tokens.filter((t) => revised.includes(t) || (replacing && t.start >= replacing.index + replacing[0].length && !loanReplaced(t)) || (replacedBy && t.end <= replacedBy.index));
  for (const t of replaced) other(t, "line:prose", "A later figure in the same sentence replaces this one");
  tokens = tokens.filter((t) => !replaced.includes(t));
  // A rate that an adjustment follows ("6.65% base less a 25 bps buy-down") is the figure before it, not the loan's rate.
  const unadjusted = tokens.filter((t, i) => t.unit === "%" && /\b(?:less|minus|before|net of)\b/i.test(text.slice(t.end, tokens[i + 1]?.start ?? text.length)) && /\b(?:buy-?down|discount|bps?)\b/i.test(text.slice(t.end).split(/[;.]/)[0]!));
  for (const t of unadjusted) other(t, "line:prose", "A rate before an adjustment, not the loan's rate");
  tokens = tokens.filter((t) => !unadjusted.includes(t));
  const colon = text.indexOf(":");
  // A dwelling count inside a budget label describes its total, not a preceding value.
  if (colon > 0 && budgetFieldOf(text.slice(0, colon)) !== null) {
    const counts = tokens.filter((t) => t.end <= colon && t.unit === "units");
    for (const t of counts) other(t, "line:label-value", "A dwelling count in the budget label, not its amount");
    tokens = tokens.filter((t) => !counts.includes(t));
  }
  // A figure said to be part of a budget field is shown, not added. A figure that lists two or more budget fields after it is a total of them: the stated total cost when its own label names a cost, total or budget, else shown only.
  const parts = new Set<NumberToken>();
  tokens.forEach((t, i) => {
    if (!isMoney(t)) return;
    const after = text.slice(t.end, tokens[i + 1]?.start ?? text.length);
    const counted = partOfNote(after, true);
    if (counted) {
      other(t, "line:prose", counted);
      parts.add(t);
    } else if (coveredFields(after) >= 2) {
      const prev = tokens[i - 1];
      const lab = prev || colon < 0 || colon > t.start ? text.slice(prev?.end ?? 0, t.start) : text.slice(0, colon);
      const m = mapToken(lab, t, { prose: true, scope: para.scope, context: text, budget: true });
      const stated = m.kind === "field" ? m.fieldKey === "stated_total_cost" : m.kind === "unmapped" && /\b(budget|total|cost|costs|cout|couts)\b/.test(fold(lab));
      if (m.kind === "field" ? stated || BUDGET_FIELDS.has(m.fieldKey) : m.kind === "unmapped") {
        const total = stated ? mapToken("total cost", t, { prose: true }) : null;
        if (total?.kind === "field") record(result, total, t, { raw: t.raw, location: locationOf(t.start), context: context.slice(0, 240), rule: "line:total-of-costs" });
        else other(t, "line:prose", total?.kind === "ignored" ? total.reason : SEVERAL_NOTE);
        parts.add(t);
      }
    }
  });
  tokens = tokens.filter((t) => !parts.has(t));
  const shares = shareBases(text, tokens, para.scope ?? "senior");
  // A floating rate's spread is not the rate. With an all-in figure in the sentence that figure is the rate; without one nothing is read.
  const float = floating(text, tokens);
  if (float) {
    const allIn = ALL_IN_RE.test(folded) ? tokens.find((t) => t.start > float.spreads[0]!.end && t.unit === "%" && t.value !== null && !float.spreads.includes(t)) : undefined;
    for (const t of tokens) {
      if (float.spreads.includes(t)) other(t, "line:floating-rate", SPREAD_NOTE);
      else if (t.unit === "%" && t !== allIn) other(t, "line:floating-rate", "A percentage in a floating-rate sentence with no all-in figure is not read; enter it by hand if it is an input");
    }
    tokens = tokens.filter((t) => !float.spreads.includes(t) && t.unit !== "%");
    if (allIn) {
      const inLabel = colon > 0 && float.at > colon;
      const before = result.candidates.length;
      push(result, inLabel ? text.slice(0, colon) : text.slice(0, float.at), allIn, locationOf(allIn.start), context, "line:floating-rate", { scope: para.scope, prose: !inLabel, context: text });
      if (result.candidates.length > before) result.candidates[before]!.note = `Floating rate: ${float.index} + ${float.spreads[0]!.raw}; the all-in figure stated beside it is read`;
    }
  }
  if (tokens.length === 0) return;
  const lineType = countedType(text, tokens) ?? carried;
  let proseFrom = 0;
  // The unit type a colon label is made of ("Studios: 4 at $1,450"); it names the items of the clause after the colon when that clause names none.
  let lead: string | null = null;
  // A unit count label ("Units: 8 one-bedroom suites ...") also reads a bare first number as that count.
  let bareCount = false;
  if (colon > 0 && tokens[0]!.start > colon) {
    // Label-first: every number after the colon shares the label. The first
    // number compatible with a field wins; the rest are kept as "other".
    const label = text.slice(0, colon);
    // A label that names nothing for any number ("Financing: a loan of ...") is an introduction: what follows is prose.
    const scope = para.scope;
    // A label for a unit field never names an item unless it is a unit type; the clause after the colon is then read as prose, its own unit types naming the items.
    const opt = (t: NumberToken): MapOptions => ({ scope, seniorHeading: scope === "senior", quote, budgetConcept: true, after: text.slice(t.end, tokens[tokens.indexOf(t) + 1]?.start ?? text.length), gap: text.slice(colon + 1, t.start) });
    const first = tokens.map((t) => mapToken(label, t, opt(t))).find((m) => m.kind === "field");
    const unitField = first?.kind === "field" && first.itemKey !== null && UNIT_FIELDS.has(first.fieldKey);
    const labelTypes = unitTypesIn(label);
    const afterTypes = unitTypesIn(text.slice(colon + 1)).length > 0;
    // A label that holds its own type and its own rent ("One-bed rent per door per month: $2,100") labels its figure; nothing after the colon names a type (task 55).
    const ownRent = labelTypes.length === 1 && !afterTypes && first?.kind === "field" && first.fieldKey !== "unit_count" && first.itemKey === labelTypes[0] && /\b(?:rents?|leases?|price|loyers?|location)\b/i.test(label);
    if (unitField && !ownRent && labelTypes.length <= 1 && (labelTypes.length === 1 || afterTypes)) {
      proseFrom = colon + 1;
      lead = labelTypes[0] ?? null;
      bareCount = true;
    } else if ((first?.kind === "field" && first.concept && LOAN_NOUN.test(fold(text.slice(colon + 1, tokens[0]!.start)))) || tokens.every((t) => mapToken(label, t, opt(t)).kind === "unmapped")) proseFrom = colon + 1;
    else {
      let used = false;
      let usedKey: string | null = null;
      let refusedPerUnit = false;
      const amounts = new Map<NumberToken, Scope>();
      let total: NumberToken | null = null;
      const ranged = rangeEnds(text, tokens);
      for (const [i, t] of tokens.entries()) {
        if (ranged.has(i)) {
          other(t, "line:label-value", RANGE_NOTE);
          continue;
        }
        // A dollar figure after "X% of <field>" is a share of that field, never the field.
        // The base never labels it; the line's own label does, when that names a dollar field.
        if (isMoney(t) && shares.some(([, end]) => t.start >= end)) {
          const own = used ? null : mapToken(label, t, opt(t));
          if (own?.kind === "field" && FIELD_BY_KEY.get(own.fieldKey)?.unit === "$") {
            record(result, own, t, { raw: t.raw, location: locationOf(t.start), context: context.slice(0, 240), rule: "line:label-value" });
            used = true;
          } else other(t, "line:label-value", SHARE_NOTE);
          continue;
        }
        if (refusedPerUnit && t !== total) {
          other(t, "line:label-value", PER_UNIT_REFUSED_NOTE);
          continue;
        }
        // After the first figure, one whose own words just before it name a different field ("at an exit cap of 5.5%") is read by that field; one with no words of its own stays with the label.
        const own: Mapped | null = used && i > 0 ? mapToken(text.slice(tokens[i - 1]!.end, t.start).replace(/^[\s,;]*(?:and|et|puis)?\s*/i, ""), t, { scope, quote, budgetConcept: true, after: text.slice(t.end, tokens[i + 1]?.start ?? text.length), prose: true, context: text }) : null;
        // A part the colon's budget line includes ("Hard costs: $X, including contingency of $Y") is inside that line, not a line of its own.
        const inside: boolean = usedKey !== null && BUDGET_LINES.has(usedKey) && PART_OF_RE.test(fold(withoutTaxBasis(text.slice(colon + 1, t.start))));
        const loan = i > 0 ? amounts.get(tokens[i - 1]!) : undefined;
        const beside = loan && t.unit === "%" && RATE_BESIDE_RE.test(text.slice(tokens[i - 1]!.end, t.start)) && !RATE_BASIS_RE.test(fold(text.slice(t.end, tokens[i + 1]?.start ?? text.length)))
          ? loanTerm(text.slice(tokens[i - 1]!.end, t.start), text.slice(t.end, tokens[i + 1]?.start ?? text.length), t, loan) : null;
        let mapped: Mapped = beside ?? (used ? (own?.kind === "field" && own.fieldKey !== usedKey && !inside ? own : { kind: "unmapped" as const }) : mapToken(label, t, { ...opt(t), ahead: text.slice(colon + 1, t.start) }));
        // A figure after a correction word is the label's field again, so the two disagree and the conflict is named.
        if (used && mapped.kind === "unmapped" && !inside && corrects(text.slice(tokens[i - 1]!.end, t.start), tokens[i - 1]!, t)) {
          const again = mapToken(label, t, { ...opt(t), ahead: text.slice(colon + 1, t.start) });
          if (again.kind === "field" && again.fieldKey === usedKey) mapped = again;
        }
        if (mapped.kind === "field" && BUDGET_LINES.has(mapped.fieldKey) && isDeposit(text, t)) {
          other(t, "line:label-value", DEPOSIT_NOTE);
          continue;
        }
        if (mapped.kind === "field" && PER_UNIT_FIELDS.has(mapped.fieldKey) && perUnit(text, t, BUDGET_LINES.has(mapped.fieldKey) ? label : "")) {
          other(t, "line:label-value", PER_UNIT_NOTE);
          refusedPerUnit = true;
          total = totalOf(text, t, tokens);
          continue;
        }
        // A place before the colon ("Kelowna, British Columbia", "Gatineau (Québec)") is not an item: that count is the deal-wide count. A single word is kept as a component name ("Residential: 160 units").
        if (/[,(]/.test(label) && mapped.kind === "field" && mapped.fieldKey === "unit_count" && mapped.itemKey !== null && mapped.itemKey !== "All units" && unitTypesIn(mapped.itemKey).length === 0) mapped = { ...mapped, itemKey: "All units" };
        if (mapped.kind === "field" && UNIT_FIELDS.has(mapped.fieldKey) && asIs(`${label} ${text.slice(t.end, tokens[i + 1]?.start ?? text.length)}`)) {
          other(t, "line:label-value", AS_IS_NOTE);
          continue;
        }
        if (mapped.kind === "field") {
          mapped = withLineType(mapped, lineType, text);
          record(result, mapped, t, { raw: t.raw, location: locationOf(t.start), context: context.slice(0, 240), rule: "line:label-value" });
          used = true;
          usedKey ??= mapped.fieldKey;
          if (AMOUNT_SCOPE[mapped.fieldKey]) amounts.set(t, AMOUNT_SCOPE[mapped.fieldKey]!);
        } else if (!used || t.value !== null) {
          other(t, "line:label-value", mapped.kind === "ignored" ? mapped.reason : used ? "Another number on this line was used" : "No field matches this label");
        }
      }
      return;
    }
  }
  // Prose: each number's label is the text since the previous number or the sentence start; when that names nothing, the words right after it.
  const ranged = rangeEnds(text, tokens);
  let from = proseFrom;
  // A per-unit price whose total the sentence states: the total is read with the price's label.
  const totalLabels = new Map<NumberToken, string>();
  // The loan a figure's label named by itself ("mezz $650k"): a percentage right after it, with no loan of its own, is that loan's rate.
  let carry: { scope: Scope; at: number } | null = null;
  let previousGrowth: string | null = null;
  let lastRead: { label: string; key: string; t: NumberToken } | null = null;
  const RATE_WORD: Record<Scope, string> = { senior: "senior rate", mezzanine: "mezzanine rate", refinance: "take-out rate" };
  // A sentence that names a non-senior loan carries it: the loan a clause names holds until a clause names another.
  // A loan named only inside a condition ("if the take-out does not fund, we amortize over 25 years") is not the loan the terms belong to.
  const loanSentence = scopesIn(unconditioned(text)).some((s) => s !== "senior");
  let sentenceLoan: Scope | null = null;
  let conceptLoan = false;
  tokens.forEach((t, i) => {
    const where = locationOf(t.start);
    if (ranged.has(i)) {
      other(t, "line:prose", RANGE_NOTE);
      from = t.end;
      return;
    }
    if (pointInTime(text, t)) {
      other(t, "line:prose", POINT_IN_TIME_NOTE);
      from = t.end;
      return;
    }
    // The base of a share ("of hard costs" after "4%") names nothing for the figures after it.
    const afterShare = isMoney(t) && shares.some(([, end]) => t.start >= end);
    const label = shares.reduce((l, [a, b]) => (b > from && a < t.start ? l.slice(0, Math.max(a - from, 0)) + " ".repeat(Math.min(b, t.start) - Math.max(a, from)) + l.slice(Math.min(b, t.start) - from) : l), text.slice(from, t.start));
    const afterFigure = text.slice(t.end, tokens[i + 1]?.start ?? text.length);
    // A building or schedule total is not the monthly rent of one unit.
    const rentWords = fold(label);
    const monthlyTotal = /\b(?:(?:total|gross) monthly rent|rent roll totals|loyer mensuel total|loyers mensuels totaux)\b/.test(rentWords) || (/\bproduces\b/.test(rentWords) && /^\s+of monthly rent\b/.test(fold(afterFigure)));
    if (isMoney(t) && monthlyTotal && !/\b(?:per (?:unit|suite|door|home)|each|par (?:unite|logement))\b/.test(`${rentWords} ${fold(afterFigure)}`)) {
      other(t, "line:prose", "A total of all units' rents, not a rent per unit");
      from = t.end;
      return;
    }
    let opts: MapOptions = { prose: true, scope: para.scope, budgetConcept: true, loanContext: para.scope !== undefined || conceptScope !== undefined || conceptLoan, conceptScope, seniorHeading: para.scope === "senior", context: text, quote, after: isMoney(t) ? afterFigure : text.slice(t.end) };
    let usedLabel = totalLabels.get(t) ?? label;
    // A shared growth verb qualifies the expense clause after the rent figure.
    if (previousGrowth !== null && /^\s*(?:annually|yearly|par an)?\s*(?:and|et)\s+(?:expenses?|costs?|overhead|charges|depenses)\b/i.test(fold(label)) && GROWTH_WORD.test(fold(previousGrowth))) { usedLabel += " growth"; opts = { ...opts, context: undefined }; }
    if (loanSentence) {
      const named = scopesIn(unconditioned(label));
      sentenceLoan = named.length === 1 ? named[0]! : named.length > 1 ? null : sentenceLoan;
      if (sentenceLoan) opts = { ...opts, scope: sentenceLoan };
    }
    if (carry?.at === i - 1 && t.unit === "%" && !scopeIn(label, false) && !BASIS_AFTER_RE.test(fold(afterFigure))) {
      opts = { ...opts, scope: carry.scope };
      if (normalizeLabel(label).label.replace(/\b(at|a|au|aux|avec|with|de|du|of|for|pour|bearing|carrying|portant)\b/g, "").trim() === "") usedLabel = RATE_WORD[carry.scope];
    }
    const named = !totalLabels.has(t) ? loanNameOnly(label) : null;
    let mapped = mapToken(usedLabel, t, opts);
    if (mapped.kind === "unmapped" && sentenceLoan && !totalLabels.has(t)) {
      const clause = (label.split(/[,;]/).pop() ?? "");
      mapped = loanTerm(clause, text.slice(t.end).split(/[,;.]/)[0] ?? "", t, sentenceLoan) ?? mapped;
    }
    // A figure after a correction word is the earlier figure's field again (task 56).
    if (mapped.kind === "unmapped" && lastRead && corrects(label, lastRead.t, t)) {
      const again = mapToken(lastRead.label, t, opts);
      if (again.kind === "field" && again.fieldKey === lastRead.key) mapped = again;
    }
    from = t.end;
    // "to build", "to lease (up)", "pour louer" and "de travaux" right after a duration belong to it alone (card 111: and are not the next figure's label).
    const attached = mapped.kind === "field" && (t.unit === "months" || t.unit === "years") ? /^\s*(?:to build|to lease(?: up)?|pour louer|de (?:construction|travaux|chantier)|de (?:mise en )?location)\b/i.exec(text.slice(t.end)) : null;
    if (attached) from = t.end + attached[0].length;
    if (afterShare && mapped.kind !== "field") {
      other(t, "line:prose", SHARE_NOTE);
      return;
    }
    if (!afterShare && !totalLabels.has(t) && (mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("Looks like")))) {
      const next = tokens[i + 1];
      let after = followingLabel(text.slice(t.end, next?.start ?? text.length));
      // Words that run on into the next figure and name a field for it are that figure's label ("96% with opex load 30%").
      if (after !== null && next && followingLabel(text.slice(t.end, next.start), true) === null && mapToken(after, next, opts).kind === "field") after = null;
      // Card 111: when the words before name nothing, the words after a figure with a stated unit may name it by concept too.
      const viaAfter = after === null ? null : mapToken(after, t, mapped.kind === "unmapped" ? { ...opts, labelAfter: true, lead: label } : opts);
      if (after !== null && viaAfter!.kind === "field") {
        mapped = viaAfter!;
        usedLabel = after;
        from = t.end + after.length;
      } else if (after !== null && viaAfter!.kind === "ignored" && mapped.kind === "unmapped") mapped = viaAfter!;
    }
    // A budget line or an operating figure written with a verb ("Our contractor will do the work for $3,400,000").
    if ((mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("A fee or premium"))) && !afterShare && !totalLabels.has(t)) mapped = costSentence(text, label, text.slice(t.end, tokens[i + 1]?.start ?? text.length), t) ?? mapped;
    if (bareCount && i === 0 && t.unit === null && t.value !== null && Number.isInteger(t.value) && t.value > 0 && mapped.kind === "unmapped") {
      const types = unitTypesIn(clauseOf(text, t));
      if (types.length === 0 && lead) types.push(lead);
      if (types.length === 1) mapped = { kind: "field", fieldKey: "unit_count", itemKey: types[0]!, value: t.value, unitSeen: "units" };
    }
    if (mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("Looks like"))) mapped = clauseItem(text, t, lead) ?? mapped;
    mapped = withLineType(mapped, lineType, clauseOf(text, t));
    // A count whose clause names no unit type is the deal-wide count.
    if (bareCount && mapped.kind === "unmapped" && t.unit === "units" && t.value !== null) mapped = { kind: "field", fieldKey: "unit_count", itemKey: "All units", value: t.value, unitSeen: "units" };
    else if (mapped.kind === "field" && mapped.itemKey !== null && (UNIT_FIELDS.has(mapped.fieldKey) && (proseFrom > 0 || mapped.fieldKey === "unit_count" || mapped.fieldKey === "unit_rent_monthly"))) {
      // The clause's unit type names the item, not the words before the label ("Studios will rent at ...").
      const types = unitTypesIn(clauseOf(text, t));
      if (types.length === 0 && lead) types.push(lead);
      if (types.length === 1) mapped = { ...mapped, itemKey: types[0]! };
    }
    if (mapped.kind === "field" && BUDGET_LINES.has(mapped.fieldKey) && isDeposit(text, t)) {
      other(t, "line:prose", DEPOSIT_NOTE);
      return;
    }
    const budgetShare = perUnit(text, t, usedLabel) && budgetFieldOf(`${usedLabel} ${afterFigure}`.replace(PER_DOOR_LABEL_RE, " ")) !== null;
    if ((((mapped.kind === "field" && PER_UNIT_FIELDS.has(mapped.fieldKey)) || (mapped.kind === "unmapped" && /\b(?:lots?|parcelles?)\b/.test(fold(usedLabel)))) && perUnit(text, t, mapped.kind === "field" && BUDGET_LINES.has(mapped.fieldKey) ? usedLabel : "")) || budgetShare) {
      other(t, "line:prose", PER_UNIT_NOTE);
      const total = totalOf(text, t, tokens);
      if (total) totalLabels.set(total, usedLabel);
      return;
    }
    if ((mapped.kind === "field" ? UNIT_FIELDS.has(mapped.fieldKey) : mapped.kind === "unmapped" && AREA_RENT_UNITS.has(t.unit ?? "")) && asIs(`${usedLabel} ${text.slice(t.end, tokens[i + 1]?.start ?? text.length).split(/[;.]/)[0]}`)) {
      other(t, "line:prose", AS_IS_NOTE);
      return;
    }
    // A loan noun attached to this amount overrides equity words left before it.
    if (mapped.kind === "field" && mapped.fieldKey === "equity_amount" && /^\s*(?:(?:of|de|du|the|un|une)\s+)*(?:construction\s+)?(?:facility|loan|mortgage|pret|financement)\b/.test(fold(afterFigure))) mapped = { kind: "unmapped" };
    carry = named && mapped.kind === "field" && isMoney(t) ? { scope: named, at: i } : null;
    previousGrowth = mapped.kind === "field" && mapped.fieldKey === "rent_growth_pct" ? usedLabel : null;
    lastRead = mapped.kind === "field" && isMoney(t) ? { label: usedLabel, key: mapped.fieldKey, t } : null;
    if (mapped.kind === "field" && AMOUNT_SCOPE[mapped.fieldKey]) conceptLoan = true;
    record(result, mapped, t, { raw: t.raw, location: where, context, rule: "line:prose" });
  });
}

/** A deal-wide rent in a line whose count names its unit type belongs to that type, when its own clause names none. */
function withLineType<M extends Mapped>(mapped: M, lineType: string | null, clause: string): M {
  if (!lineType || mapped.kind !== "field" || !LINE_TYPE_FIELDS.has(mapped.fieldKey) || (mapped.itemKey !== null && mapped.itemKey !== "All units") || unitTypesIn(clause).length > 0) return mapped;
  return { ...mapped, itemKey: lineType } as M;
}

/** The unit type a count is written right before ("3 two-bed"), when the sentence names no other type (task 55). */
function countedType(text: string, tokens: NumberToken[]): string | null {
  const types = unitTypesIn(text);
  return types.length === 1 && tokens.some((t) => t.unit === "units" && unitTypesIn(t.raw).length === 1) ? types[0]! : null;
}

/** Prose: sentences of text, each read on its own. Lines in `skip` were read as table rows. */
const CONCEPT_COSTS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency"]);

/**
 * Text lines of a budget (card 109 audit). A line named only by a cost concept ("Framing: $400,000") may be one of several lines of its field.
 * Beside another line of its field, or beside an unnamed money figure in a block that names no other cost field, it is shown, not read.
 * An unnamed figure at least the sum of the others in a block of three or more is their total and stops nothing.
 */
function conceptLinesInBudget(doc: NormalizedDocument, result: ExtractionResult, from: number, otherFrom: number) {
  const index = new Map(doc.lines.map((l, i) => [l.location, i]));
  const money = (c: Candidate) => c.value !== null && !!c.unitSeen?.includes("$");
  const byLine = new Map<number, { read: Candidate[]; unread: Candidate[] }>();
  const at = (c: Candidate) => {
    const i = index.get(c.location);
    if (i === undefined || !money(c)) return null;
    return byLine.get(i) ?? byLine.set(i, { read: [], unread: [] }).get(i)!;
  };
  for (const c of result.candidates.slice(from)) at(c)?.read.push(c);
  for (const o of result.other.slice(otherFrom)) if (o.note === "No field matches this label") at(o)?.unread.push(o);
  const blocks: number[][] = [];
  for (const i of [...byLine.keys()].sort((a, b) => a - b)) {
    const last = blocks.at(-1);
    if (last && last.at(-1) === i - 1) last.push(i);
    else blocks.push([i]);
  }
  const withheld = new Set<Candidate>();
  for (const block of blocks) {
    const read = block.flatMap((i) => byLine.get(i)!.read);
    const unread = block.flatMap((i) => byLine.get(i)!.unread);
    const all = [...read, ...unread];
    const sum = all.reduce((n, c) => n + c.value!, 0);
    const parts = unread.filter((u) => !(all.length >= 3 && u.value! >= sum - u.value!));
    // A block naming two or more cost fields lists cost lines, one per field: its unnamed lines are other costs, not more of these.
    const fields = new Set(read.map((c) => c.fieldKey).filter((k) => BUDGET_FIELDS.has(k ?? "")));
    for (const c of read) {
      if (c.rule !== "concept" || !CONCEPT_COSTS.has(c.fieldKey ?? "")) continue;
      if ((parts.length > 0 && fields.size < 2) || read.filter((x) => x.fieldKey === c.fieldKey).length > 1) withheld.add(c);
    }
  }
  if (withheld.size === 0) return;
  result.candidates = result.candidates.filter((c) => !withheld.has(c));
  for (const c of withheld) result.other.push({ ...c, fieldKey: null, itemKey: null, note: CONCEPT_BESIDE_UNREAD_NOTE });
}

function fromLines(doc: NormalizedDocument, result: ExtractionResult, skip: Set<number>, scopes: (Scope | undefined)[], excluded: boolean[]) {
  for (const para of paragraphs(doc, skip, scopes, excluded)) {
    // A type named after a count labels the per-unit rents of the clauses after it in the same line (task 55).
    let carried: string | null = null;
    for (const s of sentences(para.text)) {
      readSentence(s, para, result, carried);
      const text = labelValueForm(normalizeText(s.text));
      carried = countedType(text, tokenize(text, result.format)) ?? carried;
    }
  }
}

type RentBasis = "monthly" | "annual" | "psf";

type Roles = {
  item: number[];
  units?: number;
  rent?: number;
  basis?: number;
  area?: number;
  occupancy?: number;
  psfHeader: boolean;
  /** What the rent column's header says the rent is per; null when it only says "Rent". */
  rentBasis: RentBasis | null;
  /** The column headers say the area, or the rent, is per square metre. */
  areaM2: boolean;
  rentPerM2: boolean;
  /** The area column's header says it is the total for the row, not per unit. */
  areaTotal: boolean;
};

// A column header, lower case, "²" written "2" and accents folded ("unité" is "unite"), so "m²" and "m2" read the same.
const headerOf = (c: Cell) => c.text.toLowerCase().replace(/²/g, "2").normalize("NFD").replace(/[̀-ͯ]/g, "");
const M2_RE = /\b(m2|sq\.? ?m|sqm|square met(re|er)s?)\b/;
const PER_M2_RE = /(psm|\/\s?(m2|sq\.? ?m|sqm)\b|(per|au|par) (m2|sq\.? ?m|sqm|square met(re|er))\b)/;
const MONTHLY_RE = /\b(monthly|per month|per mo|a month|mensuel(le)?|par mois|mois)\b|\/\s?(mo|mth|month)\b/;
const ANNUAL_RE = /\b(annual|yearly|annuel(le)?|per year|per annum|par annee|par an)\b|\/\s?yr\b/;

type RentRole = "units" | "item" | "rent" | "basis" | "area" | "occupancy";

const COUNT_HEADER_RE = /\b(inventory|count|units|homes|doors|suites|totals|number|quantity|qty|nombre|logements)\b/;

function rentRole(h: string): RentRole | null {
  // French: "Nombre de logements" counts units; "Type de logement" and "Unité" name them; "Loyer par logement" is a rent.
  if (/\b(nombre|nbre|nb|quantite)\b/.test(h)) return "units";
  // A count word with no type word ("Inventory by plan", "Homes by plan") is the count, not the plan (task 55).
  if (COUNT_HEADER_RE.test(h) && !/\b(types?|rent|loyer)\b/.test(h) && !isPlainRentLabel(h)) return "units";
  // "Rent per suite" is a rent, not an item; a lone "Unit" names the row.
  if (!/\b(rent|loyer)\b/.test(h) && !isPlainRentLabel(h) && (h.trim() === "unit" || /\b(unit\s*type|type|component|space|tenant|suite|plan|floor\s*plan|use)\b/.test(h) || /\b(logement|unite|appartement|locataire|espace|local)\b/.test(h))) return "item";
  if (/\b(units|unit count|count|#|doors|suites|homes|logements|unites|appartements)\b/.test(h)) return "units";
  if ((/\b(rent|loyer)\b/.test(h) || isPlainRentLabel(h)) && !/basis/.test(h)) return "rent";
  if (/basis/.test(h)) return "basis";
  if (/\b(area|sf|nrsf|rsf|gla|square feet|superficie|surface|pi2|sqft|sq\.? ?ft|square foot|pi\.? ?ca|pieds? carres?)\b/.test(h) || M2_RE.test(h)) return "area";
  if (/occupancy|occupation|occ\b/.test(h)) return "occupancy";
  return null;
}

// A suite-by-suite roll names each suite in a suite column and its type in a type column; it needs no count or area column (task 66).
const SUITE_COL_RE = /^(?:(?:unit|suite|apt|apartment|app)\.?(?:\s*(?:#|no\.?|number))?|no\.?|logement)$/;
const TYPE_COL_RE = /^(?:(?:unit\s*)?type|type de logement)$/;

function rentRollRoles(header: Cell[]): Roles | null {
  const roles: Roles = { item: [], psfHeader: false, rentBasis: null, areaM2: false, rentPerM2: false, areaTotal: false };
  const heads = header.map((c) => headerOf(c).trim());
  const suiteAt = heads.findIndex((h) => SUITE_COL_RE.test(h));
  // The suite column leads the row, before the type: after it, "No." or "Unit #" is a count of the type's units.
  const typeAt = heads.findIndex((h) => TYPE_COL_RE.test(h));
  const bySuite = suiteAt >= 0 && typeAt > suiteAt;
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (!h) return;
    const role = bySuite && i === suiteAt ? "item" : rentRole(h);
    if (role === "units") roles.units = i;
    else if (role === "item") roles.item.push(i);
    else if (role === "rent") {
      roles.rent = i;
      roles.rentPerM2 = PER_M2_RE.test(h);
      roles.psfHeader = /(psf|\/\s?sf|per sf|(au|par) (pi2|pi\.? ?ca))/.test(h) || roles.rentPerM2;
      roles.rentBasis = roles.psfHeader ? "psf" : MONTHLY_RE.test(h) ? "monthly" : ANNUAL_RE.test(h) ? "annual" : null;
    } else if (role === "basis") roles.basis = i;
    else if (role === "area") {
      roles.area = i;
      roles.areaM2 = M2_RE.test(h);
      roles.areaTotal = /\b(total|totale|gla)\b/.test(h);
    } else if (role === "occupancy") roles.occupancy = i;
  });
  return roles.item.length > 0 && roles.rent !== undefined && (roles.units !== undefined || roles.area !== undefined || bySuite) ? roles : null;
}

const BUDGET_LABEL_RE = /\b(line\s*items?|description|category|items?|cost\s*items?|use|poste|libelle|designation|categorie|rubrique)\b/;
// A column named by one of these labels the row before any other label column ("Category | Line item | Amount" is labelled by its line item).
const BUDGET_ITEM_RE = /\b(line\s*items?|items?|cost\s*items?|postes?(?: budgetaires?)?)\b/;
// A label column named by one of these only when no column is named by the words above ("Division | Description | Amount" is labelled by its description).
const BUDGET_WEAK_LABEL_RE = /\b(line|division)\b/;
const BUDGET_AMOUNT_RE = /\b(amount|cost|budget|total|montant|couts?|\$)\b/;

/** `others`: amount columns of other revisions, shown and never read; `ambiguous`: the headers do not say which revision is latest, so none is read. */
type BudgetRoles = { label: number; amount: number; others?: number[]; ambiguous?: boolean };
// A column headed by a revision, a version or a quote option.
const REVISION_COL_RE = /\b(rev(?:ision)?\.?\s*[a-z0-9]|revised|revisee?|revise|original|initial|previous|precedent\w*|current|actuel\w*|courant|option|version|quote|bid|soumission|devis|alt\w*)\b/;
/** Where a revision column stands: later is higher; null when the header does not say. */
function columnRank(h: string): number | null {
  if (/\b(original|initial|previous|precedent\w*)\b/.test(h)) return -1;
  if (/\b(current|actuel\w*|courant)\b/.test(h)) return 100;
  return revisionOf(h) || null;
}

function budgetRoles(header: Cell[]): BudgetRoles | null {
  let label = -1;
  let weak = -1;
  let amount = -1;
  let item = -1;
  const revisions: number[] = [];
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (item < 0 && BUDGET_ITEM_RE.test(h)) item = i;
    else if (label < 0 && BUDGET_LABEL_RE.test(h)) label = i;
    else if (weak < 0 && BUDGET_WEAK_LABEL_RE.test(h)) weak = i;
    else {
      if (REVISION_COL_RE.test(h) && (BUDGET_AMOUNT_RE.test(h) || /^\s*[^a-z]*(rev|original|initial|previous|precedent|current|actuel|courant|revis)/.test(h))) revisions.push(i);
      if (amount < 0 && BUDGET_AMOUNT_RE.test(h)) amount = i;
    }
  });
  if (item >= 0) label = item;
  if (label < 0) label = weak;
  if (label < 0) return null;
  if (revisions.length >= 2) {
    const ranks = revisions.map((i) => columnRank(headerOf(header[i]!)));
    const clear = ranks.every((r) => r !== null) && new Set(ranks).size === ranks.length;
    const top = clear ? revisions[ranks.indexOf(Math.max(...(ranks as number[])))]! : revisions[0]!;
    return { label, amount: top, others: revisions.filter((i) => i !== top), ambiguous: !clear };
  }
  const only = amount >= 0 ? amount : revisions[0] ?? -1;
  return only >= 0 ? { label, amount: only } : null;
}

/** A rent column's basis from a note's words ("annual rent per apartment", "net annual per square foot", "monthly"), or null. */
function basisFromNote(text: string): RentBasis | null {
  const t = text.toLowerCase().replace(/²/g, "2").normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (/psf|\/\s?sf\b|\b(per|par|au|a) (sq\.? ?ft|sf|square f(oo|ee)t|pi2|pi\.? ?ca)\b/.test(t)) return "psf";
  if (/\b(annual|yearly|annuel(le)?|per year|par an)\b[^.]*\b(per|par) (apartment|unit|suite|logement|door)\b|\b(per|par) (apartment|unit|suite|logement) (per|par) (year|an)\b/.test(t)) return "annual";
  if (MONTHLY_RE.test(t)) return "monthly";
  return null;
}

// "<word> rents are <basis>" or "rents are <basis>": a note about the rent column.
const RENTS_ARE_RE = /(?:^|[\s,;(])(?:(\p{L}[\p{L}-]*)\s+)?(?:rents|loyers)\s+(?:are|is|sont)\s+([^.;]*)/iu;
const BASIS_UNSTATED = "The rent's basis (per month, per year or per square foot) is not stated";

const ROLL_FIELDS = new Set(["unit_count", "rentable_area_sf", "unit_rent_monthly", "rent_psf_annual", "item_occupancy_pct", "stabilized_occupancy_pct"]);
const SUITE_RULE = "table:rent-roll-suite";
const SUITE_ID_RE = /^(?:(?:suite|unit|apt|apartment|no\.?|#|logement|app\.?)\s*)?\d{1,4}[A-Za-z]?$|^(?:suite|unit|apt|apartment|logement|app\.?)\s+[A-Za-z]$|^[A-Za-z]{1,2}-?\d{1,4}$/i;
const ROLL_SUMMARY_NOTE = "A rent roll's summary row is not an assumption";
const SUMMARY_LABEL_RE = /\b(occupancy|occupation|occupied|average|avg|moyen\w*)\b/;
const STABILIZED_LABEL_RE = /\b(stabili[sz]ed|stabilis\w*|projected|pro forma|projet\w*)\b/;
const DIFFERENT_RENTS_NOTE = "Suites of this type rent at different amounts; enter the rent to use";

/** A rent-roll row's item as the unit type, and whether the row is one suite of it (a suite number or code beside or before the type). */
function suiteItem(parts: string[], hasUnitCount: boolean): { type: string; suite: boolean } {
  const ids = parts.filter((p) => SUITE_ID_RE.test(p));
  const named = parts.filter((p) => !SUITE_ID_RE.test(p));
  if (ids.length > 0 && named.length > 0) return { type: canonicalItem(named.join(" ").replace(/\s+/g, " ")), suite: true };
  // Every cell id-shaped ("101 | A1"): the suite column leads the row, so the last cell is the plan type (card 69 audit).
  if (parts.length > 1 && named.length === 0) return { type: canonicalItem(parts[parts.length - 1]!), suite: true };
  const one = parts.join(" ").replace(/\s+/g, " ").trim();
  // A leading number is a suite number unless the type needs it ("1 chambre", "2 bed").
  const lead = /^(?:(?:suite|unit|apt|apartment|no\.?|#|logement|app\.?)\s*)?\d{1,4}[A-Za-z]?\s+(\S.*)$/i.exec(one);
  if (parts.length === 1 && lead && unitTypesIn(lead[1]!).join() === unitTypesIn(one).join()) return { type: canonicalItem(lead[1]!), suite: true };
  // "TH-1", "TH-2": suites of the type "TH" only without a unit-count column; otherwise the code names the type.
  const code = /^([A-Za-z]{1,4})[-\s]?\d{1,3}$/.exec(one);
  if (!hasUnitCount && parts.length === 1 && code) return { type: code[1]!.toUpperCase(), suite: true };
  return { type: canonicalItem(one), suite: false };
}

function fromRentRoll(table: Table, headerRow: number, roles: Roles, result: ExtractionResult, extraNotes: string[] = []) {
  const wordsOf = (row: Cell[]) =>
    new Set(row.filter((c) => c.number === undefined && c.text && !RENTS_ARE_RE.test(c.text)).flatMap((c) => c.text.toLowerCase().split(/[^\p{L}0-9]+/u).filter(Boolean)));
  const body = table.rows.slice(headerRow + 1);
  const notes = [...body.flatMap((row) => row.map((c) => c.text)), ...extraNotes]
    .map((t) => RENTS_ARE_RE.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ subject: m[1]?.toLowerCase() ?? null, basis: basisFromNote(m[2]!) }));
  const rowWords = body.map(wordsOf);
  const names = (subject: string, words: Set<string>) => words.has(subject) || words.has(subject.replace(/s$/, "")) || words.has(subject + "s");
  // A note applies to the rows its subject word names; one that names no row, or none, applies to the whole table.
  const general = notes.filter((n) => !n.subject || !rowWords.some((w) => names(n.subject!, w)));
  const noteBasis = (row: Cell[]): RentBasis | null => {
    const words = wordsOf(row);
    const specific = notes.filter((n) => n.subject && names(n.subject, words));
    const use = specific.length > 0 ? specific : general;
    const first = use[0]?.basis ?? null;
    return first && use.every((n) => n.basis === first) ? first : null;
  };
  // With no unit-count column, a row is one suite when it carries a suite number or code, or its type repeats; suites are grouped by type below.
  const typeOf = (row: Cell[]) => suiteItem(roles.item.map((i) => row[i]?.text ?? "").filter(Boolean), roles.units !== undefined);
  const repeats = new Map<string, number>();
  for (const row of body) if (row.some((c) => c.text)) repeats.set(typeOf(row).type, (repeats.get(typeOf(row).type) ?? 0) + 1);
  const suiteRows: { type: string; ref: string; cands: Candidate[] }[] = [];
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const itemParts = roles.item.map((i) => row[i]?.text ?? "").filter(Boolean);
    const itemText = itemParts.join(" ").trim();
    if (!itemText) continue;
    // The roll's total row: its figures are shown, never read.
    if (itemParts.some((p) => TOTAL_RE.test(p))) {
      for (const [i, cell] of row.entries()) {
        const t = roles.item.includes(i) ? null : cellToken(cell, result.format);
        if (t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: ROLL_SUMMARY_NOTE });
      }
      continue;
    }
    // A summary row of the roll (an occupancy, an average) is not an assumption.
    if (SUMMARY_LABEL_RE.test(fold(itemText)) && !STABILIZED_LABEL_RE.test(fold(itemText))) {
      const cell = row.find((c, i) => !roles.item.includes(i) && (c.number !== undefined || /\d/.test(c.text)));
      const t = cell && cellToken(cell, result.format);
      if (cell && t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: ROLL_SUMMARY_NOTE });
      continue;
    }
    // A row of the unit table that names an income line is read by its own label, never as a unit type.
    const firstCell = row.find((c, i) => !roles.item.includes(i) && cellToken(c, result.format));
    const firstTok = firstCell && cellToken(firstCell, result.format);
    if (firstCell && firstTok && unitTypesIn(itemText).length === 0 && NON_UNIT_ROW_RE.test(fold(itemText))) {
      record(result, mapToken(itemText, firstTok, {}), firstTok, { raw: firstTok.raw, location: firstCell.ref, context: `${table.name}: ${itemText}`, rule: "table:label-value" });
      continue;
    }
    // A row for the building as it stands today is not the new rental programme.
    if (asIs(itemText)) {
      for (const [i, cell] of row.entries()) {
        const t = roles.item.includes(i) ? null : cellToken(cell, result.format);
        if (t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: AS_IS_NOTE });
      }
      continue;
    }
    const found = typeOf(row);
    const suite = found.suite || (roles.units === undefined && (repeats.get(found.type) ?? 0) > 1);
    const itemKey = found.type;
    const sink: Candidate[] = suite ? [] : result.candidates;
    if (suite) suiteRows.push({ type: itemKey, ref: row[0]?.ref ?? "", cands: sink });
    const basisText = roles.basis !== undefined ? (row[roles.basis]?.text ?? "").toLowerCase().replace(/²/g, "2") : "";
    const perM2 = roles.rentPerM2 || /psm|m2/.test(basisText);
    const psf = roles.psfHeader || perM2 || /sf|psf/.test(basisText);
    // What the rent is per: the header, the basis column, a note about the table, or (with no area column) a month. Never assumed otherwise.
    const basis: RentBasis | null = psf ? "psf" : roles.rentBasis ?? (basisText ? basisFromNote(basisText) : null) ?? (roles.area === undefined ? "monthly" : noteBasis(row));
    const countToken = roles.units !== undefined && row[roles.units] ? cellToken(row[roles.units]!, result.format) : null;
    const add = (fieldKey: string, idx: number | undefined, as?: RentBasis | null) => {
      if (idx === undefined) return;
      const cell = row[idx];
      if (!cell || (!cell.text && cell.number === undefined)) return;
      const t = cellToken(cell, result.format);
      if (!t || t.value === null) {
        if (t) result.other.push({ fieldKey: null, itemKey: null, value: null, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: itemText, rule: "table:rent-roll", note: t.refusal ?? "Unreadable" });
        return;
      }
      const def = FIELD_BY_KEY.get(fieldKey)!;
      let value = t.value;
      let unitSeen: string | null = t.unit && withCurrency(t.unit, t.currencyCode);
      let note: string | undefined;
      if (def.unit === "%" && t.unit !== "%" && value <= 1 && cell.number !== undefined) value = value * 100;
      // Square metres, stated by the cell or by its column, become square feet (decision 7).
      if (fieldKey === "rentable_area_sf" && (t.unit === "m2" || (t.unit === null && roles.areaM2))) {
        value *= SF_PER_M2;
        unitSeen = "m2";
      }
      // An area beside a count is per unit unless the header says total: the item's area is the count times it.
      if (fieldKey === "rentable_area_sf" && roles.units !== undefined && !roles.areaTotal) {
        const n = countToken?.value ?? null;
        if (n === null || n <= 0) return;
        if (n !== 1) {
          note = `${n} × ${t.value} ${unitSeen === "m2" ? "m²" : "sf"}`;
          value *= n;
        }
      }
      if (fieldKey === "rent_psf_annual" && (t.unit === "$/m2" || ((t.unit === null || t.unit === "$") && perM2))) {
        value /= SF_PER_M2;
        unitSeen = withCurrency("$/m2", t.currencyCode);
      }
      if (as === "annual" && (t.unit === null || t.unit === "$")) {
        value /= 12;
        unitSeen = withCurrency("$/yr", t.currencyCode);
        note = "The table gives a yearly rent per unit; shown as a monthly rent (÷ 12)";
      }
      sink.push({ fieldKey, itemKey, value, raw: t.raw, unitSeen, location: cell.ref, context: `${table.name}: ${itemText}`, rule: suite ? SUITE_RULE : "table:rent-roll", ...(note ? { note } : {}) });
    };
    add("unit_count", roles.units);
    if (basis === null) {
      const cell = roles.rent !== undefined ? row[roles.rent] : undefined;
      const t = cell && (cell.text || cell.number !== undefined) ? cellToken(cell, result.format) : null;
      if (cell && t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: BASIS_UNSTATED });
    } else add(basis === "psf" ? "rent_psf_annual" : "unit_rent_monthly", roles.rent, basis);
    if (basis === "psf" || (basis !== null && (roles.units !== undefined || suite))) add("rentable_area_sf", roles.area);
    add("item_occupancy_pct", roles.occupancy);
  }
  // Suites of one type become one item: the rows are the count, the areas add up, and a rent is read only when every suite has the same one.
  for (const type of new Set(suiteRows.map((x) => x.type))) {
    const rows = suiteRows.filter((x) => x.type === type);
    const all = rows.flatMap((x) => x.cands);
    const base = { itemKey: type, unitSeen: "units", context: `${table.name}: ${type}`, rule: SUITE_RULE };
    // The count is the rows, or the sum of the count column when the roll has one.
    const counts = all.filter((c) => c.fieldKey === "unit_count");
    const n = roles.units !== undefined ? counts.reduce((sum, c) => sum + c.value!, 0) : rows.length;
    result.candidates.push({ ...base, fieldKey: "unit_count", value: n, raw: `${rows.length} suites`, location: rows.map((x) => x.ref).join(", "), note: `${rows.length} suites of this type are listed` });
    const areas = all.filter((c) => c.fieldKey === "rentable_area_sf");
    if (areas.length > 0) result.candidates.push({ ...areas[0]!, value: areas.reduce((sum, c) => sum + c.value!, 0), raw: areas.map((c) => c.raw).join(" + "), location: areas.map((c) => c.location).join(", "), note: `Sum of ${areas.length} suites` });
    for (const fieldKey of ["unit_rent_monthly", "rent_psf_annual", "item_occupancy_pct"]) {
      const list = all.filter((c) => c.fieldKey === fieldKey);
      if (list.length === 0) continue;
      if (list.every((c) => c.value === list[0]!.value)) result.candidates.push({ ...list[0]!, location: list.map((c) => c.location).join(", ") });
      else for (const c of list) result.other.push({ ...c, fieldKey: null, itemKey: null, note: DIFFERENT_RENTS_NOTE });
    }
  }
}

// A rent, area or count that is the building as it stands today, not the new rental programme.
const AS_IS_RE = /\b(as[- ]is|existing|current(?:ly)?|present|in[- ]place|former(?:ly)?|actuel(?:le)?s?|existant(?:e)?s?|en place|ancien(?:ne)?)\b/;
const AS_IS_NOTE = "The existing building as it is today, not the new rental programme";
// Today's market is the basis new rents are stated on, not the existing building: "at current market", "loyer du marché actuel".
const MARKET_NOW_RE = /\b(?:current|present|today s)\s+(?:market|markets|rates?|pricing|prices|dollars|survey|conditions)\b|\b(?:marche|prix|taux|conditions?|dollars)\s+actuel(?:le)?s?\b|\b(?:du|au)\s+marche\s+actuel\b/g;
const asIs = (text: string) => AS_IS_RE.test(fold(text).replace(/['’]/g, " ").replace(MARKET_NOW_RE, " "));

// A row of a unit table that names an income line, not a unit type.
const NON_UNIT_ROW_RE = /\b(parking|storage|laundry|lockers?|vending|income|revenues?|revenus?|stationnement|rangement|buanderie|vacancy|vacance|fees?|frais|expenses?|deposits?)\b/;

const DWELLING = String.raw`(?:homes?|units?|suites?|doors?|apartments?|logements?)`;
const PER_HOME_MONTH_RE = new RegExp(String.raw`^\s*\$?\s*(?:/|per|par)\s*${DWELLING}\s*(?:/|per|par)\s*(?:month|mo|mois)(?![\p{L}])`, "iu");
const COUNT_NOUN_RE = new RegExp(String.raw`^\s*${DWELLING}(?![\p{L}])`, "iu");
const NAME_STOP_RE = /^(the|a|an|is|are|was|were|be|will|has|have|had|and|or|for|to|with|of|in|at|on|we|our|it|there|that|this|these|those|includes?|including|contains?|type|le|la|les|un|une|est|sont|et|ou|pour|avec|nous|notre|il|y|des|du|de)$/i;
const titled = (name: string) => canonicalItem(name.split(/\s+/).map((w) => (/^\d/.test(w) ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1))).join(" "));

/** A short name for a type that a line or row starts with: no field alias, heading word, suite or civic number. */
function typeName(raw: string, probe: NumberToken): string | null {
  const name = raw.replace(/[\s:|–—,@-]+$/, "").trim();
  const words = name.split(/\s+/);
  if (words.length > 4 || !/^\p{L}/u.test(name) || words.some((w) => NAME_STOP_RE.test(w))) return null;
  if (/\d/.test(name) && unitTypesIn(name).length === 0) return null;
  const f = fold(name);
  if (REFERENCE_RE.test(f) || NOT_HEADING_RE.test(f)) return null;
  const m = mapToken(name, probe, {});
  return m.kind === "ignored" || (m.kind === "field" && (m.itemKey === null || m.itemKey === "All units")) ? null : titled(name);
}

/**
 * A line or row that is a name, then a count with a dwelling noun and a per-home monthly rent, or an area and a rent per area:
 * the name is an item with both figures. One with only one of the two, or with other figures, is not read here. `bare`: the row is
 * delimited, so a bare integer beside a per-home rent is the count. True when the text was this layout, read or refused as as-is.
 */
function namedType(nameText: string, rest: string, bare: boolean, location: string, context: string, rule: string, result: ExtractionResult): boolean {
  const tokens = tokenize(rest, result.format).filter((t) => t.value !== null);
  // A unit type written after the count ("3 two-bed") is the item; the name before it is a label (task 55).
  if (tokens.length !== 2 || unitTypesIn(rest).length > 0) return false;
  const perHome = (t: NumberToken) => (t.unit === "$" && PER_HOME_MONTH_RE.test(rest.slice(t.end))) || (t.unit === "$/mo" && new RegExp(DWELLING, "i").test(t.raw));
  const perArea = (t: NumberToken) => (t.unit === "$/sf" || t.unit === "$/m2") && !/^\s*(?:per|par|\/)\s*(?:month|mois|mo)\b/i.test(rest.slice(t.end));
  const counted = (t: NumberToken) => Number.isInteger(t.value) && t.value! > 0 && (t.unit === "units" || (t.unit === null && (COUNT_NOUN_RE.test(rest.slice(t.end)) || bare)));
  const rent = tokens.find(perHome);
  const count = tokens.find((t) => t !== rent && counted(t));
  const areaRent = tokens.find(perArea);
  const area = tokens.find((t) => t.unit === "sf" || t.unit === "m2");
  const by = rent && count ? ([[count, "unit_count", "units"], [rent, "unit_rent_monthly", withCurrency("$/mo", rent.currencyCode)]] as const) : areaRent && area ? ([[area, "rentable_area_sf", area.unit!], [areaRent, "rent_psf_annual", withCurrency(areaRent.unit!, areaRent.currencyCode)]] as const) : null;
  const name = by ? typeName(nameText, by[0][0]) : null;
  if (!by || !name) return false;
  const asis = asIs(`${nameText} ${rest}`);
  for (const [t, fieldKey, unitSeen] of by) {
    const base = { raw: t.raw, location, context: context.slice(0, 240), rule };
    // Square metres are square feet, and a rent per m², a rent per sf, by the same conversions as everywhere.
    const value = fieldKey === "rentable_area_sf" && t.unit === "m2" ? t.value! * SF_PER_M2 : fieldKey === "rent_psf_annual" && t.unit === "$/m2" ? t.value! / SF_PER_M2 : t.value!;
    if (asis) result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note: AS_IS_NOTE });
    else result.candidates.push({ ...base, fieldKey, itemKey: name, value, unitSeen });
  }
  return true;
}

/** A line read as a named type: "Name | 3 homes | $2,300 per home per month", "Name: 3 homes at ...", "Name 1,800 sf at $34 per sf". */
function namedLine(text: string, location: string, result: ExtractionResult): boolean {
  if (text.includes("|")) {
    const [head, ...parts] = text.split("|");
    return namedType(head!, parts.join(" | "), true, location, text, "line:named-type", result);
  }
  const first = tokenize(text, result.format)[0];
  if (!first) return false;
  const colon = text.indexOf(":");
  const at = colon > 0 && colon < first.start ? colon : first.start;
  return namedType(text.slice(0, at), text.slice(at + (text[at] === ":" ? 1 : 0)), false, location, text, "line:named-type", result);
}

/** A table row of a name and two or more cells, read as a named type. */
function namedRow(row: Cell[], table: Table, result: ExtractionResult): boolean {
  const cells = row.filter((c) => c.text);
  const head = cells[0];
  if (!head || cells.length < 3 || head.number !== undefined) return false;
  return namedType(head.text, cells.slice(1).map((c) => c.text).join(" | "), true, head.ref, `${table.name}: ${cells.map((c) => c.text).join(" | ")}`, "table:named-type", result);
}

const COUNT_ROW_RE = /^(?:(?:number|nombre|nb|no\.?)\s+(?:of|de|d')\s*)?(?:homes?|units?|suites?|doors?|apartments?|logements?|unites?|appartements?|count)$/;
const PER_UNIT_LABEL_RE = /\b(per|par)\s+(home|unit|suite|door|apartment|logement|unite|appartement)\b/;

/**
 * A table whose header row (one of the first four, below title rows only) holds two or more unit types, and whose first column labels a count and a rent,
 * is read column by column: each column is one item. A yearly rent per home is a monthly one by twelve.
 */
function fromTypeColumns(table: Table, result: ExtractionResult): boolean {
  // The header may sit under title rows ("Rental programme", a merged banner), so long as nothing above it holds a figure.
  for (let h = 0; h < Math.min(4, table.rows.length); h++) {
    if (h > 0 && table.rows[h - 1]!.some((c) => c.number !== undefined || /\d/.test(c.text.replace(/\d+\s*[½¼¾]/g, "")))) break;
    const types = table.rows[h]!.map((c, i) => (i > 0 ? wholeUnitType(c.text) : null));
    if (new Set(types.filter(Boolean)).size < 2) continue;
    const body = table.rows.slice(h + 1).map((row) => ({ row, label: headerOf(row[0] ?? { text: "", ref: "" }).trim() }));
    const isRent = (l: string) => /\b(rent|loyer)\b/.test(l) && !/\b(psf|sf|pi2|m2)\b/.test(l);
    if (!body.some((b) => COUNT_ROW_RE.test(b.label)) || !body.some((b) => isRent(b.label))) continue;
    for (const { row, label } of body) {
      types.forEach((type, i) => {
        const cell = row[i];
        const t = type && cell?.text ? cellToken(cell, result.format) : null;
        if (!type || !cell || !t) return;
        const base = { raw: t.raw, location: cell.ref, context: `${table.name}: ${row[0]!.text} ${cell.text}`.slice(0, 240), rule: "table:type-columns" };
        const aside = (note: string) => result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note });
        if (COUNT_ROW_RE.test(label)) {
          if (t.value !== null && Number.isInteger(t.value) && t.value > 0 && (t.unit === null || t.unit === "units")) result.candidates.push({ ...base, fieldKey: "unit_count", itemKey: type, value: t.value, unitSeen: "units" });
          else aside(t.refusal ?? "Not a unit count");
        } else if (isRent(label) && t.value !== null && (t.unit === null || t.unit === "$" || t.unit === "$/mo")) {
          if (MONTHLY_RE.test(label)) result.candidates.push({ ...base, fieldKey: "unit_rent_monthly", itemKey: type, value: t.value, unitSeen: withCurrency("$/mo", t.currencyCode) });
          else if (ANNUAL_RE.test(label) && PER_UNIT_LABEL_RE.test(label)) result.candidates.push({ ...base, fieldKey: "unit_rent_monthly", itemKey: type, value: t.value / 12, unitSeen: withCurrency("$/yr", t.currencyCode), note: "The table gives a yearly rent per unit; shown as a monthly rent (÷ 12)" });
          else aside(BASIS_UNSTATED);
        } else aside("No field matches this label");
      });
    }
    return true;
  }
  return false;
}

// A suite-by-suite roll: a suite-number column and a status column, with no count column. It is never read row by row.
const SUITE_HEAD_RE = /^(suite|unit|apt|apartment|no\.?|#|logement|app\.?)(\s*(no\.?|number|#))?$/;
const STATUS_HEAD_RE = /^(status|statut|occupancy|occupation|lease status|occupied)$/;
const SUITE_ROLL_NOTE = "A suite-by-suite roll without a summary by type; enter the unit mix";
const suiteRolls = new WeakSet<ExtractionResult>();
function suiteHeader(row: Cell[]): boolean {
  const h = row.map((c) => headerOf(c).trim());
  return row.every((c) => c.number === undefined) && h.some((x) => SUITE_HEAD_RE.test(x)) && h.some((x) => STATUS_HEAD_RE.test(x)) && !h.some((x) => rentRole(x) === "units");
}

function fromBudget(table: Table, headerRow: number, roles: BudgetRoles, result: ExtractionResult, scope: Scope, excluded = false, categories?: Map<Cell[], string>) {
  // Sum component lines per field; use a "Total X" row only when no component
  // line mapped to X, and raise both when they disagree. A line that maps to no
  // field, between the header (or the previous total) and a total row for X, is a component of X.
  // A line in another currency is never added to the deal's own: sums are kept per field and currency.
  const components = new Map<string, { fieldKey: string; unitSeen: string; sum: number; refs: string[]; labels: string[]; rows: { value: number; ref: string; label: string }[]; credit?: true; concept?: true; alias?: true }>();
  const totals: Candidate[] = [];
  let started = false;
  let segment: { value: number; unitSeen: string; ref: string; label: string; shown: Candidate }[] = [];
  // Since the last total: whether an unread line was seen, and the fields a concept named. A concept line beside unread lines
  // that no total adds up may be only part of its field ("Framing" beside "Mechanical"), so it is shown, not read.
  let unreadInRun = false;
  const conceptInRun = new Set<string>();
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const labelCell = row[roles.label];
    const amountCell = row[roles.amount];
    const category = categories?.get(row);
    if (!amountCell) continue;
    // A row with no label cell shows its amount, with the row's text cells as its context; it is never summed or totalled.
    if (!labelCell?.text) {
      const t = cellToken(amountCell, result.format);
      if (t && !isYearToken(t)) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: amountCell.ref, context: `${table.name}: ${row.filter((c) => c.number === undefined && c.text.trim()).map((c) => c.text.trim()).join(" ")}`.slice(0, 240), rule: "table:budget", note: "No budget line matches this label" });
      continue;
    }
    const displayLabel = category ? `${category}: ${labelCell.text}` : labelCell.text;
    // The amounts of other revisions, or of columns whose order is not told, are shown and never read.
    for (const c of [...(roles.others ?? []), ...(roles.ambiguous ? [roles.amount] : [])]) {
      const cell = row[c];
      const o = cell && cellToken(cell, result.format);
      if (cell && o) result.other.push({ fieldKey: null, itemKey: null, value: o.value, raw: o.raw, unitSeen: o.unit, location: cell.ref, context: `${table.name}: ${displayLabel}`, rule: "table:budget", note: roles.ambiguous ? "Several amount columns; choose one" : SUPERSEDED_NOTE });
    }
    // The figures of the row's other columns (a "$ per unit" or "% of total" column) are shown, never read.
    for (const [c, cell] of row.entries()) {
      if (c === roles.label || c === roles.amount || (roles.others ?? []).includes(c)) continue;
      const o = cellToken(cell, result.format);
      if (o && !isYearToken(o)) result.other.push({ fieldKey: null, itemKey: null, value: o.value, raw: o.raw, unitSeen: o.unit, location: cell.ref, context: `${table.name}: ${displayLabel}`, rule: "table:budget", note: "Another column of this budget row; not read" });
    }
    if (roles.ambiguous) continue;
    const t = cellToken(amountCell, result.format);
    if (!t) continue;
    // A row whose own label or note says it is not part of the deal, or one under such a heading, is shown and never read, summed or totalled.
    if (excluded || (category && (markedNotPart(category) || MEMO_SECTION_RE.test(fold(category)))) || row.some((c) => markedNotPart(c.text))) {
      result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: amountCell.ref, context: `${table.name}: ${displayLabel}`, rule: "table:budget", note: NOT_PART_NOTE });
      continue;
    }
    // An amount whose own cell says it is per door is a share, not the line: it is shown and never read, summed or totalled.
    if (perUnit(amountCell.text, t, displayLabel)) {
      result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: amountCell.ref, context: `${table.name}: ${displayLabel}`, rule: "table:budget", note: PER_UNIT_NOTE });
      continue;
    }
    // A row in a budget sheet that is not money ("Loan-to-cost | 70%") is a label and value.
    if (t.unit !== null && t.unit !== "$") {
      push(result, labelCell.text, t, amountCell.ref, `${table.name}: ${displayLabel} ${amountCell.text}`, "table:label-value", { scope });
      continue;
    }
    // A figure the label says is part of another budget field adds nothing of its own.
    const counted = partOfNote(labelCell.text, false);
    if (counted) {
      result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: "$", location: amountCell.ref, context: `${table.name}: ${displayLabel}`, rule: "table:budget", note: counted });
      continue;
    }
    const categoryTotal = category && TOTAL_RE.test(category);
    const trailingTotal = category ? /\b(?:sub-?total|sous-?total|total)\s*$/i : null;
    const statedTotal = STATED_TOTAL.test(normalizeLabel(labelCell.text).label);
    const usesTotal = USES_TOTAL_RE.test(labelCell.text.trim());
    const isTotal = statedTotal || usesTotal || TOTAL_RE.test(labelCell.text) || !!categoryTotal || !!trailingTotal?.test(labelCell.text);
    // Unread rows with nothing read or totalled above them are the whole table's breakdown of its first total.
    const bare = !started;
    if (isTotal) started = true;
    const lines = segment;
    if (isTotal) segment = [];
    const labelText = isTotal ? labelCell.text.replace(TOTAL_RE, "").replace(trailingTotal ?? /$^/, "").trim() || labelCell.text : labelCell.text;
    const moneyToken: NumberToken = { ...t, currency: true, unit: t.unit ?? "$" };
    const quoted = quoteDocs.has(result) ? mapToken(labelCell.text, moneyToken, { scope, budget: true, quote: true }) : null;
    const closing = isTotal && closesUses(labelCell.text, [...components.values()].map((c) => c.fieldKey)) && table.rows.slice(r + 1).every((x) => !x[roles.amount] || !cellToken(x[roles.amount]!, result.format));
    let mapped = quoted?.kind === "field" && quoted.quote ? quoted : mapToken(closing || usesTotal ? "total project cost" : isTotal && (/development|project/i.test(labelCell.text) || statedTotal) ? labelCell.text : labelText, moneyToken, { scope, budget: true, quote: quoteDocs.has(result) });
    // Only an unnamed line inherits its category. A named field or an explicit refusal keeps its own meaning.
    const categoryKey = category && budgetCategory(category);
    // The line's own words still apply their guards (a fee, interest, an amount to date): the category is read with them.
    if (mapped.kind === "unmapped" && categoryKey) {
      const inherited = mapToken(`${FIELD_BY_KEY.get(categoryKey)!.aliases[0]!} - ${labelCell.text}`, moneyToken, { scope, budget: true, quote: quoteDocs.has(result) });
      if (inherited.kind === "ignored" || (inherited.kind === "field" && inherited.fieldKey === categoryKey)) mapped = inherited;
    }
    if (mapped.kind !== "field" || FIELD_BY_KEY.get(mapped.fieldKey)?.unit !== "$") {
      const shown: Candidate = {
        fieldKey: null,
        itemKey: null,
        value: t.value,
        raw: t.raw,
        unitSeen: "$",
        location: amountCell.ref,
        context: `${table.name}: ${displayLabel}`,
        rule: "table:budget",
        note: mapped.kind === "ignored" ? mapped.reason : "No budget line matches this label",
      };
      if (mapped.kind === "unmapped" && !isTotal && t.value !== null) {
        segment.push({ value: t.value, unitSeen: withCurrency("$", t.currencyCode), ref: amountCell.ref, label: labelCell.text, shown });
        unreadInRun = true;
      }
      result.other.push(shown);
      continue;
    }
    const cand: Candidate = {
      fieldKey: mapped.fieldKey,
      itemKey: null,
      value: mapped.value,
      raw: t.raw,
      unitSeen: withCurrency("$", t.currencyCode ?? currencyOf(mapped.unitSeen)),
      location: amountCell.ref,
      context: `${table.name}: ${displayLabel}`,
      rule: mapped.quote ? "table:quote-total" : isTotal ? "table:budget-total" : "table:budget",
    };
    const add = (value: number, unitSeen: string, ref: string, label: string) => {
      const ck = `${mapped.fieldKey}|${unitSeen}`;
      const acc = components.get(ck) ?? { fieldKey: mapped.fieldKey, unitSeen, sum: 0, refs: [], labels: [], rows: [] };
      acc.sum += value;
      acc.refs.push(ref);
      acc.labels.push(label);
      acc.rows.push({ value, ref, label });
      if (mapped.note) acc.credit = true;
      if (mapped.concept) acc.concept = true; else acc.alias = true;
      components.set(ck, acc);
    };
    if (isTotal) {
      unreadInRun = false;
      conceptInRun.clear();
    }
    if (isTotal && mapped.fieldKey === "stated_total_cost") { totals.push(cand); continue; }
    if (isTotal && mapped.fieldKey !== "stated_total_cost") {
      totals.push(cand);
      // The unread rows are the subtotal's parts only when they add up to it, with the rows already read as its field (those are then not the whole of it); otherwise the subtotal is read alone.
      const parts = lines.filter((l) => l.unitSeen === cand.unitSeen);
      const key = `${mapped.fieldKey}|${cand.unitSeen}`;
      const read = parts.length > 0 ? components.get(key) : undefined;
      const sum = parts.reduce((n, l) => n + l.value, 0) + (read?.sum ?? 0);
      if (parts.length > 0 && (bare || Math.abs(sum - mapped.value) <= parts.length + (read?.rows.length ?? 0))) for (const l of parts) add(l.value, l.unitSeen, l.ref, l.label);
      else {
        for (const l of lines) l.shown.note = NOT_SHOWN_NOTE;
        if (read) {
          components.delete(key);
          for (const r of read.rows) result.other.push({ fieldKey: null, itemKey: null, value: r.value, raw: String(r.value), unitSeen: "$", location: r.ref, context: `${table.name}: ${r.label}`, rule: "table:budget", note: NOT_SHOWN_NOTE });
        }
      }
      continue;
    }
    // A row that is read ends the run of unread rows. A row named only by a concept is one of the run's lines, so a total below still adds up the unread lines around it.
    if (mapped.concept) conceptInRun.add(`${mapped.fieldKey}|${cand.unitSeen}`);
    else {
      segment = [];
      started = true;
    }
    add(mapped.value, cand.unitSeen!, amountCell.ref, displayLabel);
  }
  if (unreadInRun) for (const key of conceptInRun) {
    const acc = components.get(key);
    if (!acc || acc.alias) continue;
    components.delete(key);
    for (const r of acc.rows) result.other.push({ fieldKey: null, itemKey: null, value: r.value, raw: String(r.value), unitSeen: "$", location: r.ref, context: `${table.name}: ${r.label}`, rule: "table:budget", note: CONCEPT_BESIDE_UNREAD_NOTE });
  }
  for (const acc of components.values()) {
    result.candidates.push({
      fieldKey: acc.fieldKey,
      itemKey: null,
      value: acc.sum,
      raw: acc.sum.toString(),
      unitSeen: acc.unitSeen,
      location: acc.refs.join(", "),
      context: `${table.name}: ${acc.labels.join(" + ")}`,
      rule: acc.refs.length > 1 ? "table:budget-sum" : "table:budget",
      // The note names a credit only when the rows add up to one.
      ...(acc.credit && acc.sum < 0 ? { note: CREDIT_NOTE } : {}),
    });
  }
  for (const t of totals) {
    const comp = t.fieldKey === "stated_total_cost"
      ? { sum: [...components.values()].filter((c) => c.unitSeen === t.unitSeen && FIELD_BY_KEY.get(c.fieldKey)?.group === "budget").reduce((sum, c) => sum + c.sum, 0) }
      : components.get(`${t.fieldKey}|${t.unitSeen}`);
    const differs = comp && Math.abs(comp.sum - (t.value ?? 0)) > 1;
    if (!comp || t.fieldKey === "stated_total_cost" || differs) result.candidates.push({ ...t, ...(differs ? { note: `The printed total does not equal the sum of its lines (${comp.sum.toLocaleString("en-US")})` } : {}) });
  }
}

// A word that opens a section of a sheet: a first column of these (or of any few repeated words) is a category column.
const SECTION_WORD_RE = /^(?:uses?|sources?|hard|soft|finance|financing|financement|revenues?|revenus?|income|assumptions?|operating|opex|timing|inputs?|project|projet|travaux|budget|emplois|hypotheses|land|terrain|acquisition|contingenc(?:y|ies)|imprevus|aleas|reserve|totals?|subtotal|sous-total|grand total|frais de financement|indirects|directs|construction|costs?|couts?|loan|equity|capital|exit|memos?|notes?|info|for information|pour memoire|pour information)\b/;

const filledCells = (row: Cell[]) => row.filter((c) => c.text.trim() || c.number !== undefined);

// These structural budget categories name a cost line when the description itself names none.
function budgetCategory(raw: string): string | null {
  const category = normalizeLabel(raw).label;
  if (/^(?:hard(?: costs)?|construction|travaux|directs|couts directs)$/.test(category)) return "hard_cost";
  if (/^(?:soft(?: costs)?|indirects|couts indirects)$/.test(category)) return "soft_cost";
  if (/^(?:land|terrain|acquisition)$/.test(category)) return "land_cost";
  // "Reserve" alone is not named: replacement, operating and interest reserves are not the contingency.
  return /^(?:contingenc(?:y|ies)|imprevus|aleas)$/.test(category) ? "contingency" : null;
}

function costCategory(raw: string): boolean {
  const label = normalizeLabel(raw).label;
  return budgetCategory(raw) !== null || /^(?:uses?|costs?|project|projet|budget|emplois|couts|totals?|subtotal|sous-total|grand total)$/.test(label);
}

const CONCEPT_BESIDE_UNREAD_NOTE = "Other lines beside it name no field, so this line may be only part of its cost; enter the field by hand";

const USES_TOTAL_RE = /^(?:sum of uses|total uses|uses total|total des emplois|somme des emplois)$/i;

/**
 * In a sheet with no header row, a first text column of a few short words, each repeated or opening a section, beside a column of distinct line items
 * is a category column. Returns, per row, the category cell; the row's label is then the next text cell (task 55).
 */
function categoryCells(rows: Cell[][], format: DocumentFormat): Map<Cell[], Cell> {
  const out = new Map<Cell[], Cell>();
  // A real header row (a budget or rent-roll column set) names the columns itself.
  if (rows.some((r) => !r.some((c) => c.number !== undefined) && (rentRollRoles(r) || budgetRoles(r)))) return out;
  const pair = (r: Cell[]) => {
    const [a, b, ...rest] = r.filter((c) => c.text || c.number !== undefined);
    const text = (c: Cell | undefined) => c !== undefined && c.number === undefined && /^\p{L}/u.test(c.text) && !isValueText(c, format);
    return text(a) && text(b) && rest.some((c) => cellToken(c, format)) ? { a: a!, b: b! } : null;
  };
  const found = rows.flatMap((r) => { const p = pair(r); return p ? [{ r, ...p }] : []; });
  const figures = rows.filter((r) => r.some((c) => cellToken(c, format))).length;
  if (found.length < 3 || found.length < 0.6 * figures) return out;
  const key = (c: Cell) => fold(c.text).replace(/\s+/g, " ").trim();
  const cats = new Map<string, number>();
  for (const f of found) cats.set(key(f.a), (cats.get(key(f.a)) ?? 0) + 1);
  if (cats.size > 8 || [...cats].some(([k, n]) => (k.split(" ").length > 3 && !PER_DOOR_LABEL_RE.test(k)) || (n < 2 && !SECTION_WORD_RE.test(k)))) return out;
  if (new Set(found.map((f) => key(f.b))).size <= found.length / 2) return out;
  for (const f of found) out.set(f.r, f.a);
  return out;
}

/** A table figure's context: its sheet, its category, and every text cell of its row from the label up to the figure, so a person sees the line item even when the label is a category word (task 57). */
function rowContext(sheet: string, cat: string | undefined, row: Cell[], label: Cell, cell: Cell): string {
  const between = row.slice(row.indexOf(label) + 1, row.indexOf(cell)).filter((c) => c.number === undefined && c.text.trim() !== "");
  return `${sheet}: ${cat ? `${cat} ` : ""}${[label, ...between].map((c) => c.text.trim()).join(" ")} ${cell.text}`.slice(0, 240);
}

/** A row that is only a short text, no number: a section label ("SENIOR LOAN", "Unit mix", "Répartition des logements"). */
function sectionLabel(row: Cell[]): string | null {
  const filled = row.filter((c) => c.text || c.number !== undefined);
  const c = filled[0];
  if (filled.length !== 1 || !c || c.number !== undefined || /\d/.test(c.text) || /[.!?]$/.test(c.text) || c.text.trim().split(/\s+/).length > 8) return null;
  return c.text;
}

// A heading of an item block is no field, section, total or sentence; the rows under it that name these fields belong to it.
const REVENUE_FIELDS = UNIT_FIELDS;
// A figure in one of these units is a count, an area or a rent even when its label names nothing.
const AREA_RENT_UNITS = new Set(["$/sf", "$/m2", "sf", "m2", "units", "$/mo"]);
const BLOCK_FIELDS = new Set(["unit_count", "unit_rent_monthly", "rentable_area_sf", "rent_psf_annual", "item_occupancy_pct"]);
// A label inside a block that names the block by "this" or "of this type" rather than by name.
const BLOCK_RELATIVE_RE = /\s*\b((of|for) this (type|component|unit|space)|this (type|component|unit|space)|(de|pour) ce (type|local)|ce local|(de|pour) cette composante|cette composante)\s*$/i;
// A suite, unit or file number, or a year, is a reference, not an item: "Suite 204", "File 2026". A name with a number is an item: "Shop 2".
const REFERENCE_RE = /\b(suite|unit|apt|apartment|appartement|logement|no|num|number|numero|room|bureau|file|dossier|ref|reference|version|edition)\s*#?\s*\d|\b(19|20)\d\d\b|#\s*\d/;
const NOT_HEADING_RE = /^(number of|nombre de|total|average|avg|monthly|annual|rent|loyer|area|superficie|occupancy|occupation|unit count)\b|\b(revenues?|revenus?|leasing|location|budget|budgets|notes?|capital|assumptions?|hypotheses|financing|financement|loan|pret|costs?|couts?|summary|sommaire|schedule|totals?)\b/;

/** The item a row names when it is a short text with no number and the next row is a label and value row for an item field ("Garden suite" over "Number of units | 2"). */
function blockHeading(row: Cell[], next: Cell[] | undefined, scope: Scope, format: DocumentFormat): string | null {
  const filled = row.filter((c) => c.text || c.number !== undefined);
  const c = filled[0];
  if (filled.length !== 1 || !c || c.number !== undefined || !(unitTypesIn(c.text).length > 0 || (/^\p{L}/u.test(c.text) && !REFERENCE_RE.test(fold(c.text)))) || /[.!?:]$/.test(c.text) || c.text.trim().split(/\s+/).length > 8 || scopeIn(c.text) || NOT_HEADING_RE.test(fold(c.text))) return null;
  const label = next?.find((x) => x.text && x.number === undefined);
  const cell = label && next!.slice(next!.indexOf(label) + 1).find((x) => cellToken(x, format));
  const t = cell && cellToken(cell, format);
  const m = label && t ? mapToken(label.text, t, { scope }) : null;
  return m?.kind === "field" && BLOCK_FIELDS.has(m.fieldKey) && !(m.itemKey && unitTypesIn(m.itemKey).length > 0) ? c.text.trim() : null;
}

/** A text cell that is one complete number and nothing else: "7.25%", "900k", "(4,000)", "$1.2M", "1,2 M$". */
function isValueText(cell: Cell, format: DocumentFormat): boolean {
  if (cell.number !== undefined || !cell.text) return false;
  const t = cellToken(cell, format);
  return !!t && !cell.text.slice(0, t.start).trim() && /^[\s)]*$/.test(cell.text.slice(t.end));
}

/** The label of a plain label/value row: its first text cell that is not itself a value. */
function labelOf(row: Cell[], format: DocumentFormat): Cell | undefined {
  return row.find((c) => c.text && c.number === undefined && !/^[\d$(.,\s%-]+$/.test(c.text) && !isValueText(c, format));
}

/**
 * A row that writes its value before its label ("7.25% | Construction loan rate"): the value is the cell nearest before the label, and no cell
 * after the label holds a figure. A year or a suite or file reference in the value's place is no value; such a row reads as it always did (nothing).
 */
function valueFirst(row: Cell[], format: DocumentFormat): { label: Cell; value: Cell } | null {
  const label = labelOf(row, format);
  if (!label) return null;
  const at = row.indexOf(label);
  const value = row.slice(0, at).filter((c) => c.number !== undefined || isValueText(c, format)).pop();
  if (!value || REFERENCE_RE.test(fold(value.text)) || row.slice(at + 1).some((c) => cellToken(c, format))) return null;
  return { label, value };
}

/** A plain section is value-first when more than half of its rows that hold both a label and a value (and at least two) have the value first. */
function isValueFirstSection(rows: Cell[][], format: DocumentFormat): boolean {
  let first = 0;
  let last = 0;
  for (const row of rows) {
    const label = labelOf(row, format);
    if (!label) continue;
    const vf = valueFirst(row, format);
    if (vf) first++;
    else if (row.slice(row.indexOf(label) + 1).some((c) => cellToken(c, format))) last++;
  }
  return first >= 2 && first > last;
}

type Section = { rows: Cell[][]; scope: Scope; loanScope: boolean; costSection?: boolean; categoryBudget?: boolean; excluded: boolean; rent?: Roles; budget?: BudgetRoles; item?: string; suites?: true };

/**
 * A sheet may stack sections. A row that is itself a header (a rent roll's or a budget's) ends the section before it and starts
 * its own; a section label row ends it too, sets the loan scope when it names a loan, and the rows under it with no column header
 * are label and value rows. Rows above the first header, when there is one and no label came first, are a title and read as nothing.
 */
/**
 * A text cell of a table that is a sentence: no number value, six words or more, and a figure in it, on a row with no number cell (next to a number
 * cell it is that number's label: "Contingency (5% of hard costs)"). A cell that begins with its figure ("5 % des revenus bruts effectifs") is a value with a qualifier, not a sentence.
 */
function isSentenceCell(c: Cell, row: Cell[], format: DocumentFormat): boolean {
  if (c.number !== undefined || row.some((x) => x.number !== undefined)) return false;
  if (figureDashItems(c.text.trim(), format)) return true;
  if (c.text.trim().split(/\s+/).length < 6) return false;
  const first = tokenize(c.text, format)[0];
  return !!first && c.text.slice(0, first.start).trim() !== "";
}

function fromTable(table0: Table, result: ExtractionResult, notes: string[] = [], scope0?: Scope) {
  // A category column beside the line items is set aside; its word stays with the row (task 55).
  const cats = categoryCells(table0.rows, result.format);
  const catOf = new Map<Cell[], string>();
  const table: Table = cats.size === 0 ? table0 : { ...table0, rows: table0.rows.map((r) => {
    const c = cats.get(r);
    if (!c) return r;
    const kept = r.filter((x) => x !== c);
    catOf.set(kept, c.text.trim());
    return kept;
  }) };
  // A rank row names the loan for the whole table, the rows above it too; a section label below still overrides it.
  let scope = tableRank(table) ?? scope0 ?? "senior";
  let loanScope = tableRank(table) !== null || scope0 !== undefined;
  let costSection = false;
  let labelled = false;
  // A sheet name or a section label that marks what follows as not part of the deal.
  // A sheet named as not part of the deal stays so throughout; a section label inside it cannot undo it.
  const sheetExcluded = markedNotPart(table.name);
  let excluded = sheetExcluded;
  const sections: Section[] = [];
  if (fromTypeColumns(table, result)) return;
  let cur: Section = { rows: [], scope, loanScope, costSection, excluded };
  const close = () => {
    if (cur.rows.length > 0) sections.push(cur);
  };
  table.rows.forEach((row, at) => {
    const numeric = row.some((c) => c.number !== undefined);
    if (suiteHeader(row)) {
      close();
      cur = { rows: [], scope, loanScope, costSection, excluded, suites: true };
      suiteRolls.add(result);
      return;
    }
    const rent = numeric ? null : rentRollRoles(row);
    const budget = numeric || rent ? null : budgetRoles(row);
    if (rent || budget) {
      if (!cur.rent && !cur.budget && sections.length === 0 && !labelled) cur.rows = [];
      close();
      cur = { rows: [row], scope, loanScope, costSection, excluded, ...(rent ? { rent } : { budget: budget! }) };
      return;
    }
    const item = numeric ? null : blockHeading(row, table.rows[at + 1], scope, result.format);
    if (item !== null) {
      close();
      labelled = true;
      excluded = sheetExcluded || markedNotPart(item);
      cur = { rows: [], scope, loanScope, costSection, excluded, item };
      return;
    }
    const label = sectionLabel(row);
    if (label !== null) {
      close();
      const named = scopeIn(label);
      scope = named ?? scope;
      loanScope ||= named !== null;
      costSection = costCategory(label);
      labelled = true;
      excluded = sheetExcluded || markedNotPart(label);
      cur = { rows: [], scope, loanScope, costSection, excluded };
      return;
    }
    cur.rows.push(row);
  });
  close();
  let rollSeen = false;
  const runs = sections.flatMap((section) => {
    if (section.rent || section.budget || section.suites) return [section];
    const parts: Section[] = [];
    for (const row of section.rows) {
      const cat = catOf.get(row);
      const budget = (cat ? costCategory(cat) : section.costSection) && filledCells(row).length === 2;
      const last = parts.at(-1);
      if (last && !!last.categoryBudget === !!budget) last.rows.push(row);
      else parts.push({ ...section, rows: [row], categoryBudget: !!budget });
    }
    return parts;
  });
  for (const s of runs) {
    const part = { ...table, rows: s.rows };
    if (s.suites) continue;
    if (s.rent) {
      fromRentRoll(part, 0, s.rent, result, notes);
      rollSeen = true;
    }
    else if (s.budget) fromBudget(part, 0, s.budget, result, s.scope, s.excluded);
    // A detected category budget uses the same sums and total checks as a headed budget.
    // Empty cells between the line and its amount are skipped; a note or a second figure keeps the sheet out.
    else if (s.categoryBudget) {
      const rows = s.rows.map(filledCells);
      rows.forEach((row, i) => { const cat = catOf.get(s.rows[i]!); if (cat) catOf.set(row, cat); });
      fromBudget({ ...part, rows }, -1, { label: 0, amount: 1 }, result, s.scope, s.excluded, catOf);
    }
    else {
      // A plain two-column sheet: each row is "label: value". Money rows that name nothing are the lines of the next total or subtotal row.
      let lines: { value: number; ref: string; label: string }[] = [];
      // The fields read since the last blank row: a bare "Total" closes a uses block that names two budget fields.
      const read = new Set<string>();
      // The item a block heading named, until a blank row or a total row.
      let block = s.item;
      const valueFirstSection = isValueFirstSection(s.rows, result.format);
      const otherCategory = (cat: string) => [...catOf.values()].some((c) => fold(c) !== fold(cat));
      s.rows.forEach((row0) => {
        const cat = catOf.get(row0);
        // A Notes category marks only this row; an ordinary document title "Notes" does not exclude its inputs.
        const catExcluded = !!cat && (markedNotPart(cat) || (MEMO_SECTION_RE.test(fold(cat)) && (!WEAK_MEMO_SECTION_RE.test(fold(cat)) || otherCategory(cat))));
        const scope = (cat && scopeIn(cat)) || s.scope;
        const loanContext = s.loanScope || !!(cat && scopeIn(cat));
        if (!s.excluded && !catExcluded && namedRow(row0, table, result)) return;
        // A sentence cell is read as a sentence under the scope and exclusion in force for its row; the other cells of the row read as usual.
        const row = row0.filter((c) => !isSentenceCell(c, row0, result.format));
        for (const c of row0) {
          if (row.includes(c)) continue;
          const para: Paragraph = { text: c.text.trim(), segs: [{ start: 0, location: c.ref }], scope: s.loanScope ? s.scope : undefined, excluded: s.excluded || catExcluded || row.some((x) => markedNotPart(x.text)) };
          for (const sentence of sentences(para.text)) readSentence(sentence, para, result);
        }
        if (row.length < row0.length && !row.some((c) => c.text || c.number !== undefined)) return;
        const vf = valueFirstSection ? valueFirst(row, result.format) : null;
        const labelCell = vf?.label ?? labelOf(row, result.format);
        const relative = block && labelCell ? BLOCK_RELATIVE_RE.test(labelCell.text) : false;
        if (!row.some((c) => c.text || c.number !== undefined)) read.clear();
        if (!row.some((c) => c.text || c.number !== undefined) || (labelCell && !relative && TOTAL_RE.test(labelCell.text))) block = undefined;
        if (!labelCell) return;
        const after = vf ? [vf.value] : row.slice(row.indexOf(labelCell) + 1);
        // A row that says it is not part of the deal, or one under such a heading, is shown and never read.
        if (s.excluded || catExcluded || row.some((c) => markedNotPart(c.text))) {
          for (const cell of after) {
            const t = cellToken(cell, result.format);
            if (t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: rowContext(table.name, cat, row, labelCell, cell), rule: "table:label-value", note: NOT_PART_NOTE });
          }
          return;
        }
        const answer = after.find((c) => c.text);
        const flag = answer ? flagRead(labelCell.text, answer.text) : null;
        if (answer && flag) {
          result.candidates.push({ fieldKey: flag.fieldKey, itemKey: null, value: flag.value, raw: answer.text, unitSeen: "flag", location: answer.ref, context: `${table.name}: ${labelCell.text} ${answer.text}`.slice(0, 240), rule: "table:label-value" });
          return;
        }
        // The note for a figure the row's label does not read: why the label does not fit it.
        const laterNote = (c: Cell, x: NumberToken): string => {
          const m = mapToken(relative ? labelCell.text.replace(BLOCK_RELATIVE_RE, "") : labelCell.text, x, { scope, loanContext, ahead: c.text.slice(0, x.start), after: c.text.slice(x.end), quote: quoteDocs.has(result) });
          return m.kind === "ignored" ? m.reason : m.kind === "field" ? LATER_FIGURE_NOTE : "No field matches this label";
        };
        // Each figure after the one the label used or showed is shown, never read (task 65); a row of years adds none.
        const rest = (from: Cell, note: string | null) => {
          // A unit type's digit ("1-bed", "2 BR") is not a figure.
          const later = after.slice(after.indexOf(from) + 1).flatMap((c) => { const x = wholeUnitType(c.text) ? null : cellToken(c, result.format); return x ? [{ c, x }] : []; });
          if (later.length === 0 || after.every((c) => { const x = cellToken(c, result.format); return !x || isYearToken(x); })) return;
          for (const { c, x } of later) {
            const own = note ?? laterNote(c, x);
            result.other.push({ fieldKey: null, itemKey: null, value: x.value, raw: x.raw, unitSeen: x.unit, location: c.ref, context: rowContext(table.name, cat, row, labelCell, c), rule: "table:label-value", note: own });
          }
        };
        // The cell a per-unit budget figure hands the line to (task 68): skipped to, once the cells before it are shown.
        let skipTo: Cell | null = null;
        for (const cell of after) {
          if (skipTo && cell !== skipTo) continue;
          skipTo = null;
          const t = cellToken(cell, result.format);
          if (!t) continue;
          const base = { raw: t.raw, location: cell.ref, context: rowContext(table.name, cat, row, labelCell, cell), rule: "table:label-value" };
          let mapped = mapToken(relative ? labelCell.text.replace(BLOCK_RELATIVE_RE, "") : labelCell.text, t, { scope, loanContext, budgetConcept: filledCells(row).length === 2 && !s.rows.some((r) => TOTAL_RE.test(labelOf(r, result.format)?.text ?? "")), ahead: cell.text.slice(0, t.start), after: cell.text.slice(t.end), quote: quoteDocs.has(result) });
          if (mapped.kind !== "field" && t.value !== null && (t.unit === "$" || t.currency) && closesUses(labelCell.text, read)) mapped = mapToken("total project cost", t, { scope: s.scope });
          if (block && mapped.kind === "field" && BLOCK_FIELDS.has(mapped.fieldKey) && !(mapped.itemKey && unitTypesIn(mapped.itemKey).length > 0)) mapped = { ...mapped, itemKey: block };
          if (relative && mapped.kind === "field" && mapped.fieldKey === "stabilized_occupancy_pct") mapped = { ...mapped, fieldKey: "item_occupancy_pct", itemKey: block! };
          const label = fold(labelCell.text);
          // Under a rent roll, a row that restates the roll (a count, an area, a rent, an occupancy) is a summary, not an assumption.
          if (rollSeen && mapped.kind === "field" && ROLL_FIELDS.has(mapped.fieldKey) && !STABILIZED_LABEL_RE.test(label)) {
            result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note: ROLL_SUMMARY_NOTE });
            rest(cell, ROLL_SUMMARY_NOTE);
            break;
          }
          if (mapped.kind === "field" && REVENUE_FIELDS.has(mapped.fieldKey) && asIs(labelCell.text)) {
            result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note: AS_IS_NOTE });
            rest(cell, AS_IS_NOTE);
            break;
          }
          // A budget or financing figure whose own cell says it is per door is a share, not the line: the next cell for the same line is read instead (task 68).
          const shareLabel = `${cat ?? ""} ${labelCell.text} ${row.slice(row.indexOf(labelCell) + 1, row.indexOf(cell)).filter((c) => !cellToken(c, result.format)).map((c) => c.text).join(" ")}`;
          const shareField = perUnit(cell.text, t, shareLabel) ? budgetFieldOf(shareLabel.replace(PER_DOOR_LABEL_RE, " ")) : null;
          if ((mapped.kind === "field" && PER_UNIT_FIELDS.has(mapped.fieldKey) && perUnit(cell.text, t, BUDGET_LINES.has(mapped.fieldKey) ? shareLabel : "")) || shareField !== null) {
            result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note: PER_UNIT_NOTE });
            const field = mapped.kind === "field" ? mapped.fieldKey : shareField;
            const item = mapped.kind === "field" ? mapped.itemKey : null;
            const lineCell: Cell | undefined = after.slice(after.indexOf(cell) + 1).find((c) => {
              const x = wholeUnitType(c.text) ? null : cellToken(c, result.format);
              if (!x || x.value === null || perUnit(c.text, x) || isDeposit(c.text, x)) return false;
              const m = mapToken(relative ? labelCell.text.replace(BLOCK_RELATIVE_RE, "") : labelCell.text, x, { scope, loanContext, ahead: c.text.slice(0, x.start), after: c.text.slice(x.end), quote: quoteDocs.has(result) });
              return m.kind === "field" && m.fieldKey === field && m.itemKey === item;
            });
            if (!lineCell) {
              rest(cell, null);
              break;
            }
            for (const c of after.slice(after.indexOf(cell) + 1, after.indexOf(lineCell))) {
              const x = wholeUnitType(c.text) ? null : cellToken(c, result.format);
              if (x) result.other.push({ fieldKey: null, itemKey: null, value: x.value, raw: x.raw, unitSeen: x.unit, location: c.ref, context: rowContext(table.name, cat, row, labelCell, c), rule: "table:label-value", note: laterNote(c, x) });
            }
            skipTo = lineCell;
            continue;
          }
          record(result, mapped, t, base);
          rest(cell, mapped.kind === "field" ? "Another figure in this row was used" : null);
          if (mapped.kind === "field") read.add(mapped.fieldKey);
          if (TOTAL_RE.test(labelCell.text)) {
            const def = mapped.kind === "field" ? FIELD_BY_KEY.get(mapped.fieldKey) : undefined;
            if (mapped.kind === "field" && def?.unit === "$" && mapped.fieldKey !== "stated_total_cost" && mapped.fieldKey !== "fixed_opex_annual" && lines.length > 0) {
              const sum = lines.reduce((n, l) => n + l.value, 0);
              if (Math.abs(sum - mapped.value) > 1) {
                result.candidates.push({ ...base, fieldKey: mapped.fieldKey, itemKey: null, value: sum, raw: sum.toString(), unitSeen: withCurrency("$", t.currencyCode), location: lines.map((l) => l.ref).join(", "), context: `${table.name}: ${lines.map((l) => l.label).join(" + ")}`.slice(0, 240), rule: "table:budget-sum" });
              }
            }
            lines = [];
          } else if (mapped.kind === "unmapped" && t.value !== null && (t.unit === "$" || t.currency || (t.unit === null && Math.abs(t.value) >= 1000 && !(t.value >= 1900 && t.value <= 2100)))) {
            lines.push({ value: t.value, ref: cell.ref, label: labelCell.text });
          }
          break;
        }
      });
    }
  }
}

// Words that make a line a sentence, not a column header.
const SENTENCE_WORDS = /^(the|is|are|was|were|be|will|and|or|for|to|with|that|this|these|those|it|we|you|our|your|le|la|les|est|sont|et|ou|pour|ce|cette|ces|nous|vous|notre|votre)$/i;

/** Split a header line into columns: each ends at a role word and takes the words before it, plus a unit or "per ..." qualifier after it. */
function headerColumns(text: string, roleOf: (h: string) => string | null, ref: string): Cell[] {
  const tokens = text.match(/\([^)]*\)|\S+/g) ?? [];
  const cols: Cell[] = [];
  let pending: string[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]!;
    if (!roleOf(headerOf({ text: tok, ref }))) {
      pending.push(tok);
      continue;
    }
    const words = [...pending, tok];
    pending = [];
    for (;;) {
      const next = tokens[k + 1];
      if (next === undefined) break;
      if (/^\(.*\)$/.test(next) || /^d['’]/i.test(next) || /^(annuel(le)?|mensuel(le)?|totale)$/i.test(next)) words.push(next);
      else if (/^(per|par|au|aux|de|du|des|of|by|\/)$/i.test(next) && tokens[k + 2] !== undefined) {
        words.push(next, tokens[k + 2]!);
        k++;
      } else break;
      k++;
    }
    cols.push({ text: words.join(" "), ref: `${ref}#${cols.length + 1}` });
  }
  return cols;
}

/**
 * Tables written as lines: a header line with no numbers whose words give a rent-roll or budget column set,
 * then one line per row. A row's values are the last run of consecutive numbers, as many as the table has numeric
 * columns; the text before the run is the item. A row that does not fit ends the table and is left to the prose reader.
 * Each table is rebuilt as a Table, so the same finders read it as read a spreadsheet's. Returns the table with
 * the lines after it (where a note may say what the rent column is per), and the lines it consumed.
 */
function textTables(doc: NormalizedDocument, format: DocumentFormat, scopes: (Scope | undefined)[], excluded: boolean[]): { tables: { table: Table; notes: string[]; scope: Scope | undefined }[]; used: Set<number> } {
  const out: { table: Table; notes: string[]; scope: Scope | undefined }[] = [];
  const used = new Set<number>();
  const lines = doc.lines;
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i]!;
    const words = head.text.match(/\S+/g) ?? [];
    if (excluded[i] || words.length < 2 || words.length > 10 || /[.:;]$/.test(head.text) || words.some((w) => SENTENCE_WORDS.test(w)) || tokenize(head.text, format).length > 0) continue;
    // A rent roll's columns, else a budget's.
    let cols = headerColumns(head.text, (h) => rentRole(h), head.location);
    let kind: "rent" | "budget" = "rent";
    let numeric: number[] = [];
    let item: number[] = [];
    let extra: number | undefined;
    const rr = rentRollRoles(cols);
    if (rr) {
      numeric = [rr.units, rr.rent, rr.area, rr.occupancy].filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      item = rr.item;
      extra = rr.basis;
    } else {
      cols = headerColumns(head.text, (h) => (BUDGET_LABEL_RE.test(h) || BUDGET_WEAK_LABEL_RE.test(h) ? "label" : BUDGET_AMOUNT_RE.test(h) ? "amount" : null), head.location);
      const br = budgetRoles(cols);
      if (!br) continue;
      kind = "budget";
      numeric = [br.amount];
      item = [br.label];
    }
    const rows: Cell[][] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      // A line under a heading that marks its section as not part of the deal is left to the prose reader, which shows it.
      if (excluded[j]) break;
      // "3 480" in an English document is two numbers, not one with a space group: split what the tokenizer refused.
      const tokens = tokenize(line.text, format).flatMap((t) =>
        t.value === null && /\s/.test(t.raw)
          ? [...t.raw.matchAll(/\S+/g)].flatMap((w) => tokenize(w[0], format).map((x) => ({ ...x, start: t.start + w.index! + x.start, end: t.start + w.index! + x.end })))
          : [t],
      );
      // The last maximal run of numbers separated only by spaces, when it is exactly as long as the numeric columns.
      const runs: NumberToken[][] = [];
      for (const t of tokens) {
        const last = runs[runs.length - 1];
        if (last && /^\s*$/.test(line.text.slice(last[last.length - 1]!.end, t.start))) last.push(t);
        else runs.push([t]);
      }
      const run = runs.filter((x) => x.length === numeric.length).pop();
      if (!run) break;
      const itemText = line.text.slice(0, run[0]!.start).trim();
      // A budget amount is money, so a page number or a count in a footer is not a line.
      if (!/\p{L}/u.test(itemText) || (kind === "budget" && !(run[0]!.currency || (run[0]!.unit === null && Math.abs(run[0]!.value ?? 0) >= 1000)))) break;
      const trailing = line.text.slice(run[run.length - 1]!.end).trim();
      const cells = cols.map((c, ci): Cell => {
        const n = numeric.indexOf(ci);
        if (n >= 0) return { text: line.text.slice(run[n]!.start, run[n]!.end), ref: line.location };
        if (ci === item[0]) return { text: itemText, ref: line.location };
        return { text: ci === extra ? trailing : "", ref: line.location };
      });
      rows.push(cells);
      used.add(j);
    }
    if (rows.length === 0) continue;
    used.add(i);
    out.push({ table: { name: `Table at ${head.location}`, rows: [cols, ...rows] }, notes: lines.slice(j, j + 4).map((l) => l.text), scope: scopes[i] });
    i = j - 1;
  }
  return { tables: out, used };
}

/** A text with every figure that lies wholly inside a struck range taken out; each is shown with `other`, never read. */
function withoutStruck(text: string, struck: [number, number][] | undefined, location: string, result: ExtractionResult): string {
  if (!struck?.length) return text;
  let out = "";
  let at = 0;
  for (const t of tokenize(text, result.format)) {
    const digits = [...text.slice(t.start, t.end).matchAll(/\d/g)];
    if (digits.length === 0 || t.start < at) continue;
    const from = t.start + digits[0]!.index!;
    const to = t.start + digits.at(-1)!.index! + 1;
    if (!struck.some(([a, b]) => a <= from && to <= b)) continue;
    result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw.trim(), unitSeen: t.unit, location, context: text.slice(0, 240), rule: "line:struck", note: STRUCK_NOTE });
    out += text.slice(at, t.start);
    at = t.end;
  }
  return out + text.slice(at);
}

// ---- A money scale the document declares ("$ in thousands", "($000s)", "en milliers de dollars") -------------------
// A sheet name, a caption row, a column header or a heading line may state that its money figures are in thousands or millions. A figure with no scale of its own
// under it is read as written times the scale, and says so in `unitSeen`. A scale that measures something else is no money scale; one that cannot be read safely refuses the figures.
type Stated = { factor: number } | "unclear";
type Ruling = { factor: number } | { refuse: true };
type Scaling = { rule: Ruling | null; own: boolean };
const SCALE_PHRASE_RE = /\$\s?['’]?000s?\b|\b000s?\s?\$|['’]000s?\b|\(\s*000s?\s*\)|\$\s?mm\b|\bthousands?\b|\bmilliers?\b|\bmillions?\b/g;
const SCALE_MEASURE_RE = /\b(?:areas?|superficies?|surfaces?|sf|sq\.? ?ft|square|pi2|m2|units?|unites?|logements?|doors?|suites?|homes?|population|people|persons?|habitants?|stalls?|employees?)\b/;
const SCALE_NOTE = "The document states a scale for these amounts that Agir cannot read safely; enter the figure";
const OWN_SCALE_RE = /\d\s?(?:billions?|bn|millions?|mm|mn|m|thousands?|k)\b/i;

/** The money scales a text states, one entry per scale phrase; a phrase that measures something else (areas, units, people) is left out. */
function statedScales(text: string): Stated[] {
  const f = fold(text).replace(/²/g, "2");
  const out: Stated[] = [];
  for (const m of f.matchAll(SCALE_PHRASE_RE)) {
    const factor = /million|mm/.test(m[0]) ? 1e6 : 1e3;
    // The words between the nearest delimiters; inside parentheses the words just before them count too ("Units (thousands)").
    const left = Math.max(...[";", ",", "|", "(", ")"].map((d) => f.lastIndexOf(d, m.index! - 1)));
    const right = Math.min(...[";", ",", "|", ")"].map((d) => (f.indexOf(d, m.index! + m[0].length) + 1 || f.length + 1) - 1));
    const near = f.slice(left + 1, right);
    const money = /\$|\bdollars?\b|\b(?:cad|usd|cdn)\b/.test(near);
    const measure = SCALE_MEASURE_RE.test(f[left] === "(" ? f.slice(Math.max(0, left - 20), right) : near);
    const explicit = /\b(?:in|en)\s+(?:thousands?|millions?|milliers?)|['’]000/.test(near);
    if (money) out.push({ factor });
    else if (!measure) out.push(explicit ? { factor } : "unclear");
  }
  return out;
}

const rulingOf = (stated: Stated[]): Ruling | null => {
  if (stated.length === 0) return null;
  const factors = new Set(stated.map((s) => (s === "unclear" ? 0 : s.factor)));
  return factors.size === 1 && !factors.has(0) ? { factor: [...factors][0]! } : { refuse: true };
};

/** A heading or title line: it states a scale and holds no figure of its own. */
const isScaleHeading = (text: string, stated: Stated[]) => stated.length > 0 && text.trim().split(/\s+/).length <= 14 && !/\d/.test(fold(text).replace(SCALE_PHRASE_RE, " ").replace(/\b(?:19|20)\d\d\b/g, " "));

/** For every line location and cell reference: the scale that governs it (a heading line; a sheet name, caption row or column header, the column's header winning), and whether the cell's own text carries a scale. */
function scalings(doc: NormalizedDocument, format: DocumentFormat): Map<string, Scaling> {
  const out = new Map<string, Scaling>();
  let heading: Stated[] = [];
  const headingAt: Stated[][] = [];
  for (const l of doc.lines) {
    const stated = statedScales(l.text);
    if (isScaleHeading(l.text, stated)) heading = stated;
    // Another heading under a scale heading may start a section the scale does not cover ("Financing"): its figures are neither scaled nor read as written.
    else if (heading.length > 0 && stated.length === 0 && l.text.trim() !== "" && !/\d/.test(l.text) && l.text.trim().split(/\s+/).length <= 6) heading = ["unclear"];
    headingAt.push(heading);
    out.set(l.location, { rule: rulingOf(heading), own: false });
  }
  for (const t of doc.tables) {
    const sheet = [...statedScales(t.name), ...(t.at ? (headingAt[t.at - 1] ?? []) : [])];
    let caption: Stated[] = [];
    let columns = new Map<number, Stated[]>();
    for (const row of t.rows) {
      const stated = row.map((c) => (c.number === undefined ? statedScales(c.text) : []));
      const figure = row.some((c) => c.number !== undefined || isValueText(c, format));
      if (!figure && stated.some((x) => x.length > 0)) {
        if (row.filter((c) => c.text).length === 1) {
          caption = stated.find((x) => x.length > 0)!;
          columns = new Map();
        } else columns = new Map(stated.flatMap((x, i) => (x.length > 0 ? [[i, x] as const] : [])));
        continue;
      }
      if (!figure && row.filter((c) => c.text).length >= 2) columns = new Map();
      row.forEach((c, i) => out.set(c.ref, { rule: rulingOf(columns.get(i) ?? [...sheet, ...caption]), own: c.number === undefined && OWN_SCALE_RE.test(c.text) }));
    }
  }
  return out;
}

/** Money candidates under a declared scale are multiplied by it; ones under a scale that is unclear, or differs, are shown with a note instead. */
function applyScales(doc: NormalizedDocument, result: ExtractionResult) {
  const map = scalings(doc, result.format);
  result.candidates = result.candidates.filter((c) => {
    const def = c.fieldKey ? FIELD_BY_KEY.get(c.fieldKey) : undefined;
    if (!def || def.unit !== "$" || c.value === null || !/^(?:\$|number|CAD|USD|AUD)$/.test(c.unitSeen ?? "")) return true;
    // A location is one line ("page 1, line 4") or one cell; a sum of rows lists several.
    const locs = map.has(c.location) ? [c.location] : c.location.split(/,\s(?!line\s\d)/);
    const hits = locs.flatMap((l) => map.get(l) ?? []);
    if (hits.length === 0 || hits.every((h) => !h.rule)) return true;
    const own = hits.map((h) => h.own || (locs.length === 1 && OWN_SCALE_RE.test(c.raw)));
    if (own.every(Boolean)) return true;
    const rules = hits.map((h) => h.rule);
    const factors = new Set(rules.map((r) => (r && "factor" in r ? r.factor : 0)));
    // A figure already written in the millions is not plainly in thousands or millions: scaling it could make a $12,000,000 loan $12 billion.
    if (own.some(Boolean) || hits.length < locs.length || factors.size !== 1 || factors.has(0) || Math.abs(c.value) >= 1e6) {
      result.other.push({ ...c, fieldKey: null, itemKey: null, note: SCALE_NOTE });
      return false;
    }
    const factor = [...factors][0]!;
    c.value = Number((c.value * factor).toPrecision(12));
    c.unitSeen = withCurrency(`$ (stated in ${factor === 1e3 ? "thousands" : "millions"}; × ${factor.toLocaleString("en-US")})`, currencyOf(c.unitSeen));
    return true;
  });
}

// ---- A currency stated for a column, a table or the whole document (card 99) ------------------------------------
// The currencies `codeOf` knows, written as a code, a marked dollar or in words. "Dollars" or "$" alone names none.
const STATED_CURRENCY: [CurrencyCode, RegExp][] = [
  ["USD", /(?<![a-z])(?:usd|us\s?\$|u\.?s\.?\s+dollars?|american dollars?|\$\s?us(?![a-z])|dollars? americains?|dollars? des etats-unis)(?![a-z])/],
  ["CAD", /(?<![a-z])(?:cad|ca\s?\$|c\$|can\s?\$|canadian dollars?|\$\s?can?(?![a-z])|dollars? canadiens?)(?![a-z])/],
  ["AUD", /(?<![a-z])(?:aud|a\$|australian dollars?|\$\s?au(?![a-z])|dollars? australiens?)(?![a-z])/],
];
/** The one currency a piece of text names, or null when it names none or more than one. */
function namedCurrency(text: string): CurrencyCode | null {
  const f = fold(text);
  const named = STATED_CURRENCY.filter(([, re]) => re.test(f)).map(([code]) => code);
  return named.length === 1 ? named[0]! : null;
}
// "All amounts in US dollars", "Figures are in USD", "Currency: USD", "Tous les montants sont en dollars américains", "Devise : USD".
const CURRENCY_STATEMENT_RE = /^\s*(?:(?:all|every|the)\s+)?(?:(?:dollar\s+)?amounts?|figures?|values?|numbers?|prices?|costs?)\s+(?:(?:are|is|shown|stated|expressed|given|written)\s+)*(?:in)\s|^\s*(?:(?:tous\s+)?les\s+)?(?:montants?|chiffres?|valeurs?|prix|couts?)\s+(?:(?:sont|est|exprimes?|indiques?|donnes?)\s+)*(?:en)\s|^\s*(?:currency|devise|monnaie)\s*:/;
function currencyStatement(text: string, format: DocumentFormat): CurrencyCode | null {
  return CURRENCY_STATEMENT_RE.test(fold(text)) && tokenize(text, format).length === 0 ? namedCurrency(text) : null;
}

/** A money figure with no currency of its own takes the one its column header, its table, or the document states. */
function applyStatedCurrency(doc: NormalizedDocument, result: ExtractionResult) {
  const docCodes = new Set(doc.lines.map((l) => currencyStatement(l.text, result.format)).filter((c): c is CurrencyCode => c !== null));
  const docCode = docCodes.size === 1 ? [...docCodes][0]! : null;
  const byRef = new Map<string, CurrencyCode | null>();
  for (const table of doc.tables) {
    const statements = new Set(table.rows.flat().filter((cell) => cell.number === undefined).map((cell) => currencyStatement(cell.text, result.format)).filter((c): c is CurrencyCode => c !== null));
    const tableCode = namedCurrency(table.name) ?? (statements.size === 1 ? [...statements][0]! : null);
    const header: (CurrencyCode | null)[] = [];
    const plain = (cell: Cell) => cell.number === undefined && tokenize(cell.text, result.format, true).length === 0;
    table.rows.forEach((row) => {
      // A header row holds no figure. Its short cells that name a currency set their column's for the rows under it.
      const headerRow = row.every(plain);
      row.forEach((cell, col) => {
        const code = headerRow && cell.text.trim().split(/\s+/).length <= 5 && !currencyStatement(cell.text, result.format) ? namedCurrency(cell.text) : null;
        if (code) header[col] = code;
        else byRef.set(cell.ref, header[col] ?? tableCode ?? docCode);
      });
    });
  }
  const apply = (c: Candidate) => {
    const def = c.fieldKey ? FIELD_BY_KEY.get(c.fieldKey) : undefined;
    const money = (c.unitSeen ?? "").startsWith("$") || (def?.unit === "$" && c.unitSeen === "number");
    if (!money || currencyOf(c.unitSeen)) return;
    const locs = byRef.has(c.location) ? [c.location] : c.location.split(/,\s(?!line\s\d)/);
    const codes = new Set(locs.map((l) => (byRef.has(l) ? byRef.get(l)! : docCode)));
    const code = codes.size === 1 ? [...codes][0]! : null;
    if (code) c.unitSeen = c.unitSeen === "number" ? code : withCurrency(c.unitSeen!, code);
  };
  result.candidates.forEach(apply);
  result.other.forEach(apply);
}

/** Every candidate value in one document. Deterministic: no model is consulted. */
export function extractCandidates(doc0: NormalizedDocument): ExtractionResult {
  const result: ExtractionResult = { format: detectFormat(doc0.fullText), candidates: [], other: [], notes: [...(doc0.notes ?? [])] };
  // The document's own text is untouched; the copy read from has its struck figures taken out.
  const doc: NormalizedDocument = {
    ...doc0,
    lines: doc0.lines.map((l) => (l.struck ? { text: withoutStruck(l.text, l.struck, l.location, result), location: l.location } : l)),
    tables: doc0.tables.map((t) => ({ ...t, rows: t.rows.map((r) => r.map((c) => (c.struck ? { ...c, text: withoutStruck(c.text, c.struck, c.ref, result), struck: undefined } : c))) })),
  };
  if (isBuilderQuote(doc)) quoteDocs.add(result);
  const scopes = lineScopes(doc, result.format, rankIn(doc));
  const excluded = excludedLines(doc, result.format);
  const text = textTables(doc, result.format, scopes, excluded);
  doc.lines.forEach((l, i) => {
    if (!excluded[i] && !text.used.has(i) && namedLine(l.text, l.location, result)) text.used.add(i);
  });
  const [linesFrom, linesOtherFrom] = [result.candidates.length, result.other.length];
  fromLines(doc, result, text.used, scopes, excluded);
  conceptLinesInBudget(doc, result, linesFrom, linesOtherFrom);
  for (const t of text.tables) fromTable(t.table, result, t.notes, t.scope);
  // A Word file's paragraphs may carry the note about a rent column ("Retail rents are ..."); there is no order between them and its tables.
  const notes = doc.kind === "docx" ? doc.lines.map((l) => l.text) : [];
  // A Word table is under the heading above it: the scope in force after the lines that come before it.
  // Without a table location, use a document-wide loan scope only when it is unambiguous.
  const documentScopes = [...new Set(scopes.filter((scope) => scope !== undefined))];
  const documentScope = documentScopes.length === 1 ? documentScopes[0] : undefined;
  for (const t of doc.tables) {
    const [before, beforeOther] = [result.candidates.length, result.other.length];
    fromTable(t, result, notes, t.at ? scopes[t.at - 1] : documentScope);
    // A sheet named old, original, prior or archive holds no current figures: what it gave is shown, not read.
    // A sheet named for a scenario (downside, lender case) holds no base-case figures either (task 56).
    const old = OLD_SHEET_RE.test(fold(t.name));
    // "Base scenario" or "Scénario retenu" is the base case; "Base vs downside" still names a scenario.
    if (!old && !SCENARIO_SHEET_RE.test(fold(t.name).replace(BASE_SCENARIO_RE, " "))) continue;
    const [named, note] = old ? [OLD_SHEET_RE, SUPERSEDED_LABEL_NOTE] : [SCENARIO_SHEET_RE, SCENARIO_SHEET_NOTE];
    // (a name that also says "not part of the deal" in other words keeps that note)
    if (!markedNotPart(fold(t.name).replace(new RegExp(named, "g"), " "))) for (const o of result.other.slice(beforeOther)) if (o.note === NOT_PART_NOTE) o.note = note;
    result.candidates.splice(before).forEach((c) => result.other.push({ ...c, fieldKey: null, itemKey: null, note }));
  }
  applyScales(doc, result);
  applyStatedCurrency(doc, result);
  const aside = (c: Candidate, note: string) => result.other.push({ ...c, fieldKey: null, itemKey: null, note });
  // A later revision of a builder's quote supersedes the earlier ones; a revision heading on its own line names the revision of the lines under it.
  const heading = new Map<string, number>();
  let rev = 0;
  for (const line of doc.lines) {
    const r = revisionOf(line.text);
    if (r > 0 && !tokenize(line.text, result.format).some((t) => t.currency || t.unit === "%")) rev = r;
    heading.set(line.location, rev);
  }
  const quotes = result.candidates.filter((c) => c.rule.endsWith(":quote-total"));
  const rank = (c: Candidate) => revisionOf(c.context) || heading.get(c.location) || 0;
  const latest = Math.max(0, ...quotes.map(rank));
  if (quotes.length > 1 && latest > 0) {
    for (const c of quotes.filter((q) => rank(q) < latest)) aside(c, SUPERSEDED_NOTE);
    result.candidates = result.candidates.filter((c) => !c.rule.endsWith(":quote-total") || rank(c) >= latest);
  }
  // A per-suite roll gives way to a type summary in the same document.
  const typed = (c: Candidate) => c.itemKey !== null && c.itemKey !== "All units";
  if (result.candidates.some((c) => typed(c) && c.rule !== SUITE_RULE)) {
    result.candidates.filter((c) => c.rule === SUITE_RULE).forEach((c) => aside(c, "This document gives a summary by type; the per-suite roll is not read"));
    result.candidates = result.candidates.filter((c) => c.rule !== SUITE_RULE);
  }
  if (suiteRolls.has(result) && !result.candidates.some(typed)) result.notes.push(SUITE_ROLL_NOTE);
  // A deal-wide figure beside named items for the same field is only shown.
  const named = new Set(result.candidates.filter(typed).map((c) => c.fieldKey));
  result.candidates.filter((c) => c.itemKey === "All units" && named.has(c.fieldKey)).forEach((c) => aside(c, "This document names items for this field; a deal-wide figure is not read beside them"));
  result.candidates = result.candidates.filter((c) => !(c.itemKey === "All units" && named.has(c.fieldKey)));
  // In a document that names residential unit types, an occupancy for a commercial space is not the deal's.
  if (unitTypesIn(doc0.fullText).length > 0) {
    const commercial = (c: Candidate) => c.fieldKey === "stabilized_occupancy_pct" && COMMERCIAL_RE.test(fold(c.context.split(/[,;]/).find((p) => p.includes(c.raw)) ?? c.context));
    result.candidates.filter(commercial).forEach((c) => aside(c, "An occupancy for the commercial space, not the deal's stabilized occupancy"));
    result.candidates = result.candidates.filter((c) => !commercial(c));
  }
  // An assumption concept cannot introduce a second value beside a surviving alias read, whichever came first.
  const assumptionFields = new Set(CONCEPTS.filter((c) => c.assumption).map((c) => c.fieldKey));
  const aliases = result.candidates.filter((c) => c.rule !== "concept" && assumptionFields.has(c.fieldKey ?? ""));
  result.candidates = result.candidates.filter((c) => {
    if (c.rule !== "concept" || !assumptionFields.has(c.fieldKey ?? "") || !aliases.some((a) => a.fieldKey === c.fieldKey && a.value !== c.value)) return true;
    aside(c, "Another line already gives this figure");
    return false;
  });
  // Within one document, the same field and value found twice is one candidate.
  const seen = new Set<string>();
  result.candidates = result.candidates.filter((c) => {
    const k = `${c.fieldKey}|${c.itemKey}|${c.value}|${currencyOf(c.unitSeen)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

export { normalizeLabel };
