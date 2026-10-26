// Accessibility scan (plan L5): `node --import tsx scripts/a11y.mjs`, after the web build.
// Starts the API with the demo seed on a scratch data folder and a free port, opens each main screen in
// light and dark, English and French, with one headless Chromium and one page at a time, and runs axe-core
// with the WCAG 2.1 AA rules. Writes a JSON report to the scratch folder and prints one line per violation
// (rule, impact, count, screen); never page content. Exits 1 on any serious or critical violation.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { findChromium } from "../packages/artifacts/src/pdf.ts";

const root = resolve(import.meta.dirname, "..");
if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  console.error("Build the web app first: npm run build -w @agir/web");
  process.exit(1);
}
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const FAILS = new Set(["serious", "critical"]);

// A scratch folder that is never the repository's .data; AGIR_A11Y_DIR names its parent.
const scratchParent = process.env.AGIR_A11Y_DIR ?? (existsSync("/private/tmp/claude-501") ? "/private/tmp/claude-501" : tmpdir());
const scratch = mkdtempSync(join(scratchParent, "agir-a11y-"));
const port = await new Promise((ok) => {
  const s = createServer().listen(0, "127.0.0.1", () => {
    const p = s.address().port;
    s.close(() => ok(p));
  });
});
// Cookies are set for the origin the page is opened on; the API listens on 127.0.0.1.
const base = `http://127.0.0.1:${port}`;

const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
const server = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
  cwd: root,
  env: { ...env, AGIR_DATA_DIR: join(scratch, "data"), PORT: String(port), AGIR_ENV: "development", AGIR_PUBLIC_ORIGIN: base },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
const ready = new Promise((ok, fail) => {
  const timer = setTimeout(() => fail(new Error("The API did not start within 5 minutes.")), 300_000);
  server.stdout.on("data", (b) => {
    serverLog += b;
    if (serverLog.includes("Agir API listening")) {
      clearTimeout(timer);
      ok();
    }
  });
  server.stderr.on("data", (b) => (serverLog += b));
  server.on("exit", (code) => fail(new Error(`The API exited (${code}) before it was ready.`)));
});
const stop = () => server.exitCode === null && server.kill("SIGTERM");
process.on("exit", stop);

let browser;
const report = { port, screens: [] };
try {
  await ready;
  const executablePath = findChromium();
  browser = await chromium.launch(executablePath ? { executablePath } : {});

  // The demo analyst's deals, and what the scan needs that the seed does not hold: an empty deal (quick start)
  // and a shared link to the Maple Heights memo.
  const setup = await browser.newContext({ baseURL: base });
  const post = async (path, data) => {
    const r = await setup.request.post(path, { data, headers: { "x-agir": "1" } });
    if (!r.ok()) throw new Error(`POST ${path.replace(/[0-9a-f-]{36}/g, ":id")} answered ${r.status()}`);
    return r.json();
  };
  const get = async (path) => (await setup.request.get(path)).json();
  await post("/api/auth/demo", { who: "analyst" });
  const ws = (await get("/api/me")).workspaces[0].id;
  const deals = await get(`/api/workspaces/${ws}/deals`);
  const id = (name) => deals.find((d) => d.deal.name === name)?.deal.id ?? (() => { throw new Error(`The seed has no deal named ${name}.`); })();
  const maple = id("Maple Heights");
  const dominion = id("Dominion Exchange");
  const empty = (await post(`/api/workspaces/${ws}/deals`, { name: "Accessibility scan", assetType: "Multifamily" })).id;
  const memo = (await get(`/api/deals/${maple}/artifacts`)).find((a) => a.status === "ready");
  if (!memo) throw new Error("The seed's Maple Heights memo is not ready (is a headless Chromium installed?).");
  const shared = (await post(`/api/artifacts/${memo.id}/share-links`, { term: "24h" })).url;
  await setup.close();

  const signedOut = [
    ["landing", "/"],
    ["sign-in", "/login"],
    ["sign-up", "/signup"],
    ["legal", "/legal"],
    ["shared link", shared],
    ["verify", "/verify"],
    ["reset (ask)", "/reset"],
    ["reset (choose)", "/reset?token=scan"],
  ];
  const signedIn = [
    ["deals", "/deals"],
    ["new deal", "/deals/new"],
    ["quick start", `/deals/${empty}/documents`],
    ["documents", `/deals/${maple}/documents`],
    ["review (blocked)", `/deals/${dominion}/review`],
    ["review", `/deals/${maple}/review`],
    ["run", `/deals/${maple}/run`],
    ["decision", `/deals/${maple}/decision`],
    ["reports", `/deals/${maple}/reports`],
    ["compare", `/deals/${maple}/compare`],
    ["explore", `/deals/${maple}/explore`],
    ["audit", `/deals/${maple}/audit`],
    ["settings", "/settings"],
    ["review access", "/settings/review-access"],
    ["verify (signed in)", "/verify"],
  ];

  for (const theme of ["light", "dark"]) {
    for (const lang of ["en", "fr"]) {
      for (const [who, screens] of [["out", signedOut], ["in", signedIn]]) {
        const context = await browser.newContext({ baseURL: base, colorScheme: theme, viewport: { width: 1280, height: 900 } });
        await context.addInitScript(([t, l]) => {
          localStorage.setItem("agir.theme", t);
          localStorage.setItem("agir.lang", l);
        }, [theme, lang]);
        if (who === "in") {
          const r = await context.request.post("/api/auth/demo", { data: { who: "analyst" }, headers: { "x-agir": "1" } });
          if (!r.ok()) throw new Error(`Demo sign-in answered ${r.status()}`);
        }
        const page = await context.newPage();
        for (const [name, path] of screens) {
          await page.goto(path, { waitUntil: "load" });
          // A screen is ready when its data has arrived; pages that poll never go idle, so the wait is capped.
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
          // Every screen has a heading once it has drawn; a screen that never draws one would pass the scan empty.
          const drawn = await page.waitForSelector("h1", { timeout: 8_000 }).then(() => true, () => false);
          await page.addScriptTag({ content: axeSource });
          const result = await page.evaluate(async (tags) => {
            // Each node's selector is kept for fixing; its HTML is not, so no page content leaves the browser.
            const r = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, count: v.nodes.length, targets: v.nodes.slice(0, 10).map((n) => n.target.join(" ")) }));
          }, TAGS);
          const screen = `${name} [${theme} ${lang}]`;
          if (!drawn) result.push({ id: "screen-not-drawn", impact: "critical", count: 1, targets: [] });
          // The scan counts only if the page is in the theme and language it was asked for.
          const shown = await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.lang]);
          if (shown[0] !== theme || !shown[1]?.startsWith(lang)) result.push({ id: "screen-wrong-theme-or-language", impact: "critical", count: 1, targets: [] });
          report.screens.push({ screen, violations: result });
          for (const v of result) console.log(`${FAILS.has(v.impact) ? "FAIL" : "note"} ${v.id} ${v.impact} ${v.count} ${screen}`);
        }
        await context.close();
      }
    }
  }
} catch (e) {
  console.error(`Accessibility scan could not run: ${e.message}`);
  if (process.env.AGIR_A11Y_DEBUG === "1") console.error(serverLog);
  process.exitCode = 2;
} finally {
  await browser?.close();
  stop();
}

const file = join(scratch, "a11y-report.json");
writeFileSync(file, JSON.stringify(report, null, 2));
const all = report.screens.flatMap((s) => s.violations);
const failing = all.filter((v) => FAILS.has(v.impact));
console.log(`\n${report.screens.length} screens scanned; ${failing.length} serious or critical violations, ${all.length - failing.length} moderate or minor. Report: ${file}`);
if (failing.length && !process.exitCode) process.exitCode = 1;
