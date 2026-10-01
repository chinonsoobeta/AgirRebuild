import { describe, expect, test } from "vitest";
import { assemble, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, scoreExtraction, type NormalizedDocument, type SourcedCandidate, type Table } from "../src/index.ts";
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

describe("square metres become square feet at entry (decision 7)", () => {
  const doc = (lines: string[], tables: Table[] = []): NormalizedDocument => ({
    kind: "pdf",
    lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })),
    tables,
    pageCount: 1,
    needsOcr: false,
    fullText: lines.join("\n"),
  });
  const only = (r: ReturnType<typeof extractCandidates>, fieldKey: string) => {
    const found = r.candidates.filter((c) => c.fieldKey === fieldKey);
    expect(found, fieldKey).toHaveLength(1);
    return found[0]!;
  };

  test("an area in m² is read as square feet, and the candidate keeps what the document said", () => {
    const c = only(extractCandidates(doc(["Retail area: 1,000 m²"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Retail", raw: "1,000 m²", unitSeen: "m2" });
    expect(c.value).toBeCloseTo(10_763.91, 2);
  });
  test("a rent per m² is read as a rent per square foot", () => {
    const c = only(extractCandidates(doc(["Retail rent: $366/m²"])), "rent_psf_annual");
    expect(c).toMatchObject({ itemKey: "Retail", unitSeen: "$/m2" });
    expect(c.value).toBeCloseTo(34.0025, 4);
  });
  test("a component named with only an area in m²", () => {
    const c = only(extractCandidates(doc(["Retail: 836 m²"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Retail", unitSeen: "m2" });
    expect(c.value).toBeCloseTo(8_998.63, 2);
  });
  test("a rent roll whose headers are in m² is converted cell by cell", () => {
    const table: Table = {
      name: "Rent roll",
      rows: [
        [{ text: "Unit type", ref: "A1" }, { text: "Area (m²)", ref: "B1" }, { text: "Rent ($/m²/yr)", ref: "C1" }],
        [{ text: "Retail", ref: "A2" }, { text: "836", number: 836, ref: "B2" }, { text: "366", number: 366, unit: "$", ref: "C2" }],
      ],
    };
    const r = extractCandidates(doc([], [table]));
    const area = only(r, "rentable_area_sf");
    const rent = only(r, "rent_psf_annual");
    expect(area).toMatchObject({ itemKey: "Retail", unitSeen: "m2" });
    expect(area.value).toBeCloseTo(8_998.63, 2);
    expect(rent).toMatchObject({ itemKey: "Retail", unitSeen: "$/m2" });
    expect(rent.value).toBeCloseTo(34.0025, 4);
    expect(r.candidates.some((c) => c.fieldKey === "unit_rent_monthly")).toBe(false);
  });
  test("one document in m² and another in square feet are compared in square feet", () => {
    const a = extractCandidates(doc(["Retail area: 1,000 m²"])).candidates.map((c) => ({ ...c, documentId: "a", documentName: "Plans" }));
    const b = extractCandidates(doc(["Retail area: 10,764 SF"])).candidates.map((c) => ({ ...c, documentId: "b", documentName: "Rent roll" }));
    const [p] = consolidate([...a, ...b]);
    expect(p!.status).toBe("conflicting");
    expect(p!.values.map((v) => v.value)).toEqual([expect.closeTo(10_763.91, 2), 10_764]);
  });
  test("pi² in a French document is square feet", () => {
    const c = only(extractCandidates(doc(["Commerce : 9 400 pi²", "Prix demandé : 31 200 000"])), "rentable_area_sf");
    expect(c).toMatchObject({ itemKey: "Commerce", value: 9_400, unitSeen: "sf" });
  });
});
