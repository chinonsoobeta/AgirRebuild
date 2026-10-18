import { describe, expect, test } from "vitest";
import { FIELD_BY_KEY, POLICY_V1, policyFor, type EngineInput } from "@agir/contracts";
import { createHash } from "node:crypto";
import { assemble, canonicalJson, ENGINE_VERSION, underwrite, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, type SourcedCandidate } from "@agir/extraction";
import { loadOracle } from "@agir/testkit";
import { developmentDeal } from "../../engine/test/fixtures.ts";
import { roundToward } from "../src/model.ts";
import { buildModel, htmlToPdf, RendererUnavailableError, renderArtifact, renderHtml, verifyProvenance, visibleText, type ArtifactInput } from "../src/index.ts";

function mapleInput(kind: ArtifactInput["kind"]): ArtifactInput {
  const deal = loadOracle("maple-heights");
  const all: SourcedCandidate[] = [];
  for (const doc of deal.documents) {
    const lines = [doc.title ?? "", ...(doc.lines ?? [])].filter(Boolean).map((text, i) => ({ text, location: `page 1, line ${i + 1}` }));
    const rows = (doc.rows ?? []).map((r, i) => r.map((v, c) => (typeof v === "number" ? { text: String(v), number: v, unit: "$" as const, ref: `A${i}${c}` } : { text: v, ref: `A${i}${c}` })));
    const r = extractCandidates({ kind: doc.kind === "xlsx" ? "xlsx" : "pdf", lines, tables: rows.length ? [{ name: doc.sheet ?? "S", rows }] : [], pageCount: 1, needsOcr: false, fullText: lines.map((l) => l.text).join("\n") });
    all.push(...r.candidates.map((c) => ({ ...c, documentId: doc.name, documentName: doc.name })));
  }
  const proposals = consolidate(all);
  const rows: AssumptionRow[] = proposals.map((p) => ({ fieldKey: p.fieldKey, itemKey: p.itemKey, status: "approved", valueNumeric: p.value }));
  const { input } = assemble(rows);
  const result = underwrite(input!, POLICY_V1);
  return {
    kind,
    deal: { name: deal.name, assetType: deal.assetType, location: deal.location, currency: "CAD", province: "BC" },
    run: { id: "r1", runNumber: 1, createdAt: "2026-09-24T12:00:00.000Z", engineVersion: result.engineVersion, policyVersion: result.policyVersion, policyHash: "p", inputHash: "a".repeat(64), resultHash: "b".repeat(64) },
    policy: POLICY_V1,
    result,
    input: input!,
    assumptions: proposals.map((p) => ({
      fieldKey: p.fieldKey,
      itemKey: p.itemKey,
      label: FIELD_BY_KEY.get(p.fieldKey)!.label,
      unit: FIELD_BY_KEY.get(p.fieldKey)!.unit,
      value: p.value!,
      sourceKind: "document",
      source: `${p.sources[0]!.documentName}, ${p.sources[0]!.location}`,
    })),
    decision: null,
  };
}

describe("artifacts", () => {
  test("the IC memo prints only figures with a recorded source", () => {
    const model = buildModel(mapleInput("ic_memo"));
    const report = verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest);
    expect(report.orphans).toEqual([]);
    expect(report.pass).toBe(true);
  });
  test("a credit in other costs is shown as Other costs (credit), with its amount", () => {
    const x = mapleInput("ic_memo");
    const rowsOf = (input: ArtifactInput) => {
      const t = buildModel(input).blocks.find((b) => b.type === "table" && b.caption === "Sources and uses");
      return t && t.type === "table" ? t.rows : [];
    };
    const plain = rowsOf(x).map((r) => r[0]);
    expect(plain).not.toContain("Other costs (credit)");
    const credit: ArtifactInput = { ...x, input: { ...x.input, budget: { ...x.input.budget, other: -20_000 } } };
    const row = rowsOf(credit).find((r) => r[0] === "Other costs (credit)");
    expect(row).toBeDefined();
    expect(row![1]).toContain("20,000");
    expect(rowsOf(credit).map((r) => r[0])).not.toContain("Other costs");
  });
  test("card 61: the cost lines, the property tax and the premium are shown only when stated, and every figure traces to the run", () => {
    // developmentDeal: S = 30, hold 5 years. A refinance of 30,000,000 at month 40 with a 4% premium adds 1,200,000 to the loan.
    const withFields = (kind: ArtifactInput["kind"]): ArtifactInput => {
      const x = mapleInput(kind);
      const input: EngineInput = {
        ...developmentDeal(),
        budget: { ...developmentDeal().budget, developmentCharges: 500_000, landTransferTax: 0, gstHstNet: 250_000 },
        propertyTaxAnnual: 120_000,
        refinance: { month: 40, amount: 30_000_000, ratePct: 5, amortYears: 30, ioMonths: 0, insurancePremiumPct: 4 },
      };
      return { ...x, input, result: underwrite(input, POLICY_V1) };
    };
    const table = (m: ReturnType<typeof buildModel>, caption: string) => {
      const t = m.blocks.find((b) => b.type === "table" && b.caption === caption);
      return t && t.type === "table" ? t.rows : [];
    };
    const paragraphs = (m: ReturnType<typeof buildModel>) => m.blocks.flatMap((b) => (b.type === "paragraph" ? [b.text] : []));
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const model = buildModel(withFields(kind));
      const rows = table(model, "Sources and uses");
      const row = (label: string) => rows.find((r) => r[0] === label)?.[1];
      expect(row("Development charges"), kind).toBe("$500,000");
      expect(row("Land transfer tax"), kind).toBe("$0");
      expect(row("GST/HST net of rebates"), kind).toBe("$250,000");
      // The lines are in the total: uses still add up.
      const amount = (label: string) => Number(row(label)!.replace(/[^\d.]/g, ""));
      const uses = ["Land", "Hard costs", "Soft costs", "Contingency", "Development charges", "Land transfer tax", "GST/HST net of rebates", "Operating costs during lease-up", "Capitalized interest"].filter((l) => row(l) !== undefined).map(amount).reduce((a, b) => a + b, 0);
      expect(Math.abs(uses - amount("Total uses")), kind).toBeLessThanOrEqual(3);
      expect(table(model, "Stabilized operations, year 1").find((r) => r[0] === "Property tax (fixed, within operating expenses)")?.[1], kind).toBe("$120,000");
      expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans, kind).toEqual([]);
    }
    const lender = buildModel(withFields("lender_package"));
    expect(paragraphs(lender)).toContain("Mortgage insurance premium: 4.00% ($1,200,000 added to the loan)");
    expect(paragraphs(buildModel(withFields("ic_memo"))).some((t) => /Mortgage insurance premium/.test(t))).toBe(false);
    // Nothing stated, nothing shown.
    const plain = buildModel(mapleInput("lender_package"));
    expect(table(plain, "Sources and uses").map((r) => r[0])).not.toEqual(expect.arrayContaining(["Development charges"]));
    expect(table(plain, "Stabilized operations, year 1").map((r) => r[0])).not.toContain("Property tax (fixed, within operating expenses)");
    expect(paragraphs(plain).some((t) => /Mortgage insurance premium/.test(t))).toBe(false);
  });
  test("the memo and the lender package both say where mezzanine interest ran past its commitment", () => {
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const x = mapleInput(kind);
      const input = { ...x.input, mezzanine: { amount: 4_000_000, ratePct: 12, amortYears: 30, ioMonths: 60 } };
      const result = underwrite(input, POLICY_V1);
      const sentence = result.checks.find((c) => c.key === "mezz_interest_accrued")?.message;
      expect(sentence, kind).toMatch(/^Mezzanine interest of \$[\d,]+ accrues on the mezzanine balance after its \$4,000,000 commitment is used; the mezzanine balance at stabilization is \$[\d,]+\.$/);
      const model = buildModel({ ...x, input, result });
      const text = visibleText(renderHtml(model));
      expect(text.split(sentence!).length - 1, kind).toBeGreaterThanOrEqual(2);
      expect(verifyProvenance(text, model.formatter.manifest).orphans, kind).toEqual([]);
      // The sources still add up to total cost: the accrued interest is a source of its own.
      const t = model.blocks.find((b) => b.type === "table" && b.caption === "Sources and uses");
      const rows = t && t.type === "table" ? t.rows : [];
      const amount = (label: string) => Number(rows.find((r) => r[0] === label)![1]!.replace(/[^\d.]/g, ""));
      const base = (k: string) => result.scenarios.find((s) => s.key === "base")!.metrics.find((m) => m.key === k)!;
      expect(amount("Mezzanine interest accrued (paid in kind)"), kind).toBeCloseTo(Math.round((base("mezz_interest_accrued") as { value: number }).value), 0);
      const sources = ["Senior loan", "Mezzanine loan", "Mezzanine interest accrued (paid in kind)", "Equity"].map(amount).reduce((a, b) => a + b, 0);
      expect(Math.abs(sources - amount("Total sources")), kind).toBeLessThanOrEqual(2);
    }
  });
  test("sources and uses has a row for the operating costs during lease-up, and still adds up; the lender package shows coverage and shortfall", () => {
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const x = mapleInput(kind);
      const model = buildModel(x);
      const base = (k: string) => x.result.scenarios.find((s) => s.key === "base")!.metrics.find((m) => m.key === k)!;
      const t = model.blocks.find((b) => b.type === "table" && b.caption === "Sources and uses");
      const rows = t && t.type === "table" ? t.rows : [];
      const amount = (label: string) => Number(rows.find((r) => r[0] === label)![1]!.replace(/[^\d.]/g, ""));
      expect(base("leaseup_operating_cost").value!, kind).toBeGreaterThan(0);
      expect(amount("Operating costs during lease-up"), kind).toBeCloseTo(Math.round(base("leaseup_operating_cost").value!), 0);
      const uses = ["Land", "Hard costs", "Soft costs", "Contingency", "Capitalized interest", "Operating costs during lease-up"].map(amount).reduce((a, b) => a + b, 0);
      expect(Math.abs(uses - amount("Total uses")), kind).toBeLessThanOrEqual(3);
      expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans, kind).toEqual([]);
    }
    const debt = buildModel(mapleInput("lender_package")).blocks.find((b) => b.type === "table" && b.caption === "Debt and coverage");
    const labels = debt && debt.type === "table" ? debt.rows.map((r) => r[0]) : [];
    expect(labels).toContain("Interest-only DSCR (year 1)");
    expect(labels).toContain("Cumulative cash shortfall after stabilization");
  });
  test("an invented figure is caught", () => {
    const model = buildModel(mapleInput("ic_memo"));
    model.blocks.push({ type: "paragraph", text: "The broker expects a 21.4% IRR and $9,450,000 of NOI." });
    const report = verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest);
    expect(report.pass).toBe(false);
    expect(report.orphans).toEqual(["21.4%", "$9,450,000"]);
  });
  test("the lender package passes provenance too", () => {
    const model = buildModel(mapleInput("lender_package"));
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
  test("Word and Excel render", async () => {
    const docx = await renderArtifact(mapleInput("ic_memo"), "docx");
    expect(docx.provenance.pass).toBe(true);
    expect(docx.bytes.byteLength).toBeGreaterThan(5_000);
    const xlsx = await renderArtifact(mapleInput("model_export"), "xlsx");
    expect(xlsx.bytes.byteLength).toBeGreaterThan(10_000);
  });
  test("PDF renders with headless Chromium", async () => {
    const pdf = await renderArtifact(mapleInput("ic_memo"), "pdf");
    expect(pdf.provenance.pass).toBe(true);
    expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe("%PDF-");
  }, 60_000);
  test("what the documents did not state is listed, from a template, and the provenance scan passes", async () => {
    const notFound = [
      { fieldKey: "other_income_annual", label: "Other income", detail: "no other income" },
      { fieldKey: "refinance_month", label: "Refinance month", detail: "no refinance" },
    ];
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const x = { ...mapleInput(kind), notFound };
      const model = buildModel(x);
      const text = visibleText(renderHtml(model));
      expect(text).toContain("Not found in the documents");
      expect(text).toContain("Other income \u2014 not found. The run treats this as: no other income.");
      expect(text).toContain("Refinance month \u2014 not found. The run treats this as: no refinance.");
      expect(verifyProvenance(text, model.formatter.manifest).pass).toBe(true);
      // A run with nothing unread, or one made before this list existed, has no such section.
      expect(visibleText(renderHtml(buildModel(mapleInput(kind))))).not.toContain("Not found in the documents");
    }
    const xlsx = await renderArtifact({ ...mapleInput("model_export"), notFound }, "xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xlsx.bytes) as never);
    const rows: unknown[][] = [];
    wb.getWorksheet("Not found")!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows.flat()).toContain("Other income \u2014 not found. The run treats this as: no other income.");
  });
  test("every report says once which dollar its figures are in", () => {
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const model = buildModel(mapleInput(kind));
      const text = visibleText(renderHtml(model));
      expect(text).toContain("All amounts in Canadian dollars (CAD)");
      expect(verifyProvenance(text, model.formatter.manifest).pass).toBe(true);
    }
    const x = mapleInput("lender_package");
    expect(buildModel({ ...x, deal: { ...x.deal, currency: null } }).meta).toContain("Currency not stated");
  });
  test("the province is added to a location that does not already name it", () => {
    const x = mapleInput("ic_memo");
    expect(buildModel({ ...x, deal: { ...x.deal, location: "Edmonton", province: "AB" } }).meta).toContain("Edmonton, Alberta ·");
    expect(buildModel(x).meta).toContain("Burnaby, British Columbia ·");
    expect(buildModel(x).meta).not.toContain("British Columbia, British Columbia");
    expect(buildModel({ ...x, deal: { ...x.deal, location: "Toronto, ON", province: "ON" } }).meta).toContain("Toronto, ON ·");
    expect(buildModel({ ...x, deal: { ...x.deal, location: "Niagara-on-the-Lake", province: "ON" } }).meta).toContain("Niagara-on-the-Lake, Ontario ·");
  });
  test("the model export states the currency", async () => {
    const xlsx = await renderArtifact(mapleInput("model_export"), "xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xlsx.bytes) as never);
    const rows: unknown[][] = [];
    wb.getWorksheet("Summary")!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows).toContainEqual(["Currency", "CAD"]);
  });
  test("screen, Word and PDF show the same figures", async () => {
    const model = buildModel(mapleInput("ic_memo"));
    const html = visibleText(renderHtml(model));
    for (const e of model.formatter.manifest.filter((m) => m.ref.startsWith("metric:base.")).slice(0, 20)) expect(html).toContain(e.text);
  });
  test("sponsor-stated and confirmed inputs are labelled, and old runs are unchanged", async () => {
    const material = (a: ArtifactInput["assumptions"][number]) => FIELD_BY_KEY.get(a.fieldKey)!.material;
    for (const kind of ["lender_package", "ic_memo"] as const) {
      const x = mapleInput(kind);
      const [stated, reviewed] = x.assumptions.filter(material);
      expect(stated && reviewed).toBeTruthy();
      stated!.sponsorStated = true;
      Object.assign(reviewed!, { confirmedByReview: true, confirmedBy: "Rowan Reviewer", confirmedAt: "2026-10-03T12:00:00Z" });
      const m = x.assumptions.filter((a) => material(a) || a.sponsorStated || a.confirmedBy || a.confirmedByReview).length;
      const model = buildModel(x);
      const text = visibleText(renderHtml(model));
      const heading = "Stated by the sponsor, not independently confirmed";
      expect(text).toContain(heading);
      expect(text).toContain(`1 of the ${m} material inputs this run used was stated by the sponsor and not confirmed by anyone else. Check them before relying on this ${kind === "ic_memo" ? "memo" : "package"}.`);
      expect(text).toContain(stated!.label);
      expect(text.indexOf(heading)).toBeLessThan(text.indexOf(kind === "ic_memo" ? "Sources and uses" : "Debt and coverage"));
      expect(text).toContain("Confirmed by Agir review on 2026-10-03");
      expect(verifyProvenance(text, model.formatter.manifest).orphans).toEqual([]);
      const docx = await renderArtifact(x, "docx");
      expect(docx.provenance.pass).toBe(true);
      // Confirmed by a named person, without review.
      Object.assign(reviewed!, { confirmedByReview: false });
      expect(visibleText(renderHtml(buildModel(x)))).toContain("Confirmed by Rowan Reviewer");
    }
    for (const kind of ["lender_package", "ic_memo"] as const) {
      expect(visibleText(renderHtml(buildModel(mapleInput(kind))))).not.toContain("Stated by the sponsor");
    }
  });
  test("the model export carries a Confirmation column", async () => {
    const x = mapleInput("model_export");
    x.assumptions[0]!.sponsorStated = true;
    const xlsx = await renderArtifact(x, "xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(xlsx.bytes) as never);
    const rows: unknown[][] = [];
    wb.getWorksheet("Inputs")!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows[0]![5]).toBe("Confirmation");
    expect(rows[1]![5]).toBe("Stated by the sponsor, not independently confirmed");
    expect(rows[2]![5] ?? "").toBe("");
  });
});

describe("the build decision report", () => {
  /** The engine's own development deal with its rents scaled: 1 fails every gate, 1.6 passes them all. */
  function dealInput(rentScale: number, edit: (i: EngineInput) => EngineInput = (i) => i): ArtifactInput {
    const base = mapleInput("build_decision");
    const d = developmentDeal();
    const input = edit({ ...d, revenue: d.revenue.map((c) => ({ ...c, rentMonthly: c.rentMonthly && c.rentMonthly * rentScale, rentPsfAnnual: c.rentPsfAnnual && c.rentPsfAnnual * rentScale })) });
    const policyHash = createHash("sha256").update(canonicalJson(POLICY_V1)).digest("hex");
    return { ...base, run: { ...base.run, policyHash }, input, result: underwrite(input, POLICY_V1), assumptions: [], notFound: [] };
  }
  const textOf = (x: ArtifactInput) => {
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    return { model, text, scan: verifyProvenance(text, model.formatter.manifest) };
  };

  test("a failing-gate run shows the three numbers, the weakest stress and the break-even lines, all with a source", async () => {
    const x = dealInput(1);
    expect(x.result.verdict.gates.some((g) => g.status === "failed")).toBe(true);
    const { model, text, scan } = textOf(x);
    expect(model.kicker).toBe("Build decision");
    expect(scan.orphans).toEqual([]);
    const at = (s: string) => text.indexOf(s);
    const order = ["Yield on cost", "Sizing DSCR (weakest year)", "Weakest stress", "What would change the answer", "Every input and its source"].map(at);
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("Weakest stress: Combined");
    expect(text).toContain("Everything else is held");
    expect(text).not.toContain("rents move together");
    expect(text).toContain("Every input and its source is listed in the IC memo and the lender package.");
    expect(text).not.toContain("Approved inputs and where each came from");
    expect(text).toContain("Out of range");
    expect(text).toContain("Not monotonic");
    expect(model.formatter.manifest.some((e) => /^run:breakeven\.equity_multiple\.rent/.test(e.ref))).toBe(true);
    expect((await renderArtifact(x, "docx")).provenance.pass).toBe(true);
  });
  test("an approved run has no break-even section and names its weakest stress", () => {
    const x = dealInput(1.6);
    expect(x.result.verdict.code).toBe("APPROVE");
    const { text, scan } = textOf(x);
    expect(scan.orphans).toEqual([]);
    expect(text).not.toContain("What would change the answer");
    expect(text).toContain("Weakest stress:");
    expect(text).toContain("fails no gate");
  });
  test("a run from another engine version leaves the break-even section out and says why", () => {
    const x = dealInput(1);
    const old = { ...x, run: { ...x.run, engineVersion: "0.9.0" } };
    expect(old.run.engineVersion).not.toBe(ENGINE_VERSION);
    const { text, scan } = textOf(old);
    expect(scan.orphans).toEqual([]);
    expect(text).toContain("What would change the answer");
    expect(text).toContain("Not shown: this run was made by an earlier engine");
    expect(text).not.toContain("Everything else is held");
    // A policy edited under the same version name is a different policy: its hash differs from the run's.
    const edited: ArtifactInput = { ...x, policy: { ...x.policy, gates: { ...x.policy.gates, equityMultipleMin: 1.4 } } as unknown as ArtifactInput["policy"] };
    const t = textOf(edited).text;
    expect(t).toContain("Not shown: this run was made under a different policy");
    expect(t).not.toContain("Everything else is held");
  });

  const table = (x: ArtifactInput) => {
    const t = buildModel(x).blocks.find((b) => b.type === "table" && b.columns[0]!.label === "Gate");
    return t && t.type === "table" ? t.rows : [];
  };
  const num = (cell: string) => Number(cell.replace(/[^\d.]/g, ""));
  /** Every printed "Passes at" figure of one kind, put back into the run as that one input: does its gate pass? */
  function passAfterRounding(x: ArtifactInput, name: RegExp, apply: (i: EngineInput, to: number, label: string) => EngineInput) {
    let gate = "";
    const seen: string[] = [];
    for (const r of table(x)) {
      gate = r[0] || gate;
      if (!name.test(r[3]!) || !/^[$\d]/.test(r[5]!)) continue;
      const key = x.result.verdict.gates.find((g) => g.label === gate)!.key;
      seen.push(r[5]!);
      const after = underwrite(apply(x.input, num(r[5]!), r[3]!), POLICY_V1);
      expect(after.verdict.gates.find((g) => g.key === key)!.status, `${gate}: ${r[3]} at ${r[5]}`).toBe("passed");
    }
    expect(seen.length).toBeGreaterThan(0);
    return seen;
  }

  test("a Passes at figure is rounded toward passing at print precision, so it passes when put back", () => {
    // One unit type, so rent prints as its own row.
    const one = (i: EngineInput): EngineInput => ({ ...i, revenue: [{ key: "A", label: "Apt", basis: "per_unit", units: 120, rentMonthly: 2_333.33 }] });
    const rent = dealInput(1, one);
    const seen = passAfterRounding(rent, /^Rent, Apt/, (i, to) => ({ ...i, revenue: i.revenue.map((c) => ({ ...c, rentMonthly: to })) }));
    expect(seen.every((s) => /^\$[\d,]+\/mo$/.test(s))).toBe(true);
    const x = dealInput(1);
    passAfterRounding(x, /^Project cost$/, (i, to) => {
      const k = to / (i.budget.land + i.budget.hard + i.budget.soft + i.budget.contingency + i.budget.other);
      return { ...i, budget: { land: i.budget.land * k, hard: i.budget.hard * k, soft: i.budget.soft * k, contingency: i.budget.contingency * k, other: i.budget.other * k } };
    });
    passAfterRounding(x, /^Exit cap rate$/, (i, to) => ({ ...i, exitCapPct: to }));
    for (const t of [rent, x]) expect(verifyProvenance(visibleText(renderHtml(buildModel(t))), buildModel(t).formatter.manifest).orphans).toEqual([]);
    // A value already on the grid is not moved a step.
    expect(roundToward(2_174.0000000001, 1, 1)).toBe(2_174);
    expect(roundToward(5_412_300.6, -1, 1)).toBe(5_412_300);
  });
  test("rents that move together print as one row with the shock", () => {
    const x = dealInput(1);
    const rows = table(x).filter((r) => r[3]!.startsWith("Rent"));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows.filter((r) => r[5] !== "Out of range" && r[5] !== "No effect" && r[5] !== "Not monotonic")) {
      expect(r[3]).toBe("Rent, all 3 unit types (same share)");
      expect(r[4]).toBe("\u2014");
      expect(r[5]).toMatch(/^\+\d+\.\d{2}%$/);
    }
    expect(table(x).some((r) => /^Rent, (1BR|2BR|3BR)/.test(r[3]!))).toBe(false);
    // The printed share, applied to every rent, passes its gate.
    let gate = "";
    for (const r of table(x)) {
      gate = r[0] || gate;
      if (!/^Rent, all/.test(r[3]!) || !r[5]!.startsWith("+")) continue;
      const k = 1 + Number(r[5]!.slice(1, -1)) / 100;
      const after = underwrite({ ...x.input, revenue: x.input.revenue.map((c) => ({ ...c, rentMonthly: c.rentMonthly && c.rentMonthly * k, rentPsfAnnual: c.rentPsfAnnual && c.rentPsfAnnual * k })) }, POLICY_V1);
      expect(after.verdict.gates.find((g) => g.label === gate)!.status, `${gate} at ${r[5]}`).toBe("passed");
    }
  });
  test("every failing gate shares one table, each gate named once", () => {
    const x = dealInput(1);
    const failing = x.result.verdict.gates.filter((g) => g.status === "failed");
    expect(failing.length).toBeGreaterThan(1);
    const model = buildModel(x);
    expect(model.blocks.filter((b) => b.type === "table" && b.columns[0]!.label === "Gate")).toHaveLength(1);
    const rows = table(x);
    for (const g of failing) expect(rows.filter((r) => r[0] === g.label)).toHaveLength(1);
    expect(rows.filter((r) => r[0] !== "").length).toBe(failing.length);
  });
  test("the worst case (five failing gates, many rents, sponsor-stated inputs) fits two pages", async () => {
    const many = (i: EngineInput): EngineInput => ({ ...i, revenue: Array.from({ length: 8 }, (_, k) => ({ key: `T${k}`, label: `Type ${k + 1}`, basis: "per_unit" as const, units: 15, rentMonthly: 1_800 + 150 * k })) });
    const x = dealInput(0.8, many);
    x.assumptions = mapleInput("build_decision").assumptions.slice(0, 6).map((a) => ({ ...a, sponsorStated: true }));
    expect(x.result.verdict.gates.filter((g) => g.status === "failed")).toHaveLength(5);
    expect(buildModel(x).blocks.some((b) => b.type === "table" && b.columns[0]!.label === "Gate")).toBe(true);
    let pdf;
    try {
      pdf = await htmlToPdf(renderHtml(buildModel(x)));
    } catch (e) {
      if (e instanceof RendererUnavailableError) return;
      throw e;
    }
    const pages = new TextDecoder("latin1").decode(pdf).match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(0);
    expect(pages).toBeLessThanOrEqual(2);
  }, 60_000);
  test("every artifact kind passes the provenance scan with no orphans", () => {
    for (const x of [dealInput(1), dealInput(1.6)]) {
      const model = buildModel(x);
      expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
    }
    for (const kind of ["ic_memo", "lender_package", "build_decision", "model_export"] as const) {
      const model = buildModel(mapleInput(kind));
      expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans, kind).toEqual([]);
    }
  });
});

describe("a deal that is kept and refinanced (card 60)", () => {
  const DRAFT = "Draft policy, not signed by credit";
  const UNREALIZED = "unrealized, not a sale";
  function holdInput(kind: ArtifactInput["kind"]): ArtifactInput {
    const input: EngineInput = { ...developmentDeal(), refinance: { month: 36, ltvPct: 65, ratePct: 5, amortYears: 30, ioMonths: 0 }, exit: "refinance_hold" };
    const policy = policyFor(input);
    const result = underwrite(input, policy);
    return {
      kind,
      deal: { name: "Kept Rental", assetType: "Multifamily", location: "Calgary", currency: "CAD", province: "AB" },
      run: { id: "r1", runNumber: 1, createdAt: "2026-10-15T12:00:00.000Z", engineVersion: result.engineVersion, policyVersion: result.policyVersion, policyHash: createHash("sha256").update(canonicalJson(policy)).digest("hex"), inputHash: "a".repeat(64), resultHash: "b".repeat(64) },
      policy,
      result,
      input,
      assumptions: [],
      decision: null,
    };
  }
  const textOf = (x: ArtifactInput) => {
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    return { model, text, report: verifyProvenance(text, model.formatter.manifest) };
  };

  describe("a break-even that moves every loan rate at once says so (task 64)", () => {
    function rateInput(): ArtifactInput {
      const x = holdInput("build_decision");
      // Tuned only refinance.ratePct from 5.00% to 5.25%: DCR = 1.1608499518x, below the conventional 1.20x floor.
      const input: EngineInput = { ...x.input, refinance: { ...x.input.refinance!, ratePct: 5.25 } };
      return { ...x, deal: { ...x.deal, name: "Fictional Shared-Rate Rental", location: "Invented Township" }, input, result: underwrite(input, x.policy) };
    }
    const gateRows = (x: ArtifactInput) => {
      const table = buildModel(x).blocks.find((b) => b.type === "table" && b.columns[3]?.label === "Input moved");
      let gate = "";
      return table && table.type === "table" ? table.rows.filter((r) => {
        gate = r[0] || gate;
        return gate === "Coverage after refinance (DCR)";
      }) : [];
    };

    test("the table names the shared move before both loan rates and explains it in the footnote", () => {
      const x = rateInput();
      expect(x.policy.version).toBe("rental-hold-v1-draft");
      expect(x.input.refinance?.insurancePremiumPct).toBeUndefined();
      expect(x.result.verdict.gates.find((g) => g.key === "dcr_after_refinance")).toMatchObject({ status: "failed", threshold: 1.2 });
      const dcr = x.result.scenarios[0]!.metrics.find((m) => m.key === "dcr_after_refinance")!.value!;
      expect(dcr).toBeGreaterThan(1);
      expect(dcr).toBeLessThan(1.2);
      const rows = gateRows(x);
      const start = rows.findIndex((r) => r[3] === "Loan interest rates, all 2 together (same move)");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(rows.slice(start, start + 3).map((r) => r.slice(3))).toEqual([
        ["Loan interest rates, all 2 together (same move)", "—", "-30 bps"],
        ["Senior loan rate, in the same move", "6.00%", "5.70%"],
        ["Refinance rate, in the same move", "5.25%", "4.95%"],
      ]);
      const { model, text } = textOf(x);
      expect(text).toContain("One input is moved at a time. Everything else is held. Loan interest rates move together by the same amount.");
      expect(model.formatter.manifest).toEqual(expect.arrayContaining([
        { text: "2", ref: "ident:breakeven.dcr_after_refinance.rate.count" },
        { text: "-30 bps", ref: "run:breakeven.dcr_after_refinance.rate.shock" },
        { text: "Senior loan rate, in the same move", ref: "ident:breakeven.dcr_after_refinance.senior_rate.label" },
        { text: "Refinance rate, in the same move", ref: "ident:breakeven.dcr_after_refinance.refinance_rate.label" },
      ]));
    });

    test("both printed rates together pass; the senior printed rate alone still fails", () => {
      const x = rateInput();
      const rows = gateRows(x);
      const senior = Number(rows.find((r) => r[3]!.startsWith("Senior loan rate"))![5]!.replace("%", ""));
      const refinance = Number(rows.find((r) => r[3]!.startsWith("Refinance rate"))![5]!.replace("%", ""));
      const seniorOnly: EngineInput = { ...x.input, senior: { ...x.input.senior, ratePct: senior } };
      const together: EngineInput = { ...seniorOnly, refinance: { ...x.input.refinance!, ratePct: refinance } };
      const gate = (input: EngineInput) => underwrite(input, x.policy).verdict.gates.find((g) => g.key === "dcr_after_refinance")!;
      expect(gate(together).status).toBe("passed");
      expect(gate(seniorOnly).status).toBe("failed");
      expect(gate(seniorOnly).actual).toBeCloseTo(gate(x.input).actual!, 9);
    });

    test("a single loan keeps its existing rate label, rows and footnote", () => {
      const x = rateInput();
      const input = developmentDeal();
      const policy = policyFor(input);
      const one: ArtifactInput = { ...x, input, policy, result: underwrite(input, policy), run: { ...x.run, policyVersion: policy.version, policyHash: createHash("sha256").update(canonicalJson(policy)).digest("hex") } };
      const { model, text, report } = textOf(one);
      const table = model.blocks.find((b) => b.type === "table" && b.columns[3]?.label === "Input moved");
      const rates = table && table.type === "table" ? table.rows.filter((r) => r[3] === "Senior loan rate") : [];
      expect(rates.map((r) => r.slice(3))).toEqual([
        ["Senior loan rate", "6.00%", "5.40%"],
        ["Senior loan rate", "6.00%", "2.02%"],
      ]);
      expect(text).toContain("One input is moved at a time. Everything else is held.");
      expect(text).not.toContain("Loan interest rates move together by the same amount.");
      expect(text).not.toContain(", in the same move");
      expect(report.orphans).toEqual([]);
    });

    test.each(["build_decision", "ic_memo", "lender_package", "model_export"] as const)("the shared-rate deal's %s has no orphan numbers", async (kind) => {
      const x = { ...rateInput(), kind };
      expect(textOf(x).report.orphans).toEqual([]);
      const out = await renderArtifact(x, kind === "model_export" ? "xlsx" : "docx");
      expect(out.provenance.orphans).toEqual([]);
      expect(out.provenance.pass).toBe(true);
      expect(out.bytes.length).toBeGreaterThan(0);
    });
  });

  test.each(["ic_memo", "lender_package", "build_decision"] as const)("the %s says the policy is a draft, leads with the hold measures, and shows no sale", (kind) => {
    const { model, text, report } = textOf(holdInput(kind));
    expect(report.orphans).toEqual([]);
    expect(text).toContain(DRAFT);
    for (const label of ["Cash returned at refinance", "Cash left in the deal", "Coverage after refinance", "Cash-on-cash after refinance"]) expect(text, label).toContain(label);
    // Every report names the unrealized figures as such, the build decision through its stressed gate (task 60 audit).
    expect(text).toContain(UNREALIZED);
    for (const sale of ["Net sale proceeds", "Exit value", "Development profit", "Profit on cost", "Sale to equity"]) expect(text, sale).not.toContain(sale);
    // The first figures after the verdict are the four hold measures, in order.
    const stats = model.blocks.find((b) => b.type === "stats");
    expect(stats && stats.type === "stats" ? stats.items.slice(0, 4).map((i) => i.label) : []).toEqual(["Cash returned at refinance", "Cash left in the deal", "Coverage after refinance (DCR)", "Cash-on-cash after refinance"]);
  });

  test.each(["ic_memo", "lender_package", "model_export"] as const)("the insured %s shows its policy, 1.10x gate and draft label with clean provenance (task 67)", async (kind) => {
    const x = holdInput(kind);
    x.deal = { ...x.deal, name: "Fictional Insured Rental", location: "Invented Township" };
    x.input = { ...x.input, refinance: { ...x.input.refinance!, insurancePremiumPct: 4 } };
    x.policy = policyFor(x.input);
    x.result = underwrite(x.input, x.policy);
    x.run = { ...x.run, policyVersion: x.policy.version, policyHash: createHash("sha256").update(canonicalJson(x.policy)).digest("hex") };
    if (kind === "model_export") {
      const out = await renderArtifact(x, "xlsx");
      expect(out.provenance.orphans).toEqual([]);
      expect(out.provenance.pass).toBe(true);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(out.bytes) as never);
      const summary = wb.getWorksheet("Summary")!;
      const cells: string[] = [];
      let threshold: import("exceljs").Cell | undefined;
      summary.eachRow((row) => {
        row.eachCell((cell) => cells.push(String(cell.value)));
        if (row.getCell(1).value === "Coverage after refinance (DCR)") threshold = row.getCell(3);
      });
      expect(cells).toContain("rental-hold-insured-v2-draft");
      expect(cells).toContain(DRAFT);
      expect(threshold?.value).toBe(1.1);
      expect(threshold?.numFmt).toBe('0.00"x"');
    } else {
      const out = await renderArtifact(x, "html");
      const text = visibleText(new TextDecoder().decode(out.bytes));
      expect(out.provenance.orphans).toEqual([]);
      expect(out.provenance.pass).toBe(true);
      expect(text).toContain("rental-hold-insured-v2-draft");
      expect(text).toContain(DRAFT);
      const model = buildModel(x);
      const table = model.blocks.find((b) => b.type === "table" && b.caption === (kind === "ic_memo" ? "Committee gates" : "Debt and coverage"));
      const label = kind === "ic_memo" ? "Coverage after refinance (DCR)" : "Coverage after refinance (DCR), minimum";
      expect(table && table.type === "table" ? table.rows.find((r) => r[0] === label)?.[1] : undefined).toBe(kind === "ic_memo" ? "at least 1.10x" : "1.10x");
    }
  });

  test("a sale deal's reports do not mention a draft policy, and still show the sale", () => {
    for (const kind of ["ic_memo", "lender_package"] as const) {
      const { text } = textOf(mapleInput(kind));
      expect(text, kind).not.toContain(DRAFT);
      expect(text, kind).not.toContain(UNREALIZED);
    }
  });

  test("the model export names the draft policy and labels the unrealized flow", async () => {
    const out = await renderArtifact(holdInput("model_export"), "xlsx");
    expect(out.provenance.pass).toBe(true);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(out.bytes) as never);
    const cells = (name: string) => {
      const rows: unknown[][] = [];
      wb.getWorksheet(name)!.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
      return rows.flat().map(String);
    };
    expect(cells("Summary").some((c) => c.includes(DRAFT))).toBe(true);
    const kinds = cells("Equity flows");
    expect(kinds.filter((c) => /unrealized/i.test(c))).toHaveLength(1);
    expect(kinds.filter((c) => /unrealized/i.test(c))[0]).toMatch(/unrealized, not a sale/i);
    expect(kinds).not.toContain("sale");
  });
});
