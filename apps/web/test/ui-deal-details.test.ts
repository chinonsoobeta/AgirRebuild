import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, type AuditEvent, type SharedReport } from "../src/api";
import { Audit } from "../src/routes/audit.tsx";
import { Invite } from "../src/routes/invite.tsx";
import { Share } from "../src/routes/share.tsx";
import { dealFacts } from "../src/components/ui";
import { build, type Lang } from "../src/i18n.tsx";

// Card Z2: the deal's units and exit, older audit events, when an invitation ends and the fuller shared page.
// Mocks follow ui-auth.test.ts and ui-audit-compare.test.ts; the infinite query runs its own queryFn and getNextPageParam.
type Page = AuditEvent[];
const state = vi.hoisted(() => ({
  lang: "en" as Lang, invite: undefined as unknown, me: undefined as unknown, meError: null as unknown, shared: undefined as unknown,
  pages: [] as unknown[][], older: [] as unknown[], infiniteKey: [] as unknown[],
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[],
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    if (key === "invite") return { data: state.invite, error: null };
    if (key === "me") return { data: state.me, error: state.meError };
    if (key === "share") return { data: state.shared, error: null };
    if (key === "audit-verify") return { data: undefined, refetch: () => {}, isFetching: false };
    return {};
  },
  useInfiniteQuery: (o: { queryKey: unknown[]; queryFn: (c: { pageParam: unknown }) => Promise<unknown[]>; getNextPageParam: (last: unknown[], all: unknown[][]) => unknown }) => {
    state.infiniteKey = o.queryKey;
    const pages = state.pages;
    const next = pages.length ? o.getNextPageParam(pages[pages.length - 1]!, pages) : undefined;
    return {
      data: pages.length ? { pages, pageParams: [] } : undefined,
      hasNextPage: next !== undefined && next !== null,
      isFetchingNextPage: false,
      fetchNextPage: async () => { state.pages = [...pages, await o.queryFn({ pageParam: next })]; },
    };
  },
  useMutation: () => ({ mutate: () => {}, isPending: false, reset: () => {}, error: null }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { deal: { id: "d1", name: "Test deal" }, run: null } }),
    useSession: () => ({ solo: true, role: "owner", workspaceId: "ws" }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children, to }: { children: unknown; to: string }) => createElement("a", { href: to }, children as string), useNavigate: () => () => {} };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async (path: string) => (path.includes("?before=") ? state.older : [])) } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = typeof value === "function" ? (value as (v: unknown) => unknown)(state.hooks[n]) : value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "input", "a"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  state.index = 0;
  state.nodes = [];
  return renderToStaticMarkup(el);
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const button = (label: string) => state.nodes.find((n) => n.tag === "button" && text(renderToStaticMarkup(createElement("b", null, n.props.children))) === label);
const en = build("en", () => {});
const fr = build("fr", () => {});

const event = (seq: number, action: string, payload: Record<string, unknown> = {}): AuditEvent =>
  ({ seq, action, entity: "x", entity_id: null, payload, hash: `${seq.toString(16).padStart(4, "0")}abcdef0123456789`, created_at: "2026-10-20T12:00:00Z", actor: "Morgan Owner" });

beforeEach(() => {
  Object.assign(state, { lang: "en", invite: undefined, me: undefined, meError: null, shared: undefined, pages: [], older: [], infiniteKey: [], hooks: [] });
  vi.mocked(api.get).mockClear();
});

describe("the facts line", () => {
  it("says the units and how the deal ends, the board's way", () => {
    expect(dealFacts(en, 6, "refinance_hold")).toBe("6 rental units, kept and refinanced");
    expect(dealFacts(en, 4, "sale")).toBe("4 rental units, sold at the end of the hold");
    expect(dealFacts(en, 8, "for_sale")).toBe("8 units for sale");
    expect(dealFacts(en, 1, "for_sale")).toBe("1 unit for sale");
    expect(dealFacts(en, 6, null)).toBe("6 units");
  });
  it("adds nothing for what is not known, and never a 0", () => {
    expect(dealFacts(en, null, null)).toBe("");
    expect(dealFacts(en, undefined, undefined)).toBe("");
    expect(dealFacts(en, null, "refinance_hold")).not.toMatch(/\d/);
  });
  it("French, with its plurals", () => {
    expect(dealFacts(fr, 6, "refinance_hold")).toBe("6 logements locatifs, conservés et refinancés");
    expect(dealFacts(fr, 4, "sale")).toBe("4 logements locatifs, vendus à la fin de la détention");
    expect(dealFacts(fr, 8, "for_sale")).toBe("8 logements à vendre");
    expect(dealFacts(fr, 1, null)).toBe("1 logement");
    expect(dealFacts(fr, 1, "refinance_hold")).toBe("1 logement locatif, conservé et refinancé");
  });
});

describe("older audit events", () => {
  // The newest 500: three uploads among deal events, so the Documents chip shows every loaded match at once.
  const newest = (): Page => Array.from({ length: 500 }, (_, k) => (k % 200 === 0 ? event(600 - k, "document.uploaded", { name: `doc-${k}.pdf` }) : event(600 - k, "deal.created")));
  it("asks the server for the events older than the oldest loaded, then stops at the start", async () => {
    state.pages = [newest()];
    state.older = [event(100, "document.uploaded", { name: "first.pdf" }), event(99, "deal.created")];
    render(createElement(Audit, { dealId: "d1" }));
    expect(state.infiniteKey.slice(0, 2)).toEqual(["audit", "d1"]);
    button("Documents")!.props.onClick();
    let html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Showing the latest 3 of 3 matching events loaded");
    expect(html).toContain(en.t("audit.capped"));
    await button("Show older events")!.props.onClick();
    expect(vi.mocked(api.get)).toHaveBeenCalledWith("/deals/d1/audit?before=101");
    html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(html).toContain("Uploaded first.pdf");
    expect(html).toContain("Showing the latest 4 of 4 matching events loaded");
    expect(button("Show older events")).toBeUndefined();
    expect(html).not.toContain(en.t("audit.capped"));
  });
  it("hides the button when the first page already reached the start", () => {
    state.pages = [Array.from({ length: 30 }, (_, k) => event(30 - k, "deal.created"))];
    const html = text(render(createElement(Audit, { dealId: "d1" })));
    expect(button("Show older events")).toBeUndefined();
    expect(html).not.toContain(en.t("audit.capped"));
  });
  it("hides the button when an older page comes back empty", async () => {
    state.pages = [newest()];
    state.older = [];
    render(createElement(Audit, { dealId: "d1" }));
    button("Documents")!.props.onClick();
    render(createElement(Audit, { dealId: "d1" }));
    await button("Show older events")!.props.onClick();
    render(createElement(Audit, { dealId: "d1" }));
    expect(button("Show older events")).toBeUndefined();
  });
});

describe("when an invitation ends", () => {
  const expiresAt = "2026-10-31T16:12:00Z";
  it("says the date the link expires", () => {
    state.invite = { workspace: "Northside Infill", deal: "Harbour Lane", expiresAt };
    state.meError = new Error("Sign in to continue.");
    const words = text(render(createElement(Invite, { secret: "s" })));
    expect(words).toContain(`This link works once and expires on ${en.f.date(expiresAt)}`);
    expect(words).toContain("If it has been used or revoked, ask Northside Infill for a new one.");
  });
  it("French", () => {
    state.lang = "fr";
    state.invite = { workspace: "Northside Infill", deal: "Harbour Lane", expiresAt };
    state.meError = new Error("x");
    const words = text(render(createElement(Invite, { secret: "s" })));
    expect(words).toContain(`expire le ${fr.f.date(expiresAt)}`);
  });
});

describe("the shared page", () => {
  const gate = (metricKey: string, threshold: number, unit: string) => ({ key: metricKey, label: metricKey, scenario: "base", metricKey, threshold, unit, actual: null, status: "passed" });
  const fig = (key: string, value: number | null, unit: string, reason?: string) => ({ key, unit, value, status: value === null ? "NOT_MEANINGFUL" : "VALID", ...(reason ? { reason } : {}) });
  const held: SharedReport = {
    deal: "Tamarack Six", kind: "ic_memo", format: "pdf", runNumber: 2, expiresAt: null,
    workspace: "Northside Infill", location: "Edmonton", province: "AB", currency: "CAD", runAt: "2026-10-24T16:00:00Z",
    units: 6, exit: "refinance_hold", policyDraft: true, errorChecks: 0,
    verdict: { code: "APPROVE", headline: "", explanation: "", hardFailReasons: [], gates: [gate("dcr_after_refinance", 1.2, "x"), gate("development_spread", 100, "bps"), gate("sizing_dscr", 1.1, "x"), gate("yield_on_cost", 6, "%")] },
    figures: [fig("total_development_cost", 1667571, "$"), fig("cost_per_unit", 277928, "$"), fig("required_equity", 567571, "$"), fig("loan_to_cost", 66, "%"),
      fig("dcr_after_refinance", 1.34, "x"), fig("sizing_dscr", 1.25, "x"), fig("development_spread", 135, "bps"), fig("yield_on_cost", 6.85, "%")],
    exitCapPct: 5.5,
  };
  const page = () => text(render(createElement(Share, { secret: "s" })));
  it("a held run: who shared it, the place, the verdict and four key figures with their recorded second lines", () => {
    state.shared = held;
    const words = page();
    expect(words).toContain("Northside Infill shared this with you");
    expect(words).toContain("Tamarack Six");
    expect(words).toContain("Edmonton, Alberta · 6 rental units, kept and refinanced · amounts in Canadian dollars");
    expect(words).toContain("Approve");
    expect(words).toContain("All four gates pass.");
    expect(words).toContain(`Run 2 · ${en.f.date(held.runAt!)}`);
    for (const k of ["total_development_cost", "required_equity", "dcr_after_refinance", "development_spread"]) expect(words).toContain(en.L.metric(k));
    expect(words).not.toContain(en.L.metric("sizing_dscr"));
    expect(words).toContain("$1,667,571");
    expect(words).toContain("$277,928 a unit");
    expect(words).toContain(`Loan to cost ${en.f.value(66, "%")}`);
    expect(words).toContain(`The gate needs ${en.f.value(1.2, "x")}`);
    expect(words).toContain(`${en.L.metric("yield_on_cost")} 6.85% over a 5.50% cap`);
    expect(words).toContain("The policy is a draft, not yet signed by credit.");
    expect(words).toContain("Every figure is printed from run 2 with its source recorded; nothing on this page is recomputed.");
    expect(words).toContain("Download the audit package");
  });
  it("a sale run shows sizing coverage in place of coverage after refinancing", () => {
    state.shared = { ...held, exit: "sale", units: 4 };
    const words = page();
    expect(words).toContain("4 rental units, sold at the end of the hold");
    expect(words).toContain(en.L.metric("sizing_dscr"));
    expect(words).not.toContain(en.L.metric("dcr_after_refinance"));
    expect(words).toContain(`The gate needs ${en.f.value(1.1, "x")}`);
  });
  it("a for-sale run: profit on cost and margin on revenue, a null figure with its reason, and no currency when none is set", () => {
    const reason = "Net sales revenue is zero, so the margin has no meaning.";
    state.shared = { ...held, units: 8, exit: "for_sale", currency: null, policyDraft: false, exitCapPct: undefined,
      verdict: { ...held.verdict!, gates: [gate("profit_on_cost_for_sale", 15, "%")] },
      figures: [fig("total_development_cost", 3200000, "$"), fig("required_equity", 900000, "$"), fig("profit_on_cost_for_sale", 18.2, "%"), fig("margin_on_revenue", null, "%", reason)] };
    const words = page();
    expect(words).toContain("Edmonton, Alberta · 8 units for sale");
    expect(words).not.toContain("amounts in");
    expect(words).toContain(en.L.metric("profit_on_cost_for_sale"));
    expect(words).toContain(en.L.metric("margin_on_revenue"));
    expect(words).toContain(`The gate needs ${en.f.value(15, "%")}`);
    expect(words).toContain(reason);
    expect(words).not.toContain("$0");
    expect(words).not.toContain("The policy is a draft");
    expect(words).not.toContain(en.L.metric("development_spread"));
  });
  it("a link whose run cannot be read keeps today's page", () => {
    state.shared = { deal: "Shared reference", kind: "lender_package", format: "docx", runNumber: 3, expiresAt: null };
    const words = page();
    for (const s of ["Shared reference", "Lender package", "Run 3", "This link does not expire."]) expect(words).toContain(s);
    expect(words).not.toContain("shared this with you");
    expect(words).not.toContain("Every figure is printed");
  });
  it("French", () => {
    state.lang = "fr";
    state.shared = held;
    const words = page();
    expect(words).toContain("6 logements locatifs, conservés et refinancés");
    expect(words).toContain("montants en dollars canadiens");
  });
});
