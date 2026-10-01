import type { Candidate } from "./candidates.ts";

export type SourcedCandidate = Candidate & { documentId: string; documentName: string };

export type Proposal = {
  fieldKey: string;
  itemKey: string | null;
  /** needs_review when every source agrees; conflicting when they do not. */
  status: "needs_review" | "conflicting";
  value: number | null;
  sources: SourcedCandidate[];
  /** Distinct documented values, for a conflict. */
  values: { value: number; sources: SourcedCandidate[] }[];
};

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Gather candidates from every live document into one proposal per field.
 * Agreement yields one value for review. Disagreement yields a conflict that
 * lists every documented value; Agir never picks between them.
 */
export function consolidate(candidates: readonly SourcedCandidate[]): Proposal[] {
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
    for (const c of list) {
      const hit = values.find((v) => same(v.value, c.value!));
      if (hit) hit.sources.push(c);
      else values.push({ value: c.value!, sources: [c] });
    }
    values.sort((a, b) => a.value - b.value);
    out.push({
      fieldKey,
      itemKey: item || null,
      status: values.length > 1 ? "conflicting" : "needs_review",
      value: values.length === 1 ? values[0]!.value : null,
      sources: list,
      values,
    });
  }
  return out.sort((a, b) => (a.fieldKey + (a.itemKey ?? "")).localeCompare(b.fieldKey + (b.itemKey ?? "")));
}
