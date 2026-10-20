import { FIELD_BY_KEY, FIELDS } from "@agir/contracts";
import { detectFormat, tokenize } from "@agir/numbers";
import type { Candidate } from "./candidates.ts";
import { CONCEPTS } from "./concepts.ts";
import { canonicalItem, currencyOf, foldText, itemFold, outsideBounds } from "./mapping.ts";

/** `labelledBy` is the person whose label put a figure here (task 58), so review can ask someone else to confirm it. */
export type SourcedCandidate = Candidate & { documentId: string; documentName: string; ocr?: boolean; labelledBy?: string };

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

/** Names that fold equal are one item; the group is named in the form most of its sources use, and on a tie the one that sorts first by code point ("Retail" before "retail"). */
function groupForm(list: readonly SourcedCandidate[]): string {
  const count = new Map<string, number>();
  for (const c of list) count.set(c.itemKey ?? "", (count.get(c.itemKey ?? "") ?? 0) + 1);
  return [...count].sort(([a, n], [b, m]) => m - n || (a < b ? -1 : a > b ? 1 : 0))[0]![0];
}

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
    const k = `${c.fieldKey}|${itemFold(c.itemKey ?? "")}`;
    const list = groups.get(k) ?? [];
    list.push(c);
    groups.set(k, list);
  }
  const out: Proposal[] = [];
  for (const list of groups.values()) {
    const fieldKey = list[0]!.fieldKey!;
    const item = groupForm(list);
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

/** A count is written bare or as "units", as the reader itself records it. */
const unitFits = (fieldUnit: string, unit: string | null) => (fieldUnit === "units" ? unit === null || unit === "units" : fieldUnit in UNIT_SEEN && unit === UNIT_SEEN[fieldUnit]);

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
    const fits = unitFits(def.unit, unit);
    if (!fits) { drop(`The figure's unit (${fig.unitSeen ?? "none"}) does not fit ${def.unit}`); continue; }
    // The field's own bounds: a figure the field could never hold is not that field's figure.
    const v = fig.value!;
    if (outsideBounds(def, v)) { drop(`The figure is outside what ${def.key} can hold`); continue; }
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

/**
 * Whether a person may label a figure written with `unitSeen` as a field of `fieldUnit`. A bare number takes the field's unit, because the person states it;
 * a plain dollar figure takes the basis of the money field named (a rent-roll cell under "Monthly rent" reads "$2,350");
 * a figure written with its own basis ("a month", "per sf") must fit as it is.
 */
const labelFits = (fieldUnit: string, unitSeen: string | null): boolean => {
  const unit = seenUnit(unitSeen);
  return unit === null || (unit === "$" && fieldUnit.startsWith("$")) || unitFits(fieldUnit, unit);
};

const LOOKS_LIKE = /^Looks like (.+), but the number is not written as /;

/**
 * Card 112. At most three fields a person might label an unnamed figure with, best first. Nothing reads, stores or approves a suggestion:
 * a person's click saves an ordinary label, which crosses `applyLabels` as any other. Only a figure no field matched, or one that looked like
 * a field but was written in another unit, gets suggestions; a figure refused for any other reason was refused for that reason.
 * The field a "Looks like" note names ranks first; then each concept whose words appear in the context and whose exclusion does not,
 * by how many of its words appear (two fitting concepts are both suggested). The figure's unit must fit as a label's does, and an
 * itemized field needs an item name, so it is never suggested. Ties keep the order of FIELDS.
 */
export function suggestFields(f: { raw: string; context: string; note: string | null; unitSeen?: string | null; value?: number | null }): string[] {
  const looks = LOOKS_LIKE.exec(f.note ?? "")?.[1];
  if (!looks && !NO_MATCH_NOTES.includes(f.note ?? "")) return [];
  const token = f.unitSeen === undefined || f.value === undefined ? tokenize(f.raw, detectFormat(f.raw))[0] : undefined;
  const unitSeen = f.unitSeen !== undefined ? f.unitSeen : (token?.unit ?? null);
  // The figure's own clause names it best, as for the reader: the words before it, or after it when it leads its clause.
  // Words elsewhere in its context count too, for less, and an exclusion counts only in the clause.
  const at = f.context.indexOf(f.raw);
  const before = at < 0 ? f.context : f.context.slice(0, at).split(/[,;]/).pop()!;
  const clause = foldText(before.trim() || f.context.slice(at + f.raw.length).split(/[,;.]/)[0]!);
  const text = foldText(f.context);
  const count = (c: (typeof CONCEPTS)[number], t: string) => [...c.words, ...(c.with ?? [])].reduce((sum, w) => sum + (t.match(new RegExp(w.source, "g"))?.length ?? 0), 0);
  const score = new Map<string, number>();
  const named = looks ? FIELDS.find((d) => d.label.toLowerCase() === looks) : undefined;
  if (named) score.set(named.key, 1000);
  for (const c of CONCEPTS) {
    if (!c.words.some((w) => w.test(text)) || c.exclude.test(clause)) continue;
    score.set(c.fieldKey, (score.get(c.fieldKey) ?? 0) + 10 * count(c, clause) + count(c, text));
  }
  // Audit: a suggestion is a label the boundary would keep. A value outside a field's bounds is not offered for it, and a small bare number
  // ("months 18") is not offered as dollars, although a person may still label it so.
  const value = f.value !== undefined ? f.value : (token?.value ?? null);
  const fits = (d: (typeof FIELDS)[number]) => labelFits(d.unit, unitSeen) && (value === null || !outsideBounds(d, value)) && !(unitSeen === null && d.unit.startsWith("$") && value !== null && Math.abs(value) < 1000);
  return FIELDS.filter((d) => score.has(d.key) && d.extractable && !d.itemized && fits(d))
    .sort((a, b) => score.get(b.key)! - score.get(a.key)!)
    .slice(0, 3)
    .map((d) => d.key);
}

export const LABELLED_NOTE = "Labelled by a person from the document; confirm it";

/** Every unlabelled figure that has a value, in one order for the worker, the review and a reconcile, so their ids match. */
export const figureOrder = (cs: readonly SourcedCandidate[]): SourcedCandidate[] =>
  cs
    .filter((c) => c.fieldKey === null && c.value !== null)
    .sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0) || (a.raw < b.raw ? -1 : a.raw > b.raw ? 1 : 0) || (a.context < b.context ? -1 : a.context > b.context ? 1 : 0) || a.value! - b.value!);

/**
 * Cross the boundary a person's figure label must pass. `figures` is `figureOrder` of the deal's live documents; ids are `offeredIds` over it.
 * Unlike a suggestion, a label is kept although the reader read the field (consolidate names the conflict), and any unlabelled figure may be
 * labelled, even one the reader refused. A bare number takes the field's unit, because the person stated it.
 */
export function applyLabels(
  figures: readonly SourcedCandidate[],
  labels: readonly { id: string; fieldKey: string; itemKey?: string | null; by?: string }[],
): { kept: SourcedCandidate[]; dropped: { id: string; why: string }[] } {
  const ids = offeredIds(figures);
  const kept: SourcedCandidate[] = [];
  const dropped: { id: string; why: string }[] = [];
  for (const l of labels) {
    const id = String(l.id);
    const drop = (why: string) => dropped.push({ id, why });
    const fig = figures[ids.indexOf(id)];
    if (!fig) { drop("The figure is no longer in the document"); continue; }
    const def = FIELD_BY_KEY.get(l.fieldKey);
    if (!def) { drop("The key is not in the catalog"); continue; }
    if (!def.extractable) { drop("This field is not read from documents"); continue; }
    if (!labelFits(def.unit, fig.unitSeen)) { drop(`The figure's unit (${fig.unitSeen}) does not fit ${def.unit}`); continue; }
    if (outsideBounds(def, fig.value!)) { drop(`The figure is outside what ${def.key} can hold`); continue; }
    let itemKey: string | null = null;
    if (def.itemized) {
      itemKey = typeof l.itemKey === "string" ? l.itemKey.trim() : "";
      if (!itemKey) { drop("This field needs an item name"); continue; }
      itemKey = canonicalItem(itemKey);
    }
    kept.push({ ...fig, fieldKey: def.key, itemKey, rule: "labelled", note: LABELLED_NOTE, ...(l.by ? { labelledBy: l.by } : {}) });
  }
  return { kept, dropped };
}

/** A person's label beats a model's suggestion: drop the suggestions for figures a person labelled (rightly or not). */
export function withoutLabelled<S extends { id: string }>(figures: readonly SourcedCandidate[], labels: readonly { id: string }[], suggestions: readonly S[]): S[] {
  const labelled = new Set(labels.map((l) => figures[offeredIds(figures).indexOf(String(l.id))]).filter(Boolean));
  const offered = figures.filter(offerable);
  const offeredId = offeredIds(offered);
  const gone = new Set(offered.flatMap((f, i) => (labelled.has(f) ? [offeredId[i]!] : [])));
  return suggestions.filter((s) => !gone.has(String(s.id)));
}
