#!/usr/bin/env node
// Checks an Agir audit package without Agir (card S8): `node scripts/verify-audit-package.mjs agir-audit-package-run-1.json`.
// Node only, no dependencies, and nothing imported from the repository, so the file can be handed over with a package.
// It prints one line per check and exits 1 if any check fails.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Key-order-independent JSON, as packages/engine/src/canonical.ts writes it to hash a run's input and result. Written
 * again here on purpose; apps/api/test/audit-package.test.ts checks that the two agree.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
    .join(",")}}`;
}

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** An audit event's hash, by the recipe of migration 0040 (also in the package's auditChain.recipe). */
export function eventHash(prev, e) {
  return sha256([prev, e.workspace_id ?? "", e.action, e.entity, e.entity_id ?? "", e.actor ?? "", e.deal_id ?? "",
    e.payload_text, e.created_at_epoch].join("|"));
}

/** Every check on a parsed package, as { status: "pass" | "fail" | "not checked", text }. */
export function verifyPackage(pkg) {
  const out = [];
  const say = (ok, text) => out.push({ status: ok ? "pass" : "fail", text });
  const run = pkg.manifest?.run ?? {};

  say(sha256(canonicalJson(pkg.inputs?.input)) === run.inputHash, "The stored input hashes to the recorded input hash.");
  say(sha256(canonicalJson(pkg.result)) === run.resultHash, "The stored result hashes to the recorded result hash.");

  const chain = pkg.auditChain;
  const links = Array.isArray(chain?.links) ? chain.links : [];
  let linkBreak = links.length === 0 ? "The package holds no chain." : null;
  links.forEach((l, i) => {
    if (linkBreak) return;
    const prev = i === 0 ? "genesis" : links[i - 1].hash;
    if (l.prev_hash !== prev || (i > 0 && !(l.seq > links[i - 1].seq))) linkBreak = `The workspace's chain breaks at event ${l.seq}.`;
  });
  say(!linkBreak, linkBreak ?? `The workspace's chain of ${links.length} events runs from genesis to event ${links.at(-1).seq} without a gap.`);

  const events = Array.isArray(pkg.auditEvents) ? pkg.auditEvents : [];
  const bySeq = new Map(links.map((l) => [l.seq, l]));
  const outside = events.find((e) => {
    const l = bySeq.get(e.seq);
    return !l || l.prev_hash !== e.prev_hash || l.hash !== e.hash || e.workspace_id !== chain?.workspace_id;
  });
  say(!outside, outside ? `Event ${outside.seq} of this deal is not in the workspace's chain.` : `All ${events.length} of this deal's events are in the workspace's chain.`);

  const shown = events.filter((e) => typeof e.payload_text === "string");
  const wrong = shown.find((e) => {
    let same = false;
    try { same = canonicalJson(JSON.parse(e.payload_text)) === canonicalJson(e.payload); } catch { same = false; }
    return !same || eventHash(e.prev_hash, e) !== e.hash;
  });
  say(!wrong, wrong ? `Event ${wrong.seq}'s hash does not recompute from its fields.` : `Each of the ${shown.length} events with their fields shown recomputes to its hash.`);
  const hidden = events.length - shown.length;
  if (hidden > 0) out.push({ status: "not checked", text: `Not checked for ${hidden} hidden ${hidden === 1 ? "event" : "events"}: the package was made for a client of the deal, and part of ${hidden === 1 ? "its" : "their"} contents is left out.` });

  out.push({ status: "not checked", text: "The run's signature: it needs Agir's signing key." });
  out.push({ status: "not checked", text: "The replay of the run: it needs Agir's engine. The package's own validation section reports it." });
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node scripts/verify-audit-package.mjs <audit package .json>");
    process.exit(2);
  }
  const lines = verifyPackage(JSON.parse(readFileSync(file, "utf8")));
  for (const l of lines) console.log(`${l.status.padEnd(11)} ${l.text}`);
  const failed = lines.filter((l) => l.status === "fail").length;
  const unchecked = lines.filter((l) => l.status === "not checked").length;
  console.log(failed ? `Failed: ${failed} ${failed === 1 ? "check" : "checks"}.` : `Every check passed. ${unchecked} ${unchecked === 1 ? "item was" : "items were"} not checked (listed above).`);
  process.exit(failed ? 1 : 0);
}
