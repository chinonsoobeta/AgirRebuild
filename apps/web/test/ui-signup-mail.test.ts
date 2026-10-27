import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api";
import { Login, Signup } from "../src/routes/auth.tsx";
import { Verify } from "../src/routes/verify.tsx";
import { Reset } from "../src/routes/reset.tsx";
import { EmailUndo } from "../src/routes/email-change.tsx";
import { Settings } from "../src/routes/settings.tsx";
import type { Lang } from "../src/i18n.tsx";

// Card B: invite-only sign-up on the sign-up and sign-in pages, and no screen claiming an email was sent when the server
// has no mail provider. Same harness as ui-email-change.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, me: undefined as unknown, meError: null as unknown, effects: [] as (() => unknown)[], signup: undefined as unknown,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}), navigate: vi.fn(), setLang: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "me" ? { data: state.me, error: state.meError } : key === "signup" ? { data: state.signup } : key === "members" || key === "deals" ? { data: [] } : key === "demo" ? { data: { available: false } } : {};
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
  return { ...react,
    useState: (initial: unknown) => {
      const n = state.index++;
      if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [state.hooks[n], (value: unknown) => { state.hooks[n] = typeof value === "function" ? (value as (v: unknown) => unknown)(state.hooks[n]) : value; }];
    },
    useEffect: (fn: () => unknown) => { state.effects.push(fn); },
  };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "input", "a", "form", "label"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (C: unknown) => { state.index = 0; state.nodes = []; state.effects = []; return renderToStaticMarkup(createElement(C as any)); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ /g, " ").trim();
const label = (n: { props: Record<string, any> }): string => { const c = n.props.children; return Array.isArray(c) ? c.filter((x) => typeof x === "string").join("") : typeof c === "string" ? c : ""; };
const button = (name: string) => state.nodes.find((n) => n.tag === "button" && label(n) === name);
const links = (html: string, href: string) => html.includes(`href="${href}"`);
const input = (id: string) => state.nodes.find((n) => n.tag === "input" && n.props.id === id);
const account = (html: string) => text(html.slice(html.indexOf('id="account"')));
const settle = () => new Promise((r) => setTimeout(r, 0));
const submitChange = async (values: Record<string, string>) => {
  const form = state.nodes.find((n) => n.tag === "form" && n.props.id === "change-email")!;
  await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { elements: { namedItem: (k: string) => ({ value: values[k] }) } } });
};
const replaceState = vi.fn();
const at = (path: string, search = "") => vi.stubGlobal("window", { location: { pathname: path, search }, history: { state: { key: "k" }, replaceState }, confirm: () => true });
const person = (verified: boolean, mail?: boolean) => ({ user: { id: "me", name: "Morgan Owner", email: "morgan@example.test", email_verified: verified },
  workspaces: [{ id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, has_logo: false, role: "owner" }], ...(mail === undefined ? {} : { mail }) });
const NO_MAIL = "No email could be sent: this server has no mail provider yet. Ask the person who runs it.";
const NO_MAIL_FR = "Aucun courriel n'a pu être envoyé : ce serveur n'a pas encore de fournisseur de courriel. Demandez à la personne qui l'administre.";

beforeEach(() => {
  Object.assign(state, { lang: "en", me: undefined, meError: null, hooks: [], effects: [], signup: undefined });
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("invite-only sign-up", () => {
  it("closed: the sign-up page shows the sentence and no form, with a way to sign in", () => {
    state.signup = { open: false };
    const html = render(Signup);
    expect(text(html)).toContain("Agir is by invitation during the pilot.");
    expect(state.nodes.some((n) => n.tag === "form" || n.tag === "input")).toBe(false);
    expect(links(html, "/login")).toBe(true);
  });

  it("open, or not known yet: the form, as before", () => {
    for (const signup of [{ open: true }, undefined]) {
      state.signup = signup;
      const html = render(Signup);
      expect(state.nodes.some((n) => n.tag === "form")).toBe(true);
      expect(text(html)).not.toContain("by invitation");
    }
  });

  it("closed: the sign-in page keeps the Create an account link and says it is by invitation", () => {
    state.signup = { open: false };
    const html = render(Login);
    expect(links(html, "/signup")).toBe(true);
    expect(text(html)).toContain("Create an account");
    expect(text(html)).toContain("By invitation during the pilot.");
    state.signup = { open: true };
    expect(text(render(Login))).not.toContain("By invitation");
  });

  it("French", () => {
    state.lang = "fr";
    state.signup = { open: false };
    expect(text(render(Signup))).toContain("Agir est sur invitation pendant le projet pilote.");
    expect(text(render(Login))).toContain("Sur invitation pendant le projet pilote.");
  });
});

describe("with no mail provider, no screen claims a send", () => {
  it("the verify page: no code will arrive, the account is created, and going on is the main button (QA card C4)", () => {
    at("/verify");
    state.me = person(false, false);
    const html = render(Verify);
    const words = text(html);
    expect(words).toContain("Your account is ready");
    expect(words).toContain("Email is not set up on this server yet, so no code will arrive. Your account is already created.");
    expect(words).not.toMatch(/We sent|send it again|Skip for now/);
    expect(input("code")).toBeUndefined();
    expect(html).toContain('<a href="/deals" class="btn primary auth-wide">Continue to your deals</a>');
  });

  it("the verify page: a send that answers sent: false says so instead of We sent a new link", async () => {
    at("/verify");
    state.me = person(false);
    render(Verify);
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true, sent: false });
    await button("send it again")!.props.onClick();
    const words = text(render(Verify));
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("We sent a new link");
  });

  it("the reset page: the sentence instead of a link on its way", async () => {
    at("/reset");
    render(Reset);
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true, sent: false });
    const form = state.nodes.find((n) => n.tag === "form")!;
    await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { elements: { namedItem: () => ({ value: "a@example.test" }) } } });
    const words = text(render(Reset));
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("on its way");
  });

  it("settings: the sentence instead of the Send a new link button", () => {
    state.me = person(false, false);
    const html = render(Settings);
    expect(account(html)).toContain("Your email address is not confirmed yet.");
    expect(account(html)).toContain(NO_MAIL);
    expect(button("Send a new link")).toBeUndefined();
  });

  it("settings: Password says no email could be sent", async () => {
    state.me = person(true);
    render(Settings);
    vi.mocked(api.post).mockResolvedValueOnce({ ok: true, sent: false });
    await button("Send me a link")!.props.onClick();
    const words = account(render(Settings));
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("We sent a link");
  });

  it("changing a confirmed address: the sentence instead of We sent a link", async () => {
    state.me = person(true);
    render(Settings);
    await button("Change")!.props.onClick();
    render(Settings);
    vi.mocked(api.post).mockResolvedValueOnce({ pending: true, sent: false });
    await submitChange({ email: "new@example.test", password: "my password" });
    const words = account(render(Settings));
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("We sent");
  });

  it("changing an unconfirmed address: the new address, and the sentence instead of We sent a link there", async () => {
    state.me = person(false);
    render(Settings);
    await button("Change")!.props.onClick();
    render(Settings);
    vi.mocked(api.post).mockResolvedValueOnce({ changed: true, sent: false });
    await submitChange({ email: "new@example.test", password: "my password" });
    const words = account(render(Settings));
    expect(words).toContain("Your email address is now new@example.test.");
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("We sent");
  });

  it("the undo page: devices signed out, and the sentence instead of the reset link", async () => {
    at("/email/undo", "?token=tok-u");
    render(EmailUndo);
    vi.mocked(api.post).mockResolvedValueOnce({ email: "morgan@example.test", sent: false });
    for (const e of state.effects) await e();
    await settle();
    const words = text(render(EmailUndo));
    expect(words).toContain("We signed every device out and turned off the old password.");
    expect(words).toContain(NO_MAIL);
    expect(words).not.toContain("We sent");
  });

  it("French", async () => {
    state.lang = "fr";
    at("/verify");
    state.me = person(false, false);
    expect(text(render(Verify))).toContain("Le courriel n'est pas encore configuré sur ce serveur, donc aucun code n'arrivera. Votre compte est déjà créé.");
    expect(text(render(Verify))).toContain("Continuer vers vos projets");
    expect(account(render(Settings))).toContain(NO_MAIL_FR);
  });
});
