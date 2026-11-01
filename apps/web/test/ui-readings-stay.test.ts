/// <reference types="node" />
import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Review as ReviewData } from "../src/api";
import type { Lang } from "../src/i18n.tsx";

// Card 184: server rendering and the neighbouring Review tests' hook mocks, without a DOM.
const s = vi.hoisted(() => ({ lang: "en" as Lang, review: undefined as unknown, role: "owner",
  nodes: [] as { tag: string; props: Record<string, any> }[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => (options.queryKey[0] === "review" ? { data: s.review } : {}),
  useMutation: (o: { mutationFn: (b: any) => Promise<any>; onSuccess?: (d: any) => unknown }) => ({
    mutate: async (b: unknown) => { const d = await o.mutationFn(b); await o.onSuccess?.(d); }, isPending: false, reset: () => {}, error: null, variables: undefined,
  }),
  useQueryClient: () => ({ invalidateQueries: async () => {} }),
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
    useDeal: () => ({ data: { deal: { currency: "CAD", location: "Burnaby, BC", province: "BC" }, updating: false, run: null, documents: { total: 2, processing: 0, failed: 0 } } }),
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

it.each(["owner", "admin", "analyst", "viewer"])("read again shown only for editors with a failed reading: %s", role => {
  s.role = role;
  for (const outcome of ["failed", "ok", null]) {
    s.review = { ...payload([]), aiReading: outcome ? {outcome, notUsed: [], pleaseCheck: []} : null };
    const html = render();
    expect(html.includes(">Read again</button>")).toBe(outcome === "failed" && role !== "viewer");
  }
});
it("read again posts and refreshes; its French label is rendered", async () => {
  s.role = "owner"; s.lang = "fr";
  s.review = { ...payload([]), aiReading: {outcome: "failed", notUsed: [], pleaseCheck: []} };
  expect(render()).toContain(">Relire</button>");
  const button = s.nodes.find(n => n.tag === "button" && n.props.children === "Relire");
  expect(button).toBeDefined(); await button!.props.onClick();
  const { api } = await import("../src/api"); expect(api.post).toHaveBeenCalledWith("/deals/deal-1/read-again");
});
