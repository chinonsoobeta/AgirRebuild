import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Stryker's own config: only the engine's tests and no web setup file.
// The root is fixed here so Stryker runs the same tests from its sandbox copy.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["packages/engine/test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
