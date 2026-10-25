/// <reference types="node" />
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FIELD_BY_KEY, TEMPLATES } from "@agir/contracts";
import { QuickStart } from "../src/components/QuickStart.tsx";
import { build, type Lang } from "../src/i18n.tsx";

const state = vi.hoisted(() => ({ template: "multiplex", lang: "en", held: false, booleanIndex: 0, types: [0] as number[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { assumptions: [] } }), useQueryClient: () => ({}), useMutation: () => ({ mutate: () => {}, reset: () => {} }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: string }) => createElement("a", null, children) };
});
vi.mock("../src/i18n", async (original) => {
  const i = await original<typeof import("../src/i18n")>();
  return { ...i, useI18n: () => i.build(state.lang as Lang, () => {}) };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const [value, set] = react.useState(initial);
    if (initial === "multiplex") return [state.template, set];
    if (initial === false && state.booleanIndex++ === 0) return [state.held, set];
    if (Array.isArray(initial) && initial.length === 1 && initial[0] === 0) return [state.types, set];
    return [value, set];
  } };
});

const render = () => { state.booleanIndex = 0; return renderToStaticMarkup(createElement(QuickStart, { dealId: "d1" })); };
const tr = (lang: Lang) => build(lang, () => {});

describe("quick start in the design's layout (card W6)", () => {
  beforeEach(() => { state.template = "multiplex"; state.lang = "en"; state.held = false; state.types = [0]; });

  it.each(["en", "fr"] as const)("offers the four templates as radio choice cards with a title and the unit range in %s", (lang) => {
    state.lang = lang;
    state.template = "apartment";
    const html = render();
    expect(html).not.toContain("<select");
    const titles = lang === "en"
      ? ["Multiplex rental", "Small apartment", "Townhomes for sale", "Small condo for sale"]
      : ["Multiplex locatif", "Petit immeuble d'appartements", "Maisons en rangée à vendre", "Petit immeuble en copropriété à vendre"];
    TEMPLATES.forEach((x, n) => {
      const card = new RegExp(`<label class="choice( on)?"><input type="radio" name="template" value="${x.key}"[^>]*/><span><span class="t">([^<]*)</span><span class="d">([^<]*)</span>`);
      const m = html.match(card);
      expect(m, x.key).not.toBeNull();
      const title = m![2]!.replace(/&#x27;/g, "'");
      expect(title).toBe(tr(lang).t(`quickstart.kind.${x.key}` as never));
      expect(title).toBe(titles[n]);
      expect(m![3]).toBe(tr(lang).t("quickstart.range", { min: x.minUnits, max: x.maxUnits }));
      expect(Boolean(m![1])).toBe(x.key === "apartment");
    });
    expect(html).toMatch(/value="apartment" checked=""/);
    expect(html).toContain(lang === "en" ? "5 to 30 units" : "5 à 30 logements");
  });

  it("asks keep or sell as two radio choice cards with today's values, the current one on", () => {
    const html = render();
    expect(html).toContain(tr("en").t("quickstart.andThen"));
    expect(html).toMatch(/<label class="choice on"><input type="radio" name="refinance_and_hold" value="" checked=""\/><span><span class="t">Sell it<\/span>/);
    expect(html).toMatch(/<label class="choice"><input type="radio" name="refinance_and_hold" value="1"\/><span><span class="t">Keep it and refinance<\/span>/);
    state.held = true;
    expect(render()).toMatch(/<label class="choice on"><input type="radio" name="refinance_and_hold" value="1" checked=""\/>/);
  });

  it("does not ask keep or sell for a template that sells", () => {
    state.template = "townhomes";
    const html = render();
    expect(html).not.toContain('name="refinance_and_hold"');
    expect(html).toContain(tr("en").t("qs.saleLine"));
  });

  it.each(["en", "fr"] as const)("lists the named defaults with their values, the not-asked lines and a real accept checkbox in %s", (lang) => {
    state.lang = lang;
    const html = render();
    const { t, f, L } = tr(lang);
    expect(html).toContain(t("qs.defaultsTitle"));
    const dl = html.match(/<dl class="kv">(.*?)<\/dl>/)?.[1] ?? "";
    for (const d of TEMPLATES[0]!.defaults) {
      const def = FIELD_BY_KEY.get(d)!;
      expect(dl).toContain(`<dt>${L.field(d).replace(/'/g, "&#x27;")}</dt><dd>${f.value(def.default!, def.unit)}</dd>`);
    }
    expect(html).toContain(t("qs.hiddenLine", { label: L.field("mezz_loan_amount"), means: L.absent("mezz_loan_amount") }).replace(/'/g, "&#x27;"));
    expect(html).toMatch(/<label class="check"><input type="checkbox" name="accept"\/><span>[^<]+<\/span><\/label>/);
    expect(t("qs.accept")).toBe(lang === "en"
      ? "Accept these defaults. Each one is recorded as a named default, not as a figure of mine."
      : "Accepter ces valeurs par défaut. Chacune est consignée comme une valeur par défaut nommée, et non comme un chiffre de ma part.");
  });

  it("still lists what is not asked when a sale template has no defaults", () => {
    state.template = "condo";
    const html = render();
    expect(html).not.toContain('name="accept"');
    expect(html).toContain(tr("en").t("quickstart.notAsked"));
    expect(html).toContain("Not asked: ");
  });

  it("shows the unit types as table rows with remove buttons and an add button", () => {
    state.template = "apartment";
    state.types = [0, 3];
    const html = render();
    const table = html.match(/<table class="table">(.*?)<\/table>/)?.[1] ?? "";
    expect(table).toContain("<th scope=\"col\">Unit type</th>");
    const rows = table.match(/<tbody>(.*?)<\/tbody>/)![1]!.split("</tr>").filter(Boolean);
    expect(rows).toHaveLength(2);
    for (const n of [0, 3]) {
      expect(table).toContain(`name="name-${n}"`);
      expect(table).toContain(`name="unit_count-${n}"`);
      expect(table).toContain(`name="unit_rent_monthly-${n}"`);
    }
    expect(table.match(/aria-label="Remove this unit type">Remove<\/button>/g)).toHaveLength(2);
    expect(html).toContain(">Add a unit type</button>");
    expect(html).toContain(tr("en").t("quickstart.totalNone", { min: 5, max: 30 }));
  });

  it("does not offer to remove the only unit type, and a sale template asks the sale price", () => {
    state.template = "condo";
    const html = render();
    expect(html).toContain('name="unit_sale_price-0"');
    expect(html).not.toContain('name="unit_rent_monthly-0"');
    expect(html).not.toContain(">Remove</button>");
    expect(html).toContain(">Add a unit type</button>");
  });

  it("groups the questions under the board's headings and closes with the reason and the save button", () => {
    const html = render();
    const { t } = tr("en");
    const order = [t("quickstart.units"), t("quickstart.costs"), t("quickstart.loans"), t("qs.defaultsTitle"), t("qs.reason"), t("qs.submit")]
      .map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(t("qs.reason")).toBe("Where do these figures come from?");
    expect(html).toContain(t("quickstart.reasonHint"));
    expect(html).toContain(t("quickstart.thenNote"));
    expect(html).not.toMatch(/class="(panel|h-section|input-affix)[ "]/);
  });
});
