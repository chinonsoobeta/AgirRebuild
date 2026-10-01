// The worker: the only place documents are checked, read and extracted, and
// artifacts rendered (decision 6: one asynchronous path in every environment).
// It drains the jobs table with leases, retries with backoff, and a dead
// letter. It runs as the trusted service principal.

import { FIELD_BY_KEY, type Currency, type EngineInput, type FieldUnit, type RunResult } from "@agir/contracts";
import { renderArtifact, RendererUnavailableError, type ArtifactInput } from "@agir/artifacts";
import { sha256Hex, type BlobStore, type Db } from "@agir/db";
import { consolidate, extractCandidates, kindOf, parseDocument, type SourcedCandidate } from "@agir/extraction";

export const MAX_UPLOAD_BYTES = 75 * 1024 * 1024;

export type WorkerDeps = { db: Db; store: BlobStore; log?: (event: Record<string, unknown>) => void };

type Job = { id: number; kind: string; payload: Record<string, string>; attempts: number; max_attempts: number };

function sniff(kind: string, bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 8));
  if (kind === "pdf" && !head.startsWith("%PDF-")) return "The file does not start like a PDF";
  if ((kind === "xlsx" || kind === "docx") && !head.startsWith("PK\u0003\u0004")) return `The file is not an Office ${kind.toUpperCase()} package`;
  if (kind === "csv" || kind === "txt") {
    if (bytes.includes(0)) return "A text file cannot contain binary data";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "The text is not valid UTF-8";
    }
  }
  return null;
}

async function audit(db: Db, ws: string | null, deal: string | null, action: string, entity: string, id: string, payload: object) {
  await db.query(`select agir_audit($1, $2, $3, $4, $5, $6)`, [ws, deal, action, entity, id, JSON.stringify(payload)]);
}

async function setStage(db: Db, id: string, stage: string, detail: string | null, extra: Record<string, unknown> = {}) {
  const cols = Object.keys(extra);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`).join(", ");
  await db.query(
    `update documents set stage = $2, stage_detail = $3, updated_at = now()${sets ? ", " + sets : ""} where id = $1`,
    [id, stage, detail, ...cols.map((c) => extra[c])],
  );
}

async function verifyDocument(deps: WorkerDeps, documentId: string) {
  const { db, store } = deps;
  const [d] = await db.query<{ id: string; deal_id: string; workspace_id: string; name: string; kind: string; size_bytes: number; sha256: string; storage_key: string }>(
    `select id, deal_id, workspace_id, name, kind, size_bytes, sha256, storage_key from documents where id = $1`,
    [documentId],
  );
  if (!d) return;
  await setStage(db, d.id, "checking", null);
  const bytes = await store.get(d.storage_key);
  const reject = async (why: string) => {
    await setStage(db, d.id, "rejected", why);
    await audit(db, d.workspace_id, d.deal_id, "document.rejected", "document", d.id, { reason: why });
  };
  if (bytes.byteLength !== Number(d.size_bytes)) return reject("The stored file does not match the size that was uploaded");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return reject("The file is larger than 75 MB");
  if (sha256Hex(bytes) !== d.sha256) return reject("The stored file does not match the fingerprint recorded at upload");
  const sniffed = sniff(d.kind, bytes);
  if (sniffed) return reject(sniffed);
  // Structural checks only: no virus scanner is part of this build.
  const detail = "Type, size and fingerprint checked";
  await setStage(db, d.id, "reading", detail);
  await db.query(`insert into jobs (kind, payload) values ('extract_document', $1)`, [JSON.stringify({ document_id: d.id })]);
  await audit(db, d.workspace_id, d.deal_id, "document.verified", "document", d.id, { checks: detail });
}

async function extractDocument(deps: WorkerDeps, documentId: string) {
  const { db, store } = deps;
  const [d] = await db.query<{ id: string; deal_id: string; workspace_id: string; name: string; storage_key: string; retired_at: string | null }>(
    `select id, deal_id, workspace_id, name, storage_key, retired_at from documents where id = $1`,
    [documentId],
  );
  if (!d || d.retired_at) return;
  await setStage(db, d.id, "reading", null);
  const bytes = await store.get(d.storage_key);
  let parsed;
  try {
    if (!kindOf(d.name)) throw new Error("This file type cannot be read");
    parsed = await parseDocument(bytes, d.name);
  } catch (e) {
    await setStage(db, d.id, "read_failed", `Agir could not read this file: ${(e as Error).message.split("\n")[0]}`);
    return;
  }
  if (parsed.needsOcr) {
    await setStage(db, d.id, "read_failed", "This PDF is scanned pages with no text layer. Agir does not run OCR yet: enter its values by hand, or upload a text PDF.", {
      page_count: parsed.pageCount,
      needs_ocr: true,
    });
    return;
  }
  await setStage(db, d.id, "extracting", null, { page_count: parsed.pageCount });
  const result = extractCandidates(parsed);
  const format = result.format.mixed ? "mixed" : result.format.decimal === "." ? "1,234.56" : result.format.decimal === "," ? "1.234,56" : "not detected";
  await db.transaction(async (tx) => {
    await tx.query(`delete from candidates where document_id = $1`, [d.id]);
    for (const c of [...result.candidates, ...result.other]) {
      await tx.query(
        `insert into candidates (document_id, deal_id, workspace_id, field_key, item_key, value, raw, unit_seen, location, context, rule, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [d.id, d.deal_id, d.workspace_id, c.fieldKey, c.itemKey, c.value, c.raw, c.unitSeen, c.location, c.context, c.rule, c.note ?? null],
      );
    }
    await tx.query(
      `update documents set stage = 'extracted', stage_detail = null, candidate_count = $2, number_format = $3, updated_at = now() where id = $1`,
      [d.id, result.candidates.length, format],
    );
    await tx.query(`insert into jobs (kind, payload) values ('reconcile_deal', $1)`, [JSON.stringify({ deal_id: d.deal_id })]);
  });
  await audit(db, d.workspace_id, d.deal_id, "document.extracted", "document", d.id, {
    candidates: result.candidates.length,
    other: result.other.length,
    number_format: format,
  });
}

type AssumptionRowDb = {
  id: string;
  field_key: string;
  item_key: string;
  status: string;
  value: number | null;
  source_kind: string;
  sources: { value: number }[];
  version: number;
};

const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** Fold every live document's values into the review queue. Never approves anything. */
export async function reconcileDeal(db: Db, dealId: string) {
  await db.transaction(async (tx) => {
    const [deal] = await tx.query<{ workspace_id: string }>(`select workspace_id from deals where id = $1`, [dealId]);
    if (!deal) return;
    const rows = await tx.query<{
      id: string; document_id: string; document_name: string; field_key: string; item_key: string | null; value: number;
      raw: string; unit_seen: string | null; location: string; context: string; rule: string;
    }>(
      `select c.id, c.document_id, d.name as document_name, c.field_key, c.item_key, c.value, c.raw, c.unit_seen, c.location, c.context, c.rule
       from candidates c join documents d on d.id = c.document_id
       where c.deal_id = $1 and c.field_key is not null and c.value is not null and d.retired_at is null and d.stage = 'extracted'`,
      [dealId],
    );
    const sourced: SourcedCandidate[] = rows.map((r) => ({
      fieldKey: r.field_key, itemKey: r.item_key, value: r.value, raw: r.raw, unitSeen: r.unit_seen, location: r.location,
      context: r.context, rule: r.rule, documentId: r.document_id, documentName: r.document_name,
    }));
    const proposals = consolidate(sourced);
    const existing = await tx.query<AssumptionRowDb>(
      `select id, field_key, item_key, status, value, source_kind, sources, version from assumptions where deal_id = $1 for update`,
      [dealId],
    );
    const byKey = new Map(existing.map((e) => [`${e.field_key}|${e.item_key}`, e]));
    const seen = new Set<string>();
    let changed = 0;
    const log = async (id: string, action: string, from: string | null, to: string, fromV: number | null, toV: number | null, reason: string) => {
      await tx.query(
        `insert into assumption_events (assumption_id, deal_id, workspace_id, actor, action, from_status, to_status, from_value, to_value, reason)
         values ($1,$2,$3,null,$4,$5,$6,$7,$8,$9)`,
        [id, dealId, deal.workspace_id, action, from, to, fromV, toV, reason],
      );
    };
    for (const p of proposals) {
      const key = `${p.fieldKey}|${p.itemKey ?? ""}`;
      seen.add(key);
      const sources = p.sources.map((s) => ({ document_id: s.documentId, document_name: s.documentName, value: s.value, location: s.location, raw: s.raw, context: s.context }));
      const conflictFromDocs = p.values.map((v) => ({ value: v.value, documents: [...new Set(v.sources.map((s) => s.documentName))] }));
      const e = byKey.get(key);
      if (!e) {
        const [ins] = await tx.query<{ id: string }>(
          `insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, source_kind, sources, conflict_values)
           values ($1,$2,$3,$4,$5,$6,'document',$7,$8) returning id`,
          [dealId, deal.workspace_id, p.fieldKey, p.itemKey ?? "", p.status, p.value, JSON.stringify(sources), p.status === "conflicting" ? JSON.stringify(conflictFromDocs) : null],
        );
        await log(ins!.id, "extracted", null, p.status, null, p.value, p.status === "conflicting" ? "Documents disagree" : "Found in documents");
        changed++;
        continue;
      }
      const agreesWithStanding = p.status === "needs_review" && same(p.value, e.value);
      if (e.status === "needs_review" || e.status === "conflicting") {
        if (e.source_kind === "document") {
          await tx.query(
            `update assumptions set status = $2, value = $3, sources = $4, conflict_values = $5, version = version + 1, updated_at = now() where id = $1`,
            [e.id, p.status, p.value, JSON.stringify(sources), p.status === "conflicting" ? JSON.stringify(conflictFromDocs) : null],
          );
          if (e.status !== p.status || !same(e.value, p.value)) await log(e.id, "re-extracted", e.status, p.status, e.value, p.value, "Documents changed");
          changed++;
        }
      } else if (e.status === "approved" || e.status === "default_accepted") {
        // An analyst's override or an accepted default already answered the
        // documents it saw. Only a value it has not seen reopens it.
        const known = (e.sources ?? []).map((x) => x.value);
        const nothingNew = e.source_kind !== "document" && p.values.every((v) => known.some((k) => same(k, v.value)));
        if (agreesWithStanding || nothingNew) {
          if (agreesWithStanding) await tx.query(`update assumptions set sources = $2, updated_at = now() where id = $1`, [e.id, JSON.stringify(sources)]);
        } else {
          // A document now disagrees with a settled value: reopen it, never overwrite it.
          const settled = { value: e.value, documents: [e.source_kind === "default" ? "Default accepted" : e.source_kind === "analyst" ? "Entered by an analyst" : "Approved earlier"] };
          const values = [settled, ...conflictFromDocs.filter((c) => !same(c.value, e.value))];
          await tx.query(
            `update assumptions set status = 'conflicting', sources = $2, conflict_values = $3, version = version + 1, updated_at = now() where id = $1`,
            [e.id, JSON.stringify(sources), JSON.stringify(values)],
          );
          await log(e.id, "reopened", e.status, "conflicting", e.value, null, "A document states a different value");
          changed++;
        }
      } else if (e.status === "rejected") {
        await tx.query(`update assumptions set sources = $2, updated_at = now() where id = $1`, [e.id, JSON.stringify(sources)]);
      }
    }
    for (const e of existing) {
      const key = `${e.field_key}|${e.item_key}`;
      if (seen.has(key) || e.source_kind !== "document") continue;
      if (e.status === "needs_review" || e.status === "conflicting") {
        await tx.query(`update assumptions set status = 'rejected', sources = '[]', conflict_values = null, reason = $2, version = version + 1, updated_at = now() where id = $1`, [
          e.id,
          "Its source document was removed",
        ]);
        await log(e.id, "source_removed", e.status, "rejected", e.value, e.value, "Its source document was removed");
        changed++;
      } else if (e.status === "approved") {
        await tx.query(`update assumptions set status = 'needs_review', sources = '[]', reason = $2, version = version + 1, updated_at = now() where id = $1`, [
          e.id,
          "Its source document was removed; confirm or reject it",
        ]);
        await log(e.id, "source_removed", "approved", "needs_review", e.value, e.value, "Its source document was removed");
        changed++;
      }
    }
    await tx.query(`select agir_audit($1, $2, 'assumptions.reconciled', 'deal', $3, $4)`, [
      deal.workspace_id,
      dealId,
      dealId,
      JSON.stringify({ proposals: proposals.length, changed }),
    ]);
  });
}

async function renderJob(deps: WorkerDeps, artifactId: string) {
  const { db, store } = deps;
  const [a] = await db.query<{ id: string; run_id: string; deal_id: string; workspace_id: string; kind: ArtifactInput["kind"]; format: "pdf" | "docx" | "xlsx" | "html" }>(
    `select id, run_id, deal_id, workspace_id, kind, format from artifacts where id = $1`,
    [artifactId],
  );
  if (!a) return;
  const [run] = await db.query<{
    id: string; run_number: number; created_at: string | Date; engine_version: string; policy_version: string; policy_hash: string;
    input_hash: string; result_hash: string; result: RunResult; input_snapshot: { input: EngineInput; assumptions: ArtifactInput["assumptions"] };
  }>(`select * from runs where id = $1`, [a.run_id]);
  const [deal] = await db.query<{ name: string; asset_type: string; location: string; currency: Currency | null; province: string | null }>(
    `select name, asset_type, location, currency, province from deals where id = $1`,
    [a.deal_id],
  );
  const [decision] = await db.query<{ decision: string; rationale: string; conditions: string | null; decided_by: string; created_at: string | Date; name: string }>(
    `select d.decision, d.rationale, d.conditions, d.decided_by, d.created_at, u.name from decisions d join users u on u.id = d.decided_by where d.run_id = $1 order by d.created_at desc limit 1`,
    [a.run_id],
  );
  if (!run || !deal) return;
  const input: ArtifactInput = {
    kind: a.kind,
    deal: { name: deal.name, assetType: deal.asset_type, location: deal.location, currency: deal.currency, province: deal.province },
    run: {
      id: run.id,
      runNumber: run.run_number,
      createdAt: new Date(run.created_at).toISOString(),
      engineVersion: run.engine_version,
      policyVersion: run.policy_version,
      policyHash: run.policy_hash,
      inputHash: run.input_hash,
      resultHash: run.result_hash,
    },
    result: run.result,
    input: run.input_snapshot.input,
    assumptions: run.input_snapshot.assumptions.map((x) => ({ ...x, unit: (FIELD_BY_KEY.get(x.fieldKey)?.unit ?? "$") as FieldUnit })),
    decision: decision
      ? { decision: decision.decision, rationale: decision.rationale, conditions: decision.conditions, decidedBy: decision.name, createdAt: new Date(decision.created_at).toISOString() }
      : null,
  };
  try {
    const out = await renderArtifact(input, a.format);
    if (!out.provenance.pass) {
      await db.query(`update artifacts set status = 'blocked', provenance = $2, error = $3, updated_at = now() where id = $1`, [
        a.id,
        JSON.stringify(out.provenance),
        `Blocked: ${out.provenance.orphans.length} figure(s) have no recorded source (${out.provenance.orphans.slice(0, 5).join(", ")})`,
      ]);
      await audit(db, a.workspace_id, a.deal_id, "artifact.blocked", "artifact", a.id, { orphans: out.provenance.orphans });
      return;
    }
    const put = await store.put(out.bytes);
    await db.query(`update artifacts set status = 'ready', storage_key = $2, sha256 = $3, provenance = $4, error = null, updated_at = now() where id = $1`, [
      a.id,
      put.key,
      put.sha256,
      JSON.stringify(out.provenance),
    ]);
    await audit(db, a.workspace_id, a.deal_id, "artifact.ready", "artifact", a.id, { sha256: put.sha256, format: a.format, kind: a.kind });
  } catch (e) {
    const msg = e instanceof RendererUnavailableError ? e.message : `Rendering failed: ${(e as Error).message.split("\n")[0]}`;
    await db.query(`update artifacts set status = 'failed', error = $2, updated_at = now() where id = $1`, [a.id, msg]);
    if (!(e instanceof RendererUnavailableError)) throw e;
  }
}

async function claim(db: Db): Promise<Job | null> {
  const [job] = await db.query<Job>(
    `update jobs set status = 'running', attempts = attempts + 1, lease_until = now() + interval '5 minutes', updated_at = now()
     where id = (
       select id from jobs
       where (status = 'queued' and run_after <= now()) or (status = 'running' and lease_until < now())
       order by id limit 1 for update skip locked)
     returning id, kind, payload, attempts, max_attempts`,
  );
  return job ?? null;
}

/** Claim and run one job. Returns false when there was nothing to do. */
export async function runOnce(deps: WorkerDeps): Promise<boolean> {
  const job = await claim(deps.db);
  if (!job) return false;
  const started = Date.now();
  try {
    if (job.kind === "verify_document") await verifyDocument(deps, job.payload.document_id!);
    else if (job.kind === "extract_document") await extractDocument(deps, job.payload.document_id!);
    else if (job.kind === "reconcile_deal") await reconcileDeal(deps.db, job.payload.deal_id!);
    else if (job.kind === "render_artifact") await renderJob(deps, job.payload.artifact_id!);
    await deps.db.query(`update jobs set status = 'done', lease_until = null, updated_at = now() where id = $1`, [job.id]);
    deps.log?.({ event: "job.done", id: job.id, kind: job.kind, ms: Date.now() - started });
  } catch (e) {
    const message = (e as Error).message;
    const dead = job.attempts >= job.max_attempts;
    await deps.db.query(
      `update jobs set status = $2, last_error = $3, lease_until = null, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() where id = $1`,
      [job.id, dead ? "dead" : "queued", message, String(2 ** job.attempts)],
    );
    if (dead && job.payload.document_id) {
      await setStage(deps.db, job.payload.document_id, "read_failed", "Agir could not process this file after several attempts. Retry it, or upload it again.");
    }
    deps.log?.({ event: dead ? "job.dead" : "job.retry", id: job.id, kind: job.kind, error: message });
  }
  return true;
}

/** Drain until empty. Tests and the seed use this to wait for the pipeline. */
export async function drain(deps: WorkerDeps, maxJobs = 10_000): Promise<number> {
  let n = 0;
  while (n < maxJobs && (await runOnce(deps))) n++;
  return n;
}

/** Poll forever; returns a stop function. */
export function startWorker(deps: WorkerDeps, intervalMs = 400): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      let worked = false;
      try {
        worked = await runOnce(deps);
      } catch (e) {
        deps.log?.({ event: "worker.error", error: (e as Error).message });
      }
      if (!worked) await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
