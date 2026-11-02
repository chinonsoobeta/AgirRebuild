-- Card 184: a verified reading stays while its document stays, and failed readings can be retried.
alter table jobs drop constraint jobs_kind_check;
alter table jobs add constraint jobs_kind_check check (kind in ('verify_document', 'extract_document', 'reconcile_deal', 'render_artifact', 'read_deal'));

create function agir_documents_hash(p_deal uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to('[' || coalesce(string_agg(
    '[' || to_json(id::text)::text || ',' || to_json(sha256)::text ||
    case when role_set is null then '' else ',' || to_json(role_set)::text end || ']',
    ',' order by id::text collate "C"), '') || ']', 'UTF8')), 'hex')
  from documents where deal_id = p_deal and retired_at is null
$$;

create function agir_reading_held(p_deal uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from jobs where kind = 'reconcile_deal' and status = 'queued'
    and payload->>'deal_id' = p_deal::text and run_after > now())
$$;

create function fn_read_again(p_deal uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null or not agir_is_member(v_ws) then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(v_ws, 'analyst');
  if agir_reading_held(p_deal) or exists (select 1 from documents where deal_id = p_deal and retired_at is null
      and stage in ('uploaded', 'checking', 'reading', 'extracting')) then
    raise exception 'Agir is still reading this deal. Try again when it finishes.' using errcode = '23505';
  end if;
  insert into jobs (kind, payload) values ('read_deal', jsonb_build_object('deal_id', p_deal));
  insert into jobs (kind, payload, run_after) values ('reconcile_deal', jsonb_build_object('deal_id', p_deal), now() + interval '600 seconds');
  perform agir_audit(v_ws, p_deal, 'deal.read_again', 'deal', p_deal::text, '{}'::jsonb);
end $$;

create or replace function fn_copy_deal(p_deal uuid, p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  d deals; r documents; reading ai_readings; a assumptions; n assumptions; v_id uuid; v_doc uuid; v_map jsonb := '{}'; v_text text; v_pair record;
  v_docs int := 0; v_values int := 0; v_labels int := 0;
begin
  select * into d from deals where id = p_deal for update;
  -- A person outside the workspace cannot see the deal, so it is not found for them (a viewer is refused below).
  if d.id is null or not agir_is_member(d.workspace_id) then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  if agir_reading_held(p_deal) or exists (select 1 from documents where deal_id = p_deal and retired_at is null and stage in ('uploaded', 'checking', 'reading', 'extracting')) then
    raise exception 'Wait until every document is read, then copy the deal.' using errcode = '23505';
  end if;

  insert into deals (workspace_id, name, asset_type, location, currency, country, province, created_by, copied_from, policy_overrides)
    values (d.workspace_id, p_name, d.asset_type, d.location, d.currency, d.country, d.province, agir_uid(), d.id, d.policy_overrides)
    returning id into v_id;

  -- Every live document in a final stage. The bytes are shared, not copied.
  for r in select * from documents where deal_id = p_deal and retired_at is null and stage in ('extracted', 'rejected', 'read_failed') order by created_at, id loop
    insert into documents (deal_id, workspace_id, name, kind, size_bytes, sha256, storage_key, stage, stage_detail, page_count, number_format,
        needs_ocr, candidate_count, uploaded_by, created_at, updated_at, role_set, read_role)
      values (v_id, r.workspace_id, r.name, r.kind, r.size_bytes, r.sha256, r.storage_key, r.stage, r.stage_detail, r.page_count, r.number_format,
        r.needs_ocr, r.candidate_count, r.uploaded_by, r.created_at, r.updated_at, r.role_set, r.read_role)
      returning id into v_doc;
    v_map := v_map || jsonb_build_object(r.id::text, v_doc::text);
    v_docs := v_docs + 1;
    insert into candidates (document_id, deal_id, workspace_id, field_key, item_key, value, raw, unit_seen, location, context, rule, note, created_at, alternatives, region)
      select v_doc, v_id, workspace_id, field_key, item_key, value, raw, unit_seen, location, context, rule, note, created_at, alternatives, region
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

  -- Every reading, including failed and historical document sets. Only live document ids have replacements.
  for reading in select * from ai_readings where deal_id = p_deal order by created_at, id loop
    v_text := reading.verification::text;
    for v_pair in select key, value from jsonb_each_text(v_map) loop
      v_text := replace(v_text, v_pair.key, v_pair.value);
    end loop;
    insert into ai_readings (deal_id, workspace_id, model, prompt_version, documents_hash, response, outcome, error, verification, created_at)
      values (v_id, d.workspace_id, reading.model, reading.prompt_version,
        case when reading.documents_hash = agir_documents_hash(p_deal) then agir_documents_hash(v_id) else reading.documents_hash end,
        reading.response, reading.outcome, reading.error, v_text::jsonb, reading.created_at);
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


-- New functions otherwise start executable by everyone; only the retry entry point is public to the app role.
revoke execute on all functions in schema public from public;
grant execute on function fn_read_again(uuid) to agir_app;
