import { FIELD_BY_KEY, OUTPUT_LIKE_PHRASES } from "@agir/contracts";
import { detectFormat, normalizeText, SF_PER_M2, tokenize, type DocumentFormat, type NumberToken } from "@agir/numbers";
import type { Cell, NormalizedDocument, Table } from "./document.ts";
import { currencyOf, hasPhrase, mapToken, normalizeLabel, withCurrency, type Mapped } from "./mapping.ts";

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
  return tokenize(cell.text, format)[0] ?? null;
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

function push(result: ExtractionResult, label: string, token: NumberToken, location: string, context: string, rule: string, prose = false) {
  record(result, mapToken(label, token, prose), token, { raw: token.raw, location, context: context.slice(0, 240), rule });
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

type Paragraph = { text: string; segs: { start: number; location: string }[] };

/** A line joins the next when it does not end a sentence and the next continues it (lower case, a number or a currency sign). */
function continues(prev: string, next: string): boolean {
  if (/[.!?:]\s*$/.test(prev) || !/^(\p{Ll}|\d|[$€£])/u.test(next)) return false;
  return !(/[\d%]\s*$/.test(prev) && /^[\d$€£]/.test(next));
}

/** The lines the table reader did not consume, with a sentence wrapped across lines made one paragraph. */
function paragraphs(doc: NormalizedDocument, skip: Set<number>): Paragraph[] {
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
      cur = { text, segs: [{ start: 0, location: line.location }] };
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
const HEDGE_RE = /\b(i.?d guess|i guess|or so|probably|maybe|perhaps|roughly|ballpark|not confirmed|unconfirmed|to be confirmed|tbc|a confirmer|je pense|peut-etre)\b|(?:\d|-)ish\b/;
const BORROWED_RE = /\b(my other (?:building|property)s?|another (?:property|building)|comparables?|comps|autres? immeubles?)\b/;
const MONTH_BEFORE_YEAR = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|in|en|since|depuis)\.?[,\s]*$/;
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
function rangeEnds(text: string, tokens: NumberToken[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 1 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (a.value === null || b.value === null) continue;
    const between = text.slice(a.end, b.start);
    const before = text.slice(0, a.start);
    const lead = /\b(from|de|d['’])\s*$/i.test(before);
    const same = a.unit === b.unit && a.currency === b.currency;
    const open = same || (a.unit === null && !a.currency);
    // "5 - 7": the tokenizer read the dash as the second number's minus sign.
    const spaced = /^\s*[-–—]\s+$/.test(between) || (/^[-−]/.test(b.raw) && /^\s+$/.test(between));
    const isRange =
      (/^[-–—]$/.test(between) && open) ||
      (spaced && same) ||
      (/^\s+(to|à)\s+$/i.test(between) && (open || lead)) ||
      (/^\s+(and|et)\s+$/i.test(between) && /\b(between|entre)\s*$/i.test(before));
    if (isRange) {
      out.add(i);
      out.add(i + 1);
    }
  }
  return out;
}

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

/** One sentence: "Label: value" gives the label to the numbers after the colon; anything else is prose. */
function readSentence(sentence: { text: string; start: number }, para: Paragraph, result: ExtractionResult) {
  const text = normalizeText(sentence.text);
  const locationOf = (pos: number) => para.segs.reduce((loc, g) => (g.start <= sentence.start + pos ? g.location : loc), para.segs[0]!.location);
  let tokens = tokenize(text, result.format);
  // A number inside parentheses before the first number outside them is part of the label ("Parking (14 stalls) $8,400").
  const spans = parenSpans(text);
  const inParen = (t: NumberToken) => spans.some(([a, b]) => t.start >= a && t.end <= b);
  const firstOutside = tokens.find((t) => !inParen(t));
  if (firstOutside) tokens = tokens.filter((t) => !(inParen(t) && t.start < firstOutside.start));
  if (tokens.length === 0) return;
  const context = sentence.text.slice(0, 240);
  // A range's "5 - 7" is read with the dash as the second number's sign: shown as written, positive.
  const shown = (t: NumberToken, note: string) => (t.value !== null && t.value < 0 && note === RANGE_NOTE && /^[-−]\s*[$\d]/.test(t.raw) ? -t.value : t.value);
  const other = (t: NumberToken, rule: string, note: string) =>
    result.other.push({ fieldKey: null, itemKey: null, value: shown(t, note), raw: t.raw, unitSeen: t.unit, location: locationOf(t.start), context, rule, note });
  const refusal = sentenceRefusal(text);
  if (refusal) {
    for (const t of tokens) other(t, "line:prose", refusal);
    return;
  }
  const colon = text.indexOf(":");
  let proseFrom = 0;
  if (colon > 0 && tokens[0]!.start > colon) {
    // Label-first: every number after the colon shares the label. The first
    // number compatible with a field wins; the rest are kept as "other".
    const label = text.slice(0, colon);
    // A label that names nothing for any number ("Financing: a loan of ...") is an introduction: what follows is prose.
    if (tokens.every((t) => mapToken(label, t).kind === "unmapped")) proseFrom = colon + 1;
    else {
      let used = false;
      for (const t of tokens) {
        const mapped = used ? { kind: "unmapped" as const } : mapToken(label, t);
        if (!used && mapped.kind === "field") {
          push(result, label, t, locationOf(t.start), context, "line:label-value");
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
  tokens.forEach((t, i) => {
    const where = locationOf(t.start);
    if (ranged.has(i)) {
      other(t, "line:prose", RANGE_NOTE);
      from = t.end;
      return;
    }
    const label = text.slice(from, t.start);
    const bare = t.unit === null && !t.currency && /^\d{4}$/.test(t.raw) && t.value !== null && t.value >= 1900 && t.value <= 2100;
    if (bare && MONTH_BEFORE_YEAR.test(fold(label))) {
      other(t, "line:prose", "This is a year, not an amount");
      from = t.end;
      return;
    }
    let mapped = mapToken(label, t, true);
    from = t.end;
    if (mapped.kind === "unmapped" || (mapped.kind === "ignored" && mapped.reason.startsWith("Looks like"))) {
      const after = followingLabel(text.slice(t.end, tokens[i + 1]?.start ?? text.length));
      const viaAfter = after === null ? null : mapToken(after, t, true);
      if (after !== null && viaAfter!.kind === "field") {
        mapped = viaAfter!;
        from = t.end + after.length;
      }
    }
    record(result, mapped, t, { raw: t.raw, location: where, context, rule: "line:prose" });
  });
}

/** Prose: sentences of text, each read on its own. Lines in `skip` were read as table rows. */
function fromLines(doc: NormalizedDocument, result: ExtractionResult, skip: Set<number>) {
  for (const para of paragraphs(doc, skip)) for (const s of sentences(para.text)) readSentence(s, para, result);
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
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const itemParts = roles.item.map((i) => row[i]?.text ?? "").filter(Boolean);
    const itemText = itemParts.join(" ").trim();
    if (!itemText || itemParts.some((p) => TOTAL_RE.test(p))) continue;
    const itemKey = itemText.replace(/\s+/g, " ");
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
      result.candidates.push({ fieldKey, itemKey, value, raw: t.raw, unitSeen, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", ...(note ? { note } : {}) });
    };
    add("unit_count", roles.units);
    if (basis === null) {
      const cell = roles.rent !== undefined ? row[roles.rent] : undefined;
      const t = cell && (cell.text || cell.number !== undefined) ? cellToken(cell, result.format) : null;
      if (cell && t) result.other.push({ fieldKey: null, itemKey: null, value: t.value, raw: t.raw, unitSeen: t.unit, location: cell.ref, context: `${table.name}: ${itemText}`, rule: "table:rent-roll", note: BASIS_UNSTATED });
    } else add(basis === "psf" ? "rent_psf_annual" : "unit_rent_monthly", roles.rent, basis);
    if (basis === "psf" || (basis !== null && roles.units !== undefined)) add("rentable_area_sf", roles.area);
    add("item_occupancy_pct", roles.occupancy);
  }
}

function fromBudget(table: Table, headerRow: number, roles: { label: number; amount: number }, result: ExtractionResult) {
  // Sum component lines per field; use a "Total X" row only when no component
  // line mapped to X, and raise both when they disagree. A line that maps to no
  // field, between the header (or the previous total) and a total row for X, is a component of X.
  // A line in another currency is never added to the deal's own: sums are kept per field and currency.
  const components = new Map<string, { fieldKey: string; unitSeen: string; sum: number; refs: string[]; labels: string[] }>();
  const totals: Candidate[] = [];
  let segment: { value: number; unitSeen: string; ref: string; label: string }[] = [];
  for (let r = headerRow + 1; r < table.rows.length; r++) {
    const row = table.rows[r]!;
    const labelCell = row[roles.label];
    const amountCell = row[roles.amount];
    if (!labelCell?.text || !amountCell) continue;
    const t = cellToken(amountCell, result.format);
    if (!t) continue;
    // A row in a budget sheet that is not money ("Loan-to-cost | 70%") is a label and value.
    if (t.unit !== null && t.unit !== "$") {
      push(result, labelCell.text, t, amountCell.ref, `${table.name}: ${labelCell.text} ${amountCell.text}`, "table:label-value");
      continue;
    }
    const isTotal = TOTAL_RE.test(labelCell.text);
    const lines = segment;
    if (isTotal) segment = [];
    const labelText = isTotal ? labelCell.text.replace(TOTAL_RE, "").trim() || labelCell.text : labelCell.text;
    const moneyToken: NumberToken = { ...t, currency: true, unit: t.unit ?? "$" };
    const mapped = mapToken(isTotal && /development|project/i.test(labelCell.text) ? labelCell.text : labelText, moneyToken);
    if (mapped.kind !== "field" || FIELD_BY_KEY.get(mapped.fieldKey)?.unit !== "$") {
      if (mapped.kind === "unmapped" && !isTotal && t.value !== null) segment.push({ value: t.value, unitSeen: withCurrency("$", t.currencyCode), ref: amountCell.ref, label: labelCell.text });
      result.other.push({
        fieldKey: null,
        itemKey: null,
        value: t.value,
        raw: t.raw,
        unitSeen: "$",
        location: amountCell.ref,
        context: `${table.name}: ${labelCell.text}`,
        rule: "table:budget",
        note: mapped.kind === "ignored" ? mapped.reason : "No budget line matches this label",
      });
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
      const acc = components.get(ck) ?? { fieldKey: mapped.fieldKey, unitSeen, sum: 0, refs: [], labels: [] };
      acc.sum += value;
      acc.refs.push(ref);
      acc.labels.push(label);
      components.set(ck, acc);
    };
    if (isTotal && mapped.fieldKey !== "stated_total_cost") {
      totals.push(cand);
      for (const l of lines) if (l.unitSeen === cand.unitSeen) add(l.value, l.unitSeen, l.ref, l.label);
      continue;
    }
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

function fromTable(table: Table, result: ExtractionResult, notes: string[] = []) {
  for (let r = 0; r < Math.min(table.rows.length, 12); r++) {
    const header = table.rows[r]!;
    const rr = rentRollRoles(header);
    if (rr) return fromRentRoll(table, r, rr, result, notes);
    const br = budgetRoles(header);
    if (br) return fromBudget(table, r, br, result);
  }
  // A plain two-column sheet: each row is "label: value".
  table.rows.forEach((row) => {
    const labelCell = row.find((c) => c.text && c.number === undefined && !/^[\d$(.,\s%-]+$/.test(c.text));
    if (!labelCell) return;
    const after = row.slice(row.indexOf(labelCell) + 1);
    for (const cell of after) {
      const t = cellToken(cell, result.format);
      if (t) {
        push(result, labelCell.text, t, cell.ref, `${table.name}: ${labelCell.text} ${cell.text}`, "table:label-value");
        break;
      }
    }
  });
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
function textTables(doc: NormalizedDocument, format: DocumentFormat): { tables: { table: Table; notes: string[] }[]; used: Set<number> } {
  const out: { table: Table; notes: string[] }[] = [];
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
    out.push({ table: { name: `Table at ${head.location}`, rows: [cols, ...rows] }, notes: lines.slice(j, j + 4).map((l) => l.text) });
    i = j - 1;
  }
  return { tables: out, used };
}

/** Every candidate value in one document. Deterministic: no model is consulted. */
export function extractCandidates(doc: NormalizedDocument): ExtractionResult {
  const result: ExtractionResult = { format: detectFormat(doc.fullText), candidates: [], other: [] };
  const text = textTables(doc, result.format);
  fromLines(doc, result, text.used);
  for (const t of text.tables) fromTable(t.table, result, t.notes);
  // A Word file's paragraphs may carry the note about a rent column ("Retail rents are ..."); there is no order between them and its tables.
  const notes = doc.kind === "docx" ? doc.lines.map((l) => l.text) : [];
  for (const t of doc.tables) fromTable(t, result, notes);
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
