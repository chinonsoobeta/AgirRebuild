import type { Candidate } from "./candidates.ts";

export type GoldenEntry = { fieldKey: string; itemKey?: string | null; value: number };

export type Score = {
  correct: number;
  incorrect: { expected: GoldenEntry; got: number }[];
  missing: GoldenEntry[];
  spurious: Candidate[];
  precision: number;
  recall: number;
  f1: number;
};

/**
 * Precision, recall and F1 of a document's candidates against a hand-checked
 * golden map (plan task X9). A wrong value counts against precision AND recall;
 * a missing value only against recall. Tolerance is 0.5% relative.
 */
export function scoreExtraction(candidates: readonly Candidate[], golden: readonly GoldenEntry[]): Score {
  const key = (f: string, i?: string | null) => `${f}|${(i ?? "").toLowerCase()}`;
  const byKey = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.fieldKey || c.value === null) continue;
    const k = key(c.fieldKey, c.itemKey);
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  let correct = 0;
  const incorrect: Score["incorrect"] = [];
  const missing: GoldenEntry[] = [];
  const matched = new Set<string>();
  for (const g of golden) {
    const k = key(g.fieldKey, g.itemKey);
    const found = byKey.get(k);
    if (!found) {
      missing.push(g);
      continue;
    }
    matched.add(k);
    const ok = found.some((c) => Math.abs((c.value ?? NaN) - g.value) <= Math.abs(g.value) * 0.005 + 1e-9);
    if (ok) correct++;
    else incorrect.push({ expected: g, got: found[0]!.value! });
  }
  const spurious = [...byKey.entries()].filter(([k]) => !matched.has(k)).flatMap(([, v]) => v);
  const produced = correct + incorrect.length + spurious.length;
  const precision = produced === 0 ? 1 : correct / produced;
  const recall = golden.length === 0 ? 1 : correct / golden.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { correct, incorrect, missing, spurious, precision, recall, f1 };
}
