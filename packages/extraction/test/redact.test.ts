import { describe, expect, test } from "vitest";
import { detectFormat, tokenize } from "@agir/numbers";
import { addressedEntries, redactDocument, redactText, redactionMarker, redactionSpans, verifyReadings, READING_FAILURE, type NormalizedDocument, type Reading, type RedactionKind } from "../src/index.ts";
import { loadOracles, toNormalized } from "./oracle.ts";

// Card S7: patterns that are never a deal figure leave the text before it goes to the model.

const kinds = (text: string, prefix = "") => redactionSpans(text, prefix).map(s => [text.slice(s.start, s.end), s.kind]);

describe("card S7: what is redacted, kind by kind", () => {
  test.each<[string, string, RedactionKind]>([
    ["Contact: jane.doe+deals@example-bank.ca for the rent roll", "jane.doe+deals@example-bank.ca", "email"],
    ["Courriel : marc.tremblay@exemple.qc.ca", "marc.tremblay@exemple.qc.ca", "email"],
    ["Call (416) 555-1234 to book", "(416) 555-1234", "phone"],
    ["Phone 416-555-1234", "416-555-1234", "phone"],
    ["Cell 416.555.1234", "416.555.1234", "phone"],
    ["Tel. +1 416-555-1234", "+1 416-555-1234", "phone"],
    ["Toll free 1-800-555-1234", "1-800-555-1234", "phone"],
    ["Office (604)555-0199 ext. 22", "(604)555-0199 ext. 22", "phone"],
    ["Bureau 514-555-0101 poste 3", "514-555-0101 poste 3", "phone"],
    ["SIN: 046 454 286", "046 454 286", "sin"],
    ["NAS : 046-454-286", "046-454-286", "sin"],
    ["Social insurance number 123 456 789", "123 456 789", "sin"],
    ["Numéro d'assurance sociale 123-456-789", "123-456-789", "sin"],
    ["Reference 046-454-286", "046-454-286", "sin"],
    ["Card 4111 1111 1111 1111 on file", "4111 1111 1111 1111", "card"],
    ["Visa 4111-1111-1111-1111", "4111-1111-1111-1111", "card"],
    ["Amex 3782 822463 10005", "3782 822463 10005", "card"],
    ["Card number 4111111111111111", "4111111111111111", "card"],
    ["123 Main St, Vancouver, BC V6B 1A1", "V6B 1A1", "postal_code"],
    ["Ottawa ON K1A0B1", "K1A0B1", "postal_code"],
    ["Austin, TX ZIP 78701-1234", "78701-1234", "postal_code"],
    ["Account no. 1234567890", "1234567890", "account"],
    ["Account #00123456", "00123456", "account"],
    ["No de compte : 0012345678", "0012345678", "account"],
    ["Routing number 021000021", "021000021", "account"],
    ["Transit 12345-003", "12345-003", "account"],
    ["Date of birth: 1980-05-12", "1980-05-12", "date_of_birth"],
    ["DOB 05/12/1980", "05/12/1980", "date_of_birth"],
    ["Date de naissance : 12 mai 1980", "12 mai 1980", "date_of_birth"],
    ["Born (birth date) March 3, 1975", "March 3, 1975", "date_of_birth"],
  ])("%s", (text, span, kind) => {
    expect(kinds(text)).toEqual([[span, kind]]);
    expect(redactText(text).text).toBe(text.replace(span, redactionMarker(kind)));
  });

  test("markers name the kind in plain words and hold no digit", () => {
    for (const kind of ["email", "phone", "sin", "card", "postal_code", "account", "date_of_birth"] as const) {
      expect(redactionMarker(kind)).toMatch(/^\[redacted [a-z ]+\]$/);
    }
    expect(redactionMarker("date_of_birth")).toBe("[redacted date of birth]");
  });

  test("a number the line names in an earlier cell of its row is redacted", () => {
    expect(kinds("046 454 286", "Tenant SIN")).toEqual([["046 454 286", "sin"]]);
    expect(kinds("1234567", "Bank account")).toEqual([["1234567", "account"]]);
    expect(kinds("1980-05-12", "Date of birth")).toEqual([["1980-05-12", "date_of_birth"]]);
  });
});

describe("card S7: figures and other numbers are kept", () => {
  test.each([
    "Purchase price: $1,250,000",
    "Prix d'achat : 1 250 000 $",
    "Coût total : 123 456 789 $",
    // A phone-shaped number with a unit beside it is read as a figure and kept (precision over recall): the card asked
    // to decide, and a figure removed by mistake costs more than a number left in.
    "Area 415-701-5500 sq ft",
    "Superficie : 2 100 pi²",
    "Interest rate 6.25%",
    "30-year amortization",
    "Closing date 2026-10-30",
    "Unit 101, Suite 4B",
    "Stated total $123456789",
    "Stated total 123 456 789",
    // Without separators a run of digits is never a phone number.
    "Call 4165551234",
    "416-555-1234 units",
    "416-555-1234 logements",
    "416.555.1234 mois",
    "416-555-1234 months",
    "416-555-1234%",
    "$416-555-1234",
    // A nine-digit group with no name and no Luhn check, or written with spaces and not named, is kept.
    "Reference 123-456-789",
    "Total 046 454 286",
    "SIN 123 456 789 $",
    // Card-shaped numbers that fail the check, or carry a currency.
    "Card 4111 1111 1111 1112",
    "$4111 1111 1111 1111",
    // A US ZIP only when the line says ZIP; a figure on a ZIP line is kept.
    "Austin, TX 78701",
    "ZIP code area 12345 sf",
    // Account rules: a money line about an account, a short number, a date, no account word, a plural.
    "Reserve account balance $1,250,000",
    "Reserve account: 2500000",
    "Solde du compte : 1250000",
    "Compte de réserve : 123 456 789 $",
    "Account 123456",
    "Account opened 2026-10-30",
    "Loan amount 12500000",
    "Accounts payable 1500000",
    "Account balance $123456789",
    // A date on a line that does not name a birth.
    "Signed March 3, 1975",
  ])("%s", text => {
    expect(kinds(text)).toEqual([]);
    expect(redactText(text).text).toBe(text);
  });
});

describe("card S7: the redacted document keeps every address", () => {
  test("lines and cells keep their addresses; struck ranges follow the text; numeric cells are untouched", () => {
    const doc: NormalizedDocument = {
      kind: "xlsx",
      lines: [{ text: "Call 416-555-1234 now, price $900,000", location: "page 1, line 1", struck: [[5, 17], [18, 21], [29, 37]] }],
      tables: [{ name: "Tenants", rows: [[
        { text: "Tenant SIN", ref: "Tenants!A1" },
        { text: "046 454 286", ref: "Tenants!B1" },
        { text: "4111111111111111", number: 4111111111111111, ref: "Tenants!C1" },
      ]] }],
      pageCount: null,
      needsOcr: false,
      fullText: "Call 416-555-1234 now, price $900,000\nTenant SIN 046 454 286",
    };
    const { document, redactions } = redactDocument(doc);
    expect(document.lines).toEqual([{ text: "Call [redacted phone] now, price $900,000", location: "page 1, line 1", struck: [[5, 21], [22, 25], [33, 41]] }]);
    const line = document.lines[0]!;
    expect(line.struck!.map(([a, b]) => line.text.slice(a, b))).toEqual(["[redacted phone]", "now", "$900,000"]);
    expect(document.tables[0]!.rows[0]!.map(c => c.text)).toEqual(["Tenant SIN", "[redacted sin]", "4111111111111111"]);
    expect(document.tables[0]!.rows[0]![2]).toEqual(doc.tables[0]!.rows[0]![2]);
    // Never sent; kept so the number format is the one the rule reader used.
    expect(document.fullText).toBe(doc.fullText);
    expect(redactions).toEqual([{ kind: "sin", count: 1 }, { kind: "phone", count: 1 }]);
    expect(addressedEntries(document).map(e => e.location)).toEqual(addressedEntries(doc).map(e => e.location));
    // The original is unchanged: the rule reader reads it.
    expect(doc.lines[0]!.text).toBe("Call 416-555-1234 now, price $900,000");
  });
});

// Every fixture document in the repository, and one made of the patterns above among figures.
const contactSheet: NormalizedDocument = (() => {
  const lines = [
    "Rent roll prepared by Jane Doe, jane.doe@example-bank.ca, (416) 555-1234 ext. 22",
    "Tenant 1: SIN 046 454 286, unit 101, rent $1,850/month, 850 sf",
    "Tenant 2: NAS : 123 456 789, logement 4B, loyer 1 250 $ par mois, 2 100 pi²",
    "Card on file 4111 1111 1111 1111; security $3,700; bank account no. 1234567890",
    "Property: 123 Main St, Vancouver, BC V6B 1A1; 24 units; cap rate 5.25%",
    "Owner date of birth 1980-05-12; closing 2026-10-30; 30-year amortization",
    "Lender contact 604.555.0199; loan $12,500,000 at 6.25% over 300 months",
  ];
  return { kind: "pdf", lines: lines.map((text, i) => ({ text, location: `page 1, line ${i + 1}` })), tables: [], pageCount: 1, needsOcr: false, fullText: lines.join("\n") };
})();
const corpus: { name: string; document: NormalizedDocument }[] = [
  ...loadOracles().flatMap(deal => deal.documents.map(d => ({ name: `${deal.slug}/${d.name}`, document: toNormalized(d) }))),
  { name: "S7 contact sheet (made for this test)", document: contactSheet },
];

describe("card S7: the fixture corpus", () => {
  test("addresses and counts and every figure survive redaction, except what a span removed", () => {
    const report: { document: string; entries: number; tokens: number; insideSpans: number; redactions: string }[] = [];
    for (const { name, document: original } of corpus) {
      const { document, redactions } = redactDocument(original);
      expect(document.lines.length, name).toBe(original.lines.length);
      expect(document.lines.map(l => l.location), name).toEqual(original.lines.map(l => l.location));
      expect(document.tables.map(t => t.rows.map(r => r.map(c => c.ref))), name).toEqual(original.tables.map(t => t.rows.map(r => r.map(c => c.ref))));
      expect(addressedEntries(document).map(e => e.location), name).toEqual(addressedEntries(original).map(e => e.location));
      const format = detectFormat(original.fullText);
      expect(document.fullText, name).toBe(original.fullText);
      // Each line and cell, with what comes before it in its row.
      const entries = [
        ...original.lines.map((l, i) => ({ before: l.text, after: document.lines[i]!.text, prefix: "", cell: false, numeric: false })),
        ...original.tables.flatMap((t, ti) => t.rows.flatMap((row, ri) => row.map((c, ci) => ({
          before: c.text, after: document.tables[ti]!.rows[ri]![ci]!.text, prefix: row.slice(0, ci).map(x => x.text).join(" "), cell: true, numeric: c.number !== undefined,
        })))),
      ];
      let tokens = 0, inside = 0;
      for (const e of entries) {
        // A spreadsheet cell that holds a number is never redacted.
        const spans = e.numeric ? [] : redactionSpans(e.before, e.prefix);
        const key = (t: ReturnType<typeof tokenize>[number]) => JSON.stringify([t.raw, t.value, t.unit, t.currency, t.currencyCode]);
        const all = tokenize(e.before, format, e.cell);
        const kept = all.filter(t => !spans.some(s => t.start < s.end && s.start < t.end)).map(key).sort();
        tokens += all.length;
        inside += all.length - kept.length;
        expect(tokenize(e.after, format, e.cell).map(key).sort(), `${name}: ${e.before}`).toEqual(kept);
      }
      report.push({ document: name, entries: entries.length, tokens, insideSpans: inside, redactions: redactions.map(r => `${r.kind} ${r.count}`).join(", ") || "none" });
    }
    console.log(["card S7 corpus (document, entries, numeric tokens, tokens inside a redacted span, redactions):", ...report.map(r => `  ${r.document}: ${r.entries}, ${r.tokens}, ${r.insideSpans}, ${r.redactions}`)].join("\n"));
    const changed = report.filter(r => r.redactions !== "none").map(r => r.document);
    expect(changed).toEqual(["S7 contact sheet (made for this test)"]);
    expect(report.at(-1)!.redactions).toBe("email 1, card 1, sin 2, phone 2, account 1, postal_code 1, date_of_birth 1");
  });
});

describe("card S7: the boundary checks what the model saw", () => {
  const original: NormalizedDocument = {
    kind: "txt",
    lines: [{ text: "Land cost: $400,000 (seller 416-555-1234)", location: "line 1" }],
    tables: [], pageCount: null, needsOcr: false, fullText: "Land cost: $400,000 (seller 416-555-1234)",
  };
  const seen = redactDocument(original).document;
  const reading = (quote: string): Reading => ({ field: "land_cost", item: null, value: 400000, unit_seen: "$", file: "deal.txt", location: "line 1", quote, note: null, confidence: "high" });
  const verify = (quote: string, document: NormalizedDocument) => verifyReadings({ readings: [reading(quote)], conflicts: [], not_used: [] }, [{ id: "d", name: "deal.txt", document }]).readings[0]!;

  test("a quote of the redacted line verifies, with the right value", () => {
    expect(seen.lines[0]!.text).toBe("Land cost: $400,000 (seller [redacted phone])");
    expect(verify("Land cost: $400,000 (seller [redacted phone])", seen)).toMatchObject({ outcome: "verified", candidate: { fieldKey: "land_cost", value: 400000 } });
  });
  test("a quote copied from the original line fails as a quote: the model never saw it", () => {
    expect(verify("Land cost: $400,000 (seller 416-555-1234)", seen)).toEqual({ outcome: READING_FAILURE.quote });
  });
});
