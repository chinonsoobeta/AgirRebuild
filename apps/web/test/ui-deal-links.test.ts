import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type ShareLink, type SharedReport } from "../src/api";
import { Reports } from "../src/routes/reports.tsx";
import { Share, SharePreview } from "../src/routes/share.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card R2: a link shares a run's files together, and its maker can preview the page it opens.
const s = vi.hoisted(() => ({ run: undefined as unknown, lang: "en" as Lang, role: "owner", artifacts: [] as unknown[], links: [] as unknown[],
  shared: undefined as unknown, preview: undefined as unknown,
  interactive: false, hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => {
    const key = o.queryKey[0];
    return key === "run" ? { data: s.run } : key === "artifacts" ? { data: s.artifacts } : key === "share-links" ? { data: s.links }
      : key === "share" ? { data: s.shared, error: null } : key === "share-preview" ? { data: s.preview, error: null } : {};
  },
  useMutation: (o: { mutationFn: (b: any) => Promise<any>; onSuccess?: (d: any, b: any) => unknown }) => ({
    mutate: async (b: unknown) => { const d = await o.mutationFn(b); await o.onSuccess?.(d, b); }, isPending: false, reset: () => {}, error: null,
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
  return { Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) =>
    createElement("a", { href: Object.entries(params ?? {}).reduce((h, [k, v]) => h.replace(`$${k}`, v), to), className }, children as string) };
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
    if (!(n in s.hooks)) s.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [s.hooks[n], (v: unknown) => { s.hooks[n] = typeof v === "function" ? (v as (x: unknown) => unknown)(s.hooks[n]) : v; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "a", "input", "section"].includes(args[0])) s.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => { s.index = 0; s.nodes = []; return renderToStaticMarkup(el).replaceAll("&#x27;", "'"); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (n: { props: Record<string, any> }): string => {
  const c = n.props.children;
  return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === "string").join("");
};
const links = (pred: (href: string) => boolean) => s.nodes.filter((n) => n.tag === "a" && pred(String(n.props.href)));
const art = (over: object) => ({ id: "a1", kind: "lender_package", format: "pdf", lang: "en", status: "ready", error: null, sha256: null,
  created_at: "2026-10-24T16:12:00Z", run_id: "run-2", run_number: 2, provenance_entries: 118, ...over });
const shareLink = (over: Partial<ShareLink>): ShareLink => ({ id: "l1", artifact_id: null, run_id: "run-2", kind: "build_decision", format: "docx", run_number: 2, term: "7d",
  expires_at: "2099-10-31T16:12:00Z", created_at: "2026-10-24T16:12:00Z", created_by: "Pat Owner", revoked_at: null, revoked_by: null, openings: 3,
  last_opened_at: "2026-10-24T17:40:00Z", files: [{ kind: "build_decision", format: "docx", lang: "en" }, { kind: "lender_package", format: "pdf", lang: "en" }], ...over });
const page: SharedReport = {
  deal: "Shared reference", kind: "build_decision", format: "docx", runNumber: 2, expiresAt: "2099-10-31T16:12:00Z",
  files: [
    { id: "f1", kind: "build_decision", format: "docx", lang: "en", traced: 23 },
    { id: "f2", kind: "build_decision", format: "docx", lang: "fr", traced: 23 },
    { id: "f3", kind: "lender_package", format: "pdf", lang: "en", traced: 118 },
    { id: "f4", kind: "model_export", format: "xlsx", lang: "en", traced: null },
  ],
};

beforeEach(() => {
  Object.assign(s, { lang: "en", role: "owner", run: undefined, artifacts: [], links: [], shared: undefined, preview: undefined, interactive: false, hooks: [] });
  vi.clearAllMocks();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the shared page with several files", () => {
  it("lists each file with its format, figures traced and the French draft label, and opens only PDFs inline", () => {
    s.shared = page;
    const words = text(render(createElement(Share, { secret: "sec" })));
    expect(words).toContain("Files 4 files");
    expect(words).toContain("Build decision Word · 23 figures traced");
    expect(words).toContain("Build decision Word · French, draft translation · 23 figures traced");
    expect(words).toContain("Lender package PDF · 118 figures traced");
    expect(words).toContain("Model export Excel");
    expect(words).not.toContain("0 figures traced");
    for (const id of ["f1", "f2", "f3", "f4"]) expect(links((h) => h === `/api/share/sec/file?artifact=${id}`).length).toBe(1);
    expect(links((h) => h.includes("inline=1")).map((n) => n.props.href)).toEqual(["/api/share/sec/file?artifact=f3&inline=1"]);
    expect(links((h) => h === "/api/share/sec/audit-package").length).toBe(1);
    expect(words).toContain("Download the audit package");
    expect(words).toContain("This link expires on");
  });
  it("one file says 1 file", () => {
    s.shared = { ...page, files: [page.files![2]!] };
    expect(text(render(createElement(Share, { secret: "sec" })))).toContain("Files 1 file");
  });
  it("in French", () => {
    s.lang = "fr";
    s.shared = page;
    const words = text(render(createElement(Share, { secret: "sec" })));
    expect(words).toContain("Fichiers 4 fichiers");
    expect(words).toContain("Français, traduction provisoire");
    expect(words).toContain("23 chiffres retracés");
  });
});

describe("the preview", () => {
  it("says it is not counted, shows the page and serves files from the signed-in routes", () => {
    s.preview = page;
    s.links = [shareLink({ id: "l1", run_id: "run-2" })];
    const words = text(render(createElement(SharePreview, { dealId: "d", linkId: "l1" })));
    expect(words).toContain("This is what the person you share with sees. Opening it here is not counted.");
    expect(words).toContain("Shared reference");
    expect(words).toContain("Files 4 files");
    expect(links((h) => h === "/api/artifacts/f1/file").length).toBe(1);
    expect(links((h) => h === "/api/artifacts/f3/file?inline=1").length).toBe(1);
    expect(links((h) => h === "/api/runs/run-2/audit-package").length).toBe(1);
    expect(links((h) => h.includes("/api/share/")).length).toBe(0);
    expect(links((h) => h === "/deals/d/reports").map(label)).toEqual(["Back to Reports"]);
  });
  it("in French", () => {
    s.lang = "fr";
    s.preview = page;
    s.links = [shareLink({})];
    const words = text(render(createElement(SharePreview, { dealId: "d", linkId: "l1" })));
    expect(words).toContain("Voici ce que voit la personne avec qui vous partagez. L'ouvrir ici n'est pas compté.");
    expect(links((h) => h === "/deals/d/reports").map(label)).toEqual(["Retour aux rapports"]);
  });
});

describe("Reports, shared links", () => {
  const boxes = () => s.nodes.filter((n) => n.tag === "input" && n.props.type === "checkbox");
  it("offers a ticked checkbox for each ready file of the current run, and makes a link with the ticked ones", async () => {
    s.interactive = true;
    vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
    s.artifacts = [
      art({ id: "lp" }),
      art({ id: "bd", kind: "build_decision", format: "docx" }),
      art({ id: "bdfr", kind: "build_decision", format: "docx", lang: "fr" }),
      art({ id: "queued", kind: "ic_memo", format: "pdf", status: "queued" }),
      art({ id: "old", kind: "ic_memo", format: "pdf", run_id: "run-1", run_number: 1 }),
    ];
    const html = render(createElement(Reports, { dealId: "d" }));
    const words = text(html);
    expect(words).toContain("A link opens a read-only page with the files you choose and the audit package. No account needed. Each opening is counted.");
    expect(words).toContain("What to share");
    expect(words).toContain("How long should it work?");
    expect(boxes().map((b) => b.props.value)).toEqual(["bd", "bdfr", "lp"]);
    expect(boxes().every((b) => b.props.checked === true)).toBe(true);
    expect(words).toContain("Build decision · Word · French, draft translation");
    expect(s.nodes.some((n) => n.tag === "button" && n.props.children === "Share")).toBe(false);
    boxes().find((b) => b.props.value === "bdfr")!.props.onChange({ target: { checked: false } });
    render(createElement(Reports, { dealId: "d" }));
    expect(boxes().find((b) => b.props.value === "bdfr")!.props.checked).toBe(false);
    await s.nodes.find((n) => n.tag === "button" && n.props.children === "Make link")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/runs/run-2/share-links", { term: "7d", artifacts: ["bd", "lp"] }]);
    const made = text(render(createElement(Reports, { dealId: "d" })));
    expect(made).toContain("Copy this link now. It is not shown again.");
    expect(s.nodes.find((n) => n.tag === "input" && n.props.readOnly)!.props.value).toBe("https://agir.test/s/secret");
  });
  it("cannot make a link with nothing ticked", () => {
    s.interactive = true;
    s.artifacts = [art({ id: "lp" })];
    render(createElement(Reports, { dealId: "d" }));
    boxes()[0]!.props.onChange({ target: { checked: false } });
    render(createElement(Reports, { dealId: "d" }));
    expect(s.nodes.find((n) => n.tag === "button" && n.props.children === "Make link")!.props.disabled).toBe(true);
  });
  it("asks for a report first when the current run has no ready file", () => {
    s.artifacts = [art({ id: "old", run_id: "run-1", run_number: 1 })];
    const words = text(render(createElement(Reports, { dealId: "d" })));
    expect(words).toContain("Make a report first, then share it.");
    expect(boxes().length).toBe(0);
    expect(s.nodes.some((n) => n.tag === "button" && n.props.children === "Make link")).toBe(false);
  });
  it("lists each link's run and files, with Preview for active links only", () => {
    s.artifacts = [art({ id: "lp" })];
    s.links = [shareLink({ id: "active" }), shareLink({ id: "gone", revoked_at: "2026-10-24T18:00:00Z", revoked_by: "Pat Owner" }),
      shareLink({ id: "fr", expires_at: "2000-01-01T00:00:00Z", files: [{ kind: "build_decision", format: "docx", lang: "fr" }] })];
    const html = render(createElement(Reports, { dealId: "d" }));
    const head = (html.match(/<thead>([\s\S]*?)<\/thead>/g) ?? []).map(text).find((h) => h.includes("Made by"))!;
    expect(head).toBe("Made by Made on Run Files Expires Openings Last opened Status Preview Revoke");
    const words = text(html);
    expect(words).toContain("Build decision (Word), Lender package (PDF)");
    expect(words).toContain("Build decision (Word, French)");
    expect(links((h) => h.startsWith("/deals/d/reports/preview/")).map((n) => [n.props.href, label(n)])).toEqual([["/deals/d/reports/preview/active", "Preview"]]);
    expect(s.nodes.filter((n) => n.tag === "button" && n.props.children === "Revoke").length).toBe(1);
  });
  it("in French", () => {
    s.lang = "fr";
    s.artifacts = [art({ id: "lp" })];
    s.links = [shareLink({ id: "active" })];
    const words = text(render(createElement(Reports, { dealId: "d" })));
    expect(words).toContain("Un lien ouvre une page en lecture seule avec les fichiers choisis et le dossier d'audit.");
    expect(words).toContain("Ce que vous partagez");
    expect(words).toContain("Décision de construire (Word), Dossier pour le prêteur (PDF)");
    expect(links((h) => h.startsWith("/deals/d/reports/preview/")).map(label)).toEqual(["Aperçu"]);
  });
  it("a French screen with no ready file asks for a report first", () => {
    s.lang = "fr";
    expect(text(render(createElement(Reports, { dealId: "d" })))).toContain("Produisez d'abord un rapport, puis partagez-le.");
  });
});
