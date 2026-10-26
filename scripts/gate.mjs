// One gate (plan task R1): `npm run gate -- --tier=fast|pr|release|fallback`.
// Behavioural only: every step runs code; none greps for a sentence.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const tier = (process.argv.find((a) => a.startsWith("--tier=")) ?? "--tier=pr").split("=")[1];
const steps = [];
const add = (name, cmd, args, env) => steps.push({ name, cmd, args, env });
// The rule reader is the fallback for the AI reader: its tests run with no model key in the environment.
const { ANTHROPIC_API_KEY: _key, ...noKey } = process.env;
const fallback = () => add("fallback: no model", "npx", ["vitest", "run", "apps/api/test/api.test.ts", "-t", "fallback: no model"], noKey);

// Tests must never be skipped or focused in the required suites.
function lintTests() {
  const bad = [];
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.name === "node_modules" || f.name === "dist") continue;
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(f.name) && /\b(test|it|describe)\.(only|skip)\(/.test(readFileSync(p, "utf8"))) bad.push(p);
    }
  };
  walk("packages");
  walk("apps");
  if (bad.length) {
    console.error(`Skipped or focused tests: ${bad.join(", ")}`);
    process.exit(1);
  }
}

// Plan L5 and E18: the built web app's size. Measured 2026-10-25 after the route split (card G): largest chunk
// 365 kB (budget 500 kB, Vite's warning limit; 27% margin), all JavaScript 926 kB (budget 1.2 MB; 23% margin),
// CSS 37 kB (budget 60 kB; 38% margin). Before the split the app was one 916 kB chunk.
// Measured 2026-10-25 after each screen's strings moved to its route group (card I), from `npm run build -w @agir/web`:
// first visit (the scripts dist/index.html loads: index and vendor) 547.4 kB, down from 711.2 kB (budget 690 kB; 21%
// margin); largest chunk 339.9 kB, vendor (32% margin); all JavaScript 939.8 kB (22% margin); CSS 37.6 kB (37% margin).
function webBudget() {
  const dir = "apps/web/dist/assets";
  const files = readdirSync(dir).map((f) => ({ f, kb: statSync(join(dir, f)).size / 1000 }));
  const js = files.filter((x) => x.f.endsWith(".js"));
  const largest = Math.max(...js.map((x) => x.kb));
  const totalJs = js.reduce((a, x) => a + x.kb, 0);
  const css = files.filter((x) => x.f.endsWith(".css")).reduce((a, x) => a + x.kb, 0);
  // The first visit: the entry script and the modules it preloads, as named in the built page.
  const page = readFileSync("apps/web/dist/index.html", "utf8");
  const first = [...page.matchAll(/(?:src|href)="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
  const firstJs = js.filter((x) => first.includes(x.f)).reduce((a, x) => a + x.kb, 0);
  const checks = [["first-visit JavaScript", firstJs, 690], ["largest JavaScript chunk", largest, 500], ["all JavaScript", totalJs, 1200], ["CSS", css, 60]];
  for (const [what, kb, max] of checks) console.log(`${what}: ${kb.toFixed(1)} kB (budget ${max} kB)`);
  return checks.every(([, kb, max]) => kb <= max) ? 0 : 1;
}

lintTests();
if (tier === "fallback") fallback();
else {
  add("typecheck (packages, api, worker)", "npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
  add("typecheck (web)", "npx", ["tsc", "-p", "apps/web/tsconfig.json", "--noEmit"]);
  if (tier === "fast") add("engine and extraction tests", "npx", ["vitest", "run", "packages/engine", "packages/numbers", "packages/extraction"]);
  else add("all tests", "npx", ["vitest", "run"]);
  if (tier === "release") {
    fallback();
    add("web build", "npm", ["run", "build", "-w", "@agir/web"]);
    steps.push({ name: "performance budget", run: webBudget });
    // One browser and one page at a time, under the same NODE_OPTIONS as the rest of the gate.
    add("accessibility scan", "node", ["--import", "tsx", "scripts/a11y.mjs"], noKey);
  }
}

for (const s of steps) {
  console.log(`\n== ${s.name}`);
  const r = s.run ? { status: s.run() } : spawnSync(s.cmd, s.args, { stdio: "inherit", env: s.env ?? process.env });
  if (r.status !== 0) {
    console.error(`\nGate failed at: ${s.name}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nGate (${tier}) passed.`);
