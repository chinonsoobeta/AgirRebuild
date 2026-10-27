import "./styles.css";
import { lazy, StrictMode, Suspense, useEffect, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider } from "@tanstack/react-router";
import { SessionGate, Shell } from "./components/ui";
import { I18nProvider, useI18n } from "./i18n";

// Each screen loads when it is first opened, so the first visit downloads only the shell (plan L5).
// `vite.config.ts` gathers the screens into one file per group: deal, settings, auth, share, landing.
const screen = <K extends string, M extends Record<K, ComponentType<any>>>(load: () => Promise<M>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const Login = screen(() => import("./routes/auth"), "Login");
const Signup = screen(() => import("./routes/auth"), "Signup");
const Deals = screen(() => import("./routes/deals"), "Deals");
const NewDeal = screen(() => import("./routes/newdeal"), "NewDeal");
const Documents = screen(() => import("./routes/documents"), "Documents");
const Review = screen(() => import("./routes/review"), "Review");
const Run = screen(() => import("./routes/run"), "Run");
const DecisionStep = screen(() => import("./routes/decision"), "DecisionStep");
const Reports = screen(() => import("./routes/reports"), "Reports");
const Audit = screen(() => import("./routes/audit"), "Audit");
const Settings = screen(() => import("./routes/settings"), "Settings");
const ReviewAccess = screen(() => import("./routes/review-access"), "ReviewAccess");
const Explore = screen(() => import("./routes/explore"), "Explore");
const Compare = screen(() => import("./routes/compare"), "Compare");
const Share = screen(() => import("./routes/share"), "Share");
const SharePreview = screen(() => import("./routes/share"), "SharePreview");
const Invite = screen(() => import("./routes/invite"), "Invite");
const Verify = screen(() => import("./routes/verify"), "Verify");
const Reset = screen(() => import("./routes/reset"), "Reset");
const EmailConfirm = screen(() => import("./routes/email-change"), "EmailConfirm");
const EmailUndo = screen(() => import("./routes/email-change"), "EmailUndo");
const Home = screen(() => import("./routes/landing"), "Home");
const Legal = screen(() => import("./routes/legal"), "Legal");

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: (n, e: any) => e?.status !== 401 && e?.status !== 403 && e?.status !== 404 && n < 2 } } });

// index.html carries a static page (the name and the landing headline) in #boot, beside #root, that shows before any code
// has arrived and while the router loads its first screen (QA item 9). The root route removes it when it first draws, and
// "/" keeps showing the same words while the landing screen's file loads, so they stay put instead of flashing.
const boot = document.getElementById("boot")?.innerHTML ?? "";
function RootScreen() {
  useEffect(() => { document.getElementById("boot")?.remove(); }, []);
  return <Suspense fallback={<Loading bar />}><Outlet /></Suspense>;
}
// While a screen's file loads, the page says so instead of going blank (QA item 9). Signed out there is no shell, so the
// fallback draws the top bar with the name; inside the app the shell's header stays and only the page area waits.
function Loading({ bar }: { bar?: boolean }) {
  const { t } = useI18n();
  if (bar && boot.trim() && location.pathname === "/") return <div dangerouslySetInnerHTML={{ __html: boot }} />;
  const body = (
    <div className="route-loading" aria-busy="true">
      <p className="muted">{t("common.loading")}</p>
      <span className="skel" /><span className="skel" /><span className="skel short" />
    </div>
  );
  if (!bar) return body;
  return (
    <>
      <header className="topbar">
        <span className="brand"><span className="brand-mark"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 18L12 5l8 13" /><path d="M8 18h8" /></svg></span>Agir</span>
      </header>
      <main className="page">{body}</main>
    </>
  );
}
const root = createRootRoute({ component: RootScreen });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: Login });
const signup = createRoute({ getParentRoute: () => root, path: "/signup", component: Signup });
// A shared link: outside the session gate, so it opens without an account (card 86).
const share = createRoute({ getParentRoute: () => root, path: "/s/$secret", component: function SharedLink() { const { secret } = share.useParams(); return <Share secret={secret} />; } });
// An invitation to be a client of one deal (card 89): outside the session gate, like a shared link.
const invite = createRoute({ getParentRoute: () => root, path: "/i/$secret", component: function Invitation() { const { secret } = invite.useParams(); return <Invite secret={secret} />; } });
// Confirming an email address and resetting a password (card W12): outside the session gate, like sign-in.
const verify = createRoute({ getParentRoute: () => root, path: "/verify", component: Verify });
const reset = createRoute({ getParentRoute: () => root, path: "/reset", component: Reset });
// The links in the change-of-address emails (card R6): outside the session gate, since they may be opened signed out.
const emailConfirm = createRoute({ getParentRoute: () => root, path: "/email/confirm", component: EmailConfirm });
const emailUndo = createRoute({ getParentRoute: () => root, path: "/email/undo", component: EmailUndo });
// "/" and the terms sit outside the session gate: signed out, "/" is the landing page (card W4).
const index = createRoute({ getParentRoute: () => root, path: "/", component: Home });
const legal = createRoute({ getParentRoute: () => root, path: "/legal", component: Legal });
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  component: () => (
    <SessionGate>
      <Shell>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </Shell>
    </SessionGate>
  ),
});
const deals = createRoute({ getParentRoute: () => app, path: "/deals", component: Deals });
const newDeal = createRoute({ getParentRoute: () => app, path: "/deals/new", component: NewDeal });
const settings = createRoute({ getParentRoute: () => app, path: "/settings", component: Settings });
const reviewAccess = createRoute({ getParentRoute: () => app, path: "/settings/review-access", component: ReviewAccess });
const deal = createRoute({ getParentRoute: () => app, path: "/deals/$dealId", component: () => <Outlet /> });
const step = <P extends string>(path: P, C: ComponentType<{ dealId: string }>) =>
  createRoute({ getParentRoute: () => deal, path, component: function Step() { const { dealId } = deal.useParams(); return <C key={dealId} dealId={dealId} />; } });
// Two runs side by side (card W11): `a` is this run, `b` the one it is compared against; both optional.
const compare = createRoute({
  getParentRoute: () => deal,
  path: "compare",
  validateSearch: (s: Record<string, unknown>): { a?: string; b?: string } => ({
    ...(typeof s.a === "string" ? { a: s.a } : {}),
    ...(typeof s.b === "string" ? { b: s.b } : {}),
  }),
  component: function CompareStep() {
    const { dealId } = deal.useParams();
    const { a, b } = compare.useSearch();
    const navigate = compare.useNavigate();
    return <Compare key={dealId} dealId={dealId} a={a} b={b} onPick={(next) => void navigate({ search: next, replace: true })} />;
  },
});
// A run in the address (card X3): `run` opens that run first; picking another from the history still works on the page.
const runStep = createRoute({
  getParentRoute: () => deal,
  path: "run",
  validateSearch: (s: Record<string, unknown>): { run?: string } => (typeof s.run === "string" ? { run: s.run } : {}),
  component: function RunStep() {
    const { dealId } = deal.useParams();
    const { run } = runStep.useSearch();
    return <Run key={`${dealId}:${run ?? ""}`} dealId={dealId} run={run} />;
  },
});
// What a shared link's recipient sees, previewed by the deal's staff (card R2); opening it here is not counted.
const sharePreview = createRoute({
  getParentRoute: () => deal,
  path: "reports/preview/$linkId",
  component: function SharePreviewStep() {
    const { dealId } = deal.useParams();
    const { linkId } = sharePreview.useParams();
    return <SharePreview key={`${dealId}:${linkId}`} dealId={dealId} linkId={linkId} />;
  },
});
const dealIndex = createRoute({ getParentRoute: () => deal, path: "/", component: function DealIndex() { const { dealId } = deal.useParams(); return <Navigate to="/deals/$dealId/documents" params={{ dealId }} />; } });

const routeTree = root.addChildren([
  login,
  signup,
  share,
  invite,
  verify,
  reset,
  emailConfirm,
  emailUndo,
  index,
  legal,
  app.addChildren([
    deals,
    newDeal,
    settings,
    reviewAccess,
    deal.addChildren([dealIndex, step("documents", Documents), step("review", Review), runStep, step("decision", DecisionStep), step("reports", Reports), sharePreview, step("audit", Audit), step("explore", Explore), compare]),
  ]),
]);
const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
