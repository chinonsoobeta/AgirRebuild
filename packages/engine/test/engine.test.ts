import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FIELDS, FIELD_BY_KEY, POLICY_V1, TEMPLATES, type AssumptionStatus, type EngineInput, type Readiness, type RunResult } from "@agir/contracts";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allocate, applyStress, assemble, buildLedger, canonicalJson, irrRoots, levelPayment, underwrite, validateInput, EngineInputError } from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const metric = (r: RunResult, key: string, scenario = "base") =>
  r.scenarios.find((s) => s.key === scenario)!.metrics.find((m) => m.key === key)!;

/**
 * The hash of a result as the engine produced it before task 37 added the `mezz_interest_accrued`
 * metric: that one entry is left out, so a pin taken before it stays true for a deal it does not touch.
 */
function shaWithoutMezzMetric(r: RunResult): string {
  const plain = { ...r, scenarios: r.scenarios.map((s) => ({ ...s, metrics: s.metrics.filter((m) => m.key !== "mezz_interest_accrued") })) };
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
    expect(sha(underwrite(developmentDeal(), POLICY_V1))).toBe("61f6c980fbabf5faf49f1e6807e001106d3970479177e2a4ad08e32e3563b1a5");
    expect(sha(underwrite(withOtherCost, POLICY_V1))).toBe("c346a2638ceca1a9345298bda5eb0a93b2b308f462896af3cf0f05c70c309039");
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
  };
  const rowsFor = (key: "multiplex" | "apartment", loan = 1_500_000) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    const rows: { fieldKey: string; itemKey: string | null; status: AssumptionStatus; valueNumeric: number | null }[] = [];
    const add = (fieldKey: string, itemKey: string | null, v: number, status: AssumptionStatus = "approved") => rows.push({ fieldKey, itemKey, status, valueNumeric: v });
    const skipped = new Set(loan === 0 ? t.questions.find((q) => q.skipsIfZero)!.skipsIfZero : []);
    for (const q of t.questions) {
      if (skipped.has(q.field)) continue;
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

  // Readiness never blocks it. These figures are a weak deal (the engine's own equity_wipeout check
  // fires, so the verdict is a hard fail), which is a finding about the deal, not a blocked run.
  test("a fourplex quick start runs to a verdict", () => {
    const { input } = assemble(rowsFor("multiplex"));
    const r = underwrite(input!, POLICY_V1);
    expect(r.verdict.code).toBe("REJECT");
    expect(r.checks.map((c) => c.key)).toContain("equity_wipeout");
    expect(input!.revenue).toHaveLength(1);
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
    const L = buildLedger(mezzDeal());
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
    expect(shaWithoutMezzMetric(underwrite(developmentDeal(), POLICY_V1))).toBe("61f6c980fbabf5faf49f1e6807e001106d3970479177e2a4ad08e32e3563b1a5");
    // The stresses are left out of the second: a +150 bps rate stress lifts a 0% mezzanine to 1.5%, and that one does accrue.
    expect(shaWithoutMezzMetric(underwrite(mezzDeal({ ratePct: 0 }), { ...POLICY_V1, stresses: [] }))).toBe("ee62512d23ae33fb7db80a2cd7cb0f1f75ca1c0a7c1a105f405069ac8a607881");
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
    // extra capitalized interest that the 60,000 carries (and the NOI is untouched).
    const capInt = metric(r, "capitalized_interest").value!;
    expect(metric(r, "hard_and_soft_cost").value!).toBeCloseTo(41_900_000, 2);
    expect(metric(r, "total_development_cost").value!).toBeCloseTo(41_900_000 + capInt + 60_000, 2);
    expect(metric(r, "total_development_cost").value! - OLD.tdc).toBeCloseTo(60_000 + (capInt - OLD.capitalizedInterest), 2);
    expect(capInt).toBeGreaterThan(OLD.capitalizedInterest);
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
    const deal = { ...developmentDeal(), leaseUpRamp: true, fixedOpexAnnual: 3_000_000, expenseRatioPct: undefined } as EngineInput;
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
