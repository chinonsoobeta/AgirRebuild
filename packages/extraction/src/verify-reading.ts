import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, normalizeText, SCALE_RE, scaleOf, SF_PER_M2, tokenize } from "@agir/numbers";
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
} as const;
export const AI_LOW_CONFIDENCE_NOTE = "Please check: every source is a low-confidence AI reading";
export const AI_AMBIGUOUS_NOTE = "Please check: the separator in this figure could be a decimal point or a thousands group; the AI read it as shown";
export type ReadingVerification = { outcome: string; candidate?: SourcedCandidate & { confidence: Reading["confidence"]; ambiguous?: true } };

/** First failure wins. No model interpretation can bypass an address or number check. */
export function verifyReading(reading: Reading, documents: readonly ReadingDocument[]): ReadingVerification {
  const field = FIELD_BY_KEY.get(reading.field);
  if (!field?.extractable) return { outcome: READING_FAILURE.field };
  if (field.itemized ? !reading.item?.trim() : reading.item !== null) return { outcome: READING_FAILURE.item };
  const matches = documents.filter(d => d.name === reading.file);
  const doc = matches.length === 1 ? matches[0] : undefined;
  const entries = doc ? addressedEntries(doc.document).filter(e => e.location === reading.location.replace(/^(.*![A-Z]+\d+)\.\.[A-Z]+\d+$/, "$1")) : [];
  if (!doc || entries.length !== 1) return { outcome: READING_FAILURE.address };
  if (!entries[0]!.text.includes(reading.quote)) return { outcome: READING_FAILURE.quote };
  const format = detectFormat(doc.document.fullText);
  let ambiguous = false;
  const token = tokenize(reading.quote, format).find(t => {
    if (t.unit === "bps") return ["senior_rate_pct", "mezz_rate_pct", "refinance_rate_pct"].includes(field.key) && t.value !== null && t.value / 100 === reading.value;
    if (t.value === reading.value) return true;
    if (t.value !== null && format.decimal !== null) return false;
    // Locate the scale after the digits, including when tokenize already consumed it.
    const text = normalizeText(reading.quote).slice(t.start);
    const digits = /^\s*\(?[-−‒–]?\s*(?:(?:US|CA|C|A)?\$|USD|CAD)?\s?(\d+([.,])\d{3})(?![\d.,])/.exec(text);
    if (!digits) return false;
    const scale = SCALE_RE.exec(text.slice(digits[0].length));
    if (!scale) return false;
    const sign = t.value !== null && t.value < 0 || /^\s*[(−‒–-]/.test(text) ? -1 : 1;
    const decimal = Number(digits[1]!.replace(",", "."));
    const grouped = Number(digits[1]!.replace(/[.,]/, ""));
    const values = format.decimal ? [format.decimal === digits[2] ? decimal : grouped] : [decimal, grouped];
    const matches = values.some(v => Math.abs(sign * v * scaleOf(scale[1]!) - reading.value) < 0.005);
    if (matches) ambiguous = format.decimal === null;
    return matches;
  });
  if (!token) return { outcome: READING_FAILURE.value };
  let value = reading.value;
  const seen = reading.unit_seen;
  // The reader schema names money per unit and annual rent by their printed money/area unit.
  const unit = field.unit === "$/unit/mo" ? "$" : field.unit === "$/sf/yr" ? "$/sf" : field.unit;
  if (seen === "m2" && unit === "sf") value *= SF_PER_M2;
  else if (seen === "$/m2" && unit === "$/sf") value /= SF_PER_M2;
  else if (seen === "years" && unit === "months") value *= 12;
  else if (seen === "months" && unit === "years") value /= 12;
  else if (seen === "vacancy_%" && ["stabilized_occupancy_pct", "item_occupancy_pct"].includes(field.key)) value = 100 - value;
  else if (seen !== unit) return { outcome: READING_FAILURE.unit };
  return { outcome: "verified", candidate: {
    fieldKey: field.key, itemKey: reading.item, value, unitSeen: token.unit === "bps" ? "bps (÷ 100)" : seen, raw: token.raw,
    documentId: doc.id, documentName: doc.name, location: reading.location, context: reading.quote,
    rule: "ai", ...(ambiguous ? { ambiguous: true as const } : {}), confidence: reading.confidence, ...(reading.note ? { note: reading.note } : {}),
  } };
}

export function verifyReadings(response: ReaderResponse, documents: readonly ReadingDocument[]) {
  const readings = response.readings.map(r => verifyReading(r, documents));
  const conflicts = response.conflicts.map(c => c.values.map(v => verifyReading({ ...v, field: c.field, item: c.item, note: c.why, confidence: "high" }, documents)));
  return { readings, conflicts };
}
