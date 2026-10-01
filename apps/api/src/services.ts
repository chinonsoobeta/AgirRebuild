// Use cases behind the API. Each runs inside asUser(): as the agir_app role,
// with the caller's id set, so row-level security and the governed database
// functions decide what the caller may see and do.

import { createHash, createHmac } from "node:crypto";
import {
  FIELD_BY_KEY,
  FIELD_GROUP_LABELS,
  POLICY_V1,
  type AssumptionStatus,
  type EngineInput,
  type Readiness,
  type RunResult,
} from "@agir/contracts";
import { assemble, canonicalJson, ENGINE_VERSION, replay, underwrite } from "@agir/engine";
import type { Db } from "@agir/db";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const POLICY_HASH = sha256(canonicalJson(POLICY_V1));

export class HttpError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export function signingSecret(): { secret: string; dev: boolean } {
  const s = process.env.AGIR_RUN_SIGNING_SECRET;
  if (s) return { secret: s, dev: false };
  if ((process.env.AGIR_ENV ?? "development") === "production") {
    throw new Error("AGIR_RUN_SIGNING_SECRET is required in production");
  }
  return { secret: "agir-development-signing-secret-not-for-production", dev: true };
}

export function signRun(inputHash: string, resultHash: string): string {
  const { secret, dev } = signingSecret();
  const mac = createHmac("sha256", secret).update(`${inputHash}.${resultHash}.${ENGINE_VERSION}.${POLICY_HASH}`).digest("hex");
  return dev ? `dev-unsafe:${mac}` : mac;
}

export function verifySignature(sig: string, inputHash: string, resultHash: string, engineVersion: string, policyHash: string): boolean {
  const { secret } = signingSecret();
  const mac = createHmac("sha256", secret).update(`${inputHash}.${resultHash}.${engineVersion}.${policyHash}`).digest("hex");
  return sig.replace(/^dev-unsafe:/, "") === mac;
}

type AssumptionDb = {
  id: string;
  field_key: string;
  item_key: string;
  status: AssumptionStatus;
  value: number | null;
  pending_value: number | null;
  source_kind: "document" | "analyst" | "default";
  sources: { document_id: string; document_name: string; value: number; location: string; raw: string; context: string }[];
  conflict_values: { value: number; documents: string[] }[] | null;
  reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  second_approver_name: string | null;
  version: number;
  updated_at: string;
};

async function loadAssumptions(tx: Db, dealId: string): Promise<AssumptionDb[]> {
  return tx.query<AssumptionDb>(
    `select a.*, u.name as decided_by_name, s.name as second_approver_name
     from assumptions a left join users u on u.id = a.decided_by left join users s on s.id = a.second_approver
     where a.deal_id = $1 order by a.field_key, a.item_key`,
    [dealId],
  );
}

function readinessFor(rows: AssumptionDb[]): { readiness: Readiness; input: EngineInput | null } {
  return assemble(
    rows.map((r) => ({ fieldKey: r.field_key, itemKey: r.item_key || null, status: r.status, valueNumeric: r.value })),
  );
}

export function sourceLabel(a: AssumptionDb): string {
  if (a.source_kind === "default") return "Default accepted";
  if (a.source_kind === "analyst") return `Entered by ${a.decided_by_name ?? "an analyst"}${a.reason ? `: ${a.reason}` : ""}`;
  const s = a.sources[0];
  return s ? `${s.document_name}, ${s.location}` : "Approved";
}

// ---- Deal overview ----------------------------------------------------------------

export type DealOverview = Awaited<ReturnType<typeof dealOverview>>;

export async function dealOverview(tx: Db, dealId: string) {
  const [deal] = await tx.query<{ id: string; workspace_id: string; name: string; asset_type: string; location: string; created_at: string }>(
    `select id, workspace_id, name, asset_type, location, created_at from deals where id = $1`,
    [dealId],
  );
  if (!deal) throw new HttpError(404, "Deal not found");
  const docs = await tx.query<{ stage: string }>(`select stage from documents where deal_id = $1 and retired_at is null`, [dealId]);
  const assumptions = await loadAssumptions(tx, dealId);
  const { readiness } = readinessFor(assumptions);
  const counts = {
    approved: assumptions.filter((a) => a.status === "approved" || a.status === "default_accepted").length,
    needsReview: assumptions.filter((a) => a.status === "needs_review").length,
    conflicting: readiness.conflicting.length,
    awaitingSecond: assumptions.filter((a) => a.status === "awaiting_second_approval").length,
    missing: readiness.missing.length,
    impossible: readiness.impossible.length,
  };
  const [latest] = await tx.query<{ id: string; run_number: number; verdict_code: string; assumptions_hash: string; policy_hash: string; engine_version: string; created_at: string }>(
    `select id, run_number, verdict_code, assumptions_hash, policy_hash, engine_version, created_at from latest_runs where deal_id = $1`,
    [dealId],
  );
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [dealId])) as [{ h: string }];
  const fresh = latest ? latest.assumptions_hash === h && latest.policy_hash === POLICY_HASH && latest.engine_version === ENGINE_VERSION : false;
  const [decision] = latest
    ? await tx.query<{ decision: string; created_at: string }>(`select decision, created_at from decisions where run_id = $1 order by created_at desc limit 1`, [latest.id])
    : [];
  const [artifacts] = latest
    ? await tx.query<{ n: number }>(`select count(*)::int as n from artifacts where run_id = $1 and status = 'ready'`, [latest.id])
    : [{ n: 0 }];
  const processing = docs.filter((d) => ["uploaded", "checking", "reading", "extracting"].includes(d.stage)).length;
  const failed = docs.filter((d) => d.stage === "rejected" || d.stage === "read_failed").length;

  // A deal's step comes from evidence, never from a field someone sets.
  let step: "documents" | "review" | "run" | "decision" | "reports" = "documents";
  let status: { tone: "pass" | "review" | "stop" | "neutral"; text: string };
  let next: string;
  if (docs.length === 0) {
    status = { tone: "neutral", text: "No documents yet" };
    next = "Upload the deal documents";
  } else if (processing > 0) {
    status = { tone: "neutral", text: `Reading ${processing} document${processing === 1 ? "" : "s"}` };
    next = failed ? `Retry ${failed} failed document${failed === 1 ? "" : "s"}` : "Wait for extraction";
  } else if (readiness.status === "blocked") {
    step = "review";
    const parts = [
      counts.conflicting && `${counts.conflicting} conflict${counts.conflicting === 1 ? "" : "s"}`,
      counts.missing && `${counts.missing} missing`,
      counts.needsReview && `${counts.needsReview} to review`,
      counts.awaitingSecond && `${counts.awaitingSecond} awaiting a second approver`,
      counts.impossible && `${counts.impossible} out of range`,
    ].filter(Boolean);
    status = { tone: counts.conflicting || counts.missing || counts.impossible ? "stop" : "review", text: `Blocked · ${parts.join(", ")}` };
    next = counts.conflicting ? `Resolve ${counts.conflicting} conflict${counts.conflicting === 1 ? "" : "s"}` : counts.missing ? `Enter ${counts.missing} missing input${counts.missing === 1 ? "" : "s"}` : "Review the extracted values";
  } else if (!latest || !fresh) {
    step = "run";
    status = latest ? { tone: "review", text: "Results are out of date" } : { tone: "neutral", text: "Ready to run" };
    next = "Run underwriting";
  } else if (!decision) {
    step = "decision";
    const verdictText = { APPROVE: "Approve", APPROVE_WITH_CONDITIONS: "Approve with conditions", REJECT: "Reject", NOT_EVALUATED: "Not evaluated" }[latest.verdict_code] ?? latest.verdict_code;
    status = { tone: latest.verdict_code === "APPROVE" ? "pass" : latest.verdict_code === "REJECT" ? "stop" : "review", text: `Verdict: ${verdictText}` };
    next = "Record the committee decision";
  } else {
    step = "reports";
    status = { tone: decision.decision.startsWith("approve") ? "pass" : "stop", text: `Decided: ${decision.decision.replace(/_/g, " ")}` };
    next = (artifacts?.n ?? 0) > 0 ? "Share the reports" : "Generate the IC memo";
  }
  return {
    deal,
    step,
    status,
    next,
    documents: { total: docs.length, processing, failed },
    review: { ...counts, status: readiness.status },
    run: latest ? { id: latest.id, number: latest.run_number, verdict: latest.verdict_code, fresh, createdAt: latest.created_at } : null,
    decision: decision ?? null,
    reports: artifacts?.n ?? 0,
  };
}

// ---- Review ---------------------------------------------------------------------------

export async function reviewView(tx: Db, dealId: string) {
  const assumptions = await loadAssumptions(tx, dealId);
  const { readiness } = readinessFor(assumptions);
  const other = await tx.query<{ document_name: string; raw: string; value: number | null; location: string; context: string; note: string | null }>(
    `select d.name as document_name, c.raw, c.value, c.location, c.context, c.note
     from candidates c join documents d on d.id = c.document_id
     where c.deal_id = $1 and c.field_key is null and d.retired_at is null
     order by d.name, c.location`,
    [dealId],
  );
  return {
    readiness,
    assumptions: assumptions.map((a) => {
      const def = FIELD_BY_KEY.get(a.field_key)!;
      return {
        id: a.id,
        fieldKey: a.field_key,
        itemKey: a.item_key || null,
        label: def.label,
        group: def.group,
        groupLabel: FIELD_GROUP_LABELS[def.group],
        unit: def.unit,
        material: def.material,
        conservative: def.conservative,
        status: a.status,
        value: a.value,
        pendingValue: a.pending_value,
        sourceKind: a.source_kind,
        sources: a.sources,
        conflictValues: a.conflict_values,
        reason: a.reason,
        decidedBy: a.decided_by_name,
        decidedById: a.decided_by,
        decidedAt: a.decided_at,
        secondApprover: a.second_approver_name,
        version: a.version,
      };
    }),
    missing: readiness.missing.map((m) => {
      const def = FIELD_BY_KEY.get(m.fieldKey)!;
      return { ...m, unit: def.unit, material: def.material, default: def.default ?? null, help: def.help ?? null, groupLabel: FIELD_GROUP_LABELS[def.group] };
    }),
    other,
  };
}

// ---- Runs --------------------------------------------------------------------------------

export function flattenMetrics(result: RunResult) {
  return result.scenarios.flatMap((s) =>
    s.metrics.map((m) => ({ scenario: s.key, key: m.key, value: m.value, status: m.status, unit: m.unit, reason: m.reason ?? null })),
  );
}

export async function createRun(tx: Db, dealId: string) {
  const assumptions = await loadAssumptions(tx, dealId);
  const { readiness, input } = readinessFor(assumptions);
  if (!input) throw new HttpError(409, "Underwriting is blocked until review is clear.", { readiness });
  const result = underwrite(input, POLICY_V1);
  const used = assumptions
    .filter((a) => a.status === "approved" || a.status === "default_accepted")
    .map((a) => ({
      fieldKey: a.field_key,
      itemKey: a.item_key || null,
      label: FIELD_BY_KEY.get(a.field_key)!.label,
      value: a.value!,
      sourceKind: a.source_kind,
      source: sourceLabel(a),
    }));
  const inputHash = sha256(canonicalJson(input));
  const resultHash = sha256(canonicalJson(result));
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [dealId])) as [{ h: string }];
  const payload = {
    engine_version: ENGINE_VERSION,
    policy_version: POLICY_V1.version,
    policy_hash: POLICY_HASH,
    input_snapshot: { input, assumptions: used },
    input_hash: inputHash,
    assumptions_hash: h,
    result,
    result_hash: resultHash,
    verdict_code: result.verdict.code,
    signature: signRun(inputHash, resultHash),
    metrics: flattenMetrics(result),
    gates: result.verdict.gates,
    checks: result.checks,
  };
  const [{ id }] = (await tx.query<{ id: string }>(`select fn_persist_run($1, $2) as id`, [dealId, JSON.stringify(payload)])) as [{ id: string }];
  return id;
}

export async function runView(tx: Db, runId: string) {
  const [run] = await tx.query<{
    id: string; deal_id: string; run_number: number; engine_version: string; policy_version: string; policy_hash: string;
    input_hash: string; result_hash: string; assumptions_hash: string; verdict_code: string; signature: string; created_at: string;
    created_by_name: string | null; result: RunResult; input_snapshot: { input: EngineInput; assumptions: unknown[] };
  }>(
    `select r.*, u.name as created_by_name from runs r left join users u on u.id = r.created_by where r.id = $1`,
    [runId],
  );
  if (!run) throw new HttpError(404, "Run not found");
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [run.deal_id])) as [{ h: string }];
  const [latest] = await tx.query<{ id: string }>(`select id from latest_runs where deal_id = $1`, [run.deal_id]);
  const staleReasons: string[] = [];
  if (run.assumptions_hash !== h) staleReasons.push("An approved input changed after this run.");
  if (run.policy_hash !== POLICY_HASH) staleReasons.push("The policy thresholds changed after this run.");
  if (run.engine_version !== ENGINE_VERSION) staleReasons.push("The engine was updated after this run.");
  const decisions = await tx.query(
    `select d.id, d.decision, d.rationale, d.conditions, d.override_reason, d.created_at, u.name as decided_by
     from decisions d join users u on u.id = d.decided_by where d.run_id = $1 order by d.created_at desc`,
    [runId],
  );
  return {
    id: run.id,
    dealId: run.deal_id,
    number: run.run_number,
    createdAt: run.created_at,
    createdBy: run.created_by_name,
    engineVersion: run.engine_version,
    policyVersion: run.policy_version,
    inputHash: run.input_hash,
    resultHash: run.result_hash,
    signed: run.signature.startsWith("dev-unsafe:") ? "development key" : "production key",
    fresh: staleReasons.length === 0,
    staleReasons,
    isLatest: latest?.id === run.id,
    result: run.result,
    inputs: run.input_snapshot.assumptions,
    decisions,
  };
}

/** The audit package: everything a reviewer needs, plus proof that it hangs together. */
export async function auditPackage(tx: Db, runId: string) {
  const [run] = await tx.query<{
    id: string; deal_id: string; run_number: number; engine_version: string; policy_hash: string; input_hash: string;
    result_hash: string; signature: string; result: RunResult; input_snapshot: { input: EngineInput; assumptions: unknown[] }; created_at: string;
  }>(`select * from runs where id = $1`, [runId]);
  if (!run) throw new HttpError(404, "Run not found");
  const [deal] = await tx.query(`select id, name, asset_type, location from deals where id = $1`, [run.deal_id]);
  const decisions = await tx.query<{ run_id: string }>(`select * from decisions where run_id = $1`, [runId]);
  const artifacts = await tx.query(`select id, kind, format, status, sha256, provenance, created_at from artifacts where run_id = $1`, [runId]);
  const events = await tx.query(`select seq, action, entity, entity_id, payload, prev_hash, hash, created_at from audit_events where deal_id = $1 order by seq`, [run.deal_id]);
  const [chain] = await tx.query<{ ok: boolean; events: number; broken_at: number | null }>(`select * from fn_verify_audit_chain()`);
  const checks: { name: string; status: "passed" | "failed"; message: string }[] = [];
  const check = (name: string, ok: boolean, message: string) => checks.push({ name, status: ok ? "passed" : "failed", message });
  check("input_hash", sha256(canonicalJson(run.input_snapshot.input)) === run.input_hash, "The stored input hashes to the recorded input hash.");
  check("result_hash", sha256(canonicalJson(run.result)) === run.result_hash, "The stored result hashes to the recorded result hash.");
  check("signature", verifySignature(run.signature, run.input_hash, run.result_hash, run.engine_version, run.policy_hash), "The run signature verifies.");
  let replayed = false;
  try {
    replayed = sha256(canonicalJson(replay(run.engine_version, run.input_snapshot.input, POLICY_V1))) === run.result_hash;
  } catch {
    replayed = false;
  }
  check("replay", replayed, "Replaying the recorded engine on the recorded input reproduces the result exactly.");
  check("decisions_bound", decisions.every((d) => d.run_id === run.id), "Every decision in the package names this run.");
  check("audit_chain", Boolean(chain?.ok), chain?.ok ? `The audit chain is intact (${chain.events} events).` : `The audit chain breaks at event ${chain?.broken_at}.`);
  return {
    manifest: { deal, run: { id: run.id, number: run.run_number, createdAt: run.created_at, engineVersion: run.engine_version, policyHash: run.policy_hash, inputHash: run.input_hash, resultHash: run.result_hash } },
    validation: { status: checks.every((c) => c.status === "passed") ? "passed" : "failed", checkedAt: new Date().toISOString(), checks },
    inputs: run.input_snapshot,
    result: run.result,
    decisions,
    artifacts,
    auditEvents: events,
  };
}
