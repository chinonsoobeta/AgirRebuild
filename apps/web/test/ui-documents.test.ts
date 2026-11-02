import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentRow } from "../src/api";
import { Documents } from "../src/routes/documents.tsx";

// Card W5: the Documents screen. Mocks follow apps/web/test/run.test.ts.
const state = vi.hoisted(() => ({ docs: undefined as unknown, role: "owner", ai: true, lang: "en" as "en" | "fr",
  overview: {} as Record<string, unknown>, mutate: [] as unknown[], hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "documents" ? { data: state.docs } : {}),
  useMutation: () => ({ mutate: (vars: unknown) => { state.mutate.push(vars); }, isPending: false, reset: () => {}, error: null }),
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
    useDeal: () => ({ data: { deal: { id: "d1", name: "Test deal", workspace_id: "ws" }, documents: { total: 0, processing: 0, failed: 0 }, ...state.overview } }),
    useSession: () => ({ solo: true, role: state.role, me: { workspaces: [{ id: "other", ai_reading: !state.ai }, { id: "ws", ai_reading: state.ai }] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
// useState keeps its values between renders, and buttons are recorded, so a test can click and draw again (as ui-auth.test.ts).
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (args[0] === "button") state.nodes.push({ tag: "button", props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
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
const render = () => { state.index = 0; state.nodes = []; return renderToStaticMarkup(createElement(Documents, { dealId: "d1" })); };
const buttons = (label: string) => state.nodes.filter((n) => n.props.children === label || (Array.isArray(n.props.children) && n.props.children.includes(label)));
const count = (html: string, s: string) => html.split(s).length - 1;

beforeEach(() => {
  state.docs = everyStage();
  state.role = "owner";
  state.ai = true;
  state.lang = "en";
  state.overview = {};
  state.mutate = [];
  state.hooks = [];
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

  // QA card D3 (impatient N1): the banner comes from the overview's counts, so it is there after a reload too.
  it("shows the Review N values banner on a return visit whenever values wait for review", () => {
    state.docs = [row("extracted", { candidate_count: 19 })];
    state.overview = { documents: { total: 1, processing: 0, failed: 0 }, review: { needsReview: 18, conflicting: 2, approved: 0, awaitingSecond: 0 } };
    let html = render();
    expect(html).toContain("1 file read, 20 values to review.");
    expect(html).toContain('href="/deals/d1/review"');
    expect(html).toContain("Review 20 values →");
    // Before the list arrives the overview alone is enough.
    state.docs = undefined;
    expect(render()).toContain("1 file read, 20 values to review.");
    // Nothing waiting: no banner on a return visit.
    state.docs = [row("extracted", { candidate_count: 19 })];
    state.overview = { documents: { total: 1, processing: 0, failed: 0 }, review: { needsReview: 0, conflicting: 0, approved: 19, awaitingSecond: 0 } };
    html = render();
    expect(html).not.toContain("to review.");
    // While a file is still being read, the values are not counted yet.
    state.docs = [row("reading")];
    state.overview = { documents: { total: 1, processing: 1, failed: 0 }, review: { needsReview: 3, conflicting: 0, approved: 0, awaitingSecond: 0 } };
    expect(render()).not.toContain("to review.");
  });

  // QA card D3 (breaker #12): Remove asks in the page, and a double click on its Yes sends one request.
  it("asks before removing in the page, not with a native confirm, and sends one request", () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    state.docs = [row("extracted", { candidate_count: 3 })];
    let html = render();
    expect(html).not.toContain("Remove extracted.pdf from this deal?");
    buttons("Remove")[0]!.props.onClick();
    html = render();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Remove extracted.pdf from this deal? Values found only in it go back to review.");
    expect(buttons("Remove")[0]!.props.disabled).toBe(true);
    const yes = buttons("Remove the file")[0]!;
    yes.props.onClick();
    yes.props.onClick();
    expect(state.mutate).toEqual([{ id: "doc-extracted", action: "retire" }]);
    expect(confirm).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    // Cancel closes it without a request.
    state.hooks = [];
    state.mutate = [];
    render();
    buttons("Remove")[0]!.props.onClick();
    render();
    buttons("Cancel")[0]!.props.onClick();
    expect(render()).not.toContain('role="alertdialog"');
    expect(state.mutate).toEqual([]);
    state.lang = "fr";
    state.hooks = [];
    render();
    buttons("Retirer")[0]!.props.onClick();
    expect(render()).toContain("Retirer le fichier");
  });

  // QA card D3 (breaker N2): a long uploader name is cut, with the whole name in its title.
  it("cuts a long uploader name with an ellipsis and keeps it whole in the title", () => {
    const long = "Bartholomew-Maximilian Featherstonehaugh-Cholmondeley the Third";
    state.docs = [row("extracted", { uploaded_by: long })];
    const html = render();
    expect(html).toContain(`by <span class="docs-by" title="${long}">${long}</span>`);
    state.docs = [row("extracted", { uploaded_by: null as unknown as string })];
    expect(render()).not.toContain("docs-by");
  });
});

it.each(["extracted", "read_failed"])("Card 180 renders separate translated detail lines for %s", stage => {
  state.lang = "fr";
  state.docs = [row(stage, { stage_detail: "1 of 2 pages in this PDF is a picture.\nAgir found no text it could read there." })];
  const html = render();
  expect(html).toContain("1 des 2 pages");
  expect(html).toMatch(/image\.<\/span>.*<span[^>]*>.*Agir/s);
  expect(html).not.toContain("is a picture");
});

it("Card 181 accepts picture extensions in the upload picker", () => {
  expect(render()).toContain('accept=".pdf,.xlsx,.csv,.docx,.txt,.png,.jpg,.jpeg,.tif,.tiff"');
});

describe("Card 189: why a file was set aside", () => {
  const plain = (html: string) => html.replaceAll("&#x27;", "'");
  const context = (extra: Partial<DocumentRow> = {}) => row("extracted", { read_role: "market report (context)", ...extra });

  it.each([
    ["en", "market report (context)", "Looks like a market report, so its figures are not used."],
    ["fr", "market report (context)", "Ressemble à un rapport de marché, donc ses chiffres ne sont pas utilisés."],
    ["en", "appraisal (evidence)", "Looks like an appraisal. Agir reads it, skips sections such as comparables, and asks you to check each figure."],
    ["fr", "appraisal (evidence)", "Ressemble à une évaluation. Agir le lit, saute des sections comme les comparables et vous demande de vérifier chaque chiffre."],
    ["en", "term sheet (deal source)", "Looks like a term sheet."],
    ["fr", "term sheet (deal source)", "Ressemble à une lettre d'offre."],
  ] as const)("in %s, %s gives the reason", (lang, read_role, reason) => {
    state.lang = lang;
    state.docs = [row("extracted", { read_role })];
    expect(plain(render())).toContain(`<span class="sub">${reason}`);
  });

  it.each([
    ["unrecognized document (deal source)", {}],
    ["budget (deal source)", {}],
    ["market report (context, set by a person)", {}],
    ["market report (context)", { role_set: "context" as const }],
    ["market report (context)", { stage: "reading" }],
    ["market report (context)", { stage: "read_failed" }],
  ])("gives no reason for %s %j", (read_role, extra) => {
    state.docs = [row("extracted", { read_role, ...extra })];
    expect(render()).not.toContain("Looks like");
  });

  it("offers Read it anyway to an editor, on an Agir decision of context only", () => {
    state.docs = [context()];
    let html = render();
    expect(html).toContain('aria-label="Read extracted.pdf anyway"');
    expect(html).toContain(">Read it anyway</button>");
    buttons("Read it anyway")[0]!.props.onClick();
    expect(state.mutate).toEqual([{ id: "doc-extracted", value: "deal_source" }]);
    state.lang = "fr";
    html = render();
    expect(html).toContain('aria-label="Lire extracted.pdf quand même"');
    expect(html).toContain(">Le lire quand même</button>");
    state.lang = "en";
    state.role = "viewer";
    html = render();
    expect(html).toContain("Looks like a market report");
    expect(html).not.toContain(">Read it anyway</button>");
    state.role = "owner";
    state.docs = [row("extracted", { read_role: "appraisal (evidence)" })];
    expect(render()).not.toContain(">Read it anyway</button>");
    state.docs = [context({ read_role: "market report (context, set by a person)" })];
    expect(render()).not.toContain(">Read it anyway</button>");
  });

  const banner = "Agir set aside every file it read as background, so no figures came from them.";
  it("replaces the pass banner when every file read was set aside", () => {
    state.overview = { review: { needsReview: 0, conflicting: 0 }, documents: { total: 1, processing: 0, failed: 0 } };
    state.docs = [context()];
    const html = render();
    expect(html).toContain(banner);
    expect(html).toContain("If one of them is about this deal, choose Read it anyway beside it.");
    expect(html).not.toContain("0 values to review");
    expect(html).toMatch(/class="notice review" role="status"/);
    state.lang = "fr";
    expect(plain(render())).toContain("Agir a classé comme contexte tous les fichiers qu'il a lus, donc aucun chiffre n'en vient.");
  });

  it("wins over a pass banner that would otherwise show, and carries the failed line", () => {
    state.overview = { review: { needsReview: 2, conflicting: 0 }, documents: { total: 2, processing: 0, failed: 1 } };
    state.docs = [context(), row("rejected", { id: "bad" })];
    const html = render();
    expect(html).toContain(banner);
    expect(html).not.toContain("to review.");
    expect(html).toContain("1 file could not be used");
  });

  it("counts a person's context as context, but needs at least one decision by Agir", () => {
    state.docs = [context(), row("extracted", { id: "two", read_role: "market report (context, set by a person)" })];
    expect(render()).toContain(banner);
    state.docs = [row("extracted", { read_role: "market report (context, set by a person)" })];
    expect(render()).not.toContain(banner);
    state.docs = [row("extracted", { read_role: "market report (context)", role_set: "context" })];
    expect(render()).not.toContain(banner);
  });

  it("does not show while reading, with another kind of file, or with nothing read", () => {
    state.docs = [context(), row("reading")];
    expect(render()).not.toContain(banner);
    state.docs = [context()];
    state.overview = { updating: true };
    expect(render()).not.toContain(banner);
    state.overview = {};
    state.docs = [context(), row("extracted", { id: "two", read_role: "term sheet (deal source)" })];
    expect(render()).not.toContain(banner);
    state.docs = [row("rejected")];
    expect(render()).not.toContain(banner);
    state.docs = [];
    expect(render()).not.toContain(banner);
  });

  it("tells only an editor to choose Read it anyway", () => {
    state.docs = [context()];
    state.role = "viewer";
    expect(render()).toContain(banner);
    expect(render()).not.toContain("choose Read it anyway");
    state.role = "owner";
    expect(render()).toContain("choose Read it anyway");
  });

  it("keeps the way to Review when values still wait there", () => {
    state.docs = [context()];
    state.overview = { review: { needsReview: 2, conflicting: 1 }, documents: { total: 1, processing: 0, failed: 0 } };
    expect(render()).toContain("Review 3 values");
    state.overview = { review: { needsReview: 0, conflicting: 0 }, documents: { total: 1, processing: 0, failed: 0 } };
    expect(render()).not.toContain("Review 0");
  });

  it("does not claim a set-aside file holds no values", () => {
    state.docs = [context({ candidate_count: 0, used_count: 0 })];
    expect(render()).not.toContain("No underwriting values");
    expect(render()).toContain("Not read for values");
    state.lang = "fr";
    expect(render()).toContain("Non lu pour les valeurs");
    state.lang = "en";
    state.docs = [row("extracted", { read_role: "market report (context)", role_set: "context", candidate_count: 0, used_count: 0 })];
    expect(render()).toContain("Not read for values");
    state.docs = [row("extracted", { read_role: "term sheet (deal source)", candidate_count: 0, used_count: 0 })];
    expect(render()).toContain("No underwriting values");
    expect(render()).not.toContain("Not read for values");
  });
});
