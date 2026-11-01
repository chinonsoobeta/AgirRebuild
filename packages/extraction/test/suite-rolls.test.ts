import { describe, expect, test } from "vitest";
import { checkArithmetic, consolidate, extractCandidates, parseDocument, type SourcedCandidate } from "../src/index.ts";

// Card 193: a suite-by-suite rent roll written as plain lines. Every fixture is invented.
const PROSE = "The owner of this invented walk-up has kept the building in steady repair for many years, and the roof, the boilers and the corridors were all looked after by the same small firm. The neighbourhood is quiet, with shops and a school within an easy walk, and the transit line runs along the main road at the end of the block. This note sets out the state of the property as the owner understands it today, for readers who have not yet visited the site in person.";
const PROSE_FR = "Le propriétaire de cet immeuble inventé en assure l'entretien depuis de nombreuses années, et la toiture, les chaudières et les corridors ont toujours été suivis par la même petite entreprise. Le quartier est tranquille, avec des commerces et une école à distance de marche, et la ligne de transport passe sur la grande rue au bout de l'îlot. Cette note décrit l'état de la propriété tel que le propriétaire le comprend aujourd'hui, pour les lecteurs qui n'ont pas encore visité les lieux en personne.";
const SUITE_RULE = "table:rent-roll-suite";
const SUITE_NOTE = "A suite's line in a rent roll; its other figures are shown, not read";
const DIFFERENT = "Suites of this type rent at different amounts; enter the rent to use";
const SUMMARY = "A rent roll's summary row is not an assumption";

const read = async (...lines: string[]) => extractCandidates(await parseDocument(new TextEncoder().encode([PROSE, "", ...lines].join("\n")), "roll.txt"));
const readFr = async (...lines: string[]) => extractCandidates(await parseDocument(new TextEncoder().encode([PROSE_FR, "", ...lines].join("\n")), "roll.txt"));
type R = Awaited<ReturnType<typeof read>>;
const counts = (r: R) => r.candidates.filter((c) => c.fieldKey === "unit_count").map((c) => [c.itemKey, c.value, c.rule]);
const rents = (r: R) => r.candidates.filter((c) => c.fieldKey === "unit_rent_monthly").map((c) => [c.itemKey, c.value]);
const shown = (r: R, note: string) => r.other.filter((o) => o.note === note).map((o) => o.value);
const pin = (r: R) => r.candidates.map((c) => [c.fieldKey, c.itemKey, c.value, c.rule]);

describe("card 193: a suite-by-suite roll written as plain lines", () => {
  test("1. one rent column, $ amounts, a total row: counts by type, each differing rent shown", async () => {
    const r = await read(
      "Suite # Type Rent Deposit Lease start Lease end Tenant Parking Storage Notes",
      "101 1 bedroom $1,410 $700 03/15/2021",
      "102 1 bedroom $1,425 $700 05/01/2022",
      "103 2 bedroom $1,890 $900 06/01/2019",
      "201 2 bedroom $1,905 $900 08/01/2020",
      "202 Bachelor $1,050 $500 09/01/2023",
      "Total $7,680 $3,700",
    );
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 2, SUITE_RULE], ["Bachelor", 1, SUITE_RULE]]);
    const suiteNumbers = [101, 102, 103, 201, 202];
    expect(r.candidates.filter((c) => suiteNumbers.includes(c.value!))).toEqual([]);
    expect(shown(r, DIFFERENT).sort()).toEqual([1410, 1425, 1890, 1905].sort());
    expect(rents(r)).toEqual([["Bachelor", 1050]]);
    expect(shown(r, SUITE_NOTE)).toEqual(expect.arrayContaining([700, 900, 500]));
    expect(shown(r, SUMMARY)).toEqual([7680, 3700]);
    expect(r.other.find((o) => o.value === 700)).toMatchObject({ rule: "line:suite-row", fieldKey: null, itemKey: null });
  });

  test("2. every suite of a type at one rent: the rent is a candidate", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800", "104 2 bedroom $1,800", "Total $6,400");
    expect(rents(r)).toEqual([["1BR", 1400], ["2BR", 1800]]);
    expect(r.candidates.find((c) => c.fieldKey === "unit_rent_monthly")?.rule).toBe(SUITE_RULE);
  });

  test("3. two rent columns in a three-line wrapped header: counts right, no rent read", async () => {
    const r = await read("In place Proposed", "Suite # Type Rent Rent", "(per month) (per month)", "101 1 bedroom $1,300 $1,450", "102 1 bedroom $1,320 $1,450", "103 2 bedroom $1,700 $1,900", "Total $4,320 $4,800");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
    expect(shown(r, SUITE_NOTE)).toEqual([1300, 1450, 1320, 1450, 1700, 1900]);
  });

  test("4. no currency mark on the rows, a total row with a matching $ sum: rents as in test 1", async () => {
    const r = await read("Suite # Type Rent Area", "101 1 bedroom 1410 610", "102 1 bedroom 1425 615", "103 2 bedroom 1890 820", "Total $4,725");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(shown(r, DIFFERENT)).toEqual([1410, 1425]);
    expect(rents(r)).toEqual([["2BR", 1890]]);
    expect(shown(r, SUITE_NOTE)).toEqual([610, 615, 820]);
  });

  test("5. the same with a sum that does not match: no rent read", async () => {
    const r = await read("Suite # Type Rent Area", "101 1 bedroom 1410 610", "102 1 bedroom 1425 615", "103 2 bedroom 1890 820", "Total $5,000");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
    expect(shown(r, DIFFERENT)).toEqual([]);
    expect(shown(r, SUITE_NOTE)).toEqual([1410, 610, 1425, 615, 1890, 820]);
  });

  test("6. no total row, rows with no currency mark: no rent read", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom 1410", "102 1 bedroom 1425", "103 2 bedroom 1890");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
    expect(shown(r, SUITE_NOTE)).toEqual([1410, 1425, 1890]);
  });

  test("7. no total row, rows with $: rents read", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,410", "102 1 bedroom $1,425", "103 2 bedroom $1,890");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(shown(r, DIFFERENT)).toEqual([1410, 1425]);
    expect(rents(r)).toEqual([["2BR", 1890]]);
  });

  test("8. marks and a status: each counted once, under the right type", async () => {
    const r = await read("Suite # Type Rent", "5* 1 bedroom $1,200", "* 0 2 bedroom $1,700", "** 111 1 bedroom $1,200", "204 (vacant) Studio", "205 Studio $950");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE], ["Studio", 2, SUITE_RULE]]);
    expect(r.candidates.filter((c) => c.value === 111 || c.value === 204 || c.value === 5)).toEqual([]);
  });

  test("9. a roll over a page, with a footer and a repeated header in the middle: all suites counted", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "Prepared by the owner's office", "Suite # Type Rent", "103 2 bedroom $1,800", "104 1 bedroom $1,400", "Total $6,000");
    expect(counts(r)).toEqual([["1BR", 3, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([["1BR", 1400], ["2BR", 1800]]);
  });

  test("10. a total row with no word Total ends the run; the line after it is read as today", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,410", "103 2 bedroom $1,800", "3 suites $4,610", "Land cost: $1,800,000");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(shown(r, SUMMARY)).toEqual([3, 4610]);
    const plain = await read("Land cost: $1,800,000");
    expect(pin(r).filter(([f]) => f !== "unit_count" && f !== "unit_rent_monthly")).toEqual(pin(plain));
    expect(pin(plain).length).toBeGreaterThan(0);
  });

  test("11. the printed total differs from the suites counted: the note names both numbers", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,410", "103 2 bedroom $1,800", "Total 13 suites $4,610");
    const note = "The roll states 13 units but 3 suites were counted; check the counts by type";
    expect(shown(r, note)).toEqual([13]);
    expect(shown(r, SUMMARY)).toEqual([4610]);
    const agrees = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,410", "103 2 bedroom $1,800", "Total 3 suites $4,610");
    expect(shown(agrees, SUMMARY)).toEqual([3, 4610]);
  });

  test("12. a count-first summary under Units Type Rent: as on the base commit", async () => {
    const r = await read("Units Type Rent", "12 1 bedroom $1,500", "8 2 bedroom $1,900", "4 Studio $1,100");
    expect(pin(r)).toEqual(PIN12);
  });

  test("13. a headerless count-first list with no repeated type: as on the base commit", async () => {
    const r = await read("12 1 bedroom $1,500", "18 2 bedroom $1,900", "24 3 bedroom $2,300");
    expect(pin(r)).toEqual(PIN13);
  });

  test("14. a headerless list with a repeated type whose first numbers do not climb: as on the base commit", async () => {
    const r = await read("12 1 bedroom $1,500", "8 1 bedroom $1,600", "4 2 bedroom $1,900");
    expect(pin(r)).toEqual(PIN14);
  });

  test("15. a summary by type elsewhere in the document: the per-suite roll gives way", async () => {
    const r = await read("Type Units Rent", "1 bedroom 2 $1,400", "2 bedroom 1 $1,800", "", "Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800", "Total $4,600");
    expect(r.candidates.filter((c) => c.rule === SUITE_RULE)).toEqual([]);
    expect(counts(r)).toEqual([["1BR", 2, "table:rent-roll"], ["2BR", 1, "table:rent-roll"]]);
    expect(shown(r, "This document gives a summary by type; the per-suite roll is not read")).toEqual(expect.arrayContaining([2, 1]));
  });

  test("16. a headerless run with a repeated type and rising ids: counted, no rent", async () => {
    const r = await read("101 1 bedroom $1,400", "102 1 bedroom $1,410", "103 2 bedroom $1,800");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
    expect(shown(r, SUITE_NOTE)).toEqual([1400, 1410, 1800]);
  });

  test("17. Unit Type Rent as one header: counted by the headerless rule, no rent", async () => {
    const r = await read("Unit Type Rent", "101 1 bedroom $1,500", "102 1 bedroom $1,500", "103 2 bedroom $1,900");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
  });

  test("18. an unknown type inside a run: not counted, figures shown, and the total note says so", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 2 bdrm $1,650", "103 1 bedroom $1,400", "901 Penthouse $3,200", "Total 4 suites $7,650");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE]]);
    expect(shown(r, SUITE_NOTE)).toEqual(expect.arrayContaining([1650, 3200]));
    expect(shown(r, "The roll states 4 units but 2 suites were counted; check the counts by type")).toEqual([4]);
    expect(r.candidates.filter((c) => [102, 901, 2].includes(c.value!) && c.itemKey !== "1BR")).toEqual([]);
  });

  test("19. a French roll: Logement # Type Loyer, 1 chambre, 1 250 $, and 3 1/2 read as 3½", async () => {
    const r = await readFr("Logement # Type Loyer", "101 1 chambre 1 250 $", "102 1 chambre 1 250 $", "103 3 1/2 1 450 $", "104 3 1/2 1 450 $", "Total 5 400 $");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["3½", 2, SUITE_RULE]]);
    expect(rents(r)).toEqual([["1BR", 1250], ["3½", 1450]]);
    // "Logement" right before "Type" names the type column, as "Unit Type" does: the headerless rule counts the suites and reads no rent.
    const typeColumn = await readFr("Logement Type Loyer", "101 1 chambre 1 250 $", "102 1 chambre 1 250 $", "103 3 1/2 1 450 $", "Total 3 950 $");
    expect(counts(typeColumn)).toEqual([["1BR", 2, SUITE_RULE], ["3½", 1, SUITE_RULE]]);
    expect(rents(typeColumn)).toEqual([]);
  });

  test("20. Studio and Bachelor stay separate", async () => {
    const r = await read("Suite # Type Rent", "101 Studio $1,000", "102 Bachelor $950", "103 Studio $1,000", "Total $2,950");
    expect(counts(r)).toEqual([["Studio", 2, SUITE_RULE], ["Bachelor", 1, SUITE_RULE]]);
  });

  test("21. 1 bedroom + den is its own item", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom + den $1,600", "103 1 bedroom $1,400", "Total $4,400");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["1BR + den", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([["1BR", 1400], ["1BR + den", 1600]]);
  });

  test("22. a roll under a heading that marks the section as not part of the deal: not read, lines stay excluded", async () => {
    const withHeader = await read("Not part of this deal", "Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800", "Total $4,600");
    expect(withHeader.candidates.filter((c) => c.fieldKey === "unit_count" || c.fieldKey === "unit_rent_monthly")).toEqual([]);
    const typeColumn = await read("Not part of this deal", "Unit Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800");
    expect(typeColumn.candidates.filter((c) => c.fieldKey === "unit_count" || c.fieldKey === "unit_rent_monthly")).toEqual([]);
    const noHeader = await read("Not part of this deal", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800");
    expect(noHeader.candidates.filter((c) => c.fieldKey === "unit_count" || c.fieldKey === "unit_rent_monthly")).toEqual([]);
    expect(noHeader.other.some((o) => o.note === "Marked as not part of this deal")).toBe(true);
  });

  test("23. a pipe roll with blank rents: right counts and no line:mix-count candidate", async () => {
    const r = await read("Suite | Type | Rent |", "101 | 1 bedroom | |", "102 | 1 bedroom | |", "103 | 2 bedroom | |");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(r.candidates.filter((c) => c.rule === "line:mix-count")).toEqual([]);
    const scan = await read("Suite Type Rent", "101 | 1 bedroom |", "102 | 1 bedroom |", "103 | 2 bedroom |");
    expect(counts(scan)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(scan.candidates.filter((c) => c.rule === "line:mix-count")).toEqual([]);
    // With no rent column the existing path does not take the rows: this card's pass does, and the prose list reader leaves them alone.
    const noRent = await read("Suite Type", "101 | 1 bedroom |", "102 | 1 bedroom |", "103 | 2 bedroom |");
    expect(counts(noRent)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(noRent.candidates.filter((c) => c.rule === "line:mix-count")).toEqual([]);
  });

  test("24. prose sentences about types: as on the base commit", async () => {
    const r = await read("Two of the suites are 1 bedroom units.", "2 1 bedroom units are vacant.");
    expect(pin(r)).toEqual(PIN24);
  });

  test("25. the counts by type check against a whole-building count", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800", "Total $4,600");
    const sourced = (value: number): SourcedCandidate[] => [
      ...r.candidates.map((c) => ({ ...c, documentId: "roll", documentName: "roll.txt" })),
      { fieldKey: "unit_count", itemKey: null, value, raw: String(value), unitSeen: "units", location: "line 1", context: "Invented building", rule: "test", documentId: "memo", documentName: "memo.txt" },
    ];
    const whole = (value: number) => checkArithmetic(consolidate(sourced(value))).find((p) => p.fieldKey === "unit_count" && p.itemKey === null)?.check;
    expect(whole(3)).toMatchObject({ outcome: "confirms" });
    expect(whole(3)?.note).toMatch(/^Checked/);
    expect(whole(5)).toMatchObject({ outcome: "questions" });
    expect(whole(5)?.note).toMatch(/^Please check/);
  });

  test("a line after the last suite that starts with a number is not taken as a suite", async () => {
    const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "500 parking stalls at $4,000");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE]]);
    expect(shown(r, SUITE_NOTE)).toEqual([]);
  });

  describe("audit of card 193", () => {
    const rentValues = (r: R) => r.candidates.filter((c) => c.fieldKey === "unit_rent_monthly").map((c) => c.value);

    test("A1. a rent beside a plain number keeps all its digits", async () => {
      const r = await read("Suite # Type Rent ($) Size (SF)", "1 1 bedroom 950 526", "2 1 bedroom 950 530", "3 2 bedroom 1200 700", "Total 3 suites $3,100 1,756");
      expect(rents(r)).toEqual([["1BR", 950], ["2BR", 1200]]);
      const same = await read("Suite # Type Rent ($) Total rent ($)", "1 1 bedroom 940 940", "2 1 bedroom 940 940", "3 2 bedroom 1200 1200", "Total 3 suites $3,080 $3,080");
      expect(rents(same)).toEqual([["1BR", 940], ["2BR", 1200]]);
    });

    test("A2. a size column before the rent, with its own total: no rent read", async () => {
      const r = await read("Suite # Type Size (SF) Rent ($)", "101 1 bedroom 800 1200", "102 1 bedroom 800 1350", "103 2 bedroom 900 1500", "Total 3 units 2500 4050");
      expect(rentValues(r)).toEqual([]);
      expect(shown(r, DIFFERENT)).toEqual([]);
      expect(shown(r, SUITE_NOTE)).toEqual([800, 1200, 800, 1350, 900, 1500]);
    });

    test("A2. a deposit column before the rent, with or without a total row: no rent read", async () => {
      const rows = ["101 1 bedroom $600 $1,200", "102 1 bedroom $600 $1,350", "103 2 bedroom $800 $1,500"];
      for (const r of [await read("Suite # Type Deposit ($) Rent ($)", ...rows, "Total 3 units $2,000 $4,050"), await read("Suite # Type Deposit ($) Rent ($)", ...rows)]) {
        expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
        expect(rentValues(r)).toEqual([]);
        expect(shown(r, DIFFERENT)).toEqual([]);
        expect(shown(r, SUITE_NOTE)).toEqual([600, 1200, 600, 1350, 800, 1500]);
      }
    });

    test("A2. a plain rent before a $ deposit is not read as the deposit", async () => {
      const r = await read("Suite # Type Rent Deposit", "101 1 bedroom 1200 $600", "102 1 bedroom 1350 $600", "103 2 bedroom 1500 $800");
      expect(rentValues(r)).toEqual([]);
      expect(shown(r, DIFFERENT)).toEqual([]);
      expect(shown(r, SUITE_NOTE)).toEqual([1200, 600, 1350, 600, 1500, 800]);
    });

    test("A2. the rent word only on a wrapped line: the order of the columns is unknown, no rent read", async () => {
      const r = await read("Suite # Type Deposit", "Rent", "101 1 bedroom $1,200 $600", "102 1 bedroom $1,200 $600", "103 2 bedroom $1,500 $800");
      expect(rentValues(r)).toEqual([]);
      expect(shown(r, SUITE_NOTE)).toEqual([1200, 600, 1200, 600, 1500, 800]);
    });

    test("A2. a French size column before the rent in plain mode: no rent read", async () => {
      const r = await readFr("Logement # Type Superficie Loyer", "101 1 chambre 600 1250", "102 1 chambre 610 1250", "103 2 chambres 800 1500", "Total 2010 4000");
      expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
      expect(rentValues(r)).toEqual([]);
    });

    test("A2. a number column before a $ rent still reads the rent", async () => {
      const size = await read("Suite # Type Est. Size (SF) Rent ($) Rent/SF ($)", "1 2 bedroom 940 $2,391 2.54", "2 2 bedroom 940 $2,391 2.54", "3 1 bedroom 700 $1,800 2.57");
      expect(rents(size)).toEqual([["2BR", 2391], ["1BR", 1800]]);
      const bath = await read("Suite # Suite type Bathroom Rent ($) Parking ($)", "101 2 bedroom 2 828 $2,381 $50", "102 2 bedroom 2 828 $2,381 $50", "103 1 bedroom 1 610 $1,700 $50");
      expect(rents(bath)).toEqual([["2BR", 2381], ["1BR", 1700]]);
      const half = await read("Suite # Type Bath Rent ($) Deposit ($)", "2125 3 bedroom 1.5 $2,240 $837.50", "2126 3 bedroom 1.5 $2,240 $837.50", "2127 2 bedroom 1 $1,900 $700");
      expect(rents(half)).toEqual([["3BR", 2240], ["2BR", 1900]]);
      expect(shown(half, SUITE_NOTE)).toEqual(expect.arrayContaining([1.5, 837.5]));
    });

    test("A3. a line that is not the roll's total keeps its reading", async () => {
      const rows = ["Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,400", "103 2 bedroom $1,800"];
      const r = await read(...rows, "Total operating expenses $200,000");
      expect(r.candidates.find((c) => c.value === 200000)).toMatchObject({ fieldKey: "fixed_opex_annual", rule: "line:prose" });
      expect(shown(r, SUMMARY)).toEqual([]);
      const line = "All suites are rented at $1,300 on average.";
      const all = await read(...rows, line);
      expect(shown(all, SUMMARY)).toEqual([]);
      expect(all.other.filter((o) => o.value === 1300 && o.rule === "line:suite-row")).toEqual([]);
      const alone = await read(line);
      expect(pin(all).filter((c) => c[2] === 1300)).toEqual(pin(alone).filter((c) => c[2] === 1300));
      expect(all.other.filter((o) => o.value === 1300).map((o) => [o.rule, o.note])).toEqual(alone.other.filter((o) => o.value === 1300).map((o) => [o.rule, o.note]));
    });

    test.each([
      ["Total", []],
      ["Total 3 units $4,050", [3, 4050]],
      ["Total $4,050", [4050]],
      ["Total monthly rent $4,050", [4050]],
      ["Total units 3", [3]],
      ["TOTAL: $4,050", [4050]],
      ["Sub-total $4,050", [4050]],
      ["35 suites $38,946", null],
    ])("A3. %s is a total row", async (line, values) => {
      const r = await read("Suite # Type Rent", "101 1 bedroom $1,400", "102 1 bedroom $1,250", "103 2 bedroom $1,400", line);
      expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
      if (values) expect(shown(r, SUMMARY)).toEqual(values);
      else expect(shown(r, "The roll states 35 units but 3 suites were counted; check the counts by type")).toEqual([35]);
      expect(r.candidates.filter((c) => c.context.includes(line) && line !== "Total")).toEqual([]);
    });

    test("A3. a French total row with a count is a total row", async () => {
      const r = await readFr("Logement # Type Loyer", "101 1 chambre 1 250 $", "102 1 chambre 1 300 $", "103 2 chambres 1 500 $", "Total 3 logements 4 050 $");
      expect(shown(r, SUMMARY)).toEqual([3, 4050]);
      expect(shown(r, DIFFERENT)).toEqual([1250, 1300]);
    });

    test.each([
      ["Suite Type Rent Deposit Lease start", ["101 1 bedroom $1,410 $700 03/15/2021", "102 1 bedroom $1,425 $700 05/01/2022", "103 2 bedroom $1,890 $900 06/01/2019"]],
      ["Unit Type Rent Deposit Move-in", ["101 1BR $1,410 $700 2021-03-15", "102 1BR $1,425 $700 2022-05-01", "103 2BR $1,890 $900 2019-06-01"]],
      ["Suite Type Rent Deposit Lease start", ["101 1 bedroom $1,410 $700 March 1, 2021", "102 1 bedroom $1,425 $700 May 1, 2022", "103 2 bedroom $1,890 $900 June 1, 2019"]],
    ])("A4. a date column at the end of a suite's line under %s is no rent", async (header, rows) => {
      const r = await read(header, ...rows);
      expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
      expect(rentValues(r)).toEqual([]);
      expect(r.candidates.filter((c) => c.itemKey?.includes("$"))).toEqual([]);
    });

    // A plain number carries no $ to tell a rent from a size, and any column adds up to its own total.
    test.each([
      ["Square Feet", [800, 850, 900]],
      ["Living Space", [800, 850, 900]],
      ["Code", [44, 55, 66]],
    ])("B1. a %s column before a plain rent, with its own total: no rent read", async (name, first) => {
      const sum = first.reduce((n, x) => n + x, 0);
      const r = await read(`Suite # Type ${name} Rent`, `101 1 bedroom ${first[0]} 1200`, `102 1 bedroom ${first[1]} 1250`, `103 2 bedroom ${first[2]} 1500`, `Total 3 units ${sum} 3950`);
      expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
      expect(rentValues(r)).toEqual([]);
      expect(shown(r, DIFFERENT)).toEqual([]);
      expect(shown(r, SUITE_NOTE)).toEqual(expect.arrayContaining([...first, 1200, 1250, 1500]));
    });

    test("B1. Square Feet before a $ rent still reads the rent", async () => {
      const r = await read("Suite # Type Square Feet Rent ($)", "101 1 bedroom 800 $1,200", "102 1 bedroom 850 $1,250", "103 2 bedroom 900 $1,500", "Total 3 units 2550 $3,950");
      expect(rents(r)).toEqual([["2BR", 1500]]);
      expect(shown(r, DIFFERENT)).toEqual([1200, 1250]);
    });

    test.each([
      ["Suite # Type Rent"],
      ["Suite # Type Monthly Rent"],
      ["Unit # Unit Type Current Rent"],
      ["Suite # Type Tenant Rent"],
      ["Suite # Type Status Rent"],
      ["Suite # Type Location & Description Rent ($)"],
    ])("B1. %s: words that hold no figures leave a plain rent read", async (header) => {
      const r = await read(header, "101 1 bedroom 1200", "102 1 bedroom 1250", "103 2 bedroom 1500", "Total 3 units 3950");
      expect(rents(r)).toEqual([["2BR", 1500]]);
      expect(shown(r, DIFFERENT)).toEqual([1200, 1250]);
    });

    test.each([["Total des loyers 3 950 $"], ["Total du loyer 3 950 $"], ["Total mensuel des loyers 3 950 $"]])("B2. %s is a French roll's total row", async (line) => {
      const r = await readFr("Logement # Type Loyer", "101 1 chambre 1 200 $", "102 1 chambre 1 250 $", "103 2 chambres 1 500 $", line);
      expect(shown(r, SUMMARY)).toEqual([3950]);
      expect(rents(r)).toEqual([["2BR", 1500]]);
      expect(shown(r, DIFFERENT)).toEqual([1200, 1250]);
    });

    test("B3. a total of something else that opens with a number keeps its reading", async () => {
      const r = await read("Suite # Type Rent", "101 1 bedroom $1,200", "102 1 bedroom $1,250", "103 2 bedroom $1,500", "Total 2024 operating expenses $200,000");
      expect(r.candidates.find((c) => c.value === 200000)).toMatchObject({ fieldKey: "fixed_opex_annual", rule: "line:prose" });
      expect(shown(r, SUMMARY)).toEqual([]);
      expect(rents(r)).toEqual([["2BR", 1500]]);
    });

    test.each([
      ["Total 5,463 $3,950", [null, 3950]],
      ["Total 5,463 sf $3,950", [5463, 3950]],
      ["Total 3 apartments $3,950", [3, 3950]],
      ["Total 3950", [3950]],
    ])("B3. %s stays a total row", async (line, values) => {
      const r = await read("Suite # Type Rent", "101 1 bedroom $1,200", "102 1 bedroom $1,250", "103 2 bedroom $1,500", line);
      expect(shown(r, SUMMARY)).toEqual(values);
      expect(rents(r)).toEqual([["2BR", 1500]]);
    });

    test("B4. a plain figure under $100 is no rent, even when the total happens to agree", async () => {
      // "1 200 $" in an English document splits in two, and the three 1s add up to the 3 of "3 950 $".
      const r = await read("Logement # Type Loyer Superficie", "101 1 chambre 1 200 $ 55", "102 1 chambre 1 250 $ 60", "103 2 chambres 1 500 $ 80", "Total 3 logements 3 950 $ 195");
      expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
      expect(rentValues(r)).toEqual([]);
      expect(shown(r, DIFFERENT)).toEqual([]);
      const fr = await readFr("Logement # Type Loyer Superficie", "101 1 chambre 1 200 $ 55", "102 1 chambre 1 250 $ 60", "103 2 chambres 1 500 $ 80", "Total 3 logements 3 950 $ 195");
      // A $ before a plain number is taken as that number's, so this layout reads no rent in French either; its figures stay shown.
      expect(rentValues(fr)).toEqual([]);
      expect(shown(fr, SUITE_NOTE)).toEqual(expect.arrayContaining([55, 60, 80]));
    });

    test("A4. a real summary by type stays read by the table path", async () => {
      const r = await read("Type Units Rent", "1 bedroom 12 $1,410", "2 bedroom 8 $1,800", "Total 20");
      expect(pin(r)).toEqual([["unit_count", "1BR", 12, "table:rent-roll"], ["unit_rent_monthly", "1BR", 1410, "table:rent-roll"], ["unit_count", "2BR", 8, "table:rent-roll"], ["unit_rent_monthly", "2BR", 1800, "table:rent-roll"]]);
      const bachelor = await read("Type Units Rent", "Bachelor 12 $1,000", "1 bedroom 8 $1,400");
      expect(pin(bachelor)).toEqual([["unit_count", "Bachelor", 12, "table:rent-roll"], ["unit_rent_monthly", "Bachelor", 1000, "table:rent-roll"], ["unit_count", "1BR", 8, "table:rent-roll"], ["unit_rent_monthly", "1BR", 1400, "table:rent-roll"]]);
    });
  });

  test("a roll stating yearly rents reads none of them as monthly", async () => {
    const r = await read("Suite # Type Annual Rent", "101 1 bedroom $16,800", "102 1 bedroom $16,800", "103 2 bedroom $21,600", "Total $55,200");
    expect(counts(r)).toEqual([["1BR", 2, SUITE_RULE], ["2BR", 1, SUITE_RULE]]);
    expect(rents(r)).toEqual([]);
    expect(shown(r, SUITE_NOTE)).toEqual([16800, 16800, 21600]);
  });
});

// Read on the base commit (249cf51) and pinned: this card leaves a count-first list where it was.
const PIN12: unknown[] = [["unit_count", "1BR", 12, "line:prose"], ["unit_count", "2BR", 8, "line:prose"], ["unit_count", "Studio", 4, "line:prose"]];
const PIN13: unknown[] = [["unit_count", "1BR", 12, "line:prose"], ["unit_count", "2BR", 18, "line:prose"], ["unit_count", "3BR", 24, "line:prose"]];
const PIN14: unknown[] = [["unit_count", "1BR", 12, "line:prose"], ["unit_count", "1BR", 8, "line:prose"], ["unit_count", "2BR", 4, "line:prose"]];
const PIN24: unknown[] = [["unit_count", "1BR", 1, "line:prose"], ["unit_count", "1BR", 2, "line:prose"]];

describe("card 193: a roll's total row beside its types", () => {
  const rule = (fieldKey: string, itemKey: string, value: number) => ({ fieldKey, itemKey, value, location: "page 1, line 20", raw: String(value), unitSeen: null, context: "", rule: "line:prose", note: null, documentId: "b", documentName: "b.pdf" }) as unknown as SourcedCandidate;
  const rows = (cs: SourcedCandidate[]) => consolidate(cs, "CAD").map(p => [p.fieldKey, p.itemKey, p.value]);
  const types = [rule("unit_count", "1BR", 7), rule("unit_count", "Bachelor", 14)];

  test("a total that adds up is not a third type, even when the total row also states its area", () => {
    expect(rows([...types, rule("unit_count", "all units", 21), rule("rentable_area_sf", "all units", 9945)])).toEqual([
      ["rentable_area_sf", "all units", 9945], ["unit_count", "1BR", 7], ["unit_count", "Bachelor", 14],
    ]);
    expect(rows([...types, rule("unit_count", "all suites", 21), rule("rentable_area_sf", "all suites", 9945)])).toEqual([
      ["rentable_area_sf", "all suites", 9945], ["unit_count", "1BR", 7], ["unit_count", "Bachelor", 14],
    ]);
  });
  test("a French total row is treated the same", () => {
    expect(rows([...types, rule("unit_count", "Tous les logements", 21), rule("rentable_area_sf", "Tous les logements", 9945)])).toEqual([
      ["rentable_area_sf", "Tous les logements", 9945], ["unit_count", "1BR", 7], ["unit_count", "Bachelor", 14],
    ]);
  });
  test("a name that does not say it is everything keeps its count when it has an area, as card 126 set", () => {
    expect(rows([...types, rule("unit_count", "Residential", 21), rule("rentable_area_sf", "Residential", 9945)])).toContainEqual(["unit_count", "Residential", 21]);
  });
  test("a name holding a count that does not add up, or a rent, stays for a person", () => {
    expect(rows([...types, rule("unit_count", "all units", 30), rule("rentable_area_sf", "all units", 9945)])).toContainEqual(["unit_count", "all units", 30]);
    expect(rows([...types, rule("unit_count", "all units", 21), rule("unit_rent_monthly", "all units", 1500)])).toContainEqual(["unit_count", "all units", 21]);
  });
});
