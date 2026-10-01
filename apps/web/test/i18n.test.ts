import { describe, expect, it } from "vitest";
import { translateMessage } from "../src/i18n.tsx";

describe("a run's source labels in French", () => {
  it("translates the line a value was read from", () => {
    expect(translateMessage("plans.txt, line 2")).toBe("plans.txt, ligne 2");
    expect(translateMessage("memo.pdf, page 3, line 14")).toBe("memo.pdf, page 3, ligne 14");
  });

  it("says a value was converted from square metres, wherever it was read", () => {
    expect(translateMessage('plans.txt, line 2, converted from square metres ("1,000 m²")'))
      .toBe("plans.txt, ligne 2, converti de mètres carrés (« 1,000 m² »)");
    expect(translateMessage('rent-roll.xlsx, Rent roll!C5, converted from square metres ("84")'))
      .toBe("rent-roll.xlsx, Rent roll!C5, converti de mètres carrés (« 84 »)");
  });
});
