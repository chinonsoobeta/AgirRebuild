import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Stryker's own config: only the engine's tests and no web setup file.
// The root is fixed here so Stryker runs the same tests from its sandbox copy.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["packages/engine/test/**/*.test.ts"],
    // Instrumented code runs far slower than the gate's, so a test gets longer here and the behaviour rules try fewer cases.
    testTimeout: 180000,
    env: { BEHAVIOUR_RUNS_SCALE: "0.1" },
  },
});
