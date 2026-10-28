import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentRow } from "../src/api";
import { Documents } from "../src/routes/documents.tsx";

// Card W5: the Documents screen. Mocks follow apps/web/test/run.test.ts.
const state = vi.hoisted(() => ({ docs: undefined as unknown, role: "owner", ai: true, lang: "en" as "en" | "fr" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "documents" ? { data: state.docs } : {}),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ children, to, params }: { children: ReactNode; to: string; params?: { dealId?: string } }) =>
      createElement("a", { href: params?.dealId ? to.replace("$dealId", params.dealId) : to }, children),
  };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { deal: { id: "d1", name: "Test deal", workspace_id: "ws" }, documents: { total: 0, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: true, role: state.role, me: { workspaces: [{ id: "other", ai_reading: !state.ai }, { id: "ws", ai_reading: state.ai }] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("../src/components/QuickStart", async () => {
  const { createElement } = await import("react");
  return { QuickStart: () => createElement("div", { "data-testid": "quick-start" }, "Quick start form") };
});

const row = (stage: string, extra: Partial<DocumentRow> = {}): DocumentRow => ({
  id: `doc-${stage}`, name: `${stage}.pdf`, kind: "pdf", role_set: null, read_role: null, size_bytes: 2048, stage, stage_detail: null, page_count: 3,
  number_format: null, needs_ocr: false, candidate_count: 0, used_count: 0, other_count: 0, created_at: "2026-10-20T12:00:00Z", uploaded_by: "Ada", ...extra,
});
const everyStage = (): DocumentRow[] => [
  row("uploaded"),
  row("checking"),
  row("rejected", { stage_detail: "This file type cannot be read" }),
  row("reading"),
  row("read_failed"),
  row("extracting"),
  row("extracted", { candidate_count: 3, other_count: 2, number_format: "1.234,56", read_role: "budget (deal source)" }),
];
const render = () => renderToStaticMarkup(createElement(Documents, { dealId: "d1" }));
const count = (html: string, s: string) => html.split(s).length - 1;

beforeEach(() => {
  state.docs = everyStage();
  state.role = "owner";
  state.ai = true;
  state.lang = "en";
});

describe("Documents screen", () => {
  it("shows each file's stage and result sentence", () => {
    const html = render();
    for (const label of ["Waiting to be checked", "Checking the file", "Reading", "Finding values"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-label="Rejected when checked"');
    expect(html).toContain('aria-label="Could not be read"');
    expect(html).toContain('aria-label="Read, values found"');
    expect(html).toContain("3 found by rules");
    expect(html).toContain("2 figures not needed (<a href=\"/deals/d1/review\">show</a>)");
    expect(html).toContain("Numbers written as 1.234,56: check each value");
    expect(html).toContain("This file could not be used.");
    expect(html).toContain("This file type cannot be read");
    expect(html).toContain("Agir: About this deal");
    expect(html).toContain('href="/api/documents/doc-extracted/file"');
    expect(html).toContain('class="table"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it("counts the values in use from a file, from the rules or the AI reading, once there are any (QA run 2, skeptic N2)", () => {
    state.docs = [row("extracted", { candidate_count: 2, used_count: 4 })];
    expect(render()).toContain("4 values used");
    expect(render()).not.toContain("found by rules");
    state.docs = [row("extracted", { candidate_count: 0, used_count: 1 })];
    expect(render()).toContain("1 value used");
    state.lang = "fr";
    state.docs = [row("extracted", { candidate_count: 2, used_count: 0 })];
    expect(render()).toContain("2 trouvées par les règles");
  });

  it("notes a file read by OCR only when the worker says so", () => {
    state.docs = [row("extracted", { needs_ocr: true, page_count: 1, candidate_count: 1, stage_detail: "Read by OCR from 1 scanned page. Check every value against the page before approving it." })];
    expect(render()).toContain("Read by OCR from 1 scanned page");
    state.docs = [row("extracted", { candidate_count: 1 })];
    expect(render()).not.toContain("OCR");
  });

  it("offers the upload role cards and the per-file role control only to editors", () => {
    let html = render();
    expect(html).toContain("What are the files you add?");
    expect(html).toContain('type="radio" name="upload-role"');
    expect(html).toContain("Let Agir decide");
    expect(html).toContain('aria-label="Change the role of extracted.pdf"');
    expect(html).toContain("Drop deal documents here");
    expect(html).toContain("Remove");
    state.role = "viewer";
    html = render();
    expect(html).not.toContain("What are the files you add?");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain("Change the role of");
    expect(html).not.toContain("Drop deal documents here");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain(">Retry<");
  });

  it("says under the drop zone whether the deal's workspace reads documents with AI (card C)", () => {
    const on = render();
    expect(on).toContain("AI reading is on for this workspace");
    expect(on.indexOf("AI reading is on")).toBeGreaterThan(on.indexOf("doc-upload"));
    state.ai = false;
    expect(render()).toContain("AI reading is off for this workspace: only Agir&#x27;s own rules read these documents.");
    state.lang = "fr";
    expect(render()).toContain("La lecture par IA est désactivée pour cet espace de travail\u00a0:");
    state.ai = true;
    expect(render()).toContain("La lecture par IA est activée pour cet espace de travail\u00a0:");
    state.role = "viewer";
    expect(render()).not.toContain("La lecture par IA");
  });

  it("offers Retry only for a file that could not be read", () => {
    const html = render();
    expect(count(html, ">Retry<")).toBe(1);
    const retryRow = html.split("<tr").find((r) => r.includes(">Retry<"))!;
    expect(retryRow).toContain("read_failed.pdf");
  });

  it("counts a rejected file only as failed, finishes its sentence, and keeps the quick start (QA #18)", () => {
    state.docs = [row("rejected", { stage_detail: "The file does not start like a PDF" })];
    const html = render();
    expect(html).toContain("1 could not be used");
    expect(html).not.toMatch(/\d+ read\b/);
    expect(html).toContain("The file does not start like a PDF.");
    expect(html).toContain("Remove it, then upload the original file again.");
    expect(html).not.toMatch(/PDF\s*—/);
    expect(html).toContain("Quick start form");
    expect(html).toContain("No documents? Use the quick start");
    expect(html).not.toContain("No documents yet. Upload");
  });

  it("gives each row an id and its cells labels, so a phone can stack them as cards (QA #17)", () => {
    const html = render();
    expect(html).toContain('id="doc-doc-extracted"');
    expect(html).toContain('data-label="Checked · Read · Values"');
    expect(html).toContain('data-label="Result"');
    expect(html).toContain('class="scroll docs-list"');
  });

  it("links to the quick start only when the deal has no documents", () => {
    state.docs = [];
    let html = render();
    expect(html).toContain("No documents? Use the quick start");
    expect(html).toContain('href="#quick-start"');
    expect(html).toContain('id="quick-start"');
    state.docs = everyStage();
    html = render();
    expect(html).not.toContain("Use the quick start");
    expect(html).not.toContain("Quick start form");
    state.docs = [];
    state.role = "viewer";
    expect(render()).not.toContain("Use the quick start");
  });
});
