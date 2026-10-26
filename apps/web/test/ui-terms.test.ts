import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GATES, METRICS } from "@agir/contracts";
import type { Lang } from "../src/i18n.tsx";

// Card X1: finance terms, plain words first or finance terms first. The preference is kept on
// this device under "agir.terms"; L.metric, L.gate and the glossary follow it.
const state = vi.hoisted(() => ({ lang: "en" as Lang }));
vi.mock("@tanstack/react-query", () => ({
  useQueries: () => [],
  // Lists answer empty; the workspace counts have not answered (they are an object, not a list).
  useQuery: (o: { queryKey: unknown[] }) => (o.queryKey[0] === "deal-metrics" ? {} : { data: [] }),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  return {
    ...ui,
    useSession: () => ({
      solo: true, role: "owner", workspaceId: "ws", setWorkspace: () => {},
      me: { user: { id: "me", name: "Morgan Owner", email: "morgan@example.test" }, workspaces: [
        { id: "ws", name: "Elm Street", review_mode: "solo", label_suggestions: true, ai_reading: true, has_logo: false, role: "owner" },
      ] },
    }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children, className }: { to: string; children: unknown; className?: string }) => createElement("a", { href: to, className }, children as string) };
});

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}
const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {}, clear: () => {} };

beforeEach(() => { state.lang = "en"; });
afterEach(async () => {
  vi.unstubAllGlobals();
  (await import("../src/terms")).termsStore.reset();
});

describe("the finance terms preference", () => {
  it("is plain words by default", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { termsStore, TERMS_KEY } = await import("../src/terms");
    expect(TERMS_KEY).toBe("agir.terms");
    expect(termsStore.getSnapshot()).toBe("plain");
  });

  it("is kept on this device", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    const { termsStore } = await import("../src/terms");
    termsStore.setPref("finance");
    expect(storage.getItem("agir.terms")).toBe("finance");
    expect(termsStore.getSnapshot()).toBe("finance");
    termsStore.reset();
    expect(termsStore.getSnapshot()).toBe("finance");
    storage.setItem("agir.terms", "nonsense");
    expect(termsStore.getSnapshot()).toBe("plain");
  });

  it("survives a storage that throws", async () => {
    vi.stubGlobal("localStorage", throwing);
    const { termsStore } = await import("../src/terms");
    expect(termsStore.getSnapshot()).toBe("plain");
    expect(() => termsStore.setPref("finance")).not.toThrow();
    expect(termsStore.getSnapshot()).toBe("finance");
  });

  it("tells every subscriber at once", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { termsStore } = await import("../src/terms");
    const a = vi.fn(), b = vi.fn();
    const stopA = termsStore.subscribe(a), stopB = termsStore.subscribe(b);
    termsStore.setPref("finance");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA(); stopB();
  });
});

describe("metric and gate names follow the preference", () => {
  it("gives the plain name by default and the finance name after switching, in English", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { build } = await import("../src/i18n");
    const { termsStore } = await import("../src/terms");
    const plain = build("en", () => {});
    expect(plain.terms).toBe("plain");
    expect(plain.L.metric("stabilized_noi")).toBe("Stabilized net operating income");
    expect(plain.L.metric("required_equity")).toBe("Equity required");
    expect(plain.L.metric("dcr_after_refinance")).toBe("Coverage after refinancing");
    expect(plain.L.metric("unrealized_equity_multiple")).toBe("Unrealized equity multiple");
    expect(plain.L.metric("sizing_dscr")).toBe("Coverage (weakest year)");
    expect(plain.L.metric("total_development_cost")).toBe("Total development cost");
    expect(plain.L.gate("dcr_after_refinance", "Coverage after refinance (DCR)")).toBe("Coverage after refinancing");
    expect(plain.L.gate("unknown_gate", "Some gate")).toBe("Some gate");
    termsStore.setPref("finance");
    const finance = build("en", () => {});
    expect(finance.terms).toBe("finance");
    expect(finance.L.metric("stabilized_noi")).toBe("Stabilized NOI");
    expect(finance.L.metric("required_equity")).toBe("Required equity");
    expect(finance.L.metric("sizing_dscr")).toBe("Sizing DCR (weakest year)");
    expect(finance.L.gate("dcr_after_refinance", "x")).toBe("Coverage after refinance (DCR)");
  });

  it("gives the plain name by default and the finance name after switching, in French", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { build } = await import("../src/i18n");
    expect(build("fr", () => {}).L.metric("stabilized_noi")).toBe("Revenu net d'exploitation stabilisé");
    expect(build("fr", () => {}).L.metric("dcr_after_refinance")).toBe("Couverture après refinancement");
    expect(build("fr", () => {}, "finance").L.metric("stabilized_noi")).toBe("RNE stabilisé");
    expect(build("fr", () => {}, "finance").L.metric("sizing_dscr")).toBe("CCD de dimensionnement (pire année)");
  });

  it("names every metric and every gate in plain words, in English and French", async () => {
    const { en, fr } = await import("../src/strings/terms");
    const enT = en as Record<string, unknown>, frT = fr as Record<string, unknown>;
    const plainKeys = Object.keys(en).filter((k) => k.startsWith("terms.metric.") || k.startsWith("terms.gate."));
    expect(plainKeys.length).toBeGreaterThan(0);
    for (const k of plainKeys) {
      expect(typeof enT[k] === "string" && (enT[k] as string).trim().length > 0, k).toBe(true);
      expect(typeof frT[k] === "string" && (frT[k] as string).trim().length > 0, k).toBe(true);
    }
    for (const m of METRICS) expect(plainKeys, m.key).toContain(`terms.metric.${m.key}`);
    for (const g of Object.keys(GATES)) expect(plainKeys, g).toContain(`terms.gate.${g}`);
  });

  it("keeps the qualifiers that change the meaning", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { build } = await import("../src/i18n");
    const en = build("en", () => {});
    expect(en.L.metric("sizing_dscr_year1")).toMatch(/year 1/);
    expect(en.L.metric("profit_on_cost_for_sale")).toMatch(/units sold/);
    expect(en.L.metric("unrealized_equity_irr")).toMatch(/[Uu]nrealized/);
    expect(en.L.gate("stressed_sizing_dscr", "x")).toMatch(/combined stress/);
  });

  it("covers every figure the run, explore and compare screens name", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { build } = await import("../src/i18n");
    const { HEADLINE, layoutFor } = await import("../src/routes/run");
    const { exploreLayoutFor } = await import("../src/routes/explore");
    const keys = new Set<string>(HEADLINE);
    for (const metrics of [[{ key: "stated_value", status: "VALID" }], [{ key: "gross_sales_revenue", status: "VALID" }], [{ key: "lp_irr", status: "VALID" }], []] as const) {
      const l = layoutFor(metrics as any);
      for (const k of [...l.headline, ...l.stressKeys]) keys.add(k);
    }
    for (const sale of [true, false]) { const l = exploreLayoutFor(sale); for (const k of [...l.compare, ...l.chartMetrics]) keys.add(k); }
    for (const lang of ["en", "fr"] as const) {
      const i = build(lang, () => {});
      for (const k of keys) expect(i.L.metric(k), `${lang} ${k}`).not.toBe(k);
    }
  });
});

describe("the glossary follows the preference", () => {
  it("leads with the plain name and ends with the finance name in plain mode", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { Glossary } = await import("../src/components/ui");
    const raw = renderToStaticMarkup(createElement(Glossary));
    const html = text(raw);
    expect(html).toContain("Coverage");
    expect(html).toContain("Lenders call it DCR or DSCR.");
    expect(html).not.toContain("DCR (debt coverage ratio)");
    expect(html).toContain("Development spread");
    expect(html).toContain("Unrealized equity multiple");
    expect(raw.match(/<dt>/g)).toHaveLength(10);
  });

  it("leads with the finance name in finance mode, as before", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { termsStore } = await import("../src/terms");
    termsStore.setPref("finance");
    const { Glossary } = await import("../src/components/ui");
    const raw = renderToStaticMarkup(createElement(Glossary));
    expect(text(raw)).toContain("DCR (debt coverage ratio), called DSCR by many lenders");
    expect(text(raw)).not.toContain("Lenders call it DCR or DSCR.");
    expect(raw.match(/<dt>/g)).toHaveLength(10);
  });

  it("has the two new entries in French", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    state.lang = "fr";
    const { Glossary } = await import("../src/components/ui");
    const html = text(renderToStaticMarkup(createElement(Glossary)));
    expect(html).toContain("Écart de développement");
    expect(html).toContain("Couverture");
    expect(html).toMatch(/CCD ou RCSD/);
  });
});

describe("the settings row", () => {
  it("renders with both options, in English and French", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const { Settings } = await import("../src/routes/settings");
    const en = text(renderToStaticMarkup(createElement(Settings)));
    expect(en).toContain("Finance terms");
    expect(en).toContain("Show plain words first, with the finance terms in the glossary on Run and Review.");
    expect(en).toContain("Plain words first");
    expect(en).toContain("Finance terms first");
    state.lang = "fr";
    const fr = text(renderToStaticMarkup(createElement(Settings)));
    expect(fr).toContain("Termes financiers");
    expect(fr).toContain("Mots simples d'abord");
    expect(fr).toContain("Termes financiers d'abord");
  });
});
