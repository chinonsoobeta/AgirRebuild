import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { detectFormat, tokenize } from "@agir/numbers";
import { FIELD_BY_KEY, FIELD_TABLE } from "@agir/contracts";
import { mapToken } from "../src/mapping.ts";
import { frameFigure, nameFigure } from "../src/frame.ts";

const cases = [
  ["senior loan amount", "$2300000", "senior", "amount", "money", "senior_loan_amount"],
  ["taux du prêt senior", "6 %", "senior", "rate", "percent", "senior_rate_pct"],
  ["senior amortization", "28 years", "senior", "amortization", "years", "senior_amort_years"],
  ["senior intérêts seulement", "14 mois", "senior", "interest_only", "months", "senior_io_months"],
  ["minimum DSCR covenant", "1.3x", "deal", "coverage", "ratio", "min_dscr_covenant"],
  ["second loan amount", "$420000", "second", "amount", "money", "mezz_loan_amount"],
  ["taux du prêt de second rang", "9 %", "second", "rate", "percent", "mezz_rate_pct"],
  ["junior amortization", "20 years", "second", "amortization", "years", "mezz_amort_years"],
  ["mezzanine intérêts seulement", "12 mois", "second", "interest_only", "months", "mezz_io_months"],
  ["refinance amount", "$3100000", "refinance", "amount", "money", "refinance_amount"],
  ["taux du refinancement", "5 %", "refinance", "rate", "percent", "refinance_rate_pct"],
  ["refinance amortization", "30 years", "refinance", "amortization", "years", "refinance_amort_years"],
  ["refinancement intérêts seulement", "6 mois", "refinance", "interest_only", "months", "refinance_io_months"],
  ["refinance LTV", "75 %", "refinance", "ltv", "percent", "refinance_ltv_pct"],
  ["refinance term", "5 years", "refinance", "term", "years", "refinance_term_years"],
  ["loan-to-cost", "70 %", "deal", "ltc", "percent", "stated_ltc_pct"],
];
function figure(label: string, value: string) {
  return frameFigure(label, tokenize(value, detectFormat(value))[0]!);
}
describe("figure frame", () => {
  it.each(cases)("names %s", (label, value, subject, attribute, type, fieldKey) => {
    const frame = figure(label!, value!);
    expect(frame).toMatchObject({ subject, attribute, type, whose: "this_deal", refusal: null, item: null });
    expect(nameFigure(frame)).toEqual(fieldKey === "refinance_term_years" ? null : { fieldKey });
  });
  it.each([
    ["Another bank loan amount", "$2200000", "other_lender"],
    ["Autre banque taux", "6 %", "other_lender"],
    ["Senior qualifying rate", "7 %", "limit"],
    ["Prêt senior taux de qualification", "7 %", "limit"],
    ["Declined senior loan amount", "$2200000", "declined"],
    ["Offre refusée prêt senior montant", "$2200000", "declined"],
    ["Senior vacancy rate", "4 %", "this_deal"],
    ["Prêt senior taux d'inoccupation", "4 %", "this_deal"],
    ["Senior amortization term", "5 years", "this_deal"],
    ["Prêt senior amortissement terme", "5 ans", "this_deal"],
  ])("refuses %s", (label, value, whose) => {
    const frame = figure(label!, value!);
    expect(frame.whose).toBe(whose);
    expect(nameFigure(frame)).toHaveProperty("refused");
  });
  it("keeps region identity and reads windows from the definitions", () => {
    const region = { source: "sheet" as const };
    const token = tokenize("6%", detectFormat("6%"))[0]!;
    expect(frameFigure("senior rate", token, { region }).region).toBe(region);
    for (const row of FIELD_TABLE) expect(row.window).toBe(FIELD_BY_KEY.get(row.fieldKey)!.window);
    expect(nameFigure({ ...figure("senior rate", "6%"), subject: null })).toBeNull();
    expect(nameFigure({ ...figure("senior rate", "6%"), attribute: null })).toBeNull();
  });
});

it("leaves a capped loan-to-cost figure to the old rules", () => {
  expect(nameFigure(figure("The lender capped the loan-to-cost", "68%"))).not.toEqual({ fieldKey: "stated_ltc_pct" });
});

// Invented values exercise each provenance difference found by the full measurement.
it.each([
  ["Loan-to-cost", "71%", "stated_ltc_pct"],
  ["Loan-to-cost", "69.5%", "stated_ltc_pct"],
  ["Loan to cost", "73%", "stated_ltc_pct"],
  ["loan-to-cost", "66%", "stated_ltc_pct"],
  ["Loan to cost", "63.8%", "stated_ltc_pct"],
  ["Taux second rang", "13%", "mezz_rate_pct"],
  ["Loan-to-cost", "72%", "stated_ltc_pct"],
  ["Loan to cost", "62.9%", "stated_ltc_pct"],
  ["loan-to-cost", "71.5%", "stated_ltc_pct"],
  ["Senior fixed rate", "7.3%", "senior_rate_pct"],
  ["LTC", "74%", "stated_ltc_pct"],
  ["The second interest", "10.4%", "mezz_rate_pct"],
  ["Intérêt prioritaire", "6.45%", "senior_rate_pct"],
  ["Senior repayment years", "31 years", "senior_amort_years"],
  ["Junior rate", "11.4%", "mezz_rate_pct"],
  ["Junior advance", "$340000", "mezz_loan_amount"],
  ["Senior repayment horizon", "32 years", "senior_amort_years"],
  ["Senior principal holiday", "17 months", "senior_io_months"],
])("preserves concept provenance for %s (%s)", (label, value, fieldKey) => {
  const token = tokenize(value!, detectFormat(value!))[0]!;
  expect(mapToken(label!, token, { prose: true })).toMatchObject({ kind: "field", fieldKey, concept: true });
});

// Bank wording stays outside the repository; only aggregate counts are printed.
const bank = "/Users/chinonsoobeta/Documents/Codex/2026-10-04/agir-reading-work/harness/bank";
it("audits every loan wording-bank case through the frame alone", (context) => {
  if (!existsSync(bank)) { context.skip("External wording bank folder is absent"); return; }
  const scope = new Set(FIELD_TABLE.map(row => row.fieldKey));
  const totals: Record<string, { right: number; null: number; wrong: number; outOfScope: number; reasons: Record<string, number> }> = {};
  for (const file of readdirSync(bank).filter(f => f.endsWith(".txt")).sort()) {
    const counts = { right: 0, null: 0, wrong: 0, outOfScope: 0, reasons: {} as Record<string, number> };
    totals[file] = counts;
    for (const line of readFileSync(`${bank}/${file}`, "utf8").split("\n")) {
      const m = line.match(/^loan\s+([RT])\s+(en|fr)\s+(.+?)\s+\|\s+(.+)$/);
      if (!m) continue;
      const [, kind, , expected, input] = m;
      const want = expected!.replace(/^!/, "").split(/[\s,]+/).map(x => x.split("=")[0]!);
      if (!want.some(key => scope.has(key))) { counts.outOfScope++; continue; }
      const fields = new Set<string>();
      const reasons = new Set<string>();
      for (const part of input!.split(" // ")) {
        const sheet = /^S(?:\([^)]*\))?:/.test(part);
        const text = part.replace(/^S(?:\([^)]*\))?:/, "").replace(/\|/g, " ");
        for (const token of tokenize(text, detectFormat(text), sheet)) {
          const label = text.slice(0, token.start).split(/[,;]/).pop()?.replace(/:\s*$/, "") ?? "";
          const frame = frameFigure(label, token, { prose: !sheet, numberCell: sheet, context: text, after: text.slice(token.end) });
          const named = nameFigure(frame);
          if (named && "fieldKey" in named) fields.add(named.fieldKey);
          else reasons.add(!frame.subject ? "Subject not established" : !frame.attribute ? "Attribute not established" : !FIELD_TABLE.some(row => row.subject === frame.subject && row.attribute === frame.attribute && row.type === frame.type) ? "No matching table row or unit" : "Non-extractable table field");
        }
      }
      const wanted = want.filter(key => scope.has(key));
      const wrong = kind === "R" ? [...fields].some(key => !wanted.includes(key)) : [...fields].some(key => want.includes(key));
      if (wrong) counts.wrong++;
      else if (kind === "T" || wanted.every(key => fields.has(key))) counts.right++;
      else {
        counts.null++;
        const reason = [...reasons].sort().join("; ") || "No token named the required field";
        counts.reasons[reason] = (counts.reasons[reason] ?? 0) + 1;
      }
    }
  }
  console.log(`Frame-only bank: ${JSON.stringify(totals)}`);
  expect(Object.values(totals).reduce((n, counts) => n + counts.wrong, 0)).toBe(0);
});
