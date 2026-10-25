import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card X2: a new workspace switches to it, roles change in the People table, clients across every deal,
// and the owner's plain counts. Mocks follow apps/web/test/ui-settings.test.ts and clients.test.ts.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, role: "owner", setWorkspace: vi.fn(), invalidate: vi.fn(async () => {}),
  members: [] as unknown[], deals: [] as unknown[], metrics: undefined as unknown,
  clients: {} as Record<string, unknown[]>, invites: {} as Record<string, unknown[]>,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
}));
const data = (key: unknown[]) => {
  const [k, id] = key as [string, string];
  return k === "members" ? state.members : k === "deals" ? state.deals : k === "deal-metrics" ? state.metrics
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
    post: vi.fn(async (path: string) => path === "/workspaces" ? { id: "ws-new" } : path.endsWith("/invites") ? { id: "inv", url: "/i/secret" } : { ok: true }),
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

const render = () => { state.index = 0; state.nodes = []; return renderToStaticMarkup(createElement(Settings)); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (n: { props: Record<string, any> }): string => { const c = n.props.children; return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : ""; };
const buttons = (name: string) => state.nodes.filter((n) => n.tag === "button" && label(n) === name);
const roleSelects = () => state.nodes.filter((n) => n.tag === "select" && String(n.props["aria-label"] ?? "").startsWith("Role of "));
const section = (html: string, id: string) => { const s = html.slice(html.indexOf(`id="${id}"`)); return s.slice(0, s.indexOf("</section>")); };

const member = (id: string, name: string, role: string) => ({ id, name, email: `${id}@example.test`, role, expires_at: null });
const deal = (id: string, name: string, run: number | null, reports: number, documents: number) => ({
  deal: { id, workspace_id: "ws", name }, run: run === null ? null : { id: `run-${id}`, number: run }, reports, documents: { total: documents, processing: 0, failed: 0 },
});
const invite = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: "2026-10-22T12:00:00Z", expires_at: "2099-11-05T12:00:00Z", created_by: "Alice Admin",
  used_at: null, used_by: null, revoked_at: null, revoked_by: null, ...over });

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.hooks = []; state.members = []; state.deals = []; state.metrics = undefined; state.clients = {}; state.invites = {};
  state.setWorkspace.mockClear(); state.invalidate.mockClear(); vi.mocked(api.post).mockClear(); vi.mocked(api.del).mockClear();
  vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a new workspace", () => {
  it("is created and becomes the current workspace, with the id the API returns", async () => {
    render();
    const form = state.nodes.find((n) => n.tag === "form" && n.props["aria-labelledby"] === "ws-new-h")!;
    const values: Record<string, string> = { name: "Harbour Lane", reviewMode: "team" };
    vi.stubGlobal("FormData", class { get(k: string) { return values[k]; } });
    await form.props.onSubmit({ preventDefault() {}, currentTarget: { reset() {} } });
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces", { name: "Harbour Lane", reviewMode: "team" }]);
    expect(state.setWorkspace).toHaveBeenCalledWith("ws-new");
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
  });
});

describe("changing a person's role", () => {
  const everyone = () => [member("me", "Morgan Owner", "owner"), member("o2", "Olive Owner", "owner"), member("a", "Ada Admin", "admin"), member("n", "Ana Analyst", "analyst"),
    member("v", "Vic Viewer", "viewer"), member("r", "Riley Reviewer", "reviewer"), member("c", "Cleo Client", "client")];

  it("offers a role select for admin, analyst and viewer rows only", () => {
    state.members = everyone();
    const html = render();
    expect(roleSelects().map((s) => s.props["aria-label"])).toEqual(["Role of Ada Admin", "Role of Ana Analyst", "Role of Vic Viewer"]);
    expect(roleSelects().map((s) => s.props.value)).toEqual(["admin", "analyst", "viewer"]);
    expect(text(section(html, "people"))).toMatch(/review-access page|reviewer access/i);
  });

  it("never offers it on your own row", () => {
    state.role = "admin";
    state.members = [member("me", "Morgan Admin", "admin"), member("n", "Ana Analyst", "analyst")];
    render();
    expect(roleSelects().map((s) => s.props["aria-label"])).toEqual(["Role of Ana Analyst"]);
  });

  it.each(["analyst", "viewer"])("is not offered to a %s", (role) => {
    state.role = role;
    state.members = everyone();
    render();
    expect(roleSelects()).toHaveLength(0);
  });

  it("asks first, then posts the email and new role and refreshes the list", async () => {
    state.members = everyone();
    render();
    const ana = roleSelects().find((s) => s.props["aria-label"] === "Role of Ana Analyst")!;
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await ana.props.onChange({ target: { value: "viewer" } });
    expect(vi.mocked(api.post).mock.calls.filter(([p]) => p === "/workspaces/ws/members")).toHaveLength(0);
    await ana.props.onChange({ target: { value: "admin" } });
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/members", { email: "n@example.test", role: "admin" }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["members"] });
  });
});

describe("clients across every deal", () => {
  it("lists a client and an open invitation from two deals, and leaves closed invitations out", async () => {
    state.deals = [deal("d1", "Larch Court", 2, 1, 5), deal("d2", "Harbour Lane", null, 0, 3)];
    state.clients = { d1: [{ id: "u-priya", name: "Priya Nair", email: "priya@example.test", assigned_at: "2026-10-18T12:00:00Z" }] };
    state.invites = { d2: [invite("open"), invite("used", { used_at: "2026-10-23T12:00:00Z", used_by: "Dana" }), invite("revoked", { revoked_at: "2026-10-23T12:00:00Z" }),
      invite("old", { expires_at: "2000-01-01T00:00:00Z" })] };
    const html = render();
    const clients = section(html, "clients");
    const table = clients.slice(clients.indexOf("<table"), clients.indexOf("</table>"));
    expect(text(table.slice(0, table.indexOf("</thead>")))).toBe("Deal Client Status");
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map((m) => text(m[1]!));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.startsWith("Larch Court"))).toMatch(/Priya Nair .*priya@example\.test .*Client since Oct(ober)? 18, 2026 Remove/);
    expect(rows.find((r) => r.startsWith("Harbour Lane"))).toMatch(/Invited Oct(ober)? 22, 2026 · link expires Nov(ember)? 5, 2099 Withdraw/);
    expect(text(clients)).not.toMatch(/Used by|Revoked|Expired|Copy link/);

    await buttons("Withdraw")[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/invites/open/revoke")).toBe(true);
    await buttons("Remove")[0]!.props.onClick();
    expect(vi.mocked(api.del).mock.calls).toContainEqual(["/deals/d1/clients/u-priya", {}]);
    expect(vi.mocked(window.confirm)).toHaveBeenCalledTimes(2);
  });

  it("invites a client to a chosen deal by email or by a link shown once", async () => {
    state.deals = [deal("d1", "Larch Court", 2, 1, 5), deal("d2", "Harbour Lane", null, 0, 3)];
    let html = render();
    expect(text(section(html, "clients"))).toContain("Invite a client to a deal");
    const pick = state.nodes.find((n) => n.tag === "select" && n.props.id === "c-deal")!;
    pick.props.onChange({ target: { value: "d2" } });
    render();
    const form = state.nodes.find((n) => n.tag === "form" && n.props["aria-labelledby"] === "c-invite-h")!;
    await form.props.onSubmit({ preventDefault() {}, currentTarget: { reset() {}, elements: { namedItem: () => ({ value: "erin@example.test" }) } } });
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/deals/d2/clients", { email: "erin@example.test" }]);
    await buttons("Make an invitation link")[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/deals/d2/invites")).toBe(true);
    html = render();
    expect(text(html)).toContain("Copy this link now. It is not shown again.");
    expect(state.nodes.some((n) => n.tag === "input" && n.props.readOnly && n.props.value === "https://agir.test/i/secret")).toBe(true);
  });
});

describe("plain counts", () => {
  it("shows the owner the four totals, with documents that needed typing", () => {
    state.deals = [deal("d1", "Larch Court", 3, 2, 10), deal("d2", "Harbour Lane", null, 5, 4)];
    state.metrics = { deals: [], totals: { deals: 2, docs_no_candidates: 2 } };
    const counts = section(render(), "counts");
    const figs = [...counts.matchAll(/<dt class="k">([^<]+)<\/dt><dd class="v">([^<]+)<\/dd>(?:<dd class="s">([^<]+)<\/dd>)?/g)].map((m) => [m[1], m[2], m[3]]);
    expect(figs).toEqual([["Deals", "2", undefined], ["Runs", "3", undefined], ["Reports made", "7", undefined], ["Documents read", "14", "2 needed typing"]]);
    expect(text(counts)).toContain("Counts for each deal");
  });

  it("leaves the typing line out while the metrics have not answered", () => {
    state.deals = [deal("d1", "Larch Court", 3, 2, 10)];
    expect(text(section(render(), "counts"))).not.toContain("needed typing");
  });
});
