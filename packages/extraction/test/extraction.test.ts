import { describe, expect, test } from "vitest";
import { assemble, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, scoreExtraction, type SourcedCandidate } from "../src/index.ts";
import { loadOracles, toNormalized } from "./oracle.ts";

const key = (f: string, i: string | null) => (i ? `${f}|${i}` : f);

for (const deal of loadOracles()) {
  describe(`reference deal: ${deal.name}`, () => {
    const all: SourcedCandidate[] = [];
    const others: { doc: string; value: number | null; note?: string }[] = [];
    for (const doc of deal.documents) {
      const r = extractCandidates(toNormalized(doc));
      all.push(...r.candidates.map((c) => ({ ...c, documentId: doc.name, documentName: doc.name })));
      others.push(...r.other.map((o) => ({ doc: doc.name, value: o.value, ...(o.note ? { note: o.note } : {}) })));
    }
    const proposals = consolidate(all);
    // An analyst approves every agreed value and leaves conflicts open.
    const rows: AssumptionRow[] = proposals.map((p) => ({
      fieldKey: p.fieldKey,
      itemKey: p.itemKey,
      status: p.status === "conflicting" ? "conflicting" : "approved",
      valueNumeric: p.value,
    }));
    const { readiness, input } = assemble(rows);

    test("conflicts are exactly the documented ones, each with every value", () => {
      const got = proposals
        .filter((p) => p.status === "conflicting")
        .map((p) => ({ key: key(p.fieldKey, p.itemKey), values: p.values.map((v) => v.value) }))
        .sort((a, b) => a.key.localeCompare(b.key));
      expect(got).toEqual([...deal.expect.conflicts].sort((a, b) => a.key.localeCompare(b.key)));
    });

    test("missing inputs are named", () => {
      const missing = readiness.missing.map((m) => key(m.fieldKey, m.itemKey ?? null)).sort();
      expect(missing).toEqual([...deal.expect.missing].sort());
    });

    if (deal.expect.values) {
      test("every expected value is read at the right magnitude", () => {
        const got = Object.fromEntries(proposals.filter((p) => p.value !== null).map((p) => [key(p.fieldKey, p.itemKey), p.value]));
        for (const [k, v] of Object.entries(deal.expect.values!)) expect(got[k], k).toBeCloseTo(v, 6);
      });
    }

    if (deal.expect.neverValues) {
      test("misreadable figures never become candidates", () => {
        for (const [k, vs] of Object.entries(deal.expect.neverValues!)) {
          for (const v of vs) expect(all.some((c) => key(c.fieldKey!, c.itemKey) === k && c.value === v), `${k}=${v}`).toBe(false);
        }
      });
    }

    if (deal.expect.neverInputs) {
      test("output figures never become candidates", () => {
        for (const v of deal.expect.neverInputs!) expect(all.some((c) => c.value === v)).toBe(false);
      });
    }

    if (deal.expect.teaserNeverCandidates) {
      test("nothing in the broker teaser becomes a candidate", () => {
        for (const d of deal.expect.teaserNeverCandidates!) expect(all.filter((c) => c.documentName === d)).toEqual([]);
        expect(others.filter((o) => deal.expect.teaserNeverCandidates!.includes(o.doc)).length).toBeGreaterThanOrEqual(5);
      });
    }

    test(deal.expect.runs ? "is ready to run" : "is blocked", () => {
      expect(readiness.status).toBe(deal.expect.runs ? "ready" : "blocked");
      expect(input === null).toBe(!deal.expect.runs);
    });

    if (deal.expect.values) {
      test("extraction precision and recall against the golden values", () => {
        const golden = Object.entries(deal.expect.values!).map(([k, value]) => {
          const [fieldKey, itemKey] = k.split("|") as [string, string | undefined];
          return { fieldKey, itemKey: itemKey ?? null, value };
        });
        const s = scoreExtraction(all.filter((c) => golden.some((g) => g.fieldKey === c.fieldKey)), golden);
        expect(s.recall).toBe(1);
        expect(s.incorrect).toEqual([]);
      });
    }
  });
}
