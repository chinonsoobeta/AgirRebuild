import { describe, expect, test } from "vitest";
import { detectFormat, tokenize, type DocumentFormat } from "../src/index.ts";

const US: DocumentFormat = { decimal: ".", mixed: false, evidence: { dot: 1, comma: 0 }, spaceGroups: false };
const EU: DocumentFormat = { decimal: ",", mixed: false, evidence: { dot: 0, comma: 1 }, spaceGroups: false };
const UNKNOWN: DocumentFormat = { decimal: null, mixed: false, evidence: { dot: 0, comma: 0 }, spaceGroups: false };
const first = (line: string, f: DocumentFormat) => tokenize(line, f)[0]!;

describe("format detection", () => {
  test("US and European documents", () => {
    expect(detectFormat("Loan: $27,625,000.00 at 6.25%").decimal).toBe(".");
    expect(detectFormat("Rente: 5,85 % und 12.400.000 EUR").decimal).toBe(",");
    expect(detectFormat("5.25% and 5,85 %").mixed).toBe(true);
  });
});

describe("the V4 corruption probes now fail closed or read correctly", () => {
  test("a comma decimal in a US document is refused, never read as 85", () => {
    const t = first("Interest rate: 5,85 %", US);
    expect(t.value).toBeNull();
  });
  test("the same token in a European document reads 5.85", () => {
    expect(first("Interest rate: 5,85 %", EU).value).toBe(5.85);
  });
  test("space-grouped thousands read whole, never the tail", () => {
    expect(first("Common equity contribution: $31 200 000", UNKNOWN).value).toBe(31_200_000);
  });
  test("an ambiguous rate is refused without document evidence", () => {
    const t = first("Interest rate: 5.125%", UNKNOWN);
    expect(t.value).toBeNull();
    expect(t.refusal).toMatch(/could be/);
  });
  test("money, counts and areas group thousands: they never have three decimals", () => {
    expect(first("Rent: $2,850 per unit per month", UNKNOWN).value).toBe(2_850);
    expect(first("Retail area: 9.400 SF", UNKNOWN).value).toBe(9_400);
    expect(first("120,000 units", UNKNOWN).value).toBe(120_000);
  });
  test("three-decimal money in a comma-decimal document is refused, not read as cents", () => {
    expect(first("Rent: $2,850", EU).value).toBeNull();
  });
  test("the same group reads as thousands in a European document", () => {
    const t = first("Retail area: 9.400 SF", EU);
    expect(t.value).toBe(9_400);
    expect(t.unit).toBe("sf");
  });
  test("a Unicode minus is a minus", () => {
    expect(first("Adjustment: −$2,150,000", US).value).toBe(-2_150_000);
    expect(first("Adjustment: ($2,150,000)", US).value).toBe(-2_150_000);
  });
  test("words are never numbers", () => {
    expect(tokenize("one hundred twenty units", US)).toEqual([]);
  });
});

describe("units and scale", () => {
  test("money scale words apply only to money", () => {
    expect(first("Loan of $34.5 million", US).value).toBe(34_500_000);
    expect(first("18 M sq ft", US).value).toBe(18);
  });
  test("rents, rates and durations", () => {
    expect(first("Rent $2,200 per month", US).unit).toBe("$/mo");
    expect(first("Office rent $38.00/SF", US).unit).toBe("$/sf");
    expect(first("Cap rate 5.25%", US).unit).toBe("%");
    expect(first("Construction: 18 months", US).unit).toBe("months");
    expect(first("DSCR 1.25x", US).unit).toBe("x");
    expect(first("120 units", US).unit).toBe("units");
  });
  test("prose numbers separated by a single space stay separate", () => {
    expect(tokenize("In 2026 120 units opened", US).map((t) => t.value)).toEqual([2026, 120]);
  });
  test("a single space group is refused unless the document groups with spaces", () => {
    expect(first("Retail area: 9 400 SF", EU).value).toBeNull();
    expect(first("Retail area: 9 400 SF", { ...EU, spaceGroups: true }).value).toBe(9_400);
  });
  test("a space group with a decimal part reads whole", () => {
    expect(first("Residential rent: 2 640,50 per unit per month", EU).value).toBe(2_640.5);
  });
});

describe("square metres and pi² (decision 7)", () => {
  test("square metres are their own unit, never square feet", () => {
    for (const line of ["Retail area: 1,000 m²", "Retail area: 1,000 m2", "Retail area: 1,000 sq m", "Retail area: 1,000 sq. m.", "Retail area: 1,000 square metres", "Retail area: 1,000 square meters"]) {
      expect(first(line, US), line).toMatchObject({ value: 1_000, unit: "m2" });
    }
  });
  test("square miles are not square metres", () => {
    expect(first("Trade area: 12 sq mi", US).unit).toBeNull();
  });
  test("a rent per square metre", () => {
    expect(first("Retail rent: $366/m²", US)).toMatchObject({ value: 366, unit: "$/m2" });
    expect(first("Retail rent: $366 per square metre", US)).toMatchObject({ value: 366, unit: "$/m2" });
    expect(first("Retail rent: $366 psm", US)).toMatchObject({ value: 366, unit: "$/m2" });
  });
  test("m² after an amount is never read as million", () => {
    expect(first("Land: $450 m²", US)).toMatchObject({ value: 450, scaled: false });
    expect(first("Land: $4.5 m", US).value).toBe(4_500_000);
  });
  test("an area in m² groups thousands, like one in square feet", () => {
    expect(first("Retail area: 1.000 m²", UNKNOWN)).toMatchObject({ value: 1_000, unit: "m2" });
  });
  test("pi², the French square foot, is square feet", () => {
    const FR: DocumentFormat = { ...EU, spaceGroups: true };
    for (const line of ["Commerce : 9 400 pi²", "Commerce : 9 400 pi2", "Commerce : 9 400 pi ca", "Commerce : 9 400 pieds carrés"]) {
      expect(first(line, FR), line).toMatchObject({ value: 9_400, unit: "sf" });
    }
  });
});
