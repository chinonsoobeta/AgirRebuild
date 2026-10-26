import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card R4: the devices you are signed in on, and the second lines under Runs and Reports made.
// Mocks follow ui-people-2.test.ts.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, role: "owner", setWorkspace: vi.fn(), invalidate: vi.fn(async () => {}),
  members: [] as unknown[], deals: [] as unknown[], metrics: undefined as unknown, sessions: undefined as unknown,
  clients: {} as Record<string, unknown[]>, invites: {} as Record<string, unknown[]>,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
}));
const data = (key: unknown[]) => {
  const [k, id] = key as [string, string];
  return k === "members" ? state.members : k === "deals" ? state.deals : k === "deal-metrics" ? state.metrics : k === "sessions" ? state.sessions
    : k === "deal-clients" ? state.clients[id] ?? [] : k === "invites" ? state.invites[id] ?? [] : undefined;
};
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({ data: data(options.queryKey) }),
  useQueries: (options: { queries: { queryKey: unknown[] }[] }) => options.queries.map((q) => ({ data: data(q.queryKey) })),
  useMutation: (options: { mutationFn: (body: any) => Promise<any>; onSuccess?: (data: any, body: any) => unknown }) => ({
    mutate: async (body: unknown) => { const d = await options.mutationFn(body); await options.onSuccess?.(d, body); },
    isPending: false, reset: () => {}, error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  return {
    ...ui,
    useSession: () => ({
      solo: true, role: state.role, workspaceId: "ws", setWorkspace: state.setWorkspace,
      me: { user: { id: "me", name: "Morgan Owner", email: "morgan@example.test" }, workspaces: [
        { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, ai_reading: true, has_logo: false, role: state.role },
      ] },
    }),
  };
});
vi.mock("../src/theme", async (original) => {
  const theme = await original<typeof import("../src/theme")>();
  return { ...theme, useTheme: () => ({ pref: "light", theme: "light", setPref: () => {} }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => createElement("a", { href: to, className }, children as string) };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async () => []),
    post: vi.fn(async (path: string) => path === "/me/sessions/end-others" ? { ended: 1 } : { ok: true }),
    del: vi.fn(async () => ({ ok: true })), upload: vi.fn(async () => ({})) } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = typeof value === "function" ? (value as (v: unknown) => unknown)(state.hooks[n]) : value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "input", "a", "form", "select"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (C: () => unknown = Settings) => { state.index = 0; state.nodes = []; return renderToStaticMarkup(createElement(C as any)); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (n: { props: Record<string, any> }): string => { const c = n.props.children; return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : ""; };
const buttons = (name: string) => state.nodes.filter((n) => n.tag === "button" && label(n) === name);
const section = (html: string, id: string) => { const s = html.slice(html.indexOf(`id="${id}"`)); return s.slice(0, s.indexOf("</section>")); };

const deal = (id: string, name: string) => ({ deal: { id, workspace_id: "ws", name }, run: { number: 9 }, reports: 9, documents: { total: 0, processing: 0, failed: 0 } });
const totals = (over: Record<string, unknown> = {}) => ({ deals: 1, docs_no_candidates: 0, archived_deals: 0, runs: 0, first_run_at: null, reports: 0, reports_shared: 0, ...over });
const fig = (html: string, k: string) => section(html, "counts").match(new RegExp(`<dt class="k">${k}</dt><dd class="v">([^<]+)</dd>(?:<dd class="s">([^<]+)</dd>)?`));
// A day in another year, so the short date carries its year whatever today is.
const PAST = "2025-10-22T12:00:00Z";
const short = (lang: string) => new Date(PAST).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", year: "numeric" });
const since = (iso: string, lang: string) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric", year: "numeric" });
const NOW = new Date().toISOString();

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.hooks = []; state.members = []; state.deals = []; state.metrics = undefined; state.sessions = undefined;
  state.clients = {}; state.invites = {};
  state.setWorkspace.mockClear(); state.invalidate.mockClear(); vi.mocked(api.post).mockClear(); vi.mocked(api.del).mockClear();
  vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("where you are signed in", () => {
  it("names this device when it is the only one, with no sign-out button", () => {
    state.sessions = { count: 1, devices: [{ device: "Mac", signedInAt: NOW, current: true }] };
    const account = text(section(render(), "account"));
    expect(account).toContain("Where you are signed in");
    expect(account).toContain("This Mac");
    expect(buttons("Sign out everywhere else")).toHaveLength(0);
  });

  it("lists this device first, then each other one with the day it signed in, and keeps Sign out everywhere else", async () => {
    state.sessions = { count: 2, devices: [{ device: "Mac", signedInAt: NOW, current: true }, { device: "iPhone", signedInAt: PAST, current: false }] };
    const account = text(section(render(), "account"));
    expect(account).toContain(`This Mac An iPhone, signed in ${short("en")}`);
    const out = buttons("Sign out everywhere else");
    expect(out).toHaveLength(1);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await out[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/me/sessions/end-others")).toBe(false);
    await out[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/me/sessions/end-others")).toBe(true);
  });

  it("says this browser, and a device we could not identify, when the label is unknown", () => {
    state.sessions = { count: 2, devices: [{ device: null, signedInAt: NOW, current: true }, { device: null, signedInAt: PAST, current: false }] };
    const account = text(section(render(), "account"));
    expect(account).toContain(`This browser A device we could not identify, signed in ${short("en")}`);
  });

  it("names each kind of device", () => {
    const kinds = ["Mac", "iPhone", "iPad", "Android phone", "Android tablet", "Windows PC", "Linux computer", "Chromebook"];
    state.sessions = { count: kinds.length + 1, devices: [{ device: "Windows PC", signedInAt: NOW, current: true },
      ...kinds.map((device) => ({ device, signedInAt: PAST, current: false }))] };
    const account = text(section(render(), "account"));
    expect(account).toContain("This Windows PC");
    for (const s of ["A Mac", "An iPhone", "An iPad", "An Android phone", "An Android tablet", "A Windows PC", "A Linux computer", "A Chromebook"]) expect(account).toContain(`${s}, signed in`);
  });

  it("is in French", () => {
    state.lang = "fr";
    state.sessions = { count: 3, devices: [{ device: "Mac", signedInAt: NOW, current: true }, { device: "Windows PC", signedInAt: PAST, current: false },
      { device: null, signedInAt: PAST, current: false }] };
    const account = text(section(render(), "account"));
    expect(account).toContain("Ce Mac");
    expect(account).toContain(`Un ordinateur Windows, connexion le ${short("fr")}`);
    expect(account).toContain(`Un appareil que nous n'avons pas pu identifier, connexion le ${short("fr")}`);
    state.sessions = { count: 2, devices: [{ device: null, signedInAt: NOW, current: true }, { device: "Android phone", signedInAt: PAST, current: false }] };
    const other = text(section(render(), "account"));
    expect(other).toContain("Ce navigateur");
    expect(other).toContain(`Un téléphone Android, connexion le ${short("fr")}`);
  });
});

describe("the counts' second lines", () => {
  it("takes Runs and Reports made from the server, with when runs began and how many files were shared", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.metrics = { deals: [], totals: totals({ runs: 14, first_run_at: "2026-10-01T15:00:00Z", reports: 9, reports_shared: 3 }) };
    const html = render();
    expect(fig(html, "Runs")?.slice(1)).toEqual(["14", `since ${since("2026-10-01T15:00:00Z", "en")}`]);
    expect(fig(html, "Reports made")?.slice(1)).toEqual(["9", "3 shared by link"]);
  });

  it("has no second line when there are no runs or nothing was shared", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.metrics = { deals: [], totals: totals({ runs: 0, first_run_at: null, reports: 2, reports_shared: 0 }) };
    const html = render();
    expect(fig(html, "Runs")?.slice(1)).toEqual(["0", undefined]);
    expect(fig(html, "Reports made")?.slice(1)).toEqual(["2", undefined]);
  });

  it("does not add up the deals list while the counts have not answered", () => {
    state.deals = [deal("d1", "Larch Court")];
    const html = render();
    expect(fig(html, "Runs")?.[1]).not.toBe("9");
    expect(fig(html, "Reports made")?.[1]).not.toBe("9");
  });

  it("is in French", () => {
    state.lang = "fr";
    state.deals = [deal("d1", "Larch Court")];
    state.metrics = { deals: [], totals: totals({ runs: 4, first_run_at: "2026-10-01T15:00:00Z", reports: 3, reports_shared: 1 }) };
    const html = render();
    expect(fig(html, "Analyses")?.slice(1)).toEqual(["4", `depuis le ${since("2026-10-01T15:00:00Z", "fr")}`]);
    expect(fig(html, "Rapports produits")?.slice(1)).toEqual(["3", "1 partagé par lien"]);
  });
});
