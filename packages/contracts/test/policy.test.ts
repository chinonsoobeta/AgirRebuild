import { describe, expect, it } from "vitest";
import { POLICIES, stressLabel } from "../src/policy.ts";
import { STRESS } from "../src/fr.ts";

describe("card 96a stress labels", () => {
  for (const policy of Object.values(POLICIES)) {
    it(`${policy.version} reproduces every existing English and French preset label`, () => {
      for (const preset of policy.stresses) {
        expect(stressLabel(preset, "en", preset)).toBe(preset.label);
        expect(stressLabel(preset, "fr", preset)).toBe(STRESS[preset.key]![1]);
      }
    });
  }
  it("prints the actual sizes of changed single and combined stresses in both languages", () => {
    const policy = POLICIES["rental-hold-draft"]!;
    const rate = policy.stresses.find((s) => s.key === "rate")!;
    expect(stressLabel({ ...rate, rateBps: 100 }, "en", rate)).toBe("Interest rate +100 bps");
    expect(stressLabel({ ...rate, rateBps: 100 }, "fr", rate)).toBe("Taux d'intérêt +100 pb");
    const combined = policy.stresses.find((s) => s.key === "combined")!;
    expect(stressLabel({ ...combined, rateBps: 100 }, "en", combined)).toBe("Combined: exit cap +75 bps, costs +10%, rate +100 bps, rent -10%, occupancy -5 pts, operating costs +5 pts");
    expect(stressLabel({ ...combined, rateBps: 100 }, "fr", combined)).toBe("Combiné\u00a0: taux de sortie +75\u00a0pb, coûts +10\u00a0%, taux +100\u00a0pb, loyers -10\u00a0%, occupation -5\u00a0pts, charges d'exploitation +5\u00a0pts");
  });
});

import { THRESHOLDS, changeMeta, effectivePolicy, validateThreshold, type PolicyOverrides } from "../src/policy.ts";
const version = "rental-hold-insured-draft";
const entry = (value: number) => ({ value, setBy: "owner-id", setAt: "2026-10-19T12:00:00Z", reason: "Owner credit decision" });
describe("card 96a owner thresholds", () => {
  it("every standard value in all six policies is inside its inclusive range", () => {
    expect(Object.keys(THRESHOLDS)).toHaveLength(6);
    for (const [version, thresholds] of Object.entries(THRESHOLDS)) for (const threshold of thresholds) {
      expect(validateThreshold(version, threshold.path, threshold.standard), `${version}/${threshold.path}`).toBeNull();
      expect(threshold.standard).toBeGreaterThanOrEqual(threshold.min);
      expect(threshold.standard).toBeLessThanOrEqual(threshold.max);
    }
  });
  it.each([
    ["unknown", "maxLtcPct", 80], [version, "sourcePrecedence", 1], [version, "version", 1],
    [version, "stresses.new.rateBps", 100], [version, "refinanceLimits.select.50.minPoints", 70],
    [version, "maxLtcPct", NaN], [version, "maxLtcPct", Infinity], [version, "maxLtcPct", 101],
    [version, "refinanceLimits.minUnits", 2.5], [version, "agreementTolerancePct", 1.1],
    [version, "stresses.rent.rentPct", 1], [version, "maxFailedGatesForConditions", 5],
  ])("refuses %s / %s / %s in both languages", (version, path, value) => {
    expect(validateThreshold(version, path, value)).toMatchObject({ en: expect.any(String), fr: expect.any(String) });
  });
  it("accepts inclusive bounds and removed stresses", () => {
    for (const [version, thresholds] of Object.entries(THRESHOLDS)) for (const threshold of thresholds) {
      expect(validateThreshold(version, threshold.path, threshold.min)).toBeNull();
      expect(validateThreshold(version, threshold.path, threshold.max)).toBeNull();
    }
  });
  it("preserves base object identity without overrides", () => {
    for (const base of Object.values(POLICIES)) expect(effectivePolicy(base, {}, {}).policy).toBe(base);
  });
  it("layers deal over workspace, falls back when cleared, and records the owner and flags", () => {
    const base = POLICIES[version]!;
    const workspace: PolicyOverrides = { [version]: { "gates.dcrAfterRefinanceMin": entry(1.05) } };
    const deal: PolicyOverrides = { [version]: { "gates.dcrAfterRefinanceMin": entry(1.08) } };
    const result = effectivePolicy(base, workspace, deal);
    expect(result.policy).not.toBe(base);
    expect(result.policy).toMatchObject({ custom: true, version, gates: { dcrAfterRefinanceMin: 1.08 } });
    expect(result.changes).toEqual([expect.objectContaining({ path: "gates.dcrAfterRefinanceMin", standard: 1.1, value: 1.08, layer: "deal", setById: "owner-id", looser: true, lenderCited: true, stressRemoved: false })]);
    expect(effectivePolicy(base, workspace, {}).policy.gates.dcrAfterRefinanceMin).toBe(1.05);
    expect(base.gates.dcrAfterRefinanceMin).toBe(1.1);
  });
  it("treats values equal to the standard as no override", () => {
    const base = POLICIES[version]!;
    const result = effectivePolicy(base, { [version]: { "gates.dcrAfterRefinanceMin": entry(1.1) } }, {});
    expect(result.policy).toBe(base);
    expect(result.changes).toEqual([]);
    expect(result.invalid).toEqual([]);
  });
  it("never throws on a stored value a later draft edit no longer allows; it reports it and leaves it out", () => {
    const base = POLICIES[version]!;
    const stale = effectivePolicy(base, { [version]: { "gates.removedGateMin": entry(1) } }, {});
    expect(stale.policy).toBe(base);
    expect(stale.invalid).toEqual([expect.objectContaining({ path: "gates.removedGateMin", layer: "workspace", value: 1 })]);
    // A deal value that no longer fits falls back to the workspace value, which still applies.
    const layered = effectivePolicy(base, { [version]: { "gates.dcrAfterRefinanceMin": entry(1.05) } }, { [version]: { "gates.dcrAfterRefinanceMin": entry(9) } });
    expect(layered.policy.gates.dcrAfterRefinanceMin).toBe(1.05);
    expect(layered.changes).toEqual([expect.objectContaining({ layer: "workspace", value: 1.05 })]);
    expect(layered.invalid).toEqual([expect.objectContaining({ path: "gates.dcrAfterRefinanceMin", layer: "deal", value: 9 })]);
  });
  it("records each change's label and unit, so an old run renders after its path is gone", () => {
    const result = effectivePolicy(POLICIES[version]!, { [version]: { "gates.dcrAfterRefinanceMin": entry(1.05) } }, {});
    expect(result.changes[0]).toMatchObject({ label: { en: "DCR after refinance", fr: "CCD après refinancement" }, unit: "x" });
  });
  it("lists the insured loan-to-cost limits as editable percentages (card 151)", () => {
    for (const path of ["refinanceLimits.select.50.maxLtcPct", "refinanceLimits.standard.maxLtcPct"]) expect(THRESHOLDS[version]!.find((t) => t.path === path)?.unit).toBe("%");
    expect(changeMeta(version, { path: "refinanceLimits.select.50.maxLtcPct" }).unit).toBe("%");
  });
  it("labels a stored change even when today's policy no longer has its path", () => {
    expect(changeMeta(version, { path: "gates.dcrAfterRefinanceMin" })).toEqual({ label: { en: "DCR after refinance", fr: "CCD après refinancement" }, unit: "x" });
    expect(changeMeta(version, { path: "refinanceLimits.select.80.maxLtvPct" }).unit).toBe("%");
    expect(changeMeta(version, { path: "gates.somethingRemoved" })).toEqual({ label: { en: "gates.somethingRemoved", fr: "gates.somethingRemoved" }, unit: "" });
    expect(changeMeta(version, { path: "x", label: { en: "Stored", fr: "Stocké" }, unit: "x" }).label.en).toBe("Stored");
  });
  it("flags zero stresses and regenerates actual stress labels", () => {
    const result = effectivePolicy(POLICIES[version]!, { [version]: { "stresses.rate.rateBps": entry(0), "stresses.combined.rateBps": entry(100) } }, {});
    expect(result.changes[0]).toMatchObject({ stressRemoved: true, looser: true });
    expect(result.policy.stresses.find((s) => s.key === "rate")!.label).toBe("Interest rate 0 bps");
    expect(result.policy.stresses.find((s) => s.key === "combined")!.label).toContain("rate +100 bps");
  });
});

describe("card P2 threshold labels", () => {
  const all = Object.values(THRESHOLDS).flat();
  it("names every English threshold in words, never by a raw key", () => {
    for (const threshold of all) expect(threshold.label.en, threshold.path).not.toContain("_");
  });
  it("names a stress threshold by the stress's name in both languages", () => {
    const threshold = THRESHOLDS["policy-v1"]!.find((t) => t.path === "stresses.exit_cap.exitCapBps")!;
    expect(threshold.label.en).toBe("Exit cap: Exit cap shock");
    expect(threshold.label.fr).toBe("Taux de sortie : Choc du taux de sortie");
  });
  it("puts a no-break space before the colon of a changed combined stress's French label", () => {
    for (const policy of Object.values(POLICIES)) {
      const combined = policy.stresses.find((s) => s.key === "combined")!;
      const field = Object.keys(combined).find((key) => typeof combined[key as keyof typeof combined] === "number")!;
      const label = stressLabel({ ...combined, [field]: 0 }, "fr", combined);
      expect(label.startsWith("Combiné\u00a0: "), label).toBe(true);
      expect(label).not.toMatch(/[^\u00a0]:/);
      expect(label, "a size never breaks from its unit").not.toMatch(/\d (?:%|pb|mois|pts)/);
    }
    const combined = POLICIES["rental-hold-draft"]!.stresses.find((s) => s.key === "combined")!;
    expect(stressLabel({ ...combined, costPct: 12 }, "fr", combined)).toContain("coûts +12\u00a0%");
  });
  it("puts a no-break space before every colon in a French label", () => {
    for (const threshold of all) expect(threshold.label.fr, threshold.path).not.toMatch(/[^ ]:/);
  });
});
