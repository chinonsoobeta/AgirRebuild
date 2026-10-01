import { describe, expect, test } from "vitest";
import { extractCandidates, parseDocument, type Candidate } from "@agir/extraction";
import { documentBytes, loadOracles } from "../src/index.ts";

const summary = (cs: Candidate[]) =>
  cs.map((c) => `${c.fieldKey}|${c.itemKey ?? ""}=${c.value}`).sort();

// The same reference documents, rendered to real PDF, XLSX and CSV bytes and
// parsed back, must yield exactly the candidates the oracle expects to see.
describe("real files parse to the same candidates", () => {
  for (const deal of loadOracles()) {
    test(deal.name, async () => {
      const found: string[] = [];
      for (const doc of deal.documents) {
        const parsed = await parseDocument(await documentBytes(doc), doc.name);
        expect(parsed.needsOcr).toBe(false);
        found.push(...summary(extractCandidates(parsed).candidates));
      }
      for (const [k, v] of Object.entries(deal.expect.values ?? {})) {
        const [f, i] = k.split("|");
        expect(found.some((s) => s === `${f}|${i ?? ""}=${v}`), `${k}=${v}`).toBe(true);
      }
    });
  }
});
