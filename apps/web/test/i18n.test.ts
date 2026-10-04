import { describe, expect, it } from "vitest";
import { build, checkText, translateMessage, verdictText, type Key } from "../src/i18n.tsx";

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

describe("the plain-language layer", () => {
  const en = build("en", () => {});
  const fr = build("fr", () => {});

  it("shows DCR for DSCR, as a whole word only", () => {
    expect(en.msg("Base-case sizing DSCR of 1.05x is under the 1.20x floor.")).toBe("Base-case sizing DCR of 1.05x is under the 1.20x floor.");
    expect(en.msg("DSCRX and ADSCR and min_dscr stay")).toBe("DSCRX and ADSCR and min_dscr stay");
    expect(en.L.metric("sizing_dscr")).toBe("Sizing DCR (weakest year)");
    expect(en.L.gate("stressed_sizing_dscr", "Sizing DSCR, combined stress")).toBe("Sizing DCR, combined stress");
    expect(en.L.stress("x", "DSCR stress")).toBe("DCR stress");
    expect(en.L.field("min_dscr_covenant")).toBe("Minimum DCR covenant");
    const c = { key: "k", kind: "k", severity: "error", message: "The DSCR is low." };
    expect(checkText(en, c)).toBe("The DCR is low.");
    const verdict = { code: "REJECT", hardFailReasons: ["DSCR is under the floor."], gates: [] };
    expect(verdictText(en, verdict, []).explanation).toBe("DCR is under the floor.");
  });

  it("shows RCD for RCSD in French, as a whole word only", () => {
    expect(fr.L.metric("sizing_dscr")).toBe("RCD de dimensionnement (pire année)");
    expect(fr.L.gate("stressed_sizing_dscr", "x")).toBe("RCD de dimensionnement, stress combiné");
    expect(fr.msg("Le RCSD baisse ; RCSDX reste")).toBe("Le RCD baisse ; RCSDX reste");
    const c = { key: "base_sizing_dscr", kind: "k", severity: "error", message: "", expected: 1.2, actual: 1.05 };
    expect(checkText(fr, c)).toContain("Le RCD de dimensionnement");
  });

  it("keeps the institutional term in the glossary", () => {
    expect(en.t("glossary.dcr")[0]).toBe("DCR (debt coverage ratio), called DSCR by many lenders");
    expect(fr.t("glossary.dcr")[0]).toBe("RCD (ratio de couverture de la dette), appelé RCSD par de nombreux prêteurs");
  });

  it("defines every term in both languages", () => {
    const keys: Key[] = ["glossary.dcr", "glossary.noi", "glossary.capRate", "glossary.yieldOnCost", "glossary.loanToCost", "glossary.equityIrr", "glossary.equityMultiple", "glossary.breakEven"];
    for (const k of keys) for (const i of [en, fr]) expect(i.t(k)[1].length).toBeGreaterThan(20);
  });

  it("calls the decision the owner's own when the review is solo", () => {
    expect(en.t("next.decideSolo")).toBe("Record your decision");
    expect(en.t("decision.titleSolo")).toBe("Your decision");
    expect(en.t("next.decide")).toBe("Record the committee decision");
    expect(fr.t("decision.titleSolo")).toBe("Votre décision");
    const gates = [{ key: "g", label: "G", status: "failed" }];
    expect(verdictText(en, { code: "APPROVE_WITH_CONDITIONS", hardFailReasons: [], gates }, [], true).headline).toBe("1 gate fails. You set the conditions.");
    expect(verdictText(en, { code: "APPROVE_WITH_CONDITIONS", hardFailReasons: [], gates }, []).headline).toBe("1 gate fails. The committee sets conditions.");
  });
});
