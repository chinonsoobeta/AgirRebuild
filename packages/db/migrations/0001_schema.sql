-- Agir V2 schema. Run-scoped tables only; "latest" is a view. Every status
-- column is closed by a CHECK that mirrors @agir/contracts.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and position('@' in email) > 1),
  name text not null check (length(name) between 1 and 120),
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now()
);

create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'analyst', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- The field catalog, seeded from @agir/contracts on every migrate so the
-- database enforces the same bounds and dual-control rule as the code.
create table field_catalog (
  key text primary key,
  label text not null,
  unit text not null,
  itemized boolean not null,
  material boolean not null,
  min_value double precision,
  max_value double precision,
  is_integer boolean not null default false,
  default_value double precision
);

create table deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null check (length(name) between 1 and 160),
  asset_type text not null default 'Multifamily',
  location text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index deals_workspace on deals(workspace_id);

create table documents (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('pdf', 'xlsx', 'csv', 'docx', 'txt')),
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  storage_key text not null,
  stage text not null default 'uploaded'
    check (stage in ('uploaded', 'checking', 'rejected', 'reading', 'read_failed', 'extracting', 'extracted')),
  stage_detail text,
  page_count int,
  number_format text,
  needs_ocr boolean not null default false,
  candidate_count int not null default 0,
  retired_at timestamptz,
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index documents_deal on documents(deal_id);
-- The same bytes cannot be live twice in one deal: a duplicate upload attaches to the original.
create unique index documents_live_hash on documents(deal_id, sha256) where retired_at is null;

create table jobs (
  id bigserial primary key,
  kind text not null check (kind in ('verify_document', 'extract_document', 'reconcile_deal', 'render_artifact')),
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready on jobs(status, run_after);

create table candidates (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  field_key text references field_catalog(key),
  item_key text,
  value double precision,
  raw text not null,
  unit_seen text,
  location text not null,
  context text not null,
  rule text not null,
  note text,
  created_at timestamptz not null default now()
);
create index candidates_deal on candidates(deal_id);

create table assumptions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  field_key text not null references field_catalog(key),
  item_key text not null default '',
  status text not null
    check (status in ('needs_review', 'conflicting', 'approved', 'awaiting_second_approval', 'default_accepted', 'rejected')),
  value double precision,
  source_kind text not null check (source_kind in ('document', 'analyst', 'default')),
  sources jsonb not null default '[]',
  conflict_values jsonb,
  pending_value double precision,
  reason text,
  decided_by uuid references users(id),
  decided_at timestamptz,
  second_approver uuid references users(id),
  second_approved_at timestamptz,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (deal_id, field_key, item_key),
  check (status not in ('approved', 'default_accepted') or value is not null),
  check (status <> 'conflicting' or conflict_values is not null),
  check (status <> 'awaiting_second_approval' or pending_value is not null)
);

create table assumption_events (
  id bigserial primary key,
  assumption_id uuid not null references assumptions(id) on delete cascade,
  deal_id uuid not null,
  workspace_id uuid not null,
  actor uuid references users(id),
  action text not null,
  from_status text,
  to_status text not null,
  from_value double precision,
  to_value double precision,
  reason text,
  created_at timestamptz not null default now()
);

create table runs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_number int not null,
  engine_version text not null,
  policy_version text not null,
  policy_hash text not null,
  input_snapshot jsonb not null,
  input_hash text not null,
  assumptions_hash text not null,
  result jsonb not null,
  result_hash text not null,
  verdict_code text not null check (verdict_code in ('APPROVE', 'APPROVE_WITH_CONDITIONS', 'REJECT', 'NOT_EVALUATED')),
  signature text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (deal_id, run_number),
  unique (deal_id, input_hash, engine_version, policy_hash)
);

create table run_metrics (
  run_id uuid not null references runs(id) on delete cascade,
  scenario text not null,
  metric_key text not null,
  value double precision,
  status text not null check (status in ('VALID', 'NOT_APPLICABLE', 'NOT_MEANINGFUL')),
  unit text not null,
  reason text,
  primary key (run_id, scenario, metric_key),
  -- The one invariant that makes "not meaningful" unfakeable from any writer.
  check ((status = 'VALID') = (value is not null))
);

create table run_gates (
  run_id uuid not null references runs(id) on delete cascade,
  gate_key text not null,
  label text not null,
  scenario text not null,
  metric_key text not null,
  threshold double precision not null,
  actual double precision,
  status text not null check (status in ('passed', 'failed', 'not_applicable', 'not_evaluated')),
  primary key (run_id, gate_key)
);

create table run_checks (
  run_id uuid not null references runs(id) on delete cascade,
  check_key text not null,
  kind text not null check (kind in ('agreement', 'bound')),
  severity text not null check (severity in ('pass', 'warning', 'error')),
  message text not null,
  primary key (run_id, check_key)
);

create table decisions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_id uuid not null references runs(id),
  decision text not null check (decision in ('approve', 'approve_with_conditions', 'reject', 'return_to_underwriting')),
  rationale text not null check (length(rationale) >= 10),
  conditions text,
  override_reason text,
  decided_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  run_id uuid not null references runs(id),
  kind text not null check (kind in ('ic_memo', 'lender_package', 'model_export')),
  format text not null check (format in ('pdf', 'docx', 'xlsx', 'html')),
  status text not null default 'queued' check (status in ('queued', 'ready', 'failed', 'blocked')),
  storage_key text,
  sha256 text,
  provenance jsonb,
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_events (
  seq bigserial primary key,
  workspace_id uuid,
  deal_id uuid,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  payload jsonb not null default '{}',
  prev_hash text not null,
  hash text not null,
  created_at timestamptz not null default now()
);

-- The latest run per deal is a view over the run table, never a second copy.
create view latest_runs with (security_invoker = true) as
  select distinct on (deal_id) * from runs order by deal_id, run_number desc;
