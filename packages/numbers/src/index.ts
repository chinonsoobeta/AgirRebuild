// Locale-aware number tokenizer (plan task X5, decision 7).
//
// Rules:
//  1. A document's decimal separator is detected ONCE from its unambiguous
//     tokens ("1,234.56", "5,85", "1.234.567").
//  2. A token whose reading depends on the separator ("12,400" or "12.400")
//     is read with the document's separator; if the document has none, or
//     shows both, the token is AMBIGUOUS and yields no number.
//  3. A token that contradicts the document's separator yields no number.
//  4. Both edges of a number are guarded, so the tail of "31 200 000" can
//     never be read as "31" or "200".
//  5. Unicode minus signs and dashes before a number are a minus sign;
//     "(2,150,000)" is negative.
//  6. Words are never numbers: "one hundred" yields nothing.
//  6b. A small count or duration written as a word ("eighteen months", "a
//     three-month lease-up", "douze mois") is a number, but only when a unit
//     word follows it directly: "three-bedroom" names an item, not a count.
//  6c. "month 26", "au mois 26" and "au 26e mois" are an ordinal point in time,
//     in months. "1.20 times" and "1,15 fois" are a multiple.
//  6d. A count may stand before a unit-type word ("four studios", "7 2-bed units",
//     "trois 4½"): the type words are in UNIT_TYPE_SRC, and unitTypesIn names them.
//     "4½" is a unit type, never the number 4.
//  6e. A money figure may carry a per-year or per-month qualifier: "$/pi²/an",
//     "1 200 $ par année", "$1,640 a month".
//  7. Square metres are their own unit. The engine works in square feet, so a
//     figure in m² is converted where it is mapped, never here.

export type DecimalSeparator = "." | ",";

/** Square feet in one square metre: the foot is exactly 0.3048 m. */
export const SF_PER_M2 = 1 / 0.3048 ** 2;

export type DocumentFormat = {
  decimal: DecimalSeparator | null;
  /** Both separators were seen used as decimals. Every ambiguous token is refused. */
  mixed: boolean;
  evidence: { dot: number; comma: number };
  /** The document groups thousands with spaces somewhere unambiguous. */
  spaceGroups: boolean;
};

export type TokenUnit =
  | "$"
  | "%"
  | "bps"
  | "x"
  | "sf"
  | "m2"
  | "units"
  | "months"
  | "years"
  | "$/sf"
  | "$/m2"
  | "$/mo"
  | null;

export type CurrencyCode = "CAD" | "USD" | "AUD";

export type NumberToken = {
  raw: string;
  start: number;
  end: number;
  /** The parsed value, or null when the token is ambiguous or contradicts the document. */
  value: number | null;
  refusal?: string;
  currency: boolean;
  /** Which currency the mark names ("US$", "CAD", "$ US"); null for a bare "$" or no mark: unstated. */
  currencyCode: CurrencyCode | null;
  unit: TokenUnit;
  /** A money scale word was applied (million, k, ...). */
  scaled: boolean;
};

const SPACE_CLASS = "    ";
// A digit run with optional grouping, then an optional decimal part. Grouping
// by , . or a non-breaking/thin space is always a group. Grouping by an
// ordinary space is accepted by parseCore only with two or more groups
// ("31 200 000"), a decimal part ("2 640,50"), or a document that groups
// thousands with spaces elsewhere; otherwise "9 400" is refused, never read
// as 9 or 400.
const NUMBER_CORE = String.raw`\d{1,3}(?:[,.\u00A0\u202F\u2009]\d{3})+(?:[.,]\d+)?|\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const TOKEN_RE = new RegExp(
  String.raw`(\()?(?<![\w.,])([-−‒–])?\s?((?:US|CA|C|A)?\$|USD\s?|CAD\s?)?\s?(${NUMBER_CORE})(?![\d])(?![.,]\d)(?!½)`,
  "g",
);

// A currency mark written after the number: "1,200,000 USD", "1 250 000 $ US", "$ CA", "$ CAN", or a
// bare "18,75 $" (French). A bare dollar sign before a digit starts the next figure ("$5 $10"): not a suffix.
const SUFFIX_RE = /^\s?(USD|CAD|\$\s?US\b|\$\s?CAN?\b|\$(?!\s?\d))/;

/** The currency a mark names: "US$", "USD", "$ US" are USD; "CA$", "C$", "CAD", "$ CA" are CAD; "A$" is AUD; a bare "$" names none. */
export function codeOf(mark: string | undefined): CurrencyCode | null {
  const m = (mark ?? "").replace(/[\s$]/g, "");
  if (m === "US" || m === "USD") return "USD";
  if (m === "CA" || m === "C" || m === "CAN" || m === "CAD") return "CAD";
  return m === "A" ? "AUD" : null;
}

/** Replace typographic minus signs with ASCII so every later rule sees one sign. */
export function normalizeText(text: string): string {
  return text.replace(/[−‒–](?=\s?[$\d])/g, "-");
}

function classify(core: string): { dotDecimal: boolean; commaDecimal: boolean } {
  const c = core.replace(new RegExp(`[${SPACE_CLASS}]`, "g"), "");
  const hasDot = c.includes(".");
  const hasComma = c.includes(",");
  if (hasDot && hasComma) {
    return c.lastIndexOf(".") > c.lastIndexOf(",") ? { dotDecimal: true, commaDecimal: false } : { dotDecimal: false, commaDecimal: true };
  }
  const sep = hasDot ? "." : hasComma ? "," : null;
  if (!sep) return { dotDecimal: false, commaDecimal: false };
  const parts = c.split(sep);
  if (parts.length > 2) return sep === "." ? { dotDecimal: false, commaDecimal: true } : { dotDecimal: true, commaDecimal: false };
  const after = parts[1]!.length;
  if (after === 3) return { dotDecimal: false, commaDecimal: false }; // ambiguous alone
  return sep === "." ? { dotDecimal: true, commaDecimal: false } : { dotDecimal: false, commaDecimal: true };
}

export function detectFormat(text: string): DocumentFormat {
  let dot = 0;
  let comma = 0;
  let spaceGroups = false;
  for (const m of normalizeText(text).matchAll(TOKEN_RE)) {
    const core = m[4]!;
    const k = classify(core);
    if (k.dotDecimal) dot++;
    if (k.commaDecimal) comma++;
    if (/[\u00A0\u202F\u2009]/.test(core) || / \d{3} \d{3}/.test(core) || / \d{3}[.,]\d/.test(core)) spaceGroups = true;
  }
  const mixed = dot > 0 && comma > 0;
  return { decimal: mixed ? null : dot > 0 ? "." : comma > 0 ? "," : null, mixed, evidence: { dot, comma }, spaceGroups };
}

/** Parse one numeric core under a document format. Null means "refuse". */
export function parseCore(
  core: string,
  format: DocumentFormat,
  /** The token is money, a count or an area: never written to three decimal places. */
  grouping = false,
  /** A trailing "$" follows: fr-CA format on its own, so one space group is a thousands group. */
  trailingDollar = false,
): { value: number | null; refusal?: string } {
  const spaced = new RegExp(`[${SPACE_CLASS}]`).test(core);
  const plainSpaceGroups = (core.match(/ \d{3}/g) ?? []).length;
  if (plainSpaceGroups === 1 && !/[.,]\d/.test(core) && !format.spaceGroups && !trailingDollar) {
    const [a, b] = core.split(" ");
    return { value: null, refusal: `"${core}" could be ${a}${b} or ${a} and ${b}; the document does not group thousands with spaces elsewhere` };
  }
  let c = core.replace(new RegExp(`[${SPACE_CLASS}]`, "g"), "");
  const hasDot = c.includes(".");
  const hasComma = c.includes(",");
  let decimal: DecimalSeparator | null = null;
  const contradicts = () => ({ value: null, refusal: `"${core}" uses a different decimal separator from the rest of the document` });
  if (hasDot && hasComma) {
    decimal = c.lastIndexOf(".") > c.lastIndexOf(",") ? "." : ",";
    if (format.decimal && decimal !== format.decimal) return contradicts();
  } else if (hasDot || hasComma) {
    const sep: DecimalSeparator = hasDot ? "." : ",";
    const parts = c.split(sep);
    if (parts.length > 2) {
      // Repeated separator: it groups thousands, so the decimal is the other one.
      decimal = sep === "." ? "," : ".";
      if (format.decimal && format.decimal === sep) return contradicts();
    } else if (parts[1]!.length !== 3 || spaced) {
      // Not three digits after it (or spaces already group the thousands): a decimal.
      decimal = sep;
      if (format.decimal && format.decimal !== sep) return contradicts();
    } else if (grouping) {
      // Money, counts and areas are never written with three decimals, so three
      // digits after a lone separator group thousands. If the document says that
      // separator is its decimal mark, the reading is implausible: refuse it.
      if (format.decimal === sep) {
        return { value: null, refusal: `"${core}" would be a figure with three decimal places, which money, counts and areas never have` };
      }
      decimal = sep === "." ? "," : ".";
    } else if (format.decimal) {
      decimal = format.decimal;
    } else {
      return {
        value: null,
        refusal: `"${core}" could be ${parts[0]}${sep}${parts[1]} or ${parts[0]}${parts[1]}; the document does not say which`,
      };
    }
  }
  const thousands = decimal === "." ? "," : decimal === "," ? "." : null;
  if (thousands) {
    const [intPart, frac] = c.split(decimal!) as [string, string | undefined];
    const groups = intPart.split(thousands);
    if (groups.length > 1 && (!/^\d{1,3}$/.test(groups[0]!) || groups.slice(1).some((g) => !/^\d{3}$/.test(g)))) {
      return { value: null, refusal: `"${core}" is not a well-formed number` };
    }
    c = groups.join("") + (frac !== undefined ? "." + frac : "");
  }
  const v = Number(c);
  return Number.isFinite(v) ? { value: v } : { value: null, refusal: `"${core}" is not a number` };
}

// Unit types a count or a rent is named by: "one-bedroom", "2-bed", "3½", "studio", "loft", "townhome", "maison de ville".
const TYPE_BED = String.raw`(?:one|two|three|un|une|deux|trois|[123])[-\s]?(?:bed(?:room)?s?|br|chambres?)`;
const TYPE_NAMED = String.raw`\d½|studios?|bachelors?|lofts?|town-?homes?|townhouses?|maisons?\s+de\s+ville`;
// A digit count takes only a plural type ("4 studios"): "Suite 12 Bachelor" is a name and a number.
const TYPE_PLURAL = String.raw`studios|bachelors|lofts|town-?homes|townhouses|maisons\s+de\s+ville`;
const BED_NAMES: Record<string, string> = { one: "1BR", un: "1BR", une: "1BR", "1": "1BR", two: "2BR", deux: "2BR", "2": "2BR", three: "3BR", trois: "3BR", "3": "3BR" };

/** The distinct unit types a clause names, in the order written, as one name each ("1BR", "Studio", "3½"). "one- and two-bedroom" names both. */
export function unitTypesIn(text: string): string[] {
  const found: { at: number; name: string }[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(${TYPE_BED})|(${TYPE_NAMED})|((?:one|two|three|un|deux|trois|[123])-)(?=\s+(?:and|or|et|ou)\s))(?![\p{L}\p{N}])`, "giu"))) {
    const w = m[0].toLowerCase();
    const name = m[1] || m[3] ? BED_NAMES[/^[a-z0-9]+/.exec(w)![0]]! : /^\d/.test(w) ? w : /^studio/.test(w) ? "Studio" : /^bachelor/.test(w) ? "Bachelor" : /^loft/.test(w) ? "Loft" : /^maison/.test(w) ? "Maison de ville" : "Townhome";
    found.push({ at: m.index!, name });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

// "m" is million only when it is not the m of m²: "$450 m²" is not $450,000,000.
const SCALE_RE = /^\s?(billion|bn|million|mm|mn|m(?!²)|thousand|k)\b/i;
// "²" is not a word character, so the rules that end in it close with a lookahead, not \b.
const UNIT_RULES: { re: RegExp; unit: TokenUnit; money?: true }[] = [
  { re: /^\s?(%|percent\b|pct\b)/i, unit: "%" },
  { re: /^\s?(bps|basis points)\b/i, unit: "bps" },
  { re: /^\s?((x|×)(?![a-z])|(times|fois)\b)/i, unit: "x" },
  // "$/pi²", "$ par pi²" and "$ au pi²" are the French rent per square foot.
  { re: /^\s?((?:\/\s?sf|psf|per\s+(?:sq\.?\s*ft|square\s+foot|sf))\b|(?:\/\s?|par\s+|au\s+)(?:pi²|pi2|pi\.?\s?ca\.?|pieds?\s+carrés?)(?![\p{L}\d]))/iu, unit: "$/sf" },
  { re: /^\s?(\/\s?(m²|m2|sq\.?\s?m\.?|sqm)|psm|per\s+(m²|m2|sq\.?\s?m\.?|sqm|square\s+met(re|er)))(?![\p{L}\d])/iu, unit: "$/m2" },
  { re: /^\s?(\/\s?(unit\s?\/\s?)?mo(nth|is)?|(per\s+unit\s+)?per\s+month|(per\s+unit\s+)?monthly|per\s+unit\s+per\s+mo|(par\s+logement\s+)?par\s+mois|mensuel(le)?)\b/i, unit: "$/mo" },
  { re: /^\s?(?:a|each|every)\s+month\b/i, unit: "$/mo", money: true },
  { re: /^\s?(sf|sq\.?\s?ft\.?|square\s+feet|rsf|nrsf)\b/i, unit: "sf" },
  // pi², the French square foot ("pi ca", "pieds carrés"). Never "p.c.", which is French for percent.
  { re: /^\s?(pi²|pi2|pi\.?\s?ca\.?|pieds?\s+carrés?)(?![\p{L}\d])/iu, unit: "sf" },
  { re: /^\s?(m²|m2|sq\.?\s?m\.?|sqm|square\s+met(re|er)s?|mètres?\s+carrés?)(?![\p{L}\d])/iu, unit: "m2" },
  { re: new RegExp(String.raw`^\s?(?:${TYPE_BED}[\s-]+)?(?:units?|homes|suites|apartments|doors)\b`, "i"), unit: "units" },
  { re: new RegExp(String.raw`^\s?(?:${TYPE_BED}[\s-]+)?(?:logements?|unités?|unites?|appartements?)(?![\p{L}\d])`, "iu"), unit: "units" },
  { re: new RegExp(String.raw`^\s?(?:${TYPE_PLURAL})(?![\p{L}\p{N}])`, "iu"), unit: "units" },
  // "au 26e mois": the ordinal's own "mois" is the unit.
  { re: /^(e|er|ème|eme)\s+mois\b/i, unit: "months" },
  { re: /^[-\s]?(months?|mos?\.?|mois)\b/i, unit: "months" },
  { re: /^[-\s]?(years?|yrs?\.?|ans?)\b/i, unit: "years" },
];

const WORD_VALUES: Record<string, number> = {
  zero: 0, zéro: 0, one: 1, un: 1, une: 1, two: 2, deux: 2, three: 3, trois: 3, four: 4, quatre: 4, five: 5, cinq: 5, six: 6, seven: 7, sept: 7,
  eight: 8, huit: 8, nine: 9, neuf: 9, ten: 10, dix: 10, eleven: 11, onze: 11, twelve: 12, douze: 12, thirteen: 13, treize: 13, fourteen: 14, quatorze: 14,
  fifteen: 15, quinze: 15, sixteen: 16, seize: 16, seventeen: 17, "dix-sept": 17, eighteen: 18, "dix-huit": 18, nineteen: 19, "dix-neuf": 19,
  twenty: 20, vingt: 20, thirty: 30, trente: 30, forty: 40, quarante: 40, fifty: 50, cinquante: 50, sixty: 60, soixante: 60,
};
const TENS = "twenty|thirty|forty|fifty|sixty|vingt|trente|quarante|cinquante|soixante";
const DIGIT_WORDS = "one|two|three|four|five|six|seven|eight|nine|un|deux|trois|quatre|cinq|six|sept|huit|neuf";
// A number word, then (directly, or after a hyphen) a unit word. Compounds ("twenty-four") first, so they win over their first word.
const WORD_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}-])((?:${TENS})-(?:${DIGIT_WORDS})|dix-sept|dix-huit|dix-neuf|${Object.keys(WORD_VALUES).filter((w) => !w.includes("-")).join("|")})(?:-|\s+)(months?|mois|years?|ans?|${TYPE_BED}(?:[\s-]+(?:units?|suites?|homes?|apartments?|logements?|unités?))?|(?:units?|suites?|homes?|apartments?|logements?|unités?)|${TYPE_NAMED})(?![\p{L}\p{N}])`,
  "giu",
);
const PRECEDING_NUMBER_WORD = /(?:(?:hundred|thousand|million|cents?|mille)\s+(?:and|et)|hundred|thousand|million|cents?|mille|-)\s*$/i;

/** Number words directly followed by a unit word. "one hundred twenty units" is not read: a word that continues a larger number is skipped. */
function wordTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[1]!.toLowerCase();
    const noun = m[2]!.toLowerCase();
    const unit: TokenUnit = /^(month|mois)/.test(noun) ? "months" : /^(years?|ans?)$/.test(noun) ? "years" : "units";
    // "any one unit", "un logement": one of a thing is not a count.
    if (unit === "units" && /^(one|un|une)$/.test(word)) continue;
    if (PRECEDING_NUMBER_WORD.test(text.slice(0, m.index!))) continue;
    const [a, b] = word.includes("-") ? word.split("-") : [word, null];
    const value = b === null || a === "dix" ? WORD_VALUES[word]! : WORD_VALUES[a!]! + WORD_VALUES[b]!;
    out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, value, currency: false, currencyCode: null, unit, scaled: false });
  }
  return out;
}

function scaleOf(word: string): number {
  const w = word.toLowerCase();
  if (w === "billion" || w === "bn") return 1e9;
  if (w === "million" || w === "mm" || w === "mn" || w === "m") return 1e6;
  return 1e3;
}

const ANNUAL_RE = /^\s?(?:\/\s?(?:an|yr|year|ann[ée]e)\b|par\s+(?:an|ann[ée]e)\b|per\s+(?:year|annum)\b|annually\b|a\s+year\b)/iu;

/** Every number in one line of text, with its unit and whether it was refused. */
export function tokenize(line: string, format: DocumentFormat): NumberToken[] {
  const text = normalizeText(line);
  const out: NumberToken[] = [];
  let reached = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, paren, sign, cur, core] = m;
    const start = m.index!;
    // The tail of a unit phrase ("7 2-bed units") is not a number of its own.
    if (start < reached) continue;
    let end = start + whole.length;
    const rest = text.slice(end);
    const scale = rest.match(SCALE_RE);
    const suffix = (scale ? rest.slice(scale[0].length) : rest).match(SUFFIX_RE);
    const currency = Boolean(cur) || Boolean(suffix);
    let currencyCode = codeOf(cur?.trim());
    let scaled = false;
    let unit: TokenUnit = currency ? "$" : null;
    const upcoming = UNIT_RULES.find((r) => r.re.test(scale && currency ? rest.slice(scale[0].length) : rest))?.unit ?? null;
    const grouping = currency || upcoming === "units" || upcoming === "sf" || upcoming === "m2";
    const parsed = parseCore(core!, format, grouping, Boolean(suffix?.[1]?.startsWith("$")));
    let value = parsed.value;
    // A scale word counts only in a money context: "18 M" alone is not $18,000,000.
    if (scale && currency && value !== null) {
      value *= scaleOf(scale[1]!);
      scaled = true;
      end += scale[0].length;
    }
    const mark = text.slice(end).match(SUFFIX_RE);
    if (mark) {
      currencyCode ??= codeOf(mark[1]);
      end += mark[0].length;
    }
    const after = text.slice(end);
    for (const r of UNIT_RULES) {
      if (r.money && !currency) continue;
      const u = after.match(r.re);
      if (u) {
        if (currency && (r.unit === "$/sf" || r.unit === "$/m2" || r.unit === "$/mo")) unit = r.unit;
        else if (!currency) unit = r.unit;
        if (unit === r.unit) end += u[0].length;
        break;
      }
    }
    // "/an", "par année", "per year" after a rent or an amount: the figure is yearly, which is what the field's unit is.
    if (currency && unit !== "$/mo") end += ANNUAL_RE.exec(text.slice(end))?.[0].length ?? 0;
    // "month 26", "au mois 26": an ordinal point in time.
    if (unit === null && /\b(month|mois)\s+$/i.test(text.slice(0, start))) unit = "months";
    reached = end;
    const negative = Boolean(sign) || (Boolean(paren) && text[end] === ")");
    if (value !== null && negative) value = -value;
    out.push({
      raw: text.slice(start, end).trim(),
      start,
      end,
      value,
      ...(parsed.refusal ? { refusal: parsed.refusal } : {}),
      currency,
      currencyCode,
      unit,
      scaled,
    });
  }
  return [...out, ...wordTokens(text)].sort((a, b) => a.start - b.start);
}
