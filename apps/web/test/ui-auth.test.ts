import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "../src/api";
import { Login, Signup } from "../src/routes/auth.tsx";
import { Invite } from "../src/routes/invite.tsx";
import { Share } from "../src/routes/share.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card W3: the signed-out screens. Mocks follow apps/web/test/clients.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, demo: undefined as unknown, me: undefined as unknown, meError: null as unknown,
  invite: undefined as unknown, inviteError: null as unknown, shared: undefined as unknown, shareError: null as unknown,
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}), navigate: vi.fn(), setLang: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "demo" ? { data: state.demo } : key === "me" ? { data: state.me, error: state.meError }
      : key === "invite" ? { data: state.invite, error: state.inviteError } : key === "share" ? { data: state.shared, error: state.shareError } : {};
  },
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, state.setLang) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, to }: { children: unknown; to: string }) => createElement("a", { href: to }, children as string), useNavigate: () => state.navigate };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api,
    get: vi.fn(async () => ({ deal: { id: "deal-1", workspace_id: "ws-client" } })),
    post: vi.fn(async (path: string) => path.endsWith("/accept") ? { ok: true, dealId: "deal-1" } : { ok: true }),
  } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "input", "a", "form", "label"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => { state.index = 0; state.nodes = []; return renderToStaticMarkup(el); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const buttons = (label: string) => state.nodes.filter((n) => n.tag === "button" && n.props.children === label);
const labelled = (id: string) => state.nodes.some((n) => n.tag === "label" && n.props.htmlFor === id) && state.nodes.some((n) => n.tag === "input" && n.props.id === id);
const submit = async (values: Record<string, string>) => {
  const form = state.nodes.find((n) => n.tag === "form")!;
  await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { elements: { namedItem: (k: string) => ({ value: values[k] }) } } });
};
const secret = "s3cret-value";

beforeEach(() => {
  Object.assign(state, { lang: "en", demo: undefined, me: undefined, meError: null, invite: undefined, inviteError: null, shared: undefined, shareError: null, hooks: [] });
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("sign in", () => {
  it("has labelled email and password fields, a link to create an account, the language switch, and the reset link (card W12)", () => {
    const html = render(createElement(Login));
    expect(labelled("email")).toBe(true);
    expect(labelled("password")).toBe(true);
    const words = text(html);
    for (const s of ["Sign in", "Welcome back.", "Email", "Password", "Create an account", "Every number traces to a document"]) expect(words).toContain(s);
    expect(html).toContain('href="/signup"');
    expect(words).toContain("Forgot your password?");
    expect(html).toContain('href="/reset"');
    expect(words).not.toMatch(/terms/i);
    expect(html).toContain("split");
    expect(buttons("Français").length).toBe(1);
  });
  it("posts the email and password, then opens the deals", async () => {
    render(createElement(Login));
    await submit({ email: "a@example.test", password: "a-long-password" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/login", { email: "a@example.test", password: "a-long-password" }]);
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals" });
  });
  it("shows the API's error", async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(401, "Wrong email or password."));
    render(createElement(Login));
    await submit({ email: "a@example.test", password: "nope-nope-nope" });
    expect(text(render(createElement(Login)))).toContain("Wrong email or password.");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("shows the demo sign-in only where it is available", async () => {
    state.demo = { available: false };
    expect(text(render(createElement(Login)))).not.toContain("Local demo");
    state.demo = { available: true };
    expect(text(render(createElement(Login)))).toContain("Local demo");
    await buttons("Continue as Rowan Reviewer")[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/demo", { who: "reviewer" }]);
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals" });
  });
  it("French", () => {
    state.lang = "fr";
    const words = text(render(createElement(Login)));
    for (const s of ["Se connecter", "Courriel", "Mot de passe", "Créer un compte"]) expect(words).toContain(s);
    expect(buttons("English").length).toBe(1);
  });
});

describe("create an account", () => {
  it("has labelled name, email and password fields and the review-mode choice, solo by default", () => {
    const html = render(createElement(Signup));
    const words = text(html);
    for (const id of ["name", "email", "password"]) expect(labelled(id)).toBe(true);
    for (const s of ["Create an account", "Your name", "At least 10 characters.", "How are values reviewed?", "On my own", "With a team", "I have an account"]) expect(words).toContain(s);
    const radios = state.nodes.filter((n) => n.tag === "input" && n.props.type === "radio");
    expect(radios.map((r) => [r.props.name, r.props.value, Boolean(r.props.checked)])).toEqual([["reviewMode", "solo", true], ["reviewMode", "team", false]]);
    expect(words).not.toMatch(/forgot|terms/i);
    expect(html).toContain('href="/login"');
    expect(buttons("Français").length).toBe(1);
  });
  it("posts the chosen review mode, then asks to confirm the email address (card W12)", async () => {
    render(createElement(Signup));
    state.nodes.find((n) => n.tag === "input" && n.props.value === "team")!.props.onChange();
    render(createElement(Signup));
    await submit({ name: "Dana", email: "d@example.test", password: "a-long-password" });
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(["/auth/signup", { name: "Dana", email: "d@example.test", password: "a-long-password", reviewMode: "team" }]);
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/verify" });
  });
  it("French", () => {
    state.lang = "fr";
    const words = text(render(createElement(Signup)));
    for (const s of ["Votre nom", "Seul", "En équipe", "J'ai déjà un compte"]) expect(words).toContain(s);
  });
});

describe("the invitation page", () => {
  const page = () => text(render(createElement(Invite, { secret })));
  it("signed out: names the workspace and the deal, with labelled fields and the language switch", () => {
    state.invite = { workspace: "Harbour Brokers", deal: "Elm Street fourplex" };
    state.meError = new ApiError(401, "Sign in to continue.");
    const html = render(createElement(Invite, { secret }));
    const words = text(html);
    for (const s of ["An invitation from Harbour Brokers", "Elm Street fourplex", "as a client", "Create my account", "This link works once."]) expect(words).toContain(s);
    for (const id of ["name", "email", "password"]) expect(labelled(id)).toBe(true);
    expect(html).toContain('href="/login"');
    expect(buttons("Français").length).toBe(1);
  });
  it("signed in: offers to join", () => {
    state.invite = { workspace: "Harbour Brokers", deal: "Elm Street fourplex" };
    state.me = { user: { id: "me", name: "Dana" }, workspaces: [] };
    expect(page()).not.toContain("Create my account");
    expect(buttons("Join as a client").length).toBe(1);
  });
  it("a used, revoked or expired link shows the API's sentence, with the language switch", () => {
    state.inviteError = new ApiError(404, "This invitation is not available. It may have been used, revoked or expired.");
    expect(page()).toContain("This invitation is not available. It may have been used, revoked or expired.");
    expect(buttons("Français").length).toBe(1);
  });
  it("French", () => {
    state.lang = "fr";
    state.invite = { workspace: "Harbour Brokers", deal: "Elm Street fourplex" };
    state.meError = new ApiError(401, "x");
    const words = page();
    for (const s of ["Une invitation de Harbour Brokers", "Créer mon compte"]) expect(words).toContain(s);
  });
});

describe("the shared-link page", () => {
  const page = () => text(render(createElement(Share, { secret })));
  it("shows the deal, the report, its run, read-only and the expiry from the API", () => {
    state.shared = { deal: "Shared reference", kind: "lender_package", format: "docx", runNumber: 3, expiresAt: "2099-10-19T12:00:00Z" };
    const words = page();
    for (const s of ["Shared reference", "Lender package", "Word", "Run 3", "Shared from Agir. Read-only.", "This link expires on", "Download the audit package"]) expect(words).toContain(s);
    expect(buttons("Français").length).toBe(1);
  });
  it("says on the verdict card when the shared run's policy is not signed by credit (card E)", () => {
    const verdict = { code: "APPROVE", gates: [], hardFailReasons: [], headline: "Invented headline", explanation: "" };
    const shared = { deal: "Shared reference", kind: "lender_package", format: "docx", runNumber: 3, expiresAt: null, verdict, errorChecks: 0, figures: [] };
    state.shared = { ...shared, policyDraft: false, policySigned: false };
    expect(page()).toContain("The policy is not yet signed by credit.");
    state.shared = { ...shared, policyDraft: true, policySigned: false };
    expect(page()).toContain("The policy is a draft, not yet signed by credit.");
    expect(page()).not.toContain("The policy is not yet signed by credit.");
    state.shared = { ...shared, policyDraft: false, policySigned: true };
    expect(page()).not.toContain("signed by credit");
    state.lang = "fr"; state.shared = { ...shared, policyDraft: false, policySigned: false };
    expect(page()).toContain("La politique n'est pas encore approuvée par le crédit.");
  });
  it("says when the link does not expire", () => {
    state.shared = { deal: "Shared reference", kind: "model_export", format: "xlsx", runNumber: 1, expiresAt: null };
    expect(page()).toContain("This link does not expire.");
  });
  it("an expired or revoked link shows the API's sentence, with the language switch", () => {
    state.shareError = new ApiError(404, "This link is not available. It may have expired or been revoked.");
    expect(page()).toContain("This link is not available. It may have expired or been revoked.");
    expect(buttons("Français").length).toBe(1);
  });
  it("French", () => {
    state.lang = "fr";
    state.shared = { deal: "Shared reference", kind: "lender_package", format: "docx", runNumber: 3, expiresAt: null };
    const words = page();
    for (const s of ["Dossier pour le prêteur", "Partagé depuis Agir. Lecture seule.", "Ce lien n'expire pas."]) expect(words).toContain(s);
    expect(build("fr", () => {}).t("nav.language")).toBe("English");
  });
});
