import { describe, expect, test } from "vitest";
import fc from "fast-check";
import * as contracts from "@agir/contracts";
import { FIELDS, FIELD_BY_KEY, METRICS, POLICIES, POLICY_V1, RENTAL_HOLD_INSURED_DRAFT, RENTAL_HOLD_DRAFT, TEMPLATES, policyFor, type AssumptionStatus, type EngineInput, type Readiness, type RunResult } from "@agir/contracts";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allocate, applyStress, assemble, buildLedger, canonicalJson, gateSpecs, grid, irrRoots, levelPayment, tornado, underwrite, validateInput, EngineInputError } from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const metric = (r: RunResult, key: string, scenario = "base") =>
  r.scenarios.find((s) => s.key === scenario)!.metrics.find((m) => m.key === key)!;

/**
 * The hash of a result as the engine produced it before task 37 added the `mezz_interest_accrued` metric and
 * task 39 added three more: those entries are left out, so a pin taken before them stays true for a deal they do not touch.
 */
function shaWithoutMezzMetric(r: RunResult): string {
  const later = ["mezz_interest_accrued", "leaseup_operating_cost", "cumulative_cash_shortfall", "io_dscr_year1"];
  const plain = { ...r, scenarios: r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => !later.includes(m.key)) })) };
  return createHash("sha256").update(canonicalJson(plain)).digest("hex");
}

describe("hand-checkable all-equity deal", () => {
  const r = underwrite(allEquityDeal(), POLICY_V1);
  test("operations", () => {
    expect(metric(r, "gross_potential_rent").value).toBeCloseTo(120_000, 6);
    expect(metric(r, "stabilized_noi").value).toBeCloseTo(120_000, 6);
    expect(metric(r, "total_development_cost").value).toBeCloseTo(1_000_000, 6);
    expect(metric(r, "yield_on_cost").value).toBeCloseTo(12, 9);
    expect(metric(r, "development_spread").value).toBeCloseTo(200, 6);
  });
  test("exit and returns", () => {
    expect(metric(r, "exit_value").value).toBeCloseTo(1_200_000, 6);
    expect(metric(r, "development_profit").value).toBeCloseTo(200_000, 6);
    expect(metric(r, "profit_on_cost").value).toBeCloseTo(20, 9);
    expect(metric(r, "equity_multiple").value).toBeCloseTo(1.32, 9);
    expect(metric(r, "equity_irr").value).toBeCloseTo(32, 5);
  });
  test("debt metrics are not applicable, never zero", () => {
    for (const k of ["sizing_dscr", "contractual_dscr", "debt_yield", "total_debt"]) {
      expect(metric(r, k).status).toBe("NOT_APPLICABLE");
      expect(metric(r, k).value).toBeNull();
    }
  });
  test("verdict: two gates fail, stressed coverage is not applicable", () => {
    const g = Object.fromEntries(r.verdict.gates.map((x) => [x.key, x.status]));
    expect(g).toEqual({
      equity_multiple: "failed",
      profit_on_cost: "passed",
      development_spread: "passed",
      stressed_sizing_dscr: "not_applicable",
      stressed_equity_multiple: "failed",
    });
    expect(r.verdict.code).toBe("APPROVE_WITH_CONDITIONS");
  });
  test("combined stress by hand", () => {
    // rent -10%, occupancy 95%, expenses 5% of year-1 EGI, exit cap 10.75%, costs +10%
    const noi = 108_000 * 0.95 * 0.95;
    const em = (noi + noi / 0.1075) / 1_100_000;
    expect(metric(r, "equity_multiple", "combined").value).toBeCloseTo(em, 9);
  });
});

describe("funding", () => {
  test("sources equal uses to the cent and the debt is fully drawn", () => {
    const L = buildLedger(developmentDeal());
    expect(L.converged).toBe(true);
    expect(L.requiredEquity + L.drawnDebtAtS).toBeCloseTo(L.tdc, 1);
    expect(L.drawnDebtAtS).toBeCloseTo(27_000_000, 1);
    expect(L.capitalizedInterest).toBeGreaterThan(0);
  });
  test("capitalized interest accrues on opening balances until stabilization", () => {
    const L = buildLedger(developmentDeal());
    let bal = 0;
    let interest = 0;
    for (const row of L.rows.slice(0, L.S)) {
      const i = (bal * 6) / 100 / 12;
      interest += i;
      bal += i + row.debtDraw;
    }
    expect(L.capitalizedInterest).toBeCloseTo(interest, 2);
  });
  test("an S-curve draws later, so it carries less interest", () => {
    const straight = buildLedger(developmentDeal());
    const s = buildLedger({ ...developmentDeal(), sCurveDraws: true });
    expect(s.capitalizedInterest).not.toBeCloseTo(straight.capitalizedInterest, 0);
  });
  test("a loan larger than the whole cost is rejected, not approved", () => {
    const deal = { ...developmentDeal(), senior: { amount: 120_000_000, ratePct: 6, amortYears: 30, ioMonths: 36 } };
    const r = underwrite(deal, POLICY_V1);
    expect(r.checks.find((c) => c.key === "debt_exceeds_cost")?.severity).toBe("error");
    expect(r.verdict.code).toBe("REJECT");
  });
  test("a stated equity short of the requirement is a funding gap", () => {
    const r = underwrite({ ...developmentDeal(), stated: { equity: 5_000_000 } }, POLICY_V1);
    expect(r.checks.find((c) => c.key === "sources_cover_uses")?.severity).toBe("error");
    expect(r.verdict.code).toBe("REJECT");
  });
});

describe("debt", () => {
  test("sizing DSCR uses the level amortizing payment", () => {
    const deal: EngineInput = { ...allEquityDeal(), senior: { amount: 500_000, ratePct: 6, amortYears: 30, ioMonths: 0 } };
    const r = underwrite(deal, POLICY_V1);
    const ds = levelPayment(500_000, 6, 360) * 12;
    expect(metric(r, "sizing_dscr").value).toBeCloseTo(120_000 / ds, 9);
    expect(metric(r, "contractual_dscr").value).toBeCloseTo(120_000 / ds, 9);
  });
  test("interest-only lowers contractual debt service but not sizing", () => {
    const amort = underwrite({ ...allEquityDeal(), senior: { amount: 500_000, ratePct: 6, amortYears: 30, ioMonths: 0 } }, POLICY_V1);
    const io = underwrite({ ...allEquityDeal(), senior: { amount: 500_000, ratePct: 6, amortYears: 30, ioMonths: 24 } }, POLICY_V1);
    expect(metric(io, "sizing_dscr").value).toBeCloseTo(metric(amort, "sizing_dscr").value!, 9);
    expect(metric(io, "contractual_dscr").value).toBeCloseTo(120_000 / 30_000, 9);
  });
  test("a refinance reaches coverage", () => {
    const base = developmentDeal();
    const r1 = underwrite(base, POLICY_V1);
    const r2 = underwrite({ ...base, refinance: { month: 31, amount: 40_000_000, ratePct: 9, amortYears: 30, ioMonths: 0 } }, POLICY_V1);
    expect(metric(r2, "sizing_dscr").value!).toBeLessThan(metric(r1, "sizing_dscr").value!);
    expect(metric(r2, "refinance_net_proceeds").value).toBeGreaterThan(0);
  });
  test("mezzanine carries construction interest and appears in all-in coverage", () => {
    const base = developmentDeal();
    const withMezz = { ...base, mezzanine: { amount: 5_000_000, ratePct: 11, amortYears: 30, ioMonths: 60 } };
    const a = buildLedger(base);
    const b = buildLedger(withMezz);
    expect(b.capitalizedInterest).toBeGreaterThan(a.capitalizedInterest);
    const r = underwrite(withMezz, POLICY_V1);
    expect(metric(r, "mezz_dscr_year1").status).toBe("VALID");
    expect(metric(r, "mezz_dscr_year1").value!).toBeLessThan(metric(r, "senior_dscr_year1").value!);
  });
});

describe("not meaningful is never zero", () => {
  test("a negative NOI makes the exit and returns not meaningful and the verdict not evaluated", () => {
    const deal = { ...allEquityDeal(), expenseRatioPct: 120 };
    expect(() => underwrite(deal, POLICY_V1)).not.toThrow();
    const r = underwrite(deal, POLICY_V1);
    expect(metric(r, "exit_value").status).toBe("NOT_MEANINGFUL");
    expect(metric(r, "equity_irr").value).toBeNull();
    expect(r.verdict.code).toBe("NOT_EVALUATED");
  });
  test("no dwelling units: cost per unit is not applicable", () => {
    const deal: EngineInput = { ...allEquityDeal(), revenue: [{ key: "Office", label: "Office", basis: "per_sf", units: 0, areaSf: 10_000, rentPsfAnnual: 12 }] };
    const r = underwrite(deal, POLICY_V1);
    expect(metric(r, "cost_per_unit").status).toBe("NOT_APPLICABLE");
    expect(metric(r, "gross_potential_rent").value).toBeCloseTo(120_000, 6);
  });
  test("every metric's value is null exactly when its status is not VALID", () => {
    const r = underwrite(developmentDeal(), POLICY_V1);
    for (const s of r.scenarios) for (const m of s.metrics) expect(m.value === null).toBe(m.status !== "VALID");
  });
});

describe("IRR", () => {
  test("finds both roots of a two-root cash flow", () => {
    const roots = irrRoots([{ t: 0, amount: -100 }, { t: 1, amount: 230 }, { t: 2, amount: -132 }]);
    expect(roots.map((r) => Math.round(r * 1000) / 1000)).toEqual([0.1, 0.2]);
  });
  test("no sign change, no root", () => {
    expect(irrRoots([{ t: 0, amount: 100 }, { t: 1, amount: 50 }])).toEqual([]);
  });
});

describe("validation", () => {
  test("names the invalid component", () => {
    const deal = { ...allEquityDeal(), revenue: [{ key: "Studio", label: "Studio", basis: "per_unit" as const, units: 0, rentMonthly: 1_500 }] };
    expect(() => underwrite(deal, POLICY_V1)).toThrow(EngineInputError);
    expect(() => underwrite(deal, POLICY_V1)).toThrow(/Studio/);
  });
});

// Task 35: only a genuine credit may take other costs below zero.
describe("a credit in other costs", () => {
  const withOther = (other: number, fix: Partial<EngineInput["budget"]> = {}): EngineInput => {
    const d = allEquityDeal();
    d.constructionMonths = 12;
    d.budget = { land: 1_000_000, hard: 500_000, soft: 100_000, contingency: 50_000, other, ...fix };
    return d;
  };
  const problems = (d: EngineInput): string[] => {
    try {
      validateInput(d);
      return [];
    } catch (e) {
      if (e instanceof EngineInputError) return e.problems;
      throw e;
    }
  };
  const sha = shaWithoutMezzMetric;

  test("a negative other cost is accepted while the total stays above 0", () => {
    expect(problems(withOther(-20_000))).toEqual([]);
    expect(() => underwrite(withOther(-20_000), POLICY_V1)).not.toThrow();
  });
  test("it is refused when the total would be 0 or less, or when it outweighs the construction costs", () => {
    expect(problems(withOther(-650_000, { land: 0 })).join(";")).toMatch(/total/);
    // The total is 950,000, but the credit is more than hard, soft and contingency together.
    expect(problems(withOther(-700_000)).join(";")).toMatch(/credit/);
    expect(problems(withOther(-650_000))).toEqual([]);
  });
  test("land, hard, soft and contingency still refuse a negative figure", () => {
    for (const k of ["land", "hard", "soft", "contingency"] as const) {
      expect(problems(withOther(-20_000, { [k]: -1 })).join(";"), k).toContain(`budget ${k} must be a number of at least 0`);
    }
  });
  test("total cost is exactly the credit lower, and every other figure moves only through that", () => {
    const base = underwrite(withOther(0), POLICY_V1);
    const credit = underwrite(withOther(-20_000), POLICY_V1);
    expect(metric(credit, "total_development_cost").value).toBeCloseTo(metric(base, "total_development_cost").value! - 20_000, 6);
    expect(metric(credit, "development_profit").value).toBeCloseTo(metric(base, "development_profit").value! + 20_000, 6);
    for (const k of ["gross_potential_rent", "stabilized_noi", "exit_value"]) expect(metric(credit, k).value, k).toBe(metric(base, k).value);
    // Equity pays for a cheaper build, month by month: the credit is spread with the other construction costs.
    const a = buildLedger(withOther(0));
    const b = buildLedger(withOther(-20_000));
    expect(b.costsBeforeFinancing).toBeCloseTo(a.costsBeforeFinancing - 20_000, 6);
    expect(b.equityContributed).toBeCloseTo(a.equityContributed - 20_000, 6);
  });
  test("a cost stress does not enlarge a credit", () => {
    const up = applyStress(withOther(-20_000), { key: "costs", label: "Costs", costPct: 10 });
    expect(up.budget.other).toBe(-20_000);
    expect(up.budget.hard).toBeCloseTo(550_000, 6);
    expect(applyStress(withOther(20_000), { key: "costs", label: "Costs", costPct: 10 }).budget.other).toBeCloseTo(22_000, 6);
    // Costs that fall take the credit down with them, so the stressed budget stays valid.
    const down = applyStress(withOther(-20_000), { key: "costs", label: "Costs", costPct: -10 });
    expect(down.budget.other).toBeCloseTo(-18_000, 6);
    expect(() => validateInput(down)).not.toThrow();
  });
  test("a deal with no credit computes byte for byte as before", () => {
    const withOtherCost = developmentDeal();
    withOtherCost.budget.other = 300_000;
    // Re-pinned for task 39 on 524ed85 with no lease-up: a ramp-off lease-up now carries fixed operating costs, so the old
    // 12-month deal (61f6c980..., c346a263...) moves by design; these two do not.
    const plain = { ...developmentDeal(), leaseUpMonths: 0 };
    withOtherCost.leaseUpMonths = 0;
    expect(sha(underwrite(plain, POLICY_V1))).toBe("52ca18ae941f2ccfa5699882c2de0aff37fce23dae690434d9d33e025a7aa12f");
    expect(sha(underwrite(withOtherCost, POLICY_V1))).toBe("dc6fd4b771ef98533a01e488fbe204a3dbce9b8d022adecdf704ebc880ae8092");
  });
});

describe("determinism and money", () => {
  test("the same input gives the same result, byte for byte", () => {
    expect(canonicalJson(underwrite(developmentDeal(), POLICY_V1))).toBe(canonicalJson(underwrite(developmentDeal(), POLICY_V1)));
  });
  test("allocation never creates or loses a cent", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e10 }), fc.array(fc.double({ min: 0.001, max: 1, noNaN: true }), { minLength: 1, maxLength: 60 }), (c, w) => {
        const parts = allocate(c / 100, w);
        return Math.round(parts.reduce((a, b) => a + b, 0) * 100) === c;
      }),
    );
  });
});

describe("stresses move returns the right way", () => {
  test("every adverse shock lowers the equity multiple (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          land: fc.integer({ min: 1_000_000, max: 10_000_000 }),
          hard: fc.integer({ min: 5_000_000, max: 50_000_000 }),
          units: fc.integer({ min: 20, max: 300 }),
          rent: fc.integer({ min: 1_500, max: 4_000 }),
          loanPct: fc.integer({ min: 0, max: 70 }),
          cap: fc.double({ min: 4, max: 7, noNaN: true }),
          c: fc.integer({ min: 0, max: 30 }),
          l: fc.integer({ min: 0, max: 18 }),
          h: fc.integer({ min: 1, max: 10 }),
        }),
        (p) => {
          const deal: EngineInput = {
            ...developmentDeal(),
            budget: { land: p.land, hard: p.hard, soft: p.hard * 0.15, contingency: p.hard * 0.05, other: 0 },
            revenue: [{ key: "U", label: "U", basis: "per_unit", units: p.units, rentMonthly: p.rent }],
            exitCapPct: p.cap,
            constructionMonths: p.c,
            leaseUpMonths: p.l,
            holdYears: p.h,
            senior: { amount: ((p.land + p.hard * 1.2) * p.loanPct) / 100, ratePct: 6.5, amortYears: 30, ioMonths: 24 },
          };
          const r = underwrite(deal, POLICY_V1);
          const base = metric(r, "equity_multiple");
          if (base.status !== "VALID") return true;
          for (const s of r.scenarios.slice(1)) {
            const x = s.metrics.find((m) => m.key === "equity_multiple")!;
            if (x.status === "VALID" && x.value! > base.value! + 1e-9) return false;
          }
          return true;
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("quick-start templates", () => {
  // A fourplex in Edmonton; every other answer is a plain, plausible number.
  const answer: Record<string, number> = {
    land_cost: 600_000, hard_cost: 1_400_000, soft_cost: 150_000, contingency: 70_000, other_cost: 20_000,
    construction_months: 12, lease_up_months: 3, unit_count: 4, unit_rent_monthly: 2_100,
    stabilized_occupancy_pct: 95, other_income_annual: 3_000, exit_cap_rate_pct: 5.25,
    senior_loan_amount: 1_500_000, senior_rate_pct: 5.2, senior_amort_years: 30,
    development_charges: 0, property_tax_annual: 0, land_transfer_tax: 0, gst_hst_net: 0,
  };
  const rowsFor = (key: "multiplex" | "apartment", loan = 1_500_000) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    const rows: { fieldKey: string; itemKey: string | null; status: AssumptionStatus; valueNumeric: number | null }[] = [];
    const add = (fieldKey: string, itemKey: string | null, v: number, status: AssumptionStatus = "approved") => rows.push({ fieldKey, itemKey, status, valueNumeric: v });
    const skipped = new Set(loan === 0 ? t.questions.find((q) => q.skipsIfZero)!.skipsIfZero : []);
    for (const q of t.questions) {
      if (skipped.has(q.field) || !Object.hasOwn(answer, q.field)) continue;
      if (q.repeatable) for (const item of ["1BR", "2BR"]) add(q.field, item, q.field === "unit_count" ? 3 : answer[q.field]!);
      else add(q.field, q.item ?? null, q.field === "senior_loan_amount" ? loan : answer[q.field]!);
    }
    for (const d of t.defaults) add(d, null, FIELD_BY_KEY.get(d)!.default!, "default_accepted");
    return rows;
  };

  test.each(TEMPLATES.map((t) => [t.key] as const))("%s asks only real fields and defaults exactly the fields that carry one", (key) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    for (const q of t.questions) {
      const def = FIELD_BY_KEY.get(q.field);
      expect(def, q.field).toBeDefined();
      expect(Boolean(def!.itemized), q.field).toBe(Boolean(q.item || q.repeatable));
    }
    expect([...t.defaults].sort()).toEqual(FIELDS.filter((f) => f.default !== undefined).map((f) => f.key).sort());
    const covered = new Set([...t.questions.map((q) => q.field), ...t.defaults]);
    for (const f of FIELDS.filter((f) => f.required === true && !f.itemized)) expect(covered.has(f.key), f.key).toBe(true);
    expect(t.minUnits).toBeLessThan(t.maxUnits);
  });

  test.each(TEMPLATES.map((t) => [t.key] as const))("%s answers leave nothing missing, with or without a loan", (key) => {
    for (const loan of [1_500_000, 0]) {
      const { readiness, input } = assemble(rowsFor(key, loan));
      expect(readiness, `${key} loan ${loan}`).toMatchObject({ status: "ready", missing: [], conflicting: [], pending: [], impossible: [] });
      expect(input).not.toBeNull();
    }
  });

  describe("kept and refinanced (task 75)", () => {
    const heldFields = ["senior_io_months", "refinance_month", "refinance_amount", "refinance_ltv_pct", "refinance_rate_pct", "refinance_amort_years", "refinance_io_months", "refinance_insurance_premium_pct"];
    const heldRowsFor = (key: "multiplex" | "apartment", changes: Record<string, number | undefined> = {}) => {
      const values: Record<string, number | undefined> = {
        refinance_and_hold: 1, senior_io_months: 18, refinance_month: 18, refinance_amount: 1_600_000,
        refinance_rate_pct: 4.8, refinance_amort_years: 30, ...changes,
      };
      const t = TEMPLATES.find((x) => x.key === key)!;
      return [...rowsFor(key).filter((r) => r.fieldKey !== "senior_amort_years"),
        ...t.questions.filter((q) => Object.hasOwn(values, q.field) && values[q.field] !== undefined).map((q) => ({
          fieldKey: q.field, itemKey: null, status: "approved" as const, valueNumeric: values[q.field]!,
        })),
      ];
    };
    test.each(TEMPLATES.map((t) => [t.key] as const))("%s is ready without unused senior amortization", (key) => {
      const { readiness, input } = assemble(heldRowsFor(key));
      expect(readiness).toMatchObject({ status: "ready", missing: [], conflicting: [], pending: [], impossible: [] });
      expect(input!.exit).toBe("refinance_hold");
      expect(input!.senior).not.toHaveProperty("amortYears");
    });
    test.each(TEMPLATES.map((t) => [t.key] as const))("%s requires amortization when IO ends before refinance", (key) => {
      const rows = heldRowsFor(key, { senior_io_months: 17 });
      expect(assemble(rows).readiness.missing.map((m) => m.fieldKey)).toEqual(["senior_amort_years"]);
      const result = assemble([...rows, { fieldKey: "senior_amort_years", itemKey: null, status: "approved", valueNumeric: 30 }]);
      expect(result.readiness.status).toBe("ready");
      expect(result.input!.exit).toBe("refinance_hold");
    });
    test.each(TEMPLATES.map((t) => [t.key] as const))("%s runs with the conventional and insured held policies", (key) => {
      for (const premium of [undefined, 4]) {
        const { input } = assemble(heldRowsFor(key, { refinance_insurance_premium_pct: premium }));
        expect(input).not.toBeNull();
        const policy = policyFor(input!);
        expect(policy.version).toBe(premium === undefined ? "rental-hold-draft" : "rental-hold-insured-draft");
        expect(["GO", "WATCH", "REJECT"]).toContain(underwrite(input!, policy).verdict.code);
      }
    });
    test.each(TEMPLATES.map((t) => [t.key] as const))("%s can size the held refinance by loan-to-value", (key) => {
      const { readiness, input } = assemble(heldRowsFor(key, { refinance_amount: undefined, refinance_ltv_pct: 70 }));
      expect(readiness).toMatchObject({ status: "ready", missing: [] });
      expect(input!.exit).toBe("refinance_hold");
      expect(input!.refinance).toMatchObject({ ltvPct: 70 });
      expect(input!.refinance).not.toHaveProperty("amount");
    });
    test.each(TEMPLATES.map((t) => [t.key] as const))("%s asks usable held fields in the specified order", (key) => {
      const t = TEMPLATES.find((x) => x.key === key)!;
      expect(t.questions[0]!.field).toBe("refinance_and_hold");
      const held = t.questions.filter((q) => q.heldOnly);
      expect(held.map((q) => q.field)).toEqual(heldFields);
      expect(t.questions.indexOf(held[0]!)).toBeGreaterThan(t.questions.findIndex((q) => q.field === "senior_amort_years"));
      for (const q of held) {
        const def = FIELD_BY_KEY.get(q.field)!;
        expect(def, q.field).toBeDefined();
        expect(def.required === false || def.required === "refinance_month", q.field).toBe(true);
      }
      for (const field of ["refinance_amount", "refinance_ltv_pct", "refinance_io_months", "refinance_insurance_premium_pct"]) {
        expect(held.find((q) => q.field === field)).toMatchObject({ optional: true });
      }
      expect(held[0]).toMatchObject({ zeroAllowed: true });
    });
    test.each([
      [{ senior_io_months: 18, refinance_month: 18 }, false],
      [{ refinance_and_hold: 1, senior_io_months: 18 }, false],
      [{ refinance_and_hold: 1, senior_io_months: 18, refinance_month: 18 }, true],
      [{ refinance_and_hold: 1, senior_io_months: 17, refinance_month: 18 }, false],
    ] as [Record<string, number>, boolean][])("shares the amortization rule for %j", (values, expected) => {
      expect(contracts.heldSeniorAmortUnused((key) => values[key])).toBe(expected);
    });
  });

  // Readiness never blocks it. These figures are a weak deal (the engine's own equity_wipeout check
  // fires, so the verdict is a hard fail), which is a finding about the deal, not a blocked run.
  test("a fourplex quick start runs to a verdict", () => {
    const { input } = assemble(rowsFor("multiplex"));
    const r = underwrite(input!, POLICY_V1);
    expect(r.verdict.code).toBe("REJECT");
    expect(r.checks.map((c) => c.key)).toContain("equity_wipeout");
    expect(input!.revenue).toHaveLength(1);
  });

  // Card 60d: one item written two ways is never counted twice.
  test("approved rows for 'Retail' and 'retail' block the run, and neither is in the revenue program", () => {
    const retail = (name: string) => [
      { fieldKey: "unit_count", itemKey: name, status: "approved" as const, valueNumeric: 2 },
      { fieldKey: "unit_rent_monthly", itemKey: name, status: "approved" as const, valueNumeric: 3_000 },
    ];
    const rows = [...rowsFor("multiplex"), ...retail("Retail"), ...retail("retail")];
    const { readiness, input } = assemble(rows);
    expect(readiness.status).toBe("blocked");
    expect(input).toBeNull();
    const named = readiness.impossible.filter((i) => i.detail === "Reject the values of one, or enter them under one name.");
    // One line for the item, naming both forms (audit of task 60d: two identical lines read as a repeat).
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ itemKey: "Retail", label: "Retail and retail are one item written two ways" });
    // Rejecting one name's values clears it, and the item is one component.
    const cleared = assemble(rows.map((r) => (r.itemKey === "retail" ? { ...r, status: "rejected" as const } : r)));
    expect(cleared.readiness.status).toBe("ready");
    expect(cleared.input!.revenue.filter((c) => c.key === "Retail")).toHaveLength(1);
  });

  // Task 35: an approved credit is not an impossible value.
  test("an approved negative other cost is accepted by readiness", () => {
    const rows = rowsFor("apartment").map((r) => (r.fieldKey === "other_cost" ? { ...r, valueNumeric: -20_000 } : r));
    const { readiness, input } = assemble(rows);
    expect(readiness.impossible).toEqual([]);
    expect(input!.budget.other).toBe(-20_000);
  });

  // Task 33: an optional line with no value is disclosed as "not found"; it is never a number and never blocks.
  describe("optional lines that were not found", () => {
    const notFoundOf = (r: Readiness) => r.notFound;
    const keys = (r: Readiness) => notFoundOf(r).map((i) => i.fieldKey);
    const minimal = () => rowsFor("multiplex").filter((r) => !["other_cost", "other_income_annual"].includes(r.fieldKey));
    const add = (fieldKey: string, status: AssumptionStatus, valueNumeric: number | null) => ({ fieldKey, itemKey: null, status, valueNumeric });

    test("a minimal deal lists other costs, other income and growth, with what each is treated as", () => {
      const { readiness } = assemble(minimal());
      const by = new Map(notFoundOf(readiness).map((i) => [i.fieldKey, i]));
      expect(by.get("other_cost")).toMatchObject({ label: "Other costs", detail: "no other costs" });
      expect(by.get("other_income_annual")).toMatchObject({ label: "Other income", detail: "no other income" });
      expect(by.get("rent_growth_pct")).toMatchObject({ detail: "flat rents" });
      expect(by.get("expense_growth_pct")).toMatchObject({ detail: "flat expenses" });
      expect(by.get("refinance_month")).toMatchObject({ detail: "no refinance" });
    });

    test("a field whose parent is absent, or that only stands in for a present one, is left out", () => {
      const { readiness } = assemble(minimal());
      const listed = keys(readiness);
      for (const k of ["refinance_rate_pct", "refinance_amount", "refinance_ltv_pct", "refinance_io_months", "mezz_io_months", "fixed_opex_annual"]) expect(listed, k).not.toContain(k);
      expect(listed).toContain("mezz_loan_amount");
      expect(listed).toContain("senior_io_months");
      // No senior amount: no senior interest-only line either.
      expect(keys(assemble(rowsFor("multiplex", 0)).readiness)).not.toContain("senior_io_months");
      // A refinance month lists what depends on it, except the alternative to a present sizing.
      const refi = assemble([...minimal(), add("refinance_month", "approved", 24), add("refinance_ltv_pct", "approved", 65), add("refinance_rate_pct", "approved", 5), add("refinance_amort_years", "approved", 30)]).readiness;
      expect(keys(refi)).toContain("refinance_io_months");
      expect(keys(refi)).not.toContain("refinance_amount");
      expect(keys(refi)).not.toContain("refinance_month");
    });

    test("a field with a value, a conflict or a pending value is not listed", () => {
      const base = minimal();
      expect(keys(assemble([...base, add("other_income_annual", "approved", 3000)]).readiness)).not.toContain("other_income_annual");
      expect(keys(assemble([...base, add("other_income_annual", "conflicting", null)]).readiness)).not.toContain("other_income_annual");
      expect(keys(assemble([...base, add("other_income_annual", "needs_review", 3000)]).readiness)).not.toContain("other_income_annual");
      expect(keys(assemble([...base, add("rent_growth_pct", "approved", 99)]).readiness)).not.toContain("rent_growth_pct");
    });

    test("it never blocks a run and never changes a number: the input is the one an explicit zero would give", () => {
      const withZeros = [...minimal(), add("other_cost", "approved", 0), add("other_income_annual", "approved", 0), add("rent_growth_pct", "approved", 0), add("expense_growth_pct", "approved", 0)];
      const a = assemble(minimal());
      const b = assemble(withZeros);
      expect(a.readiness.status).toBe("ready");
      expect(a.input).not.toBeNull();
      expect(notFoundOf(a.readiness).length).toBeGreaterThan(notFoundOf(b.readiness).length);
      expect(canonicalJson(a.input)).toBe(canonicalJson(b.input));
      expect(canonicalJson(underwrite(a.input!, POLICY_V1))).toBe(canonicalJson(underwrite(b.input!, POLICY_V1)));
    });

    test("a blocked deal still lists what was not found", () => {
      const { readiness, input } = assemble([add("land_cost", "approved", 100)]);
      expect(input).toBeNull();
      expect(keys(readiness)).toContain("other_income_annual");
    });
  });

  // Task 60b: a choice only a person makes (never extracted) is offered, apart from the lines that were not found.
  describe("choices only a person makes", () => {
    const choiceKeys = (r: Readiness) => r.choices.map((i) => i.fieldKey);
    const minimal = () => rowsFor("multiplex").filter((r) => !["other_cost", "other_income_annual"].includes(r.fieldKey));
    const add = (fieldKey: string, status: AssumptionStatus, valueNumeric: number | null) => ({ fieldKey, itemKey: null, status, valueNumeric });
    const NOT_FOUND = ["other_cost", "land_transfer_tax", "variable_expense_pct", "other_income_annual", "rent_growth_pct", "expense_growth_pct", "senior_io_months", "min_dscr_covenant", "mezz_loan_amount", "equity_amount", "refinance_month", "lp_share_pct", "stated_total_cost", "stated_ltc_pct", "stated_interest_reserve"];

    test("with none stated, every never-extracted optional flag is listed, with what the run treats it as", () => {
      const { readiness } = assemble(minimal());
      expect(choiceKeys(readiness)).toEqual(expect.arrayContaining(["lease_up_ramp", "s_curve_draws", "refinance_and_hold"]));
      const by = new Map(readiness.choices.map((i) => [i.fieldKey, i]));
      expect(by.get("lease_up_ramp")).toMatchObject({ label: "Credit income during lease-up", detail: "no income before stabilization" });
      expect(by.get("refinance_and_hold")).toMatchObject({ detail: "the deal is sold at the end of the hold" });
      for (const k of choiceKeys(readiness)) {
        const d = FIELD_BY_KEY.get(k)!;
        expect(d.extractable, k).toBe(false);
        expect(d.itemized, k).toBeFalsy();
        expect(d.required, k).toBe(false);
      }
    });

    test("none of them is in notFound, and notFound is what it was", () => {
      const { readiness } = assemble(minimal());
      expect(readiness.notFound.map((i) => i.fieldKey)).toEqual(NOT_FOUND);
      for (const k of choiceKeys(readiness)) expect(readiness.notFound.map((i) => i.fieldKey)).not.toContain(k);
    });

    test("a stated, pending or conflicting choice leaves the list", () => {
      for (const status of ["approved", "needs_review", "conflicting"] as const) {
        expect(choiceKeys(assemble([...minimal(), add("lease_up_ramp", status, status === "conflicting" ? null : 1)]).readiness), status).not.toContain("lease_up_ramp");
      }
      expect(choiceKeys(assemble([...minimal(), add("lease_up_ramp", "approved", 0)]).readiness)).not.toContain("lease_up_ramp");
      expect(choiceKeys(assemble([...minimal(), add("lease_up_ramp", "approved", 1)]).readiness)).toContain("s_curve_draws");
    });

    test("a blocked deal still lists them, and they never block a run or change the input", () => {
      expect(choiceKeys(assemble([add("land_cost", "approved", 100)]).readiness)).toContain("s_curve_draws");
      const a = assemble(minimal());
      expect(a.readiness.status).toBe("ready");
      expect(a.input).not.toBeNull();
    });
  });

  // Readiness runs the engine's own cross-field rules, so "ready" means the engine will accept the input.
  describe("a refinance the engine would refuse", () => {
    const withRefi = (fields: Record<string, number>) => [
      ...rowsFor("multiplex"),
      ...Object.entries(fields).map(([fieldKey, valueNumeric]) => ({ fieldKey, itemKey: null, status: "approved" as AssumptionStatus, valueNumeric })),
    ];
    const takeOut = { refinance_rate_pct: 5, refinance_amort_years: 30 };

    test("a month, rate and amortization with neither amount nor loan-to-value is blocked, naming the problem", () => {
      const { readiness, input } = assemble(withRefi({ refinance_month: 24, ...takeOut }));
      expect(input).toBeNull();
      expect(readiness.status).toBe("blocked");
      expect(readiness.impossible).toHaveLength(1);
      expect(readiness.impossible[0]).toMatchObject({ fieldKey: "refinance_amount", label: "give the refinance either a loan amount or a loan-to-value, not both or neither" });
    });

    test("both an amount and a loan-to-value is blocked", () => {
      const { readiness, input } = assemble(withRefi({ refinance_month: 24, refinance_amount: 1_200_000, refinance_ltv_pct: 65, ...takeOut }));
      expect(input).toBeNull();
      expect(readiness.status).toBe("blocked");
      expect(readiness.impossible.map((i) => i.label)).toEqual(["give the refinance either a loan amount or a loan-to-value, not both or neither"]);
    });

    test("exactly one of the two is ready, with the refinance in the input", () => {
      for (const sizing of [{ refinance_amount: 1_200_000 }, { refinance_ltv_pct: 65 }] as Record<string, number>[]) {
        const { readiness, input } = assemble(withRefi({ refinance_month: 24, ...sizing, ...takeOut }));
        expect(readiness).toMatchObject({ status: "ready", impossible: [] });
        expect(input!.refinance).toMatchObject({ month: 24 });
      }
    });

    test("a refinance month before stabilization is blocked", () => {
      // 12 months of construction and 3 of lease-up: stabilization is month 15.
      const { readiness, input } = assemble(withRefi({ refinance_month: 10, refinance_amount: 1_200_000, ...takeOut }));
      expect(input).toBeNull();
      expect(readiness.status).toBe("blocked");
      expect(readiness.impossible).toHaveLength(1);
      expect(readiness.impossible[0]).toMatchObject({ fieldKey: "refinance_month" });
      expect(readiness.impossible[0]!.label).toMatch(/^refinance month must fall from stabilization \(month 15\)/);
    });
  });
});

describe("mezzanine interest after its commitment (task 37)", () => {
  const mezzDeal = (mezz: Partial<NonNullable<EngineInput["mezzanine"]>> = {}): EngineInput => ({
    ...developmentDeal(),
    mezzanine: { amount: 5_000_000, ratePct: 11, amortYears: 30, ioMonths: 60, ...mezz },
  });
  const accrued = (r: RunResult) => metric(r, "mezz_interest_accrued");
  // What the undrawn commitment, drawn debt and accrued interest are, from the figures a run reports.
  const unusedAtS = (r: RunResult, commitments: number) => commitments - (metric(r, "total_debt").value! - accrued(r).value!);

  test("a mezzanine that fills early leaves nothing undrawn and no equity overrun", () => {
    const L = buildLedger(mezzDeal());
    const r = underwrite(mezzDeal(), POLICY_V1);
    expect(L.converged).toBe(true);
    expect(accrued(r).status).toBe("VALID");
    expect(accrued(r).unit).toBe("$");
    expect(accrued(r).value!).toBeGreaterThan(0);
    // Unused commitment is zero within half a cent. Because the solve also requires |overrun - unused| < 0.005,
    // the overrun is zero within half a cent too.
    expect(Math.abs(unusedAtS(r, L.commitments))).toBeLessThan(0.005);
    expect(L.balancesAtS.mezzanine).toBeCloseTo(5_000_000 + accrued(r).value!, 6);
    expect(L.balancesAtS.senior).toBeCloseTo(27_000_000, 2);
    expect(metric(r, "total_debt").value!).toBeCloseTo(32_000_000 + accrued(r).value!, 2);
    // Sources equal uses, with the accrued interest inside both.
    expect(L.requiredEquity + L.drawnDebtAtS).toBeCloseTo(L.tdc, 2);
    expect(metric(r, "loan_to_cost").value!).toBeCloseTo((32_000_000 / L.tdc) * 100, 6);
  });
  test("equity falls by the old undrawn amount, and by the interest it no longer pays, less the interest the extra draw carries", () => {
    // Before the change this deal needed 14,387,603.39 of equity, carried 45,287,603.38 of cost and left 1,100,000.00 of
    // senior undrawn. Equity is cost less debt at S, so its fall is the old undrawn amount, plus the mezzanine interest that
    // now accrues instead of being paid by equity, less the interest that the extra senior draw adds to the cost. Within 0.05.
    // The ramp is on so that the lease-up months carry no fixed cost (task 39) and the funding is what it was.
    const L = buildLedger({ ...mezzDeal(), leaseUpRamp: true });
    const drop = 14_387_603.39 - L.requiredEquity;
    expect(drop).toBeGreaterThan(1_100_000);
    expect(drop).toBeCloseTo(1_100_000 + L.mezzAccruedBeyondCommitment - (L.tdc - 45_287_603.38), 1);
  });
  test("the warning check says the amount, the commitment and the balance at stabilization", () => {
    const r = underwrite(mezzDeal(), POLICY_V1);
    const c = r.checks.find((k) => k.key === "mezz_interest_accrued");
    expect(c?.severity).toBe("warning");
    const x = accrued(r).value!;
    const fmt = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
    expect(c!.message).toBe(
      `Mezzanine interest of ${fmt(x)} accrues on the mezzanine balance after its ${fmt(5_000_000)} commitment is used; the mezzanine balance at stabilization is ${fmt(5_000_000 + x)}.`,
    );
    expect(c!.actual).toBeCloseTo(x, 6);
    expect(c!.expected).toBe(5_000_000);
  });
  test("the payoff at sale includes the accrued interest", () => {
    // Both loans are interest-only through the hold, so the payoff is exactly the balances at stabilization.
    const io = { ...mezzDeal({ ioMonths: 120 }), senior: { amount: 27_000_000, ratePct: 6, amortYears: 30, ioMonths: 120 } };
    const L = buildLedger(io);
    const r = underwrite(io, POLICY_V1);
    expect(accrued(r).value!).toBeGreaterThan(0);
    expect(L.payoffAtSale).toBeCloseTo(32_000_000 + accrued(r).value!, 2);
    expect(L.payoffAtSale).toBeCloseTo(metric(r, "total_debt").value!, 2);
  });
  test("a mezzanine whose loan never runs over reports 0 and adds no check", () => {
    const r = underwrite(mezzDeal({ ratePct: 0 }), POLICY_V1);
    expect(accrued(r).status).toBe("VALID");
    expect(accrued(r).value).toBe(0);
    expect(r.checks.find((k) => k.key === "mezz_interest_accrued")).toBeUndefined();
  });
  test("a senior-only deal reports the metric as not applicable, with a reason", () => {
    const r = underwrite(developmentDeal(), POLICY_V1);
    expect(accrued(r).status).toBe("NOT_APPLICABLE");
    expect(accrued(r).value).toBeNull();
    expect(accrued(r).reason).toMatch(/mezzanine/);
    expect(r.checks.find((k) => k.key === "mezz_interest_accrued")).toBeUndefined();
  });
  test("results that the change must not touch are byte for byte as pinned before it", () => {
    // Pinned on task/35-cost-credits (64925d2), before any engine change; only the new metric entry is left out.
    // Re-pinned for task 39 on 524ed85 with no lease-up (a ramp-off lease-up now carries fixed operating costs).
    const noLeaseUp = { ...developmentDeal(), leaseUpMonths: 0 };
    expect(shaWithoutMezzMetric(underwrite(noLeaseUp, POLICY_V1))).toBe("52ca18ae941f2ccfa5699882c2de0aff37fce23dae690434d9d33e025a7aa12f");
    // The stresses are left out of the second: a +150 bps rate stress lifts a 0% mezzanine to 1.5%, and that one does accrue.
    expect(shaWithoutMezzMetric(underwrite({ ...mezzDeal({ ratePct: 0 }), leaseUpMonths: 0 }, { ...POLICY_V1, stresses: [] }))).toBe("44159eaa9a5377ffa49b9ca857113656ec4fa12aa2d7854a15bd84420f105f95");
  });
  test("overrun and unused commitment never coexist, over a grid of sizes, rates and lengths", () => {
    for (const amount of [500_000, 2_000_000, 5_000_000, 9_000_000]) {
      for (const ratePct of [4, 8, 12, 18]) {
        for (const constructionMonths of [6, 18, 30]) {
          for (const leaseUpMonths of [0, 12]) {
            const deal = { ...mezzDeal({ amount, ratePct }), constructionMonths, leaseUpMonths };
            const L = buildLedger(deal);
            const r = underwrite(deal, POLICY_V1);
            const label = JSON.stringify({ amount, ratePct, constructionMonths, leaseUpMonths });
            expect(L.converged, label).toBe(true);
            if (L.requiredEquity > 0.005) expect(Math.abs(unusedAtS(r, L.commitments)), label).toBeLessThan(0.005);
            expect(r.checks.find((k) => k.key === "funding_not_converged"), label).toBeUndefined();
          }
        }
      }
    }
  });
  test("none of the six oracle deals has a mezzanine loan, so none can change", () => {
    const dir = join(import.meta.dirname, "../../../oracles/deals");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(6);
    for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/mezz/i);
  });
});

describe("fixed operating costs during lease-up, shortfall and interest-only coverage (cards 39 and 40)", () => {
  const NEW_METRICS = ["leaseup_operating_cost", "cumulative_cash_shortfall", "io_dscr_year1"];
  /** The hash of a result as the engine produced it before task 39: its three new metric entries are left out. */
  const shaWithoutTask39Metrics = (r: RunResult) => {
    const plain = { ...r, scenarios: r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => !NEW_METRICS.includes(m.key)) })) };
    return createHash("sha256").update(canonicalJson(plain)).digest("hex");
  };
  const fixedDeal = (over: Partial<EngineInput> = {}): EngineInput => {
    const { expenseRatioPct: _ratio, ...rest } = developmentDeal();
    return { ...rest, leaseUpMonths: 6, fixedOpexAnnual: 120_000, ...over };
  };
  // Before task 39, measured on 524ed85 for the same deals with 6 months of lease-up and the ramp off.
  const OLD = { tdc: 43_517_532.19226421, capitalizedInterest: 1_617_532.1922642032, noi: 3_291_600 };

  test("ramp off, 6 months, $120,000 a year of fixed cost: half a year is charged before stabilization", () => {
    const r = underwrite(fixedDeal(), POLICY_V1);
    const L = buildLedger(fixedDeal());
    expect(metric(r, "leaseup_operating_cost").status).toBe("VALID");
    expect(metric(r, "leaseup_operating_cost").unit).toBe("$");
    expect(metric(r, "leaseup_operating_cost").value!).toBeCloseTo(60_000, 2);
    // Identity: TDC = costs before financing + capitalized interest + lease-up operating cost. It rises by the 60,000 plus the
    // change in capitalized interest (the equity pays for more of the build, so the debt is drawn later and that change is
    // here a small fall), and the NOI is untouched.
    const capInt = metric(r, "capitalized_interest").value!;
    expect(metric(r, "hard_and_soft_cost").value!).toBeCloseTo(41_900_000, 2);
    expect(metric(r, "total_development_cost").value!).toBeCloseTo(41_900_000 + capInt + 60_000, 2);
    expect(metric(r, "total_development_cost").value! - OLD.tdc).toBeCloseTo(60_000 + (capInt - OLD.capitalizedInterest), 2);
    expect(metric(r, "stabilized_noi").value!).toBeCloseTo(OLD.noi, 6);
    // The months before stabilization carry it as a cost, and the hold-year cash flows never see it.
    const leaseUp = L.rows.filter((x) => x.phase === "lease_up");
    expect(leaseUp).toHaveLength(6);
    for (const x of leaseUp) expect(x.costDraw).toBeCloseTo(10_000, 2);
    expect(L.annual[0]!.opex).toBe(0);
    expect(L.annual[1]!.opex).toBeCloseTo(120_000, 6);
    // Sources equal uses.
    expect(L.requiredEquity + L.drawnDebtAtS).toBeCloseTo(L.tdc, 2);
  });
  test("the expense-ratio form charges the fixed dollars of decision 8, at year-1 levels", () => {
    // 35% of year-1 stabilized EGI: (60 x 2,200 + 50 x 2,600 + 10 x 3,200) x 12 x 95% + 60,000 = 3,411,600; x 35% = 1,194,060.
    const deal = { ...developmentDeal(), leaseUpMonths: 6 };
    const r = underwrite(deal, POLICY_V1);
    const L = buildLedger(deal);
    expect(metric(r, "leaseup_operating_cost").value!).toBeCloseTo(1_194_060 / 2, 2);
    expect(metric(r, "total_development_cost").value! - OLD.tdc).toBeCloseTo(597_030 + (metric(r, "capitalized_interest").value! - OLD.capitalizedInterest), 2);
    expect(metric(r, "stabilized_noi").value!).toBeCloseTo(2_217_540, 6);
    expect(L.requiredEquity + L.drawnDebtAtS).toBeCloseTo(L.tdc, 2);
  });
  test("variable costs follow income, so with the ramp off there are none before stabilization", () => {
    const withVariable = fixedDeal({ variableExpensePct: 8 });
    expect(metric(underwrite(withVariable, POLICY_V1), "leaseup_operating_cost").value!).toBeCloseTo(60_000, 2);
  });
  test("ramp on is byte for byte as before: the fixed costs were already netted against lease-up income", () => {
    // Pinned on 524ed85 (task/38-breakeven); only the three new metric entries are left out.
    const ratio = { ...developmentDeal(), leaseUpRamp: true };
    expect(shaWithoutTask39Metrics(underwrite(ratio, POLICY_V1))).toBe("d061c6a84d41bd531ba5f5957a865e330449ef066699f30e07d6af561b77f211");
    const fixedVar = { ...fixedDeal({ variableExpensePct: 5, fixedOpexAnnual: 900_000, leaseUpMonths: 12 }), leaseUpRamp: true };
    expect(shaWithoutTask39Metrics(underwrite(fixedVar, POLICY_V1))).toBe("1317131338a1b7742402a0c2d3772a719ad1bbf976997b44fa2e36c86273c802");
  });
  test("lease-up of 0 months is byte for byte as before, and the metric is not applicable", () => {
    const zero = { ...developmentDeal(), leaseUpMonths: 0 };
    const r = underwrite(zero, POLICY_V1);
    expect(shaWithoutTask39Metrics(r)).toBe("180479630a80ebf566e9ddaeadf45defdc2f0f08e7de51c68d8c887d78a5d4e5");
    expect(shaWithoutTask39Metrics(underwrite(allEquityDeal(), POLICY_V1))).toBe("4b1aa853505ea0ed888f41c3cd57d61f87072f61a70ce399d8782e3724f33938");
    expect(metric(r, "leaseup_operating_cost").status).toBe("NOT_APPLICABLE");
    expect(metric(r, "leaseup_operating_cost").value).toBeNull();
    expect(metric(r, "leaseup_operating_cost").reason).toMatch(/lease-up/i);
  });
  test("zero fixed costs give a real 0, not an unknown", () => {
    const r = underwrite({ ...developmentDeal(), expenseRatioPct: 0 }, POLICY_V1);
    expect(metric(r, "leaseup_operating_cost").status).toBe("VALID");
    expect(metric(r, "leaseup_operating_cost").value).toBe(0);
  });

  // 800,000 of senior debt at 24%, interest-only for the 12 months of year 1, on 1,000,000 of land: debt service is 16,000 a
  // month against 10,000 of rent in year 1; rent doubles in year 2 (20,000 a month), when the level payment is still under it.
  const strained = (): EngineInput => ({
    ...allEquityDeal(),
    holdYears: 2,
    rentGrowthPct: 100,
    senior: { amount: 800_000, ratePct: 24, amortYears: 30, ioMonths: 12 },
  });
  test("cumulative cash shortfall is the sum of the negative monthly cash flows after debt service, as a positive amount", () => {
    const r = underwrite(strained(), POLICY_V1);
    expect(metric(r, "cumulative_cash_shortfall").status).toBe("VALID");
    expect(metric(r, "cumulative_cash_shortfall").unit).toBe("$");
    expect(metric(r, "cumulative_cash_shortfall").value!).toBeCloseTo(12 * (16_000 - 10_000), 2);
    // The ledger agrees, month by month.
    const L = buildLedger(strained());
    const deficits = L.rows.filter((x) => x.month >= L.S && x.noi - x.debtService < 0).map((x) => x.debtService - x.noi);
    expect(deficits).toHaveLength(12);
    expect(total(deficits)).toBeCloseTo(72_000, 2);
  });
  test("a healthy deal has a shortfall of exactly 0, which is a real value", () => {
    for (const deal of [allEquityDeal(), developmentDeal()]) {
      const r = underwrite(deal, POLICY_V1);
      expect(metric(r, "cumulative_cash_shortfall").status).toBe("VALID");
      expect(metric(r, "cumulative_cash_shortfall").value).toBe(0);
    }
  });
  test("months before stabilization never count toward the shortfall", () => {
    // Ramp on, 12 months of lease-up with income far below the fixed costs: the lease-up deficit is not a shortfall.
    // Fixed costs of 1.9m against about 1.7m of ramped income over the lease-up (a loss), and 1.51m of year-1 NOI against 1.2m of interest.
    const deal = {
      ...developmentDeal(),
      leaseUpRamp: true,
      fixedOpexAnnual: 1_900_000,
      expenseRatioPct: undefined,
      senior: { amount: 20_000_000, ratePct: 6, amortYears: 30, ioMonths: 36 },
    } as EngineInput;
    expect(buildLedger(deal).annual[0]!.noi).toBeLessThan(0);
    expect(metric(underwrite(deal, POLICY_V1), "cumulative_cash_shortfall").value).toBe(0);
  });
  test("interest-only DSCR is year-1 NOI over interest at the rates on the balances in force at stabilization", () => {
    // 120,000 / (800,000 x 24%) = 0.625.
    const r = underwrite(strained(), POLICY_V1);
    expect(metric(r, "io_dscr_year1").unit).toBe("x");
    expect(metric(r, "io_dscr_year1").value!).toBeCloseTo(0.625, 9);
    // With a mezzanine loan: balances at stabilization at their own rates.
    const mezz: EngineInput = { ...developmentDeal(), mezzanine: { amount: 5_000_000, ratePct: 11, amortYears: 30, ioMonths: 60 } };
    const L = buildLedger(mezz);
    const rm = underwrite(mezz, POLICY_V1);
    const interest = (L.balancesAtS.senior * 6) / 100 + (L.balancesAtS.mezzanine * 11) / 100;
    expect(metric(rm, "io_dscr_year1").value!).toBeCloseTo(L.year1.noi / interest, 9);
  });
  test("interest-only DSCR is not applicable with no debt, with a reason", () => {
    const r = underwrite(allEquityDeal(), POLICY_V1);
    expect(metric(r, "io_dscr_year1").status).toBe("NOT_APPLICABLE");
    expect(metric(r, "io_dscr_year1").value).toBeNull();
    expect(metric(r, "io_dscr_year1").reason).toMatch(/no debt/i);
  });
  test("the new metrics carry a formula", () => {
    for (const k of NEW_METRICS) expect(metric(underwrite(developmentDeal(), POLICY_V1), k).formula.length).toBeGreaterThan(10);
  });
});

function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

describe("exit by refinancing and holding (card 60)", () => {
  const POLICY_V1_HASH = "9f95780101a9ecfe6444c47dd319c1cb8d77251d60700a1a4dde1733055296b9";
  const sha = (x: unknown) => createHash("sha256").update(canonicalJson(x)).digest("hex");
  const HOLD_METRICS = ["refinance_cash_returned", "cash_left_in_deal", "dcr_after_refinance", "cash_on_cash_after_refinance", "stated_value", "unrealized_equity_multiple", "unrealized_equity_irr"];
  const SALE_METRICS = ["exit_value", "net_sale_proceeds", "development_profit", "profit_on_cost", "equity_multiple", "equity_irr", "sale_month", "lp_irr", "gp_irr", "gp_promote"];
  const NOT_SOLD = "The deal is kept and refinanced, not sold.";
  const v = (r: RunResult, key: string, scenario = "base") => metric(r, key, scenario).value!;

  /**
   * An invented rental with no build (stabilized at month 0), all rates 0% so the arithmetic is exact.
   * Rent 10 x 1,000 x 12 = 120,000 less fixed costs 20,000 gives NOI 100,000 a year, flat. Land 1,000,000 is
   * paid at month 0 with a senior loan of 600,000 (20-year amortization, so 2,500 a month, 30,000 a year);
   * equity is 400,000. Hold 3 years, so the end of the hold T is month 35. Exit cap 10%.
   */
  const rental = (refinance: NonNullable<EngineInput["refinance"]>, extra: Partial<EngineInput> = {}): EngineInput => ({
    budget: { land: 1_000_000, hard: 0, soft: 0, contingency: 0, other: 0 },
    revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 1_000 }],
    otherIncomeAnnual: 0,
    constructionMonths: 0,
    leaseUpMonths: 0,
    holdYears: 3,
    stabilizedOccupancyPct: 100,
    fixedOpexAnnual: 20_000,
    rentGrowthPct: 0,
    expenseGrowthPct: 0,
    leaseUpRamp: false,
    sCurveDraws: false,
    exitCapPct: 10,
    sellingCostsPct: 0,
    senior: { amount: 600_000, ratePct: 0, amortYears: 20, ioMonths: 0 },
    refinance,
    exit: "refinance_hold",
    stated: {},
    ...extra,
  });
  const byAmount = () => rental({ month: 12, amount: 800_000, ratePct: 0, amortYears: 20, ioMonths: 0 });
  const byLtv = () => rental({ month: 12, ltvPct: 75, ratePct: 0, amortYears: 20, ioMonths: 0 });
  const npv = (rate: number, flows: [number, number][]) => flows.reduce((a, [t, amt]) => a + amt / Math.pow(1 + rate, t), 0);

  describe("an interest-only construction loan is sized on what it pays (task 72)", () => {
    const insured = POLICIES["rental-hold-insured-draft"]!;
    const ioDeal = (amortYears?: number, ratePct = 6): EngineInput => {
      const base = byAmount();
      return { ...base, senior: { amount: 600_000, ratePct, ioMonths: 12, ...(amortYears === undefined ? {} : { amortYears }) }, refinance: { ...base.refinance!, insurancePremiumPct: 4 } };
    };
    test.each([
      ["conventional hold", byAmount(), "rental-hold-draft"],
      ["insured hold", ioDeal(30), "rental-hold-insured-draft"],
      ["sale", { ...ioDeal(30), exit: undefined }, "policy-v1"],
    ] as const)("policyFor selects %s", (_name, input, version) => {
      expect(policyFor(input).version).toBe(version);
    });

    test("this build has policy v1 (pinned) and the two held drafts", () => {
      expect(Object.keys(POLICIES)).toEqual(["policy-v1", "rental-hold-draft", "rental-hold-insured-draft"]);
      expect(sha(POLICIES["policy-v1"])).toBe("9f95780101a9ecfe6444c47dd319c1cb8d77251d60700a1a4dde1733055296b9");
    });

    test.each([6, 0])("every scenario, gate and check is invariant to 20/30/40/absent amortization at senior rate %s", (rate) => {
      const runs = [20, 30, 40, undefined].map((amort) => underwrite(ioDeal(amort, rate), insured));
      for (const run of runs.slice(1)) {
        expect(run.scenarios).toEqual(runs[0]!.scenarios);
        expect(run.verdict.gates).toEqual(runs[0]!.verdict.gates);
        expect(run.checks).toEqual(runs[0]!.checks);
      }
      const input = ioDeal(20, rate);
      const noi = input.revenue[0]!.units * input.revenue[0]!.rentMonthly! * 12 - input.fixedOpexAnnual!;
      const interest = input.senior.amount * input.senior.ratePct / 100 / 12;
      // The original zero-rate fixture has no interest due: preserve the existing null-ratio convention.
      if (interest === 0) expect(v(runs[0]!, "senior_dscr_year1")).toBeNull();
      else expect(v(runs[0]!, "senior_dscr_year1")).toBeCloseTo(noi / (12 * interest), 9);
      expect(runs[0]!.checks.some((c) => c.severity === "error")).toBe(false);
    });

    // Audit of card 72: a delay that needs the absent amortization is not computable in the tornado and grid, never a crash.
    test("audit of card 72: the tornado and grid size like the run and survive absent amortization", () => {
      const run = underwrite(ioDeal(undefined), insured);
      const t = tornado(ioDeal(undefined), "senior_dscr_year1");
      expect(t.base).toBe(v(run, "senior_dscr_year1"));
      expect(tornado(ioDeal(30), "senior_dscr_year1").base).toBe(t.base);
      // A longer construction moves the refinance past the IO period, so the loan would amortize on terms nobody stated.
      expect(t.rows.find((r) => r.driver === "constructionMonths")!.high).toBeNull();
      const g = grid(ioDeal(undefined), "senior_dscr_year1", "rentPct", "constructionMonths", 3);
      expect(g.cells[1]![1]).toBe(t.base);
      expect(g.cells[2]!.every((c) => c === null)).toBe(true);
    });

    test("when IO ends before refinance the senior is sized on its amortizing payment", () => {
      const input = ioDeal(30);
      input.senior.ioMonths = 11;
      expect(v(underwrite(input, insured), "senior_dscr_year1")).toBeCloseTo(100_000 / (levelPayment(600_000, 6, 360) * 12), 9);
    });

    test("missing amortization that the ledger needs rejects with an error check", () => {
      const input = ioDeal();
      input.senior.ioMonths = 11;
      const run = underwrite(input, insured);
      expect(run.verdict.code).toBe("REJECT");
      expect(run.checks).toContainEqual(expect.objectContaining({ key: "senior_amortization_missing", severity: "error" }));
      expect(run.scenarios.flatMap((s) => s.metrics).every((m) => m.value === null || Number.isFinite(m.value))).toBe(true);
    });

    test("a sale with IO through refinance still uses the amortizing sizing in every scenario", () => {
      const input = { ...ioDeal(20), exit: undefined };
      const run = underwrite(input, policyFor(input));
      expect(run).toEqual(underwrite(input, POLICY_V1));
      expect(v(run, "senior_dscr_year1")).toBeCloseTo(100_000 / (levelPayment(600_000, 6, 240) * 12), 9);
    });
  });

  describe("insured base-case floor (task 70)", () => {
    test("the insured draft is selected for a premium, and its gate and warning floors are 1.10x", () => {
      const base = byAmount();
      const input = { ...base, refinance: { ...base.refinance!, insurancePremiumPct: 4 } };
      expect(policyFor(input)).toBe(RENTAL_HOLD_INSURED_DRAFT);
      expect(RENTAL_HOLD_INSURED_DRAFT.baseSizingDscrFloor).toBe(1.1);
      expect(RENTAL_HOLD_INSURED_DRAFT.gates.dcrAfterRefinanceMin).toBe(1.1);
    });

    test("base sizing between 1.10x and 1.20x warns only on the conventional held deal", () => {
      const base = byAmount();
      const conventional: EngineInput = { ...base, refinance: { ...base.refinance!, month: 0 }, revenue: base.revenue.map((r) => ({ ...r, rentMonthly: 560 })) };
      const insured: EngineInput = { ...conventional, refinance: { ...conventional.refinance!, insurancePremiumPct: 4 } };
      const insuredRun = underwrite(insured, policyFor(insured));
      const conventionalRun = underwrite(conventional, policyFor(conventional));
      for (const run of [insuredRun, conventionalRun]) {
        expect(v(run, "sizing_dscr")).toBeGreaterThan(1.1);
        expect(v(run, "sizing_dscr")).toBeLessThan(1.2);
      }
      expect(insuredRun.checks.some((c) => c.key === "base_sizing_dscr")).toBe(false);
      expect(conventionalRun.checks.find((c) => c.key === "base_sizing_dscr")).toMatchObject({ severity: "warning", expected: 1.2, message: expect.stringContaining("under the 1.20x floor") });
    });
  });

  test("a refinance by amount: every hold metric equals its hand computation", () => {
    const r = underwrite(byAmount(), policyFor(byAmount()));
    // Senior balance at month 12 (twelve payments of 2,500 made in months 0 to 11): 600,000 - 30,000 = 570,000.
    // Cash returned = 800,000 - 570,000 = 230,000. Cash left = 400,000 - 230,000 = 170,000.
    expect(v(r, "refinance_cash_returned")).toBeCloseTo(230_000, 6);
    expect(v(r, "cash_left_in_deal")).toBeCloseTo(170_000, 6);
    // Months 12 to 23: NOI 100,000; sizing debt service 800,000 / 240 x 12 = 40,000. DCR = 100,000 / 40,000 = 2.5.
    expect(v(r, "dcr_after_refinance")).toBeCloseTo(2.5, 9);
    // Debt service actually due in those months is also 40,000: (100,000 - 40,000) / 170,000 = 35.2941...%.
    expect(v(r, "cash_on_cash_after_refinance")).toBeCloseTo((60_000 / 170_000) * 100, 9);
    // Stated value = final-year NOI 100,000 / 10% = 1,000,000, no selling costs.
    expect(v(r, "stated_value")).toBeCloseTo(1_000_000, 6);
    // Debt at T: 800,000 - 24 x 3,333.33 = 720,000. Unrealized flow = 1,000,000 - 720,000 = 280,000.
    // Distributions: 230,000 + 70,000 (year 1: 100,000 - 30,000) + 60,000 + 60,000 + 280,000 = 700,000; contributions 400,000.
    expect(v(r, "unrealized_equity_multiple")).toBeCloseTo(1.75, 9);
    // The IRR is the rate at which the dated flows net to zero.
    const flows: [number, number][] = [[0, -400_000], [1, 230_000 + 70_000], [2, 60_000], [3, 60_000 + 280_000]];
    expect(npv(v(r, "unrealized_equity_irr") / 100, flows)).toBeCloseTo(0, 4);
    expect(metric(r, "unrealized_equity_multiple").unit).toBe("x");
    expect(metric(r, "stated_value").label).toMatch(/unrealized, not a sale/i);
    expect(metric(r, "unrealized_equity_multiple").label).toMatch(/unrealized, not a sale/i);
    expect(metric(r, "unrealized_equity_irr").label).toMatch(/unrealized, not a sale/i);
  });

  test("a refinance by loan-to-value: the loan is the share of the forward value", () => {
    const r = underwrite(byLtv(), policyFor(byLtv()));
    // Forward NOI (months 12 to 23) 100,000 / 10% = 1,000,000 value; 75% gives a loan of 750,000.
    // Cash returned = 750,000 - 570,000 = 180,000. Cash left = 400,000 - 180,000 = 220,000.
    expect(v(r, "refinance_cash_returned")).toBeCloseTo(180_000, 6);
    expect(v(r, "cash_left_in_deal")).toBeCloseTo(220_000, 6);
    // Sizing debt service 750,000 / 240 x 12 = 37,500: DCR = 100,000 / 37,500 = 2.6667.
    expect(v(r, "dcr_after_refinance")).toBeCloseTo(100_000 / 37_500, 9);
    // (100,000 - 37,500) / 220,000 = 28.4091...%.
    expect(v(r, "cash_on_cash_after_refinance")).toBeCloseTo((62_500 / 220_000) * 100, 9);
    // Debt at T: 750,000 - 24 x 3,125 = 675,000; unrealized flow 325,000. Distributions 180,000 + 70,000 + 62,500 + 62,500 + 325,000 = 700,000.
    expect(v(r, "unrealized_equity_multiple")).toBeCloseTo(1.75, 9);
    const flows: [number, number][] = [[0, -400_000], [1, 180_000 + 70_000], [2, 62_500], [3, 62_500 + 325_000]];
    expect(npv(v(r, "unrealized_equity_irr") / 100, flows)).toBeCloseTo(0, 4);
  });

  test("an exit-cap shock moves both the loan sized by loan-to-value and the stated value", () => {
    const r = underwrite(byLtv(), policyFor(byLtv()));
    // Cap 10.75%: value 100,000 / 0.1075 = 930,232.56; loan 75% = 697,674.42; cash returned = 697,674.42 - 570,000.
    expect(v(r, "stated_value", "exit_cap")).toBeCloseTo(100_000 / 0.1075, 4);
    expect(v(r, "refinance_cash_returned", "exit_cap")).toBeCloseTo(0.75 * (100_000 / 0.1075) - 570_000, 4);
    expect(r.scenarios.map((s) => s.key)).toEqual(["base", "exit_cap", "cost", "rate", "rent", "occupancy", "expense", "combined"]);
    for (const s of r.scenarios) for (const k of HOLD_METRICS) expect(s.metrics.some((m) => m.key === k), `${s.key} ${k}`).toBe(true);
  });

  test("there is no sale flow and exactly one unrealized flow, at the end of the hold", () => {
    const r = underwrite(byAmount(), policyFor(byAmount()));
    expect(r.equityFlows.filter((f) => f.kind === ("sale" as string))).toEqual([]);
    const un = r.equityFlows.filter((f) => f.kind === ("unrealized" as string));
    expect(un).toHaveLength(1);
    expect(un[0]).toMatchObject({ month: 35, t: 3 });
    expect(un[0]!.amount).toBeCloseTo(280_000, 6);
    expect(r.ledger.every((row) => row.saleNet === 0)).toBe(true);
    expect(r.checks.map((c) => c.key)).not.toContain("equity_wipeout");
  });

  test("the sale metrics are not applicable with the reason, never 0", () => {
    const base = underwrite(byAmount(), policyFor(byAmount()));
    const waterfall = underwrite({ ...byAmount(), waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } }, policyFor(byAmount()));
    for (const r of [base, waterfall]) {
      for (const s of r.scenarios) {
        for (const k of SALE_METRICS) {
          const m = metric(r, k, s.key);
          expect([m.status, m.value, m.reason], `${s.key} ${k}`).toEqual(["NOT_APPLICABLE", null, NOT_SOLD]);
        }
      }
    }
  });

  test("the hold metrics are appended after every existing metric, in order, and the others are computed as before", () => {
    const r = underwrite(byAmount(), policyFor(byAmount()));
    const keys = r.scenarios[0]!.metrics.map((m) => m.key);
    expect(keys.slice(-HOLD_METRICS.length)).toEqual(HOLD_METRICS);
    expect(METRICS.map((m) => m.key).slice(-HOLD_METRICS.length)).toEqual(HOLD_METRICS);
    // Everything up to T is the same ledger as the sale of the same deal, with the same metrics in the same places.
    const { exit: _e, ...asSale } = byAmount();
    const sold = underwrite(asSale, POLICY_V1);
    expect(keys.slice(0, -HOLD_METRICS.length)).toEqual(sold.scenarios[0]!.metrics.map((m) => m.key));
    expect(r.annual).toEqual(sold.annual);
    for (const k of ["total_development_cost", "required_equity", "stabilized_noi", "sizing_dscr", "contractual_dscr", "refinance_net_proceeds", "debt_yield", "cumulative_cash_shortfall"]) {
      expect(metric(r, k), k).toEqual(metric(sold, k));
    }
  });

  test("when all the equity has come back, cash-on-cash after refinance is not meaningful, with its reason", () => {
    const input = rental({ month: 12, amount: 1_200_000, ratePct: 0, amortYears: 20, ioMonths: 0 });
    const r = underwrite(input, policyFor(input));
    // Cash returned = 1,200,000 - 570,000 = 630,000; cash left = 400,000 - 630,000 = -230,000.
    expect(v(r, "cash_left_in_deal")).toBeCloseTo(-230_000, 6);
    const m = metric(r, "cash_on_cash_after_refinance");
    expect([m.status, m.value]).toEqual(["NOT_MEANINGFUL", null]);
    expect(m.reason).toMatch(/cash left in the deal/i);
  });

  test("with fewer than 12 months left the window is the months that remain, scaled to a year, and the reason says so", () => {
    const input = rental({ month: 30, amount: 800_000, ratePct: 0, amortYears: 20, ioMonths: 0 });
    const r = underwrite(input, policyFor(input));
    // Months 30 to 35 are 6 months. Senior balance at 30: 600,000 - 30 x 2,500 = 525,000; cash returned 275,000; cash left 125,000.
    // NOI 6 x 8,333.33 = 50,000; sizing debt service 6 x 3,333.33 = 20,000: DCR 2.5. Scaled: (50,000 - 20,000) x 12 / 6 = 60,000 / 125,000 = 48%.
    expect(v(r, "cash_left_in_deal")).toBeCloseTo(125_000, 6);
    expect(v(r, "dcr_after_refinance")).toBeCloseTo(2.5, 9);
    expect(v(r, "cash_on_cash_after_refinance")).toBeCloseTo(48, 9);
    expect(metric(r, "cash_on_cash_after_refinance").reason).toMatch(/Only 6 months remain/);
    expect(metric(r, "dcr_after_refinance").reason).toMatch(/Only 6 months remain/);
  });

  test("a stated value below the debt fires the wipeout check with the hold message, and the unrealized flow is 0", () => {
    const input = { ...byAmount(), exitCapPct: 50 };
    const r = underwrite(input, policyFor(input));
    // Stated value 100,000 / 50% = 200,000; debt outstanding at T is 720,000.
    const c = r.checks.find((k) => k.key === "equity_wipeout")!;
    expect(c.severity).toBe("error");
    expect(c.message).toBe("The stated value of $200,000 does not cover the $720,000 of debt outstanding. Equity has no value at the end of the hold.");
    const un = r.equityFlows.filter((f) => f.kind === ("unrealized" as string));
    expect(un).toHaveLength(1);
    expect(un[0]!.amount).toBe(0);
    expect(r.verdict.code).toBe("REJECT");
  });

  test("a stated value with no positive NOI is not meaningful, with no unrealized flow", () => {
    const input = { ...byAmount(), fixedOpexAnnual: 130_000 };
    const r = underwrite(input, policyFor(input));
    for (const k of ["stated_value", "unrealized_equity_multiple", "unrealized_equity_irr"]) expect(metric(r, k).status, k).toBe("NOT_MEANINGFUL");
    expect(r.equityFlows.filter((f) => f.kind === ("unrealized" as string))).toEqual([]);
  });

  test("the engine refuses hold mode with no refinance", () => {
    const { refinance: _r, ...none } = byAmount();
    expect(() => underwrite(none, policyFor(none))).toThrow(EngineInputError);
    expect(() => validateInput(none)).toThrow(/needs its refinance/);
  });

  describe("readiness", () => {
    const rows = (fields: Record<string, number>) => {
      const all: Record<string, number> = {
        land_cost: 1_000_000, hard_cost: 0, soft_cost: 0, contingency: 0, construction_months: 0, lease_up_months: 0, hold_years: 3,
        stabilized_occupancy_pct: 100, fixed_opex_annual: 20_000, exit_cap_rate_pct: 10, selling_costs_pct: 0,
        senior_loan_amount: 600_000, senior_rate_pct: 0, senior_amort_years: 20, ...fields,
      };
      return [
        ...Object.entries(all).map(([fieldKey, valueNumeric]) => ({ fieldKey, itemKey: null, status: "approved" as AssumptionStatus, valueNumeric })),
        { fieldKey: "unit_count", itemKey: "A", status: "approved" as AssumptionStatus, valueNumeric: 10 },
        { fieldKey: "unit_rent_monthly", itemKey: "A", status: "approved" as AssumptionStatus, valueNumeric: 1_000 },
      ];
    };
    const refi = { refinance_month: 12, refinance_amount: 800_000, refinance_rate_pct: 0, refinance_amort_years: 20 };

    test.each([
      ["IO through refinance", 12, 1, false],
      ["IO ends early", 11, 1, true],
      ["sale with a refinance", 12, 0, true],
    ] as const)("senior amortization readiness for %s (task 72)", (_name, io, held, required) => {
      const values = rows({ ...refi, refinance_and_hold: held, senior_io_months: io }).filter((r) => r.fieldKey !== "senior_amort_years");
      const result = assemble(values);
      expect(result.readiness.missing.some((m) => m.fieldKey === "senior_amort_years")).toBe(required);
      expect(result.readiness.status).toBe(required ? "blocked" : "ready");
      if (!required) expect(Object.hasOwn(result.input!.senior, "amortYears")).toBe(false);
    });

    test("the flag is a field: optional, a review choice, never read from a document", () => {
      const d = FIELD_BY_KEY.get("refinance_and_hold")!;
      expect(d).toMatchObject({ label: "Keep and refinance (no sale)", group: "refinance", unit: "flag", min: 0, max: 1, integer: true, required: false, material: true, conservative: null, extractable: false });
      expect(d.absentMeans).toBe("the deal is sold at the end of the hold");
      expect(d.aliases).toEqual(expect.arrayContaining(["refinance and hold", "keep and refinance", "conserver et refinancer"]));
    });

    test("with the flag at 1 the input says so and readiness is ready", () => {
      const { readiness, input } = assemble(rows({ ...refi, refinance_and_hold: 1 }));
      expect(readiness.status).toBe("ready");
      expect(input!.exit).toBe("refinance_hold");
      expect(policyFor(input!).version).toBe("rental-hold-draft");
    });

    test("with the flag at 0 or absent the key is absent, so the input hashes as before", () => {
      const absent = assemble(rows(refi)).input!;
      const zero = assemble(rows({ ...refi, refinance_and_hold: 0 })).input!;
      expect("exit" in absent).toBe(false);
      expect("exit" in zero).toBe(false);
      expect(sha(zero)).toBe(sha(absent));
      expect(policyFor(zero)).toBe(POLICY_V1);
    });

    test("hold mode without a refinance month is blocked, and the problem points at the refinance month", () => {
      const { readiness, input } = assemble(rows({ refinance_and_hold: 1 }));
      expect(input).toBeNull();
      expect(readiness.status).toBe("blocked");
      expect(readiness.impossible).toHaveLength(1);
      expect(readiness.impossible[0]).toMatchObject({
        fieldKey: "refinance_month",
        label: "A deal that is kept and refinanced needs its refinance: the month, the amount or loan-to-value, the rate and the amortization.",
      });
    });

    test("the existing refinance rules still apply in hold mode", () => {
      const both = assemble(rows({ ...refi, refinance_ltv_pct: 65, refinance_and_hold: 1 }));
      expect(both.input).toBeNull();
      expect(both.readiness.impossible.map((i) => i.fieldKey)).toEqual(["refinance_amount"]);
      const early = assemble(rows({ ...refi, refinance_month: 0, refinance_and_hold: 1 }));
      expect(early.input).toBeNull();
    });
  });

  describe("policy", () => {
    test.each([
      ["a held deal with premium 4", { ...byAmount(), refinance: { ...byAmount().refinance!, insurancePremiumPct: 4 } }, "rental-hold-insured-draft"],
      ["a held deal without a premium", byAmount(), "rental-hold-draft"],
      ["a held deal with premium 0", { ...byAmount(), refinance: { ...byAmount().refinance!, insurancePremiumPct: 0 } }, "rental-hold-draft"],
      ["a held deal without refinance", { ...byAmount(), refinance: undefined }, "rental-hold-draft"],
      ["a sale deal with premium 4", { ...byAmount(), exit: undefined, refinance: { ...byAmount().refinance!, insurancePremiumPct: 4 } }, "policy-v1"],
    ] as const)("policyFor selects the policy for %s (task 67)", (_label, input, version) => {
      expect(policyFor(input).version).toBe(version);
    });

    test("the insured draft changes only its version and its two 1.10x floors, and is registered (task 67)", () => {
      expect(RENTAL_HOLD_INSURED_DRAFT).toEqual({
        ...RENTAL_HOLD_DRAFT,
        version: "rental-hold-insured-draft",
        gates: { ...RENTAL_HOLD_DRAFT.gates, dcrAfterRefinanceMin: 1.1 },
        baseSizingDscrFloor: 1.1,
      });
      expect(POLICIES["rental-hold-insured-draft"]).toBe(RENTAL_HOLD_INSURED_DRAFT);
    });

    test("the insured refinance clears its DCR gate while the same conventional refinance fails (task 67)", () => {
      const base = byAmount();
      // Tuned only rentMonthly from 1,000 to 560: NOI = 47,200. With premium 4%, DCR = 47,200 / 41,600 = 1.1346153846;
      // without the premium, DCR = 47,200 / 40,000 = 1.18. Both are strictly between 1.10 and 1.20.
      const conventional: EngineInput = { ...base, revenue: base.revenue.map((r) => ({ ...r, rentMonthly: 560 })) };
      const insured: EngineInput = { ...conventional, refinance: { ...conventional.refinance!, insurancePremiumPct: 4 } };
      const insuredRun = underwrite(insured, policyFor(insured));
      const conventionalRun = underwrite(conventional, policyFor(conventional));
      const insuredDcr = v(insuredRun, "dcr_after_refinance");
      const conventionalDcr = v(conventionalRun, "dcr_after_refinance");
      expect(insuredDcr).toBeCloseTo(47_200 / 41_600, 9);
      expect(conventionalDcr).toBeCloseTo(1.18, 9);
      for (const dcr of [insuredDcr, conventionalDcr]) {
        expect(dcr).toBeGreaterThan(1.1);
        expect(dcr).toBeLessThan(1.2);
      }
      expect(conventionalDcr).toBeGreaterThanOrEqual(insuredDcr);
      expect(insuredRun.policyVersion).toBe("rental-hold-insured-draft");
      expect(insuredRun.verdict.gates.find((g) => g.key === "dcr_after_refinance")).toMatchObject({ threshold: 1.1, status: "passed" });
      expect(conventionalRun.policyVersion).toBe("rental-hold-draft");
      expect(conventionalRun.verdict.gates.find((g) => g.key === "dcr_after_refinance")).toMatchObject({ threshold: 1.2, status: "failed" });
    });

    test("policy v1 is byte for byte what it was: its hash is pinned and it has no draft key", () => {
      expect(sha(POLICY_V1)).toBe(POLICY_V1_HASH);
      expect("draft" in POLICY_V1).toBe(false);
      expect(POLICY_V1.version).toBe("policy-v1");
    });

    test("the draft takes v1's rules and has four gates, with proposed thresholds", () => {
      expect(RENTAL_HOLD_DRAFT.version).toBe("rental-hold-draft");
      expect(RENTAL_HOLD_DRAFT.draft).toBe(true);
      for (const k of ["stresses", "maxLtcPct", "baseSizingDscrFloor", "maxFailedGatesForConditions", "agreementTolerancePct", "sourcePrecedence"] as const) {
        expect(RENTAL_HOLD_DRAFT[k], k).toEqual(POLICY_V1[k]);
      }
      expect(gateSpecs(RENTAL_HOLD_DRAFT).map((g) => [g.metricKey, g.scenario, g.threshold])).toEqual([
        ["development_spread", "base", 100],
        ["dcr_after_refinance", "base", 1.2],
        ["sizing_dscr", "combined", 1.2],
        ["unrealized_equity_multiple", "combined", 1],
      ]);
      expect(gateSpecs(POLICY_V1)).toHaveLength(5);
    });

    test("audit of task 60: an unrealized gate says so, and cash left is measured on required equity, as the spec says", () => {
      expect(gateSpecs(RENTAL_HOLD_DRAFT).find((g) => g.metricKey === "unrealized_equity_multiple")!.label).toMatch(/unrealized, not a sale/);
      expect(METRICS.find((m) => m.key === "cash_left_in_deal")!.formula).toMatch(/^required equity - cash returned at refinance/);
    });

    test("the registry maps each version to its policy, and hold mode gets the draft", () => {
      expect(POLICIES["policy-v1"]).toBe(POLICY_V1);
      expect(POLICIES["rental-hold-draft"]).toBe(RENTAL_HOLD_DRAFT);
      expect(policyFor(byAmount())).toBe(POLICIES["rental-hold-draft"]);
      const { exit: _e, ...sale } = byAmount();
      expect(policyFor(sale)).toBe(POLICY_V1);
    });

    test("a hold deal runs under the draft with four gates; a sale deal under policy-v1 with five", () => {
      const hold = underwrite(byAmount(), policyFor(byAmount()));
      expect(hold.policyVersion).toBe("rental-hold-draft");
      expect(hold.verdict.gates).toHaveLength(4);
      expect(hold.verdict.gates.find((g) => g.metricKey === "dcr_after_refinance")).toMatchObject({ scenario: "base", threshold: 1.2, status: "passed", unit: "x" });
      const sale = underwrite(developmentDeal(), policyFor(developmentDeal()));
      expect(sale.policyVersion).toBe("policy-v1");
      expect(sale.verdict.gates).toHaveLength(5);
    });
  });

  describe("a sale deal does not move", () => {
    test("it gets none of the hold metrics, and its result hash is what it was", () => {
      const r = underwrite(allEquityDeal(), POLICY_V1);
      for (const s of r.scenarios) for (const k of HOLD_METRICS) expect(s.metrics.some((m) => m.key === k), `${s.key} ${k}`).toBe(false);
      expect(r.equityFlows.some((f) => f.kind === ("unrealized" as string))).toBe(false);
      // The pinned hash of the plain all-equity sale deal, taken before this card (the same pin as the lease-up test above).
      const earlier = ["leaseup_operating_cost", "cumulative_cash_shortfall", "io_dscr_year1"];
      expect(sha({ ...r, scenarios: r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => !earlier.includes(m.key)) })) })).toBe("4b1aa853505ea0ed888f41c3cd57d61f87072f61a70ce399d8782e3724f33938");
    });

    test("the six oracle deals are all sales: none states the flag", () => {
      const dir = join(import.meta.dirname, "../../../oracles/deals");
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(6);
      for (const f of files) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/refinance and hold|keep and refinance|refinance_and_hold/i);
    });
  });
});

describe("Canadian cost lines and a mortgage insurance premium, as entered values (card 61)", () => {
  const sha = (x: unknown) => createHash("sha256").update(canonicalJson(x)).digest("hex");
  const v = (r: RunResult, key: string, scenario = "base") => metric(r, key, scenario).value!;
  const KEYS = ["development_charges", "land_transfer_tax", "gst_hst_net", "property_tax_annual", "refinance_insurance_premium_pct"];

  /**
   * An invented build, no debt, so every figure is exact. Land 1,000,000 at month 0; hard costs 600,000 over the
   * 6 construction months (100,000 a month); 3 months of lease-up, no income ramp; a 2-year hold, so S = 9 and T = 32.
   * Rent 10 x 1,000 x 12 = 120,000 at 100% occupancy. Fixed costs 60,000 a year, growing 5% a year.
   */
  const plain = (extra: Partial<EngineInput> = {}): EngineInput => ({
    budget: { land: 1_000_000, hard: 600_000, soft: 0, contingency: 0, other: 0 },
    revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 1_000 }],
    otherIncomeAnnual: 0,
    constructionMonths: 6,
    leaseUpMonths: 3,
    holdYears: 2,
    stabilizedOccupancyPct: 100,
    fixedOpexAnnual: 60_000,
    rentGrowthPct: 0,
    expenseGrowthPct: 5,
    leaseUpRamp: false,
    sCurveDraws: false,
    exitCapPct: 10,
    sellingCostsPct: 0,
    senior: { amount: 0, ratePct: 0, amortYears: 30, ioMonths: 0 },
    stated: {},
    ...extra,
  });
  // 50,000 + 20,000 + 30,000 = 100,000 of the three lines.
  const withLines = (extra: Partial<EngineInput> = {}) =>
    plain({ budget: { land: 1_000_000, hard: 600_000, soft: 0, contingency: 0, other: 0, developmentCharges: 50_000, landTransferTax: 20_000, gstHstNet: 30_000 }, ...extra });
  const loaned = { senior: { amount: 1_000_000, ratePct: 6, amortYears: 25, ioMonths: 0 } };
  const draws = (i: EngineInput) => buildLedger(i).rows.slice(0, 9).map((r) => r.costDraw);

  describe("the fields", () => {
    test("each is optional and 0 or more; only development charges and land transfer tax are read from a document (card 61b)", () => {
      for (const k of KEYS) {
        const d = FIELD_BY_KEY.get(k)!;
        expect(d, k).toBeDefined();
        expect(d, k).toMatchObject({ required: false, extractable: k === "development_charges" || k === "land_transfer_tax", min: 0 });
        expect(d.absentMeans, k).toBeTruthy();
        expect(d.aliases.length, k).toBeGreaterThan(0);
        expect(d.help, k).toBeTruthy();
      }
    });
    test("labels, groups, units, flags and bounds", () => {
      expect(FIELD_BY_KEY.get("development_charges")).toMatchObject({ label: "Development charges", group: "budget", unit: "$", material: false, conservative: "max", absentMeans: "none stated" });
      expect(FIELD_BY_KEY.get("land_transfer_tax")).toMatchObject({ label: "Land transfer tax", group: "budget", unit: "$", material: false, conservative: "max", absentMeans: "none stated" });
      expect(FIELD_BY_KEY.get("gst_hst_net")).toMatchObject({ label: "GST/HST net of rebates", group: "budget", unit: "$", material: false, conservative: "max", absentMeans: "none stated" });
      expect(FIELD_BY_KEY.get("property_tax_annual")).toMatchObject({ label: "Property tax (per year)", group: "operations", unit: "$", material: false, conservative: "max", absentMeans: "included in operating costs or none" });
      expect(FIELD_BY_KEY.get("refinance_insurance_premium_pct")).toMatchObject({
        label: "Refinance mortgage insurance premium", group: "refinance", unit: "%", material: true, conservative: "max", max: 10, absentMeans: "no mortgage insurance",
      });
    });
    test("the help lines", () => {
      for (const k of ["development_charges", "land_transfer_tax", "gst_hst_net"]) expect(FIELD_BY_KEY.get(k)!.help, k).toBe("If your soft or other costs already include it, leave this out.");
      expect(FIELD_BY_KEY.get("property_tax_annual")!.help).toBe("Leave this out if your expense ratio or fixed operating costs already include it.");
    });
    test("a catalog alias is claimed by one field only, and no new alias is a fee word the reader keys on", () => {
      for (const k of KEYS) {
        for (const a of FIELD_BY_KEY.get(k)!.aliases) {
          expect(FIELDS.filter((f) => f.aliases.includes(a)).map((f) => f.key), a).toEqual([k]);
          expect(a, a).not.toMatch(/\b(fees?|frais|honoraires|premiums?|prime d assurance|minimum|maximum|term|terme)\b/);
        }
      }
    });
  });

  describe("readiness", () => {
    const rows = (fields: Record<string, number>) => {
      const all: Record<string, number> = {
        land_cost: 1_000_000, hard_cost: 0, soft_cost: 0, contingency: 0, construction_months: 0, lease_up_months: 0, hold_years: 3,
        stabilized_occupancy_pct: 100, fixed_opex_annual: 20_000, exit_cap_rate_pct: 10, selling_costs_pct: 0,
        senior_loan_amount: 600_000, senior_rate_pct: 0, senior_amort_years: 20, ...fields,
      };
      return [
        ...Object.entries(all).map(([fieldKey, valueNumeric]) => ({ fieldKey, itemKey: null, status: "approved" as AssumptionStatus, valueNumeric })),
        { fieldKey: "unit_count", itemKey: "A", status: "approved" as AssumptionStatus, valueNumeric: 10 },
        { fieldKey: "unit_rent_monthly", itemKey: "A", status: "approved" as AssumptionStatus, valueNumeric: 1_000 },
      ];
    };
    const refi = { refinance_month: 12, refinance_amount: 800_000, refinance_rate_pct: 0, refinance_amort_years: 20 };

    test("a field that is not stated is omitted from the input, never 0 and never undefined", () => {
      const { input } = assemble(rows(refi));
      expect(Object.keys(input!.budget).sort()).toEqual(["contingency", "hard", "land", "other", "soft"]);
      expect("propertyTaxAnnual" in input!).toBe(false);
      expect(Object.keys(input!.refinance!).sort()).toEqual(["amortYears", "amount", "ioMonths", "month", "ratePct"]);
      expect(canonicalJson(input)).not.toMatch(/developmentCharges|landTransferTax|gstHstNet|propertyTaxAnnual|insurancePremiumPct|undefined/);
    });
    test("a stated value is set, and a stated 0 is a value", () => {
      const { readiness, input } = assemble(rows({ ...refi, development_charges: 50_000, land_transfer_tax: 0, gst_hst_net: 30_000, property_tax_annual: 12_000, refinance_insurance_premium_pct: 4 }));
      expect(readiness.status).toBe("ready");
      expect(input!.budget).toEqual({ land: 1_000_000, hard: 0, soft: 0, contingency: 0, other: 0, developmentCharges: 50_000, landTransferTax: 0, gstHstNet: 30_000 });
      expect(input!.propertyTaxAnnual).toBe(12_000);
      expect(input!.refinance!.insurancePremiumPct).toBe(4);
    });
    test("a premium with no refinance month is not put on the input, as refinance_io_months is not", () => {
      const { input } = assemble(rows({ refinance_io_months: 6, refinance_insurance_premium_pct: 4 }));
      expect(input!.refinance).toBeUndefined();
      expect(canonicalJson(input)).not.toMatch(/insurancePremiumPct/);
    });
    test("a value out of bounds is impossible: the premium above 10 percent, a negative cost line", () => {
      const bad = assemble(rows({ ...refi, refinance_insurance_premium_pct: 10.5, development_charges: -1 }));
      expect(bad.input).toBeNull();
      expect(bad.readiness.impossible.map((i) => i.fieldKey).sort()).toEqual(["development_charges", "refinance_insurance_premium_pct"]);
    });
    test("review offers GST/HST net and property tax as choices, development charges and land transfer tax as not found, and the premium only when a refinance month is stated", () => {
      const keys = (r: Readiness) => r.choices.map((c) => c.fieldKey);
      const found = (r: Readiness) => r.notFound.map((n) => n.fieldKey);
      const none = assemble(rows({})).readiness;
      expect(keys(none)).toEqual(expect.arrayContaining(["gst_hst_net", "property_tax_annual"]));
      expect(keys(none)).not.toContain("development_charges");
      expect(keys(none)).not.toContain("land_transfer_tax");
      expect(found(none)).toEqual(expect.arrayContaining(["development_charges", "land_transfer_tax"]));
      expect(none.notFound.find((n) => n.fieldKey === "development_charges")!.detail).toBe("none stated");
      expect(keys(none)).not.toContain("refinance_insurance_premium_pct");
      expect(none.choices.find((c) => c.fieldKey === "property_tax_annual")!.detail).toBe("included in operating costs or none");
      const refinanced = assemble(rows(refi)).readiness;
      expect(keys(refinanced)).toContain("refinance_insurance_premium_pct");
      expect(refinanced.choices.find((c) => c.fieldKey === "refinance_insurance_premium_pct")!.detail).toBe("no mortgage insurance");
      for (const r of [none, refinanced]) for (const k of ["gst_hst_net", "property_tax_annual", "refinance_insurance_premium_pct"]) expect(found(r), k).not.toContain(k);
    });
    test("a stated choice leaves the list", () => {
      const r = assemble(rows({ ...refi, development_charges: 0, refinance_insurance_premium_pct: 0 })).readiness;
      expect(r.choices.map((c) => c.fieldKey)).not.toContain("development_charges");
      expect(r.choices.map((c) => c.fieldKey)).not.toContain("refinance_insurance_premium_pct");
    });
  });

  describe("the three cost lines", () => {
    test("each lands in the month the spec says", () => {
      // Month 0: land 1,000,000 + the first of six hard-cost draws 100,000 + development charges 50,000 + land transfer tax 20,000 = 1,170,000.
      // Months 1 to 4: 100,000 of hard cost. Month 5, the last construction month: 100,000 + GST/HST 30,000 = 130,000.
      // Months 6 to 8 (lease-up): fixed costs 60,000 / 12 = 5,000 each.
      expect(draws(plain())).toEqual([1_100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 5_000, 5_000, 5_000]);
      expect(draws(withLines())).toEqual([1_170_000, 100_000, 100_000, 100_000, 100_000, 130_000, 5_000, 5_000, 5_000]);
    });
    test("GST/HST net is paid at month 0 when there is no construction", () => {
      // C = 0, L = 3: month 0 carries land 1,000,000 + hard 600,000 (spread over one month) + 50,000 + 20,000 + 30,000 = 1,700,000,
      // plus the first of three lease-up months of fixed costs, 60,000 / 12 = 5,000.
      const i = withLines({ constructionMonths: 0 });
      expect(buildLedger(i).rows[0]!.costDraw).toBe(1_705_000);
      // With no lease-up either, everything is paid at month 0: total development cost is 1,700,000.
      expect(v(underwrite(withLines({ constructionMonths: 0, leaseUpMonths: 0 }), POLICY_V1), "total_development_cost")).toBeCloseTo(1_700_000, 6);
    });
    test("an S-curve moves the hard costs, not the lines that are paid on a date", () => {
      const i = withLines({ sCurveDraws: true });
      const base = plain({ sCurveDraws: true });
      const a = draws(i);
      const b = draws(base);
      expect(a[0]! - b[0]!).toBeCloseTo(70_000, 6);
      expect(a[5]! - b[5]!).toBeCloseTo(30_000, 6);
      for (const m of [1, 2, 3, 4, 6, 7, 8]) expect(a[m], `month ${m}`).toBeCloseTo(b[m]!, 6);
    });
    test("total development cost rises by exactly their sum when nothing is borrowed", () => {
      // Costs before financing 1,600,000 + 100,000 = 1,700,000. Lease-up fixed costs 3 x 5,000 = 15,000. No debt, so no interest.
      const a = underwrite(plain(), POLICY_V1);
      const b = underwrite(withLines(), POLICY_V1);
      expect(v(a, "total_development_cost")).toBeCloseTo(1_615_000, 6);
      expect(v(b, "total_development_cost")).toBeCloseTo(1_715_000, 6);
      expect(v(b, "hard_and_soft_cost") - v(a, "hard_and_soft_cost")).toBeCloseTo(100_000, 6);
      expect(v(b, "required_equity")).toBeCloseTo(1_715_000, 6);
    });
    test("with a loan they rise by their sum plus the change in interest they cause, funded equity first", () => {
      // Equity pays first, so a cost paid at month 0 delays the loan's first draw and the interest on it can fall;
      // the identity holds whichever way it moves: tdc(with) - tdc(without) = 100,000 + (interest(with) - interest(without)).
      const a = underwrite(plain(loaned), POLICY_V1);
      const b = underwrite(withLines(loaned), POLICY_V1);
      const change = v(b, "capitalized_interest") - v(a, "capitalized_interest");
      expect(v(b, "total_development_cost") - v(a, "total_development_cost")).toBeCloseTo(100_000 + change, 6);
      // The 1,000,000 loan is a commitment either way; equity covers the rest, so required equity rises by 100,000 plus that change.
      expect(v(b, "required_equity") - v(a, "required_equity")).toBeCloseTo(100_000 + change, 2); // the funding solve is exact to half a cent
      const first = buildLedger(withLines(loaned)).rows[0]!;
      expect(first.equityDraw).toBeGreaterThan(0);
      expect(first.equityDraw + first.debtDraw).toBeCloseTo(1_170_000, 6);
    });
    test("when the loan funds everything, the lines cost the interest on them as well", () => {
      // A 2,000,000 commitment is more than the deal needs, so equity is 0 and the extra 100,000 is borrowed: interest rises.
      const big = { senior: { amount: 2_000_000, ratePct: 6, amortYears: 25, ioMonths: 0 } };
      const a = underwrite(plain(big), POLICY_V1);
      const b = underwrite(withLines(big), POLICY_V1);
      const extra = v(b, "capitalized_interest") - v(a, "capitalized_interest");
      expect(extra).toBeGreaterThan(0);
      expect(v(b, "total_development_cost") - v(a, "total_development_cost")).toBeCloseTo(100_000 + extra, 6);
      expect(v(b, "required_equity")).toBeCloseTo(0, 6);
    });
    test("an agreement check against a stated total cost uses total development cost, lines included", () => {
      const r = underwrite(withLines({ stated: { totalCost: 1_715_000 } }), POLICY_V1);
      expect(r.checks.find((c) => c.key === "stated_total_cost")).toMatchObject({ severity: "pass" });
      expect(underwrite(plain({ stated: { totalCost: 1_715_000 } }), POLICY_V1).checks.find((c) => c.key === "stated_total_cost")).toMatchObject({ severity: "warning" });
    });
    test("the cost stress scales the three lines like every other cost", () => {
      const s = applyStress(withLines(), { key: "c", label: "c", costPct: 10 });
      expect(s.budget.developmentCharges).toBeCloseTo(55_000, 6);
      expect(s.budget.landTransferTax).toBeCloseTo(22_000, 6);
      expect(s.budget.gstHstNet).toBeCloseTo(33_000, 6);
      expect(s.budget.land).toBeCloseTo(1_100_000, 6);
      // A deal that states none has none added by a stress.
      expect(canonicalJson(applyStress(plain(), { key: "c", label: "c", costPct: 10 }).budget)).not.toMatch(/developmentCharges|landTransferTax|gstHstNet/);
    });
    test("a cost line below 0 is refused by the engine", () => {
      for (const k of ["developmentCharges", "landTransferTax", "gstHstNet"] as const) {
        const i = plain({ budget: { land: 1_000_000, hard: 600_000, soft: 0, contingency: 0, other: 0, [k]: -1 } });
        expect(() => validateInput(i), k).toThrow(EngineInputError);
      }
    });
  });

  describe("property tax", () => {
    test("it adds to the fixed costs in year 1, on top of fixed operating costs", () => {
      // Fixed 60,000 + property tax 12,000 = 72,000. EGI 120,000 - 72,000 = NOI 48,000.
      const r = underwrite(plain({ propertyTaxAnnual: 12_000 }), POLICY_V1);
      expect(v(r, "operating_expenses")).toBeCloseTo(72_000, 6);
      expect(v(r, "stabilized_noi")).toBeCloseTo(48_000, 6);
      expect(buildLedger(plain({ propertyTaxAnnual: 12_000 })).year1.fixedOpex).toBe(72_000);
    });
    test("it adds on top of the expense ratio's fixed dollars", () => {
      // 40% of year-1 EGI 120,000 = 48,000 + 12,000 = 60,000.
      const { fixedOpexAnnual: _f, ...rest } = plain({ propertyTaxAnnual: 12_000 });
      const r = underwrite({ ...rest, expenseRatioPct: 40 }, POLICY_V1);
      expect(v(r, "operating_expenses")).toBeCloseTo(60_000, 6);
    });
    test("it grows at expense growth", () => {
      // Year 2: (60,000 + 12,000) x 1.05 = 75,600, against 63,000 without it.
      const a = buildLedger(plain());
      const b = buildLedger(plain({ propertyTaxAnnual: 12_000 }));
      expect(a.annual[2]!.opex).toBeCloseTo(63_000, 6);
      expect(b.annual[2]!.opex).toBeCloseTo(75_600, 6);
    });
    test("it is charged in lease-up months like the other fixed costs", () => {
      // Each of the 3 lease-up months: (60,000 + 12,000) / 12 = 6,000, against 5,000.
      expect(draws(plain({ propertyTaxAnnual: 12_000 })).slice(6)).toEqual([6_000, 6_000, 6_000]);
      const r = underwrite(plain({ propertyTaxAnnual: 12_000 }), POLICY_V1);
      expect(v(r, "leaseup_operating_cost")).toBeCloseTo(18_000, 6);
      expect(v(r, "total_development_cost")).toBeCloseTo(1_618_000, 6);
    });
    test("it counts in break-even occupancy through the fixed costs", () => {
      // (fixed costs + debt service) / rent = 72,000 / 120,000 = 60%, against 60,000 / 120,000 = 50%.
      expect(v(underwrite(plain(), POLICY_V1), "break_even_occupancy")).toBeCloseTo(50, 9);
      expect(v(underwrite(plain({ propertyTaxAnnual: 12_000 }), POLICY_V1), "break_even_occupancy")).toBeCloseTo(60, 9);
    });
    test("the expense stress leaves it alone", () => {
      // Ratio 40% + 5 points = 45% of 120,000 = 54,000, plus the same 12,000 = 66,000.
      const { fixedOpexAnnual: _f, ...rest } = plain({ propertyTaxAnnual: 12_000 });
      const i: EngineInput = { ...rest, expenseRatioPct: 40 };
      const s = applyStress(i, { key: "e", label: "e", expensePts: 5 });
      expect(s.propertyTaxAnnual).toBe(12_000);
      expect(buildLedger(s).year1.fixedOpex).toBeCloseTo(66_000, 6);
      expect(buildLedger(i).year1.fixedOpex).toBeCloseTo(60_000, 6);
    });
    test("it must be a number of 0 or more", () => {
      expect(() => validateInput(plain({ propertyTaxAnnual: -1 }))).toThrow(EngineInputError);
    });
  });

  describe("the insurance premium", () => {
    /**
     * An invented rental with no build and all rates 0%, as in card 60. Rent 10 x 1,000 x 12 = 120,000 less fixed
     * costs 20,000 gives NOI 100,000 a year. Land 1,000,000 with a senior loan of 600,000 over 20 years (2,500 a
     * month); at month 12 the balance is 600,000 - 12 x 2,500 = 570,000. Hold 3 years, so T is month 35. Exit cap 10%.
     */
    const rental = (refinance: NonNullable<EngineInput["refinance"]>, extra: Partial<EngineInput> = {}): EngineInput => ({
      budget: { land: 1_000_000, hard: 0, soft: 0, contingency: 0, other: 0 },
      revenue: [{ key: "A", label: "A", basis: "per_unit", units: 10, rentMonthly: 1_000 }],
      otherIncomeAnnual: 0,
      constructionMonths: 0,
      leaseUpMonths: 0,
      holdYears: 3,
      stabilizedOccupancyPct: 100,
      fixedOpexAnnual: 20_000,
      rentGrowthPct: 0,
      expenseGrowthPct: 0,
      leaseUpRamp: false,
      sCurveDraws: false,
      exitCapPct: 10,
      sellingCostsPct: 0,
      senior: { amount: 600_000, ratePct: 0, amortYears: 20, ioMonths: 0 },
      refinance,
      stated: {},
      ...extra,
    });
    const refi = { month: 12, ratePct: 0, amortYears: 20, ioMonths: 0 };
    const amount4 = () => rental({ ...refi, amount: 1_000_000, insurancePremiumPct: 4 });
    const amount0 = () => rental({ ...refi, amount: 1_000_000 });

    test("a 4% premium on a $1,000,000 refinance gives a balance of $1,040,000", () => {
      const L = buildLedger(amount4());
      // Right after the month-12 payment the balance is 1,040,000 less one payment of 1,040,000 / 240 = 4,333.33.
      expect(L.rows[12]!.debtBalance).toBeCloseTo(1_040_000 - 1_040_000 / 240, 6);
      expect(L.rows[11]!.debtBalance).toBeCloseTo(600_000 - 12 * 2_500, 6);
      // Debt at T (month 35): 24 payments made since the refinance, 1,040,000 - 24 x 4,333.33 = 936,000.
      expect(L.payoffAtSale).toBeCloseTo(936_000, 6);
      expect(buildLedger(amount0()).payoffAtSale).toBeCloseTo(900_000, 6);
    });
    test("debt service follows the balance", () => {
      // Month 12: 1,040,000 / 240 = 4,333.33 a month, against 1,000,000 / 240 = 4,166.67. Year 2 of the hold is 52,000 against 50,000.
      const a = buildLedger(amount4());
      const b = buildLedger(amount0());
      expect(a.rows[12]!.debtService).toBeCloseTo(1_040_000 / 240, 6);
      expect(a.annual[2]!.debtService).toBeCloseTo(52_000, 6);
      expect(b.annual[2]!.debtService).toBeCloseTo(50_000, 6);
      expect(a.annual[2]!.sizingDebtService).toBeCloseTo(52_000, 6);
    });
    test("the cash returned is the loan less the payoff: the premium is not cash", () => {
      // 1,000,000 - 570,000 = 430,000 with or without the premium.
      for (const i of [amount4(), amount0()]) {
        const r = underwrite(i, POLICY_V1);
        expect(v(r, "refinance_net_proceeds")).toBeCloseTo(430_000, 6);
        expect(buildLedger(i).refinance!.net).toBeCloseTo(430_000, 6);
        expect(buildLedger(i).rows[12]!.refinanceNet).toBeCloseTo(430_000, 6);
      }
    });
    test("the premium added is reported beside the net proceeds, and only when a premium is stated", () => {
      const r = underwrite(amount4(), POLICY_V1);
      // 1,000,000 x 4% = 40,000.
      expect(v(r, "refinance_premium_added")).toBeCloseTo(40_000, 6);
      const keys = r.scenarios[0]!.metrics.map((m) => m.key);
      expect(keys[keys.indexOf("refinance_net_proceeds") + 1]).toBe("refinance_premium_added");
      const catalog = METRICS.map((m) => m.key);
      expect(catalog.indexOf("refinance_premium_added")).toBe(catalog.indexOf("refinance_net_proceeds") + 1);
      for (const s of underwrite(amount0(), POLICY_V1).scenarios) expect(s.metrics.some((m) => m.key === "refinance_premium_added"), s.key).toBe(false);
      // A premium of 0 is stated, so it is a real 0 added.
      const zero = underwrite(rental({ ...refi, amount: 1_000_000, insurancePremiumPct: 0 }), POLICY_V1);
      expect(metric(zero, "refinance_premium_added")).toMatchObject({ status: "VALID", value: 0 });
    });
    test("a loan sized by loan-to-value is sized before the premium", () => {
      // Forward NOI 100,000 / 10% = 1,000,000 of value; 80% gives a loan of 800,000, then x 1.04 = 832,000.
      const i = rental({ ...refi, ltvPct: 80, insurancePremiumPct: 4 });
      const r = underwrite(i, POLICY_V1);
      expect(v(r, "refinance_net_proceeds")).toBeCloseTo(800_000 - 570_000, 6);
      expect(v(r, "refinance_premium_added")).toBeCloseTo(32_000, 6);
      expect(buildLedger(i).payoffAtSale).toBeCloseTo(832_000 - 24 * (832_000 / 240), 6);
    });
    test("in a held deal the coverage after the refinance and the debt at T use the balance with the premium", () => {
      const held = (r: NonNullable<EngineInput["refinance"]>) => { const i = rental(r, { exit: "refinance_hold" }); return underwrite(i, policyFor(i)); };
      const a = held({ ...refi, amount: 1_000_000, insurancePremiumPct: 4 });
      const b = held({ ...refi, amount: 1_000_000 });
      // Months 12 to 23: NOI 100,000; sizing debt service 12 x 1,040,000 / 240 = 52,000. DCR = 100,000 / 52,000 = 1.9231. Without: 100,000 / 50,000 = 2.
      expect(v(a, "dcr_after_refinance")).toBeCloseTo(100_000 / 52_000, 9);
      expect(v(b, "dcr_after_refinance")).toBeCloseTo(2, 9);
      // Cash returned is 430,000 either way, so cash left is 400,000 - 430,000 = -30,000.
      expect(v(a, "refinance_cash_returned")).toBeCloseTo(430_000, 6);
      expect(v(a, "cash_left_in_deal")).toBeCloseTo(-30_000, 6);
      // Stated value 1,000,000 less debt at T 936,000 = 64,000 (900,000 and 100,000 without).
      expect(a.equityFlows.find((f) => f.kind === ("unrealized" as string))!.amount).toBeCloseTo(64_000, 6);
      expect(b.equityFlows.find((f) => f.kind === ("unrealized" as string))!.amount).toBeCloseTo(100_000, 6);
    });
    test("the premium must be from 0 to 10 percent", () => {
      for (const bad of [-1, 10.5]) expect(() => validateInput(rental({ ...refi, amount: 1_000_000, insurancePremiumPct: bad })), String(bad)).toThrow(EngineInputError);
      expect(() => validateInput(rental({ ...refi, amount: 1_000_000, insurancePremiumPct: 10 }))).not.toThrow();
    });
    test("a stress moves the loan's rate, not its premium", () => {
      const s = applyStress(amount4(), { key: "r", label: "r", rateBps: 100 });
      expect(s.refinance!.insurancePremiumPct).toBe(4);
    });
  });

  describe("a deal that states none of the five computes as before", () => {
    test("the result of the plain all-equity deal is the pinned one, and no new metric appears", () => {
      const r = underwrite(allEquityDeal(), POLICY_V1);
      for (const s of r.scenarios) expect(s.metrics.some((m) => m.key === "refinance_premium_added"), s.key).toBe(false);
      const earlier = ["leaseup_operating_cost", "cumulative_cash_shortfall", "io_dscr_year1"];
      expect(sha({ ...r, scenarios: r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => !earlier.includes(m.key)) })) })).toBe("4b1aa853505ea0ed888f41c3cd57d61f87072f61a70ce399d8782e3724f33938");
    });
    test("a stated 0 is a stated value: the numbers match, and the input records it", () => {
      const a = underwrite(plain(), POLICY_V1);
      const b = underwrite(plain({ budget: { land: 1_000_000, hard: 600_000, soft: 0, contingency: 0, other: 0, developmentCharges: 0, landTransferTax: 0, gstHstNet: 0 }, propertyTaxAnnual: 0 }), POLICY_V1);
      expect(v(b, "total_development_cost")).toBe(v(a, "total_development_cost"));
      expect(v(b, "stabilized_noi")).toBe(v(a, "stabilized_noi"));
      expect(canonicalJson(plain())).not.toBe(canonicalJson(plain({ propertyTaxAnnual: 0 })));
    });
  });

  describe("the quick start", () => {
    test("both templates ask for development charges and property tax per year, and 0 is allowed", () => {
      for (const t of TEMPLATES) {
        for (const k of ["development_charges", "property_tax_annual"]) {
          const q = t.questions.find((x) => x.field === k);
          expect(q, `${t.key} ${k}`).toMatchObject({ zeroAllowed: true });
        }
      }
    });
    test("the apartment template also asks for land transfer tax and GST/HST net, as optional questions", () => {
      const apartment = TEMPLATES.find((t) => t.key === "apartment")!;
      for (const k of ["land_transfer_tax", "gst_hst_net"]) expect(apartment.questions.find((x) => x.field === k), k).toMatchObject({ optional: true });
      const multiplex = TEMPLATES.find((t) => t.key === "multiplex")!;
      for (const k of ["land_transfer_tax", "gst_hst_net"]) expect(multiplex.questions.some((x) => x.field === k), k).toBe(false);
    });
  });
});
