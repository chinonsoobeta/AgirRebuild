import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { THRESHOLDS } from "@agir/contracts";
import type { Assumption, Review as ReviewData, ThresholdView } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card X4: thresholds in the open and the choices already made. Mocks follow apps/web/test/ui-review.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, role: "owner", review: undefined as unknown, thresholds: undefined as unknown, runs: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "review" ? { data: state.review } : key === "thresholds" ? { data: state.thresholds, error: null } : key === "runs" ? { data: state.runs } : {};
  },
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null, variables: undefined }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as string), useNavigate: () => () => {} };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { deal: { currency: "CAD" }, updating: false, run: null, documents: { total: 2, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: true, role: state.role, workspaceId: "ws", me: { user: { id: "me-id", name: "Morgan" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

import { Review } from "../src/routes/review.tsx";

const row = (over: Partial<Assumption>): Assumption => ({
  id: "x", fieldKey: "land_cost", itemKey: null, label: "", group: "budget", groupLabel: "Budget", unit: "$", material: false, conservative: null, status: "approved",
  value: 1, pendingValue: null, sourceKind: "document", sources: [], conflictValues: null, reason: null, decidedBy: "Dana", decidedById: "dana", decidedAt: "2026-10-21T12:00:00Z",
  secondApprover: null, confirmedByReview: false, secondApprovedAt: null, sponsorStated: false, clientConfirmedBy: null, clientConfirmedById: null, clientConfirmedAt: null, version: 1, ...over,
});
const payload = (): ReviewData => ({
  assumptions: [
    row({ id: "a1", fieldKey: "land_cost", value: 1150000 }),
    row({ id: "ch1", fieldKey: "refinance_term_years", group: "refinance", groupLabel: "Refinance", unit: "years", sourceKind: "analyst", value: 10, decidedBy: "Morgan", decidedById: "me-id" }),
  ],
  missing: [], notFound: [], regions: [], proposals: [], tableNotices: [], aiReading: null, other: [],
  choices: [{ fieldKey: "lease_up_ramp", label: "Credit income during lease-up", unit: "flag", material: false, default: null, help: null, groupLabel: "Operations", likely: [] }],
  readiness: { status: "ready", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
  todo: { blocking: 0, items: [] },
});
const at = (version: string, path: string) => THRESHOLDS[version]!.find((r) => r.path === path)!;
const view = (): ThresholdView => {
  const first = "rental-hold-draft", insured = "rental-hold-insured-draft";
  const dcr = at(insured, "gates.dcrAfterRefinanceMin"), ltc = at(insured, "maxLtcPct");
  return { invalid: [], policies: [
    { version: first, thresholds: THRESHOLDS[first]!.slice(0, 2).map((t) => ({ ...t, value: t.standard, layer: null, looser: false, stressRemoved: false, workspace: null, deal: null })) },
    { version: insured, thresholds: [
      { ...dcr, value: 1.1, layer: "deal", looser: true, stressRemoved: false, workspace: null, deal: { value: 1.1, setBy: "owner", setByName: "Dana", setAt: "2026-10-19T12:00:00Z", reason: "Lender term sheet" } },
      { ...ltc, value: 80, layer: "workspace", looser: false, stressRemoved: false, deal: null, workspace: { value: 80, setBy: "owner", setByName: "Dana", setAt: "2026-10-19T12:00:00Z", reason: "House rule" } },
    ] },
  ] };
};

const render = () => renderToStaticMarkup(createElement(Review, { dealId: "deal-1" }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const aside = (html: string) => html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
const thresholdsCard = (html: string) => { const a = aside(html); const i = a.indexOf('id="thresholds"'); return a.slice(i, a.indexOf("</section>", i)); };
const choices = (html: string) => html.slice(html.indexOf('id="choices"'), html.indexOf("</section>", html.indexOf('id="choices"')));
const buttonLabels = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => text(m[1]!));

beforeEach(() => {
  state.lang = "en"; state.role = "owner"; state.review = payload(); state.thresholds = view();
  state.runs = [{ id: "r2", run_number: 2, policy_version: "rental-hold-insured-draft" }, { id: "r1", run_number: 1, policy_version: "rental-hold-draft" }];
});

describe("card X4 thresholds in the open", () => {
  it("lists the thresholds of the latest run's policy without opening anything, each with its bound and note", () => {
    const card = thresholdsCard(render());
    expect(card).not.toBe("");
    const outside = card.replace(/<details[\s\S]*<\/details>/g, "");
    const words = text(outside);
    expect(words).toContain("DCR after refinance");
    expect(words).toContain("at least 1.10");
    expect(words).toContain("set for this deal");
    expect(words).toContain("CMHC's cited rule");
    expect(words).toContain("Maximum loan-to-cost");
    expect(words).toMatch(/at most 80(\.0+)?%/);
    expect(words).toContain("set for the workspace");
    expect(outside).toMatch(/<select[^>]*>[\s\S]*rental-hold-draft[\s\S]*<\/select>/);
    expect(outside).toMatch(/<option[^>]*value="rental-hold-insured-draft"[^>]*selected/);
  });
  it("uses the first policy when the deal has no run, and shows no select for a single policy", () => {
    state.runs = [];
    expect(text(thresholdsCard(render()).replace(/<details[\s\S]*<\/details>/g, ""))).not.toContain("DCR after refinance");
    const one = view(); one.policies = [one.policies[1]!]; state.thresholds = one;
    const card = thresholdsCard(render()).replace(/<details[\s\S]*<\/details>/g, "");
    expect(text(card)).toContain("DCR after refinance");
    expect(card).not.toContain("<select");
  });
  it("puts the editor in a disclosure for the owner", () => {
    const card = thresholdsCard(render());
    expect(card).toMatch(/<details[^>]*>\s*<summary[^>]*>Change a threshold for this deal \(a reason is required\)<\/summary>/);
  });
  it("gives an analyst no change disclosure and says only the owner changes thresholds", () => {
    state.role = "analyst";
    const card = thresholdsCard(render());
    expect(card).not.toContain("<details");
    expect(card).not.toContain("<form");
    expect(text(card)).toContain("Only the workspace owner changes thresholds.");
    expect(text(card)).toContain("at least 1.10");
  });
  it("says it in French", () => {
    state.lang = "fr";
    const words = text(thresholdsCard(render()));
    expect(words).toContain("au moins 1,10");
    expect(words).toContain("fixé pour ce projet");
    expect(words).toContain("Modifier un seuil pour ce projet");
  });
});

describe("card X4 choices already made", () => {
  it("lists a made choice with its value, who chose it and when, and a Change button", () => {
    const html = choices(render());
    expect(text(html)).toContain("Credit income during lease-up");
    expect(text(html)).toMatch(/Refinance term: 10 years, chosen by you on [^.]+\./);
    expect(buttonLabels(html)).toContain("Change");
  });
  it("names someone else and shows the section when only made choices remain", () => {
    const r = payload(); r.choices = []; r.assumptions[1] = { ...r.assumptions[1]!, decidedById: "dana", decidedBy: "Dana" }; state.review = r;
    const html = choices(render());
    expect(text(html)).toMatch(/Refinance term: 10 years, chosen by Dana on [^.]+\./);
  });
  it("lists a made choice without the button for a viewer and a client", () => {
    for (const role of ["viewer", "client"]) {
      state.role = role;
      const html = choices(render());
      expect(text(html)).toContain("Refinance term: 10 years");
      expect(buttonLabels(html)).not.toContain("Change");
    }
  });
  it("leaves a value read from documents out of the made choices", () => {
    expect(text(choices(render()))).not.toContain("Land cost");
  });
});
