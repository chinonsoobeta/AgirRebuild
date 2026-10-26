import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30000,
    // The web tests read every screen's strings; the app loads each area's with its screens (card I).
    setupFiles: ["apps/web/test/setup.ts"],
  },
});
