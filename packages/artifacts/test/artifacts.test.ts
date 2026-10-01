import { describe, expect, test } from "vitest";
import { FIELD_BY_KEY, POLICY_V1 } from "@agir/contracts";
import { assemble, underwrite, type AssumptionRow } from "@agir/engine";
import { consolidate, extractCandidates, type SourcedCandidate } from "@agir/extraction";
import { loadOracle } from "@agir/testkit";
import { buildModel, renderArtifact, renderHtml, verifyProvenance, visibleText, type ArtifactInput } from "../src/index.ts";

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
});
