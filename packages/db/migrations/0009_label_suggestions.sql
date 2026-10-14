-- A model may suggest a label for a figure the reader could not label; a person confirms it. Off unless the
-- owner turns it on. Each call is stored with the exact request, so a reconcile replays the stored answer
-- and never calls the model. The audit of a person's decision marks a value that came from a suggestion.

alter table workspaces add column label_suggestions boolean not null default false;

create table label_suggestions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  model text,
  prompt_hash text not null,
  request jsonb not null,
  response jsonb,
  stop_reason text,
  outcome text not null check (outcome in ('ok', 'refused', 'failed')),
  created_at timestamptz not null default now()
);
create index label_suggestions_document on label_suggestions(document_id);
alter table label_suggestions enable row level security;
create policy member_read on label_suggestions for select to agir_app using (agir_is_member(workspace_id));
grant select on label_suggestions to agir_app;

create or replace function fn_set_label_suggestions(p_workspace uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare v_from boolean;
begin
  perform agir_require(p_workspace, 'owner');
  select label_suggestions into v_from from workspaces where id = p_workspace;
  update workspaces set label_suggestions = p_on where id = p_workspace;
  -- Stored suggestions count only while it is on, so every deal is reconciled again.
  insert into jobs (kind, payload) select 'reconcile_deal', jsonb_build_object('deal_id', id) from deals where workspace_id = p_workspace;
  perform agir_audit(p_workspace, null, 'workspace.label_suggestions_changed', 'workspace', p_workspace::text,
    jsonb_build_object('from', v_from, 'to', p_on));
end $$;

create or replace function agir_log_assumption(a assumptions, p_action text, p_from_status text, p_from_value double precision, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into assumption_events (assumption_id, deal_id, workspace_id, actor, action, from_status, to_status, from_value, to_value, reason)
    values (a.id, a.deal_id, a.workspace_id, agir_uid(), p_action, p_from_status, a.status, p_from_value, coalesce(a.pending_value, a.value), p_reason);
  perform agir_audit(a.workspace_id, a.deal_id, 'assumption.' || p_action, 'assumption', a.id::text,
    jsonb_build_object('field', a.field_key, 'item', a.item_key, 'from', p_from_status, 'to', a.status,
      'from_value', p_from_value, 'to_value', coalesce(a.pending_value, a.value), 'reason', p_reason,
      'suggested', exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' = 'suggested')));
end $$;

revoke execute on all functions in schema public from public;
grant execute on function fn_set_label_suggestions(uuid, boolean) to agir_app;
