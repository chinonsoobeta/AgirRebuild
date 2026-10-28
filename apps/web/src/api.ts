// The browser talks only to the Agir API. It never queries the database.

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: any) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "x-agir": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.detail ?? (data?.code === "outside_window" ? data : undefined));
  return data as T;
}

/** A POST answered with one JSON object a line (a run's progress, card R1). Each line goes to `onLine` as it comes;
    an `error` line throws ApiError, as the plain route would have. Returns the last line. */
async function streamLines<T extends object>(path: string, headers: Record<string, string>, onLine: (line: T) => void): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: { "x-agir": "1", ...headers } });
  if (!res.ok || !res.body) {
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.detail);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let last: T | undefined;
  const take = (raw: string) => {
    if (!raw.trim()) return;
    const line = JSON.parse(raw);
    if (line?.error) throw new ApiError(line.error.status, line.error.message, line.error.detail);
    last = line;
    onLine(line);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    for (let n = buffered.indexOf("\n"); n >= 0; n = buffered.indexOf("\n")) {
      take(buffered.slice(0, n));
      buffered = buffered.slice(n + 1);
    }
  }
  take(buffered + decoder.decode());
  if (!last || !("done" in last || "stopped" in last)) throw new ApiError(0, RUN_CUT_OFF);
  return last;
}
/** The stream ended without its last line: the run may or may not have been recorded. */
const RUN_CUT_OFF = "The connection closed before the run finished. Open the deal again to see whether it was recorded.";

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  stream: streamLines,
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body ?? {}),
  put: <T>(p: string, body: unknown) => request<T>("PUT", p, body),
  upload: <T>(p: string, file: File, method: "PUT" | "POST" = "PUT") => request<T>(method, p, undefined, file),
  del: <T>(p: string, body: unknown) => request<T>("DELETE", p, body),
};

// ---- Response shapes ---------------------------------------------------------------
/** A streamed run (card R1). */
export type RunStage = "inputs" | "ledger" | "loans" | "stresses" | "gates" | "record";
export type RunFacts = { approved: number; defaults: number; policyVersion: string; policyDraft: boolean; exit: "sale" | "refinance_hold" | "for_sale";
  constructionMonths: number; holdYears?: number | undefined; stresses: number; inputHash: string; engineVersion: string };
export type RunLine = { stage: RunStage; at: string; facts?: RunFacts } | { done: { id: string } } | { stopped: true };
/** What the screen holds while a run streams: the time each stage finished, and the facts from the inputs stage. */
export type RunProgress = { stages: Partial<Record<RunStage, string>>; facts?: RunFacts | undefined };
export type Me = { user: { id: string; email: string; name: string; email_verified: boolean }; /** False when the server cannot send email (card B). */ mail?: boolean; /** True when the server writes each email to a folder instead of sending it (QA card D3). */ mailFolder?: boolean; workspaces: { id: string; name: string; review_mode: "team" | "solo"; label_suggestions: boolean; ai_reading: boolean; has_logo: boolean; /** Card F: when the owner closed it; a closed workspace is read-only. */ closed_at?: string | null; role: "owner" | "admin" | "analyst" | "viewer" | "reviewer" | "client" }[];
  /** Card F: closing a workspace and deleting an account are offered (AGIR_ACCOUNT_CLOSURE=1). */ closure?: boolean };
export type Tone = "pass" | "review" | "stop" | "neutral";
export type DealOverview = {
  deal: {
    id: string;
    workspace_id: string;
    name: string;
    asset_type: string;
    location: string;
    currency: string | null;
    country: string | null;
    province: string | null;
    created_at: string;
  };
  copiedFrom: { id: string; name: string } | null;
  step: "documents" | "review" | "run" | "decision" | "reports";
  status: { tone: Tone; text: string };
  next: string;
  documents: { total: number; processing: number; failed: number };
  /** A reconcile for this deal is queued or running: the review is behind its documents (card 58c). */
  updating: boolean;
  review: { approved: number; needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number; status: "ready" | "blocked" };
  run: { id: string; number: number; verdict: string; fresh: boolean; createdAt: string } | null;
  decision: { decision: string; created_at: string } | null;
  reports: number;
  /** The approved unit-type counts added up; null while one waits, none is approved, or a type is written two ways. Never 0 for unknown. */
  units: number | null;
  /** How the deal ends, from its approved flags; null while a flag waits or both are set. */
  exit: "sale" | "refinance_hold" | "for_sale" | null;
};
export type DocumentRow = {
  id: string; name: string; kind: string; role_set: "deal_source" | "evidence" | "context" | null; read_role: string | null; size_bytes: number; stage: string; stage_detail: string | null; page_count: number | null;
  number_format: string | null; needs_ocr: boolean; candidate_count: number; used_count: number; other_count: number; created_at: string; uploaded_by: string | null;
};
export type Source = { document_id: string; document_name: string; value: number; location: string; raw: string; unit_seen?: string | null; context: string; rule?: string; ocr?: boolean; note?: string; check_outcome?: "confirms" | "questions"; check_note?: string };
export type Assumption = {
  id: string; fieldKey: string; itemKey: string | null; label: string; group: string; groupLabel: string; unit: string; material: boolean;
  conservative: "max" | "min" | null; status: string; value: number | null; pendingValue: number | null; sourceKind: "document" | "analyst" | "default" | "table"; source?: string; tableSource?: import("@agir/contracts").TableSource;
  sources: Source[]; conflictValues: { value: number; documents: string[] }[] | null; reason: string | null; decidedBy: string | null;
  decidedById: string | null; decidedAt: string | null; secondApprover: string | null; confirmedByReview: boolean; secondApprovedAt: string | null; sponsorStated: boolean;
  /** The deal's client said the broker's value is right (card 89); not an independent confirmation. A client cannot see another client's name. */
  clientConfirmedBy: string | null; clientConfirmedById: string | null; clientConfirmedAt: string | null; version: number;
};
export type ReadinessItem = { fieldKey: string; itemKey?: string; label: string; detail?: string };
export type Review = {
  todo: { blocking: number; items: { kind: "conflict" | "impossible" | "missing" | "please_check" | "needs_review" | "awaiting" | "ai_check"; fieldKey: string; itemKey: string | null; assumptionId: string | null; blocking: boolean }[] };
  aiReading: null | { outcome: "ok" | "failed"; model: string; promptVersion: string; createdAt: string;
    notUsed: { value: number; file: string; location: string; quote: string; why: string; figureId: string | null }[];
    pleaseCheck: { field: string; item: string | null; value: number; file: string; location: string; quote: string; reason: string }[];
  };
  regions: { documentId: string; documentName: string; source: string; table: string; fields: string[]; ids: string[]; leftOut: { id: string; reason: string }[] }[];
  proposals: import("@agir/contracts").Proposal[];
  tableNotices: import("@agir/contracts").Proposal[];
  readiness: { status: "ready" | "blocked"; missing: ReadinessItem[]; conflicting: ReadinessItem[]; pending: ReadinessItem[]; impossible: ReadinessItem[]; notFound: ReadinessItem[]; choices: ReadinessItem[]; defaultable: string[] };
  assumptions: Assumption[];
  missing: (ReadinessItem & { unit: string; material: boolean; default: number | null; help: string | null; groupLabel: string; likely: { documentId: string; figureId: string; document_name: string; location: string; raw: string; context: string }[] })[];
  notFound: Review["missing"];
  choices: Review["missing"];
  other: { documentId: string; document_name: string; raw: string; value: number | null; location: string; context: string; note: string | null; figureId: string | null; label: { fieldKey: string; itemKey: string | null; by: string; at: string } | null; suggestions: string[] }[];
};
export type Metric = { key: string; label: string; unit: string; value: number | null; status: string; reason?: string; formula: string };
export type RunView = {
  policyCustom?: boolean; policy?: import("@agir/contracts").Policy; standardPolicy?: import("@agir/contracts").Policy; policyChanges?: import("@agir/contracts").PolicyChange[];
  id: string; dealId: string; number: number; createdAt: string; createdBy: string | null; engineVersion: string; policyVersion: string; policyDraft: boolean;
  inputHash: string; resultHash: string; signed: string; fresh: boolean; staleReasons: string[]; isLatest: boolean;
  result: {
    standard?: import("@agir/contracts").RunResult["standard"];
    scenarios: { key: string; label: string; metrics: Metric[] }[];
    verdict: { code: string; headline: string; explanation: string; hardFailReasons: string[]; gates: { key: string; label: string; scenario: string; metricKey: string; threshold: number; unit: string; actual: number | null; status: string }[] };
    checks: { key: string; kind: string; severity: "pass" | "warning" | "error"; message: string; expected?: number; actual?: number }[];
    annual: { year: number; gpr: number; egi: number; opex: number; noi: number; debtService: number; sizingDebtService: number; cashFlow: number }[];
    warnings: { key: string; message: string }[];
  };
  inputs: { fieldKey: string; itemKey: string | null; label: string; value: number; sourceKind: string; source: string; tableSource?: import("@agir/contracts").TableSource; tableStale?: true; sponsorStated: boolean; confirmedBy: string | null; confirmedByReview: boolean; confirmedAt: string | null }[];
  /** The optional lines no document gave, and what the run took instead (card C5). Older runs may not carry it. */
  notFound?: { fieldKey: string; itemKey?: string; label: string; detail?: string }[];
  decisions: { id: string; decision: string; rationale: string; conditions: string | null; override_reason: string | null; created_at: string; decided_by: string }[];
  heldPartners?: { lpIrr: number | null; gpIrr: number | null; promote: number; paidLp: number; paidGp: number; paidPromote: number };
  /** The refinance loan, from the engine's ledger replayed on the run's recorded input by the same engine version; not stored with the run (card R3). */
  refinance?: { loan: number; value: number; month: number; ltvPct: number | null; stated: boolean };
};
export type Artifact = { lang: "en" | "fr"; id: string; kind: string; format: string; status: string; error: string | null; sha256: string | null; created_at: string; run_id: string; run_number: number; provenance_entries: number | null };
export type ShareTerm = "24h" | "7d" | "30d" | "none";
/** A link shares a run's files together (card R2): `files` in the shared page's order; `kind` and `format` are the first one's.
 *  `artifact_id` is set only for a link made by the older one-file route. */
export type ShareLink = { id: string; artifact_id: string | null; run_id: string; kind: string; format: string; run_number: number;
  files: { kind: string; format: string; lang: "en" | "fr" }[]; term: ShareTerm; expires_at: string | null; created_at: string;
  created_by: string | null; revoked_at: string | null; revoked_by: string | null; openings: number; last_opened_at: string | null };
/** One file of a shared link; `traced` is the number of traced figures the file recorded, null when it recorded none. */
export type SharedFile = { id: string; kind: string; format: string; lang: "en" | "fr"; traced: number | null };
export type SharedReport = {
  standardFailures?: { en: string[]; fr: string[] }; deal: string; kind: string; format: string; runNumber: number; expiresAt: string | null;
  /** The link's files (card R2); `kind` and `format` above are the first one's. */
  files?: SharedFile[];
  /** What the shared run stored, never recomputed (card Y2). A link whose run cannot be read has none of these. */
  workspace?: string; location?: string; province?: string | null; currency?: string | null; runAt?: string;
  units?: number; exit?: "sale" | "refinance_hold" | "for_sale"; policyDraft?: boolean;
  /** False when credit has not signed the run's policy (card E); the page then says so. */
  policySigned?: boolean;
  verdict?: RunView["result"]["verdict"]; errorChecks?: number;
  /** Stored base-case metrics in a fixed order; only the ones the run has. */
  figures?: Pick<Metric, "key" | "unit" | "value" | "status" | "reason">[];
  /** The stored exit cap rate; absent for a run that sells its units. */
  exitCapPct?: number;
};
/** `confirmed` counts the client's confirmations that still stand; a changed value clears its confirmation. */
export type DealClient = { id: string; name: string; email: string; assigned_at: string; confirmed: number; last_confirmed_at: string | null };
export type ClientInvite = { id: string; created_at: string; expires_at: string; created_by: string | null; used_at: string | null; used_by: string | null; revoked_at: string | null; revoked_by: string | null };
export type InvitePeek = { workspace: string; deal: string; expiresAt: string };
export type AuditEvent = { seq: number; action: string; entity: string; entity_id: string | null; payload: any; hash: string; created_at: string; actor: string | null };

export type ThresholdNote = import("@agir/contracts").PolicyValue & { setByName: string };
export type ThresholdView = { invalid?: { version: string; path: string; layer: "workspace" | "deal"; value: number; setById: string; setByName: string; setAt: string; reason: string; error: { en: string; fr: string } }[]; policies: { version: string; thresholds: (import("@agir/contracts").Threshold & { workspace: ThresholdNote | null; deal: ThresholdNote | null; value: number; layer: string | null; looser: boolean; stressRemoved: boolean })[] }[] };
