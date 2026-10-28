// Use cases behind the API. Each runs inside asUser(): as the agir_app role,
// with the caller's id set, so row-level security and the governed database
// functions decide what the caller may see and do.

import { createHash, createHmac } from "node:crypto";
import {
  tableSourceLabel, type TableSource, effectivePolicy, THRESHOLDS, type PolicyOverrides, type PolicyChange,
  PREMIUM_TAX_TABLES, premiumTaxOptions, CMHC_PREMIUM, GST_HST, cmhcPremium, landTable, landTransferTaxOptions, gstHstNetOptions, ENGINE_READABLE_STATUSES, type Proposal, type Table, type TableOption,
  FIELD_BY_KEY,
  FIELD_GROUP_LABELS,
  POLICIES,
  runPolicy,
  type Policy,
  policyFor,
  type AssumptionStatus,
  type EngineInput,
  type Readiness,
  type RunResult,
} from "@agir/contracts";
import { assemble, buildLedger, canonicalJson, ENGINE_VERSION, heldPartnerReturns, replay } from "@agir/engine";
import { currentDocuments, documentsHash, type Db } from "@agir/db";
import { applyLabels, figureOrder, itemFold, labelPhrase, labelUnit, offeredIds, suggestFields, type ReaderResponse, type ReadingVerification, READER_PROMPT_VERSION, type SourcedCandidate } from "@agir/extraction";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** The hash of each registered policy, by version. A run is fresh against the hash of the policy it was made under. */
export const POLICY_HASHES: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(POLICIES).map(([v, p]) => [v, sha256(canonicalJson(p))]));

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

export function signRun(inputHash: string, resultHash: string, policyHash: string): string {
  const { secret, dev } = signingSecret();
  const mac = createHmac("sha256", secret).update(`${inputHash}.${resultHash}.${ENGINE_VERSION}.${policyHash}`).digest("hex");
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
  source_kind: "document" | "analyst" | "default" | "table";
  source_table: string | null;
  /** unit_seen is the unit the document wrote; sources recorded before it was kept have none. */
  sources: { document_id: string; document_name: string; value: number; location: string; raw: string; unit_seen?: string | null; context: string; rule?: string; ocr?: boolean; labelled_by?: string; region?: SourcedCandidate["region"]; check_outcome?: "confirms" | "questions" }[];
  conflict_values: { value: number; documents: string[] }[] | null;
  reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  second_approver_name: string | null;
  second_approved_at: string | null;
  /** The confirmer is an Agir reviewer. The membership row outlives its expiry, so the label survives. */
  confirmed_by_review: boolean;
  /** Approved on one person's say, a material field, no second approver (agir_sponsor_stated in the database). */
  sponsor_stated: boolean;
  /** The deal's client said the broker's value is right (card 89); not an independent confirmation. */
  client_confirmed_by: string | null;
  client_confirmed_by_name: string | null;
  client_confirmed_at: string | null;
  version: number;
  updated_at: string;
};

async function loadAssumptions(tx: Db, dealId: string): Promise<AssumptionDb[]> {
  return tx.query<AssumptionDb>(
    `select a.*, coalesce(nullif(btrim(u.name), ''), u.email) as decided_by_name, coalesce(nullif(btrim(s.name), ''), s.email) as second_approver_name, coalesce(nullif(btrim(k.name), ''), k.email) as client_confirmed_by_name,
       exists (select 1 from workspace_members m where m.workspace_id = a.workspace_id and m.user_id = a.second_approver and m.role = 'reviewer') as confirmed_by_review,
       (a.status = 'approved' and a.source_kind = 'analyst' and a.second_approver is null and f.material) as sponsor_stated
     from assumptions a join field_catalog f on f.key = a.field_key
       left join users u on u.id = a.decided_by left join users s on s.id = a.second_approver left join users k on k.id = a.client_confirmed_by
     where a.deal_id = $1 order by a.field_key, a.item_key`,
    [dealId],
  );
}

function readinessFor(rows: AssumptionDb[]): { readiness: Readiness; input: EngineInput | null; gaps: Record<string, string> } {
  return assemble(
    rows.map((r) => ({ fieldKey: r.field_key, itemKey: r.item_key || null, status: r.status, valueNumeric: r.value })),
  );
}

function tableSource(a: AssumptionDb): TableSource | undefined {
  return a.source_kind === "table" && a.source_table ? {...JSON.parse(a.source_table),acceptedBy:a.decided_by_name ?? "—"} : undefined;
}
export function sourceLabel(a: AssumptionDb): string {
  const published=tableSource(a);
  if (published) return tableSourceLabel(published);
  if (a.source_kind === "default") return "Default accepted";
  if (a.source_kind === "analyst") return `Entered by ${a.decided_by_name ?? "an analyst"}${a.reason ? `: ${a.reason}` : ""}`;
  const s = a.sources[0];
  if (!s) return "Approved";
  // A person, not the document's own wording, said which input this figure is: a reader of the run must see that.
  const labelled = a.sources.every((x) => x.rule === "labelled") ? ", labelled by a person" : "";
  // A figure the document gave in square metres was converted to square feet at entry: say so, with what it said.
  const converted = s.unit_seen?.startsWith("m2") || s.unit_seen?.startsWith("$/m2") ? `, converted from square metres ("${s.raw}")` : "";
  return `${s.document_name}, ${s.location}${converted}${labelled}`;
}

// Threshold metadata is stored beside the policy, so names/reasons never enter its hash.
async function policyLayers(tx: Db, dealId: string): Promise<{ workspace: PolicyOverrides; deal: PolicyOverrides }> {
  const [row] = await tx.query<{ workspace: PolicyOverrides; deal: PolicyOverrides }>(`select w.policy_overrides as workspace, d.policy_overrides as deal from deals d join workspaces w on w.id=d.workspace_id where d.id=$1`, [dealId]);
  if (!row) throw new HttpError(404, "Deal not found");
  return row;
}
async function currentPolicyHash(tx: Db, dealId: string, version: string): Promise<string | undefined> {
  const base = POLICIES[version];
  if (!base) return undefined;
  const layers = await policyLayers(tx, dealId);
  return sha256(canonicalJson(effectivePolicy(base, layers.workspace, layers.deal).policy));
}
export async function thresholdsView(tx: Db, scope: "workspace" | "deal", id: string) {
  let layers: { workspace: PolicyOverrides; deal: PolicyOverrides };
  if (scope === "deal") layers = await policyLayers(tx, id);
  else {
    const [row] = await tx.query<{ policy_overrides: PolicyOverrides }>(`select policy_overrides from workspaces where id=$1`, [id]);
    if (!row) throw new HttpError(404, "Workspace not found");
    layers = { workspace: row.policy_overrides, deal: {} };
  }
  const users = await tx.query<{ id: string; name: string }>(`select id, coalesce(nullif(btrim(name), ''), email) as name from users where id = any($1::uuid[])`, [[...new Set(Object.values(layers).flatMap((versions) => Object.values(versions).flatMap((values) => Object.values(values).map((note) => note.setBy))))]]);
  const names = new Map(users.map((user) => [user.id,user.name]));
  // Stored values the policies no longer allow (a draft edited after they were set), including a policy this build no longer has.
  const invalid = (["workspace", "deal"] as const).flatMap((layer) => Object.entries(layers[layer]).flatMap(([version, values]) => {
    const base = Object.hasOwn(POLICIES, version) ? POLICIES[version] : undefined;
    const bad = base ? effectivePolicy(base, layer === "workspace" ? { [version]: values } : {}, layer === "deal" ? { [version]: values } : {}).invalid
      : Object.entries(values).map(([path, note]) => ({ path, layer, value: note.value, setById: note.setBy, setAt: note.setAt, reason: note.reason, error: { en: "This build has no such policy.", fr: "Cette version n'a pas cette politique." } }));
    return bad.map((v) => ({ ...v, version, setByName: names.get(v.setById) ?? "—" }));
  }));
  return { invalid, policies: Object.values(POLICIES).map((base) => {
    const effective = effectivePolicy(base,layers.workspace,layers.deal);
    return { version: base.version, thresholds: THRESHOLDS[base.version]!.map((threshold) => {
      const workspace = layers.workspace[base.version]?.[threshold.path], deal = layers.deal[base.version]?.[threshold.path];
      const change = effective.changes.find((change) => change.path === threshold.path);
      const named = (note: typeof workspace) => note ? { ...note, setByName: names.get(note.setBy) ?? "—" } : null;
      return { ...threshold, workspace: named(workspace), deal: named(deal), value: deal?.value ?? workspace?.value ?? threshold.standard,
        layer: deal ? "deal" : workspace ? "workspace" : null, looser: change?.looser ?? false, stressRemoved: change?.stressRemoved ?? false };
    }) };
  }) };
}
export function runResult(engineVersion: string, input: EngineInput, policy: Policy, standardPolicy?: Policy): RunResult {
  const result = replay(engineVersion,input,policy);
  if (policy.custom) {
    if (!standardPolicy) throw new Error("A custom run must retain its standard policy");
    const standard = replay(engineVersion,input,standardPolicy);
    result.standard = { policyVersion: standardPolicy.version, verdict: standard.verdict, checks: standard.checks.filter((check) => check.severity === "error") };
  }
  return result;
}

// ---- Deal overview ----------------------------------------------------------------

export type DealOverview = Awaited<ReturnType<typeof dealOverview>>;

export async function dealOverview(tx: Db, dealId: string) {
  const [deal] = await tx.query<{
    id: string; workspace_id: string; name: string; asset_type: string; location: string;
    currency: string | null; country: string | null; province: string | null; created_at: string; copied_from: string | null;
  }>(
    `select id, workspace_id, name, asset_type, location, currency, country, province, created_at, copied_from from deals where id = $1`,
    [dealId],
  );
  if (!deal) throw new HttpError(404, "Deal not found");
  // The source is named only when the caller can see it: the query runs under the caller's row-level security.
  const [source] = deal.copied_from ? await tx.query<{ id: string; name: string }>(`select id, name from deals where id = $1`, [deal.copied_from]) : [];
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
  const [latest] = await tx.query<{ id: string; run_number: number; verdict_code: string; assumptions_hash: string; policy_version: string; policy_hash: string; engine_version: string; created_at: string }>(
    `select id, run_number, verdict_code, assumptions_hash, policy_version, policy_hash, engine_version, created_at from latest_runs where deal_id = $1`,
    [dealId],
  );
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [dealId])) as [{ h: string }];
  const fresh = latest ? latest.assumptions_hash === h && latest.policy_hash === await currentPolicyHash(tx, dealId, latest.policy_version) && latest.engine_version === ENGINE_VERSION : false;
  const [decision] = latest
    ? await tx.query<{ decision: string; created_at: string }>(`select decision, created_at from decisions where run_id = $1 order by created_at desc limit 1`, [latest.id])
    : [];
  const [artifacts] = latest
    ? await tx.query<{ n: number }>(`select count(*)::int as n from artifacts where run_id = $1 and status = 'ready'`, [latest.id])
    : [{ n: 0 }];
  // A label, an Undo, a retired document or a switch queues a reconcile; until the worker has run it the review is behind (card 58c).
  const [{ updating }] = (await tx.query<{ updating: boolean }>(`select fn_deal_updating($1) as updating`, [dealId])) as [{ updating: boolean }];
  const processing = docs.filter((d) => ["uploaded", "checking", "reading", "extracting"].includes(d.stage)).length;
  const failed = docs.filter((d) => d.stage === "rejected" || d.stage === "read_failed").length;

  // A deal's step comes from evidence, never from a field someone sets.
  let step: "documents" | "review" | "run" | "decision" | "reports" = "documents";
  let status: { tone: "pass" | "review" | "stop" | "neutral"; text: string };
  let next: string;
  // Documents are optional evidence: a deal with values and no documents is read from its values.
  if (docs.length === 0 && counts.approved + counts.needsReview + counts.conflicting + counts.awaitingSecond === 0) {
    status = { tone: "neutral", text: "No documents yet" };
    next = "Upload the deal documents";
  } else if (processing > 0) {
    status = { tone: "neutral", text: `Reading ${processing} document${processing === 1 ? "" : "s"}` };
    next = failed ? `Retry ${failed} failed document${failed === 1 ? "" : "s"}` : "Wait for extraction";
  } else if (readiness.status === "blocked") {
    step = "review";
    // Card D1: red "Blocked" only for values that disagree or cannot be right; values waiting for the person are "Needs you".
    const stop = !!(counts.conflicting || counts.impossible);
    const parts = (stop ? [
      counts.conflicting && `${counts.conflicting} conflict${counts.conflicting === 1 ? "" : "s"}`,
      counts.missing && `${counts.missing} missing`,
      counts.needsReview && `${counts.needsReview} to review`,
      counts.awaitingSecond && `${counts.awaitingSecond} awaiting a second approver`,
      counts.impossible && `${counts.impossible} to correct`,
    ] : [
      counts.needsReview && `${counts.needsReview} to review`,
      counts.missing && `${counts.missing} missing`,
      counts.awaitingSecond && `${counts.awaitingSecond} awaiting a second approver`,
    ]).filter(Boolean);
    status = { tone: stop ? "stop" : "review", text: `${stop ? "Blocked" : "Needs you"} · ${parts.join(", ")}` };
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
    next = (artifacts?.n ?? 0) > 0 ? "Share the reports" : "Generate the reports";
  }
  const { copied_from: _copiedFrom, ...place } = deal;
  return {
    deal: place,
    copiedFrom: source ?? null,
    step,
    status,
    next,
    documents: { total: docs.length, processing, failed },
    updating,
    review: { ...counts, status: readiness.status },
    run: latest ? { id: latest.id, number: latest.run_number, verdict: latest.verdict_code, fresh, createdAt: latest.created_at } : null,
    decision: decision ?? null,
    reports: artifacts?.n ?? 0,
    units: dealUnits(assumptions),
    exit: dealExit(assumptions),
  };
}

const settled = (a: AssumptionDb) => a.status === "approved" || a.status === "default_accepted";
const live = (rows: AssumptionDb[], fieldKey: string) => rows.filter((a) => a.field_key === fieldKey && a.status !== "rejected");

/**
 * The deal's units: the sum of the approved counts of its unit types, as the run's revenue lines count them, or null
 * while none is approved, any still waits, or one type is written two ways. A stated total is not added to the types.
 * Never a partial count.
 */
function dealUnits(rows: AssumptionDb[]): number | null {
  const items = live(rows, "unit_count").filter((a) => a.item_key);
  const types = new Set(items.map((a) => itemFold(a.item_key)));
  return items.length > 0 && types.size === items.length && items.every(settled) ? items.reduce((n, a) => n + a.value!, 0) : null;
}

/**
 * How the deal ends, from its two approved flags (see readiness): kept and refinanced, units sold, or a sale at the end
 * of the hold when neither is at 1. Null while a flag waits for review or is in conflict, or when both are at 1.
 */
function dealExit(rows: AssumptionDb[]): "refinance_hold" | "for_sale" | "sale" | null {
  const flag = (fieldKey: string) => {
    const items = live(rows, fieldKey);
    return items.some((a) => !settled(a)) ? null : items.some((a) => a.value === 1);
  };
  const hold = flag("refinance_and_hold");
  const sell = flag("sell_units");
  if (hold === null || sell === null || (hold && sell)) return null;
  return sell ? "for_sale" : hold ? "refinance_hold" : "sale";
}

// ---- Review ---------------------------------------------------------------------------

/** Why the label boundary would drop this label for one of the document's figures, or null when it would keep it (task 58 audit). */
/** Why a label would be refused (null when it would be kept), and the phrase and unit a workspace remembers it under (card 113). */
export async function labelRefusal(tx: Db, documentId: string, label: { id: string; fieldKey: string; itemKey?: string }): Promise<{ why: string | null; phrase: string | null; unit: string }> {
  const rows = await tx.query<{ document_id: string; document_name: string; raw: string; value: number | null; unit_seen: string | null; location: string; context: string; note: string | null }>(
    `select c.document_id, d.name as document_name, c.raw, c.value, c.unit_seen, c.location, c.context, c.note
     from candidates c join documents d on d.id = c.document_id where c.document_id = $1 and c.field_key is null`,
    [documentId],
  );
  const figures = figureOrder(rows.map((r) => ({ fieldKey: null, itemKey: null, value: r.value, raw: r.raw, unitSeen: r.unit_seen, location: r.location, context: r.context, rule: "", documentId: r.document_id, documentName: r.document_name }) as SourcedCandidate));
  const fig = figures[offeredIds(figures).indexOf(label.id)];
  return { why: applyLabels(figures, [label]).dropped[0]?.why ?? null, phrase: fig ? labelPhrase(fig) : null, unit: labelUnit(fig?.unitSeen ?? null) };
}

/**
 * A client never sees another client (card 91). Row-level security hides another client's user row, but a name
 * or id copied into a row the client can read (a run's stored inputs, an audit event) would still show, so for a
 * client of the deal it is removed here. Staff get null and see everything.
 */
export async function clientViewer(tx: Db, dealId: string): Promise<{ id: string; name: string } | null> {
  const [me] = await tx.query<{ id: string; name: string }>(
    `select u.id, coalesce(nullif(btrim(u.name), ''), u.email) as name from users u join workspace_members m on m.user_id = u.id join deals d on d.workspace_id = m.workspace_id
     where u.id = agir_uid() and d.id = $1 and m.role = 'client'`,
    [dealId],
  );
  return me ?? null;
}

/** A run stores the confirming client's name only; a name equal to the caller's own tells the caller nothing new. */
export function hideClientInputs(viewer: { name: string } | null, inputs: unknown[]): unknown[] {
  if (!viewer) return inputs;
  return inputs.map((x) => {
    const a = x as { clientConfirmedBy?: string | null };
    return a.clientConfirmedBy && a.clientConfirmedBy !== viewer.name ? { ...a, clientConfirmedBy: null } : x;
  });
}

/** Events naming another user by id (a client assigned, removed or joined) keep their place, marked, without the id. */
export function hideClientEvents<E extends { entity_id: string | null; payload: unknown }>(viewer: { id: string } | null, events: E[]): E[] {
  if (!viewer) return events;
  return events.map((e) => {
    const user = (e.payload as { user?: unknown } | null)?.user;
    if (typeof user !== "string" || user === viewer.id) return e;
    return { ...e, entity_id: e.entity_id === user ? null : e.entity_id, payload: { ...(e.payload as object), user: null }, redacted: true };
  });
}

/** The view and confirmation use the same eligibility rules; a source must belong wholly to one region. */
export async function regionGroups(tx: Db, dealId: string) {
  const [actor] = await tx.query<{ id: string }>(`select agir_uid() as id`);
  const rows = await loadAssumptions(tx, dealId);
  const groups = new Map<string, { documentId: string; documentName: string; source: string; table: string; fields: string[]; fieldLabels: string[]; ids: string[]; leftOut: { id: string; reason: string }[] }>();
  for (const a of rows) {
    const first = a.sources[0];
    const region = first?.region;
    if (!first || !region?.table || !["table", "sheet", "text table"].includes(region.source)) continue;
    if (!a.sources.every(s => s.document_id === first.document_id && s.region?.source === region.source && s.region?.table === region.table)) continue;
    if (a.status !== "needs_review" || a.value === null || (a.conflict_values?.length ?? 0) > 1) continue;
    const key = JSON.stringify([first.document_id, region.source, region.table]);
    let g = groups.get(key);
    if (!g) {
      g = { documentId: first.document_id, documentName: first.document_name, source: region.source, table: region.table, fields: [], fieldLabels: [], ids: [], leftOut: [] };
      groups.set(key, g);
    }
    const reason = a.sources.some(s => s.ocr) ? "read by OCR"
      : a.sources.some(s => s.check_outcome === "questions") ? "please check"
      // Card 137 audit: a remembered label is its author's too (card 113), so any source the caller labelled is left out.
      : a.sources.some(s => !!s.labelled_by && s.labelled_by === actor?.id) ? "your own label"
      : FIELD_BY_KEY.get(a.field_key)?.verify ? "please check" : null;
    if (reason) g.leftOut.push({ id: a.id, reason });
    else {
      g.ids.push(a.id);
      if (!g.fields.includes(a.field_key)) {
        g.fields.push(a.field_key);
        g.fieldLabels.push(FIELD_BY_KEY.get(a.field_key)!.label);
      }
    }
  }
  return [...groups.values()].filter(g => g.ids.length >= 2);
}

/** Ordered actions for Review; readiness remains the authority for whether a run is blocked. */
export function todoList(
  readiness: Readiness,
  assumptions: Pick<AssumptionDb, "id" | "field_key" | "item_key" | "status" | "sources">[],
  aiReading: { pleaseCheck: { field: string; item: string | null }[] } | null,
) {
  type Kind = "conflict" | "impossible" | "missing" | "please_check" | "needs_review" | "awaiting" | "ai_check";
  const items: { kind: Kind; fieldKey: string; itemKey: string | null; assumptionId: string | null; blocking: boolean }[] = [];
  const add = (kind: Kind, fieldKey: string, itemKey: string | null, assumptionId: string | null, blocking = true) => items.push({ kind, fieldKey, itemKey, assumptionId, blocking });
  for (const [kind, rows] of [["conflict", readiness.conflicting], ["impossible", readiness.impossible], ["missing", readiness.missing]] as const) {
    for (const row of rows) {
      const a = kind === "missing" ? undefined : assumptions.find(a => a.field_key === row.fieldKey && (a.item_key || null) === (row.itemKey || null));
      add(kind, row.fieldKey, row.itemKey || null, a?.id ?? null);
    }
  }
  for (const kind of ["please_check", "needs_review", "awaiting"] as const) {
    for (const a of assumptions) {
      const actual = a.status === "awaiting_second_approval" ? "awaiting" : a.status === "needs_review" ? (a.sources.some(s => s.check_outcome === "questions") ? "please_check" : "needs_review") : null;
      if (actual === kind) add(kind, a.field_key, a.item_key || null, a.id);
    }
  }
  for (const a of aiReading?.pleaseCheck ?? []) add("ai_check", a.field, a.item || null, null, false);
  return { blocking: readiness.missing.length + readiness.conflicting.length + readiness.pending.length + readiness.impossible.length, items };
}

/** Where a figure sits and what it says: a figure some reader made a value is the same figure wherever it is stored. */
const figureKeys = (documentId: string, location: string, value: number | null, raw: string | null | undefined) =>
  [...(value === null ? [] : [`${documentId}\u0000${location}\u0000v${value}`]), ...(raw ? [`${documentId}\u0000${location}\u0000r${raw}`] : [])];

/**
 * The figures no reader used (QA run 2, skeptic N1). A figure the rules left unmatched is still used when a reader, the rules
 * or the AI reading, made it a candidate or a value's source; it is left out unless a person labelled it, which the list shows.
 * `all` keeps every figure, for the ids the AI reading's own unused list names.
 */
async function otherFigures(tx: Db, dealId: string, assumptions: Pick<AssumptionDb, "sources">[]) {
  const rows = await tx.query<{ id: string; document_id: string; document_name: string; raw: string; value: number | null; unit_seen: string | null; location: string; context: string; note: string | null }>(
    `select c.id, c.document_id, d.name as document_name, c.raw, c.value, c.unit_seen, c.location, c.context, c.note
     from candidates c join documents d on d.id = c.document_id
     where c.deal_id = $1 and c.field_key is null and d.retired_at is null
     order by d.name, c.location`,
    [dealId],
  );
  // The id a figure label names: the same one the worker's reconcile computes.
  const figures = figureOrder(rows.map((r) => ({ fieldKey: null, itemKey: null, value: r.value, raw: r.raw, unitSeen: r.unit_seen, location: r.location, context: r.context, rule: "", documentId: r.document_id, documentName: r.document_name, rowId: r.id }) as SourcedCandidate));
  const figureIds = new Map(offeredIds(figures).map((id, i) => [(figures[i] as SourcedCandidate & { rowId: string }).rowId, id]));
  const labels = await tx.query<{ document_id: string; figure_id: string; field_key: string; item_key: string; by: string; created_at: string | Date }>(
    `select l.document_id, l.figure_id, l.field_key, l.item_key, coalesce(nullif(btrim(u.name), ''), u.email) as by, l.created_at from figure_labels l join users u on u.id = l.created_by where l.deal_id = $1`,
    [dealId],
  );
  const all = rows.map((r) => {
    const figureId = figureIds.get(r.id) ?? null;
    const l = labels.find((x) => x.document_id === r.document_id && x.figure_id === figureId);
    return {
      documentId: r.document_id, document_name: r.document_name, raw: r.raw, value: r.value, location: r.location, context: r.context, note: r.note, figureId,
      label: l ? { fieldKey: l.field_key, itemKey: l.item_key || null, by: l.by, at: l.created_at } : null,
      // Card 112: fields a person might label it with. Never stored or read; a click saves an ordinary label.
      suggestions: l || !figureId || r.value === null ? [] : suggestFields({ raw: r.raw, context: r.context, note: r.note, unitSeen: r.unit_seen, value: r.value }),
    };
  });
  const used = new Set<string>();
  // Only a reading uses a figure. A choice between a figure's readings, a remembered label or a suggested one is a proposal on a figure
  // no reader named, which a person settles by labelling it here, so that figure stays listed.
  const proposal = new Set(["arithmetic-choice", "remembered", "suggested", "labelled"]);
  for (const a of assumptions) for (const s of a.sources ?? []) if (s.document_id && s.location && !proposal.has(s.rule ?? "")) for (const k of figureKeys(s.document_id, s.location, s.value, s.raw)) used.add(k);
  const matched = await tx.query<{ document_id: string; location: string; value: number | null; raw: string }>(
    `select document_id, location, value, raw from candidates where deal_id = $1 and field_key is not null`, [dealId]);
  for (const c of matched) for (const k of figureKeys(c.document_id, c.location, c.value, c.raw)) used.add(k);
  const other = all.filter((o) => o.label || !figureKeys(o.documentId, o.location, o.value, o.raw).some((k) => used.has(k)));
  return { all, other };
}

/**
 * The deal's documents (QA run 2, skeptic N2). used_count is the number of current values with a source in the document, from
 * the rules or the AI reading; candidate_count stays what the rules alone found. other_count is the figures no reader used.
 */
export async function documentsView(tx: Db, dealId: string) {
  const rows = await tx.query<{ id: string; candidate_count: number }>(
    `select d.id, d.name, d.kind, d.role_set, d.read_role, d.size_bytes, d.stage, d.stage_detail, d.page_count, d.number_format, d.needs_ocr, d.candidate_count,
            d.created_at, d.updated_at, coalesce(nullif(btrim(u.name), ''), u.email) as uploaded_by
     from documents d left join users u on u.id = d.uploaded_by
     where d.deal_id = $1 and d.retired_at is null order by d.created_at, d.name`,
    [dealId],
  );
  const assumptions = (await loadAssumptions(tx, dealId)).filter((a) => a.status !== "rejected");
  const { other } = await otherFigures(tx, dealId, assumptions);
  return rows.map((d) => ({
    ...d,
    used_count: assumptions.filter((a) => a.sources.some((s) => s.document_id === d.id)).length,
    other_count: other.filter((o) => o.documentId === d.id).length,
  }));
}

export async function reviewView(tx: Db, dealId: string, asOf: string) {
  const assumptions = await loadAssumptions(tx, dealId);
  const { readiness, gaps } = readinessFor(assumptions);
  const [deal] = await tx.query<{country: string; province: string | null}>(`select country, province from deals where id = $1`, [dealId]);
  // The tables are Canadian: a deal elsewhere is told so, and a Canadian deal with no province is asked for one.
  const outside = deal !== undefined && deal.country !== "CA";
  const province = outside ? null : deal?.province;
  const noProvince = outside ? "these tables are for deals in Canada; enter the amount yourself" : "the deal has no province";
  const approved = assumptions.filter(a => ENGINE_READABLE_STATUSES.includes(a.status) && a.value !== null);
  const value = (key: string) => approved.find(a => a.field_key === key && !a.item_key)?.value ?? undefined;
  const unapprovedUnits = assumptions.some(a => a.field_key === "unit_count" && !ENGINE_READABLE_STATUSES.includes(a.status));
  const units = approved.filter(a => a.field_key === "unit_count" && a.item_key).reduce((n,a) => n + a.value!,0);
  const offered = new Set([...readiness.notFound,...readiness.choices].map(r => r.fieldKey));
  const savedTables=approved.filter(a=>a.source_kind === "table");
  for (const a of savedTables) offered.add(a.field_key);
  const proposals: Proposal[] = [];
  const propose = (fieldKey: string, t: Table | undefined, result: {options: TableOption[]} | {unavailable: string}) => {
    const meta = {fieldKey,tableId:t?.id ?? fieldKey,title:t?.title ?? FIELD_BY_KEY.get(fieldKey)!.label,publisher:t?.publisher ?? "",url:t?.url ?? "",effective:t?.effective ?? "",recheckBy:t?.recheckBy ?? "",readOn:t?.readOn ?? "",signedOn:t?.signedOn ?? ""};
    const options = "options" in result ? result.options.map(o => {
      // Keep the conditions visible before acceptance and in the recorded reason.
      const label = o.label + (o.note ? ` — ${o.note}` : "");
      return {key:o.key,label,value:o.value,reason:`Proposed from ${t!.publisher}, ${t!.title} (effective ${t!.effective}, read ${t!.readOn}): ${label}${label.endsWith(".") ? "" : "."}`};
    }) : [];
    proposals.push({...meta,options,...("unavailable" in result ? {unavailable:result.unavailable} : {})});
  };
  if (offered.has("land_transfer_tax")) {
    const land = value("land_cost");
    propose("land_transfer_tax", province ? landTable(province,asOf) : undefined, !province ? {unavailable:noProvince} : land === undefined ? {unavailable:assumptions.some(a => a.field_key === "land_cost" && !a.item_key && a.status !== "rejected") ? "approve the land cost first" : "state the land cost first"} : landTransferTaxOptions({province,value:land,asOf}));
  }
  if (offered.has("gst_hst_net")) propose("gst_hst_net",GST_HST,!province ? {unavailable:noProvince} : unapprovedUnits ? {unavailable:"approve the unit counts first"} : gstHstNetOptions({province,units,selling:value("sell_units") === 1,asOf}));
  if (offered.has("refinance_insurance_premium_pct")) {
    const ltvPct=value("refinance_ltv_pct"), amortYears=value("refinance_amort_years");
    const premium = !province ? {unavailable:noProvince} : unapprovedUnits ? {unavailable:"approve the unit counts first"} : units < 5 ? {unavailable:"CMHC multi-unit insurance needs at least 5 units; enter the premium yourself"}
      : ltvPct === undefined || value("refinance_amount") !== undefined ? {unavailable:"the table needs a loan-to-value"}
      : amortYears === undefined ? {unavailable:"state the refinance amortization first"}
      : cmhcPremium({ltvPct,amortYears,points:value("refinance_mli_select_points"),asOf});
    propose("refinance_insurance_premium_pct",CMHC_PREMIUM,"value" in premium ? {options:[{key:"cmhc",label:premium.label,value:premium.value}]} : premium);
  }
  if (offered.has("refinance_premium_tax_pct")) propose("refinance_premium_tax_pct",province ? PREMIUM_TAX_TABLES[province as keyof typeof PREMIUM_TAX_TABLES] : undefined,!province ? {unavailable:noProvince} : premiumTaxOptions({province,asOf}));
  const tableNotices: Proposal[] = [];
  for (let index=proposals.length-1; index>=0; index--) {
    const proposal=proposals[index]!;
    const saved=savedTables.find(a=>a.field_key === proposal.fieldKey);
    if (!saved) continue;
    proposals.splice(index,1);
    const source=tableSource(saved)!;
    const option=proposal.options.find(o=>o.key === source.optionKey);
    if (option && (option.value !== saved.value || proposal.effective !== source.effective || proposal.tableId !== source.tableId)) tableNotices.unshift({...proposal,options:[option]});
  }
  const viewer = await clientViewer(tx, dealId);
  const { all, other } = await otherFigures(tx, dealId, assumptions);
  const docs = await currentDocuments(tx, dealId);
  // RLS on ai_readings limits this snapshot to staff, including when a client can read the deal.
  const [stored] = await tx.query<{ outcome: "ok" | "failed"; model: string; prompt_version: string; created_at: string | Date; response: ReaderResponse | null; verification: { readings: ReadingVerification[]; conflicts: ReadingVerification[][] } | null }>(
    `select outcome, model, prompt_version, created_at, response, verification from ai_readings where deal_id=$1 and documents_hash=$2 and prompt_version=$3 order by created_at desc, id desc limit 1`,
    [dealId, documentsHash(docs), READER_PROMPT_VERSION],
  );
  // A reading that failed its check is shown for the person to check, unless the review already holds that figure for the
  // field (the rules read it): then the card would only repeat a row that is already waiting for approval (QA run 3, skeptic R1).
  const alreadyRead = (r: { field: string; value: number }) => assumptions.some((a) => a.status !== "rejected" && a.field_key === r.field && a.value !== null && Math.abs(a.value - r.value) < 0.5);
  const rejectedReading = (r: ReaderResponse["readings"][number], verification: ReadingVerification | undefined) => verification && verification.outcome !== "verified" && !alreadyRead(r)
    ? [{ field: r.field, item: r.item, value: r.value, file: r.file, location: r.location, quote: r.quote, reason: verification.outcome }] : [];
  const aiReading = stored ? {
    outcome: stored.outcome, model: stored.model, promptVersion: stored.prompt_version, createdAt: stored.created_at,
    notUsed: (stored.response?.not_used ?? []).map(r => {
      const matches = docs.filter(d => d.name === r.file);
      const document = matches.length === 1 ? matches[0] : undefined;
      return { ...r, figureId: all.find(o => !o.label && o.documentId === document?.id && o.location === r.location && o.value === r.value)?.figureId ?? null };
    }),
    pleaseCheck: [
      ...(stored.response?.readings ?? []).flatMap((r, i) => rejectedReading(r, stored.verification?.readings[i])),
      ...(stored.response?.conflicts ?? []).flatMap((c, i) => c.values.flatMap((v, j) => rejectedReading({ ...v, field: c.field, item: c.item, note: c.why, confidence: "high" }, stored.verification?.conflicts[i]?.[j]))),
    ],
  } : null;
  // Up to three unlabelled figures that may hold a missing input: those it ranks first, then the others, each in the table's order.
  const likely = (fieldKey: string) =>
    other.filter((o) => o.suggestions.includes(fieldKey))
      .sort((a, b) => Number(a.suggestions[0] !== fieldKey) - Number(b.suggestions[0] !== fieldKey))
      .slice(0, 3)
      .map((o) => ({ documentId: o.documentId, figureId: o.figureId!, document_name: o.document_name, location: o.location, raw: o.raw, context: o.context }));
  return {
    aiReading,
    todo: todoList(readiness, assumptions, aiReading),
    readiness,
    regions: await regionGroups(tx, dealId),
    proposals,
    tableNotices,
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
        source: sourceLabel(a),
        ...(tableSource(a) ? {tableSource:tableSource(a)} : {}),
        sources: a.sources,
        conflictValues: a.conflict_values,
        reason: a.reason,
        decidedBy: a.decided_by_name,
        decidedById: a.decided_by,
        decidedAt: a.decided_at,
        secondApprover: a.second_approver_name,
        confirmedByReview: a.confirmed_by_review,
        secondApprovedAt: a.second_approved_at,
        sponsorStated: a.sponsor_stated,
        clientConfirmedBy: viewer && a.client_confirmed_by !== viewer.id ? null : a.client_confirmed_by_name,
        clientConfirmedById: viewer && a.client_confirmed_by !== viewer.id ? null : a.client_confirmed_by,
        clientConfirmedAt: a.client_confirmed_at,
        version: a.version,
      };
    }),
    missing: readiness.missing.map((m) => {
      const def = FIELD_BY_KEY.get(m.fieldKey)!;
      const gap = gaps[`${m.fieldKey}|${m.itemKey ?? ""}`];
      return { ...m, ...(gap ? { detail: gap } : {}), unit: def.unit, material: def.material, default: def.default ?? null, help: def.help ?? null, groupLabel: FIELD_GROUP_LABELS[def.group], likely: likely(m.fieldKey) };
    }),
    notFound: readiness.notFound.map((m) => {
      const def = FIELD_BY_KEY.get(m.fieldKey)!;
      return { ...m, unit: def.unit, material: def.material, default: def.default ?? null, help: def.help ?? null, groupLabel: FIELD_GROUP_LABELS[def.group] };
    }),
    choices: readiness.choices.map((m) => {
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

/** What a streamed run reports when its inputs are settled (card R1). Counts and names only; no financial figure. */
export type RunFacts = { approved: number; defaults: number; policyVersion: string; policyDraft: boolean; exit: "sale" | "refinance_hold" | "for_sale";
  constructionMonths: number; holdYears?: number; stresses: number; inputHash: string; engineVersion: string };
/** A run's progress (card R1): each stage as it finishes, and `check`, which throws when a stop was asked for. */
export type RunProgress = { stage(key: "inputs" | "ledger" | "loans" | "stresses" | "gates", at: Date, facts?: RunFacts): Promise<void> | void; check(): Promise<void> | void };

export async function createRun(tx: Db, dealId: string, asOf: string, progress?: RunProgress) {
  const assumptions = await loadAssumptions(tx, dealId);
  const { readiness, input } = readinessFor(assumptions);
  if (!input) throw new HttpError(409, "Underwriting is blocked until review is clear.", { readiness });
  const base = policyFor(input);
  const layers = await policyLayers(tx, dealId);
  const { policy, changes, invalid } = effectivePolicy(base, layers.workspace, layers.deal);
  if (invalid.length) throw new HttpError(409, `A threshold set for ${base.version} no longer fits this policy: ${invalid.map((v) => `${v.path} (${v.layer})`).join(", ")}. Change or clear it under Thresholds, then run again.`, { invalid });
  const policyHash = sha256(canonicalJson(policy));
  const inputHash = sha256(canonicalJson(input));
  if (progress) {
    await progress.stage("inputs", new Date(), {
      approved: assumptions.filter((a) => a.status === "approved").length, defaults: assumptions.filter((a) => a.status === "default_accepted").length,
      policyVersion: policy.version, policyDraft: policy.draft === true, exit: input.exit ?? "sale", constructionMonths: input.constructionMonths,
      ...(input.exit === "for_sale" ? {} : { holdYears: input.holdYears }), stresses: policy.stresses.length, inputHash, engineVersion: ENGINE_VERSION,
    });
    await progress.check();
  }
  const result = runResult(ENGINE_VERSION,input,policy,policy.custom ? base : undefined);
  // The engine is one synchronous call: its four stages finish together, when it returns.
  if (progress) {
    const at = new Date();
    for (const key of ["ledger", "loans", "stresses", "gates"] as const) await progress.stage(key, at);
    await progress.check();
  }
  const setters = changes.length ? await tx.query<{ id: string; name: string }>(`select id, coalesce(nullif(btrim(name), ''), email) as name from users where id=any($1::uuid[])`, [[...new Set(changes.map((change) => change.setById))]]) : [];
  const policyChanges = changes.map((change) => ({ ...change, setBy: setters.find((user) => user.id === change.setById)?.name ?? "—" }));
  const used = assumptions
    .filter((a) => a.status === "approved" || a.status === "default_accepted")
    .map((a) => ({
      fieldKey: a.field_key,
      itemKey: a.item_key || null,
      label: FIELD_BY_KEY.get(a.field_key)!.label,
      value: a.value!,
      sourceKind: a.source_kind,
      source: sourceLabel(a),
      ...(tableSource(a) ? {tableSource:tableSource(a)} : {}),
      ...(tableSource(a)?.recheckBy && tableSource(a)!.recheckBy! <= asOf ? {tableStale:true} : {}),
      sponsorStated: a.sponsor_stated,
      confirmedBy: a.second_approver_name,
      confirmedByReview: a.confirmed_by_review,
      confirmedAt: a.second_approved_at,
      // Only when set, so a snapshot without a client's confirmation is what it was before card 89.
      ...(a.client_confirmed_at ? { clientConfirmedBy: a.client_confirmed_by_name, clientConfirmedAt: a.client_confirmed_at } : {}),
    }));
  const resultHash = sha256(canonicalJson(result));
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [dealId])) as [{ h: string }];
  const payload = {
    engine_version: ENGINE_VERSION,
    policy_version: policy.version,
    policy_hash: policyHash,
    // The policy itself is stored, so the run replays and renders under it after a draft is edited.
    input_snapshot: { input, policy, assumptions: used, notFound: readiness.notFound, ...(policy.custom ? { standardPolicy: base, policyChanges } : {}) },
    input_hash: inputHash,
    assumptions_hash: h,
    result,
    result_hash: resultHash,
    verdict_code: result.verdict.code,
    signature: signRun(inputHash, resultHash, policyHash),
    metrics: flattenMetrics(result),
    gates: result.verdict.gates,
    checks: result.checks,
  };
  const [{ id }] = (await tx.query<{ id: string }>(`select fn_persist_run($1, $2) as id`, [dealId, JSON.stringify(payload)])) as [{ id: string }];
  // A stop asked for before the commit rolls the run back: no run row, no audit event, no run number used.
  await progress?.check();
  return id;
}

export async function runView(tx: Db, runId: string) {
  const [run] = await tx.query<{
    id: string; deal_id: string; run_number: number; engine_version: string; policy_version: string; policy_hash: string;
    input_hash: string; result_hash: string; assumptions_hash: string; verdict_code: string; signature: string; created_at: string;
    created_by_name: string | null; result: RunResult; input_snapshot: { input: EngineInput; policy?: Policy; standardPolicy?: Policy; policyChanges?: PolicyChange[]; assumptions: unknown[]; notFound?: { fieldKey: string; itemKey?: string; label: string; detail?: string }[] };
  }>(
    `select r.*, coalesce(nullif(btrim(u.name), ''), u.email) as created_by_name from runs r left join users u on u.id = r.created_by where r.id = $1`,
    [runId],
  );
  if (!run) throw new HttpError(404, "Run not found");
  const [{ h }] = (await tx.query<{ h: string }>(`select fn_assumptions_hash($1) as h`, [run.deal_id])) as [{ h: string }];
  const [latest] = await tx.query<{ id: string }>(`select id from latest_runs where deal_id = $1`, [run.deal_id]);
  const staleReasons: string[] = [];
  if (run.assumptions_hash !== h) staleReasons.push("An approved input changed after this run.");
  if (run.policy_hash !== await currentPolicyHash(tx, run.deal_id, run.policy_version)) staleReasons.push("The policy thresholds changed after this run.");
  if (run.engine_version !== ENGINE_VERSION) staleReasons.push("The engine was updated after this run.");
  const decisions = await tx.query(
    `select d.id, d.decision, d.rationale, d.conditions, d.override_reason, d.created_at, coalesce(nullif(btrim(u.name), ''), u.email) as decided_by
     from decisions d join users u on u.id = d.decided_by where d.run_id = $1 order by d.created_at desc`,
    [runId],
  );
  // A held run with a split shows its partner returns (card 88): report arithmetic over the stored flows, not metrics.
  const { input } = run.input_snapshot;
  const held = input.exit === "refinance_hold" && input.waterfall ? heldPartnerReturns(run.result.equityFlows, input.waterfall) : null;
  const positive = (flows: readonly { amount: number }[]) => flows.filter((f) => f.amount > 0).reduce((n, f) => n + f.amount, 0);
  // The refinance loan (card R3) is the engine's own ledger replayed on the run's recorded input: not one of the run's signed figures.
  // Only under the engine version that recorded the run, and left out if the ledger cannot be built.
  let refinance: { loan: number; value: number; month: number; ltvPct: number | null; stated: boolean } | null = null;
  if (input.refinance && run.engine_version === ENGINE_VERSION) {
    try {
      const r = buildLedger(input).refinance;
      if (r) refinance = { loan: r.newAmount, value: r.value, month: r.month, ltvPct: input.refinance.ltvPct ?? null, stated: input.refinance.amount !== undefined };
    } catch {
      refinance = null;
    }
  }
  return {
    id: run.id,
    dealId: run.deal_id,
    number: run.run_number,
    createdAt: run.created_at,
    createdBy: run.created_by_name,
    engineVersion: run.engine_version,
    policyVersion: run.policy_version,
    policyDraft: runPolicy(run.input_snapshot, run.policy_version)?.draft === true,
    ...(run.input_snapshot.policy?.custom ? { policyCustom: true, policy: run.input_snapshot.policy, standardPolicy: run.input_snapshot.standardPolicy, policyChanges: run.input_snapshot.policyChanges } : {}),
    inputHash: run.input_hash,
    resultHash: run.result_hash,
    signed: run.signature.startsWith("dev-unsafe:") ? "development key" : "production key",
    fresh: staleReasons.length === 0,
    staleReasons,
    isLatest: latest?.id === run.id,
    result: run.result,
    inputs: hideClientInputs(await clientViewer(tx, run.deal_id), run.input_snapshot.assumptions),
    // Read only (card C5): the optional lines no document gave and what the run assumed instead, as the run recorded them.
    notFound: run.input_snapshot.notFound ?? [],
    decisions,
    ...(held ? { heldPartners: { lpIrr: held.withValue.lpIrr, gpIrr: held.withValue.gpIrr, promote: held.withValue.promote,
      paidLp: positive(held.paid.lp), paidGp: positive(held.paid.gp), paidPromote: held.paid.promote } } : {}),
    ...(refinance ? { refinance } : {}),
  };
}

/** The audit package: everything a reviewer needs, plus proof that it hangs together. */
export async function auditPackage(tx: Db, runId: string) {
  const [run] = await tx.query<{
    id: string; deal_id: string; run_number: number; engine_version: string; policy_version: string; policy_hash: string; input_hash: string;
    result_hash: string; signature: string; result: RunResult; input_snapshot: { input: EngineInput; policy?: Policy; standardPolicy?: Policy; policyChanges?: PolicyChange[]; assumptions: unknown[] }; created_at: string;
  }>(`select * from runs where id = $1`, [runId]);
  if (!run) throw new HttpError(404, "Run not found");
  const [deal] = await tx.query(`select id, name, asset_type, location, currency, country, province from deals where id = $1`, [run.deal_id]);
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
    const policy = runPolicy(run.input_snapshot, run.policy_version);
    // The policy replayed must be the one the run's hash and signature name.
    replayed = policy !== undefined && sha256(canonicalJson(policy)) === run.policy_hash &&
      sha256(canonicalJson(runResult(run.engine_version, run.input_snapshot.input, policy, run.input_snapshot.standardPolicy))) === run.result_hash;
  } catch {
    replayed = false;
  }
  check("replay", replayed, "Replaying the recorded engine on the recorded input reproduces the result exactly.");
  check("decisions_bound", decisions.every((d) => d.run_id === run.id), "Every decision in the package names this run.");
  check("audit_chain", Boolean(chain?.ok), chain?.ok ? `The audit chain is intact (${chain.events} events).` : `The audit chain breaks at event ${chain?.broken_at}.`);
  const viewer = await clientViewer(tx, run.deal_id);
  return {
    manifest: { deal, run: { id: run.id, number: run.run_number, createdAt: run.created_at, engineVersion: run.engine_version, policyHash: run.policy_hash, inputHash: run.input_hash, resultHash: run.result_hash } },
    validation: { status: checks.every((c) => c.status === "passed") ? "passed" : "failed", checkedAt: new Date().toISOString(), checks },
    inputs: { ...run.input_snapshot, assumptions: hideClientInputs(viewer, run.input_snapshot.assumptions) },
    result: run.result,
    decisions,
    artifacts,
    auditEvents: hideClientEvents(viewer, events as { entity_id: string | null; payload: unknown }[]),
  };
}
