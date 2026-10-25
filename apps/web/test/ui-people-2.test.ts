import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import { ReviewAccess } from "../src/routes/review-access.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card Z1: the workspace name, removing someone, your name, signed-in devices, archived deals,
// what each client confirmed, and ending a reviewer's access. Mocks follow ui-settings-2.test.ts.
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
        { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, has_logo: false, role: state.role },
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
const form = (name: string) => state.nodes.find((n) => n.tag === "form" && n.props["aria-label"] === name);
const submit = (f: { props: Record<string, any> }, value: string) =>
  f.props.onSubmit({ preventDefault() {}, currentTarget: { reset() {}, elements: { namedItem: () => ({ value }) } } });

const member = (id: string, name: string, role: string, expires_at: string | null = null) => ({ id, name, email: `${id}@example.test`, role, expires_at });
const everyone = () => [member("me", "Morgan Owner", "owner"), member("o2", "Olive Owner", "owner"), member("a", "Ada Admin", "admin"), member("n", "Ana Analyst", "analyst"),
  member("v", "Vic Viewer", "viewer"), member("r", "Riley Reviewer", "reviewer", "2099-06-15T12:00:00Z"), member("c", "Cleo Client", "client")];
const deal = (id: string, name: string) => ({ deal: { id, workspace_id: "ws", name }, run: null, reports: 0, documents: { total: 0, processing: 0, failed: 0 } });
const client = (over: Record<string, unknown> = {}) => ({ id: "u-priya", name: "Priya Nair", email: "priya@example.test", assigned_at: "2026-10-18T12:00:00Z",
  confirmed: 0, last_confirmed_at: null, ...over });

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.hooks = []; state.members = []; state.deals = []; state.metrics = undefined; state.sessions = undefined;
  state.clients = {}; state.invites = {};
  state.setWorkspace.mockClear(); state.invalidate.mockClear(); vi.mocked(api.post).mockClear(); vi.mocked(api.del).mockClear();
  vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("the workspace name", () => {
  it("is a field with Save for the owner, and the owner's Save posts the name route", async () => {
    render();
    const name = state.nodes.find((n) => n.tag === "input" && n.props.id === "ws-name")!;
    expect(name.props.defaultValue).toBe("Elm Street");
    expect(buttons("Save").length).toBeGreaterThan(0);
    await submit(form("Workspace name")!, "Harbour Capital");
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/name", { name: "Harbour Capital" }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
  });

  it("is plain text for a viewer", () => {
    state.role = "viewer";
    const html = render();
    expect(state.nodes.some((n) => n.tag === "input" && n.props.id === "ws-name")).toBe(false);
    expect(form("Workspace name")).toBeUndefined();
    expect(text(section(html, "workspace"))).toContain("Elm Street");
  });
});

describe("removing someone from the workspace", () => {
  const removes = () => state.nodes.filter((n) => n.tag === "button" && label(n) === "Remove" && String(n.props["aria-label"] ?? "").endsWith("from this workspace"));

  it("is offered on admin, analyst and viewer rows, never on the owner's, your own, a reviewer's or a client's", () => {
    state.members = everyone();
    render();
    expect(removes().map((b) => b.props["aria-label"])).toEqual(["Remove Ada Admin from this workspace", "Remove Ana Analyst from this workspace", "Remove Vic Viewer from this workspace"]);
  });

  it("is offered to an admin too, but not to an analyst", () => {
    state.role = "admin";
    state.members = [member("me", "Morgan Admin", "admin"), member("n", "Ana Analyst", "analyst")];
    render();
    expect(removes().map((b) => b.props["aria-label"])).toEqual(["Remove Ana Analyst from this workspace"]);
    state.role = "analyst";
    render();
    expect(removes()).toHaveLength(0);
  });

  it("asks first, in a sentence, then removes them and refreshes the list", async () => {
    state.members = everyone();
    render();
    const ana = removes().find((b) => b.props["aria-label"] === "Remove Ana Analyst from this workspace")!;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await ana.props.onClick();
    expect(vi.mocked(api.del)).not.toHaveBeenCalled();
    await ana.props.onClick();
    const asked = String(vi.mocked(window.confirm).mock.calls[0]![0]);
    expect(asked).toContain("Ana Analyst");
    expect(asked).toMatch(/every deal/);
    expect(asked).toMatch(/audit trail/);
    expect(vi.mocked(api.del).mock.calls).toContainEqual(["/workspaces/ws/members/n", {}]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["members"] });
  });
});

describe("your account", () => {
  it("has a name field with Save, keeps the email as text, and saves the name", async () => {
    const html = render();
    const name = state.nodes.find((n) => n.tag === "input" && n.props.id === "ac-name")!;
    expect(name.props.defaultValue).toBe("Morgan Owner");
    expect(text(section(html, "account"))).toContain("morgan@example.test");
    await submit(form("Your name")!, "Morgan Lee");
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/me/name", { name: "Morgan Lee" }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
  });

  it("says how many browsers or devices you are signed in on, and signs out the others", async () => {
    state.sessions = { count: 2 };
    let account = text(section(render(), "account"));
    expect(account).toContain("You are signed in on 2 browsers or devices, this one included.");
    const out = buttons("Sign out everywhere else");
    expect(out).toHaveLength(1);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await out[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/me/sessions/end-others")).toBe(false);
    await out[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/me/sessions/end-others")).toBe(true);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["sessions"] });
    state.sessions = { count: 1 };
    account = text(section(render(), "account"));
    expect(account).toContain("Signed out on 1 other browser or device.");
  });

  it("hides the button when this is the only one", () => {
    state.sessions = { count: 1 };
    const account = text(section(render(), "account"));
    expect(account).toContain("You are signed in on this browser only.");
    expect(buttons("Sign out everywhere else")).toHaveLength(0);
  });

  it("is in French", () => {
    state.lang = "fr";
    state.sessions = { count: 3 };
    expect(text(section(render(), "account"))).toContain("Vous êtes connecté sur 3 navigateurs ou appareils, y compris celui-ci.");
  });
});

describe("archived deals in the counts", () => {
  const dealsFig = (html: string) => section(html, "counts").match(/<dt class="k">Deals<\/dt><dd class="v">([^<]+)<\/dd>(?:<dd class="s">([^<]+)<\/dd>)?/);

  it("adds a line under the deals figure when some are archived", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.metrics = { deals: [], totals: { deals: 1, docs_no_candidates: 0, archived_deals: 2 } };
    expect(dealsFig(render())?.[2]).toBe("Not counting 2 archived");
  });

  it("has no line when none are archived or the counts have not answered", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.metrics = { deals: [], totals: { deals: 1, docs_no_candidates: 0, archived_deals: 0 } };
    expect(dealsFig(render())?.[2]).toBeUndefined();
    state.metrics = undefined;
    expect(dealsFig(render())?.[2]).toBeUndefined();
  });
});

describe("what each client confirmed", () => {
  const row = (html: string) => {
    const clients = section(html, "clients");
    return text([...clients.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!).find((r) => r.includes("Priya Nair"))!);
  };

  it("shows how many values the client confirmed and when, then Remove", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.clients = { d1: [client({ confirmed: 6, last_confirmed_at: "2026-10-18T12:00:00Z" })] };
    expect(row(render())).toMatch(/Confirmed 6 values · .*18.* Remove$/);
    state.clients = { d1: [client({ confirmed: 1, last_confirmed_at: "2026-10-18T12:00:00Z" })] };
    expect(row(render())).toMatch(/Confirmed 1 value · /);
  });

  it("says when they joined and that nothing is confirmed yet", () => {
    state.deals = [deal("d1", "Larch Court")];
    state.clients = { d1: [client()] };
    const r = row(render());
    expect(r).toMatch(/Client since Oct(ober)? 18, 2026, nothing confirmed yet Remove$/);
    expect(r).not.toMatch(/Confirmed \d/);
  });
});

describe("ending a reviewer's access", () => {
  beforeEach(() => {
    // Three days left, so Extend is offered too (it is shown only when a length would end access later).
    state.members = [member("r1", "Riley Reviewer", "reviewer", new Date(Date.now() + 3 * 86_400_000).toISOString()), member("r2", "Pat Past", "reviewer", "2001-06-15T12:00:00Z")];
  });
  const of = (name: string, id: string) => state.nodes.filter((n) => n.tag === "button" && label(n) === name && n.props.value === id);

  it("offers End access now beside Extend on an active reviewer's row, and posts the end route after asking", async () => {
    render(ReviewAccess);
    expect(of("Extend", "r1")).toHaveLength(1);
    const end = of("End access now", "r1");
    expect(end).toHaveLength(1);
    expect(end[0]!.props["aria-label"]).toBe("End Riley Reviewer's access now");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await end[0]!.props.onClick();
    expect(vi.mocked(api.post)).not.toHaveBeenCalled();
    await end[0]!.props.onClick();
    const asked = String(vi.mocked(window.confirm).mock.calls[0]![0]);
    expect(asked).toMatch(/no longer open/);
    expect(asked).toMatch(/confirmed stays/);
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/review-grant/r1/end", {}]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["members"] });
  });

  it("offers neither on an ended reviewer's row", () => {
    render(ReviewAccess);
    expect(of("Extend", "r2")).toHaveLength(0);
    expect(of("End access now", "r2")).toHaveLength(0);
  });
});
