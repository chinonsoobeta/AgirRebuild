import { describe, expect, test } from "vitest";
import { documentKind, extractCandidates, parseDocument, type NormalizedDocument } from "../src/index.ts";

// Card 190: what each paper is called, and which two kinds of report are set aside. Every fixture is invented.
const doc = (...lines: string[]): NormalizedDocument => ({
  kind: "txt",
  lines: lines.map((text, i) => ({ text, location: `line ${i + 1}` })),
  tables: [],
  pageCount: null,
  needsOcr: false,
  fullText: lines.join("\n"),
});
const parsed = (...lines: string[]) => parseDocument(new TextEncoder().encode(lines.join("\n")), "paper.txt");

const filler = Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1} explains the purpose and background of this paper in ordinary words.`);
const soil = Array.from({ length: 12 }, (_, i) => `Borehole BH-${i + 1} met dense till over bedrock, and the bearing capacity at this depth is adequate.`);
const sols = Array.from({ length: 12 }, (_, i) => `Le forage F-${i + 1} a atteint le roc, et la capacité portante à cette profondeur est suffisante.`);
const site = Array.from({ length: 12 }, (_, i) => `Area ${i + 1} shows petroleum in the groundwater, so contamination and remediation are discussed here.`);
const terrain = Array.from({ length: 12 }, (_, i) => `La zone ${i + 1} présente des hydrocarbures dans les eaux souterraines, et la réhabilitation des sols est décrite.`);
const padding = ["Prepared for the owner", "Project number 2041", "March 2024", "Prepared by the consultant", "Limitations of this work", "Scope of this work", "Field program", "Summary of findings", "Regional setting"];
const brochure = (...extra: string[]) => ["FOR SALE", "Maple Court", "Exclusive listing with the advisors named below", ...extra, ...filler];

describe("the geotechnical report and the environmental report", () => {
  test("a geotechnical report with its title on line 1", () => {
    expect(documentKind(doc("Geotechnical Investigation Report", ...soil, ...filler))).toEqual(expect.objectContaining({ kind: "geotechnical report", role: "context" }));
  });
  test("the same in French, with its title on line 6", () => {
    expect(documentKind(doc(...padding.slice(0, 5), "Étude géotechnique", ...sols, ...filler)).kind).toBe("geotechnical report");
  });
  test("a Phase I environmental site assessment with its title on line 1", () => {
    expect(documentKind(doc("Phase I Environmental Site Assessment", ...site, ...filler))).toEqual(expect.objectContaining({ kind: "environmental report", role: "context" }));
  });
  test("the same in French", () => {
    expect(documentKind(doc("Évaluation environnementale de site", ...terrain, ...filler)).kind).toBe("environmental report");
  });
  test("a brochure that says an assessment exists, deep in it, stays a brochure", () => {
    const lines = brochure();
    lines.splice(29, 0, "A Phase I Environmental Site Assessment is available");
    expect(documentKind(doc(...lines))).toEqual(expect.objectContaining({ kind: "broker brochure", role: "evidence" }));
  });
  test("the same mention in the first 8 lines, with no site terms, is not a report", () => {
    expect(documentKind(doc("Maple Court", "A Phase I Environmental Site Assessment is available", ...filler)).kind).toBe("unrecognized document");
  });
  test("a long deal paper that quotes a soil study is not a report", () => {
    expect(documentKind(doc(...padding, "See the geotechnical report for this site", ...soil, ...filler)).kind).toBe("unrecognized document");
  });
  test("a building rehabilitation assessment is not a report", () => {
    const words = Array.from({ length: 30 }, (_, i) => `The rehabilitation of floor ${i + 1} is priced in this rehabilitation assessment.`);
    expect(documentKind(doc("Phase 2 Rehabilitation Assessment", ...words)).kind).toBe("unrecognized document");
  });
  test("the stronger test wins over a weak kind", () => {
    expect(documentKind(doc("Geotechnical Investigation Manual", "Table of contents", ...soil, ...filler)).kind).toBe("geotechnical report");
  });
  test("a blank line takes no place among the first 8 lines", () => {
    expect(documentKind(doc("", "", "", ...padding.slice(0, 6), "", "Geotechnical Report", ...soil, ...filler)).kind).toBe("geotechnical report");
  });
  test("the title after the first 8 lines does not count", () => {
    expect(documentKind(doc(...padding.slice(0, 8), "Geotechnical Report", ...soil, ...filler)).kind).toBe("unrecognized document");
  });
});

describe("a citation is never a title", () => {
  const withCitation = () => {
    const lines = ["Maple Court", "A new rental building of 40 suites", "The vacancy rate here is low", ...filler, ...filler, ...filler];
    lines.splice(59, 0, "Source: CMHC Rental Market Report (October 2023)");
    return lines;
  };
  test("a one-project brochure that cites a market report is not one", () => {
    const lines = withCitation();
    expect(lines[59]).toContain("Source:");
    const verdict = documentKind(doc(...lines));
    expect(verdict.kind).not.toBe("market report");
    expect(verdict).toEqual(documentKind(doc(...lines.filter(l => !l.startsWith("Source:")))));
  });
  test("a market report with its title on line 3 stays one", () => {
    expect(documentKind(doc("Maple Research", "Fall 2024", "Rental Market Report", "The vacancy rate is low", ...filler))).toEqual(expect.objectContaining({ kind: "market report", role: "context" }));
  });
  test("a market report named only on line 30, not as a citation, is no longer one", () => {
    const lines = ["Maple Court", "The vacancy rate here is low", ...filler];
    lines.splice(29, 0, "A market report for the region is in the data room");
    expect(documentKind(doc(...lines)).kind).toBe("unrecognized document");
  });
  test("a cited market report in the first lines is not a title", () => {
    expect(documentKind(doc("Maple Court", "Source: CMHC Rental Market Report (October 2023)", "The vacancy rate here is low", ...filler)).kind).toBe("unrecognized document");
  });
  test.each(["Source: Geotechnical Report by a consultant", "Notes: geotechnical report on file", "(Sources: Phase I Environmental Site Assessment)"])("a soil or site paper is not named by a cited line: %s", citation => {
    expect(documentKind(doc("Maple Court", citation, ...soil, ...site, ...filler)).kind).toBe("unrecognized document");
  });
  test("a citation takes no place among the first 8 lines", () => {
    const citations = ["Source: city records", "Source: land title", "Note: figures are rounded"];
    expect(documentKind(doc(...padding.slice(0, 6), ...citations, "Geotechnical Report", ...soil, ...filler)).kind).toBe("geotechnical report");
  });
  test("a deal-source verdict does not change", () => {
    expect(documentKind(doc("Maple Court", "Source: term sheet of March 2024", ...filler)).kind).toBe("term sheet");
  });
  test("a cited guide is not a guidebook", () => {
    expect(documentKind(doc("Maple Court", "Source: CMHC guide to rental housing", "Table of contents", ...filler)).kind).toBe("unrecognized document");
  });
});

describe("names that change no reading", () => {
  const named: [string, string[]][] = [
    ["operating statement", ["Operating Statement", "Trailing twelve months", "Income and Expenses", "Statement of Income", "T-12 summary", "État des résultats d'exploitation"]],
    ["purchase agreement", ["Agreement of Purchase and Sale", "Purchase and Sale Agreement", "Offer to Purchase", "Promesse d'achat", "Convention d'achat"]],
    ["cost report", ["Quantity Surveyor Report", "Cost Consultant Letter", "Cost Report No. 4", "Class C Estimate", "Project Monitor Report", "Cost to complete"]],
    ["tax assessment", ["Property Assessment Notice", "Notice of Assessment", "Property Tax Bill", "Tax bill", "Compte de taxes", "Rôle d'évaluation"]],
    ["draw schedule", ["Draw Schedule", "Draw Request No. 3", "Calendrier de débours", "Demande de déboursement"]],
  ];
  const each = named.flatMap(([kind, titles]) => titles.map(title => [kind, title] as const));
  test.each(each)("%s over 80 words: %s", (kind, title) => {
    expect(documentKind(doc("Maple Court", title, ...filler))).toEqual(expect.objectContaining({ kind, role: "deal source" }));
  });
  test.each(each)("%s under 80 words: %s", (kind, title) => {
    expect(documentKind(doc("Maple Court", title))).toEqual(expect.objectContaining({ kind, role: "deal source" }));
  });
  test("a brochure with an offer to purchase stays a brochure", () => {
    expect(documentKind(doc(...brochure("Offer to purchase by the date below")))).toEqual(expect.objectContaining({ kind: "broker brochure", role: "evidence" }));
  });
  test("a report that mentions a cost to complete stays a report", () => {
    expect(documentKind(doc("Geotechnical Report", "This affects the cost to complete", ...soil, ...filler)).kind).toBe("geotechnical report");
  });
  test("a term sheet that mentions a cost to complete stays a term sheet", () => {
    expect(documentKind(doc("Term Sheet", "Interest reserve and cost to complete are funded at closing", ...filler)).kind).toBe("term sheet");
  });
  test.each([[filler], [[]]])("a letter that mentions a draw request stays a letter", rest => {
    expect(documentKind(doc("To: Maple Court Developments", "We received your draw request", ...rest)).kind).toBe("email or letter");
  });
});

describe("the notes say a or an", () => {
  test("read from an appraisal", async () => {
    const r = extractCandidates(await parsed("Appraisal report", ...filler, "Land cost: $830,000"), { role: "evidence" });
    expect(r.notes).toContain("Document kind: appraisal (evidence, set by a person)");
    expect(r.candidates.find(c => c.value === 830000)?.note).toBe("Read from an appraisal; check it");
  });
  test("an excluded section of an offering memorandum", async () => {
    const r = extractCandidates(await parsed("Offering memorandum", ...filler, "Risk factors", "Land cost: $830,000"));
    expect(r.notes).toContain("Document kind: offering memorandum for one project (evidence)");
    expect(r.other.find(c => c.value === 830000)?.note).toBe("The risk factors section of an offering memorandum for one project; its figures are shown, not read");
  });
});
