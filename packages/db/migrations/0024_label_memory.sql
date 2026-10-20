-- Card 113. A workspace remembers a person's label by the figure's own label phrase and unit, so the same unnamed label in
-- its next deal arrives in review already proposed, for a person to confirm. A reconcile applies it through the boundary a
-- model's suggestion crosses; nothing approves it. The newest label for a phrase and unit wins; removing the label that is
-- a memory's source forgets it. The broker's working tool: staff read it, a client never does, and only the functions write it.

create table label_memory (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  phrase text not null,
  unit text not null,
  field_key text not null,
  item_key text not null default '',
  source_document_id uuid not null references documents(id) on delete cascade,
  source_figure_id text not null,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  unique (workspace_id, phrase, unit)
);
create index label_memory_source on label_memory(source_document_id, source_figure_id);
alter table label_memory enable row level security;
create policy member_read on label_memory for select to agir_app using (agir_is_staff(workspace_id));
grant select on label_memory to agir_app;

drop function fn_label_figure(uuid, text, text, text);
create function fn_label_figure(p_document uuid, p_figure text, p_field text, p_item text, p_phrase text, p_unit text) returns void
language plpgsql security definer set search_path = public as $$
declare d documents; v_item text := coalesce(trim(p_item), ''); v_unit text := coalesce(p_unit, 'none');
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
  if p_phrase is not null and length(trim(p_phrase)) > 0 then
    insert into label_memory (workspace_id, phrase, unit, field_key, item_key, source_document_id, source_figure_id, created_by)
      values (d.workspace_id, p_phrase, v_unit, p_field, v_item, p_document, p_figure, agir_uid())
      on conflict (workspace_id, phrase, unit) do update
        set field_key = excluded.field_key, item_key = excluded.item_key, source_document_id = excluded.source_document_id,
          source_figure_id = excluded.source_figure_id, created_by = excluded.created_by, created_at = now();
    -- Every other deal of the workspace with a document read may now hold the same label.
    insert into jobs (kind, payload) select 'reconcile_deal', jsonb_build_object('deal_id', x.id) from deals x
      where x.workspace_id = d.workspace_id and x.id <> d.deal_id
        and exists (select 1 from documents y where y.deal_id = x.id and y.retired_at is null and y.stage = 'extracted');
    perform agir_audit(d.workspace_id, d.deal_id, 'label.remembered', 'document', p_document::text,
      jsonb_build_object('phrase', p_phrase, 'unit', v_unit, 'field', p_field, 'item', v_item, 'figure', p_figure));
  end if;
end $$;

create or replace function fn_unlabel_figure(p_document uuid, p_figure text) returns void
language plpgsql security definer set search_path = public as $$
declare d documents; m label_memory; v_forgot boolean := false;
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  delete from figure_labels where document_id = p_document and figure_id = p_figure;
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', d.deal_id));
  perform agir_audit(d.workspace_id, d.deal_id, 'figure.unlabelled', 'document', p_document::text, jsonb_build_object('figure', p_figure));
  for m in delete from label_memory where source_document_id = p_document and source_figure_id = p_figure returning * loop
    v_forgot := true;
    perform agir_audit(d.workspace_id, d.deal_id, 'label.forgotten', 'document', p_document::text,
      jsonb_build_object('phrase', m.phrase, 'unit', m.unit, 'field', m.field_key, 'item', m.item_key, 'figure', p_figure));
  end loop;
  if v_forgot then
    insert into jobs (kind, payload) select 'reconcile_deal', jsonb_build_object('deal_id', x.id) from deals x
      where x.workspace_id = d.workspace_id and x.id <> d.deal_id
        and exists (select 1 from documents y where y.deal_id = x.id and y.retired_at is null and y.stage = 'extracted');
  end if;
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
      'labelled', exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' = 'labelled'),
      'remembered', exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' = 'remembered')));
end $$;

revoke execute on all functions in schema public from public;
grant execute on function fn_label_figure(uuid, text, text, text, text, text), fn_unlabel_figure(uuid, text) to agir_app;
