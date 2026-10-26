import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card F: "Close this workspace" and "Delete my account" in Settings, shown only when the server offers them
// (AGIR_ACCOUNT_CLOSURE=1). Mocks follow ui-people-2.test.ts.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, role: "owner", setWorkspace: vi.fn(), invalidate: vi.fn(async () => {}),
  members: [] as unknown[], deals: [] as unknown[], metrics: undefined as unknown, sessions: undefined as unknown,
  clients: {} as Record<string, unknown[]>, invites: {} as Record<string, unknown[]>,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
  closure: true, closedAt: null as string | null, owned: [] as { id: string; name: string; role: string; closed_at: string | null }[],
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
      me: { user: { id: "me", name: "Morgan Owner", email: "morgan@example.test" }, closure: state.closure, workspaces: [
        { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, has_logo: false, role: state.role, closed_at: state.closedAt },
        ...state.owned.map((w) => ({ review_mode: "team", label_suggestions: false, has_logo: false, ...w })),
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
    if (typeof args[0] === "string" && ["button", "input", "a", "form", "select", "textarea"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
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


beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.hooks = []; state.members = []; state.deals = []; state.metrics = undefined; state.sessions = undefined;
  state.clients = {}; state.invites = {}; state.closure = true; state.closedAt = null; state.owned = [];
  state.invalidate.mockClear(); vi.mocked(api.post).mockClear();
  vi.stubGlobal("window", { location: { origin: "https://agir.test", assign: vi.fn() }, confirm: vi.fn(() => true) });
});
afterEach(() => { vi.unstubAllGlobals(); });

const CLOSE = "Close this workspace";
const DELETE = "Delete my account";

describe("with the setting off", () => {
  it("shows neither closing the workspace nor deleting the account, even to the owner", () => {
    state.closure = false;
    const html = text(render());
    expect(html).not.toContain(CLOSE);
    expect(html).not.toContain(DELETE);
    expect(form(CLOSE)).toBeUndefined();
    expect(form(DELETE)).toBeUndefined();
  });
});

describe("closing the workspace", () => {
  it("is offered to the owner only, in the workspace section", () => {
    const html = render();
    expect(buttons(CLOSE)).toHaveLength(1);
    expect(text(section(html, "workspace"))).toContain(CLOSE);
    for (const role of ["admin", "analyst", "viewer"]) {
      state.role = role;
      render();
      expect(buttons(CLOSE), role).toHaveLength(0);
    }
  });

  it("says what happens before anything does, then posts the reason and refreshes the session", async () => {
    const html = text(render());
    expect(html).toContain("Closing makes the workspace read-only at once");
    expect(html).toContain("It is deleted once the retention period has passed; until a retention period is set, it is kept.");
    expect(state.nodes.find((n) => n.tag === "textarea")!.props).toMatchObject({ name: "reason", required: true, minLength: 10, maxLength: 500 });
    await submit(form(CLOSE)!, "We are winding the firm down");
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/close", { reason: "We are winding the firm down" }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
  });

  it("is gone once the workspace is closed, which the section says with the date", () => {
    state.closedAt = "2026-10-20T12:00:00Z";
    const html = text(section(render(), "workspace"));
    expect(buttons(CLOSE)).toHaveLength(0);
    expect(html).toMatch(/Closed on .+\. This workspace is read-only\./);
  });
});

describe("deleting your account", () => {
  it("is offered to every role, in Your account, and explains the audit trail", () => {
    for (const role of ["owner", "admin", "viewer", "client"]) {
      state.role = role;
      const html = render();
      expect(text(section(html, "account")), role).toContain(DELETE);
    }
    expect(text(render())).toContain("The audit trail is never edited: events recorded before keep what they recorded, which can include your name.");
  });

  it("names the open workspaces you own instead of asking for the password", () => {
    state.owned = [{ id: "w2", name: "Harbour Capital", role: "owner", closed_at: null }, { id: "w3", name: "Old Firm", role: "owner", closed_at: "2026-10-01T00:00:00Z" }];
    const html = text(render());
    expect(html).toContain("First close the workspaces you own: Elm Street, Harbour Capital.");
    expect(state.nodes.some((n) => n.tag === "input" && n.props.name === "password")).toBe(false);
    expect(buttons(DELETE)).toHaveLength(1);
  });

  it("asks for the password once you own no open workspace, posts it, and leaves for sign-in", async () => {
    state.closedAt = "2026-10-20T12:00:00Z";
    render();
    expect(state.nodes.find((n) => n.tag === "input" && n.props.name === "password")!.props).toMatchObject({ type: "password", required: true, autoComplete: "current-password" });
    expect(buttons(DELETE)).toHaveLength(2);
    await submit(form(DELETE)!, "correct horse battery");
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/auth/delete-account", { password: "correct horse battery" }]);
    expect(window.location.assign).toHaveBeenCalledWith("/login");
  });
});

describe("in French", () => {
  it("both actions are in French", () => {
    state.lang = "fr";
    const html = text(render());
    expect(html).toContain("Fermer cet espace de travail");
    expect(html).toContain("Supprimer mon compte");
    // The text helper folds the non-breaking space before the colon into a plain one.
    expect(html).toContain("Fermez d'abord les espaces dont vous êtes propriétaire : Elm Street.");
  });
});
