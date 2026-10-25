import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DealOverview, Me } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card U21: French typography and terms, one meaning for "variante", no doubled wording on the deals home.
const state = vi.hoisted(() => ({ deals: [] as unknown[], me: undefined as unknown, lang: "en" as Lang }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) =>
    options.queryKey[0] === "me" ? { data: state.me, isLoading: false, error: null } : { data: state.deals, isLoading: false },
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  const href = (to: string, params?: Record<string, string>) => to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "");
  return {
    Link: ({ to, params, children, className }: { to: string; params?: Record<string, string>; children: unknown; className?: string }) => createElement("a", { href: href(to, params), className }, children as string),
    useNavigate: () => () => {},
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

const { EN, FR, build } = await import("../src/i18n.tsx");
const { Deals } = await import("../src/routes/deals.tsx");
const { DealFrame, SessionGate } = await import("../src/components/ui.tsx");

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, "\u00a0").replace(/[ \t\n]+/g, " ").trim();

const me: Me = { user: { id: "u1", email: "ada@example.com", name: "Ada Lovelace" }, workspaces: [{ id: "w1", name: "First", review_mode: "solo", label_suggestions: false, has_logo: false, role: "owner" }] };
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(SessionGate, null, node));

beforeEach(() => {
  state.deals = [];
  state.me = me;
  state.lang = "en";
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

// ---- French typography -------------------------------------------------------------------------------
/** Every French value as text: strings directly, functions called with sample parameters (skipping any that throw). */
function frenchTexts(): { key: string; text: string }[] {
  const sample = new Proxy({} as Record<string, unknown>, { get: (_, k) => (k === "solo" || k === "material" || k === "defaults" ? false : k === "n" || k === "min" || k === "max" ? 5 : "x") });
  const out: { key: string; text: string }[] = [];
  for (const [key, entry] of Object.entries(FR)) {
    if (typeof entry === "string") { out.push({ key, text: entry }); continue; }
    let value: string | string[];
    try { value = entry(sample); } catch { continue; }
    for (const v of [value].flat()) if (typeof v === "string") out.push({ key, text: v });
  }
  return out;
}
const PLAIN_SPACING = / [:;?!»]|« |\d [%$]/;

describe("French typography", () => {
  it("uses a no-break space before : ; ? ! », after «, and between a number and % or $", () => {
    const texts = frenchTexts();
    expect(texts.length).toBeGreaterThan(900);
    expect(texts.filter((x) => PLAIN_SPACING.test(x.text)).map((x) => `${x.key}: ${x.text}`)).toEqual([]);
  });
  it("catches a plain space where a no-break space belongs", () => {
    for (const bad of ["Verdict : x", "Pourquoi ?", "« oui »", "5 %", "100 $", "a ; b", "Non !"]) expect(PLAIN_SPACING.test(bad)).toBe(true);
    for (const good of ["Verdict\u00a0: x", "Pourquoi\u00a0?", "«\u00a0oui\u00a0»", "5\u00a0%", "100\u00a0$", "Pourquoi?"]) expect(PLAIN_SPACING.test(good)).toBe(false);
  });
});

describe("French terms", () => {
  it("calls a rent roll an état des loyers and a term sheet a lettre d'offre everywhere", () => {
    const bad = /rôle des loyers|relevé des loyers|état locatif|lettre d['’]engagement/i;
    expect(frenchTexts().filter((x) => bad.test(x.text)).map((x) => x.key)).toEqual([]);
  });
  it("keeps variante for a copied deal only", () => {
    const fr = build("fr", () => {});
    for (const key of ["explore.title", "run.explore", "explore.action"] as const) {
      expect(fr.t(key)).toBeTruthy();
      expect(fr.t(key)).not.toMatch(/variante/i);
    }
    expect(build("en", () => {}).t("explore.action")).toBe("Explore changes");
    expect(fr.t("explore.action")).toBe(fr.t("explore.title"));
  });
  it("has exactly the English keys in French", () => {
    expect(Object.keys(FR).sort()).toEqual(Object.keys(EN).sort());
  });
});

// ---- The deals home --------------------------------------------------------------------------------
const review = { approved: 10, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0, status: "ready" as const };
function deal(id: string, over: Partial<DealOverview>): DealOverview {
  return {
    deal: { id, workspace_id: "w1", name: `Deal ${id}`, asset_type: "Multifamily", location: "Halifax", currency: "CAD", country: "CA", province: "NS", created_at: "2026-10-01T00:00:00Z" },
    copiedFrom: null, step: "documents", status: { tone: "neutral", text: "" }, next: "", documents: { total: 3, processing: 0, failed: 0 }, updating: false,
    review, run: null, decision: null, reports: 0, ...over,
  };
}
const decided = deal("d5", { step: "reports", run: { id: "r5", number: 3, verdict: "APPROVE", fresh: true, createdAt: "2026-10-19T12:00:00Z" }, decision: { decision: "approve_with_conditions", created_at: "2026-10-19T12:00:00Z" }, reports: 2 });
const outOfDate = deal("d3", { step: "run", run: { id: "r3", number: 2, verdict: "APPROVE", fresh: false, createdAt: "2026-10-20T12:00:00Z" } });
const rows = () => render(createElement(Deals)).split('<article class="deal"').slice(1).map(text);

describe("the deals home says each thing once", () => {
  it("shows a decided deal's decision as its tag, then the date and run, in English", () => {
    state.deals = [decided];
    const [row] = rows();
    expect(row).toContain("Approve with conditions");
    expect(row!.match(/decided/gi)?.length).toBe(1);
    expect(row).toMatch(/Decided on .*2026.* against run 3\./);
  });
  it("does the same in French", () => {
    state.lang = "fr";
    state.deals = [decided];
    const [row] = rows();
    expect(row).toContain("Approuver sous conditions");
    expect(row!.match(/décidé/gi)?.length).toBe(1);
    expect(row).toMatch(/Décidé le .*2026.*analyse[ \u00a0]3\./);
  });
  it("gives an out-of-date deal a sentence that does not repeat its tag and names the run", () => {
    for (const lang of ["en", "fr"] as const) {
      state.lang = lang;
      state.deals = [outOfDate];
      const [row] = rows();
      const tag = build(lang, () => {}).t("deals.tag.stale");
      expect(row).toContain(tag);
      expect(row!.toLowerCase().split(tag.toLowerCase().replace(/s$/, "")).length).toBe(2);
      expect(row).toMatch(lang === "en" ? /after run 2/ : /analyse 2/);
    }
  });
  it("offers to run an out-of-date deal again", () => {
    state.deals = [outOfDate];
    expect(rows()[0]).toContain("Run underwriting again");
  });
});

// ---- The deal frame ------------------------------------------------------------------------------------
describe("the deal frame's explore action", () => {
  it("uses its own key, in both languages", () => {
    for (const lang of ["en", "fr"] as const) {
      state.lang = lang;
      const out = text(render(createElement(DealFrame, { o: decided, active: "reports" })));
      expect(out).toContain(build(lang, () => {}).t("explore.action"));
      if (lang === "fr") expect(out).not.toMatch(/Explorer des variantes/);
    }
  });
});
