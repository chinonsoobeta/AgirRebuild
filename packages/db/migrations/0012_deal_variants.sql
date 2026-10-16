-- A variant is a copy of a deal that a person then changes (card 62). The copy is in exactly the state of its source: the same
-- live documents (new rows over the same stored bytes), their candidates, figure labels and stored model suggestions, and every
-- assumption row with its status, evidence and approvals. Copying never creates an approval; it carries the ones that exist, for
-- the same values from the same evidence. Runs, decisions, reports, history and retired documents stay with the source.

alter table deals add column copied_from uuid references deals(id) on delete set null;

create function fn_copy_deal(p_deal uuid, p_name text) returns uuid
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
    insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, source_kind, sources, conflict_values, pending_value, reason,
        decided_by, decided_at, second_approver, second_approved_at)
      values (v_id, a.workspace_id, a.field_key, a.item_key, a.status, a.value, a.source_kind, v_text::jsonb, a.conflict_values, a.pending_value, a.reason,
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

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_copy_deal(uuid, text) to agir_app;
