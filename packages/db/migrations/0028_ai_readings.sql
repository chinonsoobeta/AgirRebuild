-- Store the exact header-free request, response and code verification for replay.
create table ai_readings (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  model text not null,
  prompt_version text not null,
  documents_hash text not null,
  request jsonb not null,
  response jsonb,
  outcome text not null check (outcome in ('ok', 'failed')),
  error jsonb,
  verification jsonb,
  created_at timestamptz not null default now(),
  unique (deal_id, model, prompt_version, documents_hash)
);
alter table ai_readings enable row level security;
create policy staff_read on ai_readings for select to agir_app using (agir_is_staff(workspace_id));
grant select on ai_readings to agir_app;
