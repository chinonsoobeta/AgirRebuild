import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DealOverview, Me } from "../src/api";
import { build, I18nProvider } from "../src/i18n.tsx";
import { DealFrame, DealPath, SessionGate, Shell, pathStates } from "../src/components/ui.tsx";
import { THEME_KEY, themeStore, useTheme } from "../src/theme.ts";

// Card F2: the top bar, the deal frame and its path. Mocks follow apps/web/test/run.test.ts.
const state = vi.hoisted(() => ({ me: undefined as unknown, path: "/deals" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "me" ? { data: state.me, isLoading: false, error: null } : {}),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {}, clear: () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: { dealId?: string } }) =>
      createElement("a", { href: params?.dealId ? to.replace("$dealId", params.dealId) : to, ...rest }, children),
    useNavigate: () => () => {},
    useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) => select({ location: { pathname: state.path } }),
  };
});

let store: Map<string, string>;
let storageThrows = false;
beforeEach(() => {
  store = new Map();
  storageThrows = false;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => { if (storageThrows) throw new Error("blocked"); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (storageThrows) throw new Error("blocked"); store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal("matchMedia", (q: string) => ({ media: q, matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("document", { documentElement: { dataset: {}, lang: "en" } });
  state.path = "/deals";
});
afterEach(() => { vi.unstubAllGlobals(); });

type Role = Me["workspaces"][number]["role"];
const workspace = (id: string, name: string, role: Role = "owner"): Me["workspaces"][number] => ({ id, name, review_mode: "team", label_suggestions: false, has_logo: false, role });
const me = (workspaces: Me["workspaces"]): Me => ({ user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace", email_verified: true }, workspaces });
const render = (node: ReactNode, who: Me = me([workspace("w1", "First workspace")])) => {
  state.me = who;
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(SessionGate, null, node)));
};

// ---- Overview fixtures ---------------------------------------------------------------------------
const base: DealOverview = {
  deal: { id: "d1", workspace_id: "w1", name: "Test deal", asset_type: "multifamily", location: "Halifax", currency: "CAD", country: "CA", province: "NS", created_at: "2026-10-01" },
  copiedFrom: null, step: "documents", status: { tone: "neutral", text: "" }, next: "",
  documents: { total: 0, processing: 0, failed: 0 }, updating: false,
  review: { approved: 0, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "blocked" },
  run: null, decision: null, reports: 0,
};
const nothingYet = base;
const reviewBlocked: DealOverview = { ...base, step: "review", documents: { total: 3, processing: 0, failed: 0 }, review: { ...base.review, approved: 5, conflicting: 2, missing: 1 } };
const runOutOfDate: DealOverview = { ...base, step: "run", documents: { total: 3, processing: 0, failed: 0 }, review: { ...base.review, approved: 9, status: "ready" },
  run: { id: "r1", number: 2, verdict: "APPROVE", fresh: false, createdAt: "2026-10-02" } };
const decided: DealOverview = { ...base, step: "reports", documents: { total: 3, processing: 0, failed: 0 }, review: { ...base.review, approved: 9, status: "ready" },
  run: { id: "r1", number: 2, verdict: "APPROVE", fresh: true, createdAt: "2026-10-02" }, decision: { decision: "proceed", created_at: "2026-10-03" }, reports: 2 };

const en = build("en", () => {});
const steps = (out: string) => [...out.matchAll(/<a [^>]*class="step[^"]*"[^>]*>.*?<\/a>/g)].map((m) => m[0]);

describe("the top bar", () => {
  it("has the brand, both nav links with the current one marked, and the main page", () => {
    const out = render(createElement(Shell, null, "content"));
    expect(out).toContain('<header class="topbar">');
    expect(out).toMatch(/<a href="\/deals" class="brand"[^>]*>.*Agir<\/a>/);
    expect(out).toMatch(/<nav class="nav" aria-label="Main">/);
    expect(out).toMatch(/<a href="\/deals" class="current" aria-current="page">Deals<\/a>/);
    expect(out).toMatch(/<a href="\/settings"[^>]*>Settings<\/a>/);
    expect(out).not.toMatch(/<a href="\/settings"[^>]*aria-current/);
    expect(out).toContain('<main class="page" id="main-content" tabindex="-1">content</main>');
    expect(out).not.toContain('class="rail"');
  });

  it("marks Settings as current on the settings page", () => {
    state.path = "/settings/team";
    const out = render(createElement(Shell, null, "x"));
    expect(out).toMatch(/<a href="\/settings" class="current" aria-current="page">Settings<\/a>/);
    expect(out).not.toMatch(/<a href="\/deals" class="current"/);
  });

  it("shows one workspace as text, the language switch, the theme toggle, the person's name and role, and sign out", () => {
    const out = render(createElement(Shell, null, "x"));
    expect(out).toContain('<div class="topbar-right">');
    expect(out).toContain("First workspace");
    expect(out).not.toContain("<select");
    expect(out).toMatch(/<button type="button" class="toplink" lang="fr">Français<\/button>/);
    expect(out).toContain('aria-label="Switch to dark mode"');
    expect(out).toMatch(/<span class="avatar" aria-hidden="true">AL<\/span>/);
    expect(out).toContain("Ada Lovelace · owner");
    expect(out).toMatch(/<button type="button" class="toplink">Sign out<\/button>/);
  });

  it("offers a labelled switcher when there are several workspaces", () => {
    const out = render(createElement(Shell, null, "x"), me([workspace("w1", "First workspace"), workspace("w2", "Second workspace", "analyst")]));
    expect(out).toMatch(/<label class="sr-only" for="ws-select">Workspace<\/label>/);
    expect(out).toMatch(/<select id="ws-select" class="ws">/);
    expect(out).toContain(">Second workspace</option>");
  });

  it("speaks French", () => {
    store.set("agir.lang", "fr");
    const out = render(createElement(Shell, null, "x"));
    expect(out).toContain(">Projets</a>");
    expect(out).toContain('lang="en">English</button>');
    expect(out).toContain("Se déconnecter");
    expect(out).toContain('aria-label="Principal"');
  });
});

describe("the deal path", () => {
  it("nothing yet: no step done, Documents is where the deal is", () => {
    const st = pathStates(nothingYet, en, false);
    expect(st.map((s) => s.key)).toEqual(["documents", "review", "run", "decision", "reports"]);
    expect(st.map((s) => s.tone)).toEqual(["faint", "faint", "faint", "faint", "faint"]);
    expect(st[0]!.text).toBe("No documents");
    expect(st[2]!.text).toBe("Locked until review is clear");
    const out = render(createElement(DealPath, { o: nothingYet, active: "documents" }));
    expect(out).toMatch(/<ol class="path" aria-label="Deal steps">/);
    const s = steps(out);
    expect(s).toHaveLength(5);
    expect(s[0]).toMatch(/class="step now here" aria-current="step"/);
    expect(out).not.toContain("step done");
    expect(out).not.toMatch(/>0[1-5]</);
    expect(out).toContain('<span class="step-name">Review</span>');
  });

  it("review blocked: documents done with a check, review shows its block in the stop colour", () => {
    const st = pathStates(reviewBlocked, en, false);
    expect(st[0]).toMatchObject({ tone: "done", text: "3 read" });
    expect(st[1]).toMatchObject({ tone: "stop", text: "Blocked · 2 conflicts, 1 missing" });
    const out = render(createElement(DealPath, { o: reviewBlocked, active: "documents" }));
    const s = steps(out);
    expect(s[0]).toMatch(/class="step done here" aria-current="step"/);
    expect(s[0]).toMatch(/<span class="marker"><svg/);
    expect(s[1]).toMatch(/class="step now"/);
    expect(s[1]).not.toContain("aria-current");
    expect(s[1]).toMatch(/<span class="step-state stop"><svg[^>]*>.*<\/svg>Blocked · 2 conflicts, 1 missing<\/span>/);
    expect(s[2]).toMatch(/<span class="marker"><\/span>/);
  });

  it("run out of date: the run step shows it in the stop colour", () => {
    const st = pathStates(runOutOfDate, en, false);
    expect(st[1]).toMatchObject({ tone: "done", text: "Clear" });
    expect(st[2]).toMatchObject({ tone: "stop", text: "Run 2 · out of date" });
    expect(st[3]).toMatchObject({ tone: "faint", text: "Waiting" });
    const s = steps(render(createElement(DealPath, { o: runOutOfDate, active: "run" })));
    expect(s[2]).toMatch(/class="step now here" aria-current="step"/);
    expect(s[2]).toContain('class="step-state stop"');
  });

  it("decided with reports: every step done, reports where the deal is", () => {
    const st = pathStates(decided, en, false);
    expect(st.map((s) => s.tone)).toEqual(["done", "done", "done", "done", "done"]);
    expect(st[4]!.text).toBe("2 ready");
    const s = steps(render(createElement(DealPath, { o: decided, active: "decision" })));
    expect(s[3]).toMatch(/class="step done here" aria-current="step"/);
    expect(s[4]).toMatch(/class="step done now"/);
    expect(s.join("")).not.toContain("step-state stop");
  });
});

describe("the deal frame", () => {
  it("has the back link, the name, the meta line and the actions", () => {
    const out = render(createElement(DealFrame, { o: { ...decided, copiedFrom: { id: "d0", name: "Original" } }, active: "run" }));
    expect(out).toMatch(/<div class="deal-head">/);
    expect(out).toMatch(/<a href="\/deals" class="back"><svg[^>]*>.*<\/svg>All deals<\/a>/);
    expect(out).toContain('<h1 class="deal-name">Test deal</h1>');
    expect(out).toMatch(/<p class="meta">[^<]+ · [^<]+<\/p>/);
    expect(out).toContain("Variant of");
    expect(out).toContain(">Original</a>");
    expect(out).toMatch(/<a href="\/deals\/d1\/explore" class="btn quiet sm">Explore changes<\/a>/);
    expect(out).toMatch(/<a href="\/deals\/d1\/audit" class="btn quiet sm">Audit trail<\/a>/);
    expect(out).toMatch(/<button class="btn quiet sm" type="button">Copy as a variant<\/button>/);
    expect(out).toContain('<ol class="path"');
    expect(out).toContain('aria-labelledby="copy-deal-title"');
  });

  it("hides Explore changes without a run", () => {
    const out = render(createElement(DealFrame, { o: reviewBlocked, active: "review" }));
    expect(out).not.toContain("Explore changes");
    expect(out).toContain("Audit trail");
  });

  it("hides Copy as a variant from a viewer", () => {
    const out = render(createElement(DealFrame, { o: decided, active: "run" }), me([workspace("w1", "First workspace", "viewer")]));
    expect(out).not.toContain("Copy as a variant</button>");
    expect(out).toContain("Explore changes");
  });

  it("speaks French", () => {
    store.set("agir.lang", "fr");
    const out = render(createElement(DealFrame, { o: decided, active: "run" }));
    expect(out).toContain("Tous les projets");
    expect(out).toContain("Explorer des changements");
  });
});

describe("one theme for the whole page", () => {
  it("a change made through one subscriber is seen by every other", () => {
    let first: ReturnType<typeof useTheme> | undefined;
    const Probe = () => { first = useTheme(); return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(first?.theme).toBe("light");
    const seen: string[][] = [[], []];
    const stops = seen.map((log) => themeStore.subscribe(() => log.push(themeStore.getSnapshot().theme)));
    first!.setPref("dark");
    expect(seen).toEqual([["dark"], ["dark"]]);
    expect(store.get(THEME_KEY)).toBe("dark");
    let second: ReturnType<typeof useTheme> | undefined;
    const Other = () => { second = useTheme(); return null; };
    renderToStaticMarkup(createElement(Other));
    expect(second).toMatchObject({ pref: "dark", theme: "dark" });
    stops.forEach((stop) => stop());
    first!.setPref("light");
    expect(seen).toEqual([["dark"], ["dark"]]);
  });

  it("keeps the choice for the tab when storage is blocked", () => {
    storageThrows = true;
    themeStore.setPref("dark");
    let got: ReturnType<typeof useTheme> | undefined;
    const Probe = () => { got = useTheme(); return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(got).toMatchObject({ pref: "dark", theme: "dark" });
    themeStore.setPref("light");
  });
});
