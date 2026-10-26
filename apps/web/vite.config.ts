import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The screens in groups (plan L5): one file per group, loaded the first time one of its screens opens.
const GROUPS: Record<string, string> = {
  deals: "deal", newdeal: "deal", documents: "deal", review: "deal", run: "deal", decision: "deal", reports: "deal",
  audit: "deal", explore: "deal", compare: "deal",
  settings: "settings", "review-access": "settings",
  auth: "auth", verify: "auth", reset: "auth", "email-change": "auth", invite: "auth",
  share: "share",
  landing: "landing", legal: "landing",
};
// The strings of one group's screens go with that group (card I); shell.ts, thresholds.ts, terms.ts and entry.ts, and the
// strings in i18n.tsx, are the shell's and those used by more than one group, and load first.
const STRINGS: Record<string, string> = {
  deals: "deal", newdeal: "deal", quickstart: "deal", documents: "deal", review: "deal", run: "deal", decision: "deal",
  reports: "deal", explore: "deal", audit: "deal", compare: "deal",
  settings: "settings", agirreview: "settings",
  auth: "auth",
  share: "share",
  landing: "landing",
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Every module is named: a module left to Rollup goes into the first group that imports it, which put the
        // shared strings in "auth" and made the first page load it. Libraries and the shared app code load first.
        manualChunks: (id) => {
          const route = /\/src\/routes\/([a-z-]+)\.tsx$/.exec(id)?.[1];
          if (route) return GROUPS[route];
          const strings = /\/src\/strings\/([a-z]+)\.ts$/.exec(id)?.[1];
          if (strings && STRINGS[strings]) return STRINGS[strings];
          if (id.includes("/components/QuickStart")) return "deal";
          return id.includes("/node_modules/") || id.startsWith("\0") ? "vendor" : "app";
        },
      },
    },
  },
});
