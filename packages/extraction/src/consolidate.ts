import { FIELD_BY_KEY } from "@agir/contracts";
import type { Candidate } from "./candidates.ts";
import { canonicalItem, currencyOf } from "./mapping.ts";

export type SourcedCandidate = Candidate & { documentId: string; documentName: string };

export type Proposal = {
  fieldKey: string;
  itemKey: string | null;
  /** needs_review when every source agrees; conflicting when they do not. */
  status: "needs_review" | "conflicting";
  value: number | null;
  sources: SourcedCandidate[];
  /** Distinct documented values, for a conflict. Never includes a figure in another currency. */
  values: { value: number; sources: SourcedCandidate[] }[];
  /** Figures stated in a currency other than the deal's. Kept in sources for provenance; never a value. */
  foreign: SourcedCandidate[];
  /** Why the field conflicts when a foreign figure is the cause. */
  reason: string | null;
};

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Gather candidates from every live document into one proposal per field.
 * Agreement yields one value for review. Disagreement yields a conflict that
 * lists every documented value; Agir never picks between them. A figure marked
 * in another currency is never a value, and neither is one marked in any currency
 * when the deal states none (it cannot be compared): the field conflicts, and the
 * person enters the amount in the deal's currency.
 */
export function consolidate(candidates: readonly SourcedCandidate[], dealCurrency: string | null = null): Proposal[] {
  const isForeign = (c: SourcedCandidate) => {
    const code = currencyOf(c.unitSeen);
    return code !== null && code !== dealCurrency; // a deal with no currency compares none
  };
  const groups = new Map<string, SourcedCandidate[]>();
  for (const c of candidates) {
    if (!c.fieldKey || c.value === null) continue;
    const k = `${c.fieldKey}|${c.itemKey ?? ""}`;
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }
  const out: Proposal[] = [];
  for (const [k, list] of groups) {
    const [fieldKey, item] = k.split("|") as [string, string];
    const values: Proposal["values"] = [];
    const foreign = list.filter(isForeign);
    for (const c of list.filter((x) => !isForeign(x))) {
      const hit = values.find((v) => same(v.value, c.value!));
      if (hit) hit.sources.push(c);
      else values.push({ value: c.value!, sources: [c] });
    }
    values.sort((a, b) => a.value - b.value);
    out.push({
      fieldKey,
      itemKey: item || null,
      status: values.length > 1 || foreign.length > 0 ? "conflicting" : "needs_review",
      value: values.length === 1 && foreign.length === 0 ? values[0]!.value : null,
      // Figures in the deal's currency first: a value settled from sources[0] is never a foreign one.
      sources: [...list.filter((x) => !isForeign(x)), ...foreign],
      values,
      foreign,
      reason: foreign.length
        ? `A document states this in ${[...new Set(foreign.map((c) => currencyOf(c.unitSeen)))].join(" and ")}; ${
            dealCurrency ? `this deal is in ${dealCurrency}. Enter the amount in ${dealCurrency}.` : "this deal does not state its currency. Enter the amount."
          }`
        : null,
    });
  }
  return out.sort((a, b) => (a.fieldKey + (a.itemKey ?? "")).localeCompare(b.fieldKey + (b.itemKey ?? "")));
}

const NO_MATCH_NOTES = ["No field matches this label", "No budget line matches this label"];
export const SUGGESTED_NOTE = "Suggested label, not read by Agir's rules; confirm it";

/** A figure the reader found but could not label. Any refused figure (limit, fee, range, year, struck, per-basis, scale, not part of the deal) carries another note and is never offered. */
export const offerable = (c: Candidate): boolean => c.fieldKey === null && c.value !== null && NO_MATCH_NOTES.includes(c.note ?? "");

/** A stable id for each offered figure: its document, location and raw text, numbered when the same triple repeats. */
export function offeredIds(offered: readonly SourcedCandidate[]): string[] {
  const seen = new Map<string, number>();
  return offered.map((c) => {
    const base = `${c.documentId}|${c.location}|${c.raw}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
}

/** The unit a figure was written with, without its currency code ("CAD" alone is "$"). */
const seenUnit = (u: string | null): string | null => {
  if (u === null) return null;
  const bare = u.replace(/\s?(CAD|USD|AUD)$/, "");
  return bare === "" ? "$" : bare;
};
const UNIT_SEEN: Record<string, string | null> = { "$": "$", "$/unit/mo": "$/mo", "$/sf/yr": "$/sf", "%": "%", months: "months", years: "years", x: "x", sf: "sf", units: null };

/**
 * Cross the boundary a model's label suggestion must pass. A kept candidate is the offered figure itself:
 * only its fieldKey and itemKey come from the suggestion, and any other property of a suggestion is never read.
 * The caller concatenates `kept` with the reader's candidates and calls `consolidate`. A "suggested" candidate
 * reaches a person as needs_review or a conflict like any other; nothing here or in `consolidate` approves it.
 */
export function applySuggestions(
  results: readonly SourcedCandidate[],
  offered: readonly SourcedCandidate[],
  suggestions: readonly { id: string; fieldKey: string | "ignore"; itemKey?: string | null }[],
): { kept: SourcedCandidate[]; dropped: { id: string; why: string }[] } {
  const ids = offeredIds(offered);
  const read = new Set(results.filter((r) => r.fieldKey && r.value !== null).map((r) => `${r.fieldKey}|${(r.itemKey ?? "").toLowerCase()}`));
  const used = new Set<string>();
  const kept: SourcedCandidate[] = [];
  const dropped: { id: string; why: string }[] = [];
  for (const s of suggestions) {
    const id = String(s.id);
    const drop = (why: string) => dropped.push({ id, why });
    const at = ids.indexOf(id);
    const fig = offered[at];
    if (!fig) { drop("The id names no offered figure"); continue; }
    if (!offerable(fig)) { drop("This figure is not one that may be offered"); continue; }
    if (used.has(id)) { drop("This figure was already suggested once"); continue; }
    if (s.fieldKey === "ignore") { drop("The model said this figure is no input"); continue; }
    const def = FIELD_BY_KEY.get(s.fieldKey);
    if (!def) { drop("The key is not in the catalog"); continue; }
    if (!def.extractable) { drop("This field is not read from documents"); continue; }
    const unit = seenUnit(fig.unitSeen);
    // A count is written bare or as "units", as the reader itself records it.
    const fits = def.unit === "units" ? (unit === null || unit === "units") : def.unit in UNIT_SEEN && unit === UNIT_SEEN[def.unit];
    if (!fits) { drop(`The figure's unit (${fig.unitSeen ?? "none"}) does not fit ${def.unit}`); continue; }
    // The field's own bounds: a figure the field could never hold is not that field's figure.
    const v = fig.value!;
    if ((def.integer && !Number.isInteger(v)) || (def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) { drop(`The figure is outside what ${def.key} can hold`); continue; }
    let itemKey: string | null = null;
    if (def.itemized) {
      itemKey = typeof s.itemKey === "string" ? s.itemKey.trim() : "";
      if (!itemKey || !fig.context.toLowerCase().includes(itemKey.toLowerCase())) { drop("The item name is missing or not in the figure's own context"); continue; }
      // The same item name the reader would give it ("2-bed" is "2BR"), so it groups with the reader's figures in consolidate.
      itemKey = canonicalItem(itemKey);
    }
    if (read.has(`${def.key}|${(itemKey ?? "").toLowerCase()}`)) { drop("The reader already read this field for the deal"); continue; }
    used.add(id);
    kept.push({ ...fig, fieldKey: def.key, itemKey, rule: "suggested", note: SUGGESTED_NOTE });
  }
  return { kept, dropped };
}
