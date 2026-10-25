import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "../src/api";
import { Login } from "../src/routes/auth.tsx";
import { takeToken, Verify } from "../src/routes/verify.tsx";
import { Reset } from "../src/routes/reset.tsx";
import { Settings } from "../src/routes/settings.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card W12: confirming an email address and resetting a password. Static rendering runs no effects,
// so the handlers are taken from captured nodes and called directly, as in ui-auth.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, me: undefined as unknown, meError: null as unknown,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}), navigate: vi.fn(), setLang: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "me" ? { data: state.me, error: state.meError } : key === "members" || key === "deals" ? { data: [] } : key === "demo" ? { data: { available: false } } : {};
  },
  useMutation: (options: { mutationFn: (body: any) => Promise<any>; onSuccess?: (data: any, body: any) => unknown }) => ({
    mutate: async (body: unknown) => { const data = await options.mutationFn(body); await options.onSuccess?.(data, body); },
    isPending: false, isSuccess: false, reset: () => {}, error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  return { ...ui, useSession: () => ({ solo: true, role: "owner", workspaceId: "ws", setWorkspace: vi.fn(), me: state.me }) };
});
vi.mock("../src/theme", async (original) => {
  const theme = await original<typeof import("../src/theme")>();
  return { ...theme, useTheme: () => ({ pref: "light", theme: "light", setPref: vi.fn() }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, state.setLang) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, to, className }: { children: unknown; to: string; className?: string }) => createElement("a", { href: to, className }, children as string), useNavigate: () => state.navigate };
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
    if (typeof args[0] === "string" && ["button", "input", "a", "form", "label"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (C: unknown) => { state.index = 0; state.nodes = []; return renderToStaticMarkup(createElement(C as any)); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const label = (n: { props: Record<string, any> }): string => { const c = n.props.children; return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : ""; };
const button = (name: string) => state.nodes.find((n) => n.tag === "button" && label(n) === name);
const input = (id: string) => state.nodes.find((n) => n.tag === "input" && n.props.id === id);
const submit = async (values: Record<string, string>) => {
  const form = state.nodes.find((n) => n.tag === "form")!;
  await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { elements: { namedItem: (k: string) => ({ value: values[k] }) } } });
};
const replaceState = vi.fn();
const at = (path: string, search = "") => vi.stubGlobal("window", { location: { pathname: path, search }, history: { state: { key: "k" }, replaceState } });
const person = (verified: boolean) => ({ user: { id: "me", name: "Morgan Owner", email: "morgan@example.test", email_verified: verified }, workspaces: [
  { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, has_logo: false, role: "owner" },
] });

beforeEach(() => {
  Object.assign(state, { lang: "en", me: undefined, meError: null, hooks: [] });
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("takeToken", () => {
  it("returns the token and removes the query from the address bar, keeping the path", () => {
    at("/verify", "?token=abc123");
    expect(takeToken()).toBe("abc123");
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]![2]).toBe("/verify");
  });
  it("returns null without a token and leaves the address alone", () => {
    at("/verify");
    expect(takeToken()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe("the confirm-your-email page", () => {
  it("signed in and not confirmed: the address, the code form, send it again and skip", async () => {
    at("/verify");
    state.me = person(false);
    const words = text(render(Verify));
    for (const s of ["Check your email", "morgan@example.test", "60 minutes", "Continue", "send it again", "Skip for now"]) expect(words).toContain(s);
    expect(words).not.toMatch(/different email|on this device|receipts/i);
    const code = input("code")!;
    expect(code.props.inputMode).toBe("numeric");
    expect(code.props.autoComplete).toBe("one-time-code");
    expect(state.nodes.some((n) => n.tag === "label" && n.props.htmlFor === "code")).toBe(true);
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/deals")).toBe(true);
    await submit({ code: "123456" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/verify", { code: "123456" }]);
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals" });
    render(Verify);
    await button("send it again")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls[1]![0]).toBe("/auth/verify/send");
  });
  it("a wrong code shows the API's sentence and goes nowhere", async () => {
    at("/verify");
    state.me = person(false);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(400, "That code is wrong or has expired."));
    render(Verify);
    await submit({ code: "000000" });
    expect(text(render(Verify))).toContain("That code is wrong or has expired.");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("signed in and already confirmed: says so, with a link to the deals", () => {
    at("/verify");
    state.me = person(true);
    const words = text(render(Verify));
    expect(words).toContain("Your email address is confirmed.");
    expect(input("code")).toBeUndefined();
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/deals")).toBe(true);
  });
  it("signed out with no token: asks them to open the link or sign in", () => {
    at("/verify");
    state.meError = new ApiError(401, "Sign in to continue.");
    render(Verify);
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/login")).toBe(true);
    expect(input("code")).toBeUndefined();
  });
  it("French", () => {
    at("/verify");
    state.lang = "fr";
    state.me = person(false);
    const words = text(render(Verify));
    for (const s of ["Vérifiez vos courriels", "Continuer", "Plus tard"]) expect(words).toContain(s);
  });
});

describe("the reset-password page", () => {
  it("with no token: asks for the email and posts it", async () => {
    at("/reset");
    const words = text(render(Reset));
    for (const s of ["Forgot your password?", "Send me a link", "Back to sign in"]) expect(words).toContain(s);
    expect(state.nodes.some((n) => n.tag === "label" && n.props.htmlFor === "email")).toBe(true);
    await submit({ email: "a@example.test" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/reset/send", { email: "a@example.test" }]);
    expect(text(render(Reset))).toContain("If an account uses a@example.test, a link to choose a new password is on its way.");
  });
  it("with a token: two password fields and the sign-out box ticked; different passwords post nothing", async () => {
    at("/reset", "?token=tok-1");
    const words = text(render(Reset));
    for (const s of ["Choose a new password", "Type it again", "Sign out my other devices", "Save and sign in", "At least 10 characters."]) expect(words).toContain(s);
    expect(replaceState.mock.calls[0]![2]).toBe("/reset");
    expect(input("password")!.props.autoComplete).toBe("new-password");
    expect(input("password")!.props.minLength).toBe(10);
    expect(input("password2")).toBeTruthy();
    expect(input("others")!.props.checked).toBe(true);
    expect(words).not.toMatch(/leaked|lock the account|from the link we sent at/i);
    await submit({ password: "a-long-password", password2: "a-different-one" });
    expect(api.post).not.toHaveBeenCalled();
    expect(text(render(Reset))).toContain("The two passwords are different.");
    await submit({ password: "a-long-password", password2: "a-long-password" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/reset", { token: "tok-1", password: "a-long-password", signOutOthers: true }]);
    expect(state.invalidate).toHaveBeenCalled();
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals" });
  });
  it("a used or expired link shows the sentence and a way to ask for a new one", async () => {
    at("/reset", "?token=tok-1");
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(400, "This link has been used or has expired."));
    render(Reset);
    await submit({ password: "a-long-password", password2: "a-long-password" });
    const html = render(Reset);
    expect(text(html)).toContain("This link has been used or has expired.");
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/reset")).toBe(true);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("French", () => {
    at("/reset");
    state.lang = "fr";
    expect(text(render(Reset))).toContain("Mot de passe oublié ?");
    state.hooks = [];
    at("/reset", "?token=t");
    expect(text(render(Reset))).toContain("Choisissez un nouveau mot de passe");
  });
});

describe("sign in", () => {
  it("links to the reset page", () => {
    render(Login);
    const link = state.nodes.find((n) => n.tag === "a" && n.props.href === "/reset");
    expect(link && label(link)).toBe("Forgot your password?");
  });
});

describe("settings, your account", () => {
  it("not confirmed: the notice, a button that sends a new link and a link to enter the code", async () => {
    state.me = person(false);
    const html = render(Settings);
    const account = text(html.slice(html.indexOf('id="account"')));
    expect(account).toContain("Your email address is not confirmed yet.");
    expect(state.nodes.some((n) => n.tag === "a" && n.props.href === "/verify")).toBe(true);
    expect(account).not.toContain("Confirmed");
    await button("Send a new link")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/auth/verify/send", {}]);
  });
  it("confirmed: a Confirmed tag beside the email", () => {
    state.me = person(true);
    const html = render(Settings);
    const account = text(html.slice(html.indexOf('id="account"')));
    expect(account).toContain("Confirmed");
    expect(account).not.toContain("not confirmed");
    expect(button("Send a new link")).toBeUndefined();
  });
  it("French", () => {
    state.lang = "fr";
    state.me = person(false);
    expect(text(render(Settings))).toContain("Votre adresse courriel n'est pas encore confirmée.");
  });
});
