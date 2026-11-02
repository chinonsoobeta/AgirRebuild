/// <reference types="node" />
import { describe, expect, it, vi } from "vitest";
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
    s.review = { ...payload([]), aiReading: outcome ? {outcome, unread: [], notUsed: [], pleaseCheck: [], sheetsLeftOut: []} : null };
    const html = render();
    expect(html.includes(">Read again</button>")).toBe(outcome === "failed" && role !== "viewer");
  }
});
it("read again posts and refreshes; its French label is rendered", async () => {
  s.role = "owner"; s.lang = "fr";
  s.review = { ...payload([]), aiReading: {outcome: "failed", unread: [], notUsed: [], pleaseCheck: [], sheetsLeftOut: []} };
  expect(render()).toContain(">Relire</button>");
  const button = s.nodes.find(n => n.tag === "button" && n.props.children === "Relire");
  expect(button).toBeDefined(); await button!.props.onClick();
  const { api } = await import("../src/api"); expect(api.post).toHaveBeenCalledWith("/deals/deal-1/read-again");
});

it.each(["owner", "admin", "analyst", "viewer"])("read again and unread notice for an incomplete ok reading: %s", role => {
  s.lang = "en"; s.role = role;
  s.review = { ...payload([]), aiReading: { outcome: "ok", unread: ["two.txt", "three.txt"], notUsed: [], pleaseCheck: [], sheetsLeftOut: [] } };
  const html = render();
  expect(html.includes(">Read again</button>")).toBe(role !== "viewer");
  expect(text(html)).toContain("AI reading has not covered two.txt, three.txt yet. The figures below come from Agir's rules and the earlier reading.");
  expect(text(html)).not.toContain("AI reading did not finish");
});

describe("Card 189: the notice when every file was set aside", () => {
  const notice = "Agir set aside every file it read as background, so no figures here came from them.";
  it("shows the notice and the link to an editor", () => {
    s.lang = "en"; s.role = "owner"; s.review = { ...payload([]), setAsideAll: true };
    const html = render();
    expect(text(html)).toContain(notice);
    expect(html).toContain('class="notice review" role="status"');
    expect(html).toContain('<a href="/deals/$dealId/documents">Choose what to read on Documents</a>');
    s.lang = "fr";
    const french = text(render());
    expect(french).toContain("Agir a classé comme contexte tous les fichiers qu'il a lus, donc aucun chiffre ici n'en vient.");
    expect(french).toContain("Choisir quoi lire à l'étape Documents");
    s.lang = "en";
  });
  it("the French note reaches Review's list of other figures", () => {
    s.lang = "fr"; s.role = "owner";
    s.review = { ...payload([]), other: [{ documentId: "d", document_name: "m.txt", raw: "$65,000", value: 65000, location: "line 3", context: "Reserve: $65,000", note: "This document looks like a market report; its figures are shown, not read. No field matches this label", figureId: "f", label: null, suggestions: [] }] };
    const french = text(render());
    expect(french).toContain("Ce document ressemble à un rapport de marché\u00a0; ses chiffres sont affichés, mais pas lus. Aucun champ ne correspond à ce libellé");
    expect(french).not.toContain("looks like");
    s.lang = "en";
  });
  it("shows nothing to a viewer, or when it is false", () => {
    s.lang = "en"; s.role = "viewer"; s.review = { ...payload([]), setAsideAll: true };
    expect(text(render())).not.toContain(notice);
    s.role = "owner"; s.review = { ...payload([]), setAsideAll: false };
    expect(text(render())).not.toContain(notice);
  });
});
