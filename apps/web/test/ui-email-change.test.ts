import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "../src/api";
import { Verify } from "../src/routes/verify.tsx";
import { EmailConfirm, EmailUndo } from "../src/routes/email-change.tsx";
import { Settings } from "../src/routes/settings.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card R6: changing the email address, the Password row in Settings, "Use a different email" on the verify page, and the
// two pages the change emails link to. Static rendering runs no effects, so effects are captured and run by hand, once,
// and handlers are taken from captured nodes, as in ui-email.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, me: undefined as unknown, meError: null as unknown, effects: [] as (() => unknown)[],
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}), navigate: vi.fn(), setLang: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
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
const person = (verified: boolean) => ({ user: { id: "me", name: "Morgan Owner", email: "morgan@example.test", email_verified: verified }, workspaces: [
  { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, has_logo: false, role: "owner" },
] });
const DEAD = "This link does not work any more. It may have been used or expired. Ask for a new one.";
const UNDO_DEAD = "This link does not work any more. It may have been used already, or be more than 7 days old.";

beforeEach(() => {
  Object.assign(state, { lang: "en", me: undefined, meError: null, hooks: [], effects: [] });
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("settings, your account", () => {
  it("in the board's order: your name, Email with Change, Password, then the devices", () => {
    state.me = person(true);
    const words = account(render(Settings));
    const order = ["Your name", "morgan@example.test", "Change", "Password", "We send a link to your email to set a new one. The current one keeps working until you do.", "Send me a link", "Where you are signed in"];
    for (const s of order) expect(words).toContain(s);
    const at = order.map((s) => words.indexOf(s));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(input("ce-email")).toBeUndefined();
  });

  it("Change opens the form; a confirmed address says the old one will be told; the form posts /me/email; pending", async () => {
    state.me = person(true);
    render(Settings);
    await button("Change")!.props.onClick();
    const words = account(render(Settings));
    for (const s of ["New email address", "Your password", "Change my email", "Cancel", "We will also let morgan@example.test know, with a way to undo the change for 7 days."]) expect(words).toContain(s);
    expect(input("ce-email")!.props).toMatchObject({ type: "email", autoComplete: "email", name: "email" });
    expect(input("ce-password")!.props).toMatchObject({ type: "password", autoComplete: "current-password", name: "password" });
    vi.mocked(api.post).mockResolvedValueOnce({ pending: true });
    await submitChange({ email: "New@Example.test", password: "my password" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/me/email", { email: "New@Example.test", password: "my password" }]);
    expect(account(render(Settings))).toContain("We sent a link to New@Example.test. Your email stays morgan@example.test until you open it. The link works for 60 minutes.");
  });

  it("Cancel closes the form", async () => {
    state.me = person(true);
    render(Settings);
    await button("Change")!.props.onClick();
    render(Settings);
    await button("Cancel")!.props.onClick();
    render(Settings);
    expect(input("ce-email")).toBeUndefined();
  });

  it("an unconfirmed address changes at once: me is refreshed and the sentence says so", async () => {
    state.me = person(false);
    render(Settings);
    await button("Change")!.props.onClick();
    expect(account(render(Settings))).not.toContain("We will also let");
    vi.mocked(api.post).mockResolvedValueOnce({ changed: true });
    await submitChange({ email: "new@example.test", password: "my password" });
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
    expect(account(render(Settings))).toContain("Your email is now new@example.test. We sent a link there to confirm it.");
  });

  it("a refused change shows the API's sentence", async () => {
    state.me = person(true);
    render(Settings);
    await button("Change")!.props.onClick();
    render(Settings);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "That password is not right."));
    await submitChange({ email: "new@example.test", password: "wrong" });
    expect(account(render(Settings))).toContain("That password is not right.");
  });

  it("Password: Send me a link posts the person's own email and says where it went", async () => {
    state.me = person(true);
    render(Settings);
    await button("Send me a link")!.props.onClick();
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/reset/send", { email: "morgan@example.test" }]);
    expect(account(render(Settings))).toContain("We sent a link to morgan@example.test. It works for 60 minutes.");
  });

  it("French", async () => {
    state.lang = "fr";
    state.me = person(true);
    const words = account(render(Settings));
    for (const s of ["Modifier", "Mot de passe", "M'envoyer un lien"]) expect(words).toContain(s);
    await button("Modifier")!.props.onClick();
    const open = account(render(Settings));
    for (const s of ["Nouvelle adresse courriel", "Votre mot de passe", "Modifier mon courriel", "Annuler", "Nous en informerons aussi morgan@example.test"]) expect(open).toContain(s);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "That password is not right."));
    await submitChange({ email: "new@example.test", password: "wrong" });
    expect(account(render(Settings))).toContain("Ce mot de passe n'est pas le bon.");
    vi.mocked(api.post).mockResolvedValueOnce({ pending: true });
    await submitChange({ email: "new@example.test", password: "right" });
    expect(account(render(Settings))).toContain("Votre courriel reste morgan@example.test");
  });
});

describe("the verify page: use a different email", () => {
  it("signed in and not confirmed: Wrong address? Use a different email, which opens the same form", async () => {
    at("/verify");
    state.me = person(false);
    const words = text(render(Verify));
    expect(words).toContain("Wrong address? Use a different email .");
    expect(input("ce-email")).toBeUndefined();
    await button("Use a different email")!.props.onClick();
    expect(text(render(Verify))).toContain("Change my email");
    vi.mocked(api.post).mockResolvedValueOnce({ changed: true });
    await submitChange({ email: "right@example.test", password: "my password" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/me/email", { email: "right@example.test", password: "my password" }]);
    expect(state.invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
    // The page goes back to "We sent a link to <address>", which shows the refreshed address.
    state.me = { ...person(false), user: { ...person(false).user, email: "right@example.test" } };
    const after = text(render(Verify));
    expect(input("ce-email")).toBeUndefined();
    expect(after).toContain("We sent a link to right@example.test.");
  });

  it("confirmed: no way to change it here", () => {
    at("/verify");
    state.me = person(true);
    expect(text(render(Verify))).not.toContain("Use a different email");
  });

  it("French", () => {
    at("/verify");
    state.lang = "fr";
    state.me = person(false);
    const words = text(render(Verify));
    expect(words).toContain("Mauvaise adresse ?");
    expect(words).toContain("Utiliser une autre adresse");
  });
});

describe("the confirm and undo pages", () => {
  it("confirm: takes the token once, posts it once, then says the new address with a link to the deals", async () => {
    at("/email/confirm", "?token=tok-c");
    expect(text(render(EmailConfirm))).toContain("Changing your email address…");
    expect(replaceState.mock.calls[0]![2]).toBe("/email/confirm");
    vi.mocked(api.post).mockResolvedValueOnce({ email: "new@example.test" });
    for (const e of state.effects) await e();
    await settle();
    const html = render(EmailConfirm);
    expect(text(html)).toContain("Your email address is now new@example.test.");
    expect(links(html, "/deals")).toBe(true);
    expect(text(html)).toContain("Open your deals");
    expect(vi.mocked(api.post).mock.calls).toEqual([["/auth/email/confirm", { token: "tok-c" }]]);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it("undo: puts the address back, says every device was signed out, links to sign in", async () => {
    at("/email/undo", "?token=tok-u");
    expect(text(render(EmailUndo))).toContain("Putting your email address back…");
    vi.mocked(api.post).mockResolvedValueOnce({ email: "morgan@example.test" });
    for (const e of state.effects) await e();
    await settle();
    const html = render(EmailUndo);
    const words = text(html);
    expect(words).toContain("Your email address is back to morgan@example.test.");
    expect(words).toContain("We signed every device out and turned off the old password. We sent a link to morgan@example.test to choose a new one. It works for 60 minutes.");
    expect(words).toContain("Back to sign in");
    expect(links(html, "/login")).toBe(true);
    expect(vi.mocked(api.post).mock.calls).toEqual([["/auth/email/undo", { token: "tok-u" }]]);
  });

  it("a dead link: says it did not work, with the API's sentence and a way back to sign in", async () => {
    for (const [C, path, sentence] of [[EmailConfirm, "/email/confirm", DEAD], [EmailUndo, "/email/undo", UNDO_DEAD]] as const) {
      state.hooks = [];
      at(path, "?token=old");
      render(C);
      vi.mocked(api.post).mockRejectedValueOnce(new ApiError(400, sentence));
      for (const e of state.effects) await e();
      await settle();
      const html = render(C);
      expect(text(html)).toContain("This link did not work");
      expect(text(html)).toContain(sentence);
      expect(links(html, "/login")).toBe(true);
    }
  });

  it("French, including the server's sentences", async () => {
    state.lang = "fr";
    at("/email/confirm", "?token=tok-c");
    expect(text(render(EmailConfirm))).toContain("Modification de votre adresse courriel…");
    vi.mocked(api.post).mockResolvedValueOnce({ email: "new@example.test" });
    for (const e of state.effects) await e();
    await settle();
    expect(text(render(EmailConfirm))).toContain("Votre adresse courriel est maintenant new@example.test.");

    state.hooks = [];
    at("/email/undo", "?token=tok-u");
    expect(text(render(EmailUndo))).toContain("Rétablissement de votre adresse courriel…");
    vi.mocked(api.post).mockResolvedValueOnce({ email: "morgan@example.test" });
    for (const e of state.effects) await e();
    await settle();
    const undone = text(render(EmailUndo));
    expect(undone).toContain("Votre adresse courriel est de nouveau morgan@example.test.");
    expect(undone).toContain("Retour à la connexion");

    state.hooks = [];
    at("/email/undo", "?token=old");
    render(EmailUndo);
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(400, UNDO_DEAD));
    for (const e of state.effects) await e();
    await settle();
    const failed = text(render(EmailUndo));
    expect(failed).toContain("Ce lien n'a pas fonctionné");
    expect(failed).toContain("Ce lien ne fonctionne plus. Il a peut-être déjà servi, ou il date de plus de 7 jours.");

    const { err } = build("fr", vi.fn());
    expect(err(new ApiError(422, "That is already your email address."))).toBe("C'est déjà votre adresse courriel.");
    expect(err(new ApiError(429, "Too many attempts. Wait a while and try again."))).toBe("Trop de tentatives. Patientez un moment, puis réessayez.");
    expect(err(new ApiError(400, "That code is not right, or it has expired. Check the latest email or ask for a new code."))).toBe("Ce code n'est pas le bon, ou il a expiré. Vérifiez le dernier courriel ou demandez un nouveau code.");
  });
});
