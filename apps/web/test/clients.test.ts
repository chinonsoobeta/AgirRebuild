/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type Assumption } from "../src/api";
import { canDecide, canEdit } from "../src/components/ui";
import { ClientConfirmation, TableProposal } from "../src/routes/review.tsx";
import { ClientsPanel, LogoPanel } from "../src/routes/settings.tsx";
import { Invite } from "../src/routes/invite.tsx";
import { Reports } from "../src/routes/reports.tsx";
import { build, type Lang } from "../src/i18n.tsx";

// Card 89c: the screens of a broker's client. Mocks follow apps/web/test/run.test.ts.
const state = vi.hoisted(() => ({ lang: "en" as Lang, role: "client", me: undefined as unknown, meError: null as unknown, invite: undefined as unknown, inviteError: null as unknown,
  clients: [] as unknown[], invites: [] as unknown[], artifacts: [] as unknown[], secret: "", options: [] as { queryKey: unknown[] }[],
  hooks: [] as unknown[], index: 0, nodes: [] as { tag: string; props: Record<string, any> }[], invalidate: vi.fn(async () => {}), navigate: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    state.options.push(options);
    const key = options.queryKey[0];
    return key === "me" ? { data: state.me, error: state.meError, isLoading: false } : key === "invite" ? { data: state.invite, error: state.inviteError }
      : key === "deal-clients" ? { data: state.clients } : key === "invites" ? { data: state.invites } : key === "artifacts" ? { data: state.artifacts }
      : key === "share-links" ? { data: [] } : {};
  },
  useMutation: (options: { mutationFn: (body: any) => Promise<any>; onSuccess?: (data: any) => unknown }) => ({
    mutate: async (body: unknown) => { const data = await options.mutationFn(body); await options.onSuccess?.(data); },
    isPending: false, reset: () => {}, error: null,
  }),
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("../src/components/ui", async (original) => {
  const ui = await original<typeof import("../src/components/ui")>();
  const { createElement } = await import("react");
  return {
    ...ui,
    DealHeader: () => createElement("header", null, "Deal header"),
    useDeal: () => ({ data: { run: { id: "run-1", number: 1, fresh: true }, documents: { total: 0, processing: 0, failed: 0 } } }),
    useSession: () => ({ solo: false, role: state.role, workspaceId: "ws", me: { user: { id: "me-id", name: "Me" }, workspaces: [] } }),
  };
});
vi.mock("../src/i18n", async (original) => {
  const i18n = await original<typeof import("../src/i18n")>();
  return { ...i18n, useI18n: () => i18n.build(state.lang, () => {}) };
});
vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return { Link: ({ children }: { children: unknown }) => createElement("a", null, children as string), useNavigate: () => state.navigate };
});
vi.mock("../src/api", async (original) => {
  const real = await original<typeof import("../src/api")>();
  return { ...real, api: { ...real.api,
    get: vi.fn(async (path: string) => path.startsWith("/deals/") ? { deal: { id: "deal-1", workspace_id: "ws-client" } } : state.invite),
    post: vi.fn(async (path: string) => path.endsWith("/invites") ? { id: "new-invite", url: `/i/${state.secret}` }
      : path.endsWith("/accept") ? { ok: true, dealId: "deal-1" } : { ok: true }),
    del: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => ({ mime: "image/png", width: 120, height: 40 })),
  } };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => {
    const n = state.index++;
    if (!(n in state.hooks)) state.hooks[n] = initial;
    return [state.hooks[n], (value: unknown) => { state.hooks[n] = value; }];
  } };
});
vi.mock("react/jsx-dev-runtime", async (original) => {
  const runtime = await original<typeof import("react/jsx-dev-runtime")>();
  return { ...runtime, jsxDEV: (...args: Parameters<typeof runtime.jsxDEV>) => {
    if (typeof args[0] === "string" && ["button", "select", "input", "a", "form", "img"].includes(args[0])) state.nodes.push({ tag: args[0], props: args[1] as Record<string, any> });
    return runtime.jsxDEV(...args);
  } };
});

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) => {
  state.index = 0; state.nodes = [];
  return renderToStaticMarkup(element).replaceAll(state.secret, "[redacted]");
};
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replace(/\s+/g, " ").trim();
const buttons = (label: string) => state.nodes.filter((n) => n.tag === "button" && n.props.children === label);
const stated = (over: Partial<Assumption> = {}) => ({ id: "a1", status: "approved", sponsorStated: true, version: 4, clientConfirmedBy: null, clientConfirmedById: null,
  clientConfirmedAt: null, ...over }) as Assumption;

beforeEach(() => {
  state.lang = "en"; state.role = "client"; state.me = undefined; state.meError = null; state.invite = { workspace: "Harbour Brokers", deal: "Elm Street fourplex" };
  state.inviteError = null; state.clients = []; state.invites = []; state.artifacts = []; state.options = []; state.hooks = [];
  state.secret = randomBytes(32).toString("base64url");
  vi.clearAllMocks();
  vi.stubGlobal("window", { location: { origin: "https://agir.test" }, confirm: vi.fn(() => true) });
  vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => {}) } });
  vi.stubGlobal("localStorage", { setItem: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("a client's controls (task 89c)", () => {
  it("a client may not edit, run, request a report or decide", () => {
    expect(canEdit("client")).toBe(false);
    expect(canDecide("client")).toBe(false);
    for (const staff of ["owner", "admin", "analyst"]) expect(canEdit(staff)).toBe(true);
  });
  it("a client's reports screen has no enabled report button and no share button", () => {
    state.artifacts = [{ id: "ready", kind: "lender_package", format: "pdf", status: "ready", error: null, sha256: null, created_at: "2026-10-19T12:00:00Z", run_id: "run-1", run_number: 1, provenance_entries: null }];
    render(createElement(Reports, { dealId: "deal-1" }));
    const reportButtons = state.nodes.filter((n) => n.tag === "button" && n.props.type === "button" && n.props.className === "btn");
    expect(reportButtons.length).toBeGreaterThan(0);
    expect(reportButtons.every((b) => b.props.disabled)).toBe(true);
    expect(buttons("Share").length).toBe(0);
    expect(state.nodes.some((n) => n.tag === "a" && n.props.children?.[1] === "Download")).toBe(true);
  });
  it.each(["en", "fr"] as const)("names the client role in %s", (lang) => {
    expect(build(lang, () => {}).L.role("client")).toBe(lang === "en" ? "client" : "client");
    expect(build(lang, () => {}).t("settings.r.client")).toBe(lang === "en"
      ? "Reads the deals assigned to it and confirms the values the broker stated. Changes nothing else."
      : "Consulte les projets qui lui sont confiés et confirme les valeurs déclarées par le courtier. Ne modifie rien d'autre.");
  });
});

describe("a client's confirmation on the review screen (task 89c)", () => {
  it("a client sees Confirm on a stated value it has not confirmed, and the button posts the version", async () => {
    render(createElement(ClientConfirmation, { a: stated(), isClient: true, meId: "me-id" }));
    const [confirm] = buttons("Confirm");
    expect(Boolean(confirm)).toBe(true);
    await confirm!.props.onClick();
    expect(vi.mocked(api.post).mock.calls).toEqual([["/assumptions/a1/client-confirm", { version: 4 }]]);
    expect(state.invalidate.mock.calls.length).toBeGreaterThan(0);
  });
  it("no Confirm for staff, nor on a value that is not sponsor-stated", () => {
    expect(text(render(createElement(ClientConfirmation, { a: stated(), isClient: false, meId: "me-id" })))).toBe("");
    expect(text(render(createElement(ClientConfirmation, { a: stated({ sponsorStated: false }), isClient: true, meId: "me-id" })))).toBe("");
  });
  it("after confirming, the client reads Confirmed by you; staff read the client's name", () => {
    const done = stated({ clientConfirmedBy: "Dana Client", clientConfirmedById: "me-id", clientConfirmedAt: "2026-10-19T12:00:00Z" } as Partial<Assumption>);
    const mine = text(render(createElement(ClientConfirmation, { a: done, isClient: true, meId: "me-id" })));
    expect(mine).toMatch(/^Confirmed by you on Oct(ober)? 19, 2026/);
    expect(buttons("Confirm").length).toBe(0);
    expect(text(render(createElement(ClientConfirmation, { a: done, isClient: false, meId: "staff-id" })))).toMatch(/^Confirmed by the client Dana Client on Oct(ober)? 19, 2026/);
  });
  it("another client's confirmation, whose name a client cannot see, reads as another client's", () => {
    const other = stated({ clientConfirmedBy: null, clientConfirmedById: "other-id", clientConfirmedAt: "2026-10-19T12:00:00Z" } as Partial<Assumption>);
    expect(text(render(createElement(ClientConfirmation, { a: other, isClient: true, meId: "me-id" })))).toMatch(/^Confirmed by another client on Oct(ober)? 19, 2026/);
  });
  it("French", () => {
    state.lang = "fr";
    render(createElement(ClientConfirmation, { a: stated(), isClient: true, meId: "me-id" }));
    expect(buttons("Confirmer").length).toBe(1);
    const done = stated({ clientConfirmedBy: "Dana Client", clientConfirmedById: "me-id", clientConfirmedAt: "2026-10-19T12:00:00Z" } as Partial<Assumption>);
    expect(text(render(createElement(ClientConfirmation, { a: done, isClient: true, meId: "me-id" })))).toMatch(/^Confirmée par vous le 19 oct\.? 2026/);
    expect(text(render(createElement(ClientConfirmation, { a: done, isClient: false, meId: "x" })))).toMatch(/^Confirmée par le client Dana Client le 19 oct\.? 2026/);
  });
});

describe("the clients section of settings (task 89c)", () => {
  const invite = (id: string, over: Record<string, unknown> = {}) => ({ id, created_at: "2026-10-19T12:00:00Z", expires_at: "2099-10-26T12:00:00Z", created_by: "Alice Admin",
    used_at: null, used_by: null, revoked_at: null, revoked_by: null, ...over });
  it("lists the deal's clients, adds by email and removes", async () => {
    state.role = "admin";
    state.clients = [{ id: "u-dana", name: "Dana Client", email: "dana@example.test", assigned_at: "2026-10-19T12:00:00Z" }];
    const html = text(render(createElement(ClientsPanel, { dealId: "deal-1" })));
    for (const s of ["Clients of this deal", "Dana Client", "dana@example.test"]) expect(html).toContain(s);
    const form = state.nodes.find((n) => n.tag === "form")!;
    await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { reset: () => {}, elements: { namedItem: () => ({ value: "erin@example.test" }) } } });
    expect(vi.mocked(api.post).mock.calls).toContainEqual(["/deals/deal-1/clients", { email: "erin@example.test" }]);
    await buttons("Remove")[0]!.props.onClick();
    expect(vi.mocked(window.confirm).mock.calls.length).toBe(1);
    expect(vi.mocked(api.del).mock.calls).toContainEqual(["/deals/deal-1/clients/u-dana", {}]);
  });
  it("makes an invitation link, shows it once with a copy button", async () => {
    state.role = "owner";
    render(createElement(ClientsPanel, { dealId: "deal-1" }));
    await buttons("Make an invitation link")[0]!.props.onClick();
    const html = render(createElement(ClientsPanel, { dealId: "deal-1" }));
    expect(html).toContain("Copy this link now. It is not shown again.");
    const input = state.nodes.find((n) => n.tag === "input" && n.props.readOnly)!;
    expect(input.props.value === `https://agir.test/i/${state.secret}`).toBe(true);
    await buttons("Copy")[0]!.props.onClick();
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0] === input.props.value).toBe(true);
    expect(html).not.toContain(state.secret);
  });
  it("lists invitations by status and revokes only an open one", async () => {
    state.role = "admin";
    state.invites = [invite("open"), invite("used", { used_at: "2026-10-19T13:00:00Z", used_by: "Dana Client" }), invite("revoked", { revoked_at: "2026-10-19T13:00:00Z", revoked_by: "Alice Admin" }),
      invite("expired", { expires_at: "2000-01-01T00:00:00Z" })];
    const html = text(render(createElement(ClientsPanel, { dealId: "deal-1" })));
    for (const s of ["Invitations", "Open", "Used by Dana Client", "Revoked", "Expired"]) expect(html).toContain(s);
    expect(buttons("Revoke").length).toBe(1);
    await buttons("Revoke")[0]!.props.onClick();
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe("Revoke this invitation? Nobody will be able to use it.");
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === "/invites/open/revoke")).toBe(true);
  });
  it("French", () => {
    state.lang = "fr"; state.role = "admin";
    state.invites = [invite("used", { used_at: "2026-10-19T13:00:00Z", used_by: "Dana Client" })];
    const html = text(render(createElement(ClientsPanel, { dealId: "deal-1" })));
    for (const s of ["Clients de ce projet", "Créer un lien d'invitation", "Invitations", "Utilisée par Dana Client"]) expect(html).toContain(s);
  });
});

describe("the invitation page (task 89c)", () => {
  const page = () => render(createElement(Invite, { secret: state.secret }));
  it("a dead link shows only the API sentence", () => {
    state.invite = undefined;
    state.inviteError = new ApiError(404, "This invitation is not available. It may have been used, revoked or expired.");
    expect(text(page())).toBe("This invitation is not available. It may have been used, revoked or expired.");
  });
  it("signed out: names the workspace and deal and signs up with the invitation", async () => {
    state.meError = new ApiError(401, "Sign in to continue.");
    const html = text(page());
    for (const s of ["Harbour Brokers", "Elm Street fourplex", "Name", "Email", "Password", "Create my account"]) expect(html).toContain(s);
    expect(buttons("Join as a client").length).toBe(0);
    const form = state.nodes.find((n) => n.tag === "form")!;
    const values: Record<string, string> = { name: "Dana Client", email: "dana@example.test", password: "a-long-password" };
    await form.props.onSubmit({ preventDefault: () => {}, currentTarget: { elements: { namedItem: (k: string) => ({ value: values[k] }) } } });
    const call = vi.mocked(api.post).mock.calls.find(([p]) => p === "/auth/signup")!;
    expect(call[1]).toEqual({ ...values, invite: state.secret });
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals" });
  });
  it("signed in: a Join as a client button accepts and opens the deal's review", async () => {
    state.me = { user: { id: "me-id", name: "Dana" }, workspaces: [] };
    const html = text(page());
    expect(html).toContain("Elm Street fourplex");
    expect(html).not.toContain("Create my account");
    await buttons("Join as a client")[0]!.props.onClick();
    expect(vi.mocked(api.post).mock.calls.some(([p]) => p === `/invite/${state.secret}/accept`)).toBe(true);
    expect(vi.mocked(localStorage.setItem).mock.calls).toEqual([["agir.workspace", "ws-client"]]);
    expect(state.navigate.mock.calls[0]![0]).toEqual({ to: "/deals/$dealId/review", params: { dealId: "deal-1" } });
  });
  it("French", () => {
    state.lang = "fr"; state.me = { user: { id: "me-id", name: "Dana" }, workspaces: [] };
    page();
    expect(buttons("Rejoindre comme client").length).toBe(1);
    state.me = undefined; state.meError = new ApiError(401, "x");
    expect(text(page())).toContain("Créer mon compte");
  });
});

describe("the logo section of settings (task 89d)", () => {
  it("without a logo: the owner picks a PNG or JPEG, which is posted", async () => {
    const html = text(render(createElement(LogoPanel, { workspaceId: "ws", hasLogo: false })));
    for (const s of ["Logo on the lender package", "PNG or JPEG, at most 500 KB. It appears, with Prepared by and this workspace's name, only on the lender package."]) expect(html).toContain(s);
    expect(state.nodes.some((n) => n.tag === "img")).toBe(false);
    const input = state.nodes.find((n) => n.tag === "input" && n.props.type === "file")!;
    expect(input.props.accept).toBe("image/png,image/jpeg");
    const file = { name: "logo.png" };
    await input.props.onChange({ currentTarget: { files: [file], value: "x" } });
    expect(vi.mocked(api.upload).mock.calls).toEqual([["/workspaces/ws/logo", file, "POST"]]);
    expect(state.invalidate.mock.calls.length).toBeGreaterThan(0);
  });
  it("with a logo: a preview and Remove, after confirmation", async () => {
    render(createElement(LogoPanel, { workspaceId: "ws", hasLogo: true }));
    const img = state.nodes.find((n) => n.tag === "img")!;
    expect(String(img.props.src)).toMatch(/^\/api\/workspaces\/ws\/logo/);
    expect(img.props.style.maxHeight).toBe(48);
    await buttons("Remove")[0]!.props.onClick();
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toBe("Remove the logo? Lender packages made from now on will not show it.");
    expect(vi.mocked(api.del).mock.calls).toEqual([["/workspaces/ws/logo", {}]]);
  });
  it("French", () => {
    state.lang = "fr";
    expect(text(render(createElement(LogoPanel, { workspaceId: "ws", hasLogo: true })))).toContain("Logo sur le dossier pour le prêteur");
  });
});


describe("card 94c table proposal controls", () => {
  const proposal = (options = [{label:"CMHC MLI Select, 50 points",value:5.49,reason:"Proposed from CMHC, Multi-unit Fees and Premiums (effective 2025-07-14, read 2026-10-19): CMHC MLI Select, 50 points."}]) => ({fieldKey:"refinance_insurance_premium_pct",tableId:"cmhc-premium",title:"Multi-unit Fees and Premiums",publisher:"CMHC",url:"https://example.test/official",effective:"2025-07-14",options});
  it("shows a single proposal with source and accepts its exact value and reason", () => {
    state.role="owner"; const onUse=vi.fn(), p=proposal();
    const html=render(createElement(TableProposal,{proposal:p,unit:"%",onUse,busy:false}));
    expect(text(html)).toContain("Proposed: 5.49% — CMHC, effective 2025-07-14");
    expect(html).toContain('href="https://example.test/official"');
    expect(buttons("Use this")).toHaveLength(1);
    buttons("Use this")[0]!.props.onClick();
    expect(onUse).toHaveBeenCalledWith({fieldKey:p.fieldKey,value:5.49,reason:p.options[0]!.reason});
  });
  it("offers a labelled select and accepts the chosen option", () => {
    state.role="analyst"; const onUse=vi.fn();
    const p=proposal([{label:"Ontario, outside Toronto",value:16475,reason:"First official option"},{label:"Toronto",value:32950,reason:"Second official option"}]);
    const element=createElement(TableProposal,{proposal:p,unit:"$",onUse,busy:false});
    const html=render(element);
    expect(html).toContain("<select");
    const select=state.nodes.find(n=>n.tag === "select")!;
    expect(select.props["aria-label"]).toBeTruthy();
    select.props.onChange({target:{value:"1"}}); render(element);
    buttons("Use this")[0]!.props.onClick();
    expect(onUse).toHaveBeenCalledWith({fieldKey:p.fieldKey,value:32950,reason:"Second official option"});
  });
  it("displays an unavailable proposal without acceptance", () => {
    state.role="owner";
    const html=render(createElement(TableProposal,{proposal:{...proposal([]),unavailable:"the table needs a loan-to-value"},unit:"%",onUse:vi.fn(),busy:false}));
    expect(text(html)).toContain("the table needs a loan-to-value");
    expect(buttons("Use this")).toHaveLength(0);
  });
  it("a client sees the proposal but no Use this control", () => {
    state.role="client";
    const html=render(createElement(TableProposal,{proposal:proposal(),unit:"%",onUse:vi.fn(),busy:false}));
    expect(text(html)).toContain("CMHC");expect(buttons("Use this")).toHaveLength(0);
  });
  it("explains Quebec QST in French without calculating an amount", () => {
    state.lang="fr";state.role="owner";
    const unavailable="Quebec has no full QST rebate for purpose-built rentals (the full rebate covers GST only). QST of 9.975% on the fair market value at completion is payable, less a rebate of up to $7,182 per unit that is nil at $225,000 or more per unit. Enter the net amount.";
    const html=render(createElement(TableProposal,{proposal:{...proposal([]),unavailable},unit:"$",onUse:vi.fn(),busy:false}));
    const words=text(html);
    expect(words).toContain("aucun remboursement intégral de la TVQ");expect(words).toContain("7 182");
    expect(words).toContain("9,975");expect(words).toContain("225 000");
    expect(buttons("Use this")).toHaveLength(0);
  });
});
