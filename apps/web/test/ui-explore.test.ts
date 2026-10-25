/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { policyFor } from "@agir/contracts";
import { underwrite } from "../../../packages/engine/src/index.ts";
import { developmentDeal } from "../../../packages/engine/test/fixtures.ts";
import { DRIVERS } from "../../../packages/engine/src/explore.ts";
import { Explore } from "../src/routes/explore.tsx";
import { build } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, run: { id: "r1", number: 3 } as { id: string; number: number } | null }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => ({ data: state.data[options.queryKey[0] as string] }),
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {} }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return { ...ui, DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: state.run } }), useSession: () => ({ solo: true, role: "owner" }) };
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
const i = build("en", () => {});
const dscrGate = result.verdict.gates.find((g) => g.metricKey === "sizing_dscr")!;

function render() {
  return renderToStaticMarkup(createElement(Explore, { dealId: "d1" }));
}

describe("the explore screen (card W10)", () => {
  beforeEach(() => {
    state.run = { id: "r1", number: 3 };
    const t = dscrGate.threshold;
    state.data = {
      run: { id: "r1", number: 3, result },
      drivers: DRIVERS,
      explore: { scenarios: result.scenarios, verdict: result.verdict, checks: result.checks },
      tornado: { base: 1.5, rows: [{ driver: "rentPct", low: 1.2, high: 1.8, lowShock: -10, highShock: 10 }, { driver: "costPct", low: 1.7, high: 1.4, lowShock: -10, highShock: 10 }] },
      breakeven: { rows: [], hardFails: [] },
      grid: { x: "rateBps", y: "rentPct", xs: [-200, -100, 0, 100, 200], ys: [-20, -10, 0, 10, 20],
        cells: [0, 1, 2, 3, 4].map((r) => [0, 1, 2, 3, 4].map((c) => t + 0.2 - 0.1 * (r + c) / 2)) },
    };
  });

  it("gives every slider a label", () => {
    const html = render();
    for (const d of DRIVERS) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="drv-${d.key}"`));
      expect(html).toMatch(new RegExp(`<input[^>]*id="drv-${d.key}"[^>]*type="range"|<input[^>]*type="range"[^>]*id="drv-${d.key}"`));
    }
    expect(html).toContain(i.t("explore.helper"));
  });

  it("leads with what exploration is and links back to the run", () => {
    const html = render();
    expect(html).toContain(i.t("explore.banner"));
    expect(html).toContain(i.t("explore.back", { n: 3 }));
  });

  it("renders the what-changes table with the gate needs and the explored verdict", () => {
    const html = render();
    expect(html).toContain(i.t("explore.results"));
    expect(html).toContain(`<th class="r">${i.t("explore.col.explored")}</th>`);
    const spread = result.verdict.gates.find((g) => g.key === "development_spread")!;
    expect(html).toContain(i.t("explore.gateNeeds", { t: i.f.value(spread.threshold, spread.unit) }));
    expect(html).toContain(i.L.gate(dscrGate.key, dscrGate.label));
    expect(html).toContain(i.t("explore.verdictWith", { v: i.L.verdict(result.verdict.code) }));
  });

  it("marks failing grid cells with text, not colour alone, and outlines the run's cell", () => {
    const html = render();
    const failing = [...html.matchAll(/<td class="cell fail[^"]*"[^>]*>(.*?)<\/td>/g)];
    expect(failing.length).toBeGreaterThan(0);
    for (const m of failing) expect(m[1]).toContain(i.t("explore.belowGate"));
    expect(html).toMatch(/<td class="cell[^"]*\bbase\b/);
    expect(html).toContain(i.t("explore.table"));
  });

  it("draws the tornado with tokens and a legend", () => {
    const html = render();
    expect(html).toContain('class="bar"');
    expect(html).toContain(i.t("explore.lowers"));
    expect(html).toContain(i.t("explore.raises"));
  });

  it("says so when no gate fails", () => {
    const failing = result.verdict.gates.some((g) => g.status === "failed");
    expect(render().includes(i.t("explore.be.noneRun", { n: 3 }))).toBe(!failing);
  });

  it("has no literal colour in the rendered markup", () => {
    const html = render().replace(/&#?\w+;/g, "");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])/);
  });

  it("still says what to do with no run", () => {
    state.run = null;
    expect(render()).toContain(i.t("explore.noRun"));
  });
});
