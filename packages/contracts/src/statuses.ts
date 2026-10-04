// Every status in the product is declared here once. The UI, the API, the
// database CHECK constraints and the engine all speak this vocabulary.

/** Where an assumption's value came from. */
export const SOURCE_KINDS = ["document", "analyst", "default"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * The review state of one assumption. "Missing" is never stored: a required
 * field with no readable row is missing by definition.
 */
export const ASSUMPTION_STATUSES = [
  "needs_review",
  "conflicting",
  "approved",
  "awaiting_second_approval",
  "default_accepted",
  "rejected",
] as const;
export type AssumptionStatus = (typeof ASSUMPTION_STATUSES)[number];

/** The only statuses the engine may read. */
export const ENGINE_READABLE_STATUSES: readonly AssumptionStatus[] = ["approved", "default_accepted"];

/**
 * A metric is either measured, or it says why it is not. A value that is not
 * VALID is always null; it is never rendered as zero.
 */
export const METRIC_STATUSES = ["VALID", "NOT_APPLICABLE", "NOT_MEANINGFUL"] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const VERDICT_CODES = ["APPROVE", "APPROVE_WITH_CONDITIONS", "REJECT", "NOT_EVALUATED"] as const;
export type VerdictCode = (typeof VERDICT_CODES)[number];

/** `failed` is a breach; `not_evaluated` is an absence. They are never merged. */
export const GATE_STATUSES = ["passed", "failed", "not_applicable", "not_evaluated"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export const CHECK_SEVERITIES = ["pass", "warning", "error"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

export const DOCUMENT_STAGES = [
  "uploaded",
  "checking",
  "rejected",
  "reading",
  "read_failed",
  "extracting",
  "extracted",
] as const;
export type DocumentStage = (typeof DOCUMENT_STAGES)[number];

export const WORKSPACE_ROLES = ["owner", "admin", "analyst", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** team: a material value entered by hand waits for a second person. solo: it is used at once, labelled sponsor-stated. */
export const REVIEW_MODES = ["team", "solo"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const DECISIONS = ["approve", "approve_with_conditions", "reject", "return_to_underwriting"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DEAL_STEPS = ["documents", "review", "run", "decision", "reports"] as const;
export type DealStep = (typeof DEAL_STEPS)[number];
