import { describe, expect, test } from "vitest";
import { plainTerm, FIELD_BY_KEY, POLICY_V1, policyFor, type EngineInput } from "@agir/contracts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { runWaterfall, irrRoots, heldPartnerReturns, applyStress, breakeven, assemble, canonicalJson, ENGINE_VERSION, underwrite, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, type SourcedCandidate } from "@agir/extraction";
import { loadOracle } from "@agir/testkit";
import { allEquityDeal, developmentDeal } from "../../engine/test/fixtures.ts";
import { roundToward } from "../src/model.ts";
import { buildModel, htmlToPdf, RendererUnavailableError, renderArtifact, renderHtml, verifyProvenance, visibleText, formatValue, type ArtifactInput } from "../src/index.ts";

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
    expect(labels).toContain("Interest-only DCR (year 1)");
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
  test("a value the client confirmed stays sponsor-stated and says so (task 89a)", async () => {
    const material = (a: ArtifactInput["assumptions"][number]) => FIELD_BY_KEY.get(a.fieldKey)!.material;
    for (const kind of ["lender_package", "ic_memo", "build_decision"] as const) {
      const x = mapleInput(kind);
      const [first, second] = x.assumptions.filter(material);
      first!.sponsorStated = true;
      second!.sponsorStated = true;
      Object.assign(first!, { clientConfirmedBy: "Dana Client", clientConfirmedAt: "2026-10-19T12:00:00Z" });
      const model = buildModel(x);
      const text = visibleText(renderHtml(model));
      // Task 92: every client of the deal can download a report, so it never names the client.
      expect(text).toContain("Stated by the sponsor, confirmed by the client on 2026-10-19, not independently confirmed");
      expect(text).not.toContain("Dana Client");
      expect(JSON.stringify(model)).not.toContain("Dana Client");
      expect(text).toContain("The client confirmed 1 of them; that is not an independent confirmation.");
      expect(text).toContain("Stated by the sponsor, not independently confirmed");
      expect(verifyProvenance(text, model.formatter.manifest).orphans).toEqual([]);
      expect(model.formatter.manifest.map((m) => m.ref)).toEqual(expect.arrayContaining([`ident:clientConfirmedAt.${first!.fieldKey}`, "ident:clientConfirmed.count"]));
      expect((await renderArtifact(x, "docx")).provenance.pass).toBe(true);
      // Without a client confirmation, the block has no such sentence.
      delete first!.clientConfirmedBy;
      delete first!.clientConfirmedAt;
      expect(visibleText(renderHtml(buildModel(x)))).not.toContain("The client confirmed");
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
    // Task 92: a client's confirmation is dated, never named.
    Object.assign(x.assumptions[0]!, { clientConfirmedBy: "Dana Client", clientConfirmedAt: "2026-10-19T12:00:00Z" });
    const named = new ExcelJS.Workbook();
    await named.xlsx.load(Buffer.from((await renderArtifact(x, "xlsx")).bytes) as never);
    const cells: string[] = [];
    named.eachSheet((sheet) => sheet.eachRow((row) => cells.push(JSON.stringify(row.values))));
    expect(cells.join("\n")).toContain("Stated by the sponsor, confirmed by the client on 2026-10-19, not independently confirmed");
    expect(cells.join("\n")).not.toContain("Dana Client");
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
    const order = ["Yield on cost", "Sizing DCR (weakest year)", "Weakest stress", "What would change the answer", "Every input and its source"].map(at);
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
      const key = x.result.verdict.gates.find((g) => plainTerm("en", g.label) === gate)!.key;
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
      expect(after.verdict.gates.find((g) => plainTerm("en", g.label) === gate)!.status, `${gate} at ${r[5]}`).toBe("passed");
    }
  });
  test("every failing gate shares one table, each gate named once", () => {
    const x = dealInput(1);
    const failing = x.result.verdict.gates.filter((g) => g.status === "failed");
    expect(failing.length).toBeGreaterThan(1);
    const model = buildModel(x);
    expect(model.blocks.filter((b) => b.type === "table" && b.columns[0]!.label === "Gate")).toHaveLength(1);
    const rows = table(x);
    for (const g of failing) expect(rows.filter((r) => r[0] === plainTerm("en", g.label))).toHaveLength(1);
    expect(rows.filter((r) => r[0] !== "").length).toBe(failing.length);
  });
  test("card 93c: the French worst case fits two pages", async () => {
    const x = { ...dealInput(0.8, (i) => ({ ...i, revenue: Array.from({ length: 8 }, (_, k) => ({ key: `F${k}`, label: `Logement ${k + 1}`, basis: "per_unit" as const, units: 15, rentMonthly: 1800 + 150 * k })) })), lang: "fr" } as ArtifactInput;
    x.assumptions = mapleInput("build_decision").assumptions.slice(0, 6).map((a) => ({ ...a, sponsorStated: true }));
    const result = await renderArtifact(x, "pdf");
    expect(result.provenance).toMatchObject({ pass: true, orphans: [] });
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBeLessThanOrEqual(2);
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
      expect(x.policy.version).toBe("rental-hold-draft");
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
    x.input = { ...x.input, refinance: { ...x.input.refinance!, insurancePremiumPct: 4, mliSelectPoints: 50 } };
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
      expect(cells).toContain("rental-hold-insured-draft");
      expect(cells).toContain(DRAFT);
      expect(threshold?.value).toBe(1.1);
      expect(threshold?.numFmt).toBe('0.00"x"');
    } else {
      const out = await renderArtifact(x, "html");
      const text = visibleText(new TextDecoder().decode(out.bytes));
      expect(out.provenance.orphans).toEqual([]);
      expect(out.provenance.pass).toBe(true);
      expect(text).toContain("rental-hold-insured-draft");
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
  describe("the reports for a deal that sells its units (task 80)", () => {
    test.each([
    // card 97c: DSCR→DCR rename only; text otherwise identical to `29531862e11b0510111895565f213a8c2d4975d8f2fe79d694e646e4f056f404`
    ["ic_memo", "22e94946039c8786f9a8793faf7c7d1686ed3bae5b8b7977ea14a4c79c7df731"],
    // card 97c: DSCR→DCR rename only; text otherwise identical to `d605a268e8b161c97f6b79a3855f06c93aa3bc3f9a7b0e283b8671c0c8a4b98f`
    ["build_decision", "61757e6912b7e04bbcee1c3fe37927271b3da4409678b6d8446d535771888a08"],
    // card 97c: DSCR→DCR rename only; text otherwise identical to `4cf6ef2277600502cf073624101fc3988664370849ef77e986513ebe66afb08a`
    ["lender_package", "a0cc7a283f1ce22d258878b616a500a5eaafc457f2cc6169abb023d08d0e609b"]] as const)("the existing held %s text is byte-identical", (kind, hash) => {
      expect(createHash("sha256").update(textOf(holdInput(kind)).text).digest("hex")).toBe(hash);
    });
  });

  describe("a Partners sheet in the Excel export (task 85b)", () => {
    test("the held fixture with a split gets Partners after Equity flows (changed in task 88a)", async () => {
      const x = holdInput("model_export");
      x.input = { ...x.input, waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } };
      x.result = underwrite(x.input, x.policy);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from((await renderArtifact(x, "xlsx")).bytes) as never);
      expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Summary", "Metrics", "Annual", "Monthly ledger", "Equity flows", "Partners", "Inputs", "Checks"]);
    });
    test("the held fixture without a split keeps its sheet names (task 88a)", async () => {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from((await renderArtifact(holdInput("model_export"), "xlsx")).bytes) as never);
      expect(wb.worksheets.map((ws) => ws.name)).toEqual(["Summary", "Metrics", "Annual", "Monthly ledger", "Equity flows", "Inputs", "Checks"]);
    });
  });

  describe("a report says when a check decides the verdict (task 85a)", () => {
    test("the held fixture without an error check adds no paragraph", () => {
      const x = holdInput("build_decision");
      expect(x.result.verdict.hardFailReasons).toEqual([]);
      const { text, report } = textOf(x);
      expect(text).not.toContain("This run fails a check that no gate can offset.");
      expect(report.orphans).toEqual([]);
    });
  });

});

type OracleInputs = { unit_types: { name: string; units: number; price: number }[]; land: number; hard: number; soft: number; contingency: number; construction_months: number; presold_units_pct: number; deposit_pct: number; absorption_units_per_month: number; sales_commission_pct: number; closing_lag_months: number; unsold_carry_monthly: number; senior_commitment: number; senior_rate_pct: number; mezz_commitment: number; mezz_rate_pct: number; senior_presale_threshold_pct: number };
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

const SALE_KINDS = ["ic_memo", "build_decision", "lender_package"] as const;
const SALE_SLUGS = ["kestrel-row-townhomes", "alder-court-condo"] as const;
const SALE_OPERATIONS = "A deal that sells its units has no years of operations. Each month's costs, loans and closings are in the Excel export.";
const SALE_CHANGE = "What would change the answer is not yet available for a deal that sells its units.";
function saleInput(slug: typeof SALE_SLUGS[number], kind: ArtifactInput["kind"]): ArtifactInput {
  const d = (JSON.parse(readFileSync(new URL(`../../../oracles/for-sale/${slug}.outcome.json`, import.meta.url), "utf8")) as { inputs: OracleInputs }).inputs;
  const input = fromOracle(d);
  const policy = policyFor(input);
  const result = underwrite(input, policy);
  const scalars: Record<string, number> = { sell_units: 1, land_cost: d.land, hard_cost: d.hard, soft_cost: d.soft, contingency: d.contingency,
    other_cost: 0, construction_months: d.construction_months, s_curve_draws: 0, senior_loan_amount: d.senior_commitment, senior_rate_pct: d.senior_rate_pct,
    presold_units_pct: d.presold_units_pct, deposit_pct: d.deposit_pct, absorption_units_per_month: d.absorption_units_per_month,
    sales_commission_pct: d.sales_commission_pct, closing_lag_months: d.closing_lag_months, unsold_carry_monthly: d.unsold_carry_monthly,
    senior_presale_threshold_pct: d.senior_presale_threshold_pct,
    ...(d.mezz_commitment > 0 ? { mezz_loan_amount: d.mezz_commitment, mezz_rate_pct: d.mezz_rate_pct } : {}),
  };
  const assumption = (fieldKey: string, value: number, itemKey: string | null = null): ArtifactInput["assumptions"][number] => ({
    fieldKey, itemKey, value, label: FIELD_BY_KEY.get(fieldKey)!.label, unit: FIELD_BY_KEY.get(fieldKey)!.unit,
    sourceKind: "analyst", source: "Stated in the oracle inputs",
  });
  return { kind, deal: { name: slug === "kestrel-row-townhomes" ? "Kestrel Row" : "Alder Court", assetType: "Units for sale", location: "Fictional town", currency: "CAD", province: slug === "kestrel-row-townhomes" ? "ON" : "BC" },
    run: { id: "sale", runNumber: 1, createdAt: "2026-10-18T12:00:00.000Z", engineVersion: result.engineVersion, policyVersion: policy.version,
      policyHash: createHash("sha256").update(canonicalJson(policy)).digest("hex"), inputHash: "a".repeat(64), resultHash: "b".repeat(64) },
    input, result, policy, decision: null,
    assumptions: [...Object.entries(scalars).map(([k, v]) => assumption(k, v)), ...input.forSale!.units.flatMap((u) => [assumption("unit_count", u.units, u.key), assumption("unit_sale_price", u.price, u.key)])],
  };
}
const saleTable = (model: ReturnType<typeof buildModel>, caption: string) => {
  const t = model.blocks.find((b) => b.type === "table" && b.caption === caption);
  if (!t || t.type !== "table") throw new Error(`Missing table: ${caption}`);
  return t;
};

describe("the reports for a deal that sells its units (task 80)", () => {
  test.each([
    // card 97c: DSCR→DCR rename only; text otherwise identical to `fa9dd2f818ca58ba1500ec30db01d5171229546e8828b96d74e9f0138bf93812`
    ["ic_memo", "200c7159ce649a03fff64ef222399b755da85112d8fce957b0f6df3ea69ff7c4"],
    // card 97c: DSCR→DCR rename only; text otherwise identical to `64389bea70bedfb6f257617d58cc54d1bfff3bf08f55eb90e2f967f1d91736d0`
    ["build_decision", "161df3ae41c30a1322c47bf6b2cb6d4b4b7c18b34de0dbc177b2e819aca70fd9"],
    // card 97c: DSCR→DCR rename only; text otherwise identical to `5f81e68b930e8735a4036eba356bad6242bc1e05cdaa3ca89a84a69f47dd208c`
    ["lender_package", "be3357a81416eb58bb60c7147850071e584947e517fa7b5e77e3f44bd5cf9641"]] as const)("the existing Maple Heights %s text is byte-identical", (kind, hash) => {
    expect(createHash("sha256").update(visibleText(renderHtml(buildModel(mapleInput(kind))))).digest("hex")).toBe(hash);
  });
  test.each(SALE_SLUGS.flatMap((slug) => SALE_KINDS.map((kind) => [slug, kind] as const)))("%s %s has provenance, sale stats and stresses without rental sections", (slug, kind) => {
    const x = saleInput(slug, kind);
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    expect(verifyProvenance(text, model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
    expect(text).not.toMatch(/DSCR|Debt yield|Break-even occupancy|Capitalized interest|\brent\b/i);
    const captions = model.blocks.flatMap((b) => b.type === "table" ? [b.caption] : []);
    for (const caption of ["Revenue program", "Operations", "Stabilized operations, year 1", "Annual cash flows"]) expect(captions).not.toContain(caption);
    if (!(kind === "build_decision" && x.result.verdict.code !== "APPROVE")) expect(saleTable(model, "Stresses (each a full re-run of the model)").columns.map((c) => c.label)).toEqual(["Scenario", "Profit on cost (units sold)", "Margin on sales revenue", "Equity multiple"]);
    const stats = model.blocks.find((b) => b.type === "stats");
    expect(stats?.type === "stats" ? stats.items.map((i) => i.label) : []).toEqual(kind === "ic_memo"
      ? ["Total cost", "Profit on cost (units sold)", "Margin on sales revenue", "Equity multiple", "Equity IRR"]
      : kind === "build_decision" ? ["Profit on cost (units sold)", "Margin on sales revenue", "Equity multiple"] : []);
    if (kind !== "build_decision") {
      const keys = ["gross_sales_revenue", "net_sales_revenue", "carry_total", "interest_after_completion", "development_profit_for_sale", "profit_on_cost_for_sale", "margin_on_revenue", "sellout_month", "sellout_years", "deposits_held_at_completion", "senior_balance_at_completion", ...(x.input.mezzanine ? ["mezz_balance_at_completion"] : [])];
      expect(saleTable(model, "Sale results").rows).toEqual(keys.map((key) => {
        const m = x.result.scenarios[0]!.metrics.find((m) => m.key === key)!;
        return [m.label, formatValue(m.value!, m.unit)];
      }));
      const units = saleTable(model, "Unit sales");
      expect(units.rows.slice(0, x.input.forSale!.units.length)).toEqual(x.input.forSale!.units.map((u) => [u.label, `${formatValue(u.units, "units")} units`, formatValue(u.price, "$")]));
      for (const u of x.input.forSale!.units) expect(model.formatter.manifest).toEqual(expect.arrayContaining([
        { text: u.label, ref: `ident:forSale.${u.key}.label` }, { text: formatValue(u.units, "units"), ref: `input:unit_count|${u.key}` }, { text: formatValue(u.price, "$"), ref: `input:unit_sale_price|${u.key}` },
      ]));
      expect(units.rows.some((r) => r[0] === FIELD_BY_KEY.get("senior_presale_threshold_pct")!.label)).toBe(true);
      expect(model.blocks).toContainEqual({ type: "paragraph", muted: true, text: SALE_OPERATIONS });
    }
  });
  test("audit: Kestrel sells out in 1.5 years, not a rounded 2, and the sales pace is not followed by a second unit", () => {
    const model = buildModel(saleInput("kestrel-row-townhomes", "ic_memo"));
    expect(saleTable(model, "Sale results").rows).toContainEqual(["Time to sell out", "1.5 years"]);
    expect(saleTable(model, "Unit sales").rows).toContainEqual([FIELD_BY_KEY.get("absorption_units_per_month")!.label, "1", ""]);
    expect(formatValue(25, "years")).toBe("25 years");
  });
  test("Kestrel sources equal uses without a balancing row", () => {
    const x = saleInput("kestrel-row-townhomes", "ic_memo");
    const m = (key: string) => x.result.scenarios[0]!.metrics.find((m) => m.key === key)!.value!;
    expect(Math.abs(m("required_equity") + x.input.senior.amount + (x.input.mezzanine?.amount ?? 0) - m("total_development_cost"))).toBeLessThanOrEqual(1);
    expect(saleTable(buildModel(x), "Sources and uses").rows).toEqual([
      ["Land", "$900,000"], ["Hard costs", "$3,200,000"], ["Soft costs", "$520,000"], ["Contingency", "$160,000"],
      ["Interest during construction", formatValue(m("interest_before_completion"), "$")], ["Total uses", formatValue(m("total_development_cost"), "$")],
      ["Senior loan", "$3,300,000"], ["Equity", formatValue(m("required_equity"), "$")], ["Total sources", formatValue(m("total_development_cost"), "$")],
    ]);
  });
  test("the lender's presale rows appear exactly when the condition is stated, with no amortization or IO rows", () => {
    for (const stated of [true, false]) {
      const x = saleInput("alder-court-condo", "lender_package");
      if (!stated) { delete x.input.forSale!.presaleThresholdPct; x.assumptions = x.assumptions.filter((a) => a.fieldKey !== "senior_presale_threshold_pct"); }
      const model = buildModel(x);
      for (const caption of ["Unit sales", "Debt"]) expect(saleTable(model, caption).rows.some((r) => r[0] === FIELD_BY_KEY.get("senior_presale_threshold_pct")!.label)).toBe(stated);
      const terms = saleTable(model, "Debt").rows;
      expect(terms.flat().join(" ")).not.toMatch(/amortization|interest-only|DSCR/i);
      for (const key of ["loan_to_cost", "interest_after_completion", "senior_balance_at_completion", "mezz_balance_at_completion"]) {
        const m = x.result.scenarios[0]!.metrics.find((m) => m.key === key)!;
        expect(terms).toContainEqual([m.label, formatValue(m.value!, m.unit)]);
      }
      if (stated) {
        const index = terms.findIndex((r) => r[0] === FIELD_BY_KEY.get("senior_presale_threshold_pct")!.label);
        expect(terms[index + 1]).toEqual([FIELD_BY_KEY.get("presold_units_pct")!.label, formatValue(x.input.forSale!.presoldPct, "%")]);
      }
    }
  });
  test("Alder's rejected build decision ranks stresses by failed gates then profit on cost and shows break-even rows", () => {
    const x = saleInput("alder-court-condo", "build_decision");
    expect(x.result.verdict.code).toBe("REJECT");
    for (const tie of [false, true]) {
      const result = tie ? { ...x.result, verdict: { ...x.result.verdict, gates: x.result.verdict.gates.map((g) => ({ ...g, status: "passed" as const })) } } : x.result;
      const count = (key: string) => result.verdict.gates.filter((g) => g.scenario === key && g.status === "failed").length;
      const poc = (key: string) => result.scenarios.find((s) => s.key === key)!.metrics.find((m) => m.key === "profit_on_cost_for_sale")!.value!;
      const weakest = result.scenarios.filter((s) => s.key !== "base").sort((a, b) => count(b.key) - count(a.key) || poc(a.key) - poc(b.key))[0]!;
      const model = buildModel({ ...x, result });
      const paragraph = model.blocks.find((b) => b.type === "paragraph" && b.text.startsWith("Weakest stress:"));
      expect(paragraph?.type === "paragraph" && paragraph.text.startsWith(`Weakest stress: ${weakest.label}.`)).toBe(true);
      expect(paragraph?.type === "paragraph" ? paragraph.text : "").toContain(`Its profit on cost: ${formatValue(poc(weakest.key), "%")}.`);
      expect(model.blocks).not.toContainEqual({ type: "paragraph", muted: true, text: SALE_CHANGE });
      expect(model.blocks.some((b) => b.type === "table" && b.columns.some((c) => c.label === "Input moved"))).toBe(!tie);
      expect(model.blocks.some((b) => b.type === "table" && b.caption === "Stresses (each a full re-run of the model)")).toBe(false);
    }
  });
  test("the sale workbook has the specified sheets, ledger columns, numeric money and metric omission note", async () => {
    const x = saleInput("kestrel-row-townhomes", "model_export");
    const out = await renderArtifact(x, "xlsx");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(out.bytes) as never);
    expect(wb.getWorksheet("Annual")).toBeUndefined();
    for (const name of ["Summary", "Metrics", "Equity flows", "Inputs", "Checks"]) expect(wb.getWorksheet(name)).toBeDefined();
    const ledger = wb.getWorksheet("Monthly ledger")!;
    expect((ledger.getRow(1).values as string[]).slice(1)).toEqual(["Month", "Phase", "Cost draw", "Equity draw", "Debt draw", "Capitalized interest", "Loan repayment", "Debt balance", "Sale to equity"]);
    expect(ledger.rowCount).toBe(x.result.ledger.length + 1);
    let distributed = 0;
    ledger.eachRow((row, n) => {
      if (n === 1) return;
      for (let col = 3; col <= 9; col++) { expect(typeof row.getCell(col).value).toBe("number"); expect(row.getCell(col).numFmt).toContain('$'); }
      distributed += Number(row.getCell(9).value);
      expect([row.getCell(6).value, row.getCell(7).value, row.getCell(9).value]).toEqual([x.result.ledger[n - 2]!.capitalizedInterest, x.result.ledger[n - 2]!.debtService, x.result.ledger[n - 2]!.saleNet]);
    });
    expect(Math.abs(distributed - x.result.scenarios[0]!.metrics.find((m) => m.key === "equity_distributed")!.value!)).toBeLessThanOrEqual(1);
    // Audit: the months after completion are selling, never "hold".
    const phases = new Set<unknown>(); ledger.eachRow((row, n) => { if (n > 1) phases.add(row.getCell(2).value); });
    expect([...phases]).toEqual(["construction", "selling"]);
    const metrics = wb.getWorksheet("Metrics")!;
    expect(String(metrics.getRow(2).getCell(1).value)).toContain("The units are sold; there is no rental income.");
    const metricLabels: unknown[] = [];
    metrics.eachRow((row, n) => { if (n > 2) metricLabels.push(row.getCell(1).value); });
    const kept = x.result.scenarios[0]!.metrics.filter((m) => !(m.status === "NOT_APPLICABLE" && m.reason === "The units are sold; there is no rental income."));
    expect(metricLabels).toEqual(kept.map((m) => m.label));
  });
  test.each(SALE_SLUGS.flatMap((slug) => SALE_KINDS.map((kind) => [slug, kind] as const)))("%s %s renders Word, PDF and Excel", async (slug, kind) => {
    const x = saleInput(slug, kind);
    for (const format of ["docx", "xlsx", "pdf"] as const) {
      let out;
      try { out = await renderArtifact(x, format); }
      catch (e) { if (format === "pdf" && e instanceof RendererUnavailableError) continue; throw e; }
      expect(out.provenance).toMatchObject({ pass: true, orphans: [] });
      expect(out.bytes.byteLength).toBeGreaterThan(1_000);
      if (format === "pdf") expect(new TextDecoder().decode(out.bytes.slice(0, 5))).toBe("%PDF-");
    }
  }, 60_000);
});

describe("what would change the answer for a deal that sells its units (task 83)", () => {
  const tableOf = (model: ReturnType<typeof buildModel>) => {
    const table = model.blocks.find((b) => b.type === "table" && b.columns.some((c) => c.label === "Input moved"));
    if (!table || table.type !== "table") throw new Error("Missing change-the-answer table");
    return table;
  };
  const gateRows = (model: ReturnType<typeof buildModel>, label: string) => {
    const rows = tableOf(model).rows;
    const first = rows.findIndex((r) => r[0] === label);
    expect(first).toBeGreaterThanOrEqual(0);
    const next = rows.findIndex((r, i) => i > first && r[0] !== "");
    return rows.slice(first, next < 0 ? undefined : next);
  };
  test.each(SALE_SLUGS)("%s prints one six-column block per failing gate with provenance", (slug) => {
    const x = saleInput(slug, "build_decision");
    expect(x.result.verdict.code).toBe(slug === "alder-court-condo" ? "REJECT" : "APPROVE_WITH_CONDITIONS");
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    expect(text).toContain("What would change the answer");
    expect(text).not.toContain(SALE_CHANGE);
    const table = tableOf(model);
    expect(table.columns.map((c) => c.label)).toEqual(["Gate", "Needs", "This run", "Input moved", "In this run", "Passes at"]);
    const failing = x.result.verdict.gates.filter((g) => g.status === "failed");
    expect(table.rows.filter((r) => r[0] !== "").map((r) => r[0])).toEqual(failing.map((g) => g.label));
    const result = breakeven(x.input, x.policy);
    for (const g of failing) {
      const rows = gateRows(model, g.label);
      const expectedCount = result.rows.filter((r) => r.gate === g.key).reduce((n, r) =>
        n + (r.state !== "value" || r.driver === "pricePct" ? 1 : r.to.length + (r.driver === "rateBps" && r.to.length > 1 ? 1 : 0)), 0);
      expect(rows).toHaveLength(expectedCount);
      expect(rows[0]!.slice(1, 3)).toEqual([formatValue(g.threshold, g.unit), formatValue(g.actual!, g.unit)]);
      expect(rows.every((r) => r.length === 6)).toBe(true);
      expect(rows.slice(1).every((r) => r.slice(0, 3).every((c) => c === ""))).toBe(true);
    }
    expect(model.blocks.some((b) => b.type === "table" && b.caption === "Stresses (each a full re-run of the model)")).toBe(false);
    expect(verifyProvenance(text, model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
  });
  test("an approved sale keeps the stress table and has no change-the-answer section", () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    x.result = { ...x.result, verdict: { ...x.result.verdict, code: "APPROVE" } };
    const model = buildModel(x);
    expect(saleTable(model, "Stresses (each a full re-run of the model)").rows).toHaveLength(x.result.scenarios.length);
    expect(visibleText(renderHtml(model))).not.toContain("What would change the answer");
    expect(model.blocks.some((b) => b.type === "table" && b.columns.some((c) => c.label === "Input moved"))).toBe(false);
  });
  test("Alder prices move together in one row with the engine shock and recorded count", () => {
    const x = saleInput("alder-court-condo", "build_decision");
    const model = buildModel(x);
    const prices = breakeven(x.input, x.policy).rows.filter((r) => r.driver === "pricePct" && r.state === "value");
    expect(prices.length).toBeGreaterThan(0);
    for (const price of prices) {
      const g = x.result.verdict.gates.find((g) => g.key === price.gate)!;
      const rows = gateRows(model, g.label).filter((r) => r[3]!.startsWith("Sale price"));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.slice(3)).toEqual(["Sale prices, all 3 unit types (same share)", "—", "+" + formatValue(price.shock!, "%")]);
      expect(model.formatter.manifest).toEqual(expect.arrayContaining([
        { text: "3", ref: `ident:breakeven.${g.key}.price.count` },
        { text: formatValue(price.shock!, "%"), ref: `run:breakeven.${g.key}.price.shock` },
      ]));
    }
  });
  test("one unit type prints the rounded-up passing price and passes when fed back", () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    // Keep the eight-unit program; all units now use the first type's price and label.
    const units = x.input.forSale!.units;
    x.input = { ...x.input, forSale: { ...x.input.forSale!, units: [{ ...units[0]!, units: units.reduce((n, u) => n + u.units, 0) }] } };
    x.result = underwrite(x.input, x.policy);
    const price = breakeven(x.input, x.policy).rows.find((r) => r.gate === "profit_on_cost_for_sale" && r.driver === "pricePct")!;
    expect(price.state).toBe("value");
    const model = buildModel(x);
    const gate = x.result.verdict.gates.find((g) => g.key === price.gate)!;
    const echo = price.to[0]!;
    const passing = roundToward(echo.to, 1, 1);
    const printed = gateRows(model, gate.label).find((r) => r[3] === `Sale price, ${echo.item}`)!;
    expect(printed.slice(3)).toEqual([`Sale price, ${echo.item}`, formatValue(echo.from, "$"), formatValue(passing, "$")]);
    const at = underwrite(applyStress(x.input, { key: "price", label: "Price", pricePct: price.shock! }), x.policy).verdict.gates.find((g) => g.key === gate.key)!;
    expect(at.status).toBe("passed");
    expect(at.actual).toBe(price.actual);
    const rounded = { ...x.input, forSale: { ...x.input.forSale!, units: x.input.forSale!.units.map((u) => ({ ...u, price: passing })) } };
    expect(underwrite(rounded, x.policy).verdict.gates.find((g) => g.key === gate.key)!.status).toBe("passed");
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
  test("sales pace and presales print their passing echoes rounded up to hundredths", () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    x.input = { ...x.input, forSale: { ...x.input.forSale!, absorptionPerMonth: 0.05 } };
    x.result = underwrite(x.input, x.policy);
    const result = breakeven(x.input, x.policy);
    const model = buildModel(x);
    for (const [driver, label, unit] of [["absorptionPct", "Sales pace", "units/mo"], ["presalesPts", "Presold units", "%"]] as const) {
      const row = result.rows.find((r) => r.driver === driver && r.state === "value")!;
      expect(row, driver).toBeDefined();
      const echo = row.to[0]!;
      const g = x.result.verdict.gates.find((g) => g.key === row.gate)!;
      const printed = gateRows(model, g.label).find((r) => r[3] === label)!;
      expect(printed.slice(3)).toEqual([label, formatValue(echo.from, unit), formatValue(roundToward(echo.to, 1, 0.01), unit)]);
      if (driver === "absorptionPct") expect(printed.slice(4)).toEqual(["0.05 units per month", "0.06 units per month"]);
    }
    expect(formatValue(1, "units/mo")).toBe("1 unit per month");
    expect(formatValue(2.43, "units/mo")).toBe("2.43 units per month");
    expect(formatValue(2.4, "units/mo")).toBe("2.4 units per month");
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
  test("unavailable moves name each sale driver and its state", () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    x.input = { ...x.input, forSale: { ...x.input.forSale!, units: [x.input.forSale!.units[0]!] } };
    x.result = underwrite(x.input, x.policy);
    const model = buildModel(x);
    const states = { out_of_range: "Out of range", no_effect: "No effect", not_monotonic: "Not monotonic" } as const;
    const names = { pricePct: "Sale prices", absorptionPct: "Sales pace", presalesPts: "Presales" } as const;
    for (const driver of ["pricePct", "absorptionPct", "presalesPts"] as const) {
      const rows = breakeven(x.input, x.policy).rows.filter((r) => r.driver === driver && r.state !== "value");
      expect(rows.length, driver).toBeGreaterThan(0);
      for (const row of rows) {
        const gate = x.result.verdict.gates.find((g) => g.key === row.gate)!;
        expect(gateRows(model, gate.label).map((r) => r.slice(3))).toContainEqual([names[driver], "—", states[row.state as keyof typeof states]]);
      }
    }
  });
  test.each(SALE_SLUGS)("%s explains an earlier engine or a different policy as rental reports do", (slug) => {
    const x = saleInput(slug, "build_decision");
    for (const [run, message] of [
      [{ ...x.run, engineVersion: "0.9.0" }, "Not shown: this run was made by an earlier engine."],
      [{ ...x.run, policyHash: "different" }, "Not shown: this run was made under a different policy."],
    ] as const) {
      const model = buildModel({ ...x, run });
      const text = visibleText(renderHtml(model));
      expect(text).toContain("What would change the answer");
      expect(text).toContain(message);
      expect(model.blocks.some((b) => b.type === "table" && b.columns.some((c) => c.label === "Input moved"))).toBe(false);
      expect(verifyProvenance(text, model.formatter.manifest).orphans).toEqual([]);
    }
  });
});

const partnerMemoInput = (sale: boolean): ArtifactInput => {
  const base = sale ? saleInput("kestrel-row-townhomes", "ic_memo") : mapleInput("ic_memo");
  const input = { ...(sale ? base.input : developmentDeal()), waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } };
  const policy = policyFor(input);
  return { ...base, kind: "partner_memo", deal: { ...base.deal, name: sale ? "Kestrel Row" : "Development rental" },
    input, policy, result: underwrite(input, policy), assumptions: [], notFound: [], run: { ...base.run,
      policyVersion: policy.version, policyHash: createHash("sha256").update(canonicalJson(policy)).digest("hex") } };
};

describe("the partner memo (task 84d)", () => {
  test.each([false, true])("sale=%s prints partner terms, cash and stress metrics with provenance", (sale) => {
    const x = partnerMemoInput(sale);
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    const sums = (flows: { amount: number }[]) => ({
      contributed: -flows.filter((f) => f.amount < 0).reduce((n, f) => n + f.amount, 0),
      distributed: flows.filter((f) => f.amount > 0).reduce((n, f) => n + f.amount, 0),
    });
    const lp = sums(w.lp), gp = sums(w.gp);
    const metric = (key: string) => x.result.scenarios[0]!.metrics.find((m) => m.key === key)!;
    expect(model.kicker).toBe("Partner memo");
    const stats = model.blocks.find((b) => b.type === "stats")!;
    expect(stats.type === "stats" ? stats.items : []).toEqual(["equity_multiple", "equity_irr", "lp_irr", "gp_irr"].map((key) => ({
      label: metric(key).label, value: formatValue(metric(key).value!, metric(key).unit),
    })));
    expect(saleTable(model, "Partnership terms").rows).toEqual([
      ["lp_share_pct", 90], ["preferred_return_pct", 8], ["gp_promote_pct", 20],
    ].map(([key, value]) => [FIELD_BY_KEY.get(String(key))!.label, formatValue(Number(value), "%")]));
    const table = saleTable(model, "Capital and distributions");
    expect(table.columns.map((c) => c.label)).toEqual(["Partner", "Contributed", "Distributed", "Multiple", "IRR"]);
    expect(table.rows.slice(0, 3).map((r) => r[0])).toEqual(["LP", "GP", "Total"]);
    for (const [label, totals, irr] of [["LP", lp, "lp_irr"], ["GP", gp, "gp_irr"]] as const) {
      expect(table.rows.find((r) => r[0] === label)).toEqual([label, formatValue(totals.contributed, "$"),
        formatValue(totals.distributed, "$"), formatValue(totals.distributed / totals.contributed, "x"), formatValue(metric(irr).value!, "%")]);
    }
    const total = table.rows.find((r) => r[0] === "Total")!;
    const number = (s: string) => Number(s.replace(/[^0-9.-]/g, ""));
    expect(Math.abs(number(total[1]!) - lp.contributed - gp.contributed)).toBeLessThanOrEqual(1);
    expect(Math.abs(number(total[2]!) - lp.distributed - gp.distributed)).toBeLessThanOrEqual(1);
    expect(total.slice(3)).toEqual([formatValue(metric("equity_multiple").value!, "x"), formatValue(metric("equity_irr").value!, "%")]);
    expect(table.rows[3]).toEqual(["GP promote", "", formatValue(metric("gp_promote").value!, "$"), "", ""]);
    expect(saleTable(model, "Stresses (each a full re-run of the model)").columns.map((c) => c.label))
      .toEqual(["Scenario", ...["equity_multiple", "lp_irr", "gp_irr"].map((key) => metric(key).label)]);
    const captions = model.blocks.flatMap((b) => b.type === "table" && b.caption ? [b.caption] : []);
    expect(captions).toEqual(["Partnership terms", "Capital and distributions", "Sources and uses", "Stresses (each a full re-run of the model)"]);
    expect(text).toContain("Distributions go pro rata until the LP has received its capital and its preferred return, compounded annually on what is unreturned. After that the GP takes its promote share of each dollar and the rest is split pro rata.");
    expect(text).toContain("Every input and its source is listed in the IC memo and the lender package.");
    expect(verifyProvenance(text, model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
    if (sale) {
      expect(model.blocks).toContainEqual({ type: "paragraph", muted: true, text: SALE_OPERATIONS });
      expect(text).not.toMatch(/DSCR|debt yield|\brent\b/i);
      const decision = buildModel({ ...x, kind: "build_decision" });
      expect(decision.blocks).not.toContainEqual({ type: "paragraph", muted: true, text: SALE_OPERATIONS });
    }
  });
  test.each([false, true])("sale=%s renders Word and PDF", async (sale) => {
    for (const format of ["docx", "pdf"] as const) {
      let out;
      try { out = await renderArtifact(partnerMemoInput(sale), format); }
      catch (e) { if (format === "pdf" && e instanceof RendererUnavailableError) continue; throw e; }
      expect(out.provenance).toMatchObject({ pass: true, orphans: [] });
      expect(out.bytes.byteLength).toBeGreaterThan(1_000);
    }
  }, 60_000);
  test.each(["no split", "held without a split"])("%s is refused by the builder with a named error", (mode) => {
    const x = partnerMemoInput(false);
    if (mode === "no split") x.input = developmentDeal();
    else {
      const { waterfall: _, ...rest } = x.input;
      x.input = { ...rest, exit: "refinance_hold", refinance: { month: 36, amount: 29_000_000, ratePct: 5, amortYears: 30, ioMonths: 0 } };
    }
    x.result = underwrite(x.input, policyFor(x.input));
    let error: unknown;
    try { buildModel(x); } catch (e) { error = e; }
    expect(error).toMatchObject({ name: "PartnerMemoUnavailableError", message: "This deal has no LP/GP split, so it has no partner memo." });
  });
});

describe("the partner memo of a held deal (task 87a)", () => {
  const heldPartnerInput = (preferredReturnPct: number, extra: Partial<EngineInput> = {}): ArtifactInput => {
    const base = partnerMemoInput(false);
    const input: EngineInput = { ...developmentDeal(), refinance: { month: 36, ltvPct: 65, ratePct: 5, amortYears: 30, ioMonths: 0 }, exit: "refinance_hold",
      waterfall: { lpSharePct: 90, preferredReturnPct, gpPromotePct: 20 }, ...extra };
    const policy = policyFor(input);
    return { ...base, deal: { ...base.deal, name: "Kept Rental" }, input, policy, result: underwrite(input, policy),
      run: { ...base.run, policyVersion: policy.version, policyHash: createHash("sha256").update(canonicalJson(policy)).digest("hex") } };
  };
  const metric = (x: ArtifactInput, key: string) => x.result.scenarios[0]!.metrics.find((m) => m.key === key)!;
  const irrText = (flows: { t: number; amount: number }[]) => {
    const roots = irrRoots(flows);
    return roots.length === 1 ? formatValue(roots[0]! * 100, "%") : "Not meaningful";
  };
  const sum = (flows: { amount: number }[], sign: 1 | -1) => sign * flows.filter((f) => sign * f.amount > 0).reduce((n, f) => n + f.amount, 0);
  const number = (s: string) => Number(s.replace(/[^0-9.-]/g, ""));
  const CAPITAL = "Capital and distributions, with the stated value (unrealized, not a sale)";
  const PAID = "Cash paid out before the stated value";
  const NOTHING_SOLD = "Nothing is sold. The stated value is final-year NOI over the exit cap rate, less the debt outstanding; returns that include it are unrealized. Cash paid out is the operating and refinance cash only.";

  test("with a promote (90/3/20): stats, both partner tables, order and provenance", () => {
    const x = heldPartnerInput(3);
    const model = buildModel(x);
    const text = visibleText(renderHtml(model));
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    const paid = runWaterfall(x.result.equityFlows.filter((f) => f.kind !== "unrealized"), x.input.waterfall!);
    expect(w.promote).toBeGreaterThan(0);
    expect(paid.promote).toBe(0);
    const lpIrr = irrRoots(w.lp), gpIrr = irrRoots(w.gp);
    expect(lpIrr).toHaveLength(1);
    expect(gpIrr).toHaveLength(1);
    expect(lpIrr[0]! * 100).toBeLessThan(metric(x, "unrealized_equity_irr").value!);
    expect(gpIrr[0]! * 100).toBeGreaterThan(metric(x, "unrealized_equity_irr").value!);
    const stats = model.blocks.find((b) => b.type === "stats")!;
    expect(stats.type === "stats" ? stats.items : []).toEqual([
      ...["unrealized_equity_multiple", "unrealized_equity_irr"].map((key) => ({ label: metric(x, key).label, value: formatValue(metric(x, key).value!, metric(x, key).unit) })),
      { label: "LP IRR (unrealized, not a sale)", value: irrText(w.lp) },
      { label: "GP IRR (unrealized, not a sale)", value: irrText(w.gp) },
    ]);
    const captions = model.blocks.flatMap((b) => b.type === "table" && b.caption ? [b.caption] : []);
    expect(captions).toEqual(["Partnership terms", CAPITAL, PAID, "Sources and uses", "Stresses (each a full re-run of the model)"]);
    const capital = saleTable(model, CAPITAL);
    expect(capital.columns.map((c) => c.label)).toEqual(["Partner", "Contributed", "Distributed", "Multiple", "IRR"]);
    expect(capital.rows.map((r) => r[0])).toEqual(["LP", "GP", "Total", "GP promote (unrealized, not a sale)"]);
    for (const [label, flows] of [["LP", w.lp], ["GP", w.gp]] as const) {
      const c = sum(flows, -1), d = sum(flows, 1);
      expect(capital.rows.find((r) => r[0] === label)).toEqual([label, formatValue(c, "$"), formatValue(d, "$"), formatValue(d / c, "x"), irrText(flows)]);
    }
    const total = capital.rows.find((r) => r[0] === "Total")!;
    expect(Math.abs(number(total[2]!) - sum(x.result.equityFlows, 1))).toBeLessThanOrEqual(1);
    expect(Math.abs(sum(w.lp, 1) + sum(w.gp, 1) - sum(x.result.equityFlows, 1))).toBeLessThanOrEqual(0.01);
    expect(total.slice(3)).toEqual(["unrealized_equity_multiple", "unrealized_equity_irr"].map((key) => formatValue(metric(x, key).value!, metric(x, key).unit)));
    expect(capital.rows[3]).toEqual(["GP promote (unrealized, not a sale)", "", formatValue(w.promote, "$"), "", ""]);
    const paidTable = saleTable(model, PAID);
    expect(paidTable.columns.map((c) => c.label)).toEqual(["Partner", "Contributed", "Paid out", "Paid out / contributed"]);
    expect(paidTable.rows.map((r) => r[0])).toEqual(["LP", "GP", "Total", "GP promote paid"]);
    for (const [label, flows] of [["LP", paid.lp], ["GP", paid.gp]] as const) {
      const c = sum(flows, -1), d = sum(flows, 1);
      expect(paidTable.rows.find((r) => r[0] === label)).toEqual([label, formatValue(c, "$"), formatValue(d, "$"), formatValue(d / c, "x")]);
    }
    const cashPaid = x.result.equityFlows.filter((f) => f.kind === "operating" || f.kind === "refinance").reduce((n, f) => n + f.amount, 0);
    expect(Math.abs(sum(paid.lp, 1) + sum(paid.gp, 1) - cashPaid)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(number(paidTable.rows[2]![2]!) - cashPaid)).toBeLessThanOrEqual(1);
    expect(paidTable.rows[3]).toEqual(["GP promote paid", "", formatValue(0, "$"), ""]);
    expect(saleTable(model, "Stresses (each a full re-run of the model)").columns.map((c) => c.label))
      .toEqual(["Scenario", ...["dcr_after_refinance", "unrealized_equity_multiple", "unrealized_equity_irr"].map((key) => metric(x, key).label)]);
    expect(text).toContain("Distributions go pro rata until the LP has received its capital and its preferred return");
    expect(text).toContain(NOTHING_SOLD);
    expect(text.indexOf(NOTHING_SOLD)).toBeGreaterThan(text.indexOf("Distributions go pro rata"));
    expect(text).toContain("Every input and its source is listed in the IC memo and the lender package.");
    expect(text).toContain("unrealized, not a sale");
    expect(stats.type === "stats" && stats.items.some((i) => i.value === "Not applicable")).toBe(false);
    expect(verifyProvenance(text, model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
  });

  test("below the preferred return (90/8/20): no promote, and each partner's IRR is the deal's", () => {
    const x = heldPartnerInput(8);
    const model = buildModel(x);
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    expect(w.promote).toBe(0);
    const deal = formatValue(metric(x, "unrealized_equity_irr").value!, "%");
    const stats = model.blocks.find((b) => b.type === "stats")!;
    const items = stats.type === "stats" ? stats.items : [];
    expect(items.slice(2).map((i) => i.value)).toEqual([deal, deal]);
    expect(saleTable(model, CAPITAL).rows[3]).toEqual(["GP promote (unrealized, not a sale)", "", formatValue(0, "$"), "", ""]);
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
  });

  test.each([3, 8])("90/%s/20 renders Word and PDF with zero orphans", async (pref) => {
    for (const format of ["docx", "pdf"] as const) {
      let out;
      try { out = await renderArtifact(heldPartnerInput(pref), format); }
      catch (e) { if (format === "pdf" && e instanceof RendererUnavailableError) continue; throw e; }
      expect(out.provenance).toMatchObject({ pass: true, orphans: [] });
      expect(out.bytes.byteLength).toBeGreaterThan(1_000);
    }
  }, 60_000);

  test.each([3, 8])("90/%s/20: the held Partners sheet reads the helper (task 88a)", async (pref) => {
    const x = { ...heldPartnerInput(pref), kind: "model_export" as const };
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from((await renderArtifact(x, "xlsx")).bytes) as never);
    const names = wb.worksheets.map((ws) => ws.name);
    expect(names[names.indexOf("Equity flows") + 1]).toBe("Partners");
    const sheet = wb.getWorksheet("Partners")!;
    const h = heldPartnerReturns(x.result.equityFlows, x.input.waterfall!);
    const months = [...new Set(x.result.equityFlows.map((f) => Math.round(f.t * 12)))].sort((a, b) => a - b);
    expect((sheet.getRow(4).values as unknown[]).slice(1)).toEqual(["Month (cash date)", "Year", "Kind", "Deal flow", "LP flow", "GP flow"]);
    for (const [n, month] of months.entries()) {
      const row = (sheet.getRow(n + 5).values as unknown[]).slice(1);
      const deal = x.result.equityFlows.filter((f) => Math.round(f.t * 12) === month);
      expect(row[2]).toBe([...new Set(deal.map((f) => f.kind === "unrealized" ? "Unrealized, not a sale" : f.kind))].join(", "));
      expect(Math.abs((row[4] as number) + (row[5] as number) - (row[3] as number))).toBeLessThanOrEqual(0.01);
    }
    const last = months.length + 5;
    expect((sheet.getRow(last).values as unknown[])[1]).toBe("Total");
    const positive = (flows: { amount: number }[]) => flows.filter((f) => f.amount > 0).reduce((n, f) => n + f.amount, 0);
    const summary = [last + 1, last + 2, last + 3, last + 4, last + 5, last + 6, last + 7].map((n) => (sheet.getRow(n).values as unknown[]).slice(1));
    expect(summary).toEqual([
      ["LP IRR (unrealized, not a sale)", h.withValue.lpIrr ?? "Not meaningful"],
      ["GP IRR (unrealized, not a sale)", h.withValue.gpIrr ?? "Not meaningful"],
      ["GP promote (unrealized, not a sale)", h.withValue.promote],
      [],
      ["Paid out to the LP", positive(h.paid.lp)],
      ["Paid out to the GP", positive(h.paid.gp)],
      ["GP promote paid", h.paid.promote],
    ]);
    expect(sheet.rowCount).toBe(last + 7);
  });

  test("a stated value that is not meaningful still builds, by the roots rule", () => {
    const x = heldPartnerInput(8, { expenseRatioPct: undefined, fixedOpexAnnual: 50_000_000 });
    expect(metric(x, "stated_value").status).toBe("NOT_MEANINGFUL");
    expect(x.result.equityFlows.some((f) => f.kind === "unrealized")).toBe(false);
    const model = buildModel(x);
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    const stats = model.blocks.find((b) => b.type === "stats")!;
    expect(stats.type === "stats" ? stats.items.slice(2).map((i) => i.value) : []).toEqual([irrText(w.lp), irrText(w.gp)]);
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest)).toMatchObject({ pass: true, orphans: [] });
  });
});


describe("a Partners sheet in the Excel export (task 85b)", () => {
  const workbook = async (x: ArtifactInput) => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from((await renderArtifact(x, "xlsx")).bytes) as never);
    return wb;
  };
  test.each([false, true])("sale=%s has terms, conserved monthly flows, totals and metric rows", async (sale) => {
    const x = partnerMemoInput(sale);
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    const wb = await workbook(x);
    const names = wb.worksheets.map((ws) => ws.name);
    expect(names[names.indexOf("Equity flows") + 1]).toBe("Partners");
    const sheet = wb.getWorksheet("Partners")!;
    expect(sheet).toBeDefined();
    const months = [...new Set(x.result.equityFlows.map((f) => Math.round(f.t * 12)))].sort((a, b) => a - b);
    // No blank rows: three terms, a header, one row per cash-date month and four closing rows.
    expect(sheet.rowCount).toBe(3 + 1 + months.length + 4);
    for (const [n, key, value] of [[1, "lp_share_pct", 90], [2, "preferred_return_pct", 8], [3, "gp_promote_pct", 20]] as const) {
      expect((sheet.getRow(n).values as unknown[]).slice(1)).toEqual([FIELD_BY_KEY.get(key)!.label, value]);
      expect(sheet.getRow(n).getCell(2).numFmt).toBe('0.00"%"');
    }
    expect((sheet.getRow(4).values as unknown[]).slice(1)).toEqual(["Month (cash date)", "Year", "Kind", "Deal flow", "LP flow", "GP flow"]);
    const sums = [0, 0, 0];
    for (const [n, month] of months.entries()) {
      const deal = x.result.equityFlows.filter((f) => Math.round(f.t * 12) === month);
      expect(new Set(deal.map((f) => f.t)).size).toBe(1);
      const amounts = [deal, w.lp.filter((f) => Math.round(f.t * 12) === month), w.gp.filter((f) => Math.round(f.t * 12) === month)]
        .map((flows) => flows.reduce((sum, f) => sum + f.amount, 0));
      const row = sheet.getRow(n + 5);
      expect((row.values as unknown[]).slice(1)).toEqual([month, deal[0]!.t, [...new Set(deal.map((f) => f.kind))].join(", "), ...amounts]);
      expect(Math.abs(amounts[1]! + amounts[2]! - amounts[0]!)).toBeLessThanOrEqual(0.01);
      amounts.forEach((v, i) => { sums[i]! += v; });
      for (const col of [4, 5, 6]) expect(row.getCell(col).numFmt).toBe(wb.getWorksheet("Equity flows")!.getRow(2).getCell(4).numFmt);
    }
    expect((sheet.getRow(months.length + 5).values as unknown[]).slice(1)).toEqual(["Total", , , ...sums]);
    const capital = saleTable(buildModel(x), "Capital and distributions").rows;
    for (const [n, label, flows] of [[0, "Total", x.result.equityFlows], [1, "LP", w.lp], [2, "GP", w.gp]] as const) {
      const row = capital.find((r) => r[0] === label)!;
      const number = (s: string) => Number(s.replace(/[^0-9.-]/g, ""));
      const contributed = -flows.filter((f) => f.amount < 0).reduce((sum, f) => sum + f.amount, 0);
      const distributed = flows.filter((f) => f.amount > 0).reduce((sum, f) => sum + f.amount, 0);
      expect(Math.abs(contributed - number(row[1]!))).toBeLessThanOrEqual(1);
      expect(Math.abs(distributed - number(row[2]!))).toBeLessThanOrEqual(1);
      expect(Math.abs(sums[n]! - (number(row[2]!) - number(row[1]!)))).toBeLessThanOrEqual(1);
    }
    for (const [n, key] of ["lp_irr", "gp_irr", "gp_promote"].entries()) {
      const metric = x.result.scenarios[0]!.metrics.find((m) => m.key === key)!;
      const row = sheet.getRow(months.length + 6 + n);
      expect((row.values as unknown[]).slice(1)).toEqual([metric.label, metric.value]);
      expect(row.getCell(2).numFmt).toBe(metric.unit === "$" ? wb.getWorksheet("Equity flows")!.getRow(2).getCell(4).numFmt : '0.00"%"');
    }
    sheet.eachRow((row) => row.eachCell((cell) => expect(typeof cell.value).not.toBe("object")));
  });
  test("Kestrel groups both waterfall tiers and month 15's sale and contribution by cash date", async () => {
    const x = partnerMemoInput(true);
    const w = runWaterfall(x.result.equityFlows, x.input.waterfall!);
    const month = w.lp.map((f) => Math.round(f.t * 12)).find((m) => w.lp.filter((f) => Math.round(f.t * 12) === m).length > x.result.equityFlows.filter((f) => Math.round(f.t * 12) === m).length)!;
    expect(month).toBeDefined();
    expect(w.lp.length).toBeGreaterThan(x.result.equityFlows.length);
    const sheet = (await workbook(x)).getWorksheet("Partners")!;
    expect(sheet).toBeDefined();
    for (const key of new Set([month, 15])) {
      const rows: unknown[][] = [];
      sheet.eachRow((row, n) => { if (n > 4 && row.getCell(1).value === key) rows.push((row.values as unknown[]).slice(1)); });
      expect(rows).toHaveLength(1);
      expect(Math.abs(Number(rows[0]![4]) + Number(rows[0]![5]) - Number(rows[0]![3]))).toBeLessThanOrEqual(0.01);
      expect(Number(rows[0]![4])).toBe(w.lp.filter((f) => Math.round(f.t * 12) === key).reduce((sum, f) => sum + f.amount, 0));
      if (key === 15) {
        const flows = x.result.equityFlows.filter((f) => Math.round(f.t * 12) === 15);
        expect(flows).toHaveLength(2);
        expect(rows[0]![2]).toBe("sale, contribution");
        expect(rows[0]![3]).toBe(flows[0]!.amount + flows[1]!.amount);
      }
    }
  });
  test.each(["alder", "maple"])("%s without a split keeps its sheet names", async (deal) => {
    const x = deal === "alder" ? saleInput("alder-court-condo", "model_export") : mapleInput("model_export");
    expect((await workbook(x)).worksheets.map((ws) => ws.name)).toEqual(["Summary", "Metrics", ...(deal === "maple" ? ["Annual"] : []), "Monthly ledger", "Equity flows", "Inputs", "Checks"]);
  });
  test("non-valid partner metrics print their stored reasons", async () => {
    const x = partnerMemoInput(true);
    const keys = ["lp_irr", "gp_irr", "gp_promote"];
    x.result.scenarios[0]!.metrics = x.result.scenarios[0]!.metrics.map((m) => keys.includes(m.key)
      ? { ...m, status: "NOT_MEANINGFUL", value: null, reason: "Deal returns are not meaningful." } : m);
    const sheet = (await workbook(x)).getWorksheet("Partners")!;
    expect(sheet).toBeDefined();
    for (const offset of [2, 1, 0]) expect(sheet.getRow(sheet.rowCount - offset).getCell(2).value).toBe("Deal returns are not meaningful.");
  });
});


describe("a report says when a check decides the verdict (task 85a)", () => {
  const message = "This run fails a check that no gate can offset. Passing the gates alone would not change the verdict while it stands.";
  const shortEquity = () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    x.input = { ...x.input, stated: { equity: 0 } };
    x.result = underwrite(x.input, x.policy);
    expect(x.result.verdict.hardFailReasons.length).toBeGreaterThan(0);
    return x;
  };
  test.each([false, true])("Kestrel short equity with all gates passed=%s prints the warning before its table", (passed) => {
    const x = shortEquity();
    expect(x.result.verdict.gates.some((g) => g.status === "failed")).toBe(true);
    if (passed) x.result.verdict.gates = x.result.verdict.gates.map((g) => ({ ...g, status: "passed" }));
    const model = buildModel(x);
    const at = model.blocks.findIndex((b) => b.type === "heading" && b.text === "What would change the answer");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(model.blocks[at + 1]).toEqual({ type: "paragraph", text: message });
    const table = model.blocks[at + 2];
    expect(table?.type).toBe("table");
    if (table?.type === "table") {
      if (passed) expect(table.caption).toBe("Stresses (each a full re-run of the model)");
      else expect(table.columns.some((c) => c.label === "Input moved")).toBe(true);
    }
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
  test("Maple keeps its notice first, then adds the warning and no table", () => {
    const x = mapleInput("build_decision");
    expect(x.result.verdict.hardFailReasons.length).toBeGreaterThan(0);
    const model = buildModel(x);
    const at = model.blocks.findIndex((b) => b.type === "heading" && b.text === "What would change the answer");
    expect(model.blocks[at + 1]).toEqual({ type: "paragraph", muted: true, text: "Not shown: this run was made under a different policy." });
    expect(model.blocks[at + 2]).toEqual({ type: "paragraph", text: message });
    expect(model.blocks[at + 3]).not.toMatchObject({ type: "table" });
    const text = visibleText(renderHtml(model));
    expect(text.split(message)).toHaveLength(2);
    // The warning is the only change: without it, the text is the card 80 pin.
    const restored = { ...model, blocks: model.blocks.filter((_, n) => n !== at + 2) };
    // card 97c: DSCR→DCR rename only; text otherwise identical to `c49c28c5eafee7e5d6eb89704d4b04584c7887ecbf5d51bd33160417cf83d17e`
    expect(createHash("sha256").update(visibleText(renderHtml(restored))).digest("hex"))
      .toBe("3377dc48bc5130ccc4b8941ac7ccb38f612e8c939d1ac8a431cb7476c8ef29ae");
    expect(verifyProvenance(text, model.formatter.manifest).orphans).toEqual([]);
  });
  test.each(["engine", "policy"])("the %s notice comes before the warning", (notice) => {
    const x = shortEquity();
    if (notice === "engine") x.run.engineVersion = "0.9.0";
    else x.run.policyHash = "different";
    const model = buildModel(x);
    const at = model.blocks.findIndex((b) => b.type === "heading" && b.text === "What would change the answer");
    expect(model.blocks[at + 1]).toMatchObject({ type: "paragraph", text: expect.stringMatching(/^Not shown:/) });
    expect(model.blocks[at + 2]).toEqual({ type: "paragraph", text: message });
    // A run from another engine or policy shows no break-even table.
    expect(model.blocks.some((b) => b.type === "table" && b.columns.some((c) => c.label === "Input moved"))).toBe(false);
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
  test("Kestrel without stated equity adds no warning", () => {
    const x = saleInput("kestrel-row-townhomes", "build_decision");
    expect(x.result.verdict.hardFailReasons).toEqual([]);
    const model = buildModel(x);
    expect(visibleText(renderHtml(model))).not.toContain(message);
    expect(verifyProvenance(visibleText(renderHtml(model)), model.formatter.manifest).orphans).toEqual([]);
  });
});

describe("the broker's logo on the lender package (task 89d)", () => {
  // A real PNG, so Word can embed it.
  const png = (w: number, h: number) => {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
  };
  // Digits in the name: "Prepared by" goes through the provenance manifest.
  const broker = { name: "Harbour 2026 Brokers", logo: { bytes: png(120, 40), mime: "image/png" as const, width: 120, height: 40 } };
  const html = (x: ArtifactInput) => renderHtml(buildModel(x));
  const hasMedia = (bytes: Uint8Array) => Buffer.from(bytes).includes("word/media/");
  test("the PDF page shows the logo, at most 48 px high, and Prepared by the workspace", () => {
    const x = { ...mapleInput("lender_package"), broker };
    const page = html(x);
    const img = page.match(/<img [^>]*>/g) ?? [];
    expect(img).toHaveLength(1);
    expect(img[0]).toContain(`src="data:image/png;base64,${Buffer.from(broker.logo.bytes).toString("base64")}"`);
    expect(img[0]).toMatch(/height="40"/);
    expect(img[0]).toMatch(/width="120"/);
    expect(visibleText(page)).toContain("Prepared by Harbour 2026 Brokers");
    const model = buildModel(x);
    expect(verifyProvenance(visibleText(page), model.formatter.manifest).orphans).toEqual([]);
  });
  test("a tall logo is scaled to 48 px high, keeping its aspect", () => {
    const tall = { ...broker, logo: { ...broker.logo, bytes: png(100, 200), width: 100, height: 200 } };
    const img = html({ ...mapleInput("lender_package"), broker: tall }).match(/<img [^>]*>/)![0];
    expect(img).toMatch(/height="48"/);
    expect(img).toMatch(/width="24"/);
  });
  test("a wide logo is scaled to at most 240 px wide, keeping its aspect (task 91b)", () => {
    const wide = { ...broker, logo: { ...broker.logo, bytes: png(1200, 100), width: 1200, height: 100 } };
    const img = html({ ...mapleInput("lender_package"), broker: wide }).match(/<img [^>]*>/)![0];
    expect(img).toMatch(/width="240"/);
    expect(img).toMatch(/height="20"/);
  });
  test("the Word lender package has the image part and Prepared by; its scan passes", async () => {
    const out = await renderArtifact({ ...mapleInput("lender_package"), broker }, "docx");
    expect(out.provenance.orphans).toEqual([]);
    expect(hasMedia(out.bytes)).toBe(true);
    const plain = await renderArtifact(mapleInput("lender_package"), "docx");
    expect(hasMedia(plain.bytes)).toBe(false);
  });
  test("without a logo, the lender package is today's", () => {
    expect(html({ ...mapleInput("lender_package"), broker: undefined })).toBe(html(mapleInput("lender_package")));
    expect(html(mapleInput("lender_package"))).not.toContain("<img");
  });
  test("the IC memo, build decision and partner memo ignore a logo", async () => {
    for (const x of [mapleInput("ic_memo"), mapleInput("build_decision"), partnerMemoInput(false)]) {
      expect(html({ ...x, broker })).toBe(html(x));
      expect(hasMedia((await renderArtifact({ ...x, broker }, "docx")).bytes)).toBe(false);
    }
  });
});


describe("card 93c draft French reports", () => {
  const banner = "Traduction provisoire : ce rapport n'a pas encore été révisé par un traducteur qualifié. En cas de divergence, la version anglaise fait foi.";
  test.each((["ic_memo", "lender_package", "build_decision", "partner_memo"] as const).flatMap((kind) => (["pdf", "docx"] as const).map((format) => ({ kind, format }))))("$kind $format is a French draft with sourced French figures", async ({ kind, format }) => {
    const x = { ...mapleInput(kind), lang: "fr" } as ArtifactInput;
    x.input = { ...x.input, waterfall: { lpSharePct: 90, preferredReturnPct: 8, gpPromotePct: 20 } };
    x.result = underwrite(x.input, x.policy);
    x.assumptions = [
      { fieldKey: "land_cost", itemKey: null, label: "Land cost", unit: "$", value: 2450000, sourceKind: "analyst", source: "Translation example", sponsorStated: true },
      { fieldKey: "exit_cap_rate_pct", itemKey: null, label: "Exit cap rate", unit: "%", value: 5.5, sourceKind: "analyst", source: "Translation example", sponsorStated: true },
    ];
    const html = renderHtml(buildModel(x));
    expect(html).toContain('<html lang="fr-CA">');
    expect(visibleText(html.slice(html.indexOf("<body>") + 6)).trimStart()).toMatch(/^Traduction provisoire/);
    const text = visibleText(html).replace(/\s/g, " ");
    expect(text).toContain("2 450 000 $");
    expect(text).toContain("5,50 %");
    const artifact = await renderArtifact(x, format);
    expect(artifact.provenance).toMatchObject({ pass: true, orphans: [] });
    if (format === "docx") {
      const mammoth = await import("mammoth");
      const extracted = await mammoth.extractRawText({ buffer: Buffer.from(artifact.bytes) });
      expect(extracted.value.trimStart().startsWith(banner)).toBe(true);
    } else {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({ data: new Uint8Array(artifact.bytes), useSystemFonts: true });
      try {
        const page = await (await task.promise).getPage(1);
        const content = await page.getTextContent();
        const first = content.items.map((i) => "str" in i ? i.str : "").join(" ").replace(/\s+/g, " ").trim();
        expect(first.startsWith(banner)).toBe(true);
      } finally { await task.destroy(); }
    }
  });
  test("translates stored English check messages while leaving the run unchanged", () => {
    const x = { ...mapleInput("ic_memo"), lang: "fr", input: allEquityDeal() } as ArtifactInput;
    x.result = underwrite(x.input, POLICY_V1);
    const before = canonicalJson(x.result);
    const check = x.result.checks.find((c) => c.key === "sources_cover_uses")!;
    const text = visibleText(renderHtml(buildModel(x)));
    expect(text).not.toContain(check.message);
    expect(text).toContain("Aucun montant de fonds propres n'est indiqué");
    expect(canonicalJson(x.result)).toBe(before);
  });
});


describe("card 94b report insured product", () => {
  test.each(["en", "fr"] as const)("%s names Select points or Standard term with provenance", lang => {
    for (const points of [50, undefined]) {
      const x = mapleInput("lender_package");
      x.lang = lang;
      x.input = {...x.input, exit:"refinance_hold", refinance:{month:40,ltvPct:75,ratePct:5,amortYears:30,ioMonths:0,insurancePremiumPct:4,...(points === undefined ? {termYears:10} : {mliSelectPoints:points})}};
      x.policy=policyFor(x.input); x.result=underwrite(x.input,x.policy);
      const model=buildModel(x), text=visibleText(renderHtml(model));
      expect(text).toContain(points === undefined ? "MLI Standard" : "MLI Select, 50 points");
      expect(text).toContain(points === undefined ? (lang === "en" ? "10-year term" : "durée de 10 ans") : "50 points");
      expect(verifyProvenance(text,model.formatter.manifest).orphans).toEqual([]);
    }
    expect(formatValue(50,"points")).toBe("50");
  });
});


describe("card 97c report rendering", () => {
  test("renames DSCR only for rendering and lets provenance tables break between pages", () => {
    const x=mapleInput("lender_package");
    x.assumptions[0]={...x.assumptions[0]!,sponsorStated:true};
    x.assumptions.push({...x.assumptions[0]!,fieldKey:"land_transfer_tax",label:"Land transfer tax",sourceKind:"table",sponsorStated:false,source:"Published table: Fictional published source"});
    const stored=canonicalJson(x.result),model=buildModel(x),html=renderHtml(model),text=visibleText(html);
    expect(text).not.toMatch(/\bDSCR\b/);
    expect(text).toContain("DCR");
    expect(canonicalJson(x.result)).toBe(stored);
    const tables=model.blocks.filter(b=>b.type === "table" && !b.caption);
    expect(tables).toHaveLength(2);
    for (const table of tables) expect(table).toMatchObject({long:true});
    expect((html.match(/<section class="tbl long">/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  test("human-entered source and reason text retains DSCR", () => {
    const source="DSCR lender note; owner's reason: DSCR checked manually.";
    for (const lang of ["en","fr"] as const) {
      const x=mapleInput("lender_package");x.lang=lang;
      x.assumptions[0]={...x.assumptions[0]!,source};
      expect(visibleText(renderHtml(buildModel(x)))).toContain(source);
    }
  });
  test.each(["en","fr"] as const)("%s Standard term is a bare integer recorded in years", lang => {
    const x=mapleInput("lender_package");x.lang=lang;
    x.input={...x.input,exit:"refinance_hold",refinance:{month:40,ltvPct:75,ratePct:5,amortYears:30,ioMonths:0,insurancePremiumPct:4,termYears:10}};
    x.policy=policyFor(x.input);x.result=underwrite(x.input,x.policy);
    const model=buildModel(x),text=visibleText(renderHtml(model));
    expect(text).toContain(lang === "en" ? "10-year term" : "durée de 10 ans");
    expect(model.formatter.manifest).toContainEqual({text:"10",ref:"input:refinance_term_years",unit:"years"});
    expect(verifyProvenance(text,model.formatter.manifest).orphans).toEqual([]);
  });
});
