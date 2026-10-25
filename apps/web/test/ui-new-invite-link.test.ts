import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import { translateMessage, type Lang } from "../src/i18n.tsx";

// Card R5: "Make a new link" on an open invitation, since a link is shown only once.
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
    post: vi.fn(async (path: string) => path.endsWith("/replace") ? { id: "inv-new", url: "/i/new-link" } : { ok: true }),
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
const rowsOf = (html: string) => { const c = section(html, "clients"); const table = c.slice(c.indexOf("<table"), c.indexOf("</table>")); return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1).map((m) => text(m[1]!)); };

const deal = (id: string, name: string) => ({ deal: { id, workspace_id: "ws", name }, run: null, reports: 0, documents: { total: 0, processing: 0, failed: 0 } });
const invite = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: "2026-10-22T12:00:00Z", expires_at: "2099-11-05T12:00:00Z", created_by: "Alice Admin",
  used_at: null, used_by: null, revoked_at: null, revoked_by: null, ...over });
const NOTE = "A link is shown only once, when it is made. To send one again, make a new link.";
const madeInput = () => state.nodes.find((n) => n.tag === "input" && n.props.readOnly);

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.hooks = []; state.members = []; state.deals = []; state.metrics = undefined; state.sessions = undefined;
  state.clients = {}; state.invites = {};
  state.setWorkspace.mockClear(); state.invalidate.mockClear(); vi.mocked(api.post).mockClear(); vi.mocked(api.del).mockClear();
  vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("making a new link for an open invitation", () => {
  it("puts Make a new link before Withdraw on an open invitation's row, naming the deal", () => {
    state.deals = [deal("d1", "Larch Court"), deal("d2", "Harbour Lane")];
    state.invites = { d2: [invite("open"), invite("used", { used_at: "2026-10-23T12:00:00Z" })] };
    const html = render();
    expect(rowsOf(html)).toHaveLength(1);
    expect(rowsOf(html)[0]).toMatch(/^Harbour Lane .*link expires Nov(ember)? 5, 2099 Make a new link Withdraw$/);
    const make = buttons("Make a new link");
    expect(make).toHaveLength(1);
    expect(make[0]!.props["aria-label"]).toBe("Make a new link for the invitation to Harbour Lane");
    expect(make[0]!.props.className).toBe("btn ghost sm");
    expect(make[0]!.props.type).toBe("button");
  });

  it("asks first, and does nothing when the person says no", async () => {
    state.deals = [deal("d2", "Harbour Lane")];
    state.invites = { d2: [invite("open")] };
    render();
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await buttons("Make a new link")[0]!.props.onClick();
    expect(window.confirm).toHaveBeenCalledWith("Make a new link? The link you sent before will stop working.");
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/invites/open/replace")).toBe(false);
  });

  it("calls the replace route, shows the new link once in the link box with Copy, focuses it, and refreshes the lists", async () => {
    state.deals = [deal("d1", "Larch Court"), deal("d2", "Harbour Lane")];
    state.invites = { d2: [invite("open")] };
    render();
    expect(madeInput()).toBeUndefined();
    await buttons("Make a new link")[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.map(([p]) => p)).toEqual(["/invites/open/replace"]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["invites", "d2"] });
    const html = render();
    const input = madeInput();
    expect(input?.props.value).toBe("https://agir.test/i/new-link");
    expect(input?.props.autoFocus).toBe(true);
    expect(text(section(html, "clients"))).toContain("Copy this link now. It is not shown again.");
    expect(buttons("Copy")).toHaveLength(1);
    // The deal picker follows the deal the new link belongs to, so the box does not sit under another deal's name.
    expect(state.nodes.find((n) => n.tag === "select" && n.props.id === "c-deal")?.props.value).toBe("d2");
  });

  it("does not move focus to a link made with Make an invitation link", async () => {
    vi.mocked(api.post).mockImplementationOnce(async () => ({ id: "inv", url: "/i/first" }));
    state.deals = [deal("d1", "Larch Court")];
    render();
    await buttons("Make an invitation link")[0]!.props.onClick();
    render();
    expect(madeInput()?.props.value).toBe("https://agir.test/i/first");
    expect(madeInput()?.props.autoFocus).toBeFalsy();
  });

  it("says under the table how to send a link again, only when an invitation is listed", () => {
    state.deals = [deal("d1", "Larch Court"), deal("d2", "Harbour Lane")];
    state.clients = { d1: [{ id: "u-priya", name: "Priya Nair", email: "priya@example.test", assigned_at: "2026-10-18T12:00:00Z", confirmed: 0, last_confirmed_at: null }] };
    expect(text(section(render(), "clients"))).not.toContain(NOTE);
    state.invites = { d2: [invite("revoked", { revoked_at: "2026-10-23T12:00:00Z" })] };
    expect(text(section(render(), "clients"))).not.toContain(NOTE);
    state.invites = { d2: [invite("open")] };
    const clients = section(render(), "clients");
    expect(text(clients)).toContain(NOTE);
    expect(clients).toContain(`<p class="small muted">${NOTE}</p>`);
    expect(clients.indexOf(NOTE)).toBeGreaterThan(clients.indexOf("</table>"));
  });

  it("is in French", async () => {
    state.lang = "fr";
    state.deals = [deal("d2", "Harbour Lane")];
    state.invites = { d2: [invite("open")] };
    const clients = text(section(render(), "clients"));
    expect(clients).toContain("Un lien ne s'affiche qu'une fois, au moment où il est créé. Pour l'envoyer de nouveau, créez un nouveau lien.");
    const make = buttons("Créer un nouveau lien");
    expect(make).toHaveLength(1);
    expect(make[0]!.props["aria-label"]).toBe("Créer un nouveau lien pour l'invitation au projet Harbour Lane");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    await make[0]!.props.onClick();
    expect(window.confirm).toHaveBeenCalledWith("Créer un nouveau lien ? Le lien envoyé plus tôt ne fonctionnera plus.");
  });

  it("translates the server's sentence for an invitation that is gone", () => {
    expect(translateMessage("This invitation is not there any more.")).toBe("Cette invitation n'existe plus.");
  });
  it("translates the sentences for an invitation already used or withdrawn, or not found", () => {
    expect(translateMessage("This invitation is already used or revoked.")).toBe("Cette invitation a déjà été utilisée ou annulée.");
    expect(translateMessage("Invitation not found")).toBe("Cette invitation n'existe plus.");
  });
});
