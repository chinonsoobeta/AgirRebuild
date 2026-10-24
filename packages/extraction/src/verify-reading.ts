import { FIELD_BY_KEY } from "@agir/contracts";
import { detectFormat, SF_PER_M2, tokenize } from "@agir/numbers";
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
export type ReadingVerification = { outcome: string; candidate?: SourcedCandidate & { confidence: Reading["confidence"] } };

/** First failure wins. No model interpretation can bypass an address or number check. */
export function verifyReading(reading: Reading, documents: readonly ReadingDocument[]): ReadingVerification {
  const field = FIELD_BY_KEY.get(reading.field);
  if (!field?.extractable) return { outcome: READING_FAILURE.field };
  if (field.itemized ? !reading.item?.trim() : reading.item !== null) return { outcome: READING_FAILURE.item };
  const matches = documents.filter(d => d.name === reading.file);
  const doc = matches.length === 1 ? matches[0] : undefined;
  const entries = doc ? addressedEntries(doc.document).filter(e => e.location === reading.location) : [];
  if (!doc || entries.length !== 1) return { outcome: READING_FAILURE.address };
  if (!entries[0]!.text.includes(reading.quote)) return { outcome: READING_FAILURE.quote };
  const token = tokenize(reading.quote, detectFormat(doc.document.fullText)).find(t => t.value === reading.value);
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
    fieldKey: field.key, itemKey: reading.item, value, unitSeen: seen, raw: token.raw,
    documentId: doc.id, documentName: doc.name, location: reading.location, context: reading.quote,
    rule: "ai", confidence: reading.confidence, ...(reading.note ? { note: reading.note } : {}),
  } };
}

export function verifyReadings(response: ReaderResponse, documents: readonly ReadingDocument[]) {
  const readings = response.readings.map(r => verifyReading(r, documents));
  const conflicts = response.conflicts.map(c => c.values.map(v => verifyReading({ ...v, field: c.field, item: c.item, note: c.why, confidence: "high" }, documents)));
  return { readings, conflicts };
}
