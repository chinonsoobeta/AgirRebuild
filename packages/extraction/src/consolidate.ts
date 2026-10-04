import type { Candidate } from "./candidates.ts";
import { currencyOf } from "./mapping.ts";

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
