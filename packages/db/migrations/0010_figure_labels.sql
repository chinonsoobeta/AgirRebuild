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

-- Audit of task 58: a value that only the caller's own label supports is the caller's entry, not the document's. In team review
-- a material one waits for someone else, as a hand entry does; a reader's figure or another person's label for the same value
-- is independent support, and solo review is unchanged.
create or replace function agir_own_label(a assumptions, v double precision) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jsonb_array_elements(a.sources) e where abs((e->>'value')::double precision - v) <= 1e-9 * greatest(1, abs(v)))
    and not exists (select 1 from jsonb_array_elements(a.sources) e where abs((e->>'value')::double precision - v) <= 1e-9 * greatest(1, abs(v))
      and (e->>'rule' is distinct from 'labelled' or e->>'labelled_by' is distinct from agir_uid()::text))
$$;

create or replace function fn_review(
  p_assumption uuid, p_action text, p_value double precision, p_reason text, p_expected_version int
) returns assumptions
language plpgsql security definer set search_path = public as $$
declare a assumptions; v_from_status text; v_from_value double precision; v_material boolean; v_ok boolean; v_team boolean;
begin
  select * into a from assumptions where id = p_assumption for update;
  if a.id is null then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  -- A live reviewer may only confirm; every other action needs an analyst, which a reviewer is not.
  perform agir_require(a.workspace_id, case when p_action = 'second_approve' and exists (
    select 1 from workspace_members where workspace_id = a.workspace_id and user_id = agir_uid()
      and role = 'reviewer' and (expires_at is null or expires_at > now())) then 'viewer' else 'analyst' end);
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'Someone changed this value while you were looking at it. Reload and try again.' using errcode = '40001';
  end if;
  v_from_status := a.status; v_from_value := coalesce(a.pending_value, a.value);
  select material into v_material from field_catalog where key = a.field_key;
  select review_mode = 'team' into v_team from workspaces where id = a.workspace_id;

  if p_action = 'approve' then
    if a.status <> 'needs_review' then raise exception 'Only a value that needs review can be approved' using errcode = '22023'; end if;
    perform agir_check_value(a.field_key, a.value);
    if v_material and v_team and agir_own_label(a, a.value) then
      update assumptions set status = 'awaiting_second_approval', pending_value = a.value, decided_by = agir_uid(), decided_at = now(),
        second_approver = null, second_approved_at = null, reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    else
      update assumptions set status = 'approved', decided_by = agir_uid(), decided_at = now(), reason = p_reason,
        version = version + 1, updated_at = now() where id = a.id returning * into a;
    end if;

  elsif p_action = 'resolve' then
    if a.status <> 'conflicting' then raise exception 'Only a conflicting value can be resolved' using errcode = '22023'; end if;
    select exists (select 1 from jsonb_array_elements(a.conflict_values) e
                   where abs((e->>'value')::double precision - p_value) <= 1e-9 * greatest(1, abs(p_value))) into v_ok;
    if not v_ok then
      raise exception 'A conflict can only be resolved to one of the documented values. Use "enter a different value" to override.' using errcode = '22023';
    end if;
    perform agir_check_value(a.field_key, p_value);
    if v_material and v_team and agir_own_label(a, p_value) then
      update assumptions set status = 'awaiting_second_approval', pending_value = p_value, decided_by = agir_uid(), decided_at = now(),
        second_approver = null, second_approved_at = null, reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    else
      update assumptions set status = 'approved', value = p_value, decided_by = agir_uid(), decided_at = now(),
        reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    end if;

  elsif p_action = 'modify' then
    if p_reason is null or length(trim(p_reason)) < 10 then
      raise exception 'Say why you are entering a different value (at least 10 characters)' using errcode = '22023';
    end if;
    perform agir_check_value(a.field_key, p_value);
    if v_material and v_team then
      update assumptions set status = 'awaiting_second_approval', pending_value = p_value, source_kind = 'analyst',
        decided_by = agir_uid(), decided_at = now(), second_approver = null, second_approved_at = null,
        reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    else
      update assumptions set status = 'approved', value = p_value, pending_value = null, source_kind = 'analyst',
        decided_by = agir_uid(), decided_at = now(), second_approver = null, second_approved_at = null,
        reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    end if;

  elsif p_action = 'second_approve' then
    if a.status <> 'awaiting_second_approval' and not agir_sponsor_stated(a) then
      raise exception 'Nothing is waiting for a second approver' using errcode = '22023';
    end if;
    if a.decided_by = agir_uid() then
      raise exception 'A second approver must be a different person from the one who entered the value' using errcode = '42501';
    end if;
    -- A sponsor-stated value is already approved and keeps its value; it only gains a confirmer.
    update assumptions set status = 'approved', value = coalesce(pending_value, value), pending_value = null,
      second_approver = agir_uid(), second_approved_at = now(), version = version + 1, updated_at = now()
      where id = a.id returning * into a;

  elsif p_action = 'reject' then
    update assumptions set status = 'rejected', pending_value = null, decided_by = agir_uid(), decided_at = now(),
      reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;

  elsif p_action = 'reopen' then
    update assumptions set status = case when conflict_values is not null and jsonb_array_length(conflict_values) > 1 then 'conflicting' else 'needs_review' end,
      pending_value = null, version = version + 1, updated_at = now(),
      source_kind = case when exists (select 1 from jsonb_array_elements(assumptions.sources) e
        where abs((e->>'value')::double precision - assumptions.value) <= 1e-9 * greatest(1, abs(assumptions.value))) then 'document' else source_kind end
      where id = a.id returning * into a;
    if a.status = 'needs_review' and a.value is null then
      update assumptions set status = 'rejected' where id = a.id returning * into a;
    end if;
  else
    raise exception 'Unknown review action %', p_action using errcode = '22023';
  end if;

  perform agir_log_assumption(a, p_action, v_from_status, v_from_value, p_reason);
  return a;
end $$;

revoke execute on all functions in schema public from public;
grant execute on function fn_label_figure(uuid, text, text, text), fn_unlabel_figure(uuid, text) to agir_app;
