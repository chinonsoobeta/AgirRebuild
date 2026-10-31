import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { consolidate, extractCandidates, type SourcedCandidate } from "../src/index.ts";
import { toNormalized, type OracleDeal, type OracleDoc } from "./oracle.ts";

// Card F1: two fictional deals that sell their units. They sit beside the tests, not in oracles/deals, so no reference deal changes.
const key = (f: string, i: string | null) => (i ? `${f}|${i}` : f);
const saleDeal = (slug: string) => JSON.parse(readFileSync(join(import.meta.dirname, "sale-deals", `${slug}.json`), "utf8")) as OracleDeal;
const lines = (...l: string[]): OracleDoc => ({ name: "note.pdf", kind: "pdf", lines: l });
const read = (doc: OracleDoc) => Object.fromEntries(extractCandidates(toNormalized(doc)).candidates.map((c) => [key(c.fieldKey!, c.itemKey), c.value]));

for (const slug of ["fernhill-row", "tamarack-terrace"]) {
  const deal = saleDeal(slug);
  describe(`sale deal: ${deal.name}`, () => {
    const all: SourcedCandidate[] = deal.documents.flatMap((doc) => extractCandidates(toNormalized(doc)).candidates.map((c) => ({ ...c, documentId: doc.name, documentName: doc.name })));
    const proposals = consolidate(all);

    test("every stated figure is read, with its document and place, and nothing else is", () => {
      const got = Object.fromEntries(proposals.map((p) => [key(p.fieldKey, p.itemKey), p.value]));
      expect(got).toEqual(deal.expect.values);
      for (const c of all) expect(c.location, key(c.fieldKey!, c.itemKey)).toBeTruthy();
    });

    test("no two documents disagree", () => {
      expect(proposals.filter((p) => p.status === "conflicting")).toEqual([]);
    });

    test("a count of a total never becomes the share presold", () => {
      for (const [k, vs] of Object.entries(deal.expect.neverValues ?? {})) for (const v of vs) expect(all.some((c) => key(c.fieldKey!, c.itemKey) === k && c.value === v), `${k}=${v}`).toBe(false);
    });
  });
}

describe("sale figures in labels and sentences", () => {
  test("presales, the lender's presale condition, deposit, commission, pace, closing lag and carry", () => {
    expect(read(lines("Presales: 50%", "Buyer deposit: 10%", "Sales commission: 4%", "Sales pace: 3 units per month", "Closing lag: 4 months", "Carry per unsold unit: $650 per month"))).toEqual({
      presold_units_pct: 50, deposit_pct: 10, sales_commission_pct: 4, absorption_units_per_month: 3, closing_lag_months: 4, unsold_carry_monthly: 650,
    });
    expect(read(lines("Presale requirement: 60% presold before first draw"))).toEqual({ senior_presale_threshold_pct: 60 });
    expect(read(lines("Presales: 60% before first draw"))).toEqual({ senior_presale_threshold_pct: 60 });
  });

  test("the French words", () => {
    expect(read(lines("Préventes : 55 %", "Dépôt des acheteurs : 15 %", "Commission de vente : 3,5 %", "Préventes exigées : 65 %", "Délai de clôture : 3 mois"))).toEqual({
      presold_units_pct: 55, deposit_pct: 15, sales_commission_pct: 3.5, senior_presale_threshold_pct: 65, closing_lag_months: 3,
    });
  });

  test("a price by type in a label", () => {
    expect(read(lines("End unit price: $899,900", "Interior sale price: $779,900"))).toEqual({ "unit_sale_price|End": 899_900, "unit_sale_price|Interior": 779_900 });
  });

  test("words that only look like sale figures are not read as them", () => {
    const got = read(lines("Leasing commission: 4%", "Bank deposit rate: 3%", "Sales commission cap: 3%", "Presales cap: 60%", "Sales pace: 36 units per year", "Land price: $2,100,000"));
    for (const k of ["sales_commission_pct", "deposit_pct", "presold_units_pct", "senior_presale_threshold_pct", "absorption_units_per_month"]) expect(got[k], k).toBeUndefined();
    expect(Object.keys(got).some((k) => k.startsWith("unit_sale_price"))).toBe(false);
  });

  test("a price list with a different price inside one type reads no price for that type", () => {
    const r = extractCandidates(toNormalized({ name: "Prices.xlsx", kind: "xlsx", sheet: "Prices", rows: [["Unit", "Type", "Price"], ["1", "End", 899_900], ["2", "Interior", 779_900], ["3", "Interior", 789_900], ["Total", "", 2_469_700]] }));
    expect(r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value])).toEqual([["unit_sale_price", "End", 899_900]]);
    expect(r.other.map((o) => o.value)).toEqual(expect.arrayContaining([779_900, 789_900, 2_469_700]));
  });
});
