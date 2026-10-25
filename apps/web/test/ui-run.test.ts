/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import * as runScreen from "../src/routes/run.tsx";
import { build } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ run: undefined as unknown, pending: false, hasRun: true,
  runs: [] as { id: string; run_number: number; verdict_code: string; created_at: string; created_by: string }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    return key === "run" ? { data: state.run } : key === "runs" ? { data: state.runs } : {};
  },
  useMutation: () => ({ mutate: () => {}, isPending: state.pending, error: null, reset: () => {} }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: state.hasRun ? { id: "run-2", number: 2 } : null, documents: { total: 0, processing: 0, failed: 0 },
      review: { status: "ready", approved: 1, needsReview: 0, conflicting: 0, awaitingSecond: 0, missing: 0, impossible: 0 } } }),
    useSession: () => ({ solo: true, role: "owner" }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build("en", () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string) };
});

const input = developmentDeal();
const result = underwrite(input, policyFor(input));
const view = { id: "run-2", number: 2, result, fresh: true, staleReasons: [], inputs: [], policyVersion: result.policyVersion, policyDraft: true,
  engineVersion: result.engineVersion, createdAt: "2026-10-24T15:58:00Z", createdBy: "Invented author", inputHash: "a".repeat(64), resultHash: "b".repeat(64), signed: "development key" };
const en = build("en", () => {});
const render = () => renderToStaticMarkup(createElement(runScreen.Run, { dealId: "deal" }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the run screen in the new design (card W8)", () => {
  beforeEach(() => {
    state.run = view; state.pending = false; state.hasRun = true;
    state.runs = [{ id: "run-2", run_number: 2, verdict_code: "APPROVE", created_at: "2026-10-24T15:58:00Z", created_by: "Invented author" },
      { id: "run-1", run_number: 1, verdict_code: "APPROVE", created_at: "2026-10-22T10:00:00Z", created_by: "Invented author" }];
  });

  it("shows the in-progress card while the run is pending, with the steps and no stop button or times", () => {
    state.pending = true;
    const html = render();
    const words = text(html);
    expect(words).toContain(en.t("run.inProgress", { n: 3 }));
    expect(html).toContain('class="runlist"');
    expect(words).toContain(en.t("run.neverTitle"));
    expect(words).not.toMatch(/stop this run/i);
    expect(words).not.toMatch(/\bnow\b|under a minute|email you/i);
    expect(words).not.toMatch(/\d{1,2}:\d{2}/);
    expect(words).not.toContain(en.t("run.keyFigures"));
  });

  it("numbers the first run 1 while it is pending", () => {
    state.pending = true; state.hasRun = false; state.run = undefined; state.runs = [];
    expect(text(render())).toContain(en.t("run.inProgress", { n: 1 }));
  });

  it("shows the run button and what a run does before the first run", () => {
    state.hasRun = false; state.run = undefined; state.runs = [];
    const words = text(render());
    expect(words).toContain(en.t("run.noRunBody"));
    expect(words).toContain(en.t("run.run"));
  });

  it("says the policy is a draft not signed by credit on the verdict card", () => {
    const words = text(render());
    expect(words).toContain("Run 2 · Sale at the end of the hold, draft, not signed by credit");
    expect(en.t("run.verdictLine", { n: 2, policy: "p", draft: true })).toBe("Run 2 · p, draft, not signed by credit");
    expect(words).toContain(en.t("run.memoAction"));
    expect(words).toContain(en.t("run.again"));
    expect(words).toContain(en.t("run.currentLine"));
  });

  it("lays out the key figures as a description list", () => {
    const html = render();
    expect(html).toContain('<dl class="figs">');
    const figures = html.slice(html.indexOf('<dl class="figs">'), html.indexOf("</dl>", html.indexOf('<dl class="figs">')));
    for (const key of runScreen.layoutFor(result.scenarios[0]!.metrics).headline) expect(figures).toContain(en.L.metric(key));
    expect(figures).toContain('<dt class="k">');
  });

  it("offers the glossary as a disclosure", () => {
    const html = render();
    expect(html).toMatch(new RegExp(`<details[^>]*><summary[^>]*>${en.t("glossary.title")}</summary>`));
  });

  it("puts every visible string of the new screen in French too", () => {
    const fr = build("fr", () => {});
    for (const key of ["run.inProgress", "run.neverTitle", "run.memoAction", "run.currentLine", "run.underStress"] as const) {
      expect(fr.t(key, { n: 2, policy: "p", draft: true })).not.toBe(en.t(key, { n: 2, policy: "p", draft: true }));
    }
  });
});
