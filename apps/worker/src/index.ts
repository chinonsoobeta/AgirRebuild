// The worker: the only place documents are checked, read and extracted, and
// artifacts rendered (decision 6: one asynchronous path in every environment).
// It drains the jobs table with leases, retries with backoff, and a dead
// letter. It runs as the trusted service principal.

import Anthropic from "@anthropic-ai/sdk";
import { FIELDS, FIELD_BY_KEY, POLICIES, type Currency, type EngineInput, type FieldUnit, type RunResult } from "@agir/contracts";
import { itemFold } from "@agir/numbers";
import { renderArtifact, RendererUnavailableError, type ArtifactInput } from "@agir/artifacts";
import { sha256Hex, type BlobStore, type Db } from "@agir/db";
import { applyLabels, applySuggestions, consolidate, extractCandidates, figureOrder, kindOf, offerable, offeredIds, parseDocument, withoutLabelled, type SourcedCandidate } from "@agir/extraction";

export const MAX_UPLOAD_BYTES = 75 * 1024 * 1024;

/** What a model is asked: the exact body of the call. The figures and the catalog are in the one user turn, as JSON. */
export type SuggestRequest = {
  model: string; max_tokens: number; fallbacks: "default"; system: string;
  thinking: { type: "adaptive" };
  output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max"; format: { type: "json_schema"; schema: Record<string, unknown> } };
  messages: { role: "user"; content: string }[];
};
export type SuggestReply = { model: string; stop_reason: string | null; text: string };
export type SuggestionProvider = (request: SuggestRequest) => Promise<SuggestReply>;

export type WorkerDeps = { db: Db; store: BlobStore; log?: (event: Record<string, unknown>) => void; suggest?: SuggestionProvider };

const SUGGEST_SYSTEM = `You label figures that a document reader could not label. For each figure, choose one catalog key, or "ignore".
Never change, compute, sum or convert a value. Return only ids and keys.
For an itemized field, the item name must be words from the figure's own context.
Ignore anything unclear, a lender's limit or condition, a scenario or sensitivity, a range, an output or result figure, or a figure about another property.`;
const SUGGEST_SCHEMA = {
  type: "object", additionalProperties: false, required: ["suggestions"],
  properties: { suggestions: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["id", "fieldKey", "itemKey"],
    properties: { id: { type: "string" }, fieldKey: { type: "string" }, itemKey: { type: ["string", "null"] } },
  } } },
};
const SUGGEST_BATCH = 100;

/** The real call, used only when ANTHROPIC_API_KEY is set (the SDK reads it). */
const anthropicProvider: SuggestionProvider = async (request) => {
  // A job's lease is 5 minutes: each call, with its one retry, ends well inside it, and the batches run side by side.
  const m = await new Anthropic({ timeout: 140_000, maxRetries: 1 }).beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"] });
  return { model: m.model, stop_reason: m.stop_reason, text: m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("") };
};

/** The figures that may be offered, in one order for the worker and for a reconcile, so their ids match. */
const offeredOf = (cs: SourcedCandidate[]) => figureOrder(cs).filter(offerable);

type SuggestionRow = { model: string | null; prompt_hash: string; request: SuggestRequest; response: unknown; stop_reason: string | null; outcome: "ok" | "refused" | "failed"; error?: { class: string; status: number | null } };

/** One call per batch of 100 figures. A failure is a row, never an error: the reader's own candidates stand. */
async function suggestLabels(deps: WorkerDeps, workspaceId: string, offered: SourcedCandidate[]): Promise<SuggestionRow[]> {
  const [ws] = await deps.db.query<{ label_suggestions: boolean }>(`select label_suggestions from workspaces where id = $1`, [workspaceId]);
  const provider = deps.suggest ?? (process.env.ANTHROPIC_API_KEY ? anthropicProvider : null);
  if (!ws?.label_suggestions || !provider || offered.length === 0) return [];
  const catalog = FIELDS.filter((f) => f.extractable).map((f) => ({ key: f.key, label: f.label, unit: f.unit, itemized: f.itemized ?? false, aliases: f.aliases.slice(0, 4) }));
  const ids = offeredIds(offered);
  const figures = offered.map((c, i) => ({ id: ids[i]!, raw: c.raw, value: c.value, unitSeen: c.unitSeen, location: c.location, context: c.context }));
  figures.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batches: (typeof figures)[] = [];
  for (let i = 0; i < figures.length; i += SUGGEST_BATCH) batches.push(figures.slice(i, i + SUGGEST_BATCH));
  return Promise.all(batches.map(async (batch) => {
    const request: SuggestRequest = {
      model: process.env.AGIR_SUGGEST_MODEL || "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: (process.env.AGIR_SUGGEST_EFFORT || "medium") as SuggestRequest["output_config"]["effort"], format: { type: "json_schema", schema: SUGGEST_SCHEMA } },
      system: SUGGEST_SYSTEM,
      messages: [{ role: "user", content: JSON.stringify({ catalog, figures: batch }) }],
    };
    const row: SuggestionRow = { model: null, prompt_hash: sha256Hex(new TextEncoder().encode(JSON.stringify(request))), request, response: null, stop_reason: null, outcome: "failed" };
    try {
      const reply = await provider(request);
      row.model = reply.model;
      row.stop_reason = reply.stop_reason;
      if (reply.stop_reason === "refusal") row.outcome = "refused";
      else if (reply.stop_reason !== "max_tokens") {
        const parsed = JSON.parse(reply.text) as { suggestions?: unknown };
        if (!Array.isArray(parsed.suggestions)) throw new Error("The reply has no suggestions list");
        row.response = parsed.suggestions;
        row.outcome = "ok";
      }
    } catch (e) {
      row.error = { class: (e as Error).constructor.name, status: e instanceof Anthropic.APIError ? (e.status ?? null) : null };
      row.response = { error: row.error.class, status: row.error.status };
      row.outcome = "failed";
    }
    return row;
  }));
}

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
  const asSourced = (c: (typeof result.candidates)[number]): SourcedCandidate => ({ ...c, documentId: d.id, documentName: d.name });
  const suggestions = await suggestLabels(deps, d.workspace_id, offeredOf([...result.candidates, ...result.other].map(asSourced)));
  await db.transaction(async (tx) => {
    await tx.query(`delete from candidates where document_id = $1`, [d.id]);
    await tx.query(`delete from label_suggestions where document_id = $1`, [d.id]);
    for (const r of suggestions) {
      await tx.query(
        `insert into label_suggestions (document_id, deal_id, workspace_id, model, prompt_hash, request, response, stop_reason, outcome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [d.id, d.deal_id, d.workspace_id, r.model, r.prompt_hash, JSON.stringify(r.request), r.response && JSON.stringify(r.response), r.stop_reason, r.outcome],
      );
    }
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
  for (const r of suggestions) if (r.error) await audit(db, d.workspace_id, d.deal_id, "document.suggestions_failed", "document", d.id, r.error);
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
  sources: { value: number; unit_seen?: string | null; document_id?: string; location?: string; labelled_by?: string }[];
  conflict_values: { value: number }[] | null;
  reason: string | null;
  version: number;
};

/** What a settled value was when a label reopened it (card 58b), as the reopened event stores it. */
type RestoreTo = { status: "approved" | "default_accepted"; value: number; reason: string | null; sources: AssumptionRowDb["sources"]; by_label: boolean };

const same = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** What a reviewer sees of a row's sources, in an order that does not matter. */
const sourceForm = (s: { value: number | null; unit_seen?: string | null; document_id?: string; location?: string; labelled_by?: string }[]) =>
  (s ?? []).map((x) => JSON.stringify([x.document_id ?? null, x.location ?? null, x.value, x.unit_seen ?? null, x.labelled_by ?? null])).sort();
const sameList = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameValues = (a: { value: number }[] | null, b: { value: number }[] | null) => {
  if (!a || !b) return a === b;
  const x = a.map((v) => v.value).sort((p, q) => p - q);
  const y = b.map((v) => v.value).sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Fold every live document's values into the review queue. Never approves anything. */
export async function reconcileDeal(db: Db, dealId: string) {
  await db.transaction(async (tx) => {
    const [deal] = await tx.query<{ workspace_id: string; currency: string | null }>(`select workspace_id, currency from deals where id = $1`, [dealId]);
    if (!deal) return;
    const rows = await tx.query<{
      id: string; document_id: string; document_name: string; field_key: string; item_key: string | null; value: number;
      raw: string; unit_seen: string | null; location: string; context: string; rule: string; note: string | null;
    }>(
      `select c.id, c.document_id, d.name as document_name, c.field_key, c.item_key, c.value, c.raw, c.unit_seen, c.location, c.context, c.rule, c.note
       from candidates c join documents d on d.id = c.document_id
       where c.deal_id = $1 and c.field_key is not null and c.value is not null and d.retired_at is null and d.stage = 'extracted'`,
      [dealId],
    );
    const toSourced = (r: (typeof rows)[number]): SourcedCandidate => ({
      fieldKey: r.field_key, itemKey: r.item_key, value: r.value, raw: r.raw, unitSeen: r.unit_seen, location: r.location,
      context: r.context, rule: r.rule, ...(r.note ? { note: r.note } : {}), documentId: r.document_id, documentName: r.document_name,
    });
    const sourced = rows.map(toSourced);
    // A stored suggestion counts only while the workspace switch is on, and only after the boundary has checked it. The model is never called here.
    const [{ label_suggestions: on } = { label_suggestions: false }] = await tx.query<{ label_suggestions: boolean }>(`select label_suggestions from workspaces where id = $1`, [deal.workspace_id]);
    let kept: SourcedCandidate[] = [];
    let dropped: { id: string; why: string }[] = [];
    // Every unlabelled figure with a value, in the order the review used for the ids a person's label names.
    const unlabelled = figureOrder(
      (
        await tx.query<(typeof rows)[number]>(
          `select c.id, c.document_id, d.name as document_name, c.field_key, c.item_key, c.value, c.raw, c.unit_seen, c.location, c.context, c.rule, c.note
           from candidates c join documents d on d.id = c.document_id
           where c.deal_id = $1 and c.field_key is null and c.value is not null and d.retired_at is null and d.stage = 'extracted'`,
          [dealId],
        )
      ).map(toSourced),
    );
    // A person's label always applies, whatever the suggestions switch says, and is never dropped because the reader read the field.
    const labelRows = await tx.query<{ figure_id: string; field_key: string; item_key: string; created_by: string }>(
      `select l.figure_id, l.field_key, l.item_key, l.created_by from figure_labels l join documents d on d.id = l.document_id
       where l.deal_id = $1 and d.retired_at is null and d.stage = 'extracted' order by l.document_id, l.figure_id`,
      [dealId],
    );
    const labels = labelRows.map((l) => ({ id: l.figure_id, fieldKey: l.field_key, itemKey: l.item_key, by: l.created_by }));
    const { kept: labelled, dropped: labelDropped } = applyLabels(unlabelled, labels);
    if (on) {
      const stored = await tx.query<{ response: unknown[] }>(
        `select s.response from label_suggestions s join documents d on d.id = s.document_id
         where s.deal_id = $1 and s.outcome = 'ok' and d.retired_at is null and d.stage = 'extracted' order by s.document_id, s.created_at, s.id`,
        [dealId],
      );
      const suggestions = withoutLabelled(unlabelled, labels, stored.flatMap((r) => r.response as { id: string; fieldKey: string; itemKey?: string | null }[]));
      ({ kept, dropped } = applySuggestions(sourced, unlabelled.filter(offerable), suggestions));
    }
    const proposals = consolidate([...sourced, ...kept, ...labelled], deal.currency);
    const existing = await tx.query<AssumptionRowDb>(
      `select id, field_key, item_key, status, value, source_kind, sources, conflict_values, reason, version from assumptions where deal_id = $1 for update`,
      [dealId],
    );
    const byKey = new Map(existing.map((e) => [`${e.field_key}|${e.item_key}`, e]));
    const seen = new Set<string>();
    let changed = 0;
    const log = async (id: string, action: string, from: string | null, to: string, fromV: number | null, toV: number | null, reason: string, restoreTo?: unknown) => {
      await tx.query(
        `insert into assumption_events (assumption_id, deal_id, workspace_id, actor, action, from_status, to_status, from_value, to_value, reason, restore_to)
         values ($1,$2,$3,null,$4,$5,$6,$7,$8,$9,$10)`,
        [id, dealId, deal.workspace_id, action, from, to, fromV, toV, reason, restoreTo === undefined ? null : JSON.stringify(restoreTo)],
      );
    };
    // A value a person's label reopened (card 58b) comes back when the label goes, if no person has acted on it since and
    // nothing else disagrees. The latest reopen, and only if it recorded what the value was because of a label.
    const restorable = new Map<string, RestoreTo>();
    for (const r of await tx.query<{ assumption_id: string; restore_to: RestoreTo }>(
      `select e.assumption_id, e.restore_to from assumption_events e join assumptions a on a.id = e.assumption_id
       where a.deal_id = $1 and a.status = 'conflicting' and e.action = 'reopened' and e.restore_to is not null
         and e.id = (select max(x.id) from assumption_events x where x.assumption_id = a.id and x.action = 'reopened')
         and not exists (select 1 from assumption_events y where y.assumption_id = a.id and y.id > e.id and y.actor is not null)`,
      [dealId],
    )) if (r.restore_to.by_label) restorable.set(r.assumption_id, r.restore_to);
    let restored = 0;
    const restore = async (e: AssumptionRowDb, rt: RestoreTo, sources: unknown) => {
      await tx.query(`update assumptions set status = $2, value = $3, reason = $4, sources = $5, conflict_values = null, version = version + 1, updated_at = now() where id = $1`, [
        e.id, rt.status, rt.value, rt.reason, JSON.stringify(sources),
      ]);
      await log(e.id, "restored", "conflicting", rt.status, e.value, rt.value, `The label that disagreed was removed; the value is back as it was ${rt.status === "approved" ? "approved" : "accepted"}`);
      restored++;
      changed++;
    };
    // A proposal meets the existing row whose item name folds equal (task 60d); when several do, it meets none of them and readiness blocks the run.
    // A row with the proposal's own name comes first, whatever its status, so a value a person rejected stays rejected (task 60d audit).
    const folded = new Map<string, AssumptionRowDb[]>();
    for (const e of existing.filter((x) => x.status !== "rejected")) folded.set(`${e.field_key}|${itemFold(e.item_key)}`, [...(folded.get(`${e.field_key}|${itemFold(e.item_key)}`) ?? []), e]);
    for (const p of proposals) {
      const meets = byKey.has(`${p.fieldKey}|${p.itemKey ?? ""}`) ? [] : (folded.get(`${p.fieldKey}|${itemFold(p.itemKey ?? "")}`) ?? []);
      if (meets.length === 1) p.itemKey = meets[0]!.item_key || null;
      const key = `${p.fieldKey}|${p.itemKey ?? ""}`;
      seen.add(key);
      const sources = p.sources.map((s) => ({
        document_id: s.documentId,
        document_name: s.documentName,
        value: s.value,
        location: s.location,
        raw: s.raw,
        unit_seen: s.unitSeen,
        context: s.context,
        rule: s.rule,
        ...(s.note ? { note: s.note } : {}),
        ...(s.labelledBy ? { labelled_by: s.labelledBy } : {}),
      }));
      const reason = p.reason;
      const conflictFromDocs = p.values.map((v) => ({ value: v.value, documents: [...new Set(v.sources.map((s) => s.documentName))] }));
      const e = byKey.get(key);
      if (!e) {
        const [ins] = await tx.query<{ id: string }>(
          `insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, source_kind, sources, conflict_values, reason)
           values ($1,$2,$3,$4,$5,$6,'document',$7,$8,$9) returning id`,
          [dealId, deal.workspace_id, p.fieldKey, p.itemKey ?? "", p.status, p.value, JSON.stringify(sources), p.status === "conflicting" ? JSON.stringify(conflictFromDocs) : null, reason],
        );
        await log(ins!.id, "extracted", null, p.status, null, p.value, reason ?? (p.status === "conflicting" ? "Documents disagree" : "Found in documents"));
        changed++;
        continue;
      }
      // A foreign figure the row's sources already hold was seen when the value was settled.
      const foreignKnown = p.foreign.every((f) => (e.sources ?? []).some((x) => x.unit_seen === f.unitSeen && same(x.value, f.value)));
      const agreesWithStanding =
        (p.status === "needs_review" && same(p.value, e.value)) ||
        (p.foreign.length > 0 && foreignKnown && p.values.length === 1 && same(p.values[0]!.value, e.value));
      const rt = restorable.get(e.id);
      if (rt && e.status === "conflicting") {
        // The approved branch's test, against the value as it was settled.
        const knownThen = rt.sources.map((x) => x.value);
        const foreignKnownThen = p.foreign.every((f) => rt.sources.some((x) => x.unit_seen === f.unitSeen && same(x.value, f.value)));
        const agreesThen =
          (p.status === "needs_review" && same(p.value, rt.value)) ||
          (p.foreign.length > 0 && foreignKnownThen && p.values.length === 1 && same(p.values[0]!.value, rt.value));
        const nothingNewThen = e.source_kind !== "document" && foreignKnownThen && p.values.every((v) => knownThen.some((k) => same(k, v.value)));
        if (agreesThen || nothingNewThen) {
          await restore(e, rt, agreesThen ? sources : rt.sources);
          continue;
        }
      }
      if (e.status === "needs_review" || e.status === "conflicting") {
        if (e.source_kind === "document") {
          // The currency reason is this function's own: set it while it holds, and clear it when it no longer does.
          const nextReason = reason ?? (e.reason?.startsWith("A document states this in ") ? null : e.reason);
          const conflictNow = p.status === "conflicting" ? conflictFromDocs : null;
          // Bump the version only when something a reviewer sees changed, or a person holding the old one is refused for nothing.
          const unchanged =
            e.status === p.status && (e.value === null ? p.value === null : same(e.value, p.value)) && nextReason === e.reason &&
            sameValues(e.conflict_values, conflictNow) && sameList(sourceForm(e.sources), sourceForm(sources));
          if (unchanged) continue;
          await tx.query(
            `update assumptions set status = $2, value = $3, sources = $4, conflict_values = $5, reason = $6, version = version + 1, updated_at = now() where id = $1`,
            [e.id, p.status, p.value, JSON.stringify(sources), conflictNow ? JSON.stringify(conflictNow) : null, nextReason],
          );
          if (e.status !== p.status || !same(e.value, p.value)) await log(e.id, "re-extracted", e.status, p.status, e.value, p.value, "Documents changed");
          changed++;
        }
      } else if (e.status === "approved" || e.status === "default_accepted") {
        // An analyst's override or an accepted default already answered the
        // documents it saw. Only a value it has not seen reopens it.
        const known = (e.sources ?? []).map((x) => x.value);
        const nothingNew = e.source_kind !== "document" && foreignKnown && p.values.every((v) => known.some((k) => same(k, v.value)));
        if (agreesWithStanding || nothingNew) {
          if (agreesWithStanding) await tx.query(`update assumptions set sources = $2, updated_at = now() where id = $1`, [e.id, JSON.stringify(sources)]);
        } else {
          // A document now disagrees with a settled value: reopen it, never overwrite it.
          const settled = { value: e.value, documents: [e.source_kind === "default" ? "Default accepted" : e.source_kind === "analyst" ? "Entered by an analyst" : "Approved earlier"] };
          const values = [settled, ...conflictFromDocs.filter((c) => !same(c.value, e.value))];
          await tx.query(
            `update assumptions set status = 'conflicting', sources = $2, conflict_values = $3, reason = coalesce($4, reason), version = version + 1, updated_at = now() where id = $1`,
            [e.id, JSON.stringify(sources), JSON.stringify(values), reason],
          );
          // What the value was, for an Undo of the label that disagrees (card 58b): by_label when some disagreeing value rests only on labels.
          const disagreeing = [...p.values.filter((v) => !same(v.value, e.value)).map((v) => v.sources), ...p.foreign.filter((f) => !(e.sources ?? []).some((x) => x.unit_seen === f.unitSeen && same(x.value, f.value))).map((f) => [f])];
          const restoreTo: RestoreTo = {
            status: e.status as RestoreTo["status"], value: e.value as number, reason: e.reason, sources: e.sources,
            by_label: disagreeing.some((g) => g.length > 0 && g.every((x) => x.rule === "labelled")),
          };
          await log(e.id, "reopened", e.status, "conflicting", e.value, null, reason ?? "A document states a different value", restoreTo);
          changed++;
        }
      } else if (e.status === "rejected") {
        await tx.query(`update assumptions set sources = $2, updated_at = now() where id = $1`, [e.id, JSON.stringify(sources)]);
      }
    }
    for (const e of existing) {
      const key = `${e.field_key}|${e.item_key}`;
      // No proposal for a hand entry or an accepted default: the label that disagreed went, and nothing else did (card 58b).
      const rt = restorable.get(e.id);
      if (rt && !seen.has(key) && e.status === "conflicting" && e.source_kind !== "document") {
        await restore(e, rt, rt.sources);
        continue;
      }
      if (seen.has(key) || e.source_kind !== "document") continue;
      // A value whose every source was a model's suggestion leaves because the switch is off, not because a document went.
      const everyRule = (r: string) => !!e.sources?.length && e.sources.every((x) => (x as { rule?: string }).rule === r);
      const gone = !on && everyRule("suggested") ? "Its label was a model's suggestion, and suggestions are now off" : everyRule("labelled") ? "The label a person gave its figure was removed" : "Its source document was removed";
      if (e.status === "needs_review" || e.status === "conflicting") {
        await tx.query(`update assumptions set status = 'rejected', sources = '[]', conflict_values = null, reason = $2, version = version + 1, updated_at = now() where id = $1`, [
          e.id,
          gone,
        ]);
        await log(e.id, "source_removed", e.status, "rejected", e.value, e.value, gone);
        changed++;
      } else if (e.status === "approved") {
        await tx.query(`update assumptions set status = 'needs_review', sources = '[]', reason = $2, version = version + 1, updated_at = now() where id = $1`, [
          e.id,
          `${gone}; confirm or reject it`,
        ]);
        await log(e.id, "source_removed", "approved", "needs_review", e.value, e.value, gone);
        changed++;
      }
    }
    await tx.query(`select agir_audit($1, $2, 'assumptions.reconciled', 'deal', $3, $4)`, [
      deal.workspace_id,
      dealId,
      dealId,
      JSON.stringify({ proposals: proposals.length, changed, ...(restored ? { restored } : {}), ...(on ? { suggested: kept.length, dropped } : {}), ...(labelRows.length ? { labelled: labelled.length, labelDropped } : {}) }),
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
    input_hash: string; result_hash: string; result: RunResult; input_snapshot: { input: EngineInput; assumptions: ArtifactInput["assumptions"]; notFound?: ArtifactInput["notFound"] };
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
  // The policy the run was made under, by its stored version: a held deal is not read under v1.
  const policy = POLICIES[run.policy_version];
  if (!policy) {
    await db.query(`update artifacts set status = 'failed', error = $2, updated_at = now() where id = $1`, [a.id, `This run was made under policy ${run.policy_version}, which this build does not have.`]);
    return;
  }
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
    policy,
    assumptions: run.input_snapshot.assumptions.map((x) => ({ ...x, unit: (FIELD_BY_KEY.get(x.fieldKey)?.unit ?? "$") as FieldUnit })),
    notFound: run.input_snapshot.notFound ?? [],
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
