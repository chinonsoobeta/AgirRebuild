import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as contracts from "@agir/contracts";
import type { EngineInput } from "@agir/contracts";
import * as engine from "../src/index.ts";
import { allEquityDeal, developmentDeal } from "./fixtures.ts";
import { loadOracles, toNormalized } from "../../extraction/test/oracle.ts";
import { consolidate, extractCandidates } from "@agir/extraction";

const sha = (value: unknown) => createHash("sha256").update(engine.canonicalJson(value)).digest("hex");
const value = (r: ReturnType<typeof engine.underwrite>, key: string, scenario = "base") => r.scenarios.find((s) => s.key === scenario)!.metrics.find((m) => m.key === key)!;
type OracleInputs = { unit_types: { name: string; units: number; price: number }[]; land: number; hard: number; soft: number; contingency: number; construction_months: number; presold_units_pct: number; deposit_pct: number; absorption_units_per_month: number; sales_commission_pct: number; closing_lag_months: number; unsold_carry_monthly: number; senior_commitment: number; senior_rate_pct: number; mezz_commitment: number; mezz_rate_pct: number; senior_presale_threshold_pct: number };
type Oracle = { inputs: OracleInputs; base: Record<string, number | string>; stresses: Record<string, Record<string, number | string>>; closings: Record<string, number[][]>; gates: { key: string; scenario: string; threshold: number; value: number; pass: boolean }[]; verdict: string; tolerance: { money: number; percent: number; multiple: number } };
const fromOracle = (d: OracleInputs): EngineInput => ({
  ...allEquityDeal(), budget: { land: d.land, hard: d.hard, soft: d.soft, contingency: d.contingency, other: 0 },
  revenue: [], constructionMonths: d.construction_months, leaseUpMonths: 0, exit: "for_sale",
  senior: { amount: d.senior_commitment, ratePct: d.senior_rate_pct, ioMonths: 0 },
  ...(d.mezz_commitment > 0 ? { mezzanine: { amount: d.mezz_commitment, ratePct: d.mezz_rate_pct, amortYears: 30, ioMonths: 0 } } : {}),
  forSale: { units: d.unit_types.map((u, i) => ({ key: String(i), label: u.name, units: u.units, price: u.price })),
    presoldPct: d.presold_units_pct, depositPct: d.deposit_pct, absorptionPerMonth: d.absorption_units_per_month,
    commissionPct: d.sales_commission_pct, closingLagMonths: d.closing_lag_months, carryMonthly: d.unsold_carry_monthly,
    presaleThresholdPct: d.senior_presale_threshold_pct },
});
const small = (): EngineInput => ({ ...allEquityDeal(), budget: { land: 60, hard: 40, soft: 0, contingency: 0, other: 0 },
  revenue: [], exit: "for_sale", constructionMonths: 1,
  senior: { amount: 50, ratePct: 0, ioMonths: 0 }, mezzanine: { amount: 20, ratePct: 0, amortYears: 30, ioMonths: 0 },
  forSale: { units: [{ key: "A", label: "A", units: 1, price: 100 }, { key: "B", label: "B", units: 2, price: 250 }],
    presoldPct: 50, depositPct: 10, absorptionPerMonth: 0.75, commissionPct: 10, closingLagMonths: 1, carryMonthly: 10, presaleThresholdPct: 50 },
});
const run = (input: EngineInput) => engine.underwrite(input, contracts.policyFor(input));

describe("selling the units (task 77)", () => {
  test.each(["kestrel-row-townhomes", "alder-court-condo"])("matches every checked workbook result: %s", (slug) => {
    const oracle = JSON.parse(readFileSync(new URL(`../../../oracles/for-sale/${slug}.outcome.json`, import.meta.url), "utf8")) as Oracle;
    const input = fromOracle(oracle.inputs);
    const result = run(input);
    expect(result.verdict.code).toBe(oracle.verdict);
    for (const [scenario, expected] of Object.entries({ base: oracle.base, ...oracle.stresses })) {
      const stressed = scenario === "base" ? input : engine.applyStress(input, contracts.FOR_SALE_DRAFT.stresses.find((s) => s.key === scenario)!);
      const L = engine.buildForSaleLedger(stressed);
      for (const [key, wanted] of Object.entries(expected)) {
        // The workbook's self-checks are ledger diagnostics, not catalog metrics: compare them on the ledger.
        if (!contracts.METRIC_BY_KEY.has(key)) {
          const counted = ["funding_converged", "profit_reconciliation_pass", "flow_sign_changes", "closing_units_check"].includes(key);
          expect(L.values[key], `${slug} ${scenario} ${key}`).toBeDefined();
          expect(Math.abs(L.values[key]! - Number(wanted)), `${slug} ${scenario} ${key}`).toBeLessThanOrEqual(counted ? 0 : oracle.tolerance.money);
          continue;
        }
        const got = value(result, key, scenario);
        expect(got, `${slug} ${scenario} ${key}`).toBeDefined();
        if (wanted === "not meaningful") expect(got).toMatchObject({ value: null, status: "NOT_MEANINGFUL" });
        else {
          expect(got.status, `${slug} ${scenario} ${key}`).toBe("VALID");
          const tolerance = got.unit === "$" ? oracle.tolerance.money : got.unit === "%" ? oracle.tolerance.percent : got.unit === "x" ? oracle.tolerance.multiple : 1e-9;
          expect(Math.abs(got.value! - Number(wanted)), `${slug} ${scenario} ${key}: engine ${got.value}, file ${wanted}`).toBeLessThanOrEqual(tolerance);
        }
      }
      expect(L.closings.map((n, m) => [m, n]).filter(([, n]) => n! > 0)).toEqual(oracle.closings[scenario]);
    }
    const gateKeys = ["profit_on_cost_for_sale", "margin_on_revenue", "stressed_profit_on_cost_for_sale", "stressed_equity_multiple"];
    oracle.gates.forEach((g, i) => {
      const actual = result.verdict.gates[i]!;
      expect(actual).toMatchObject({ key: gateKeys[i], scenario: g.scenario, threshold: g.threshold, status: g.pass ? "passed" : "failed" });
      expect(Math.abs(actual.actual! - g.value)).toBeLessThanOrEqual(i === 3 ? oracle.tolerance.multiple : oracle.tolerance.percent);
    });
  });
  test("pins all three rental policies and selects only the new mode's policy", () => {
    const expected = {"policy-v1": "9f95780101a9ecfe6444c47dd319c1cb8d77251d60700a1a4dde1733055296b9", "rental-hold-draft": "2fb3d651462684813c8207c60d86fe0a3d0785bc7220fa5a57a91968b9bd3ae8", "rental-hold-insured-draft": "1acd96e37d38fc6a4fb724c4fd565bd91ead4b5e938c2e6625b8de9b68eca206"};
    for (const p of [contracts.POLICY_V1, contracts.RENTAL_HOLD_DRAFT, contracts.RENTAL_HOLD_INSURED_DRAFT]) expect(sha(p)).toBe(expected[p.version as keyof typeof expected]);
    expect(contracts.policyFor(small()).version).toBe("for-sale-draft");
    expect(contracts.policyFor(allEquityDeal())).toBe(contracts.POLICY_V1);
    expect(contracts.policyFor({ ...developmentDeal(), exit: "refinance_hold" })).toBe(contracts.RENTAL_HOLD_DRAFT);
    expect(contracts.policyFor({ ...developmentDeal(), exit: "refinance_hold", refinance: { month: 36, amount: 1, ratePct: 1, amortYears: 30, ioMonths: 0, insurancePremiumPct: 4, mliSelectPoints: 50 } })).toBe(contracts.RENTAL_HOLD_INSURED_DRAFT);
  });
  test.each([
    ["cannot state rents", (d: EngineInput) => ({ ...d, revenue: allEquityDeal().revenue })],
    ["cannot have a refinance", (d: EngineInput) => ({ ...d, refinance: { month: 2, amount: 1, ratePct: 1, amortYears: 30, ioMonths: 0 } })],
    ["cannot have a lease-up period", (d: EngineInput) => ({ ...d, leaseUpMonths: 1 })],
    ["apply only to a deal that sells its units", (d: EngineInput) => ({ ...d, exit: undefined })],
    ["needs its sale details", (d: EngineInput) => ({ ...d, forSale: undefined })],
  ] as const)("rejects an incompatible combination: %s", (name, change) => {
    expect(() => engine.validateInput(change(small()))).toThrow(new RegExp(name));
  });
  test("Q1: carry includes presold units waiting for closing", () => {
    // C=1, lag=1; opening unclosed units at months 1..4 = 3,3,2,1. Carry = 9 x $10 = $90.
    expect(value(run(small()), "carry_total").value).toBe(90);
    expect(engine.buildForSaleLedger(small()).rows.slice(1).map((r) => r.equityDraw)).toEqual([30, 30, 20, 10]);
  });
  test("Q2: every closing uses the weighted average price and repays senior before mezzanine", () => {
    // Gross = 1x100 + 2x250 = 600; average 200; net each 180. First closing repays 50+20, equity gets 110.
    const L = engine.buildForSaleLedger(small());
    expect(L.rows[2]).toMatchObject({ debtService: 70, debtBalance: 0, saleNet: 110 });
    expect(L.rows.slice(3).map((r) => r.saleNet)).toEqual([180, 180]);
    expect(value(run(small()), "development_profit_for_sale").value).toBe(540 - 100 - 90);
  });
  test("Q3: presales round down and deposits stay in trust", () => {
    // floor(3 x 50%) = 1; trust deposit = 1 x $200 x 10% = $20, not $30.
    const input = small();
    const r = run(input);
    expect(value(r, "deposits_held_at_completion").value).toBe(20);
    const noDeposit = { ...input, forSale: { ...input.forSale!, depositPct: 0 } };
    expect(run(noDeposit).equityFlows).toEqual(r.equityFlows);
  });
  test("Q4: fractional cumulative absorption stays whole and closings follow the lag", () => {
    // Unsold cumulative floor(.75 x k) = 0,1,2; with one-month lag the three closings are months 2,3,4.
    expect(engine.buildForSaleLedger(small()).closings).toEqual([0, 0, 1, 1, 1]);
    expect(value(run(small()), "sellout_month").value).toBe(4);
  });
  test("Q5: the lender's presale condition is base-only and includes equality", () => {
    // Base 50% meets 50%; 49% is one point short. The -15-point stress is not a lender retest.
    const d = small();
    expect(run(d).checks.some((c) => c.key === "presale_threshold_unmet")).toBe(false);
    expect(contracts.FOR_SALE_DRAFT.stresses.find((s) => s.key === "presales")).toMatchObject({ presalesPts: -15 });
    const below = run({ ...d, forSale: { ...d.forSale!, presoldPct: 49 } });
    expect(below.checks.filter((c) => c.key === "presale_threshold_unmet")).toMatchObject([{ severity: "error", expected: 50, actual: 49, message: "The construction loan needs 50% presold; 49% is stated." }]);
    expect(below.verdict.code).toBe("REJECT");
  });
  test("interest after completion capitalizes before repayment", () => {
    // $50 senior x 1% in month 1, then $50.50 x 1% in month 2; it is repaid at that closing.
    const d = small(); d.senior.ratePct = 12;
    expect(value(run(d), "interest_after_completion").value).toBeCloseTo(1.005, 10);
  });
  test("unpaid debt rejects without negative distributions", () => {
    const d = small(); d.forSale!.units = d.forSale!.units.map((u) => ({ ...u, price: 1 }));
    const r = run(d);
    const unpaid = r.checks.find((c) => c.key === "for_sale_debt_unpaid")!;
    expect(unpaid).toMatchObject({ severity: "error" });
    expect(unpaid.actual).toBeCloseTo(70 - 3 * 0.9, 10);
    expect(r.verdict.code).toBe("REJECT");
    expect(r.equityFlows.filter((f) => f.kind === "sale").every((f) => f.amount >= 0)).toBe(true);
  });
  test("rental-only metrics are not applicable and the new metrics never enter rental results", () => {
    const rental = run(allEquityDeal());
    const sale = run(small());
    const shared = ["total_development_cost", "equity_multiple", "equity_irr", "peak_equity", "loan_to_cost", "required_equity", "cost_per_unit"];
    for (const m of rental.scenarios[0]!.metrics.filter((m) => !shared.includes(m.key))) expect(value(sale, m.key)).toMatchObject({ status: "NOT_APPLICABLE", value: null, reason: "The units are sold; there is no rental income." });
    expect(rental.scenarios[0]!.metrics.some((m) => m.key === "gross_sales_revenue")).toBe(false);
    expect(sale.ledger.every((r) => r.egi === 0 && r.noi === 0)).toBe(true);
    expect(sale.annual).toEqual([]);
  });
  test("the same for-sale input gives the same result hash", () => { expect(sha(run(small()))).toBe(sha(run(small()))); });
  // Card 125: readiness hashes moved only because GST/HST net and property tax are now listed as not found, not as choices; inputs, results and verdicts are unchanged.
  test("all six rental reference deals keep their input, outcome and result hashes", () => {
    const pins = [{"slug": "bergendal-kvarter", "readinessHash": "72acd0f865504c019dfc6b24372ecb92bc01d356815888a8e73ba1f896123c4d", "inputHash": null, "resultHash": null, "verdict": null}, {"slug": "cascade-row", "readinessHash": "c8c10f737d1c6fc7d4744d0a9c0f1d39a6413c2145d194015e91a0c826f270b7", "inputHash": "8e5a9ac2d0b28fb26cc48812a2531a87ce65bbcfbdb5ffcf89919627a24b0e8f", "resultHash": "c96a22dcaf0e48ace80f8b9ca68253dcf9908dbc72d7d503c3a155bebeb4fe5a", "verdict": "REJECT"}, {"slug": "dominion-exchange", "readinessHash": "d0917738a49b6268aa45cba4bd0caaaf6e2903414e972e096b7d97d523879035", "inputHash": null, "resultHash": null, "verdict": null}, {"slug": "lantern-fields", "readinessHash": "8a409536bbc0535b63e8639698ced7f00d557a602b92bdf31e179c6b3d84cc2f", "inputHash": "42dade922fc2a6c1c1a7b927907dea43321e01f8326bbdf33277801dcac5ffb8", "resultHash": "7c94ef2f72d6a4da9155b04088886bddb7d40a9b363f42363cc3bb7766ddfe42", "verdict": "REJECT"}, {"slug": "maple-heights", "readinessHash": "05efe83b5d4d2d4b22e5822c8c813b5ae07c363b67d38c9cdbb1ade8f7d7f4c0", "inputHash": "fc2f8f0bbcf00a469af82bde666fac6d75c04e173921766f99992c93b93ee24f", "resultHash": "c76c9e459c3abdb82b7d0f8c18707730c7ee47bdc54b995da44aa2fbd49dd54c", "verdict": "REJECT"}, {"slug": "northgate-cold-storage", "readinessHash": "38a8391b4b258235856bf4f3fba9d105f250c46a184ffea26112fca0e2aab523", "inputHash": null, "resultHash": null, "verdict": null}];
    for (const deal of loadOracles()) {
      const candidates = deal.documents.flatMap((doc) => extractCandidates(toNormalized(doc)).candidates.map((c) => ({ ...c, documentId: doc.name, documentName: doc.name })));
      const { readiness, input } = engine.assemble(consolidate(candidates).map((p) => ({ fieldKey: p.fieldKey, itemKey: p.itemKey, status: p.status === "conflicting" ? "conflicting" : "approved", valueNumeric: p.value })));
      const result = input ? run(input) : null;
      expect({ slug: deal.slug, readinessHash: sha(readiness), inputHash: input ? sha(input) : null, resultHash: result ? sha(result) : null, verdict: result?.verdict.code ?? null }).toEqual(pins.find((p) => p.slug === deal.slug));
    }
  });
  test("rental and held fixtures keep their complete ledger and result hashes", () => {
    const held: EngineInput = { ...developmentDeal(), exit: "refinance_hold", refinance: { month: 36, amount: 29000000, ratePct: 5, amortYears: 30, ioMonths: 0 } };
    // Frozen pre-94b policy, with no refinanceLimits. Its hash proves the exact stored-policy copy.
    const legacyInsuredPolicy = Object.freeze(
    {
      "maxLtcPct": 85,
      "baseSizingDscrFloor": 1.1,
      "maxFailedGatesForConditions": 2,
      "agreementTolerancePct": 1,
      "sourcePrecedence": [
        "lender_term_sheet",
        "appraisal",
        "budget",
        "rent_roll",
        "sponsor_summary",
        "market_study",
        "other"
      ],
      "stresses": [
        {
          "key": "exit_cap",
          "label": "Exit cap +75 bps",
          "exitCapBps": 75
        },
        {
          "key": "cost",
          "label": "Costs +10%",
          "costPct": 10
        },
        {
          "key": "rate",
          "label": "Interest rate +150 bps",
          "rateBps": 150
        },
        {
          "key": "rent",
          "label": "Rent -10%",
          "rentPct": -10
        },
        {
          "key": "occupancy",
          "label": "Occupancy -5 pts",
          "occupancyPts": -5
        },
        {
          "key": "expense",
          "label": "Operating costs +5 pts",
          "expensePts": 5
        },
        {
          "key": "combined",
          "label": "Combined",
          "exitCapBps": 75,
          "costPct": 10,
          "rateBps": 150,
          "rentPct": -10,
          "occupancyPts": -5,
          "expensePts": 5
        }
      ],
      "version": "rental-hold-insured-draft",
      "draft": true,
      "gates": {
        "developmentSpreadMinBps": 100,
        "dcrAfterRefinanceMin": 1.1,
        "stressedSizingDscrMin": 1.2,
        "stressedUnrealizedMultipleMin": 1
      },
      "gateKeys": [
        "development_spread",
        "dcr_after_refinance",
        "stressed_sizing_dscr",
        "stressed_unrealized_equity_multiple"
      ]
    } as const);
    expect(sha(legacyInsuredPolicy)).toBe("68828e103643ba37b73715961151693012cee5ad22fb24d702c269d39e4b2960");
    expect(legacyInsuredPolicy).not.toHaveProperty("refinanceLimits");
    const inputs = { rental: developmentDeal(), allEquity: allEquityDeal(), held, insured: { ...held, refinance: { ...held.refinance!, insurancePremiumPct: 4 } } };
    for (const pin of [{"name": "rental", "input": "0d2d665f09e3eb4fa03f0aa69ae97ef268d36775e01d92f84257739e5099df7d", "ledger": "c32c695fd8d80d883a79e1bbdaba30709f49e9d28d222f88c96906041eac86dd", "result": "ca707fa0c9e7414dbe944c3a6f1409cec7413f4f744293f4e3538ab4a5921395"}, {"name": "allEquity", "input": "ab34be3951216eda02b33cf6df1cade189bbe9955e6fcfba429464371f85db8f", "ledger": "4af891bcfe9d11c51db3422c116eb3e0d7c5888c1041a4fd25644e6a59e7a22b", "result": "f3d2cd0c98f657a0eb5a24e9a824045872ba741be3450153db1a573cbbfe0ef5"}, {"name": "held", "input": "090fc971d369184cb95bc3d9330f69dddcc3c19d5ed62e350cf2d28e8108ea7d", "ledger": "f13c6c0a79d0ffd1ddad852611d2037e06f000696dcd5d708734c13b14518ef2", "result": "b625d070932949181ae8affc679e34ade9809a7c02ee534daa12072e91d23e47"}, {"name": "insured", "input": "bfd5969f62772a5be63eb0ad7a54c061890436232b0035d16a9d09c031036993", "ledger": "3ecd3b5f1d032d0c9df1e580a1561dc620176e2297357bb95e4a20d7e3d7255e", "result": "1eecd188300f2356e8338c8836eec8c3c9068aba68581f7ac0dba2672607efbf"}]) {
      const input = inputs[pin.name as keyof typeof inputs];
      const ledger = engine.buildLedger(input);
      const result = pin.name === "insured" ? engine.replay(engine.ENGINE_VERSION, input, legacyInsuredPolicy) : run(input);
      expect({ name: pin.name, input: sha(input), ledger: sha(ledger), result: sha(result) }).toEqual(pin);
      if (pin.name === "insured" || pin.name === "held") {
        expect(ledger.refinance!.value).toBe(45075765);
        const legacyRefinance: Partial<NonNullable<typeof ledger.refinance>> = {...ledger.refinance!};
        delete legacyRefinance.value;
        expect(sha({...ledger,refinance:legacyRefinance})).toBe(pin.name === "insured"
          ? "a539e14e0823cde1643c5e0dbafc1566c5cf4b91775646d4b41cefa13e88ff2d"
          : "f5eb1ebe1b5cfe98baf793c4a87fb88b03ca1f7a1cf86f287306086b9e1f8b8a");
      }
    }
  });
  test.each([{"name": "insuredSelect", "input": "e0a637cbfe7cb62f6f7dd714240a2d17452a926dcb91d024c9c2becaa8af603f", "ledger": "3ecd3b5f1d032d0c9df1e580a1561dc620176e2297357bb95e4a20d7e3d7255e", "result": "1eecd188300f2356e8338c8836eec8c3c9068aba68581f7ac0dba2672607efbf", "policyVersion": "rental-hold-insured-draft"}, {"name": "insuredStandardShort", "input": "bfd5969f62772a5be63eb0ad7a54c061890436232b0035d16a9d09c031036993", "ledger": "3ecd3b5f1d032d0c9df1e580a1561dc620176e2297357bb95e4a20d7e3d7255e", "result": "747311cdafc972f06543f394140b5950f1915c6c2f0297ae8eaac37f9f530a60", "policyVersion": "rental-hold-insured-standard-short-draft"}])("card 94b current-policy pin: $name", (pin) => {
    const input: EngineInput = { ...developmentDeal(), exit: "refinance_hold", refinance: {
      month: 36, amount: 29000000, ratePct: 5, amortYears: 30, ioMonths: 0, insurancePremiumPct: 4,
      ...(pin.name === "insuredSelect" ? {mliSelectPoints:50} : {}),
    }};
    const policy=contracts.policyFor(input), result=engine.underwrite(input,policy);
    expect({name:pin.name,input:sha(input),ledger:sha(engine.buildLedger(input)),result:sha(result),policyVersion:result.policyVersion}).toEqual(pin);
    const select=pin.name === "insuredSelect";
    expect(result.verdict.gates.map(g=>({key:g.key,threshold:g.threshold,status:g.status}))).toEqual([
      {key:"development_spread",threshold:100,status:"failed"},
      {key:"dcr_after_refinance",threshold:select ? 1.10 : 1.30,status:select ? "passed" : "failed"},
      {key:"stressed_sizing_dscr",threshold:1.20,status:"failed"},
      {key:"stressed_unrealized_equity_multiple",threshold:1,status:"failed"},
    ]);
    expect(result.verdict.gates.filter(g=>g.status === "failed")).toHaveLength(select ? 3 : 4);
    expect(result.verdict.code).toBe("REJECT");
    if (select) expect(result.checks.filter(c=>c.severity === "error" && ["insured_min_units","refinance_ltv_limit","refinance_amort_limit"].includes(c.key))).toEqual([]);
    else {
      const warning=result.checks.find(c=>c.key === "base_sizing_dscr");
      expect(warning).toMatchObject({severity:"warning",expected:1.30,message:expect.stringContaining("under the 1.30x floor")});
      expect(warning!.actual).toBeLessThan(1.30);
    }
  });
  // Audit: checks read the base case only. Costs 100 (land 60, hard 40), debt 70 at 0%, one presold unit at 75:
  // the base repays 70 of 75; prices -10% leave 67.50, so 2.50 of debt is unpaid in that stress, shown in its metrics.
  test("debt left unpaid only under a stress is not an error check", () => {
    const input: EngineInput = { ...small(), forSale: { ...small().forSale!, units: [{ key: "A", label: "A", units: 1, price: 75 }],
      presoldPct: 100, absorptionPerMonth: 1, commissionPct: 0, closingLagMonths: 0, carryMonthly: 0 } };
    const r = run(input);
    expect(r.checks.map((c) => c.key)).not.toContain("for_sale_debt_unpaid");
    expect(value(r, "equity_distributed").value).toBeCloseTo(5, 9);
    expect(value(r, "equity_distributed", "prices").value).toBe(0);
    expect(engine.buildForSaleLedger(engine.applyStress(input, contracts.FOR_SALE_DRAFT.stresses[0]!)).values.ending_mezz_balance).toBeCloseTo(2.5, 9);
  });
});


describe("the run screen for a deal that sells its units (task 79)", () => {
  test.each(["kestrel-row-townhomes", "alder-court-condo"])("%s measures financing and cost per unit in every scenario", (slug) => {
    const d = (JSON.parse(readFileSync(new URL(`../../../oracles/for-sale/${slug}.outcome.json`, import.meta.url), "utf8")) as Oracle).inputs;
    const result = run(fromOracle(d));
    const commitments = d.senior_commitment + d.mezz_commitment;
    const units = d.unit_types.reduce((n, u) => n + u.units, 0);
    const shared = ["total_development_cost", "equity_multiple", "equity_irr", "peak_equity", "loan_to_cost", "required_equity", "cost_per_unit"];
    const rentalOnly = run(allEquityDeal()).scenarios[0]!.metrics.filter((m) => !shared.includes(m.key)).map((m) => m.key);
    for (const scenario of result.scenarios) {
      const tdc = value(result, "total_development_cost", scenario.key).value!;
      for (const [key, expected] of [["loan_to_cost", commitments / tdc * 100], ["required_equity", tdc - commitments], ["cost_per_unit", tdc / units]] as const) {
        expect(value(result, key, scenario.key)).toMatchObject({ status: "VALID", value: expected });
      }
      for (const key of rentalOnly) expect(value(result, key, scenario.key)).toMatchObject({ status: "NOT_APPLICABLE", value: null, reason: "The units are sold; there is no rental income." });
    }
  });
  test("zero development cost follows the rental denominator rule", () => {
    const result = run({ ...small(), budget: { land: 0, hard: 0, soft: 0, contingency: 0, other: 0 }, senior: { amount: 0, ratePct: 0, ioMonths: 0 }, mezzanine: undefined });
    expect(value(result, "loan_to_cost")).toMatchObject({ status: "NOT_MEANINGFUL", value: null, reason: "Total development cost is zero." });
    expect(value(result, "required_equity")).toMatchObject({ status: "VALID", value: 0 });
    expect(value(result, "cost_per_unit")).toMatchObject({ status: "VALID", value: 0 });
  });
  test.each([
    ["gross_sales_revenue", "Gross sales revenue", "units × sale price, every unit type"],
    ["net_sales_revenue", "Net sales revenue", "gross sales revenue − sales commission"],
    ["interest_before_completion", "Interest during construction", "interest on the loans before completion, whoever pays it"],
    ["interest_after_completion", "Interest after completion", "interest added to the loans from completion until they are repaid"],
    ["carry_total", "Carrying costs of unsold units", "carry per unit per month × units completed and not yet closed"],
    ["development_profit_for_sale", "Development profit (units sold)", "net sales revenue − total development cost − carrying costs − interest after completion"],
    ["profit_on_cost_for_sale", "Profit on cost (units sold)", "development profit / (total development cost + carrying costs + interest after completion)"],
    ["margin_on_revenue", "Margin on sales revenue", "development profit / net sales revenue"],
    ["equity_contributed", "Equity put in", "every equity payment, carrying costs included"],
    ["equity_distributed", "Equity returned", "sale proceeds left after the loans are repaid"],
    ["completion_month", "Completion (month)", "the construction period"],
    ["sellout_month", "Last closing (month)", "the month the last unit closes"],
    ["sellout_years", "Time to sell out", "(last closing month + 1) / 12"],
    ["deposits_held_at_completion", "Buyer deposits in trust at completion", "presold units × average price × deposit %; held in trust, never used for costs"],
    ["senior_balance_at_completion", "Senior loan balance at completion", "drawn senior debt plus its interest at completion"],
    ["mezz_balance_at_completion", "Mezzanine balance at completion", "drawn mezzanine debt plus its interest at completion"],
  ] as const)("%s has the specified label and formula", (key, label, formula) => {
    expect(contracts.METRIC_BY_KEY.get(key)).toMatchObject({ label, formula });
  });
  test("no two catalog metrics share a label", () => {
    expect(new Set(contracts.METRICS.map((m) => m.label)).size).toBe(contracts.METRICS.length);
  });
});
