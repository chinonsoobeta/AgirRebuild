// One gate (plan task R1): `npm run gate -- --tier=fast|pr|release`.
// Behavioural only: every step runs code; none greps for a sentence.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const tier = (process.argv.find((a) => a.startsWith("--tier=")) ?? "--tier=pr").split("=")[1];
const steps = [];
const add = (name, cmd, args) => steps.push({ name, cmd, args });

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

lintTests();
add("typecheck (packages, api, worker)", "npx", ["tsc", "-p", "tsconfig.json", "--noEmit"]);
add("typecheck (web)", "npx", ["tsc", "-p", "apps/web/tsconfig.json", "--noEmit"]);
if (tier === "fast") add("engine and extraction tests", "npx", ["vitest", "run", "packages/engine", "packages/numbers", "packages/extraction"]);
else add("all tests", "npx", ["vitest", "run"]);
if (tier === "release") add("web build", "npm", ["run", "build", "-w", "@agir/web"]);

for (const s of steps) {
  console.log(`\n== ${s.name}`);
  const r = spawnSync(s.cmd, s.args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\nGate failed at: ${s.name}`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nGate (${tier}) passed.`);
