-- A person labels a figure Agir did not use: the field and, for an itemized field, the item. The figure keeps its
-- document, location and context. Labels apply at every reconcile, whatever the label-suggestions switch says, and
-- survive a re-extraction: they are matched again by figure id, and one that no longer matches is dropped in reconcile.

create table figure_labels (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  figure_id text not null,
  field_key text not null,
  item_key text not null default '',
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (document_id, figure_id)
);
create index figure_labels_deal on figure_labels(deal_id);
alter table figure_labels enable row level security;
create policy member_read on figure_labels for select to agir_app using (agir_is_member(workspace_id));
grant select on figure_labels to agir_app;

create or replace function fn_label_figure(p_document uuid, p_figure text, p_field text, p_item text) returns void
language plpgsql security definer set search_path = public as $$
declare d documents; v_item text := coalesce(trim(p_item), '');
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  insert into figure_labels (deal_id, workspace_id, document_id, figure_id, field_key, item_key, created_by)
    values (d.deal_id, d.workspace_id, p_document, p_figure, p_field, v_item, agir_uid())
    on conflict (document_id, figure_id) do update
      set field_key = excluded.field_key, item_key = excluded.item_key, created_by = excluded.created_by, created_at = now();
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', d.deal_id));
  perform agir_audit(d.workspace_id, d.deal_id, 'figure.labelled', 'document', p_document::text,
    jsonb_build_object('field', p_field, 'item', v_item, 'figure', p_figure));
end $$;

create or replace function fn_unlabel_figure(p_document uuid, p_figure text) returns void
language plpgsql security definer set search_path = public as $$
declare d documents;
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  delete from figure_labels where document_id = p_document and figure_id = p_figure;
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', d.deal_id));
  perform agir_audit(d.workspace_id, d.deal_id, 'figure.unlabelled', 'document', p_document::text, jsonb_build_object('figure', p_figure));
end $$;

create or replace function agir_log_assumption(a assumptions, p_action text, p_from_status text, p_from_value double precision, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into assumption_events (assumption_id, deal_id, workspace_id, actor, action, from_status, to_status, from_value, to_value, reason)
    values (a.id, a.deal_id, a.workspace_id, agir_uid(), p_action, p_from_status, a.status, p_from_value, coalesce(a.pending_value, a.value), p_reason);
  perform agir_audit(a.workspace_id, a.deal_id, 'assumption.' || p_action, 'assumption', a.id::text,
    jsonb_build_object('field', a.field_key, 'item', a.item_key, 'from', p_from_status, 'to', a.status,
      'from_value', p_from_value, 'to_value', coalesce(a.pending_value, a.value), 'reason', p_reason,
      'suggested', exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' = 'suggested'),
      'labelled', exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' = 'labelled')));
end $$;

revoke execute on all functions in schema public from public;
grant execute on function fn_label_figure(uuid, text, text, text), fn_unlabel_figure(uuid, text) to agir_app;
