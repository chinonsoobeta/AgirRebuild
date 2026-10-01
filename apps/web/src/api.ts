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
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.detail);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body ?? {}),
  upload: <T>(p: string, file: File) => request<T>("PUT", p, undefined, file),
};

// ---- Response shapes ---------------------------------------------------------------
export type Me = { user: { id: string; email: string; name: string }; workspaces: { id: string; name: string; role: "owner" | "admin" | "analyst" | "viewer" }[] };
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
  step: "documents" | "review" | "run" | "decision" | "reports";
  status: { tone: Tone; text: string };
  next: string;
  documents: { total: number; processing: number; failed: number };
  review: { approved: number; needsReview: number; conflicting: number; awaitingSecond: number; missing: number; impossible: number; status: "ready" | "blocked" };
  run: { id: string; number: number; verdict: string; fresh: boolean; createdAt: string } | null;
  decision: { decision: string; created_at: string } | null;
  reports: number;
};
export type DocumentRow = {
  id: string; name: string; kind: string; size_bytes: number; stage: string; stage_detail: string | null; page_count: number | null;
  number_format: string | null; needs_ocr: boolean; candidate_count: number; other_count: number; created_at: string; uploaded_by: string | null;
};
export type Source = { document_id: string; document_name: string; value: number; location: string; raw: string; context: string };
export type Assumption = {
  id: string; fieldKey: string; itemKey: string | null; label: string; group: string; groupLabel: string; unit: string; material: boolean;
  conservative: "max" | "min" | null; status: string; value: number | null; pendingValue: number | null; sourceKind: "document" | "analyst" | "default";
  sources: Source[]; conflictValues: { value: number; documents: string[] }[] | null; reason: string | null; decidedBy: string | null;
  decidedById: string | null; decidedAt: string | null; secondApprover: string | null; version: number;
};
export type ReadinessItem = { fieldKey: string; itemKey?: string; label: string; detail?: string };
export type Review = {
  readiness: { status: "ready" | "blocked"; missing: ReadinessItem[]; conflicting: ReadinessItem[]; pending: ReadinessItem[]; impossible: ReadinessItem[]; defaultable: string[] };
  assumptions: Assumption[];
  missing: (ReadinessItem & { unit: string; material: boolean; default: number | null; help: string | null; groupLabel: string })[];
  other: { document_name: string; raw: string; value: number | null; location: string; context: string; note: string | null }[];
};
export type Metric = { key: string; label: string; unit: string; value: number | null; status: string; reason?: string; formula: string };
export type RunView = {
  id: string; dealId: string; number: number; createdAt: string; createdBy: string | null; engineVersion: string; policyVersion: string;
  inputHash: string; resultHash: string; signed: string; fresh: boolean; staleReasons: string[]; isLatest: boolean;
  result: {
    scenarios: { key: string; label: string; metrics: Metric[] }[];
    verdict: { code: string; headline: string; explanation: string; hardFailReasons: string[]; gates: { key: string; label: string; scenario: string; metricKey: string; threshold: number; unit: string; actual: number | null; status: string }[] };
    checks: { key: string; kind: string; severity: "pass" | "warning" | "error"; message: string }[];
    annual: { year: number; gpr: number; egi: number; opex: number; noi: number; debtService: number; sizingDebtService: number; cashFlow: number }[];
    warnings: { key: string; message: string }[];
  };
  inputs: { fieldKey: string; itemKey: string | null; label: string; value: number; sourceKind: string; source: string }[];
  decisions: { id: string; decision: string; rationale: string; conditions: string | null; override_reason: string | null; created_at: string; decided_by: string }[];
};
export type Artifact = { id: string; kind: string; format: string; status: string; error: string | null; sha256: string | null; created_at: string; run_id: string; run_number: number; provenance_entries: number | null };
export type AuditEvent = { seq: number; action: string; entity: string; entity_id: string | null; payload: any; hash: string; created_at: string; actor: string | null };
