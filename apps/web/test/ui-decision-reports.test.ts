import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { DecisionStep } from "../src/routes/decision.tsx";
import { Reports } from "../src/routes/reports.tsx";
import type { Lang } from "../src/i18n.tsx";

const s = vi.hoisted(() => ({ run: undefined as unknown, lang: "en" as Lang, role: "owner", artifacts: [] as unknown[], links: [] as unknown[],
  interactive: false, hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => {
    const key = o.queryKey[0];
    return key === "run" ? { data: s.run } : key === "artifacts" ? { data: s.artifacts } : key === "share-links" ? { data: s.links } : {};
  },
  useMutation: (o: { mutationFn: (b: any) => Promise<any>; onSuccess?: (d: any) => unknown }) => ({
    mutate: async (b: unknown) => { const d = await o.mutationFn(b); await o.onSuccess?.(d); }, isPending: false, reset: () => {}, error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: s.invalidate }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return { ...ui, DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { run: { id: "run-2", number: 2, fresh: true } } }),
    useSession: () => ({ solo: true, role: s.role }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async () => undefined), post: vi.fn(async () => ({ id: "link", url: "/s/secret", expiresAt: null })) } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const real = react.useState(initial);
    if (!s.interactive) return real;
    const n = s.index++;
    if (!(n in s.hooks)) s.hooks[n] = initial;
    return [s.hooks[n], (v: unknown) => { s.hooks[n] = v; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "a", "form", "input", "textarea"].includes(args[0])) s.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => { s.index = 0; s.nodes = []; return renderToStaticMarkup(el).replaceAll("&#x27;", "'"); };
const run = (over: object = {}) => ({ id: "run-2", number: 2, createdAt: "2026-10-24T15:58:00Z", createdBy: null, engineVersion: "9.8.7", policyVersion: "rental-hold-test",
  policyDraft: true, inputHash: "7f3a91c0aaaabbbbccccddddeeeeffff0000111122223333e2d4", resultHash: "r", signed: "dev", fresh: true, staleReasons: [], isLatest: true,
  inputs: [], decisions: [],
  result: { scenarios: [{ key: "base", label: "Base", metrics: [{ key: "lp_irr", status: "OK", value: 0.1, unit: "pct", label: "", formula: "" }] }],
    verdict: { code: "APPROVE", headline: "", explanation: "", hardFailReasons: [], gates: [] }, checks: [], annual: [], warnings: [] }, ...over });

beforeEach(() => { s.lang = "en"; s.role = "owner"; s.run = run(); s.artifacts = []; s.links = []; s.interactive = false; s.hooks = []; vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the decision screen (card W9)", () => {
  it("offers the three choice cards with their descriptions", () => {
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    expect(html).toContain("What do you decide?");
    for (const text of ["Approve", "Go ahead as the run stands.", "Approve with conditions", "Go ahead once the conditions you name are met.",
      "Reject", "Do not go ahead. Your reasons are recorded."]) expect(html).toContain(text);
    expect(s.nodes.filter((n) => n.tag === "input" && n.props.type === "radio" && n.props.name === "decision").length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('class="choices"');
  });
  it("says decisions are permanent and shows the empty record", () => {
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    expect(html).toContain("Decisions are permanent. A later decision is added, never edited.");
    expect(html).toContain("Your reasoning");
    expect(html).toContain("Recorded decisions");
    expect(html).toContain("Nothing yet.");
  });
  it("shows what a decision binds to from the run", () => {
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    expect(html).toContain("What a decision binds to");
    for (const text of ["9.8.7", "rental-hold-test", "draft, not signed by credit", "7f3a91c0"]) expect(html).toContain(text);
    expect(html).not.toContain("7f3a91c0aaaabbbbccccddddeeeeffff0000111122223333e2d4");
  });
  it("lists a recorded decision with who, conditions and reasoning", () => {
    s.run = run({ decisions: [{ id: "x", decision: "approve_with_conditions", rationale: "Sound enough to proceed.", conditions: "Fixed-price contract first", override_reason: null, created_at: "2026-10-24T16:00:00Z", decided_by: "Pat Owner" }] });
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    for (const text of ["Pat Owner", "Sound enough to proceed.", "Fixed-price contract first"]) expect(html).toContain(text);
    expect(html).not.toContain("Nothing yet.");
  });
  it("a non-decider sees the reason and no form", () => {
    s.role = "analyst";
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    expect(html).toContain("Only a workspace admin or owner records a decision.");
    expect(s.nodes.some((n) => n.tag === "form")).toBe(false);
    expect(html).not.toContain("What do you decide?");
  });
  it("renders in French", () => {
    s.lang = "fr";
    const html = render(createElement(DecisionStep, { dealId: "d" }));
    expect(html).toContain("Les décisions sont permanentes.");
    expect(html).toContain("Approuver sous conditions");
  });
});

describe("the reports screen (card W9)", () => {
  const gen = () => s.nodes.filter((n) => n.tag === "button" && n.props.name === "generate");
  it("has one card per report kind, the audit package included", () => {
    const html = render(createElement(Reports, { dealId: "d" }));
    for (const h of ["Committee memo", "Lender package", "Build decision", "Partner memo", "Model export", "Audit package"]) expect(html).toContain(`<h3 class="h3">${h}</h3>`);
    expect(s.nodes.some((n) => n.tag === "a" && n.props.href === "/api/runs/run-2/audit-package")).toBe(true);
    expect(html).toContain("Everything made so far");
  });
  it("the model export offers only Excel and English", async () => {
    s.lang = "fr";
    render(createElement(Reports, { dealId: "d" }));
    const model = gen().filter((b) => String(b.props.value).startsWith("model_export"));
    expect(model.map((b) => b.props.value)).toEqual(["model_export:xlsx"]);
    await model[0]!.props.onClick();
    const body = vi.mocked(api.post).mock.calls.find(([p]) => p === "/runs/run-2/artifacts")![1] as { kind: string; format: string; lang: string };
    expect(body).toEqual({ kind: "model_export", format: "xlsx", lang: "en" });
    expect(gen().filter((b) => String(b.props.value).startsWith("ic_memo")).map((b) => b.props.value)).toEqual(["ic_memo:pdf", "ic_memo:docx"]);
  });
  it("shows Download, figures traced and the French draft note for a ready report of the current run", () => {
    s.lang = "fr";
    s.artifacts = [{ id: "a1", kind: "build_decision", format: "docx", lang: "fr", status: "ready", error: null, sha256: null, created_at: "2026-10-24T16:12:00Z", run_id: "run-2", run_number: 2, provenance_entries: 23 }];
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(s.nodes.some((n) => n.tag === "a" && n.props.href === "/api/artifacts/a1/file")).toBe(true);
    expect(html).toContain("23 chiffres retracés");
    expect(html).toContain("Français, traduction provisoire");
    expect(gen().some((b) => b.props.value === "build_decision:docx")).toBe(false);
  });
  it("labels files from an older run as out of date", () => {
    s.artifacts = [{ id: "old", kind: "build_decision", format: "pdf", lang: "en", status: "ready", error: null, sha256: null, created_at: "2026-10-22T11:03:00Z", run_id: "run-1", run_number: 1, provenance_entries: null }];
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(html).toContain("Out of date");
  });
  it("offers the four share-link terms as a segmented choice", async () => {
    s.interactive = true;
    vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
    s.artifacts = [{ id: "a1", kind: "lender_package", format: "pdf", lang: "en", status: "ready", error: null, sha256: null, created_at: "2026-10-24T16:12:00Z", run_id: "run-2", run_number: 2, provenance_entries: null }];
    render(createElement(Reports, { dealId: "d" }));
    await s.nodes.find((n) => n.tag === "button" && n.props.children === "Share")!.props.onClick();
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(html).toContain('class="seg"');
    for (const term of ["24 hours", "7 days", "30 days", "No expiry"]) expect(s.nodes.some((n) => n.tag === "button" && n.props.children === term)).toBe(true);
    expect(html).toContain("Make link");
  });
  it("a viewer cannot generate", () => {
    s.role = "viewer";
    render(createElement(Reports, { dealId: "d" }));
    expect(gen().length).toBeGreaterThan(0);
    expect(gen().every((b) => b.props.disabled)).toBe(true);
  });
});
