import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Reports } from "../src/routes/reports.tsx";
import { Deals } from "../src/routes/deals.tsx";
import { ReviewAccess } from "../src/routes/review-access.tsx";
import type { Lang } from "../src/i18n.tsx";

const s = vi.hoisted(() => ({ run: undefined as unknown, lang: "en" as Lang, role: "owner", artifacts: [] as unknown[], links: [] as unknown[], members: [] as unknown[],
  interactive: false, hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => {
    const key = o.queryKey[0];
    return key === "run" ? { data: s.run } : key === "artifacts" ? { data: s.artifacts } : key === "share-links" ? { data: s.links }
      : key === "members" ? { data: s.members } : key === "deals" ? { data: [], isLoading: false } : {};
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
    useSession: () => ({ me: { user: { id: "u1", email: "a@b.c", name: "Pat Owner" }, workspaces: [] }, workspaceId: "ws", solo: true, role: s.role }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, hash, children, className }: { to: string; hash?: string; children: unknown; className?: string }) =>
    createElement("a", { href: to + (hash ? `#${hash}` : ""), className }, children as string) };
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
    if (typeof args[0] === "string" && ["button", "a", "select", "option", "section"].includes(args[0])) s.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => { s.index = 0; s.nodes = []; return renderToStaticMarkup(el).replaceAll("&#x27;", "'"); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (n: { props: Record<string, any> }): string => {
  const c = n.props.children;
  return (Array.isArray(c) ? c : [c]).filter((x) => typeof x === "string").join("");
};
const run = { id: "run-2", number: 2, createdAt: "2026-10-24T15:58:00Z", fresh: true, inputs: [], decisions: [],
  result: { scenarios: [{ key: "base", label: "Base", metrics: [] }], verdict: { code: "APPROVE" }, checks: [], annual: [], warnings: [] } };
const art = (over: object) => ({ id: "a1", kind: "lender_package", format: "pdf", lang: "en", status: "ready", error: null, sha256: null,
  created_at: "2026-10-24T16:12:00Z", run_id: "run-2", run_number: 2, provenance_entries: 118, ...over });

beforeEach(() => { s.lang = "en"; s.role = "owner"; s.run = run; s.artifacts = []; s.links = []; s.members = []; s.interactive = false; s.hooks = []; vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("reports in the other language (card X5)", () => {
  const other = () => s.nodes.filter((n) => n.tag === "button" && n.props.name === "generate-other");
  it("a ready English lender package offers the French draft, which posts lang fr", async () => {
    s.artifacts = [art({})];
    const html = render(createElement(Reports, { dealId: "d" }));
    const lender = other().filter((b) => String(b.props.value).startsWith("lender_package:"));
    expect(lender.length).toBeGreaterThan(0);
    expect(label(lender[0]!)).toContain("French, draft translation");
    await lender[0]!.props.onClick();
    const body = vi.mocked(api.post).mock.calls.find(([p]) => p === "/runs/run-2/artifacts")![1] as { lang: string; kind: string };
    expect(body.kind).toBe("lender_package");
    expect(body.lang).toBe("fr");
    expect(other().some((b) => String(b.props.value).startsWith("model_export"))).toBe(false);
    expect(html).toContain("French, draft translation");
  });
  it("a ready French file downloads from the second action, with Make again for an editor", () => {
    s.artifacts = [art({}), art({ id: "f1", lang: "fr" })];
    render(createElement(Reports, { dealId: "d" }));
    expect(s.nodes.some((n) => n.tag === "a" && n.props.href === "/api/artifacts/f1/file")).toBe(true);
    expect(s.nodes.some((n) => n.tag === "button" && n.props.name === "regenerate-other" && n.props.value === "lender_package:pdf:fr")).toBe(true);
    expect(other().some((b) => String(b.props.value).startsWith("lender_package:pdf"))).toBe(false);
  });
  it("on a French screen the second action makes the English version", async () => {
    s.lang = "fr";
    render(createElement(Reports, { dealId: "d" }));
    const memo = other().find((b) => String(b.props.value).startsWith("ic_memo:"))!;
    await memo.props.onClick();
    const body = vi.mocked(api.post).mock.calls.find(([p]) => p === "/runs/run-2/artifacts")![1] as { lang: string };
    expect(body.lang).toBe("en");
  });
});

describe("sharing in the open (card X5)", () => {
  it("shows the Shared links section and its file picker before any link exists", () => {
    s.artifacts = [art({}), art({ id: "a0", kind: "build_decision", format: "docx", created_at: "2026-10-24T15:00:00Z", provenance_entries: 23 })];
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(html).toContain("Shared links");
    expect(s.nodes.some((n) => n.tag === "select")).toBe(true);
    const opts = s.nodes.filter((n) => n.tag === "option");
    expect(opts.map((o) => o.props.value)).toEqual(["a1", "a0"]);
    expect(html).toContain("Make link");
    expect(s.nodes.some((n) => n.tag === "button" && label(n) === "Make a shareable link")).toBe(true);
  });
  it("Share on a row preselects that file", async () => {
    s.interactive = true;
    vi.stubGlobal("window", { location: { origin: "https://agir.test" } });
    vi.stubGlobal("document", { getElementById: () => null });
    s.artifacts = [art({}), art({ id: "a0", kind: "build_decision", format: "docx", created_at: "2026-10-24T15:00:00Z" })];
    render(createElement(Reports, { dealId: "d" }));
    await s.nodes.filter((n) => n.tag === "button" && n.props.children === "Share")[1]!.props.onClick();
    render(createElement(Reports, { dealId: "d" }));
    expect(s.nodes.find((n) => n.tag === "select")!.props.value).toBe("a0");
    await s.nodes.find((n) => n.tag === "button" && n.props.children === "Make link")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/artifacts/a0/share-links", { term: "7d" }]);
  });
  it("says a link needs a report first when no file is ready", () => {
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(html).toContain("Shared links");
    expect(text(html)).toContain("A link needs a report first.");
    expect(s.nodes.some((n) => n.tag === "select")).toBe(false);
  });
  it("a client sees neither the button nor the section", () => {
    s.role = "client";
    s.artifacts = [art({})];
    const html = render(createElement(Reports, { dealId: "d" }));
    expect(html).not.toContain("Shared links");
    expect(html).not.toContain("Make a shareable link");
  });
});

describe("the first visit (card X5)", () => {
  it("links to how data is handled", () => {
    const html = render(createElement(Deals));
    expect(html).toMatch(/<a href="\/legal#privacy">How your data is handled<\/a>/);
  });
});

describe("extending reviewer access (card X5)", () => {
  it("an active reviewer row has Extend, which posts the grant with that email", async () => {
    s.interactive = true;
    s.members = [
      { id: "r1", name: "Riley Reviewer", email: "riley@example.test", role: "reviewer", expires_at: "2099-06-15T12:00:00Z" },
      { id: "r2", name: "Old Reviewer", email: "old@example.test", role: "reviewer", expires_at: "2020-01-01T12:00:00Z" },
    ];
    render(createElement(ReviewAccess));
    const ext = s.nodes.filter((n) => n.tag === "button" && n.props.name === "extend");
    expect(ext.map((b) => b.props.value)).toEqual(["r1"]);
    await ext[0]!.props.onClick();
    render(createElement(ReviewAccess));
    // The grant form has its own day choice; the reviewer's row comes after it.
    s.nodes.filter((n) => n.tag === "button" && n.props.children === "30 days").at(-1)!.props.onClick();
    render(createElement(ReviewAccess));
    await s.nodes.find((n) => n.tag === "button" && n.props.name === "extend-confirm")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/review-grant", { email: "riley@example.test", days: 30 }]);
    expect(text(render(createElement(ReviewAccess)))).toMatch(/Riley.*now ends on/);
  });
});
