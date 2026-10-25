import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Settings } from "../src/routes/settings.tsx";
import { ReviewAccess } from "../src/routes/review-access.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card W2: the settings screen and the screen that gives a reviewer access. Mocks follow
// apps/web/test/clients.test.ts: hooks are replaced so a render can be clicked and re-rendered.
const state = vi.hoisted(() => ({
  lang: "en" as Lang, role: "owner", pref: "light" as "light" | "dark" | "system",
  setPref: vi.fn(), setLang: vi.fn(), setWorkspace: vi.fn(), invalidate: vi.fn(async () => {}),
  members: [] as unknown[], hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "members" ? { data: state.members } : key === "deals" ? { data: [] } : {};
  },
  useMutation: (options: { mutationFn: (body: any) => Promise<any>; onSuccess?: (data: any, body: any) => unknown }) => ({
    mutate: async (body: unknown) => { const data = await options.mutationFn(body); await options.onSuccess?.(data, body); },
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
        { id: "ws2", name: "Harbour Partners", review_mode: "team", label_suggestions: false, has_logo: false, role: "viewer" },
      ] },
    }),
  };
});
vi.mock("../src/theme", async (original) => {
  const theme = await original<typeof import("../src/theme")>();
  return { ...theme, useTheme: () => ({ pref: state.pref, theme: state.pref === "dark" ? "dark" : "light", setPref: state.setPref }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, state.setLang) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => createElement("a", { href: to, className }, children as string) };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async () => []), post: vi.fn(async () => ({ ok: true })), del: vi.fn(async () => ({ ok: true })), upload: vi.fn(async () => ({})) } };
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

const render = (C: () => unknown) => { state.index = 0; state.nodes = []; return renderToStaticMarkup(createElement(C as any)); };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const label = (n: { props: Record<string, any> }): string => { const c = n.props.children; return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : ""; };
const button = (name: string) => state.nodes.find((n) => n.tag === "button" && label(n) === name);

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.pref = "light"; state.hooks = []; state.members = [];
  state.setPref.mockClear(); state.setLang.mockClear(); state.setWorkspace.mockClear(); state.invalidate.mockClear(); vi.mocked(api.post).mockClear();
});

const OWNER_SECTIONS = ["workspace", "appearance", "review", "thresholds", "people", "roles", "clients", "reading", "logo", "counts", "account"];

describe("the settings screen", () => {
  it("has an on-page nav and every section, in order, for the owner", () => {
    const html = render(Settings);
    expect(html).toContain('aria-label="On this page"');
    const hrefs = [...html.matchAll(/href="#([a-z]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(OWNER_SECTIONS);
    const ids = [...html.matchAll(/<section[^>]* id="([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(OWNER_SECTIONS);
    const words = text(html);
    for (const s of ["Settings", "Workspace", "Appearance and language", "How values are reviewed", "Thresholds", "People", "What each role can do", "Clients", "Reading documents", "Logo on the lender package", "Counts", "Your account", "morgan@example.test", "Harbour Partners"]) expect(words).toContain(s);
    // The owner changes the workspace name and everyone changes their own name in a field (card Z1).
    expect(html).toContain('value="Elm Street"');
    expect(html).toContain('value="Morgan Owner"');
    expect(html).toContain('href="/settings/review-access"');
    expect(words).not.toMatch(/billing|paying|\bpay\b|C\$/i);
  });

  it("switches workspace and keeps the new-workspace form", () => {
    render(Settings);
    button("Switch")!.props.onClick();
    expect(state.setWorkspace).toHaveBeenCalledWith("ws2");
    expect(state.nodes.some((n) => n.tag === "input" && n.props.name === "name")).toBe(true);
  });

  it("shows a viewer the review mode disabled with the reason, and no owner-only section", () => {
    state.role = "viewer";
    const html = render(Settings);
    const radios = state.nodes.filter((n) => n.tag === "input" && n.props.name === "review-mode");
    expect(radios).toHaveLength(2);
    for (const r of radios) expect(r.props.disabled).toBe(true);
    expect(text(html)).toContain("Only the owner can change how values are reviewed.");
    for (const id of ["clients", "logo", "counts"]) {
      expect(html).not.toContain(`id="${id}"`);
      expect(html).not.toContain(`href="#${id}"`);
    }
    expect(html).not.toContain('href="/settings/review-access"');
    expect(state.nodes.some((n) => n.tag === "form" && n.props["aria-label"] === "Add someone to this workspace")).toBe(false);
  });

  it("shows the theme preference in a segmented control and sets it on click", () => {
    state.pref = "dark";
    render(Settings);
    expect(button("Dark")!.props["aria-pressed"]).toBe(true);
    expect(button("Light")!.props["aria-pressed"]).toBe(false);
    button("Match the device")!.props.onClick();
    expect(state.setPref).toHaveBeenCalledWith("system");
  });

  it("sets the language", () => {
    render(Settings);
    button("Français")!.props.onClick();
    expect(state.setLang).toHaveBeenCalledWith("fr");
  });

  it("lists every role with what it can and cannot do", () => {
    const html = render(Settings);
    const roles = html.slice(html.indexOf('id="roles"'));
    const table = roles.slice(0, roles.indexOf("</table>"));
    expect(text(table)).toContain("Can");
    expect(text(table)).toContain("Cannot");
    const rows = [...table.matchAll(/<th scope="row">([^<]+)/g)].map((m) => m[1]);
    expect(rows).toEqual(["Viewer", "Reviewer", "Analyst", "Admin", "Owner", "Client"]);
  });

  it("shows a reviewer's end date in the people table", () => {
    state.members = [{ id: "r1", name: "Riley Reviewer", email: "riley@example.test", role: "reviewer", expires_at: "2099-06-15T12:00:00Z" }];
    const words = text(render(Settings));
    expect(words).toContain("Riley Reviewer");
    expect(words).toMatch(/until .*2099/);
  });

  it("is in French with the French table", () => {
    state.lang = "fr";
    const words = text(render(Settings));
    for (const s of ["Paramètres", "Apparence et langue", "Ce que chaque rôle permet"]) expect(words).toContain(s);
  });
});

describe("giving a reviewer access", () => {
  it("asks for an email, a length and a consent tick before it can be sent", async () => {
    let html = render(ReviewAccess);
    const words = text(html);
    expect(words).toContain("Give a reviewer access");
    expect(words).toContain("every deal in this workspace");
    expect(words).toContain("audit trail");
    expect(words).not.toMatch(/\$|C\$|price|business day/i);
    const email = state.nodes.find((n) => n.tag === "input" && n.props.type === "email")!;
    expect(email).toBeTruthy();
    for (const d of ["7 days", "14 days", "30 days"]) expect(button(d)).toBeTruthy();
    expect(button("14 days")!.props["aria-pressed"]).toBe(true);
    const tick = state.nodes.find((n) => n.tag === "input" && n.props.type === "checkbox")!;
    expect(text(html)).toContain("I understand the reviewer will see every deal in this workspace, and that their confirmations are not an appraisal or lending advice");
    expect(state.nodes.find((n) => n.tag === "button" && n.props.type === "submit")!.props.disabled).toBe(true);

    email.props.onChange({ target: { value: "riley@example.test" } });
    button("30 days")!.props.onClick();
    tick.props.onChange({ target: { checked: true } });
    html = render(ReviewAccess);
    expect(state.nodes.find((n) => n.tag === "button" && n.props.type === "submit")!.props.disabled).toBe(false);
    await state.nodes.find((n) => n.tag === "form")!.props.onSubmit({ preventDefault() {} });
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/workspaces/ws/review-grant", { email: "riley@example.test", days: 30 }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["members"] });
    expect(text(render(ReviewAccess))).toContain("riley@example.test");
  });

  it("lists current and past reviewers with their end dates", () => {
    state.members = [
      { id: "a", name: "Ana Analyst", email: "ana@example.test", role: "analyst", expires_at: null },
      { id: "r1", name: "Riley Reviewer", email: "riley@example.test", role: "reviewer", expires_at: "2099-06-15T12:00:00Z" },
      { id: "r2", name: "Pat Past", email: "pat@example.test", role: "reviewer", expires_at: "2001-06-15T12:00:00Z" },
    ];
    const words = text(render(ReviewAccess));
    expect(words).toContain("Riley Reviewer");
    expect(words).toContain("Pat Past");
    expect(words).not.toContain("Ana Analyst");
    expect(words).toMatch(/2099/);
    expect(words).toMatch(/2001/);
  });

  it("tells someone who is not the owner, in one sentence, and links back to Settings", () => {
    state.role = "admin";
    const html = render(ReviewAccess);
    expect(text(html)).toContain("Only the workspace owner can give a reviewer access.");
    expect(html).toContain('href="/settings"');
    expect(state.nodes.some((n) => n.tag === "form")).toBe(false);
  });

  it("is in French", () => {
    state.lang = "fr";
    expect(text(render(ReviewAccess))).toContain("Donner accès à un réviseur");
  });
});
