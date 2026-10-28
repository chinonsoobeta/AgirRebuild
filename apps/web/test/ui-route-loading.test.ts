import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// QA run 3: the router wraps the first screen in a Suspense whose fallback is the pending component. On "/" it must keep
// the static landing top from index.html on screen while the landing screen's file loads, instead of a blank frame;
// elsewhere, outside the app, it draws the top bar and the loading line; inside the app only the page area waits.
const BOOT = '<div class="landing boot-landing" aria-busy="true"><h1 class="ld-h1">Decide whether to build, with numbers a lender can check.</h1></div>';
// Each test re-imports the modules after the stubs are in place, so the provider and the component share one i18n module.
const load = async () => {
  const [{ I18nProvider }, ui] = await Promise.all([import("../src/i18n.tsx"), import("../src/components/ui.tsx")]);
  return { ...ui, render: (el: React.ReactElement) => renderToStaticMarkup(createElement(I18nProvider, null, el)) };
};

describe("the route loading state (QA run 3)", () => {
  // The web tests run in Node: stand in for the document (index.html's #boot) and the location the component reads.
  const g = globalThis as { document?: unknown; location?: unknown };
  const at = (pathname: string, boot = BOOT) => {
    g.document = { documentElement: { lang: "" }, querySelector: (sel: string) => (sel === "#boot .boot-landing" ? { outerHTML: boot } : null) };
    g.location = { pathname };
  };
  beforeEach(() => vi.resetModules());
  afterEach(() => { delete g.document; delete g.location; });

  it("keeps the landing top on '/' while the landing screen loads", async () => {
    at("/");
    const { RouteLoading, render } = await load();
    const html = render(createElement(RouteLoading, { bar: true }));
    expect(html).toContain("Decide whether to build, with numbers a lender can check.");
    expect(html).not.toContain("route-loading");
  });

  it("draws the top bar and the loading line on a public page", async () => {
    at("/signup");
    const { RouteLoading, render } = await load();
    const html = render(createElement(RouteLoading, { bar: true }));
    expect(html).toContain('class="topbar"');
    expect(html).toContain("Loading…");
    expect(html).toContain("route-loading");
  });

  it("waits in the page area only inside the app", async () => {
    at("/deals");
    const { RouteLoading, isAppPath, render } = await load();
    const html = render(createElement(RouteLoading, {}));
    expect(html).not.toContain("topbar");
    expect(html).toContain("route-loading");
    expect(isAppPath("/deals/abc/review")).toBe(true);
    expect(isAppPath("/settings")).toBe(true);
    expect(["/", "/login", "/signup", "/verify", "/legal", "/s/x", "/i/x", "/email/confirm"].some(isAppPath)).toBe(false);
  });
});
