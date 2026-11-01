import { describe, expect, test } from "vitest";
import { verifyReading, READING_FAILURE, type NormalizedDocument, type Reading } from "../src/index.ts";

type Figure = { field: string; item?: string; value: number; unit: string; quote: string; raw?: string; candidateValue?: number; ambiguous?: boolean };
const accepted: Figure[] = [
  { field: "land_cost", value: 1025000, unit: "$", quote: "Land $ _1,025,000.00", raw: "1,025,000.00" },
  { field: "hard_cost", value: 2450272.92, unit: "$", quote: "Hard costs § _2,450,272.92", raw: "2,450,272.92" },
  { field: "land_cost", value: 1025000, unit: "$", quote: "Land $ 1,025.000.00", raw: "1,025.000.00" },
  { field: "hard_cost", value: 16439679.92, unit: "$", quote: "Hard costs S 16,439 679.92", raw: "16,439 679.92" },
  { field: "hard_cost", value: 18997661, unit: "$", quote: "Hard costs 1 18 997,661", raw: "18 997,661" },
  { field: "fixed_opex_annual", value: 923760, unit: "$", quote: "TOTAL OPERATING EXPENSES 923.760 PUPA: 14.434", raw: "923.760" },
  { field: "land_cost", value: 1056297, unit: "$", quote: "Mise de fonds 1056 297 $", raw: "1056 297" },
  { field: "senior_loan_amount", value: 43.63, unit: "$", quote: "Required mortgage ($M) $43. 63 .", raw: "43. 63", candidateValue: 43630000 },
  { field: "senior_rate_pct", value: 6.75, unit: "%", quote: "Rate 6. 75%", raw: "6. 75" },
  { field: "land_cost", value: 14000, unit: "$", quote: "Land 923,760 14 000", raw: "14 000" },
  { field: "land_cost", value: 1500250, unit: "$", quote: "Land 1.500 250 12", raw: "1.500 250" },
  { field: "fixed_opex_annual", value: 41979, unit: "$", quote: "Dépenses Totales -41979$ 304% 6997$", raw: "-41979" },
  { field: "fixed_opex_annual", value: 41979, unit: "$", quote: "Dépenses Totales 41 979 $ 30,4 % 6 997 $", raw: "41 979", ambiguous: false },
];
const refused: Figure[] = [
  { field: "land_cost", value: 30512046, unit: "$", quote: "Land 130,512,046" },
  { field: "land_cost", value: 102500, unit: "$", quote: "Land 1,025.00" },
  { field: "variable_expense_pct", value: 30.4, unit: "%", quote: "Expenses 304%" },
  { field: "senior_rate_pct", value: 4, unit: "%", quote: "Taux d'intérêt 40%" },
  { field: "senior_rate_pct", value: 5.25, unit: "%", quote: "Rate 5 25%" },
  { field: "senior_amort_years", value: 12, unit: "years", quote: "Term 1 2" },
  { field: "unit_count", value: 12, unit: "units", quote: "Units 1 2" },
  { field: "land_cost", value: 1250000, unit: "$", quote: "Land 12,500,000" },
  { field: "land_cost", value: 125000, unit: "$", quote: "Land 12,500" },
  { field: "land_cost", value: 1250000, unit: "$", quote: "Land 1,250" },
  { field: "land_cost", value: 1250, unit: "$", quote: "Suite 1 250 000" },
  { field: "land_cost", value: 250000, unit: "$", quote: "Suite 1 250 000" },
  { field: "land_cost", value: 456789, unit: "$", quote: "Land 123 456 789" },
  { field: "land_cost", value: 250, unit: "$", quote: "Land 0 250" },
  { field: "other_cost", value: 125000, unit: "$", quote: "Rebate -125,000" },
  { field: "other_cost", value: 125000, unit: "$", quote: "Rebate (125,000)" },
  { field: "other_cost", value: 125000, unit: "$", quote: "Other costs $ _125,000.00" },
  { field: "rent_growth_pct", value: 2.5, unit: "%", quote: "Rent growth -2. 5%" },
  { field: "expense_growth_pct", value: 3.5, unit: "%", quote: "Expenses (3. 5%)" },
];
function verify(figure: Figure, ocr: boolean, otherText = "") {
  const location = "page 1, line 1";
  const document: NormalizedDocument = {
    kind: "pdf", lines: [{ location: location + (ocr ? " (OCR, confidence 90%)" : ""), text: figure.quote },
      ...(otherText ? [{ location: "page 1, line 2", text: otherText }] : [])],
    tables: [], pageCount: 1, needsOcr: false, fullText: [figure.quote, otherText].filter(Boolean).join("\n"),
  };
  const reading: Reading = { field: figure.field, item: figure.item ?? null, value: figure.value, unit_seen: figure.unit,
    file: "invented.pdf", location, quote: figure.quote, note: null, confidence: "high" };
  return verifyReading(reading, [{ id: "invented", name: reading.file, document }]);
}
function expectAccepted(figure: Figure, ocr: boolean, otherText = "") {
  const result = verify(figure, ocr, otherText);
  expect(result.outcome).toBe("verified");
  expect(result.candidate).toMatchObject({ value: figure.candidateValue ?? figure.value, raw: figure.raw });
  expect(result.candidate?.ambiguous).toBe(figure.ambiguous === false ? undefined : true);
  expect(result.candidate?.ocr).toBe(ocr ? true : undefined);
}

describe("Card 196: invented smudged figures", () => {
  test.each(accepted)("OCR accepts $quote", figure => expectAccepted(figure, true));
  test.each(refused)("OCR refuses $quote as $value", figure => {
    expect(verify(figure, true)).toEqual({ outcome: figure.quote === "Land 0 250" ? READING_FAILURE.small : READING_FAILURE.value });
  });
  test.each(accepted.slice(0, -1))("text layer still refuses $quote", figure => {
    expect(verify(figure, false)).toEqual({ outcome: figure.quote === "Land 0 250" ? READING_FAILURE.small : READING_FAILURE.value });
  });
  test.each(refused)("text layer still refuses $quote as $value", figure => {
    expect(verify(figure, false)).toEqual({ outcome: figure.quote === "Land 0 250" ? READING_FAILURE.small : READING_FAILURE.value });
  });
  test.each([false, true])("French trailing dollar, OCR=%s, uses comma decimals without ambiguity", ocr => {
    expectAccepted(accepted.at(-1)!, ocr);
  });
  test.each([false, true])("French trailing dollar, OCR=%s, flags dot decimals", ocr => {
    const figure = { ...accepted.at(-1)!, quote: "Dépenses Totales 41 979 $ 30.4 % 6 997 $", ambiguous: true };
    expectAccepted(figure, ocr);
  });
  test("an ordinary OCR figure uses the existing chain without ambiguity", () => {
    expectAccepted({ field: "land_cost", value: 1025000, unit: "$", quote: "Land $1,025,000", raw: "$1,025,000", ambiguous: false }, true);
  });
  test.each(["other_cost", "land_cost"])("a negative %s reading keeps its sign", field => {
    const other = field === "other_cost";
    expectAccepted({ field, value: other ? -125000 : -1025000, unit: "$", quote: other ? "Rebate -125,000" : "Land -1,025,000",
      raw: other ? "-125,000" : "-1,025,000", ambiguous: false }, true, "Price 1,025,000.00");
  });
  test("a negative reading never uses the smudged fallback", () => {
    expect(verify({ field: "land_cost", value: -1025000, unit: "$", quote: "Land $ _1,025,000.00" }, true,
      "Price 1,025,000.00")).toEqual({ outcome: READING_FAILURE.value });
  });
  test.each([false, true])("a minus on land is reinterpreted only on OCR=%s", ocr => {
    const figure = { field: "land_cost", value: 1025000, unit: "$", quote: "Land -1,025,000", raw: "-1,025,000" };
    if (ocr) expectAccepted(figure, true, "Price 1,025,000.00");
    else expect(verify(figure, false, "Price 1,025,000.00")).toEqual({ outcome: figure.quote === "Land 0 250" ? READING_FAILURE.small : READING_FAILURE.value });
  });
  test.each([false, true])("parenthesised land stays unambiguous on OCR=%s", ocr => {
    expectAccepted({ field: "land_cost", value: 1025000, unit: "$", quote: "Land (1,025,000)", raw: "(1,025,000", ambiguous: false }, ocr, "Price 1,025,000.00");
  });
});

describe("Card 196 audit: what a dollar sign and a lone figure do not prove", () => {
  // A dollar sign touching a digit starts the next figure, and a count is never followed by its own dollar sign.
  test.each([
    { field: "land_cost", value: 60590, unit: "$", quote: "Land 60 590 $2,200", raw: "60 590" },
    { field: "unit_count", value: 60590, unit: "units", quote: "One-bedroom 60 590 $ 2,200", raw: "60 590" },
  ])("$quote is two figures on a text layer, and on a recognized line a figure to check", figure => {
    expect(verify(figure, false)).toEqual({ outcome: READING_FAILURE.value });
    expectAccepted(figure, true);
  });
  test.each([
    { field: "fixed_opex_annual", value: 41979, unit: "$", quote: "Depenses 41 979 $ 30.4 %", raw: "41 979" },
    { field: "unit_rent_monthly", item: "Studio", value: 1450, unit: "$/unit/mo", quote: "Studio 1 450 $ 2 900 $", raw: "1 450" },
  ])("$quote keeps its French dollar figure", figure => {
    for (const ocr of [false, true]) expectAccepted(figure, ocr);
  });
  // A lone group has no punctuation to smudge, and what touches it may be a misread digit or a decimal point.
  test.each([
    { field: "senior_rate_pct", value: 5, unit: "%", quote: "Rate l5%" },
    { field: "senior_rate_pct", value: 5, unit: "%", quote: "Rate .5%" },
    { field: "land_cost", value: 4394, unit: "$", quote: "Land _4394" },
    { field: "senior_amort_years", value: 30, unit: "years", quote: "Term_30" },
    { field: "unit_count", value: 120, unit: "units", quote: "Block A120" },
  ])("recognition never proves $value from $quote", figure => {
    expect(verify(figure, true)).toEqual({ outcome: READING_FAILURE.value });
  });
  test.each([
    { field: "senior_loan_amount", value: 7600000, unit: "$", quote: "Senior loan 7600,000", raw: "7600,000" },
    { field: "soft_cost", value: 1120500, unit: "$", quote: "Soft costs 1120,500", raw: "1120,500" },
  ])("a dropped comma in $quote keeps its figure, to check", figure => {
    expectAccepted(figure, true);
    expect(verify(figure, false)).toEqual({ outcome: READING_FAILURE.value });
  });
});
