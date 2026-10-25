/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as runScreen from "../src/routes/run.tsx";
import { build } from "../src/i18n.tsx";
import type { RunFacts, RunProgress } from "../src/api";

// Card R1: the run in progress, by stage, with Stop.
const state = vi.hoisted(() => ({ lang: "en" as "en" | "fr" }));
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});

const en = build("en", () => {});
const fr = build("fr", () => {});
const STARTED = Date.parse("2026-10-24T15:58:00Z");
const facts = (extra: Partial<RunFacts> = {}): RunFacts => ({ approved: 31, defaults: 4, policyVersion: "rental-hold-draft", policyDraft: true, exit: "refinance_hold",
  constructionMonths: 18, holdYears: 10, stresses: 7, inputHash: "7f3a91c0deadbeef".padEnd(64, "0"), engineVersion: "invented-engine", ...extra });
const twoDone = (f: RunFacts = facts()): RunProgress => ({ stages: { inputs: "2026-10-24T15:58:02Z", ledger: "2026-10-24T15:58:05Z" }, facts: f });
const render = (progress: RunProgress, extra: object = {}) => renderToStaticMarkup(createElement(runScreen.RunInProgress,
  { n: 2, startedAt: STARTED, by: "Invented starter", progress, stopping: false, onStop: () => {}, ...extra }));
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const items = (html: string) => [...html.slice(html.indexOf("<ol"), html.indexOf("</ol>")).matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => text(m[1]!).trim());
const itemClasses = (html: string) => [...html.slice(html.indexOf("<ol"), html.indexOf("</ol>")).matchAll(/<li( class="([^"]*)")?/g)].map((m) => m[2] ?? "");
const TIME = /\d{1,2}:\d{2}:\d{2}/;

describe("the run in progress (card R1)", () => {
  beforeEach(() => { state.lang = "en"; });

  it("with no stage done: today's lead, the six stages to come, now beside the first, and Stop", () => {
    const html = render({ stages: {} });
    const words = text(html);
    expect(words).toContain("Run 2 is in progress");
    expect(words).toMatch(/Started \d{1,2}:\d{2}.* · usually a few seconds/);
    expect(words).not.toMatch(/under a minute|email you/i);
    expect(words).toContain(en.t("run.inProgressLead"));
    const list = items(html);
    expect(list).toHaveLength(6);
    expect(list[0]).toMatch(/now$/);
    expect(list.slice(1).some((l) => /now$/.test(l))).toBe(false);
    expect(list.some((l) => TIME.test(l))).toBe(false);
    expect(itemClasses(html)).toEqual(["on", "", "", "", "", ""]);
    expect(html).toMatch(/<ol[^>]*aria-live="polite"/);
    expect(words).toContain("You can leave this page. The run carries on without you, and it will be here when you come back.");
    expect(html).toMatch(/<button[^>]*class="btn quiet[^"]*"[^>]*>Stop this run<\/button>/);
    expect(words).toContain("Started by Invented starter");
    expect(words).toContain("Run 1 stays available, as it is, until this one finishes.");
    expect(words).not.toContain("Inputs");
  });

  it("with two stages done: ticks and times on them, now on the third, and the facts in the lead and the aside", () => {
    const html = render(twoDone());
    const words = text(html);
    expect(words).toContain("The engine is working from 31 approved values and 4 named defaults under the “Rental hold” policy (draft). Nothing you see on the other screens changes until it finishes.");
    const list = items(html);
    expect(list[0]).toMatch(new RegExp(`^Checked that every value the policy needs is approved ${TIME.source}`));
    expect(list[1]).toMatch(new RegExp(`^Built the monthly ledger: 18 months of construction, then 10 years held ${TIME.source}`));
    expect(list[2]).toBe("Underwriting the loans, the refinance and the hold now");
    expect(list[3]).toBe("Applying the 7 stresses");
    expect(list[4]).toBe("Testing the gates and settling the verdict");
    expect(list[5]).toBe("Writing, hashing and signing the run record");
    expect(itemClasses(html)).toEqual(["done", "done", "on", "", "", ""]);
    expect(html.match(/<svg/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(words).toContain("Inputs 7f3a 91c0 …");
    expect(words).toContain(`Policy ${en.t("run.kv.policyDraft", { p: "Rental hold" })}`);
    expect(words).toContain("Engine invented-engine");
  });

  it("words the ledger and the loans by the deal's exit, and leaves out construction when there is none", () => {
    const all = (f: RunFacts) => ({ stages: { inputs: "2026-10-24T15:58:02Z", ledger: "2026-10-24T15:58:05Z", loans: "2026-10-24T15:58:05Z" }, facts: f });
    const sold = items(render(all(facts({ exit: "sale", holdYears: 5, policyVersion: "policy-v1", policyDraft: false }))));
    expect(sold[1]).toMatch(/^Built the monthly ledger: 18 months of construction, then 5 years to the sale /);
    expect(sold[2]).toMatch(/^Underwrote the loans and the sale /);
    const units = items(render(all(facts({ exit: "for_sale", holdYears: undefined, policyVersion: "for-sale-draft" }))));
    expect(units[1]).toMatch(/^Built the monthly ledger: 18 months of construction and the sales /);
    expect(units[2]).toMatch(/^Underwrote the construction loan and the sales /);
    const held = items(render(all(facts({ constructionMonths: 0, holdYears: 1 }))));
    expect(held[1]).toMatch(/^Built the monthly ledger: 1 year held /);
    expect(held[2]).toMatch(/^Underwrote the loans, the refinance and the hold /);
    const pending = items(render({ stages: { inputs: "2026-10-24T15:58:02Z" }, facts: facts({ exit: "for_sale", constructionMonths: 0, holdYears: undefined }) }));
    expect(pending[1]).toBe("Building the monthly ledger: the sales now");
    expect(pending[2]).toBe("Underwriting the construction loan and the sales");
  });

  it("while stopping, the button reads Stopping… and is disabled", () => {
    const html = render(twoDone(), { stopping: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Stopping…<\/button>/);
    expect(text(html)).not.toContain("Stop this run");
  });

  it("after a stop, says that nothing was recorded", () => {
    const words = text(renderToStaticMarkup(createElement(runScreen.RunStopped, { n: 2 })));
    expect(words).toContain("Run 2 was stopped. Nothing was recorded.");
  });

  it("has the French strings, with French spacing", () => {
    state.lang = "fr";
    const html = render(twoDone());
    const words = text(html);
    expect(words).toContain(fr.t("run.inProgress", { n: 2 }));
    expect(words).toContain("31 valeurs approuvées");
    expect(words).toContain("« Location conservée et refinancée »");
    const list = items(html);
    expect(list[1]).toContain("18 mois de construction, puis 10 ans de détention");
    expect(list[2]).toMatch(/en cours$/);
    expect(words).toContain(fr.t("run.stop"));
    expect(text(renderToStaticMarkup(createElement(runScreen.RunStopped, { n: 2 })))).toContain("L'analyse 2 a été arrêtée. Rien n'a été enregistré.");
    for (const key of ["run.stop", "run.stopping", "run.leave", "run.inRun", "run.stopped", "run.now"] as const) expect(fr.t(key)).not.toBe(en.t(key));
  });

  it("translates the server's new sentences", () => {
    for (const sentence of ["This run is not in progress. It may have finished.", "This run needs a valid run token.",
      "A run with this token is already in progress.", "The connection closed before the run finished. Open the deal again to see whether it was recorded."]) {
      expect(fr.msg(sentence)).not.toBe(sentence);
    }
  });
});
