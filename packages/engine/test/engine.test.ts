import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FIELDS, FIELD_BY_KEY, POLICY_V1, TEMPLATES, type AssumptionStatus, type EngineInput, type RunResult } from "@agir/contracts";
import { allocate, assemble, buildLedger, canonicalJson, irrRoots, levelPayment, underwrite, EngineInputError } from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";

const metric = (r: RunResult, key: string, scenario = "base") =>
  r.scenarios.find((s) => s.key === scenario)!.metrics.find((m) => m.key === key)!;

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

  // Task 33: an optional line with no value is disclosed as "not found"; it is never a number and never blocks.
  describe("optional lines that were not found", () => {
    type Item = { fieldKey: string; itemKey?: string; label: string; detail?: string };
    const notFoundOf = (r: unknown) => (r as { notFound: Item[] }).notFound;
    const keys = (r: unknown) => notFoundOf(r).map((i) => i.fieldKey);
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
