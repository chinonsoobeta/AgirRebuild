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
  test("a percent unit settles three decimals without document evidence", () => {
    const t = first("Interest rate: 5.125%", UNKNOWN);
    expect(t.value).toBe(5.125);
    expect(t.refusal).toBeUndefined();
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

describe("scaled three-digit figures (Card 163)", () => {
  test.each([
    ["$1.216M", US, 1_216_000],
    ["$1.216M", EU, 1_216_000_000],
    ["$1.216M", UNKNOWN, null],
    ["0,614 M$", EU, 614_000],
    ["0,614 M$", UNKNOWN, 614_000],
    ["$0.614M", UNKNOWN, 614_000],
    ["$1,216M", UNKNOWN, null],
    ["$1,216M", US, 1_216_000_000],
    ["$1.2M", UNKNOWN, 1_200_000],
    ["$12,400", UNKNOWN, 12_400],
    ["$0.614M", US, 614_000],
    ["$0.614M", EU, null],
    ["0,614 M$", US, null],
    ["$0.614", UNKNOWN, 0.614],
    ["$0.614", EU, null],
  ] as const)("%s with document format %j reads %s", (line, format, value) => {
    const token = first(line, format);
    expect(token.value).toBe(value);
    if (value === null) {
      expect(token.refusal).toMatch(format.decimal
        ? /uses a different decimal separator/
        : /could be .* or .*; the document does not say which/);
    }
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

describe("the currency a figure names", () => {
  const code = (line: string, f = US) => first(line, f).currencyCode;
  test("a prefix names its currency; a bare dollar sign names none", () => {
    expect(["US$1,200", "USD 1,200", "CA$1,200", "C$1,200", "CAD 1,200", "A$1,200", "$1,200"].map((l) => code(l))).toEqual([
      "USD", "USD", "CAD", "CAD", "CAD", "AUD", null,
    ]);
  });
  test("a suffix names its currency too, including the French forms", () => {
    expect(["1,200,000 USD", "1,200,000 CAD", "$1.2 million USD"].map((l) => code(l))).toEqual(["USD", "CAD", "USD"]);
    expect(["1 250 000 $ US", "1 250 000 $ CA", "1 250 000 $ CAN"].map((l) => code(l, UNKNOWN))).toEqual(["USD", "CAD", "CAD"]);
  });
  test("a suffix makes the figure money, with its raw text and per-unit rule intact", () => {
    const t = first("Land cost: 1 250 000 $ US", UNKNOWN);
    expect(t).toMatchObject({ value: 1_250_000, currency: true, unit: "$", raw: "1 250 000 $ US" });
    expect(first("Rent: 2,100 USD/mo", US)).toMatchObject({ value: 2_100, unit: "$/mo", currencyCode: "USD" });
    expect(first("Land cost: US$1,200,000", US)).toMatchObject({ value: 1_200_000, currency: true, currencyCode: "USD" });
  });
  test("a figure with no mark names no currency", () => {
    expect(first("Units: 12", US)).toMatchObject({ currency: false, currencyCode: null });
    expect(code("Land cost: 1,200,000")).toBeNull();
  });
});

describe("French documents: a dollar sign after the number", () => {
  const FR: DocumentFormat = { ...EU, spaceGroups: true };
  test("a trailing dollar sign makes the figure money", () => {
    expect(first("Loyer : 18,75 $", FR)).toMatchObject({ value: 18.75, currency: true, unit: "$", currencyCode: null, raw: "18,75 $" });
    expect(first("Terrain : 1 250 000 $", FR)).toMatchObject({ value: 1_250_000, currency: true, unit: "$" });
    expect(first("Terrain : 1 250 000,00 $", FR)).toMatchObject({ value: 1_250_000, currency: true, unit: "$" });
  });
  test("it carries its per-unit reading: monthly, per square foot, per square metre", () => {
    expect(first("Loyer : 2 100 $/mois", FR)).toMatchObject({ value: 2_100, unit: "$/mo" });
    expect(first("Loyer : 2 100 $ par mois", FR)).toMatchObject({ value: 2_100, unit: "$/mo" });
    expect(first("Loyer : 18,75 $/pi²", FR)).toMatchObject({ value: 18.75, unit: "$/sf" });
    expect(first("Loyer : 18,75 $ par pi²", FR)).toMatchObject({ value: 18.75, unit: "$/sf" });
    expect(first("Loyer : 201,82 $/m²", FR)).toMatchObject({ value: 201.82, unit: "$/m2" });
  });
  test("French units for counts and durations", () => {
    expect(first("Durée : 18 mois", FR)).toMatchObject({ value: 18, unit: "months" });
    expect(first("Amortissement : 25 ans", FR)).toMatchObject({ value: 25, unit: "years" });
    expect(first("Nombre de logements : 24 logements", FR)).toMatchObject({ value: 24, unit: "units" });
  });
  test("a space-grouped figure with one group is refused unless the document groups with spaces or a trailing $ follows", () => {
    expect(first("Loyer : 2 100 / mois", EU).value).toBeNull();
    expect(first("Superficie : 2 100 pi²", EU).value).toBeNull();
    expect(first("Loyer : 2 100", EU).value).toBeNull();
    expect(first("Loyer : $2 100", EU).value).toBeNull();
  });
  test("a trailing dollar sign is itself fr-CA evidence for a single space group, with or without a per-unit suffix", () => {
    expect(first("Loyer : 2 100 $/mois", EU)).toMatchObject({ value: 2_100, unit: "$/mo", currencyCode: null });
    expect(first("Loyer : 2 100 $", EU)).toMatchObject({ value: 2_100, unit: "$" });
    expect(first("Loyer : 18 750 $/pi²", EU)).toMatchObject({ value: 18_750, unit: "$/sf" });
    expect(first("Terrain : 2 100 $ US", EU)).toMatchObject({ value: 2_100, currencyCode: "USD" });
    expect(first("Loyer : 2 100 $/mois", UNKNOWN)).toMatchObject({ value: 2_100, unit: "$/mo" });
  });
  test("a French document is detected as comma-decimal", () => {
    expect(detectFormat("Terrain : 1 250 000,00 $\nTaux : 5,25 %")).toMatchObject({ decimal: ",", spaceGroups: true });
  });
  test("English documents are unaffected: a dollar sign before the next figure is not a suffix", () => {
    const t = tokenize("Land $5 $10", US);
    expect(t.map((x) => [x.raw, x.value, x.currency])).toEqual([["$5", 5, true], ["$10", 10, true]]);
    expect(first("Rent: $2,850 per unit per month", US)).toMatchObject({ value: 2_850, unit: "$/mo", raw: "$2,850 per unit per month" });
  });
});

describe("number words, ordinal months and times (prose)", () => {
  const read = (line: string, f: DocumentFormat = US) => tokenize(line, f).map((t) => [t.raw, t.value, t.unit]);
  test("a number word is a number only when a unit word follows, including the hyphenated adjective", () => {
    expect(read("the lease-up lasts eighteen months")).toEqual([["eighteen months", 18, "months"]]);
    expect(read("followed by a three-month lease-up")).toEqual([["three-month", 3, "months"]]);
    expect(read("a twenty-four month build")).toEqual([["twenty-four month", 24, "months"]]);
    expect(read("la durée est de douze mois")).toEqual([["douze mois", 12, "months"]]);
    expect(read("a hold of five years")).toEqual([["five years", 5, "years"]]);
    expect(read("eight suites")).toEqual([["eight suites", 8, "units"]]);
  });
  test("negative: an item name, a bare number word and a compound number are not read", () => {
    expect(read("three-bedroom suites and a four-storey wing")).toEqual([]);
    expect(read("trois chambres")).toEqual([]);
    expect(read("a three storey building, five of them")).toEqual([]);
    expect(read("there are many months and years")).toEqual([]);
  });
  test("an ordinal month is a point in time in months", () => {
    expect(read("refinance in month 46")).toEqual([["46", 46, "months"]]);
    expect(read("au mois 26")).toEqual([["26", 26, "months"]]);
    expect(read("au 26e mois")).toEqual([["26e mois", 26, "months"]]);
    expect(read("12 months")).toEqual([["12 months", 12, "months"]]);
  });
  test("negative: a number after the plural, or after another word, is not an ordinal month", () => {
    expect(read("months 26")).toEqual([["26", 26, null]]);
    expect(read("in unit 26")).toEqual([["26", 26, null]]);
  });
  test("times and fois are a multiple", () => {
    expect(read("1.20 times")).toEqual([["1.20 times", 1.2, "x"]]);
    expect(read("1,15 fois", EU)).toEqual([["1,15 fois", 1.15, "x"]]);
    expect(read("a sometimes 3 timeshare")).toEqual([["3", 3, null]]);
  });
});

describe("units after a figure: per-year qualifiers and unit types", () => {
  const FR: DocumentFormat = { ...EU, spaceGroups: true };
  test("a rent per square foot per year is one token, in French and English", () => {
    expect(first("Loyer : 22,50 $/pi²/an", FR)).toMatchObject({ value: 22.5, unit: "$/sf", raw: "22,50 $/pi²/an" });
    expect(first("Rent: $24.00/sf/yr", US)).toMatchObject({ value: 24, unit: "$/sf", raw: "$24.00/sf/yr" });
    expect(first("Loyer : 1 200 $ par année", FR)).toMatchObject({ value: 1_200, unit: "$", raw: "1 200 $ par année" });
    expect(first("Loyer : 1 200 $/an", FR)).toMatchObject({ value: 1_200, unit: "$", raw: "1 200 $/an" });
  });
  test("a monthly rent may be written a month, each month or par mois", () => {
    expect(first("The rent is $1,640 a month", US)).toMatchObject({ value: 1_640, unit: "$/mo" });
    expect(first("Rent of $1,640 each month", US)).toMatchObject({ unit: "$/mo" });
    expect(first("Loyer de 1 880 $ par mois", FR)).toMatchObject({ value: 1_880, unit: "$/mo" });
  });
  test("a count before a unit-type word is a count, in words and in digits", () => {
    expect(tokenize("four studios and seven one-bedroom suites", US).map((t) => [t.value, t.unit])).toEqual([[4, "units"], [7, "units"]]);
    expect(tokenize("7 2-bed units", US).map((t) => [t.value, t.unit])).toEqual([[7, "units"]]);
    expect(tokenize("trois 4½ à 1 880 $ par mois", FR).map((t) => [t.value, t.unit])).toEqual([[3, "units"], [1_880, "$/mo"]]);
  });
  test("negative: an item name is not a count, and 4½ is not the number 4", () => {
    expect(tokenize("three-bedroom suites", US)).toEqual([]);
    expect(tokenize("a two-bedroom suite", US)).toEqual([]);
    expect(tokenize("Type 4½", FR)).toEqual([]);
  });
});

describe("a dash is a minus sign only when it is attached to the number", () => {
  const value = (line: string) => first(line, US).value;
  test("a dash that stands apart from the number, or opens a list item, is no sign", () => {
    expect(value("- 1.5 years to build")).toBe(1.5);
    expect(value("– 96% occupied at stabilization")).toBe(96);
    expect(value("• – 96% occupied")).toBe(96);
    expect(value("-- 18 months")).toBe(18);
    expect(value("Fee: – $450,000")).toBe(450_000);
    expect(value("  * - 12 months")).toBe(12);
  });
  test("negative: a number that really is negative keeps its sign", () => {
    expect(value("Variance -$12,500")).toBe(-12_500);
    expect(value("Change −3.5%")).toBe(-3.5);
    expect(value("Change -2% on rents")).toBe(-2);
    expect(value("Credits (25,000)")).toBe(-25_000);
    expect(value("(12,500)")).toBe(-12_500);
  });
  test("a parenthesised figure after text and a number is an aside, never a negative", () => {
    expect(tokenize("Fee: 4% of costs ($96,000)", US).map((t) => t.value)).toEqual([4, 96_000]);
    expect(tokenize("Trois lots à 160 000 $ chacun (480 000 $)", EU).map((t) => t.value)).toEqual([160_000, 480_000]);
    // negative: the same parentheses with no figure before them are a negative
    expect(tokenize("Other costs ($96,000)", US).map((t) => t.value)).toEqual([-96_000]);
  });
});

describe("a sign written in words is refused, never read either way", () => {
  test("minus and moins before a number leave it unread", () => {
    for (const line of ["revenue minus 2% vacancy", "rent growth: minus 2%", "moins 2 % sur les loyers", "Croissance : moins 2 %"]) {
      const t = first(line, US);
      expect(t.value, line).toBeNull();
      expect(t.refusal).toBe("A sign written in words; enter the figure by hand");
    }
  });
  test("negative: at least, give or take and an attached sign are as before", () => {
    expect(first("au moins 90 % occupé", US).value).toBe(90);
    expect(first("plus ou moins 2 %", US).value).toBe(2);
    expect(first("plus or minus 2%", US).value).toBe(2);
    expect(first("minus -2%", US).value).toBe(-2);
  });
});

describe("durations written as phrases", () => {
  const dur = (line: string, f: DocumentFormat = US) => tokenize(line, f).map((t) => [t.value, t.unit]);
  test("quarters and trimestres are three months each", () => {
    expect(dur("about five quarters")).toEqual([[15, "months"]]);
    expect(dur("deux trimestres", EU)).toEqual([[6, "months"]]);
    expect(dur("4 quarters")).toEqual([[12, "months"]]);
  });
  test("a year and a half, in both languages", () => {
    expect(dur("a year and a half")).toEqual([[1.5, "years"]]);
    expect(dur("one and a half years")).toEqual([[1.5, "years"]]);
    expect(dur("un an et demi", EU)).toEqual([[1.5, "years"]]);
    expect(dur("deux ans et demi", EU)).toEqual([[2.5, "years"]]);
    expect(dur("une année et demie", EU)).toEqual([[1.5, "years"]]);
  });
  test("a bare 'a year' is one year", () => {
    expect(dur("for a year")).toEqual([[1, "years"]]);
    expect(dur("un an", EU)).toEqual([[1, "years"]]);
  });
  test("negative: fractions, rates per year and 'once a year' are not durations", () => {
    expect(dur("three quarters of the units")).toEqual([]);
    expect(dur("trois quarts des logements", EU)).toEqual([]);
    expect(dur("rent is paid once a year")).toEqual([]);
    expect(dur("$96,000 a year")).toEqual([[96_000, "$"]]);
    expect(dur("a year ago")).toEqual([]);
    expect(dur("a unit and a half")).toEqual([]);
  });
});

describe("letter-spaced digits and figures after 'per' (task 47)", () => {
  test("a run of single digits is refused whole, never read in part or joined", () => {
    const tokens = tokenize("amount: $ 1 6 2 , 5 0 0 , 0 0 0", US);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.value).toBeNull();
    expect(tokens[0]!.refusal).toBe("Letter-spaced digits, as OCR leaves them; enter the figure");
    expect(tokenize("rate 5 . 2 5 %", US).map((t) => t.value)).toEqual([null]);
  });
  test("negative: space-grouped thousands and short digit pairs are not letter-spaced", () => {
    expect(first("Loan: 1 250 000 $", EU).value).toBe(1_250_000);
    expect(first("Common equity: $31 200 000", UNKNOWN).value).toBe(31_200_000);
    expect(tokenize("Floors 1 2", US).map((t) => t.value)).toEqual([1, 2]);
  });
  test("a figure directly after per, par, for every, pour chaque or a slash is a basis, not a value", () => {
    const t = tokenize("1.8 stalls per 1,000 SF", US);
    expect(t.map((x) => x.value)).toEqual([1.8, null]);
    expect(t[1]!.refusal).toMatch(/basis/);
    expect(tokenize("$85/1,000 sf", US).map((x) => x.value)).toEqual([85, null]);
    expect(tokenize("1 place par 100 pi²", EU).map((x) => x.value)).toEqual([1, null]);
    expect(tokenize("1 stall for every 4 units", US).map((x) => x.value)).toEqual([1, null]);
    expect(tokenize("1 place pour chaque 4 logements", EU).map((x) => x.value)).toEqual([1, null]);
  });
  test("negative: a rate per sf and a plain area keep their values", () => {
    expect(first("Rent: $24.50 per SF", US)).toMatchObject({ value: 24.5, unit: "$/sf" });
    expect(first("Rentable area: 12,000 SF", US)).toMatchObject({ value: 12_000, unit: "sf" });
    expect(first("Closing 2026/10/01", US).value).toBe(2026);
  });
});


describe("three-decimal rates and slashes after labels (Card 164)", () => {
  test.each([
    ["Exit cap rate 4.738%", UNKNOWN, [4.738]],
    ["Exit cap rate 4.738 %", UNKNOWN, [4.738]],
    ["Taux 4,738 %", UNKNOWN, [4.738]],
    ["DSCR 1.208x", UNKNOWN, [1.208]],
    ["Rate 5.375%", UNKNOWN, [5.375]],
    ["Rate 5.375%", US, [5.375]],
    ["Vacancy 1,250%", UNKNOWN, [1.25]],
    ["Land / $1,658,477", UNKNOWN, [1658477]],
    ["Land / $1,658,477", US, [1658477]],
    ["Hold / 12 years", UNKNOWN, [12]],
    ["Cost / 1,250 sf", UNKNOWN, [1250]],
    ["$12 / 1,000 sf", UNKNOWN, [12, null]],
    ["$2,500 per 1,000 sf", UNKNOWN, [2500, null]],
    ["2026/10", UNKNOWN, [2026, 10]],
    ["Rent $29.009/sf", UNKNOWN, [29009]],
    ["4,738 %", US, [null]],
    ["Taux 4,738 %", { ...EU, spaceGroups: true }, [4.738]],
    ["12 $ / 1 000 pi²", { ...EU, spaceGroups: true }, [12, null]],
    ["DSCR 1.208×", UNKNOWN, [1.208]],
    ["DSCR 1.208 times", UNKNOWN, [1.208]],
    ["DSCR 1,208 fois", UNKNOWN, [1.208]],
    ["12 sf / 1,000 sf", UNKNOWN, [12, null]],
  ] as const)("%s with format %j reads %j", (line, format, values) => {
    const tokens = tokenize(line, format);
    expect(tokens.map((t) => t.value)).toEqual(values);
    tokens.forEach((t, i) => {
      if (values[i] === null) expect(t.refusal).toMatch(line === "4,738 %" ? /different decimal separator/ : /basis of a ratio/);
      else expect(t.refusal).toBeUndefined();
    });
  });

  test("an x before another figure is a multiplication, not a multiple", () => {
    expect(tokenize("Rent 1,250 x 12", US).map((t) => t.value)).toEqual([1250, 12]);
    expect(tokenize("Rent 1,250 × $12", US).map((t) => t.value)).toEqual([1250, 12]);
    const unknown = tokenize("Rent 1,250 x 12", UNKNOWN);
    expect(unknown.map((t) => t.value)).toEqual([null, 12]);
    expect(unknown[0]!.refusal).toMatch(/does not say which/);
  });
});


describe("Card 166: compound duration words", () => {
  test.each([
    ["vingt et un mois", 21, "months"],
    ["trente et un mois", 31, "months"],
    ["quarante et un mois", 41, "months"],
    ["cinquante et un mois", 51, "months"],
    ["soixante et un mois", 61, "months"],
    ["twenty one months", 21, "months"],
    ["thirty six months", 36, "months"],
    ["twenty one years", 21, "years"],
    ["twenty one quarters", 63, "months"],
    ["vingt et un trimestres", 63, "months"],
    ["twenty-one months", 21, "months"],
    ["vingt-deux mois", 22, "months"],
    ["vingt et un ans", 21, "years"],
    ["vingt et une années", 21, "years"],
    ["vingt-et-un mois", 21, "months"],
    ["trente-et-un mois", 31, "months"],
    ["vingt-et-une années", 21, "years"],
    ["twenty one years and a half", 21.5, "years"],
    ["twenty one units", 21, "units"],
    ["twenty one studios", 21, "units"],
    ["vingt et un logements", 21, "units"],
  ] as const)("%s reads the complete compound", (text, value, unit) => {
    expect(tokenize(text, UNKNOWN).map(t => [t.raw, t.value, t.unit])).toEqual([[text, value, unit]]);
  });
  test.each(["soixante et onze mois", "soixante-et-onze mois", "quatre-vingts mois", "cent vingt mois", "one hundred twenty units", "one hundred twenty one units", "twenty one-month extensions", "thirty one-year terms"])("%s never reads the tail alone", text => {
    expect(tokenize(text, UNKNOWN)).toEqual([]);
  });
  test.each([
    ["twenty one-bedroom units", 20, "units"],
    ["twenty one bedroom units", 20, "units"],
    ["twenty two-bedroom units", 20, "units"],
    ["twenty one (21) months", 21, "months"],
    ["vingt et un (21) mois", 21, "months"],
  ] as const)("%s keeps its reading", (text, value, unit) => {
    expect(tokenize(text, UNKNOWN).map(t => [t.value, t.unit])).toEqual([[value, unit]]);
  });
});

describe("Card 166: dollars after a figure are currency", () => {
  test.each([
    ["500 dollars", UNKNOWN, 500, null],
    ["500 dollar", UNKNOWN, 500, null],
    ["500 DOLLARS", UNKNOWN, 500, null],
    ["3.226 million dollars", US, 3226000, null],
    ["3,2 millions de dollars", EU, 3200000, null],
    ["500 dollars US", UNKNOWN, 500, "USD"],
    ["500 dollars U.S.", UNKNOWN, 500, "USD"],
    ["500 dollars USD", UNKNOWN, 500, "USD"],
    ["2 million dollars américains", UNKNOWN, 2000000, "USD"],
    ["500 dollars U.S", UNKNOWN, 500, "USD"],
    ["500 dollars americains", UNKNOWN, 500, "USD"],
    ["3,2 millions de dollars US", EU, 3200000, "USD"],
    ["2,024 dollars", UNKNOWN, 2024, null],
    ["850 dollars", UNKNOWN, 850, null],
  ] as const)("%s names money and its currency", (text, format, value, currencyCode) => {
    expect(tokenize(text, format)).toEqual([expect.objectContaining({ value, unit: "$", currency: true, currencyCode })]);
  });
  test.each(["500 US dollars", "500 dollarsworth", "500 de dollars", "500 usd", "500 cad", "500 cadres"])("%s keeps its plain-number reading", text => {
    expect(tokenize(text, UNKNOWN)).toEqual([expect.objectContaining({ value: 500, unit: null, currency: false, currencyCode: null })]);
  });
  test("a lot number before cadastre is not money", () => {
    expect(tokenize("Lot 1 234 567 cadastre du Québec", UNKNOWN)).toEqual([expect.objectContaining({ value: 1234567, unit: null, currency: false, currencyCode: null })]);
  });
  test.each([["All figures in 2024 dollars", 2024], ["Costs (1999 dollars)", 1999]] as const)("a year before dollars in %s is not money", (text, value) => {
    expect(tokenize(text, UNKNOWN)).toEqual([expect.objectContaining({ value, unit: null, currency: false, currencyCode: null })]);
  });
  test("a footnote between a scale word and de dollars is not money", () => {
    expect(tokenize("571 millions 1 de dollars", UNKNOWN).map(t => [t.value, t.unit])).toEqual([[571, null], [1, null]]);
  });
});

describe("Card 166: bare scales still depend on cell context", () => {
  test.each([
    ["267.168K", false, 267.168, null],
    ["267.168K", true, 267168, "$"],
    ["185K", false, 185, null],
    ["185K", true, 185000, "$"],
  ] as const)("%s with cell=%s", (text, cell, value, unit) => {
    expect(tokenize(text, US, cell)).toEqual([expect.objectContaining({ value, unit })]);
  });
});


describe("Card 168: a range written in words is not a value", () => {
  test.each([
    ["Lease-up: seven to nine months", []],
    ["Lease-up: between seven and nine months", []],
    ["Lease-up: seven or eight months", []],
    ["Période de location : sept à neuf mois", []],
    ["Hold: five to seven years", []],
    ["Construction: eighteen to twenty-four months", []],
    ["Units: seven to nine units", []],
    ["Lease-up: seven-to-nine months", []],
    ["Lease-up: 7 to 9 months", [[7, null], [9, "months"]]],
    ["Lease-up: 7 to nine months", [[7, null], [9, "months"]]],
    ["Lease-up: nine months", [[9, "months"]]],
    ["Lease-up: twelve (12) months", [[12, "months"]]],
    ["Hold: one and a half years", [[1.5, "years"]]],
    ["Term: two years and lease-up nine months", [[2, "years"], [9, "months"]]],
    ["Lease-up: seven months, then nine months of stabilization", [[7, "months"], [9, "months"]]],
    ["entre sept et neuf mois", []],
    ["vingt et un mois", [[21, "months"]]],
    ["Term: two years and nine months", [[2, "years"], [9, "months"]]],
    ["Durée : deux ans et six mois", [[2, "years"], [6, "months"]]],
    ["Lease-up: seven months to nine months", [[7, "months"], [9, "months"]]],
    ["one hundred and five units", []],
    ["a year and a half", [[1.5, "years"]]],
    ["from twenty-four to thirty months", []],
    ["de vingt et un à trente mois", []],
    ["seven - nine months", []],
    ["seven – nine months", []],
    ["seven — nine months", []],
    ["sept ou neuf mois", []],
    ["Durée : un an et six mois", [[1, "years"], [6, "months"]]],
    ["un an ou deux ans", [[1, "years"], [2, "years"]]],
  ] as const)("%s keeps only definite values", (text, expected) => {
    expect(tokenize(text, UNKNOWN).map(t => [t.value, t.unit])).toEqual(expected);
  });
});
