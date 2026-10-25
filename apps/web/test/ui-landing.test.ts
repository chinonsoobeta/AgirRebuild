import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/api";
import { type Lang } from "../src/i18n.tsx";
import { Home, Landing, homeDecision } from "../src/routes/landing.tsx";
import { Legal } from "../src/routes/legal.tsx";

const state = vi.hoisted(() => ({ lang: "en" as "en" | "fr", me: {} as { isLoading?: boolean; data?: unknown; error?: unknown } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "me" ? state.me : {}),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ to, hash, children, ...rest }: { to: string; hash?: string; children: unknown }) => createElement("a", { ...rest, href: hash ? `${to}#${hash}` : to }, children as string),
    Navigate: ({ to }: { to: string }) => createElement("meta", { "data-navigate": to }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang as Lang, () => {}) };
});

const html = (c: () => React.JSX.Element, lang: "en" | "fr" = "en") => {
  state.lang = lang;
  return renderToStaticMarkup(createElement(c));
};
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("the landing page", () => {
  it("has the hero, the five steps, the documents, the Canadian rules, the engine, the questions and a footer", () => {
    const out = html(Landing);
    for (const id of ["how", "get", "canada", "engine", "questions"]) expect(out).toContain(`id="${id}"`);
    const words = text(out);
    expect(words).toContain("Decide whether to build, with numbers a lender can check.");
    expect(words).toContain("Five steps, in the order a lender would ask for them");
    expect(words).toContain("Three documents from one run");
    expect(words).toContain("Built for Canadian deals");
    expect(words).toContain("Only the engine makes numbers");
    expect(words).toContain("Questions people ask first");
    for (const step of ["Documents", "Review", "Run", "Decision", "Reports"]) expect(words).toContain(step);
    expect(out).toContain("<footer");
  });

  it("links to sign in and to start a deal, and its footer to the terms and the privacy notice", () => {
    const out = html(Landing);
    expect(out).toMatch(/<a[^>]*href="\/login"[^>]*>Sign in<\/a>/);
    expect(out).toMatch(/<a[^>]*href="\/signup"[^>]*>Start a deal/);
    expect(out).toMatch(/href="\/legal#terms"[^>]*>Terms</);
    expect(out).toMatch(/href="\/legal#privacy"[^>]*>Privacy</);
    expect(out).toContain('aria-label="Switch to dark mode"');
    const fr = html(Landing, "fr");
    expect(fr).toMatch(/href="\/login"[^>]*>Se connecter<\/a>/);
    expect(fr).toMatch(/href="\/signup"[^>]*>Lancer un projet/);
  });

  it("shows no price and claims no Canadian storage, in either language, on either page", () => {
    for (const page of [Landing, Legal]) {
      for (const lang of ["en", "fr"] as const) {
        const words = text(html(page, lang));
        expect(words).not.toMatch(/\$\s?\d|\d[\s ]?\$|C\$|\b99\b/);
        expect(words).not.toMatch(/(stored|stay|kept|backed up)[^.]*\bin canada|canadian region|canada region/i);
        expect(words).not.toMatch(/(stockée?s?|restent|conservée?s?|sauvegardée?s?)[^.]*\bau canada|région canadienne/i);
        expect(words).not.toMatch(/pipeda|stripe/i);
      }
    }
  });

  it("shows no sample deal's figures", () => {
    const words = text(html(Landing));
    expect(words).not.toMatch(/\d+(\.\d+)?\s?%|\bbps\b|Tamarack/);
  });
});

describe("the terms and privacy page", () => {
  it("opens with the draft notice in English and in French, whatever the language", () => {
    for (const lang of ["en", "fr"] as const) {
      const out = html(Legal, lang);
      const words = text(out);
      expect(words).toContain("This is a draft. A lawyer and a translator have not reviewed it yet, and it does not apply until they have.");
      expect(words).toContain("Ceci est une ébauche. Un avocat et un traducteur ne l'ont pas encore révisée, et elle ne s'applique pas avant qu'ils l'aient fait.");
      expect(out.indexOf("Ceci est une ébauche")).toBeLessThan(out.indexOf('id="terms"'));
    }
  });

  it("has a table of contents and the terms and privacy anchors the footer links to", () => {
    const out = html(Legal);
    expect(out).toContain('id="terms"');
    expect(out).toContain('id="privacy"');
    expect(out).toMatch(/<nav[^>]*aria-label="On this page"/);
    expect(out).toContain('href="#privacy"');
    expect(text(html(Legal, "fr"))).toContain("Conditions et confidentialité");
  });

  it("writes what is not settled as to be settled, not as a fact", () => {
    const words = text(html(Legal));
    expect(words).toMatch(/To be settled/);
    expect(words).not.toMatch(/30 days|Ontario|privacy@/);
  });
});

describe("the signed-out home", () => {
  it("decides from the session: signed in goes to the deals, a 401 shows the landing page, loading shows nothing", () => {
    expect(homeDecision({ isLoading: true })).toBe("wait");
    expect(homeDecision({ isLoading: false, data: { user: {}, workspaces: [] } })).toBe("deals");
    expect(homeDecision({ isLoading: false, error: new ApiError(401, "Sign in to continue.") })).toBe("landing");
    expect(homeDecision({ isLoading: false, error: new ApiError(500, "Down") })).toBe("deals");
  });

  it("renders the redirect, the landing page or nothing", () => {
    state.me = { isLoading: false, data: { user: { id: "u", email: "a@b.c", name: "A" }, workspaces: [] } };
    expect(html(Home)).toBe('<meta data-navigate="/deals"/>');
    state.me = { isLoading: false, error: new ApiError(401, "Sign in to continue.") };
    expect(text(html(Home))).toContain("Decide whether to build");
    state.me = { isLoading: true };
    expect(html(Home)).toBe("");
  });
});
