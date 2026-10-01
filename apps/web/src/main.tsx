import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Navigate, Outlet, RouterProvider } from "@tanstack/react-router";
import { SessionGate, Shell } from "./components/ui";
import { Login, Signup } from "./routes/auth";
import { Deals } from "./routes/deals";
import { Documents } from "./routes/documents";
import { Review } from "./routes/review";
import { Run } from "./routes/run";
import { DecisionStep } from "./routes/decision";
import { Reports } from "./routes/reports";
import { Audit } from "./routes/audit";
import { Settings } from "./routes/settings";
import { Explore } from "./routes/explore";
import { I18nProvider } from "./i18n";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: (n, e: any) => e?.status !== 401 && e?.status !== 403 && e?.status !== 404 && n < 2 } } });

const root = createRootRoute({ component: () => <Outlet /> });
const login = createRoute({ getParentRoute: () => root, path: "/login", component: Login });
const signup = createRoute({ getParentRoute: () => root, path: "/signup", component: Signup });
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
const index = createRoute({ getParentRoute: () => app, path: "/", component: () => <Navigate to="/deals" /> });
const deals = createRoute({ getParentRoute: () => app, path: "/deals", component: Deals });
const settings = createRoute({ getParentRoute: () => app, path: "/settings", component: Settings });
const deal = createRoute({ getParentRoute: () => app, path: "/deals/$dealId", component: () => <Outlet /> });
const step = <P extends string>(path: P, C: (p: { dealId: string }) => React.JSX.Element) =>
  createRoute({ getParentRoute: () => deal, path, component: function Step() { const { dealId } = deal.useParams(); return <C key={dealId} dealId={dealId} />; } });
const dealIndex = createRoute({ getParentRoute: () => deal, path: "/", component: function DealIndex() { const { dealId } = deal.useParams(); return <Navigate to="/deals/$dealId/documents" params={{ dealId }} />; } });

const routeTree = root.addChildren([
  login,
  signup,
  app.addChildren([
    index,
    deals,
    settings,
    deal.addChildren([dealIndex, step("documents", Documents), step("review", Review), step("run", Run), step("decision", DecisionStep), step("reports", Reports), step("audit", Audit), step("explore", Explore)]),
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
