/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { THRESHOLDS } from "@agir/contracts";
import type { Me } from "../src/api";
import { build, I18nProvider } from "../src/i18n.tsx";
import { ErrorText, MetricValue, SessionGate, Shell } from "../src/components/ui.tsx";
import { Thresholds } from "../src/components/thresholds.tsx";

// Card U20: the old styles are gone, the thresholds editor is on base classes, the shell has a skip link.
const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const state = vi.hoisted(() => ({ me: undefined as unknown, thresholds: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "me" ? { data: state.me, isLoading: false, error: null } : key === "thresholds" ? { data: state.thresholds, error: null } : {};
  },
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {}, clear: () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: { dealId?: string } }) =>
      createElement("a", { href: params?.dealId ? to.replace("$dealId", params.dealId) : to, ...rest }, children),
    useNavigate: () => () => {},
    useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) => select({ location: { pathname: "/deals" } }),
  };
});

let store: Map<string, string>;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  vi.stubGlobal("matchMedia", (q: string) => ({ media: q, matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("document", { documentElement: { dataset: {}, lang: "en" } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const who: Me = { user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace" },
  workspaces: [{ id: "w1", name: "First workspace", review_mode: "team", label_suggestions: false, has_logo: false, role: "owner" }] };
const render = (node: ReactNode) => {
  state.me = who;
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(SessionGate, null, node)));
};
const classes = (html: string) => [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean));
const definedInBase = (cls: string) => new RegExp(`\\.${cls.replace(/[-]/g, "\\-")}(?![\\w-])`).test(base);

const thresholds = () => {
  const version = "rental-hold-insured-draft";
  const row = THRESHOLDS[version]!.find((r) => r.path === "gates.dcrAfterRefinanceMin")!;
  state.thresholds = {
    policies: [{ version, thresholds: [{ ...row, value: 1.05, layer: "deal", looser: true, stressRemoved: true,
      workspace: { value: 1.05, setBy: "owner", setByName: "Dana Analyst", setAt: "2026-10-19T12:00:00Z", reason: "Owner credit decision" },
      deal: { value: 1.05, setBy: "owner", setByName: "Dana Analyst", setAt: "2026-10-19T12:00:00Z", reason: "Owner credit decision" } }] }],
    invalid: [{ version, path: "gates.removedGateMin", layer: "deal", value: 1, setById: "owner", setByName: "Dana Analyst", setAt: "2026-10-19T12:00:00Z",
      reason: "Set before a draft edit", error: { en: "This policy path cannot be changed.", fr: "Ce paramètre de politique ne peut pas être modifié." } }],
  };
};

describe("the thresholds editor on base classes", () => {
  it("renders no legacy class, and every class it renders is in base.css", () => {
    thresholds();
    const html = render(createElement(Thresholds, { scope: "deals", id: "d1" }));
    const used = classes(html);
    for (const old of ["panel", "tbl", "h-section", "why"]) expect(used).not.toContain(old);
    for (const m of html.matchAll(/<button[^>]*class="([^"]*)"/g)) expect(m[1]!.split(" ")).not.toContain("small");
    expect(html).toContain('value="save"');
    expect(html).toContain('value="clear-invalid"');
    expect(used.filter((c) => !definedInBase(c))).toEqual([]);
  });

  it("says Thresholds by default (Run) and takes another summary where the screen already titles it", () => {
    thresholds();
    expect(render(createElement(Thresholds, { scope: "deals", id: "d1" }))).toMatch(/<summary[^>]*>Thresholds<\/summary>/);
    const en = build("en", () => {}), fr = build("fr", () => {});
    expect(en.t("thresholds.show")).toBe("Show the thresholds");
    expect(fr.t("thresholds.show")).toBe("Afficher les seuils");
    const html = render(createElement(Thresholds, { scope: "workspaces", id: "w1", summary: en.t("thresholds.show") }));
    expect(html).toMatch(/<summary[^>]*>Show the thresholds<\/summary>/);
    expect(html).not.toMatch(/<summary[^>]*>Thresholds<\/summary>/);
  });
});

describe("error text and metric values", () => {
  it("ErrorText is an alert styled by base.css", () => {
    const html = render(createElement(ErrorText, { error: new Error("Something failed") }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something failed");
    expect(classes(html).length).toBeGreaterThan(0);
    expect(classes(html).filter((c) => !definedInBase(c))).toEqual([]);
  });

  it("MetricValue says Not meaningful or Not applicable with classes base.css defines", () => {
    const nm = render(createElement(MetricValue, { value: null, unit: "%", status: "NOT_MEANINGFUL" }));
    const na = render(createElement(MetricValue, { value: null, unit: "%", status: "NOT_APPLICABLE" }));
    expect(nm).toContain("Not meaningful");
    expect(na).toContain("Not applicable");
    for (const html of [nm, na]) {
      expect(classes(html).length).toBeGreaterThan(0);
      expect(classes(html).filter((c) => !definedInBase(c))).toEqual([]);
    }
  });
});

describe("the skip link", () => {
  const firstFocusable = (html: string) => html.match(/<(a|button|select|input|textarea)\b[^>]*>[^<]*/)![0];
  it("is the shell's first focusable element and points at the main element", () => {
    const html = render(createElement(Shell, null, "content"));
    const first = firstFocusable(html);
    const target = first.match(/href="#([^"]+)"/)![1]!;
    expect(first).toContain("Skip to the main content");
    expect(html).toMatch(new RegExp(`<main[^>]*id="${target}"[^>]*>`));
    expect(html.match(/<main[^>]*>/)![0]).toContain('tabindex="-1"');
    expect(first.match(/class="([^"]*)"/)?.[1]).toBeTruthy();
  });

  it("speaks French", () => {
    store.set("agir.lang", "fr");
    const html = render(createElement(Shell, null, "contenu"));
    expect(firstFocusable(html)).toContain("Passer au contenu principal");
  });
});

describe("the old styles", () => {
  it("styles.css no longer imports legacy.css", () => {
    expect(entry).not.toContain("legacy.css");
    expect(entry).toContain("base.css");
  });

  it("base.css stops motion for people who ask for less", () => {
    expect(base).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});
