-- Card 96b: owner thresholds, independent of inputs and of the policy's strategy version.
create function agir_policy_overrides_shape(p_values jsonb) returns boolean
language plpgsql immutable as $$
declare v record; p record;
begin
  if jsonb_typeof(p_values) <> 'object' then return false; end if;
  for v in select * from jsonb_each(p_values) loop
    if v.key = '' or jsonb_typeof(v.value) <> 'object' then return false; end if;
    for p in select * from jsonb_each(v.value) loop
      if p.key = '' or jsonb_typeof(p.value) <> 'object' then return false; end if;
      if not (p.value ?& array['value','setBy','setAt','reason']) then return false; end if;
      if jsonb_typeof(p.value->'value') <> 'number' or jsonb_typeof(p.value->'setBy') <> 'string'
        or jsonb_typeof(p.value->'setAt') <> 'string' or jsonb_typeof(p.value->'reason') <> 'string'
        or length(trim(p.value->>'reason')) = 0 then return false; end if;
    end loop;
  end loop;
  return true;
end $$;

alter table workspaces add column policy_overrides jsonb not null default '{}' check (agir_policy_overrides_shape(policy_overrides));
alter table deals add column policy_overrides jsonb not null default '{}' check (agir_policy_overrides_shape(policy_overrides));

create function fn_set_policy_value(p_scope text, p_id uuid, p_version text, p_path text, p_value numeric, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_all jsonb; v_values jsonb; v_old jsonb;
begin
  if p_scope not in ('workspace','deal') then raise exception 'Unknown threshold scope' using errcode = '22023'; end if;
  v_ws := case when p_scope = 'workspace' then p_id else agir_deal_workspace(p_id) end;
  perform agir_require(v_ws, 'owner');
  if p_reason is null or length(trim(p_reason)) = 0 then raise exception 'Give a reason for the threshold change' using errcode = '22023'; end if;
  if p_version is null or p_version = '' or p_path is null or p_path = '' then raise exception 'Name the policy and path' using errcode = '22023'; end if;
  if p_scope = 'workspace' then select policy_overrides into v_all from workspaces where id = p_id for update;
  else select policy_overrides into v_all from deals where id = p_id for update; end if;
  v_values := coalesce(v_all->p_version, '{}'::jsonb);
  v_old := v_values->p_path->'value';
  if p_value is null then v_values := v_values - p_path;
  else v_values := jsonb_set(v_values, array[p_path], jsonb_build_object('value',p_value,'setBy',agir_uid(),'setAt',now(),'reason',p_reason),true); end if;
  v_all := case when v_values = '{}'::jsonb then v_all - p_version else jsonb_set(v_all,array[p_version],v_values,true) end;
  if p_scope = 'workspace' then update workspaces set policy_overrides = v_all where id = p_id;
  else update deals set policy_overrides = v_all where id = p_id; end if;
  perform agir_audit(v_ws, case when p_scope = 'deal' then p_id else null end, 'policy.threshold_changed', p_scope, p_id::text,
    jsonb_build_object('scope',p_scope,'version',p_version,'path',p_path,'old',v_old,'new',p_value,'reason',p_reason));
end $$;

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

  insert into deals (workspace_id, name, asset_type, location, currency, country, province, created_by, copied_from, policy_overrides)
    values (d.workspace_id, p_name, d.asset_type, d.location, d.currency, d.country, d.province, agir_uid(), d.id, d.policy_overrides)
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

revoke all on function agir_policy_overrides_shape(jsonb) from public;
revoke all on function fn_set_policy_value(text,uuid,text,text,numeric,text) from public;
grant execute on function agir_policy_overrides_shape(jsonb) to agir_app;
grant execute on function fn_set_policy_value(text,uuid,text,text,numeric,text) to agir_app;
