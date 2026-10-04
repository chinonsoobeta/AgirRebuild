import { describe, expect, it } from "vitest";
import { FIELDS } from "@agir/contracts";
import { SF_PER_M2 } from "@agir/numbers";
import { reviewWaiting } from "../src/components/ui.tsx";
import { enteredInUnit } from "../src/routes/review.tsx";
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

describe("the quick start's gaps", () => {
  const docs = (total: number, processing = 0) => ({ total, processing, failed: 0 });
  const rev = (o: Partial<{ approved: number; needsReview: number; conflicting: number; awaitingSecond: number }> = {}) =>
    ({ approved: 0, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "blocked" as const, ...o });

  it("waits for documents only when there are none and no values, or while reading", () => {
    expect(reviewWaiting({ documents: docs(0), review: rev() })).toBe(true);
    expect(reviewWaiting({ documents: docs(0), review: rev({ approved: 12 }) })).toBe(false);
    expect(reviewWaiting({ documents: docs(0), review: rev({ awaitingSecond: 1 }) })).toBe(false);
    expect(reviewWaiting({ documents: docs(2, 1), review: rev({ approved: 12 }) })).toBe(true);
    expect(reviewWaiting({ documents: docs(2), review: rev() })).toBe(false);
  });

  it("has French for what every optional field means when it is not asked", () => {
    const fr = build("fr", () => {});
    for (const d of FIELDS.filter((x) => x.absentMeans)) {
      expect(fr.L.absent(d.key), d.key).not.toBe(d.absentMeans);
      expect(build("en", () => {}).L.absent(d.key)).toBe(d.absentMeans);
    }
    expect(fr.L.absent("rent_growth_pct")).toBe("loyers stables");
  });

  it("converts an area or a rent entered in square metres, and records it", () => {
    const a = enteredInUnit("sf", true, 870, "from the plans", "en");
    expect(a.value).toBeCloseTo(870 * SF_PER_M2, 9);
    expect(a.reason).toBe("from the plans (entered as 870 m²)");
    const r = enteredInUnit("$/sf/yr", true, 107.64, "broker letter", "fr");
    expect(r.value).toBeCloseTo(107.64 / SF_PER_M2, 9);
    expect(r.reason).toBe("broker letter (saisi en 107,64 $/m²/an)");
    expect(enteredInUnit("sf", false, 870, "from the plans", "en")).toEqual({ value: 870, reason: "from the plans" });
    expect(enteredInUnit("$", true, 5, "x".repeat(10), "en")).toEqual({ value: 5, reason: "x".repeat(10) });
  });
});
