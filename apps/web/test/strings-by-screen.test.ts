import { describe, expect, it, vi } from "vitest";

// Card I: a screen's strings load with its route group, so the first page does not download every screen's strings.
// A fresh module registry stands for a first visit: only what the page has imported so far is loaded.
describe("strings by screen", () => {
  it("adds a screen's strings once its route module is imported, to tables already in use", async () => {
    vi.resetModules();
    const { build } = await import("../src/i18n.tsx");
    const en = build("en", () => {});
    const fr = build("fr", () => {});
    expect(en.t("shell.skip")).toBe("Skip to the main content");
    expect(en.t("landing.navHow")).toBeUndefined();
    await import("../src/routes/landing.tsx");
    expect(en.t("landing.navHow")).toBe("How it works");
    expect(fr.t("landing.navHow")).toBe("Comment ça marche");
  });
});
