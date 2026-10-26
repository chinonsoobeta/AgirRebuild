import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, normalizeText, SCALE_RE, scaleOf, SF_PER_M2, tokenize } from "@agir/numbers";
import { declaredScale, statedScaleUnit } from "./candidates.ts";
import { addressedEntries } from "./addressed.ts";
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
} as const;
export const AI_LOW_CONFIDENCE_NOTE = "Please check: every source is a low-confidence AI reading";
export const AI_AMBIGUOUS_NOTE = "Please check: the separator in this figure can be read more than one way; the AI read it as shown";
export type ReadingVerification = { outcome: string; candidate?: SourcedCandidate & { confidence: Reading["confidence"]; ambiguous?: true } };

const UNIT_COUNT_TOTAL_NAMES = new Set([
  "total", "grand total", "total units", "total unit", "units total", "total unit count", "total number of units",
  "building total", "total logements", "total des logements", "nombre total de logements", "logements au total",
]);

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
  const entries = doc ? addressedEntries(doc.document).filter(e => e.location === location) : [];
  if (!doc || entries.length !== 1) return { outcome: READING_FAILURE.address };
  if (!entries[0]!.text.includes(reading.quote)) return { outcome: READING_FAILURE.quote };
  const format = detectFormat(doc.document.fullText);
  let ambiguous = false;
  const cell = doc.document.tables.some(table => table.rows.some(row => row.some(c => c.ref === location)));
  const money = field.unit === "$" && reading.unit_seen === "$";
  const scaling = money ? declaredScale(doc.document, format, location) : { rule: null, own: false };
  const tokens = tokenize(reading.quote, format, cell).map(t => {
    // A declared money scale supplies the currency context for an unmarked figure.
    if (!money || !scaling.rule || t.currency || t.value !== null || t.unit !== null) return t;
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
    return !t.scaled && scaling.rule && "factor" in scaling.rule
      && Math.abs(t.value) < 1e6 && roundedScale(t.value, scaling.rule.factor) === reading.value;
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
  if (token.currencyCode !== null && token.currencyCode !== "CAD") return { outcome: READING_FAILURE.unit };
  let value = reading.value;
  const seen = reading.unit_seen;
  let unitSeen: string = token.unit === "bps" ? "bps (÷ 100)" : seen;
  if (money) {
    if (token.scaled && token.value !== null) value = token.value;
    if (token.paren && field.min !== undefined && field.min >= 0 && reading.value >= 0) value = Math.abs(value);
    if (!token.scaled && !scaling.own && scaling.rule) {
      if ("refuse" in scaling.rule || token.value === null || Math.abs(token.value) >= 1e6) return { outcome: READING_FAILURE.scale };
      value = roundedScale(token.paren && reading.value >= 0 ? Math.abs(token.value) : token.value, scaling.rule.factor);
      unitSeen = statedScaleUnit(scaling.rule.factor);
    }
    if (value !== 0 && Math.abs(value) < 1000) return { outcome: READING_FAILURE.small };
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
    fieldKey: field.key, itemKey, value, unitSeen, raw: token.raw,
    documentId: doc.id, documentName: doc.name, location: reading.location, context: reading.quote,
    rule: "ai", ...(ambiguous ? { ambiguous: true as const } : {}), confidence: reading.confidence, ...(reading.note ? { note: reading.note } : {}),
  } };
}

export function verifyReadings(response: ReaderResponse, documents: readonly ReadingDocument[]) {
  const readings = response.readings.map(r => verifyReading(r, documents));
  const conflicts = response.conflicts.map(c => c.values.map(v => verifyReading({ ...v, field: c.field, item: c.item, note: c.why, confidence: "high" }, documents)));
  return { readings, conflicts };
}
