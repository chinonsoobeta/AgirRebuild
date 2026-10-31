import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, normalizeText, SCALE_RE, scaleOf, SF_PER_M2, tokenize } from "@agir/numbers";
import { declaredScale, labelScale, statedScaleUnit } from "./candidates.ts";
import { addressedEntries } from "./addressed.ts";
import { canonicalItem, foldText } from "./mapping.ts";
import type { NormalizedDocument } from "./document.ts";
import type { SourcedCandidate } from "./consolidate.ts";

export type ReaderUnit = "$" | "%" | "sf" | "m2" | "$/sf" | "$/m2" | "months" | "years" | "units" | "x" | "vacancy_%";
export type ReadingValue = { value: number; unit_seen: ReaderUnit; file: string; location: string; quote: string };
export type Reading = ReadingValue & { field: string; item: string | null; note: string | null; confidence: "high" | "medium" | "low" };
export type ReaderResponse = {
  readings: Reading[];
  conflicts: { field: string; item: string | null; values: ReadingValue[]; why: string }[];
  not_used: { value: number; file: string; location: string; quote: string; why: string }[];
};
export type ReadingDocument = { id: string; name: string; document: NormalizedDocument };
export const READING_FAILURE = {
  field: "The AI field is unknown or cannot be read from documents",
  item: "The AI item does not match this field",
  address: "The AI document or address does not exist",
  quote: "The AI quote is not at this address",
  value: "The AI value is not written in its quote",
  unit: "The AI unit does not match this field",
  scale: "The document states a scale for this amount that Agir cannot read safely",
  small: "The AI amount is under $1,000; check whether the document states it in thousands or millions",
  count: "The AI read a count of homes as a percent; a share presold is read only where the document writes the percent",
  financing: "The AI read a financing figure as other costs; interest and lender fees are computed by Agir or belong to the stated interest reserve",
} as const;
// Card F1: "21 of 30", "21/30", "21 sur 30" is a count of a total, never a percent.
const PRESALE_FIELDS = new Set(["presold_units_pct", "senior_presale_threshold_pct"]);
const OF_TOTAL_AFTER = /^\s*(?:of|out of|sur|\/)\s*\d/;
const OF_TOTAL_BEFORE = /\d\s*(?:of|out of|sur|\/)\s*$/;
// A pace stated per year, quarter or week is not units per month until a person says so.
const NOT_MONTHLY_PACE = /^\s*(?:[a-z]+\s+){0,2}?(?:per|a|an|each|every|par|\/)\s*(?:years?|yr|annum|quarters?|weeks?|an|annee|trimestres?|semaines?)\b|^\s*(?:[a-z]+\s+){0,2}?(?:annually|yearly|quarterly|weekly|annuellement)\b/;

export const AI_LOW_CONFIDENCE_NOTE = "Please check: every source is a low-confidence AI reading";
export const AI_AMBIGUOUS_NOTE = "Please check: the separator in this figure can be read more than one way; the AI read it as shown";
export type ReadingVerification = { outcome: string; candidate?: SourcedCandidate & { confidence: Reading["confidence"]; ambiguous?: true } };

const UNIT_COUNT_TOTAL_NAMES = new Set([
  "total", "grand total", "total units", "total unit", "units total", "total unit count", "total number of units",
  "building total", "total logements", "total des logements", "nombre total de logements", "logements au total",
]);

// Card 174: financing words, from the stated interest reserve's aliases and the lender's fees.
const FINANCING_WORDS = [
  ...FIELD_BY_KEY.get("stated_interest_reserve")!.aliases,
  "interests?", "interets?", "financing", "financement", "lenders?(?: s)? fees?", "commitment fees?", "origination", "loan fees?",
  "capitali[sz]ed interest", "frais de financement", "frais du preteur", "commission d engagement",
];
const FINANCING = new RegExp(`\\b(?:${FINANCING_WORDS.join("|")})\\b`);
// "Other costs (excluding financing)": financing named only to leave it out.
const EXCLUDING = /\b(?:excluding|excl|exclusive of|not including|without|net of|hors|sans|excluant|a l exclusion)\b[^)]*/g;
// The figure's own label ends at the previous figure or separator: "Lender fee $25,000; Other $40,000".
const LABEL_START = /^.*(?:[;|\t•]|\$\s?\d[\d.,]*|\d[\d.,\s]*\$)/s;

/** The text before a quote: its line up to the quote, or the cells with words before it in its row. */
function textBefore(document: NormalizedDocument, location: string, line: string, quote: string): string {
  const row = document.tables.flatMap(t => t.rows).find(r => r.some(c => c.ref === location));
  return row
    ? row.slice(0, row.findIndex(c => c.ref === location)).map(c => c.text).filter(t => /\p{L}/u.test(t)).join(" ") + " "
    : line.slice(0, line.indexOf(quote));
}

/** The words a figure is written under: its line up to the quote, or the cells before it in its row. */
function figureLabel(document: NormalizedDocument, location: string, line: string, quote: string): string {
  const at = quote.search(/[\d$]/);
  const own = at < 0 ? quote : quote.slice(0, at);
  return foldText(textBefore(document, location, line, quote) + own).replace(LABEL_START, "");
}

/** First failure wins. No model interpretation can bypass an address or number check. */
export function verifyReading(reading: Reading, documents: readonly ReadingDocument[]): ReadingVerification {
  const field = FIELD_BY_KEY.get(reading.field);
  if (!field?.extractable) return { outcome: READING_FAILURE.field };
  const foldedItem = reading.item?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim().replace(/\p{P}+$/u, "").trim();
  const wholeUnitCount = field.key === "unit_count" && (!reading.item?.trim() || UNIT_COUNT_TOTAL_NAMES.has(foldedItem!));
  const itemKey = wholeUnitCount ? null : reading.item;
  if (field.itemized ? !wholeUnitCount && !itemKey?.trim() : itemKey !== null) return { outcome: READING_FAILURE.item };
  const matches = documents.filter(d => d.name === reading.file);
  const doc = matches.length === 1 ? matches[0] : undefined;
  const location = reading.location.replace(/^(.*![A-Z]+\d+)\.\.[A-Z]+\d+$/, "$1");
  // The model sometimes copies the address marker into its quote ("[line 4] Loan amount: $3,900,000"); the marker is not
  // document text, so it is dropped before the quote is looked for (QA run 3, skeptic R1).
  const marker = `[${reading.location}] `;
  if (reading.quote.startsWith(marker)) reading = { ...reading, quote: reading.quote.slice(marker.length) };
  const entries = doc ? addressedEntries(doc.document).filter(e => e.location === location) : [];
  if (!doc || entries.length !== 1) return { outcome: READING_FAILURE.address };
  if (!entries[0]!.text.includes(reading.quote)) return { outcome: READING_FAILURE.quote };
  // Interest and lender fees are computed by the engine; as other costs they would count twice.
  if (field.key === "other_cost" && FINANCING.test(figureLabel(doc.document, location, entries[0]!.text, reading.quote).replace(EXCLUDING, " "))) {
    return { outcome: READING_FAILURE.financing };
  }
  const format = detectFormat(doc.document.fullText);
  let ambiguous = false;
  const cell = doc.document.tables.some(table => table.rows.some(row => row.some(c => c.ref === location)));
  const money = field.unit === "$" && reading.unit_seen === "$";
  const scaling = money ? declaredScale(doc.document, format, location) : { rule: null, own: false };
  // A scale the figure's own label states ("Required mortgage ($M) $43.63") is that figure's scale: the words since the figure before it.
  const before = textBefore(doc.document, location, entries[0]!.text, reading.quote);
  const labelled = (t: { start: number }) => {
    if (!money) return null;
    const text = normalizeText(before + reading.quote.slice(0, t.start));
    // "$000" in "($000s)" is part of a scale, not a figure.
    const previous = tokenize(text, format).filter(x => /[1-9]/.test(x.raw)).at(-1);
    return labelScale(previous ? text.slice(previous.end) : text);
  };
  // A label's scale over a declared one that differs cannot be read safely.
  const ruleFor = (t: { start: number }) => {
    const own = labelled(t);
    if (!own) return scaling.rule;
    return scaling.rule && "factor" in scaling.rule && scaling.rule.factor !== own.factor ? { refuse: true as const } : own;
  };
  const tokens = tokenize(reading.quote, format, cell).map(t => {
    // A declared money scale supplies the currency context for an unmarked figure.
    if (!money || !ruleFor(t) || t.currency || t.value !== null || t.unit !== null) return t;
    const amount = tokenize(`${t.raw} $`, format, cell)[0];
    return amount ? { ...t, value: amount.value } : t;
  });
  const roundedScale = (value: number, factor: number) => Number((value * factor).toPrecision(12));
  const ownFactor = (raw: string) => {
    const afterDigits = normalizeText(raw).replace(/^.*?\d[\d., ]*/, "");
    const scale = SCALE_RE.exec(afterDigits);
    return scale ? scaleOf(scale[1]!) : 1;
  };
  const token = tokens.find(t => t.unit === "bps"
    ? ["senior_rate_pct", "mezz_rate_pct", "refinance_rate_pct"].includes(field.key) && t.value !== null && t.value / 100 === reading.value
    : t.value === reading.value) ?? tokens.find(t => {
    if (!money || t.value === null) return false;
    if (t.scaled && Math.abs(t.value / ownFactor(t.raw) - reading.value) < 1e-9) return true;
    if (t.paren && field.min !== undefined && field.min >= 0 && Math.abs(t.value) === reading.value) return true;
    const rule = ruleFor(t);
    return !t.scaled && rule && "factor" in rule
      && Math.abs(t.value) < 1e6 && roundedScale(t.value, rule.factor) === reading.value;
  }) ?? tokens.find(t => {
    if (t.unit === "bps") return false;
    if (t.value === null && !format.spaceGroups) {
      const digits = /\d[\d.,\s]*/.exec(t.raw)?.[0].trim();
      // Each side is a figure of its own; "050" is not.
      if (digits && /^\d{1,3} [1-9]\d{2}$/.test(digits) && digits.split(" ").some(v => Number(v) === reading.value)) {
        ambiguous = true;
        return true;
      }
    }
    if (t.value !== null && format.decimal !== null) return false;
    // Locate the scale after the digits, including when tokenize already consumed it.
    const text = normalizeText(reading.quote).slice(t.start);
    const digits = /^\s*\(?[-−‒–]?\s*(?:(?:US|CA|C|A)?\$|USD|CAD)?\s?(\d+([.,])\d{3})(?![\d.,])/.exec(text);
    if (!digits) return false;
    const scale = SCALE_RE.exec(text.slice(digits[0].length));
    const sign = t.value !== null && t.value < 0 || /^\s*[(−‒–-]/.test(text) ? -1 : 1;
    const decimal = Number(digits[1]!.replace(",", "."));
    const grouped = Number(digits[1]!.replace(/[.,]/, ""));
    if (!scale) {
      if (format.decimal !== null || field.min === undefined) return false;
      const range = field.max !== undefined ? { min: field.min, max: field.max } : field.window;
      if (!range) return false;
      const values = [sign * decimal, sign * grouped];
      const inRange = (v: number) => v >= range.min && v <= range.max;
      const matches = values.filter(v => v === reading.value).length === 1 && inRange(reading.value)
        && values.some(v => v !== reading.value && !inRange(v));
      if (matches && field.max === undefined) ambiguous = true;
      return matches;
    }
    const values = format.decimal ? [format.decimal === digits[2] ? decimal : grouped] : [decimal, grouped];
    const matches = values.some(v => Math.abs(sign * v * scaleOf(scale[1]!) - reading.value) < 0.005);
    if (matches) ambiguous = format.decimal === null;
    return matches;
  });
  if (!token) return { outcome: READING_FAILURE.value };
  if (PRESALE_FIELDS.has(field.key) && token.unit !== "%") {
    const text = normalizeText(reading.quote);
    if (token.unit === "units" || OF_TOTAL_AFTER.test(foldText(text.slice(token.end))) || OF_TOTAL_BEFORE.test(foldText(text.slice(0, token.start)))) return { outcome: READING_FAILURE.count };
  }
  if (field.key === "absorption_units_per_month" && NOT_MONTHLY_PACE.test(foldText(normalizeText(reading.quote).slice(token.end)))) return { outcome: READING_FAILURE.unit };
  if (token.currencyCode !== null && token.currencyCode !== "CAD") return { outcome: READING_FAILURE.unit };
  let value = reading.value;
  const seen = reading.unit_seen;
  let unitSeen: string = token.unit === "bps" ? "bps (÷ 100)" : seen;
  if (money) {
    if (token.scaled && token.value !== null) value = token.value;
    if (token.paren && field.min !== undefined && field.min >= 0 && reading.value >= 0) value = Math.abs(value);
    const rule = ruleFor(token);
    if (!token.scaled && (labelled(token) || !scaling.own) && rule) {
      if ("refuse" in rule || token.value === null || Math.abs(token.value) >= 1e6) return { outcome: READING_FAILURE.scale };
      value = roundedScale(token.paren && reading.value >= 0 ? Math.abs(token.value) : token.value, rule.factor);
      unitSeen = statedScaleUnit(rule.factor);
    }
    // Card F1: a carry per unsold home per month is often a few hundred dollars.
    if (value !== 0 && Math.abs(value) < 1000 && field.key !== "unsold_carry_monthly") return { outcome: READING_FAILURE.small };
  }
  // The reader schema names money per unit and annual rent by their printed money/area unit.
  const unit = field.unit === "$/unit/mo" ? "$" : field.unit === "$/sf/yr" ? "$/sf" : field.unit;
  if (seen === "m2" && unit === "sf") value *= SF_PER_M2;
  else if (seen === "$/m2" && unit === "$/sf") value /= SF_PER_M2;
  else if (seen === "years" && unit === "months") value *= 12;
  else if (seen === "months" && unit === "years") value /= 12;
  else if (seen === "vacancy_%" && ["stabilized_occupancy_pct", "item_occupancy_pct"].includes(field.key)) value = 100 - value;
  else if (seen !== unit) return { outcome: READING_FAILURE.unit };
  return { outcome: "verified", candidate: {
    // The rule reader's name for the same type ("Two-bedroom" and "2BR" are "2BR"), so the two group in consolidate (QA card C1).
    fieldKey: field.key, itemKey: itemKey === null ? null : canonicalItem(itemKey.trim()), value, unitSeen, raw: token.raw,
    documentId: doc.id, documentName: doc.name, location: reading.location, context: reading.quote,
    rule: "ai", ...(ambiguous ? { ambiguous: true as const } : {}), confidence: reading.confidence, ...(reading.note ? { note: reading.note } : {}),
  } };
}

export function verifyReadings(response: ReaderResponse, documents: readonly ReadingDocument[]) {
  const readings = response.readings.map(r => verifyReading(r, documents));
  const conflicts = response.conflicts.map(c => c.values.map(v => verifyReading({ ...v, field: c.field, item: c.item, note: c.why, confidence: "high" }, documents)));
  return { readings, conflicts };
}
