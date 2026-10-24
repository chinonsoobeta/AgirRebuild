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
//  5. Unicode minus signs and dashes attached to a number are a minus sign. "minus" and "moins"
//     before a number is a sign in words, which is ambiguous ("revenue minus 2% vacancy" is
//     +2%): that number is refused, neither negative nor positive. A dash set apart from the number by a space ("- 18 months", "– 96%") is a
//     list marker, never a sign. "(2,150,000)" is negative, but only money or a bare number is
//     ("(16 months)" is 16), and only when no number stands before it in its clause: the
//     "($96,000)" of "4% of hard costs ($96,000)" is an aside, positive.
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
//  6f. Single digits (and single "," "." "%" marks) each set apart by one space ("1 6 2 , 5 0 0") are
//      OCR's letter-spacing: the whole run is one refused token, never read in part and never joined.
//      A figure directly after "per", "par", "for every", "pour chaque" or "/" is the basis of a ratio
//      ("1.8 stalls per 1,000 SF"), never a value.
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
  /** Written as N quarters (or trimestres): value and unit are already in months, three to the quarter. */
  quarters?: true;
  /** Written in parentheses. Negative only as money; a mapper that reads it as another unit takes its absolute value. */
  paren?: true;
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
  String.raw`(\()?(?<![\w.,])(?:([-−‒–])(?!\s))?\s?((?:US|CA|C|A)?\$|USD\s?|CAD\s?)?\s?(${NUMBER_CORE})(?![\d])(?![.,]\d)(?!½)`,
  "g",
);

// A currency mark written after the number: "1,200,000 USD", "1 250 000 $ US", "$ CA", "$ CAN", "$ CAD", or a
// bare "18,75 $" (French). A bare dollar sign before a digit starts the next figure ("$5 $10"): not a suffix.
const SUFFIX_RE = /^\s?(USD|CAD|\$\s?US\b|\$\s?(?:CAD|CAN?)\b|\$(?!\s?\d))/;

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
  /** The token is money, a count or an area: normally grouped at three digits. */
  grouping = false,
  /** A trailing "$" follows: fr-CA format on its own, so one space group is a thousands group. */
  trailingDollar = false,
  /** A money scale word follows, so three decimal places are possible. */
  moneyScale = false,
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
    } else if (parts[1]!.length !== 3 || spaced || parts[0] === "0") {
      // A zero whole part cannot start a thousands group; spaces also establish grouping.
      decimal = sep;
      if (format.decimal && format.decimal !== sep) return contradicts();
    } else if (grouping && !moneyScale) {
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
const TYPE_HALF = String.raw`(?:un|une|deux|trois|quatre|cinq|six)[\s-]+et[\s-]+demie?`;
const TYPE_NAMED = String.raw`\d\s?½|${TYPE_HALF}|studios?|bachelors?|lofts?|town-?homes?|townhouses?|maisons?\s+de\s+ville`;
// A digit count takes only a plural type ("4 studios"): "Suite 12 Bachelor" is a name and a number.
const TYPE_PLURAL = String.raw`studios|bachelors|lofts|town-?homes|townhouses|maisons\s+de\s+ville`;
const HALF_NAMES: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6 };
const BED_NAMES: Record<string, string> = { one: "1BR", un: "1BR", une: "1BR", "1": "1BR", two: "2BR", deux: "2BR", "2": "2BR", three: "3BR", trois: "3BR", "3": "3BR" };

/** The distinct unit types a clause names, in the order written, as one name each ("1BR", "Studio", "3½"). "one- and two-bedroom" names both. */
export function unitTypesIn(text: string): string[] {
  const found: { at: number; name: string }[] = [];
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\p{L}\p{N}])(?:(${TYPE_BED})|(${TYPE_NAMED})|((?:one|two|three|un|deux|trois|[123])-)(?=\s+(?:and|or|et|ou)\s))(?![\p{L}\p{N}])`, "giu"))) {
    const w = m[0].toLowerCase();
    const name = m[1] || m[3] ? BED_NAMES[/^(?:one|two|three|une?|deux|trois|[123])/.exec(w)![0]]! : /^\d/.test(w) ? w.replace(/\s/g, "") : HALF_NAMES[w.split(/[\s-]/)[0]!] ? `${HALF_NAMES[w.split(/[\s-]/)[0]!]}½` : /^studio/.test(w) ? "Studio" : /^bachelor/.test(w) ? "Bachelor" : /^loft/.test(w) ? "Loft" : /^maison/.test(w) ? "Maison de ville" : "Townhome";
    found.push({ at: m.index!, name });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.name))];
}

const WHOLE_TYPE_RE = new RegExp(String.raw`^(?:${TYPE_BED}|${TYPE_NAMED})(?:[\s-]+(?:units?|suites?|homes?|apartments?|logements?|unités?))?$`, "iu");

/** The unit type a text is wholly made of ("One-bed", "1 chambre", "studio units"), else null: "2-bed + den" is a type of its own. */
export function wholeUnitType(text: string): string | null {
  const t = text.trim();
  return WHOLE_TYPE_RE.test(t) ? (unitTypesIn(t)[0] ?? null) : null;
}

/** The unit type written in parentheses ("End units (3 bed)"), if there is one. */
export function parenType(raw: string): string | null {
  for (const m of raw.matchAll(/\(([^)]*)\)/g)) {
    const t = wholeUnitType(m[1]!);
    if (t) return t;
  }
  return null;
}

/** A unit type written in any of its ways is one name ("One-bed", "1BR", "1 chambre" are "1BR"); a name with more to it ("2-bed + den") is kept as written. */
export function canonicalItem(name: string): string {
  const whole = wholeUnitType(name);
  if (whole) return whole;
  // A bracketed bedroom count describes a named layout; it does not replace its name.
  return name.replace(/\s*[([]([^()[\]]*)[)\]]\s*$/u, (all, inside: string) => wholeUnitType(inside) ? "" : all).trim();
}

/** Two item names are the same item when their folds are equal: canonical, single spaces, lower case. */
export function itemFold(name: string): string {
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", un: "1", une: "1", deux: "2", trois: "3", quatre: "4", cinq: "5" };
  return canonicalItem(name).replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/\b(one|two|three|four|five|six|un|une|deux|trois|quatre|cinq)(?=[- ](?:bed|chambre))/g, w => words[w]!)
    .replace(/(\b(?:\d+[- ](?:beds?|bedrooms?|chambres?)|basement|garden|end|interior|lower|upper|front|rear|stacked)\s+)(sides|terraces|suites|homes|units|latérales|laterales)\b/g, (_, prefix: string, noun: string) => prefix + noun.slice(0, -1));
}

// "m" is million only when it is not the m of m²: "$450 m²" is not $450,000,000.
export const SCALE_RE = /^\s?(billions?|bn|millions?|mm|mn|m(?!²)|thousands?|k)\b/i;
// In a table cell nothing around the figure says it is money, so only the spellings that cannot be a metre or a millimetre count: "85 m" and "5 mm" are not millions.
const CELL_SCALE_RE = /^(?:[kK]|MM?|bn|[Bb]illions?|[Mm]illions?|[Tt]housands?)$/;
// "three quarters of the units" and "three quarters complete" are fractions, not spans of time.
const NOT_FRACTION = String.raw`(?!\s+(?:of|de|du|des|complete|completed|done|finished|built|leased|occupied|sold|full|achev[ée]s?|termin[ée]s?|lou[ée]s?)\b)`;
// "²" is not a word character, so the rules that end in it close with a lookahead, not \b.
const UNIT_RULES: { re: RegExp; unit: TokenUnit; money?: true; quarters?: true; named?: true }[] = [
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
  // A count right before a bedroom type, a spelled half or a named type ("3 two-bed", "2 quatre et demie", "4 studio") counts that type; "Suite 12 2-bed" is a name and a number.
  { re: new RegExp(String.raw`^\s(?:${TYPE_BED}|${TYPE_HALF}|studio|bachelor|loft|town-?home|townhouse)(?![\p{L}\p{N}])`, "iu"), unit: "units", named: true },
  // "au 26e mois": the ordinal's own "mois" is the unit.
  { re: /^(e|er|ème|eme)\s+mois\b/i, unit: "months" },
  // "5 quarters" is fifteen months; "3 quarters of the units" is a fraction, not a span.
  { re: new RegExp(String.raw`^\s?(?:quarters|trimestres)(?![\p{L}\p{N}'’])${NOT_FRACTION}`, "iu"), unit: "months", quarters: true },
  { re: /^[-\s]?(months?|mos?\.?|mois)\b/i, unit: "months" },
  { re: /^[-\s]?(years?|yrs?\.?|ans?)\b/i, unit: "years" },
];

const NUMBERED_NAME_RE = /(?:\b(?:suite|unit|apt|apartment|no|number|unité|unite|appartement|local|porte|door)\.?|#)\s*$/i;

const WORD_VALUES: Record<string, number> = {
  zero: 0, zéro: 0, one: 1, un: 1, une: 1, two: 2, deux: 2, three: 3, trois: 3, four: 4, quatre: 4, five: 5, cinq: 5, six: 6, seven: 7, sept: 7,
  eight: 8, huit: 8, nine: 9, neuf: 9, ten: 10, dix: 10, eleven: 11, onze: 11, twelve: 12, douze: 12, thirteen: 13, treize: 13, fourteen: 14, quatorze: 14,
  fifteen: 15, quinze: 15, sixteen: 16, seize: 16, seventeen: 17, "dix-sept": 17, eighteen: 18, "dix-huit": 18, nineteen: 19, "dix-neuf": 19,
  twenty: 20, vingt: 20, thirty: 30, trente: 30, forty: 40, quarante: 40, fifty: 50, cinquante: 50, sixty: 60, soixante: 60,
};
const TENS = "twenty|thirty|forty|fifty|sixty|vingt|trente|quarante|cinquante|soixante";
const DIGIT_WORDS = "one|two|three|four|five|six|seven|eight|nine|un|deux|trois|quatre|cinq|six|sept|huit|neuf";
// A number word, then (directly, or after a hyphen) a unit word. Compounds ("twenty-four") first, so they win over their first word.
// "a" and "an" count only before a year ("a year"); "one and a half years" and "a year and a half" are 1.5 years; "five quarters" is fifteen months.
const YEAR_NOUN = "years?|ans?|ann[ée]es?";
const YEAR_FRACTION = String.raw`(?:\s+(?:and\s+(?:a\s+half|a\s+third|two\s+thirds)|et\s+(?:demie?|un\s+tiers|deux\s+tiers))(?![\p{L}\p{N}]))?`;
const WORD_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}-])((?:${TENS})-(?:${DIGIT_WORDS})|dix-sept|dix-huit|dix-neuf|${Object.keys(WORD_VALUES).filter((w) => !w.includes("-")).join("|")}|an?)(\s+and\s+a\s+half)?(?:-|\s+)(months?|mois|${YEAR_NOUN}|(?:quarters|trimestres)${NOT_FRACTION}(?!['’])|${TYPE_BED}(?:[\s-]+(?:units?|suites?|homes?|apartments?|logements?|unités?))?|(?:units?|suites?|homes?|apartments?|logements?|unités?)|${TYPE_NAMED})(?![\p{L}\p{N}])(${YEAR_FRACTION})`,
  "giu",
);
// "twelve (12) months": the digits in parentheses after their own words are the figure, and the words are not a second one.
const WORDS_THEN_PAREN = new RegExp(String.raw`(?<![\p{L}\p{N}-])((?:${TENS})-(?:${DIGIT_WORDS})|${Object.keys(WORD_VALUES).join("|")})\s+$`, "iu");
const PRECEDING_NUMBER_WORD = /(?:(?:hundred|thousand|million|cents?|mille)\s+(?:and|et)|hundred|thousand|million|cents?|mille|(?<=[\p{L}\p{N}])-)\s*$/iu;

// Card 111. A rate written in words ("five and a half percent", "cinq virgule cinq pour cent") or with a fraction ("5 1/2%", "5½ %") is one figure in %.
const PCT_MARK = String.raw`(?:\s?%|\s+(?:percent|per\s+cent|pour\s?cent|pct)(?![\p{L}]))`;
const ONE_DIGIT: Record<string, number> = { zero: 0, zéro: 0, one: 1, un: 1, two: 2, deux: 2, three: 3, trois: 3, four: 4, quatre: 4, five: 5, cinq: 5, six: 6, seven: 7, sept: 7, eight: 8, huit: 8, nine: 9, neuf: 9 };
const RATE_WHOLE = String.raw`(?:${TENS})-(?:${DIGIT_WORDS})|dix-sept|dix-huit|dix-neuf|${Object.keys(WORD_VALUES).filter((w) => !w.includes("-") && w !== "une").join("|")}`;
const RATE_PART: Record<string, number> = { "and a half": 0.5, "and a quarter": 0.25, "and three quarters": 0.75, "et demi": 0.5, "et demie": 0.5, "et quart": 0.25, "et trois quarts": 0.75 };
const RATE_WORD_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}-])(${RATE_WHOLE})(?:\s+(and\s+a\s+half|and\s+a\s+quarter|and\s+three\s+quarters|et\s+demie?|et\s+quart|et\s+trois\s+quarts)|\s+(?:point|virgule)\s+((?:${TENS})-(?:${DIGIT_WORDS})|(?:${Object.keys(ONE_DIGIT).join("|")})(?:\s+(?:${Object.keys(ONE_DIGIT).join("|")}))*))?${PCT_MARK}`,
  "giu",
);
// A word that continues a larger number or a range ("twenty five", "five to six", "hundred and five") is not a rate of its own.
const RATE_CONTINUES = new RegExp(String.raw`(?:\d|(?<![\p{L}])(?:${Object.keys(WORD_VALUES).join("|")}|hundred|thousand|million|cents?|mille))\s*(?:(?:to|and|or|à|a|et|ou|-)\s+)?$`, "iu");
const FRACTION_PCT_RE = new RegExp(String.raw`(?<![\w.,/$])(\d{1,2})(?:\s+(1\/2|1\/4|3\/4)|\s?([½¼¾]))${PCT_MARK}`, "gu");

function rateTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(RATE_WORD_RE)) {
    if (RATE_CONTINUES.test(text.slice(0, m.index!))) continue;
    const word = m[1]!.toLowerCase();
    const [a, b] = word.includes("-") && !word.startsWith("dix") ? word.split("-") : [word, null];
    let value = b === null ? WORD_VALUES[word]! : WORD_VALUES[a!]! + WORD_VALUES[b]!;
    if (m[2]) value += RATE_PART[m[2].toLowerCase().replace(/\s+/g, " ")]!;
    if (m[3]) {
      const d = m[3].toLowerCase();
      const parts = d.split(/\s+/);
      const digits = parts.every((p) => p in ONE_DIGIT) ? parts.map((p) => ONE_DIGIT[p]).join("") : String(WORD_VALUES[d.split("-")[0]!]! + WORD_VALUES[d.split("-")[1]!]!);
      value = Number(`${value}.${digits}`);
    }
    out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, value, currency: false, currencyCode: null, unit: "%", scaled: false });
  }
  return out;
}

/** Number words directly followed by a unit word. "one hundred twenty units" is not read: a word that continues a larger number is skipped. */
function wordTokens(text: string): NumberToken[] {
  const out: NumberToken[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[1]!.toLowerCase();
    const noun = m[3]!.toLowerCase();
    const quarters = /^(quarters|trimestres)$/.test(noun);
    const unit: TokenUnit = /^(month|mois)/.test(noun) || quarters ? "months" : new RegExp(`^(${YEAR_NOUN})$`, "i").test(noun) ? "years" : "units";
    // "any one unit", "un logement": one of a thing is not a count.
    if (unit === "units" && /^(one|un|une|an?)$/.test(word)) continue;
    const before = text.slice(0, m.index!);
    if (PRECEDING_NUMBER_WORD.test(before)) continue;
    const fraction = m[2] || m[4] || "";
    const hasFraction = Boolean(fraction);
    // "a year": a duration, not "once a year", "$96,000 a year", "a year ago" or "a unit and a half".
    if (/^an?$/.test(word) && (unit !== "years" || /(?:once|twice|times|per|each|every|[\d%$])\s*$/i.test(before) || /^(?:[-'’]|\s+(?:ago|old|earlier|later|before)\b)/i.test(text.slice(m.index! + m[0].length)))) continue;
    if (hasFraction && unit !== "years") continue;
    if (quarters && /^(one|un|une|an?)$/.test(word)) continue;
    const [a, b] = word.includes("-") ? word.split("-") : [word, null];
    const base = /^an?$/.test(word) ? 1 : b === null || a === "dix" ? WORD_VALUES[word]! : WORD_VALUES[a!]! + WORD_VALUES[b]!;
    const value = quarters ? base * 3 : base + (/two\s+thirds|deux\s+tiers/i.test(fraction) ? 2 / 3 : /third|tiers/i.test(fraction) ? 1 / 3 : hasFraction ? 0.5 : 0);
    out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, value, currency: false, currencyCode: null, unit, scaled: false, ...(quarters ? { quarters: true as const } : {}) });
  }
  return out;
}

export function scaleOf(word: string): number {
  const w = word.toLowerCase();
  if (w.startsWith("billion") || w === "bn") return 1e9;
  if (w.startsWith("million") || w === "mm" || w === "mn" || w === "m") return 1e6;
  return 1e3;
}

// "minus 2%", "moins 2 %"; not "au moins 2 %" (at least) or "plus ou moins" (give or take).
const MINUS_WORD_RE = /(?:^|[^\p{L}])(?<!\b(?:au|du|ou|or|plus|at|de|à|a|par|et)\s+)(?:minus|moins)\s+$/iu;
const ANNUAL_RE = /^\s?(?:\/\s?(?:an|yr|year|ann[ée]e)\b|par\s+(?:an|ann[ée]e)\b|per\s+(?:year|annum)\b|annually\b|a\s+year\b)/iu;

// Three or more single digits, each set apart by one space: "1 6 2 , 5 0 0". Ordinary space groups ("1 250 000") never match.
const SPACED_RE = /(?<![\d$€£])(?<!\d )(?:[$€£]\s?)?\d(?: [\d,.%])*(?!\d)(?! \d)/g;
const SPACED_NOTE = "Letter-spaced digits, as OCR leaves them; enter the figure";
const BASIS_NOTE = "A figure after 'per' is the basis of a ratio, not a value";
const BASIS_BEFORE_RE = /(?:\b(?:per|par|for every|pour chaque))\s*$/i;

/** Every number in one line of text, with its unit and whether it was refused. */
export function tokenize(line: string, format: DocumentFormat, cell = false): NumberToken[] {
  const text = normalizeText(line);
  const out: NumberToken[] = [];
  let reached = 0;
  const spaced = [...text.matchAll(SPACED_RE)].filter((m) => (m[0].match(/\d/g) ?? []).length >= 3);
  for (const m of spaced) {
    const raw = m[0].trim();
    out.push({ raw, start: m.index!, end: m.index! + m[0].length, value: null, refusal: SPACED_NOTE, currency: /^[$€£]/.test(raw), currencyCode: null, unit: null, scaled: false });
  }
  const fractions = [...text.matchAll(FRACTION_PCT_RE)].filter((m) => !spaced.some((r) => m.index! < r.index! + r[0].length && m.index! + m[0].length > r.index!));
  for (const m of fractions) {
    const value = Number(m[1]) + ({ "1/2": 0.5, "1/4": 0.25, "3/4": 0.75, "½": 0.5, "¼": 0.25, "¾": 0.75 } as Record<string, number>)[m[2] ?? m[3]!]!;
    out.push({ raw: m[0].trim(), start: m.index!, end: m.index! + m[0].length, value, currency: false, currencyCode: null, unit: "%", scaled: false });
  }
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, paren, sign, cur, core] = m;
    let start = m.index!;
    // Part of a letter-spaced run: refused with the run, never a number of its own.
    if (spaced.some((r) => start < r.index! + r[0].length && start + whole.length > r.index!)) continue;
    // Part of a fraction rate ("5 1/2%"): one figure, read above.
    if (fractions.some((r) => start < r.index! + r[0].length && start + whole.length > r.index!)) continue;
    // The tail of a unit phrase ("7 2-bed units") is not a number of its own.
    if (start < reached) continue;
    let end = start + whole.length;
    const rest = text.slice(end);
    const scale = rest.match(SCALE_RE);
    const suffix = (scale ? rest.slice(scale[0].length) : rest).match(SUFFIX_RE);
    // In a cell, "185k" or "1.2M" with no unit after it is an amount, as "$185k" is in prose.
    const bare = cell && !cur && !suffix && scale && CELL_SCALE_RE.test(scale[1]!) && !UNIT_RULES.some((r) => !r.money && r.re.test(rest.slice(scale[0].length)));
    const currency = Boolean(cur) || Boolean(suffix) || Boolean(bare);
    let currencyCode = codeOf(cur?.trim());
    let scaled = false;
    let unit: TokenUnit = currency ? "$" : null;
    const upcoming = UNIT_RULES.find((r) => r.re.test(scale && currency ? rest.slice(scale[0].length) : rest))?.unit ?? null;
    const grouping = currency || upcoming === "units" || upcoming === "sf" || upcoming === "m2";
    const parsed = parseCore(core!, format, grouping, Boolean(suffix?.[1]?.startsWith("$")), Boolean(scale && currency));
    let value = parsed.value;
    let refusal = parsed.refusal;
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
    let quarters = false;
    for (const r of UNIT_RULES) {
      if (r.money && !currency) continue;
      if (r.named && NUMBERED_NAME_RE.test(text.slice(0, start))) continue;
      const u = after.match(r.re);
      if (u) {
        if (r.quarters && !currency && value !== null) {
          value *= 3;
          quarters = true;
        }
        if (currency && (r.unit === "$/sf" || r.unit === "$/m2" || r.unit === "$/mo")) unit = r.unit;
        else if (!currency) unit = r.unit;
        if (unit === r.unit) end += u[0].length;
        break;
      }
    }
    const worded = unit === null && paren && text[end] === ")" ? WORDS_THEN_PAREN.exec(text.slice(0, start)) : null;
    const spelled = worded && UNIT_RULES.find((r) => !r.money && (r.unit === "months" || r.unit === "years") && r.re.test(text.slice(end + 1)));
    if (worded && spelled) {
      end += 1 + text.slice(end + 1).match(spelled.re)![0].length;
      unit = spelled.unit;
      start = worded.index;
    }
    // "/an", "par année", "per year" after a rent or an amount: the figure is yearly, which is what the field's unit is.
    if (currency && unit !== "$/mo") end += ANNUAL_RE.exec(text.slice(end))?.[0].length ?? 0;
    // "month 26", "au mois 26": an ordinal point in time.
    if (unit === null && /\b(month|mois)\s+$/i.test(text.slice(0, start))) unit = "months";
    reached = end;
    // "(2,150,000)" is negative; "(16 months)", "(95%)" and "(3x)" are not, and neither is an aside after a number.
    const parenthesised = Boolean(paren) && text[end] === ")";
    const clause = text.slice(0, start);
    const aside = /\d/.test(clause.slice(clause.lastIndexOf(":") + 1));
    const signWord = !sign && MINUS_WORD_RE.test(clause);
    const negative = Boolean(sign) || (parenthesised && !aside && (currency || unit === null));
    if (value !== null && negative) value = -value;
    if (signWord && value !== null) {
      value = null;
      refusal = "A sign written in words; enter the figure by hand";
    }
    // After "per" or a slash: the denominator of a ratio. A slash joining two digits ("2026/10") is a date unless a unit follows.
    const before = text.slice(0, start);
    if (value !== null && (BASIS_BEFORE_RE.test(before) || (/\/\s*$/.test(before) && (!/\d\/$/.test(before) || unit !== null)))) {
      value = null;
      refusal = BASIS_NOTE;
    }
    out.push({
      raw: text.slice(start, end).trim(),
      start,
      end,
      value,
      ...(refusal ? { refusal } : {}),
      currency,
      currencyCode,
      unit,
      scaled,
      ...(quarters ? { quarters: true as const } : {}),
      ...(parenthesised ? { paren: true as const } : {}),
    });
  }
  // A word token that sits inside a figure already read ("$96,000 a year") is not a second one.
  const rates = rateTokens(text);
  const words = [...wordTokens(text).filter((w) => !rates.some((t) => w.start < t.end && t.start < w.end)), ...rates].filter((w) => !out.some((t) => w.start < t.end && t.start < w.end));
  return [...out, ...words].sort((a, b) => a.start - b.start);
}
