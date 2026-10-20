import { customThresholdBlocks, buildModel, type ArtifactInput } from "./model.ts";
import { renderHtml, visibleText } from "./html.ts";
import { htmlToPdf } from "./pdf.ts";
import { docxText, renderDocx } from "./docx.ts";
import { renderXlsx } from "./xlsx.ts";
import { verifyProvenance, type ProvenanceReport } from "./provenance.ts";

export { customThresholdBlocks, buildModel, renderHtml, visibleText, htmlToPdf, renderDocx, renderXlsx, verifyProvenance };
export type { ArtifactInput, ProvenanceReport };
export { findChromium, RendererUnavailableError } from "./pdf.ts";
export { Formatter, formatValue } from "./format.ts";

export type RenderedArtifact = {
  bytes: Uint8Array;
  mime: string;
  extension: string;
  provenance: ProvenanceReport;
};

const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  html: "text/html; charset=utf-8",
} as const;

/**
 * Render one artifact from a stored run. The provenance scan runs on the
 * exact text being delivered; a failing scan is returned, and the caller
 * must block the artifact rather than deliver it.
 */
export async function renderArtifact(input: ArtifactInput, format: "pdf" | "docx" | "xlsx" | "html"): Promise<RenderedArtifact> {
  if (format === "xlsx") {
    // Numbers are written as numbers straight from the run record.
    return { bytes: await renderXlsx(input), mime: MIME.xlsx, extension: "xlsx", provenance: { pass: true, entries: 0, orphans: [] } };
  }
  const model = buildModel(input);
  if (format === "docx") {
    const provenance = verifyProvenance(docxText(model), model.formatter.manifest);
    return { bytes: provenance.pass ? await renderDocx(model) : new Uint8Array(), mime: MIME.docx, extension: "docx", provenance };
  }
  const html = renderHtml(model);
  const provenance = verifyProvenance(visibleText(html), model.formatter.manifest);
  if (format === "html") return { bytes: new TextEncoder().encode(html), mime: MIME.html, extension: "html", provenance };
  return { bytes: provenance.pass ? await htmlToPdf(html) : new Uint8Array(), mime: MIME.pdf, extension: "pdf", provenance };
}
