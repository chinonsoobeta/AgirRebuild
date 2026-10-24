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

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body ?? {}),
  upload: <T>(p: string, file: File, method: "PUT" | "POST" = "PUT") => request<T>(method, p, undefined, file),
  del: <T>(p: string, body: unknown) => request<T>("DELETE", p, body),
};

// ---- Response shapes ---------------------------------------------------------------
export type Me = { user: { id: string; email: string; name: string }; workspaces: { id: string; name: string; review_mode: "team" | "solo"; label_suggestions: boolean; has_logo: boolean; role: "owner" | "admin" | "analyst" | "viewer" | "reviewer" | "client" }[] };
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
};
export type DocumentRow = {
  id: string; name: string; kind: string; role_set: "deal_source" | "evidence" | "context" | null; read_role: string | null; size_bytes: number; stage: string; stage_detail: string | null; page_count: number | null;
  number_format: string | null; needs_ocr: boolean; candidate_count: number; other_count: number; created_at: string; uploaded_by: string | null;
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
    checks: { key: string; kind: string; severity: "pass" | "warning" | "error"; message: string }[];
    annual: { year: number; gpr: number; egi: number; opex: number; noi: number; debtService: number; sizingDebtService: number; cashFlow: number }[];
    warnings: { key: string; message: string }[];
  };
  inputs: { fieldKey: string; itemKey: string | null; label: string; value: number; sourceKind: string; source: string; tableSource?: import("@agir/contracts").TableSource; sponsorStated: boolean; confirmedBy: string | null; confirmedByReview: boolean; confirmedAt: string | null }[];
  decisions: { id: string; decision: string; rationale: string; conditions: string | null; override_reason: string | null; created_at: string; decided_by: string }[];
  heldPartners?: { lpIrr: number | null; gpIrr: number | null; promote: number; paidLp: number; paidGp: number; paidPromote: number };
};
export type Artifact = { lang: "en" | "fr"; id: string; kind: string; format: string; status: string; error: string | null; sha256: string | null; created_at: string; run_id: string; run_number: number; provenance_entries: number | null };
export type ShareTerm = "24h" | "7d" | "30d" | "none";
export type ShareLink = { id: string; artifact_id: string; kind: string; format: string; run_number: number; term: ShareTerm; expires_at: string | null; created_at: string;
  created_by: string | null; revoked_at: string | null; revoked_by: string | null; openings: number; last_opened_at: string | null };
export type SharedReport = { standardFailures?: { en: string[]; fr: string[] }; deal: string; kind: string; format: string; runNumber: number; expiresAt: string | null };
export type DealClient = { id: string; name: string; email: string; assigned_at: string };
export type ClientInvite = { id: string; created_at: string; expires_at: string; created_by: string | null; used_at: string | null; used_by: string | null; revoked_at: string | null; revoked_by: string | null };
export type InvitePeek = { workspace: string; deal: string };
export type AuditEvent = { seq: number; action: string; entity: string; entity_id: string | null; payload: any; hash: string; created_at: string; actor: string | null };

export type ThresholdNote = import("@agir/contracts").PolicyValue & { setByName: string };
export type ThresholdView = { invalid?: { version: string; path: string; layer: "workspace" | "deal"; value: number; setById: string; setByName: string; setAt: string; reason: string; error: { en: string; fr: string } }[]; policies: { version: string; thresholds: (import("@agir/contracts").Threshold & { workspace: ThresholdNote | null; deal: ThresholdNote | null; value: number; layer: string | null; looser: boolean; stressRemoved: boolean })[] }[] };
