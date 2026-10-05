import { FIELD_BY_KEY, OUTPUT_LIKE_PHRASES } from "@agir/contracts";
import { detectFormat, normalizeText, SF_PER_M2, tokenize, unitTypesIn, type DocumentFormat, type NumberToken } from "@agir/numbers";
import type { Cell, NormalizedDocument, Table } from "./document.ts";
import { canonicalItem, currencyOf, hasPhrase, mapToken, normalizeLabel, rankScope, scopeIn, withCurrency, type MapOptions, type Mapped, type Scope } from "./mapping.ts";

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

function cellToken(cell: Cell, format: DocumentFormat): NumberToken | null {
  if (cell.number !== undefined) {
    return {
      raw: cell.text,
      start: 0,
      end: cell.text.length,
      value: cell.number,
      currency: cell.unit === "$",
      currencyCode: cell.currency ?? null,
      unit: cell.unit ?? null,
      scaled: false,
    };
  }
  const t = tokenize(cell.text, format)[0];
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

function record(result: ExtractionResult, mapped: Mapped, token: NumberToken, base: Base) {
  if (mapped.kind === "field") {
    result.candidates.push({ ...base, fieldKey: mapped.fieldKey, itemKey: mapped.itemKey, value: mapped.value, unitSeen: mapped.unitSeen });
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
  record(result, mapToken(label, token, opts), token, { raw: token.raw, location, context: context.slice(0, 240), rule });
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

type Paragraph = { text: string; segs: { start: number; location: string }[]; scope: Scope };

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

/**
 * The loan each line is about, set only by a title or heading: one of the first three lines or a "Subject:" / "Re:" / "Objet :" line
 * (forward and reply prefixes stripped, any length, numbers allowed), or a short line with no number and no sentence end.
 * A body sentence never changes it, and a heading that names two loans sets none. A document whose headings name no loan
 * is about the loan its rank row names, else the senior loan.
 */
function lineScopes(doc: NormalizedDocument, format: DocumentFormat, rank: Scope | null): Scope[] {
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
    return subject ? (!endsSentence(text) ? body : null) : (near && words <= 14 && plain) || (words <= 8 && plain) ? body : null;
  });
  const named = headings.some((h) => h !== null && scopeIn(h, false) !== null);
  let scope: Scope = named ? "senior" : (rank ?? "senior");
  return headings.map((h) => {
    if (h !== null) scope = scopeIn(h, !rank || named) ?? scope;
    return scope;
  });
}

/** A line joins the next when it does not end a sentence and the next continues it (lower case, a number or a currency sign). */
function continues(prev: string, next: string): boolean {
  // A list item ("2) ...", "- ...") starts its own paragraph.
  if (/[.!?:]\s*$/.test(prev) || !/^(\p{Ll}|\d|[$€£])/u.test(next) || /^(\d{1,2}[.)]|[-•*])\s/.test(next)) return false;
  return !(/[\d%]\s*$/.test(prev) && /^[\d$€£]/.test(next));
}

/** The lines the table reader did not consume, with a sentence wrapped across lines made one paragraph. */
function paragraphs(doc: NormalizedDocument, skip: Set<number>, scopes: Scope[]): Paragraph[] {
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
      cur = { text, segs: [{ start: 0, location: line.location }], scope: scopes[li]! };
      out.push(cur);
    }
    prev = text;
  });
  return out;
}

const ABBREVIATIONS = new Set(["ltd", "inc", "approx", "st", "ste", "no", "corp", "co", "cie", "ave", "dr", "mr", "mrs", "ms", "mme", "vs", "etc", "est", "apt", "blvd"]);

/** Split on . ! ? ; followed by a space and an upper-case letter or the end, never after a one-letter initial or an abbreviation. */
function sentences(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let from = 0;
  const add = (to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), start: from + lead });
    from = to;
  };
  for (const m of text.matchAll(/[.!?;](?=\s+\p{Lu}|\s*$)/gu)) {
    const word = /(\p{L}+)$/u.exec(text.slice(0, m.index!))?.[1] ?? "";
    if (m[0] === "." && (word.length === 1 || ABBREVIATIONS.has(word.toLowerCase()))) continue;
    add(m.index! + 1);
  }
  add(text.length);
  return out;
}

const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const HEDGE_RE = /\b(i.?d guess|i guess|or so|probably|maybe|perhaps|roughly|ballpark|not confirmed|unconfirmed|to be confirmed|tbc|a confirmer|je pense|peut-etre|somewhere|around about|give or take|or thereabouts|quelque part|environ [^.;]*ou plus)\b|(?:\d|-)ish\b/;
const BORROWED_RE = /\b(my other (?:building|property)s?|another (?:property|building)|comparables?|comps|autres? immeubles?)\b/;
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
  const label = normalizeLabel(text).label;
  const output = OUTPUT_LIKE_PHRASES.find((p) => hasPhrase(label, p));
  if (output) return `This sentence names an output figure ("${output}"), which is never taken as an input`;
  const f = fold(text);
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
    const open = same || (a.unit === null && !a.currency);
    // "5 - 7": the tokenizer read the dash as the second number's minus sign.
    const spaced = /^\s+[-–—]\s*$/.test(between) || (/^[-−]/.test(b.raw) && /^\s+$/.test(between));
    const isRange =
      (/^[-–—]$/.test(between) && open) ||
      (spaced && open) ||
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

/** The words right after a number and its unit, up to the next number, comma, semicolon, "and"/"et" or the end of the sentence. */
function followingLabel(rest: string): string | null {
  if (!/^\s+\S/.test(rest)) return null;
  let cut = rest.length;
  for (const re of [/[,;:]/, /\s(?:and|et)\s/i, /[.!?](?:\s|$)/]) {
    const m = re.exec(rest);
    if (m && m.index < cut) cut = m.index;
  }
  return rest.slice(0, cut).trim() ? rest.slice(0, cut) : null;
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
const PER_UNIT_NOTE = "A price per unit, not the total";
const PER_UNIT_REFUSED_NOTE = "The line's first figure is a price per unit; this number is not stated as its total";
const SHARE_OF_RE = /^\s*(?:of|de|du|des)\s+((?:(?:the|les?|la)\s+)?[\p{L}][\p{L}'’&/-]*(?:\s+[\p{L}'’&/-]+)*)/iu;
const SHARE_PROBE: NumberToken = { raw: "1", start: 0, end: 1, value: 1, currency: true, currencyCode: null, unit: "$", scaled: false };
const isMoney = (t: NumberToken) => t.value !== null && (t.currency || t.unit === "$");

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

// Money followed by one of these is a price for one lot, door or unit.
const EACH_RE = /^\s*(?:each|apiece|per\s+(?:lot|door|unit|suite)|chacune?|par\s+(?:lot|porte|unit[ée]|logement))(?![\p{L}])/iu;
const PER_UNIT_FIELDS = new Set(["land_cost", "hard_cost", "soft_cost", "contingency", "other_cost", "senior_loan_amount", "mezz_loan_amount", "refinance_amount", "equity_amount"]);
const TOTAL_WORD = String.raw`(?:for(?:\s+a)?(?:\s+total)?(?:\s+of)?|pour(?:\s+un\s+total\s+de)?|soit|totall?ing|in\s+total|total(?:\s+of)?|=)`;
const TOTAL_BETWEEN = [/^\s*\(\s*(?:total|soit|=)?\s*:?\s*$/i, new RegExp(String.raw`^\s*[,;]?\s*${TOTAL_WORD}\s*:?\s*\(?\s*$`, "i")];
const TOTAL_AFTER_RE = /^\s*(?:in\s+|au\s+)?total\b/i;

/** A money figure priced for one lot, door or unit: "$160,000 each", "95 000 $ par porte". */
function perUnit(text: string, t: NumberToken): boolean {
  return t.unit === "$" && t.value !== null && EACH_RE.test(text.slice(t.end));
}

/** The total a per-unit price states for itself: the next money figure when it sits in parentheses after the price, follows "total", "for", "soit" or "pour un total de", or is followed by "total". */
function totalOf(text: string, t: NumberToken, tokens: NumberToken[]): NumberToken | null {
  const next = tokens.find((x) => x.start >= t.end && isMoney(x));
  if (!next) return null;
  // A parenthesised token's own text starts at its "(".
  const between = (text.slice(t.end, next.start) + (next.raw.startsWith("(") ? "(" : "")).replace(EACH_RE, "");
  return TOTAL_BETWEEN.some((re) => re.test(between)) || (/^\s*[,;]?\s*$/.test(between) && TOTAL_AFTER_RE.test(text.slice(next.end))) ? next : null;
}

/** One sentence: "Label: value" gives the label to the numbers after the colon; anything else is prose. */
function readSentence(sentence: { text: string; start: number }, para0: Paragraph, result: ExtractionResult) {
  const text = normalizeText(sentence.text);
  // A short label that names a loan ("Take-out: ...") scopes every number on its line, the prose after the colon too; the next line is back under the document's scope.
  const label = text.slice(0, Math.max(text.indexOf(":"), 0));
  const inline = label.split(/\s+/).length <= 8 ? scopeIn(label, false) : null;
  const para = inline ? { ...para0, scope: inline } : para0;
  const locationOf = (pos: number) => para.segs.reduce((loc, g) => (g.start <= sentence.start + pos ? g.location : loc), para.segs[0]!.location);
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
  const refusal = sentenceRefusal(text);
  if (refusal) {
    for (const t of tokens) other(t, "line:prose", refusal);
    return;
  }
  // A year is never money: it is shown as a year.
  const years = tokens.filter((t) => isYear(text, tokens, t));
  for (const t of years) other(t, "line:prose", "This is a year, not an amount");
  tokens = tokens.filter((t) => !years.includes(t));
  // A figure the sentence says is replaced by another is shown, not read.
  const folded = fold(text);
  const replacing = /\b(replaces?|replacing|supersedes?|remplace(?:nt)?)\b/.exec(folded);
  const replacedBy = /\b(replaced by|superseded by|remplacee? par)\b/.exec(folded);
  const replaced = tokens.filter((t) => (replacing && t.start >= replacing.index + replacing[0].length) || (replacedBy && t.end <= replacedBy.index));
  for (const t of replaced) other(t, "line:prose", "A later figure in the same sentence replaces this one");
  tokens = tokens.filter((t) => !replaced.includes(t));
  const colon = text.indexOf(":");
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
  const shares = shareBases(text, tokens, para.scope);
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
    const first = tokens.map((t) => mapToken(label, t, { scope })).find((m) => m.kind === "field");
    const unitField = first?.kind === "field" && first.itemKey !== null && UNIT_FIELDS.has(first.fieldKey);
    const labelTypes = unitTypesIn(label);
    if (unitField && labelTypes.length <= 1 && (labelTypes.length === 1 || unitTypesIn(text.slice(colon + 1)).length > 0)) {
      proseFrom = colon + 1;
      lead = labelTypes[0] ?? null;
      bareCount = true;
    } else if (tokens.every((t) => mapToken(label, t, { scope }).kind === "unmapped")) proseFrom = colon + 1;
    else {
      let used = false;
      let refusedPerUnit = false;
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
          const own = used ? null : mapToken(label, t, { scope });
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
        let mapped = used ? { kind: "unmapped" as const } : mapToken(label, t, { scope, ahead: text.slice(colon + 1, t.start) });
        if (mapped.kind === "field" && PER_UNIT_FIELDS.has(mapped.fieldKey) && perUnit(text, t)) {
          other(t, "line:label-value", PER_UNIT_NOTE);
          refusedPerUnit = true;
          total = totalOf(text, t, tokens);
          continue;
        }
        // A place before the colon ("Kelowna, British Columbia", "Gatineau (Québec)") is not an item: that count is the deal-wide count. A single word is kept as a component name ("Residential: 160 units").
        if (/[,(]/.test(label) && mapped.kind === "field" && mapped.fieldKey === "unit_count" && mapped.itemKey !== null && mapped.itemKey !== "All units" && unitTypesIn(mapped.itemKey).length === 0) mapped = { ...mapped, itemKey: "All units" };
        if (!used && mapped.kind === "field") {
          record(result, mapped, t, { raw: t.raw, location: locationOf(t.start), context: context.slice(0, 240), rule: "line:label-value" });
          used = true;
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
  tokens.forEach((t, i) => {
    const where = locationOf(t.start);
    if (ranged.has(i)) {
      other(t, "line:prose", RANGE_NOTE);
      from = t.end;
      return;
    }
    // The base of a share ("of hard costs" after "4%") names nothing for the figures after it.
    const afterShare = isMoney(t) && shares.some(([, end]) => t.start >= end);
    const label = shares.reduce((l, [a, b]) => (b > from && a < t.start ? l.slice(0, Math.max(a - from, 0)) + " ".repeat(Math.min(b, t.start) - Math.max(a, from)) + l.slice(Math.min(b, t.start) - from) : l), text.slice(from, t.start));
    const opts: MapOptions = { prose: true, scope: para.scope, context: text };
    let usedLabel = totalLabels.get(t) ?? label;
    let mapped = mapToken(usedLabel, t, opts);
    from = t.end;
    if (afterShare && mapped.kind !== "field") {
      other(t, "line:prose", SHARE_NOTE);
      return;
    }
    if (!afterShare && !totalLabels.has(t) && (mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("Looks like")))) {
      const after = followingLabel(text.slice(t.end, tokens[i + 1]?.start ?? text.length));
      const viaAfter = after === null ? null : mapToken(after, t, opts);
      if (after !== null && viaAfter!.kind === "field") {
        mapped = viaAfter!;
        usedLabel = after;
        from = t.end + after.length;
      } else if (after !== null && viaAfter!.kind === "ignored" && mapped.kind === "unmapped") mapped = viaAfter!;
    }
    if (bareCount && i === 0 && t.unit === null && t.value !== null && Number.isInteger(t.value) && t.value > 0 && mapped.kind === "unmapped") {
      const types = unitTypesIn(clauseOf(text, t));
      if (types.length === 0 && lead) types.push(lead);
      if (types.length === 1) mapped = { kind: "field", fieldKey: "unit_count", itemKey: types[0]!, value: t.value, unitSeen: "units" };
    }
    if (mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("Looks like"))) mapped = clauseItem(text, t, lead) ?? mapped;
    // A count whose clause names no unit type is the deal-wide count.
    if (bareCount && mapped.kind === "unmapped" && t.unit === "units" && t.value !== null) mapped = { kind: "field", fieldKey: "unit_count", itemKey: "All units", value: t.value, unitSeen: "units" };
    else if (mapped.kind === "field" && mapped.itemKey !== null && (UNIT_FIELDS.has(mapped.fieldKey) && (proseFrom > 0 || mapped.fieldKey === "unit_count" || mapped.fieldKey === "unit_rent_monthly"))) {
      // The clause's unit type names the item, not the words before the label ("Studios will rent at ...").
      const types = unitTypesIn(clauseOf(text, t));
      if (types.length === 0 && lead) types.push(lead);
      if (types.length === 1) mapped = { ...mapped, itemKey: types[0]! };
    }
    if (mapped.kind === "field" && PER_UNIT_FIELDS.has(mapped.fieldKey) && perUnit(text, t)) {
      other(t, "line:prose", PER_UNIT_NOTE);
      const total = totalOf(text, t, tokens);
      if (total) totalLabels.set(total, usedLabel);
      return;
    }
    record(result, mapped, t, { raw: t.raw, location: where, context, rule: "line:prose" });
  });
}

/** Prose: sentences of text, each read on its own. Lines in `skip` were read as table rows. */
function fromLines(doc: NormalizedDocument, result: ExtractionResult, skip: Set<number>, scopes: Scope[]) {
  for (const para of paragraphs(doc, skip, scopes)) for (const s of sentences(para.text)) readSentence(s, para, result);
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
const MONTHLY_RE = /\b(monthly|per month|mensuel(le)?|par mois|mois)\b|\/\s?mo\b/;
const ANNUAL_RE = /\b(annual|yearly|annuel(le)?|per year|per annum|par annee|par an)\b|\/\s?yr\b/;

type RentRole = "units" | "item" | "rent" | "basis" | "area" | "occupancy";

function rentRole(h: string): RentRole | null {
  // French: "Nombre de logements" counts units; "Type de logement" and "Unité" name them; "Loyer par logement" is a rent.
  if (/\b(nombre|nbre|nb|quantite)\b/.test(h)) return "units";
  // "Rent per suite" is a rent, not an item; a lone "Unit" names the row.
  if (!/\b(rent|loyer)\b/.test(h) && (h.trim() === "unit" || /\b(unit\s*type|type|component|space|tenant|suite|plan|floor\s*plan|use)\b/.test(h) || /\b(logement|unite|appartement|locataire|espace|local)\b/.test(h))) return "item";
  if (/\b(units|unit count|count|#|doors|suites|homes|logements|unites|appartements)\b/.test(h)) return "units";
  if (/\b(rent|loyer)\b/.test(h) && !/basis/.test(h)) return "rent";
  if (/basis/.test(h)) return "basis";
  if (/\b(area|sf|nrsf|rsf|gla|square feet|superficie|surface|pi2)\b/.test(h) || M2_RE.test(h)) return "area";
  if (/occupancy|occupation|occ\b/.test(h)) return "occupancy";
  return null;
}

function rentRollRoles(header: Cell[]): Roles | null {
  const roles: Roles = { item: [], psfHeader: false, rentBasis: null, areaM2: false, rentPerM2: false, areaTotal: false };
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (!h) return;
    const role = rentRole(h);
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
  return roles.item.length > 0 && roles.rent !== undefined && (roles.units !== undefined || roles.area !== undefined) ? roles : null;
}

const BUDGET_LABEL_RE = /\b(line\s*item|description|category|item|cost\s*item|use|poste|libelle|designation|categorie|rubrique)\b/;
// A label column named by one of these only when no column is named by the words above ("Division | Description | Amount" is labelled by its description).
const BUDGET_WEAK_LABEL_RE = /\b(line|division)\b/;
const BUDGET_AMOUNT_RE = /\b(amount|cost|budget|total|montant|couts?|\$)\b/;

function budgetRoles(header: Cell[]): { label: number; amount: number } | null {
  let label = -1;
  let weak = -1;
  let amount = -1;
  header.forEach((c, i) => {
    const h = headerOf(c);
    if (label < 0 && BUDGET_LABEL_RE.test(h)) label = i;
    else if (weak < 0 && BUDGET_WEAK_LABEL_RE.test(h)) weak = i;
    else if (amount < 0 && BUDGET_AMOUNT_RE.test(h)) amount = i;
  });
  if (label < 0) label = weak;
  return label >= 0 && amount >= 0 ? { label, amount } : null;
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
const SUITE_ID_RE = /^(?:(?:suite|unit|apt|apartment|no\.?|#|logement|app\.?)\s*)?\d{1,4}[A-Za-z]?$/i;
const ROLL_SUMMARY_NOTE = "A rent roll's summary row is not an assumption";
const SUMMARY_LABEL_RE = /\b(occupancy|occupation|occupied|average|avg|moyen\w*)\b/;
const STABILIZED_LABEL_RE = /\b(stabili[sz]ed|stabilis\w*|projected|pro forma|projet\w*)\b/;
const DIFFERENT_RENTS_NOTE = "Suites of this type rent at different amounts; enter the rent to use";

/** A rent-roll row's item as the unit type, and whether the row is one suite of it (a suite number or code beside or before the type). */
function suiteItem(parts: string[]): { type: string; suite: boolean } {
  const ids = parts.filter((p) => SUITE_ID_RE.test(p));
  const named = parts.filter((p) => !SUITE_ID_RE.test(p));
  if (ids.length > 0 && named.length > 0) return { type: canonicalItem(named.join(" ").replace(/\s+/g, " ")), suite: true };
  const one = parts.join(" ").replace(/\s+/g, " ").trim();
  // A leading number is a suite number unless the type needs it ("1 chambre", "2 bed").
  const lead = /^(?:(?:suite|unit|apt|apartment|no\.?|#|logement|app\.?)\s*)?\d{1,4}[A-Za-z]?\s+(\S.*)$/i.exec(one);
  if (parts.length === 1 && lead && unitTypesIn(lead[1]!).join() === unitTypesIn(one).join()) return { type: canonicalItem(lead[1]!), suite: true };
  // "TH-1", "TH-2": suites of the type "TH".
  const code = /^([A-Za-z]{1,4})[-\s]?\d{1,3}$/.exec(one);
  if (parts.length === 1 && code) return { type: code[1]!.toUpperCase(), suite: true };
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
  const typeOf = (row: Cell[]) => suiteItem(roles.item.map((i) => row[i]?.text ?? "").filter(Boolean));
  const repeats = new Map<string, number>();
  for (const row of body) if (row.some((c) => c.text)) repeats.set(typeOf(row).type, (repeats.get(typeOf(row).type) ?? 0) + 1);
  const suiteRows: { type: string; ref: string; cands: Candidate[] }[] = [];
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const itemParts = roles.item.map((i) => row[i]?.text ?? "").filter(Boolean);
    const itemText = itemParts.join(" ").trim();
    if (!itemText || itemParts.some((p) => TOTAL_RE.test(p))) continue;
    // A summary row of the roll (an occupancy, an average) is not an assumption.
    if (SUMMARY_LABEL_RE.test(fold(itemText)) && !STABILIZED_LABEL_RE.test(fold(itemText))) {
      const cell = row.find((c, i) => !roles.item.includes(i) && (c.number !== undefined || /\d/.test(c.text)));
      const t = cell && cellToken(cell, result.format);
      if (cell && t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: ROLL_SUMMARY_NOTE });
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

function fromBudget(table: Table, headerRow: number, roles: { label: number; amount: number }, result: ExtractionResult, scope: Scope) {
  // Sum component lines per field; use a "Total X" row only when no component
  // line mapped to X, and raise both when they disagree. A line that maps to no
  // field, between the header (or the previous total) and a total row for X, is a component of X.
  // A line in another currency is never added to the deal's own: sums are kept per field and currency.
  const components = new Map<string, { fieldKey: string; unitSeen: string; sum: number; refs: string[]; labels: string[]; rows: { value: number; ref: string; label: string }[] }>();
  const totals: Candidate[] = [];
  let started = false;
  let segment: { value: number; unitSeen: string; ref: string; label: string; shown: Candidate }[] = [];
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const labelCell = row[roles.label];
    const amountCell = row[roles.amount];
    if (!labelCell?.text || !amountCell) continue;
    const t = cellToken(amountCell, result.format);
    if (!t) continue;
    // A row in a budget sheet that is not money ("Loan-to-cost | 70%") is a label and value.
    if (t.unit !== null && t.unit !== "$") {
      push(result, labelCell.text, t, amountCell.ref, `${table.name}: ${labelCell.text} ${amountCell.text}`, "table:label-value", { scope });
      continue;
    }
    // A figure the label says is part of another budget field adds nothing of its own.
    const counted = partOfNote(labelCell.text, false);
    if (counted) {
      result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: "$", location: amountCell.ref, context: `${table.name}: ${labelCell.text}`, rule: "table:budget", note: counted });
      continue;
    }
    const isTotal = TOTAL_RE.test(labelCell.text);
    // Unread rows with nothing read or totalled above them are the whole table's breakdown of its first total.
    const bare = !started;
    if (isTotal) started = true;
    const lines = segment;
    if (isTotal) segment = [];
    const labelText = isTotal ? labelCell.text.replace(TOTAL_RE, "").trim() || labelCell.text : labelCell.text;
    const moneyToken: NumberToken = { ...t, currency: true, unit: t.unit ?? "$" };
    const mapped = mapToken(isTotal && /development|project/i.test(labelCell.text) ? labelCell.text : labelText, moneyToken, { scope, budget: true });
    if (mapped.kind !== "field" || FIELD_BY_KEY.get(mapped.fieldKey)?.unit !== "$") {
      const shown: Candidate = {
        fieldKey: null,
        itemKey: null,
        value: t.value,
        raw: t.raw,
        unitSeen: "$",
        location: amountCell.ref,
        context: `${table.name}: ${labelCell.text}`,
        rule: "table:budget",
        note: mapped.kind === "ignored" ? mapped.reason : "No budget line matches this label",
      };
      if (mapped.kind === "unmapped" && !isTotal && t.value !== null) segment.push({ value: t.value, unitSeen: withCurrency("$", t.currencyCode), ref: amountCell.ref, label: labelCell.text, shown });
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
      context: `${table.name}: ${labelCell.text}`,
      rule: isTotal ? "table:budget-total" : "table:budget",
    };
    const add = (value: number, unitSeen: string, ref: string, label: string) => {
      const ck = `${mapped.fieldKey}|${unitSeen}`;
      const acc = components.get(ck) ?? { fieldKey: mapped.fieldKey, unitSeen, sum: 0, refs: [], labels: [], rows: [] };
      acc.sum += value;
      acc.refs.push(ref);
      acc.labels.push(label);
      acc.rows.push({ value, ref, label });
      components.set(ck, acc);
    };
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
    // A row that is read ends the run of unread rows.
    segment = [];
    started = true;
    add(mapped.value, cand.unitSeen!, amountCell.ref, labelCell.text);
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
    });
  }
  for (const t of totals) {
    const comp = components.get(`${t.fieldKey}|${t.unitSeen}`);
    if (!comp) result.candidates.push(t);
    else if (Math.abs(comp.sum - (t.value ?? 0)) > 1) {
      result.candidates.push({ ...t, note: `The printed total does not equal the sum of its lines (${comp.sum.toLocaleString("en-US")})` });
    }
  }
}

/** A row that is only a short text, no number: a section label ("SENIOR LOAN", "Unit mix", "Répartition des logements"). */
function sectionLabel(row: Cell[]): string | null {
  const filled = row.filter((c) => c.text || c.number !== undefined);
  const c = filled[0];
  if (filled.length !== 1 || !c || c.number !== undefined || /\d/.test(c.text) || /[.!?]$/.test(c.text) || c.text.trim().split(/\s+/).length > 8) return null;
  return c.text;
}

type Section = { rows: Cell[][]; scope: Scope; rent?: Roles; budget?: { label: number; amount: number } };

/**
 * A sheet may stack sections. A row that is itself a header (a rent roll's or a budget's) ends the section before it and starts
 * its own; a section label row ends it too, sets the loan scope when it names a loan, and the rows under it with no column header
 * are label and value rows. Rows above the first header, when there is one and no label came first, are a title and read as nothing.
 */
function fromTable(table: Table, result: ExtractionResult, notes: string[] = [], scope0: Scope = "senior") {
  // A rank row names the loan for the whole table, the rows above it too; a section label below still overrides it.
  let scope = tableRank(table) ?? scope0;
  let labelled = false;
  const sections: Section[] = [];
  let cur: Section = { rows: [], scope };
  const close = () => {
    if (cur.rows.length > 0) sections.push(cur);
  };
  table.rows.forEach((row) => {
    const numeric = row.some((c) => c.number !== undefined);
    const rent = numeric ? null : rentRollRoles(row);
    const budget = numeric || rent ? null : budgetRoles(row);
    if (rent || budget) {
      if (!cur.rent && !cur.budget && sections.length === 0 && !labelled) cur.rows = [];
      close();
      cur = { rows: [row], scope, ...(rent ? { rent } : { budget: budget! }) };
      return;
    }
    const label = sectionLabel(row);
    if (label !== null) {
      close();
      scope = scopeIn(label) ?? scope;
      labelled = true;
      cur = { rows: [], scope };
      return;
    }
    cur.rows.push(row);
  });
  close();
  let rollSeen = false;
  for (const s of sections) {
    const part = { ...table, rows: s.rows };
    if (s.rent) {
      fromRentRoll(part, 0, s.rent, result, notes);
      rollSeen = true;
    }
    else if (s.budget) fromBudget(part, 0, s.budget, result, s.scope);
    else {
      // A plain two-column sheet: each row is "label: value". Money rows that name nothing are the lines of the next total or subtotal row.
      let lines: { value: number; ref: string; label: string }[] = [];
      s.rows.forEach((row) => {
        const labelCell = row.find((c) => c.text && c.number === undefined && !/^[\d$(.,\s%-]+$/.test(c.text));
        if (!labelCell) return;
        const after = row.slice(row.indexOf(labelCell) + 1);
        for (const cell of after) {
          const t = cellToken(cell, result.format);
          if (!t) continue;
          const base = { raw: t.raw, location: cell.ref, context: `${table.name}: ${labelCell.text} ${cell.text}`.slice(0, 240), rule: "table:label-value" };
          const mapped = mapToken(labelCell.text, t, { scope: s.scope, ahead: cell.text.slice(0, t.start) });
          const label = fold(labelCell.text);
          // Under a rent roll, a row that restates the roll (a count, an area, a rent, an occupancy) is a summary, not an assumption.
          if (rollSeen && mapped.kind === "field" && ROLL_FIELDS.has(mapped.fieldKey) && !STABILIZED_LABEL_RE.test(label)) {
            result.other.push({ ...base, fieldKey: null, itemKey: null, value: t.value, unitSeen: t.unit, note: ROLL_SUMMARY_NOTE });
            break;
          }
          record(result, mapped, t, base);
          if (TOTAL_RE.test(labelCell.text)) {
            const def = mapped.kind === "field" ? FIELD_BY_KEY.get(mapped.fieldKey) : undefined;
            if (mapped.kind === "field" && def?.unit === "$" && mapped.fieldKey !== "stated_total_cost" && lines.length > 0) {
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
function textTables(doc: NormalizedDocument, format: DocumentFormat, scopes: Scope[]): { tables: { table: Table; notes: string[]; scope: Scope }[]; used: Set<number> } {
  const out: { table: Table; notes: string[]; scope: Scope }[] = [];
  const used = new Set<number>();
  const lines = doc.lines;
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i]!;
    const words = head.text.match(/\S+/g) ?? [];
    if (words.length < 2 || words.length > 10 || /[.:;]$/.test(head.text) || words.some((w) => SENTENCE_WORDS.test(w)) || tokenize(head.text, format).length > 0) continue;
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
    out.push({ table: { name: `Table at ${head.location}`, rows: [cols, ...rows] }, notes: lines.slice(j, j + 4).map((l) => l.text), scope: scopes[i]! });
    i = j - 1;
  }
  return { tables: out, used };
}

/** Every candidate value in one document. Deterministic: no model is consulted. */
export function extractCandidates(doc: NormalizedDocument): ExtractionResult {
  const result: ExtractionResult = { format: detectFormat(doc.fullText), candidates: [], other: [], notes: [...(doc.notes ?? [])] };
  const scopes = lineScopes(doc, result.format, rankIn(doc));
  const text = textTables(doc, result.format, scopes);
  fromLines(doc, result, text.used, scopes);
  for (const t of text.tables) fromTable(t.table, result, t.notes, t.scope);
  // A Word file's paragraphs may carry the note about a rent column ("Retail rents are ..."); there is no order between them and its tables.
  const notes = doc.kind === "docx" ? doc.lines.map((l) => l.text) : [];
  // A Word table is under the heading above it: the scope in force after the lines that come before it.
  for (const t of doc.tables) fromTable(t, result, notes, (t.at ? scopes[t.at - 1] : undefined) ?? "senior");
  // A per-suite roll gives way to a type summary in the same document.
  const aside = (c: Candidate, note: string) => result.other.push({ ...c, fieldKey: null, itemKey: null, note });
  const typed = (c: Candidate) => c.itemKey !== null && c.itemKey !== "All units";
  if (result.candidates.some((c) => typed(c) && c.rule !== SUITE_RULE)) {
    result.candidates.filter((c) => c.rule === SUITE_RULE).forEach((c) => aside(c, "This document gives a summary by type; the per-suite roll is not read"));
    result.candidates = result.candidates.filter((c) => c.rule !== SUITE_RULE);
  }
  // A deal-wide figure beside named items for the same field is only shown.
  const named = new Set(result.candidates.filter(typed).map((c) => c.fieldKey));
  result.candidates.filter((c) => c.itemKey === "All units" && named.has(c.fieldKey)).forEach((c) => aside(c, "This document names items for this field; a deal-wide figure is not read beside them"));
  result.candidates = result.candidates.filter((c) => !(c.itemKey === "All units" && named.has(c.fieldKey)));
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
