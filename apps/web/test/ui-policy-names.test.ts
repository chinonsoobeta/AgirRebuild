/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor, type EngineInput } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import type { RunView, ThresholdView } from "../src/api";
import { Run } from "../src/routes/run.tsx";
import { DecisionStep } from "../src/routes/decision.tsx";
import { compareSummary, diffRuns } from "../src/routes/compare.tsx";
import { TableProposal } from "../src/routes/review.tsx";
import { ThresholdList, Thresholds } from "../src/components/thresholds.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card P1: a policy is named in words, never by its version id; three short API messages start with a capital in English.
// Mocks follow apps/web/test/ui-run-2.test.ts and ui-decision-reports.test.ts.
const s = vi.hoisted(() => ({ lang: "en" as Lang, role: "owner", run: undefined as unknown, runs: [] as unknown[], thresholds: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: { queryKey: unknown[] }) => {
    const key = o.queryKey[0];
    return key === "run" ? { data: s.run } : key === "runs" ? { data: s.runs } : key === "thresholds" ? { data: s.thresholds } : {};
  },
  useQueries: (o: { queries: unknown[] }) => o.queries.map(() => ({})),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return { ...ui, DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { run: { id: "run-2", number: 2, fresh: true }, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: s.role, me: { user: { id: "u", email: "u@example.test", name: "Invented starter" }, workspaces: [] } }) };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});

const input = developmentDeal();
const result = underwrite(input as EngineInput, policyFor(input as EngineInput));
const run = (over: object = {}) => ({ id: "run-2", number: 2, result, fresh: true, staleReasons: [], inputs: [], isLatest: true, decisions: [],
  policyVersion: "rental-hold-draft", policyDraft: true, engineVersion: "invented-engine", createdAt: "2026-10-24T15:58:00Z", createdBy: "Invented author",
  inputHash: "a".repeat(64), resultHash: "b".repeat(64), signed: "development key", ...over });
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replace(/\s+/g, " ");
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => text(renderToStaticMarkup(el));
const detail = (words: string, label: string) => words.match(new RegExp(` ${label} (.*?) (?:Inputs|Données|Engine|Moteur) `))?.[1];
const options = (html: string) => [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

beforeEach(() => {
  s.lang = "en"; s.role = "owner"; s.run = run();
  s.runs = [{ id: "run-2", run_number: 2, verdict_code: "APPROVE", created_at: "2026-10-24T15:58:00Z", created_by: "Invented author", policy_version: "rental-hold-draft" }];
  s.thresholds = undefined;
});

describe("the run page names its policy (card P1)", () => {
  it("names a draft policy in the verdict line and the Policy detail, in English", () => {
    const words = render(createElement(Run, { dealId: "deal" }));
    expect(words).toContain("Run 2 · Rental hold, draft, not signed by credit");
    expect(detail(words, "Policy")).toBe("Rental hold, draft, not signed by credit");
    expect(words).not.toContain("rental-hold-draft");
  });

  it("names a draft policy in the verdict line and the Policy detail, in French", () => {
    s.lang = "fr";
    const words = render(createElement(Run, { dealId: "deal" }));
    expect(words).toContain("Analyse 2 · Location conservée et refinancée, provisoire, non approuvée par le crédit");
    expect(detail(words, "Politique")).toBe("Location conservée et refinancée, provisoire, non approuvée par le crédit");
  });

  // Card E: policy-v1 is not a draft, but credit has not signed it either, so it says so without the draft words.
  it("names policy-v1, which credit has not signed, without the draft words", () => {
    s.run = run({ policyVersion: "policy-v1", policyDraft: false });
    const words = render(createElement(Run, { dealId: "deal" }));
    expect(words).toContain("Run 2 · Sale at the end of the hold, not yet signed by credit");
    expect(detail(words, "Policy")).toBe("Sale at the end of the hold, not yet signed by credit");
    expect(words).not.toContain("draft");
    s.lang = "fr";
    const fr = render(createElement(Run, { dealId: "deal" }));
    expect(fr).toContain("Analyse 2 · Vente à la fin de la détention, non encore approuvée par le crédit");
    expect(detail(fr, "Politique")).toBe("Vente à la fin de la détention, non encore approuvée par le crédit");
  });

  it("shows a version this build does not know as its id", () => {
    s.run = run({ policyVersion: "rental-hold-2025-draft", policyDraft: true });
    const words = render(createElement(Run, { dealId: "deal" }));
    expect(words).toContain("Run 2 · rental-hold-2025-draft, draft, not signed by credit");
    expect(detail(words, "Policy")).toBe("rental-hold-2025-draft, draft, not signed by credit");
  });
});

describe("the decision page names its policy (card P1)", () => {
  it("names a draft policy in both languages", () => {
    s.run = run({ policyVersion: "rental-hold-insured-standard-short-draft" });
    expect(render(createElement(DecisionStep, { dealId: "d" }))).toContain(" Policy Rental hold, CMHC standard insurance, term under 10 years, draft, not signed by credit ");
    s.lang = "fr";
    expect(render(createElement(DecisionStep, { dealId: "d" })))
      .toContain(" Politique Location conservée et refinancée, assurance standard de la SCHL, durée de moins de 10 ans, provisoire, non approuvée par le crédit ");
  });

  it("names policy-v1 in both languages", () => {
    s.run = run({ policyVersion: "policy-v1", policyDraft: false });
    expect(render(createElement(DecisionStep, { dealId: "d" }))).toContain(" Policy Sale at the end of the hold ");
    s.lang = "fr";
    expect(render(createElement(DecisionStep, { dealId: "d" }))).toContain(" Politique Vente à la fin de la détention ");
  });
});

const view = (versions: string[], invalid: ThresholdView["invalid"] = []): ThresholdView => ({ invalid, policies: versions.map((version) => ({ version, thresholds: [] })) });
const all = ["policy-v1", "rental-hold-draft", "rental-hold-insured-draft", "rental-hold-insured-standard-draft", "rental-hold-insured-standard-short-draft", "for-sale-draft", "older-draft"];
const invalidDcr = [{ version: "rental-hold-draft", path: "gates.dcrAfterRefinanceMin", layer: "workspace" as const, value: 0.2, setById: "u", setByName: "Invented owner",
  setAt: "2026-10-20T12:00:00Z", reason: "Invented reason", error: { en: "Too low.", fr: "Trop bas." } }];

describe("the threshold views name each policy (card P1)", () => {
  it("lists the policies by name in Settings' editor, keeping the version ids as values", () => {
    s.thresholds = view(all);
    expect(options(renderToStaticMarkup(createElement(Thresholds, { scope: "workspaces", id: "ws" })))).toEqual([
      ["policy-v1", "Sale at the end of the hold"],
      ["rental-hold-draft", "Rental hold"],
      ["rental-hold-insured-draft", "Rental hold, CMHC MLI Select"],
      ["rental-hold-insured-standard-draft", "Rental hold, CMHC standard insurance"],
      ["rental-hold-insured-standard-short-draft", "Rental hold, CMHC standard insurance, term under 10 years"],
      ["for-sale-draft", "Units for sale"],
      ["older-draft", "older-draft"],
    ]);
    s.lang = "fr";
    expect(options(renderToStaticMarkup(createElement(Thresholds, { scope: "workspaces", id: "ws" }))).map(([, name]) => name)).toEqual([
      "Vente à la fin de la détention",
      "Location conservée et refinancée",
      "Location conservée et refinancée, MLI Select de la SCHL",
      "Location conservée et refinancée, assurance standard de la SCHL",
      "Location conservée et refinancée, assurance standard de la SCHL, durée de moins de 10 ans",
      "Logements à vendre",
      "older-draft",
    ]);
  });

  it("lists the policies by name on the Review page, and names a single one", () => {
    s.thresholds = view(["rental-hold-insured-draft", "for-sale-draft"]);
    expect(options(renderToStaticMarkup(createElement(ThresholdList, { dealId: "d" })))).toEqual([
      ["rental-hold-insured-draft", "Rental hold, CMHC MLI Select"], ["for-sale-draft", "Units for sale"]]);
    s.lang = "fr";
    expect(options(renderToStaticMarkup(createElement(ThresholdList, { dealId: "d" })))).toEqual([
      ["rental-hold-insured-draft", "Location conservée et refinancée, MLI Select de la SCHL"], ["for-sale-draft", "Logements à vendre"]]);
    s.lang = "en";
    s.thresholds = view(["for-sale-draft"]);
    expect(render(createElement(ThresholdList, { dealId: "d" })).trim()).toBe("Units for sale");
  });

  it("names the policy and the threshold in the lists of values that no longer fit", () => {
    s.thresholds = view(["rental-hold-draft"], invalidDcr);
    expect(render(createElement(Thresholds, { scope: "workspaces", id: "ws" }))).toContain("Rental hold · DCR after refinance = 0.2 (workspace) · Too low.");
    s.role = "member";
    expect(render(createElement(ThresholdList, { dealId: "d" }))).toContain("Rental hold · DCR after refinance = 0.2 (workspace) · Too low.");
    s.lang = "fr";
    expect(render(createElement(ThresholdList, { dealId: "d" }))).toContain("Location conservée et refinancée · CCD après refinancement = 0.2 (espace de travail) · Trop bas.");
  });

  it("falls back to the raw path and version when the threshold is not known", () => {
    s.role = "member";
    s.thresholds = view(["rental-hold-draft"], [{ ...invalidDcr[0]!, version: "older-draft", path: "gates.retiredMin" }]);
    expect(render(createElement(ThresholdList, { dealId: "d" }))).toContain("older-draft · gates.retiredMin = 0.2 (workspace) · Too low.");
  });
});

describe("the compare sentence names both policies (card P1)", () => {
  it("says which policy each run used", () => {
    const one = run({ id: "run-1", number: 1, policyVersion: "policy-v1", policyDraft: false }) as unknown as RunView;
    const two = run() as unknown as RunView;
    expect(compareSummary(build("en", () => {}), diffRuns(two, one), two, one).body).toContain("The policy differs: Sale at the end of the hold, then Rental hold.");
    expect(compareSummary(build("fr", () => {}), diffRuns(two, one), two, one).body)
      .toContain("La politique diffère : Vente à la fin de la détention, puis Location conservée et refinancée.");
  });

  it("names the policy when only its thresholds differ", () => {
    const one = run({ id: "run-1", number: 1, policy: { edited: 1 } }) as unknown as RunView;
    const two = run({ policy: { edited: 2 } }) as unknown as RunView;
    expect(compareSummary(build("en", () => {}), diffRuns(two, one), two, one).body).toContain("The policy thresholds differ (Rental hold).");
  });
});

describe("an unavailable proposal starts with a capital letter in English (card P1)", () => {
  const proposal = { fieldKey: "land_transfer_tax", tableId: "ltt", title: "Invented table", publisher: "Invented publisher", url: "https://example.test/official",
    effective: "2025-01-01", readOn: "2026-10-24", signedOn: "2026-10-24", recheckBy: "2027-01-31", options: [] };
  it("capitalizes the API's lower-case message", () => {
    const html = renderToStaticMarkup(createElement(TableProposal, { proposal: { ...proposal, unavailable: "state the land cost first" }, unit: "$", onUse: () => {}, busy: false }));
    expect(text(html).trim()).toBe("State the land cost first");
    const province = renderToStaticMarkup(createElement(TableProposal, { proposal: { ...proposal, unavailable: "the deal has no province" }, unit: "$", onUse: () => {}, busy: false }));
    expect(text(province).trim()).toBe("The deal has no province");
  });
});
