-- Card 97b: a published-table value follows the same role and second-approval rules as a hand entry.
alter table assumptions drop constraint assumptions_source_kind_check;
alter table assumptions add constraint assumptions_source_kind_check check (source_kind in ('document','analyst','default','table'));
alter table assumptions add column source_table text;

-- A manual modification/default/document replacement must not retain table provenance.
create function agir_clear_source_table() returns trigger language plpgsql as $$
begin
  if new.source_kind <> 'table' then new.source_table := null; end if;
  return new;
end $$;
create trigger assumptions_source_table before insert or update on assumptions for each row execute function agir_clear_source_table();

create or replace function fn_enter_table_value(p_deal uuid, p_field text, p_item text, p_value double precision, p_reason text, p_source_table text)
returns assumptions language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); a assumptions; v_material boolean; v_team boolean; v_from text; v_from_value double precision;
begin
  perform agir_require(v_ws, 'analyst');
  perform agir_check_value(p_field, p_value);
  if p_source_table is null or not (p_source_table::jsonb ?& array['tableId','optionKey','publisher','title','effective','fields']) then
    raise exception 'Name the published table and option' using errcode = '22023';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'Say where this value comes from (at least 10 characters)' using errcode = '22023';
  end if;
  select material into v_material from field_catalog where key = p_field;
  select review_mode = 'team' into v_team from workspaces where id = v_ws;
  v_material := v_material and v_team;
  select * into a from assumptions where deal_id = p_deal and field_key = p_field and item_key = coalesce(p_item, '') for update;
  if a.id is not null and a.status <> 'rejected' and not (a.source_kind = 'table' and a.status = 'approved') then
    raise exception 'This field already has a value; review it instead' using errcode = '23505';
  end if;
  v_from := a.status; v_from_value := a.value;
  if a.id is null then
    insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, pending_value, source_kind, source_table, reason, decided_by, decided_at)
      values (p_deal, v_ws, p_field, coalesce(p_item, ''),
        case when v_material then 'awaiting_second_approval' else 'approved' end,
        case when v_material then null else p_value end,
        case when v_material then p_value else null end,
        'table', p_source_table, p_reason, agir_uid(), now())
      returning * into a;
  else
    update assumptions set status = case when v_material then 'awaiting_second_approval' else 'approved' end,
      value = case when v_material then value else p_value end,
      pending_value = case when v_material then p_value else null end,
      source_kind = 'table', source_table = p_source_table, reason = p_reason, second_approver = null, second_approved_at = null, decided_by = agir_uid(), decided_at = now(),
      version = version + 1, updated_at = now() where id = a.id returning * into a;
  end if;
  perform agir_log_assumption(a, 'enter', v_from, v_from_value, p_reason);
  return a;
end $$;


-- Copy the table snapshot with its value and approvals.
create or replace function fn_copy_deal(p_deal uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d deals; r documents; a assumptions; n assumptions; v_id uuid; v_doc uuid; v_map jsonb := '{}'; v_text text; v_pair record;
  v_docs int := 0; v_values int := 0; v_labels int := 0;
begin
  select * into d from deals where id = p_deal for update;
  -- A person outside the workspace cannot see the deal, so it is not found for them (a viewer is refused below).
  if d.id is null or not agir_is_member(d.workspace_id) then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  if exists (select 1 from documents where deal_id = p_deal and retired_at is null and stage in ('uploaded', 'checking', 'reading', 'extracting')) then
    raise exception 'Wait until every document is read, then copy the deal.' using errcode = '23505';
  end if;

  insert into deals (workspace_id, name, asset_type, location, currency, country, province, created_by, copied_from)
    values (d.workspace_id, p_name, d.asset_type, d.location, d.currency, d.country, d.province, agir_uid(), d.id)
    returning id into v_id;

  -- Every live document in a final stage. The bytes are shared, not copied.
  for r in select * from documents where deal_id = p_deal and retired_at is null and stage in ('extracted', 'rejected', 'read_failed') order by created_at, id loop
    insert into documents (deal_id, workspace_id, name, kind, size_bytes, sha256, storage_key, stage, stage_detail, page_count, number_format,
        needs_ocr, candidate_count, uploaded_by, created_at, updated_at)
      values (v_id, r.workspace_id, r.name, r.kind, r.size_bytes, r.sha256, r.storage_key, r.stage, r.stage_detail, r.page_count, r.number_format,
        r.needs_ocr, r.candidate_count, r.uploaded_by, r.created_at, r.updated_at)
      returning id into v_doc;
    v_map := v_map || jsonb_build_object(r.id::text, v_doc::text);
    v_docs := v_docs + 1;
    insert into candidates (document_id, deal_id, workspace_id, field_key, item_key, value, raw, unit_seen, location, context, rule, note, created_at)
      select v_doc, v_id, workspace_id, field_key, item_key, value, raw, unit_seen, location, context, rule, note, created_at
      from candidates where document_id = r.id order by created_at, id;
    -- A figure id starts with its document's id.
    insert into figure_labels (deal_id, workspace_id, document_id, figure_id, field_key, item_key, created_by, created_at)
      select v_id, workspace_id, v_doc, replace(figure_id, r.id::text, v_doc::text), field_key, item_key, created_by, created_at
      from figure_labels where document_id = r.id;
    v_labels := v_labels + (select count(*) from figure_labels where document_id = v_doc);
    -- What was sent is kept as it was; only the figure ids in the answer name the copy's document.
    insert into label_suggestions (document_id, deal_id, workspace_id, model, prompt_hash, request, response, stop_reason, outcome, created_at)
      select v_doc, v_id, workspace_id, model, prompt_hash, request, replace(response::text, r.id::text, v_doc::text)::jsonb, stop_reason, outcome, created_at
      from label_suggestions where document_id = r.id and outcome = 'ok';
  end loop;

  -- Every assumption in every status, with its approvals, its sources pointing at the copy's documents.
  for a in select * from assumptions where deal_id = p_deal order by field_key, item_key loop
    v_text := a.sources::text;
    for v_pair in select key, value from jsonb_each_text(v_map) loop
      v_text := replace(v_text, v_pair.key, v_pair.value);
    end loop;
    insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, source_kind, source_table, sources, conflict_values, pending_value, reason,
        decided_by, decided_at, second_approver, second_approved_at)
      values (v_id, a.workspace_id, a.field_key, a.item_key, a.status, a.value, a.source_kind, a.source_table, v_text::jsonb, a.conflict_values, a.pending_value, a.reason,
        a.decided_by, a.decided_at, a.second_approver, a.second_approved_at)
      returning * into n;
    perform agir_log_assumption(n, 'copied', null, null, 'Copied from ' || d.name);
    v_values := v_values + 1;
  end loop;

  -- A reconcile the source still has queued (a document read or retired, a label changed) is the copy's too. On a copy
  -- in exactly its source's state it changes nothing.
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', v_id));

  perform agir_audit(d.workspace_id, p_deal, 'deal.copied', 'deal', p_deal::text, jsonb_build_object('copy', v_id, 'name', p_name));
  perform agir_audit(d.workspace_id, v_id, 'deal.created_as_copy', 'deal', v_id::text,
    jsonb_build_object('source', p_deal, 'name', d.name, 'documents', v_docs, 'values', v_values, 'labels', v_labels));
  return v_id;
end $$;


-- Existing non-table hashes remain unchanged.
create or replace function fn_assumptions_hash(p_deal uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(coalesce((
    select jsonb_agg(jsonb_build_array(field_key, item_key, status, value)
      || case when agir_sponsor_stated(a) then '["sponsor_stated"]'::jsonb else '[]'::jsonb end
      || case when a.source_kind = 'table' then jsonb_build_array('table', a.source_table) else '[]'::jsonb end
      || case when a.client_confirmed_at is not null then '["client_confirmed"]'::jsonb else '[]'::jsonb end order by field_key, item_key)
    from assumptions a where deal_id = p_deal and status in ('approved', 'default_accepted')
  ), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;


revoke execute on all functions in schema public from public;
grant execute on function fn_enter_table_value(uuid,text,text,double precision,text,text) to agir_app;
