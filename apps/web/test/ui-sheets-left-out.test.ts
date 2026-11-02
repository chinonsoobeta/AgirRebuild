/// <reference types="node" />
import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Review says which sheets of a long workbook the AI reader did not get. Server rendering and the neighbouring Review tests' hook mocks, without a DOM.
const s = vi.hoisted(() => ({ lang: "en" as Lang, review: undefined as unknown, role: "owner",
  nodes: [] as { tag: string; props: Record<string, any> }[], mutation: {} as Record<string, unknown>, deal: { updating: false, processing: 0 }, invalidate: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "review" ? { data: s.review } : {}),
  useMutation: (o: { mutationFn: (b: any) => Promise<any>; onSuccess?: (d: any) => unknown }) => ({
    mutate: async (b: unknown) => { const d = await o.mutationFn(b); await o.onSuccess?.(d); }, isPending: false, isSuccess: false, reset: () => {}, error: null, variables: undefined, ...(String(o.mutationFn).includes("/role") ? s.mutation : {}),
  }),
  useQueryClient: () => ({ invalidateQueries: s.invalidate }),
}));
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ to, children }: { to: string; children: unknown }) => createElement("a", { href: to }, children as string), useNavigate: () => () => {}, useBlocker: () => ({ status: "idle" }) };
});
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealFrame: () => createElement("header", null, "Deal frame"),
    useDeal: () => ({ data: { deal: { currency: "CAD", location: "Burnaby, BC", province: "BC" }, updating: s.deal.updating, run: null, documents: { total: 2, processing: s.deal.processing, failed: 0 } } }),
    useSession: () => ({ solo: true, role: s.role, workspaceId: "ws", me: { user: { id: "me-id", name: "Morgan" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(s.lang, () => {}) };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api, get: vi.fn(async () => undefined), post: vi.fn(async () => ({})) } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "form", "input"].includes(args[0])) s.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

import { Review } from "../src/routes/review.tsx";

const payload = (notNeeded: ReviewData["notNeeded"]): ReviewData => ({
  assumptions: [], missing: [], choices: [], regions: [], tableNotices: [], aiReading: null, proposals: [], other: [], notFound: [], notNeeded,
  readiness: { status: "ready", missing: [], conflicting: [], pending: [], impossible: [], notFound: [], choices: [], defaultable: [] },
  todo: { blocking: 0, items: [] },
} as unknown as ReviewData);
const render = () => { s.nodes = []; return renderToStaticMarkup(createElement(Review, { dealId: "deal-1" })).replaceAll("&#x27;", "'"); };
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&amp;", "&").replaceAll("&nbsp;", "\u00a0").replace(/[ \t\n]+/g, " ").trim();

type LeftOut = { id: string; name: string; sheets: string[]; readAnyway: "deal_source" | "evidence" | null };
const file = (sheets = ["Ledger", "Rents"], readAnyway: LeftOut["readAnyway"] = "deal_source", name = "model.xlsx", id = "doc-1"): LeftOut => ({ id, name, sheets, readAnyway });
const set = (sheetsLeftOut: LeftOut[]) => { s.review = { ...payload([]), aiReading: { outcome: "ok", unread: [], notUsed: [], pleaseCheck: [], sheetsLeftOut } }; };
const buttons = () => s.nodes.filter(n => n.tag === "button" && /^(Read .* anyway|Lire .* quand même)$/.test(n.props["aria-label"] ?? ""));
beforeEach(() => { s.lang = "en"; s.role = "owner"; s.mutation = {}; s.deal = { updating: false, processing: 0 }; vi.clearAllMocks(); });
it("names the sheets omitted from a workbook", () => {
  set([file()]);
  expect(text(render())).toContain("model.xlsx is long, so the AI reader did not get these sheets: Ledger, Rents. Agir's rules still read them.");
});
it("names the sheets and action in French", () => {
  s.lang = "fr"; set([file()]);
  expect(text(render()).replaceAll("\u00a0", " ")).toContain("model.xlsx est long, donc le lecteur IA n’a pas reçu ces feuilles : Ledger, Rents. Les règles d’Agir les lisent quand même.");
  expect(buttons()[0]?.props.children).toBe("Le lire quand même");
});
it.each(["en", "fr"] as Lang[])("seven sheets are shortened in %s", lang => {
  s.lang = lang; set([file(["A", "B", "C", "D", "E", "F", "G"])]);
  expect(text(render())).toContain(lang === "en" ? "A, B, C, D, E and 2 more. Agir's rules" : "A, B, C, D, E et 2 autres. Les règles");
});
it.each(["en", "fr"] as Lang[])("five sheets have no remainder in %s", lang => {
  s.lang = lang; set([file(["A", "B", "C", "D", "E"])]);
  expect(text(render())).toContain(lang === "en" ? "A, B, C, D, E. Agir's rules" : "A, B, C, D, E. Les règles");
});
it.each(["en", "fr"] as Lang[])("CSV file notice in %s", lang => {
  s.lang = lang; set([file([], "deal_source", "rents.csv")]);
  expect(text(render())).toContain(lang === "en" ? "rents.csv is long, so the AI reader did not get it. Agir's rules still read it." : "rents.csv est long, donc le lecteur IA ne l’a pas reçu. Les règles d’Agir le lisent quand même.");
});
it.each(["owner", "admin", "analyst", "viewer"])("notice and editor permissions for %s", role => {
  s.role = role; set([file()]);
  expect(text(render())).toContain("model.xlsx is long");
  expect(buttons()).toHaveLength(role === "viewer" ? 0 : 1);
});
it("person already asked: notice without action", () => {
  set([file(["Ledger"], null)]); expect(text(render())).toContain("model.xlsx is long"); expect(buttons()).toHaveLength(0);
});
it("empty list has no notice or action", () => {
  set([]); expect(text(render())).not.toContain("is long"); expect(buttons()).toHaveLength(0);
});
it.each(["deal_source", "evidence"] as const)("action posts the %s role", async role => {
  set([file(["Ledger"], role)]); render();
  expect(buttons()[0]?.props["aria-label"]).toBe("Read model.xlsx anyway");
  expect(buttons()).toHaveLength(1); await buttons()[0]!.props.onClick();
  const { api } = await import("../src/api");
  expect(api.post).toHaveBeenCalledWith("/documents/doc-1/role", { role });
});
it("two files each have their own named action", () => {
  set([file(), file(["Archive"], "evidence", "other.xlsx", "doc-2")]); render();
  expect(buttons().map(b => b.props["aria-label"])).toEqual(["Read model.xlsx anyway", "Read other.xlsx anyway"]);
});

// What the audit added: what happens around the click.
it("the click refreshes both the review and the deal, so the page follows the reading", async () => {
  set([file()]); render();
  await buttons()[0]!.props.onClick();
  const keys = s.invalidate.mock.calls.map(call => (call as unknown as [{ queryKey: unknown[] }])[0].queryKey);
  expect(keys).toContainEqual(["review", "deal-1"]);
  expect(keys).toContainEqual(["deal", "deal-1"]);
});
it("the button waits while the request is on its way", () => {
  set([file()]); s.mutation = { isPending: true }; render();
  expect(buttons()[0]!.props.disabled).toBe(true);
  s.mutation = {}; render();
  expect(buttons()[0]!.props.disabled).toBe(false);
});
it("a refused request is shown", () => {
  set([file()]); s.mutation = { error: new Error("Refused while testing") };
  expect(text(render())).toContain("Refused while testing");
});
const READING_NOW = { en: "Reading it now. This page updates when the reading is done.", fr: "Lecture en cours. Cette page se met à jour une fois la lecture terminée." };
it.each(["en", "fr"] as Lang[])("after the click, a line where the button was says the reading is on its way, in %s", lang => {
  s.lang = lang; s.review = payload([]);
  s.mutation = { isSuccess: true }; s.deal = { updating: false, processing: 1 };
  const html = render();
  expect(text(html)).toContain(READING_NOW[lang]);
  expect(html).toContain(`<p class="small muted" role="status">${READING_NOW[lang]}</p>`);
});
it("the line stays until the reading itself ends", () => {
  s.review = payload([]); s.mutation = { isSuccess: true };
  s.deal = { updating: true, processing: 0 };
  expect(text(render())).toContain(READING_NOW.en);
  s.deal = { updating: false, processing: 0 };
  expect(text(render())).not.toContain(READING_NOW.en);
});
it("no line without the click, however busy the deal is", () => {
  s.review = payload([]); s.deal = { updating: true, processing: 2 };
  expect(text(render())).not.toContain(READING_NOW.en);
});
