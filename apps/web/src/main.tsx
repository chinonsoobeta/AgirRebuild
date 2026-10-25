import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider } from "@tanstack/react-router";
import { SessionGate, Shell } from "./components/ui";
import { Login, Signup } from "./routes/auth";
import { Deals } from "./routes/deals";
import { NewDeal } from "./routes/newdeal";
import { Documents } from "./routes/documents";
import { Review } from "./routes/review";
import { Run } from "./routes/run";
import { DecisionStep } from "./routes/decision";
import { Reports } from "./routes/reports";
import { Audit } from "./routes/audit";
import { Settings } from "./routes/settings";
import { ReviewAccess } from "./routes/review-access";
import { Explore } from "./routes/explore";
import { Compare } from "./routes/compare";
import { Share } from "./routes/share";
import { Invite } from "./routes/invite";
import { Home } from "./routes/landing";
import { Legal } from "./routes/legal";
import { I18nProvider } from "./i18n";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: (n, e: any) => e?.status !== 401 && e?.status !== 403 && e?.status !== 404 && n < 2 } } });

const root = createRootRoute({ component: () => <Outlet /> });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: Login });
const signup = createRoute({ getParentRoute: () => root, path: "/signup", component: Signup });
// A shared link: outside the session gate, so it opens without an account (card 86).
const share = createRoute({ getParentRoute: () => root, path: "/s/$secret", component: function SharedLink() { const { secret } = share.useParams(); return <Share secret={secret} />; } });
// An invitation to be a client of one deal (card 89): outside the session gate, like a shared link.
const invite = createRoute({ getParentRoute: () => root, path: "/i/$secret", component: function Invitation() { const { secret } = invite.useParams(); return <Invite secret={secret} />; } });
// "/" and the terms sit outside the session gate: signed out, "/" is the landing page (card W4).
const index = createRoute({ getParentRoute: () => root, path: "/", component: Home });
const legal = createRoute({ getParentRoute: () => root, path: "/legal", component: Legal });
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  component: () => (
    <SessionGate>
      <Shell>
        <Outlet />
      </Shell>
    </SessionGate>
  ),
});
const deals = createRoute({ getParentRoute: () => app, path: "/deals", component: Deals });
const newDeal = createRoute({ getParentRoute: () => app, path: "/deals/new", component: NewDeal });
const settings = createRoute({ getParentRoute: () => app, path: "/settings", component: Settings });
const reviewAccess = createRoute({ getParentRoute: () => app, path: "/settings/review-access", component: ReviewAccess });
const deal = createRoute({ getParentRoute: () => app, path: "/deals/$dealId", component: () => <Outlet /> });
const step = <P extends string>(path: P, C: (p: { dealId: string }) => React.JSX.Element) =>
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
const dealIndex = createRoute({ getParentRoute: () => deal, path: "/", component: function DealIndex() { const { dealId } = deal.useParams(); return <Navigate to="/deals/$dealId/documents" params={{ dealId }} />; } });

const routeTree = root.addChildren([
  login,
  signup,
  share,
  invite,
  index,
  legal,
  app.addChildren([
    deals,
    newDeal,
    settings,
    reviewAccess,
    deal.addChildren([dealIndex, step("documents", Documents), step("review", Review), runStep, step("decision", DecisionStep), step("reports", Reports), step("audit", Audit), step("explore", Explore), compare]),
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
