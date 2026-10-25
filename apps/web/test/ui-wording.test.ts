import { describe, expect, it } from "vitest";
import { EN, FR } from "../src/i18n.tsx";

// Interface text is written in sentence case: nothing shouts. A word of four or more
// capital letters must be a real acronym, and every one allowed here is one.
const ACRONYMS = new Set([
  "CMHC", // Canada Mortgage and Housing Corporation
  "SCHL", // Société canadienne d'hypothèques et de logement (CMHC in French)
  "DSCR", // debt service coverage ratio
  "RCSD", // ratio de couverture du service de la dette (DSCR in French)
  "JPEG", // the image format
]);
const SHOUTING = /(?<![\p{L}\p{N}])\p{Lu}{4,}(?![\p{L}\p{N}])/gu;

function shouting(table: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [key, entry] of Object.entries(table)) {
    if (typeof entry !== "string") continue;
    for (const word of entry.match(SHOUTING) ?? []) if (!ACRONYMS.has(word)) found.push(`${key}: ${word}`);
  }
  return found;
}

describe("interface wording", () => {
  it("has string entries to check in both languages", () => {
    expect(Object.values(EN).filter((e) => typeof e === "string").length).toBeGreaterThan(100);
    expect(Object.values(FR).filter((e) => typeof e === "string").length).toBeGreaterThan(100);
  });
  it("has a French entry for every English key, and no other", () => {
    expect(Object.keys(FR).sort()).toEqual(Object.keys(EN).sort());
  });
  it("uses no capitalised word in English except real acronyms", () => {
    expect(shouting(EN)).toEqual([]);
  });
  it("uses no capitalised word in French except real acronyms", () => {
    expect(shouting(FR)).toEqual([]);
  });
  it("catches a shouting word, and lets an acronym through", () => {
    expect(shouting({ a: "Run the deal TODAY", b: "Under the CMHC rule", c: "ÉTAPE suivante", d: "MLI Select" })).toEqual(["a: TODAY", "c: ÉTAPE"]);
  });
});
