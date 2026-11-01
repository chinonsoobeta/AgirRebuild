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
