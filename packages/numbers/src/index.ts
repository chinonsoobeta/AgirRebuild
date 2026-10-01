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

export type NumberToken = {
  raw: string;
  start: number;
  end: number;
  /** The parsed value, or null when the token is ambiguous or contradicts the document. */
  value: number | null;
  refusal?: string;
  currency: boolean;
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
  String.raw`(\()?(?<![\w.,])([-−‒–])?\s?((?:US|CA|C|A)?\$|USD\s?|CAD\s?)?\s?(${NUMBER_CORE})(?![\d])(?![.,]\d)`,
  "g",
);

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
): { value: number | null; refusal?: string } {
  const spaced = new RegExp(`[${SPACE_CLASS}]`).test(core);
  const plainSpaceGroups = (core.match(/ \d{3}/g) ?? []).length;
  if (plainSpaceGroups === 1 && !/[.,]\d/.test(core) && !format.spaceGroups) {
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

// "m" is million only when it is not the m of m²: "$450 m²" is not $450,000,000.
const SCALE_RE = /^\s?(billion|bn|million|mm|mn|m(?!²)|thousand|k)\b/i;
// "²" is not a word character, so the rules that end in it close with a lookahead, not \b.
const UNIT_RULES: { re: RegExp; unit: TokenUnit }[] = [
  { re: /^\s?(%|percent\b|pct\b)/i, unit: "%" },
  { re: /^\s?(bps|basis points)\b/i, unit: "bps" },
  { re: /^\s?(x|×)(?![a-z])/i, unit: "x" },
  { re: /^\s?(\/\s?sf|psf|per\s+(sq\.?\s*ft|square\s+foot|sf))\b/i, unit: "$/sf" },
  { re: /^\s?(\/\s?(m²|m2|sq\.?\s?m\.?|sqm)|psm|per\s+(m²|m2|sq\.?\s?m\.?|sqm|square\s+met(re|er)))(?![\p{L}\d])/iu, unit: "$/m2" },
  { re: /^\s?(\/\s?(unit\s?\/\s?)?mo(nth)?|(per\s+unit\s+)?per\s+month|(per\s+unit\s+)?monthly|per\s+unit\s+per\s+mo)\b/i, unit: "$/mo" },
  { re: /^\s?(sf|sq\.?\s?ft\.?|square\s+feet|rsf|nrsf)\b/i, unit: "sf" },
  // pi², the French square foot ("pi ca", "pieds carrés"). Never "p.c.", which is French for percent.
  { re: /^\s?(pi²|pi2|pi\.?\s?ca\.?|pieds?\s+carrés?)(?![\p{L}\d])/iu, unit: "sf" },
  { re: /^\s?(m²|m2|sq\.?\s?m\.?|sqm|square\s+met(re|er)s?|mètres?\s+carrés?)(?![\p{L}\d])/iu, unit: "m2" },
  { re: /^\s?(units?|homes|suites|apartments|doors)\b/i, unit: "units" },
  { re: /^[-\s]?(months?|mos?\.?)\b/i, unit: "months" },
  { re: /^[-\s]?(years?|yrs?\.?)\b/i, unit: "years" },
];

function scaleOf(word: string): number {
  const w = word.toLowerCase();
  if (w === "billion" || w === "bn") return 1e9;
  if (w === "million" || w === "mm" || w === "mn" || w === "m") return 1e6;
  return 1e3;
}

/** Every number in one line of text, with its unit and whether it was refused. */
export function tokenize(line: string, format: DocumentFormat): NumberToken[] {
  const text = normalizeText(line);
  const out: NumberToken[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const [whole, paren, sign, cur, core] = m;
    const start = m.index!;
    let end = start + whole.length;
    const rest = text.slice(end);
    const currency = Boolean(cur);
    let scaled = false;
    let unit: TokenUnit = currency ? "$" : null;
    const scale = rest.match(SCALE_RE);
    const upcoming = UNIT_RULES.find((r) => r.re.test(scale && currency ? rest.slice(scale[0].length) : rest))?.unit ?? null;
    const grouping = currency || upcoming === "units" || upcoming === "sf" || upcoming === "m2";
    const parsed = parseCore(core!, format, grouping);
    let value = parsed.value;
    // A scale word counts only in a money context: "18 M" alone is not $18,000,000.
    if (scale && currency && value !== null) {
      value *= scaleOf(scale[1]!);
      scaled = true;
      end += scale[0].length;
    }
    const after = text.slice(end);
    for (const r of UNIT_RULES) {
      const u = after.match(r.re);
      if (u) {
        if (currency && (r.unit === "$/sf" || r.unit === "$/m2" || r.unit === "$/mo")) unit = r.unit;
        else if (!currency) unit = r.unit;
        if (unit === r.unit) end += u[0].length;
        break;
      }
    }
    const negative = Boolean(sign) || (Boolean(paren) && text[end] === ")");
    if (value !== null && negative) value = -value;
    out.push({
      raw: text.slice(start, end).trim(),
      start,
      end,
      value,
      ...(parsed.refusal ? { refusal: parsed.refusal } : {}),
      currency,
      unit,
      scaled,
    });
  }
  return out;
}
