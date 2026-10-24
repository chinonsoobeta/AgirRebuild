-- The person's role is separate from the file type and the reader's last role.
alter table documents add column role_set text null check (role_set in ('deal_source', 'evidence', 'context'));
alter table documents add column read_role text null;
alter table runs add column document_roles jsonb not null default '[]';

create or replace function fn_set_document_role(p_document uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare d documents;
begin
  select * into d from documents where id = p_document for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  if p_role is not null and p_role not in ('deal_source', 'evidence', 'context') then
    raise exception 'Invalid document role' using errcode = '22023';
  end if;
  if d.role_set is not distinct from p_role then return; end if;
  if d.stage = 'rejected' then raise exception 'A rejected document cannot be read' using errcode = '22023'; end if;
  -- A document still being uploaded or checked keeps its place in the pipeline: the check runs first, and its extraction will use this role.
  if d.stage in ('uploaded', 'checking') then
    update documents set role_set = p_role, updated_at = now() where id = p_document;
  else
    update documents set role_set = p_role, stage = 'reading', stage_detail = null, updated_at = now() where id = p_document;
    insert into jobs (kind, payload) values ('extract_document', jsonb_build_object('document_id', p_document));
  end if;
  perform agir_audit(d.workspace_id, d.deal_id, 'document.role_set', 'document', p_document::text,
    jsonb_build_object('old', d.role_set, 'new', p_role));
end $$;

-- Keep the existing run reuse and hash contracts; add display provenance only.
create or replace function fn_persist_run(p_deal uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); v_id uuid; v_number int; v_latest runs; m jsonb; g jsonb; c jsonb;
begin
  perform agir_require(v_ws, 'analyst');
  perform pg_advisory_xact_lock(hashtext(p_deal::text));
  -- A run is bound to the inputs approved right now; anything else is refused.
  if p->>'assumptions_hash' is distinct from fn_assumptions_hash(p_deal) then
    raise exception 'The approved inputs changed while the run was being computed. Run it again.' using errcode = '40001';
  end if;
  select * into v_latest from runs where deal_id = p_deal order by run_number desc limit 1;
  if v_latest.id is not null and v_latest.input_hash = p->>'input_hash' and v_latest.assumptions_hash = p->>'assumptions_hash'
     and v_latest.engine_version = p->>'engine_version' and v_latest.policy_hash = p->>'policy_hash' then
    return v_latest.id;
  end if;
  select coalesce(max(run_number), 0) + 1 into v_number from runs where deal_id = p_deal;
  insert into runs (deal_id, workspace_id, run_number, engine_version, policy_version, policy_hash, input_snapshot,
      input_hash, assumptions_hash, result, result_hash, verdict_code, signature, created_by, document_roles)
    values (p_deal, v_ws, v_number, p->>'engine_version', p->>'policy_version', p->>'policy_hash', p->'input_snapshot',
      p->>'input_hash', p->>'assumptions_hash', p->'result', p->>'result_hash', p->>'verdict_code', p->>'signature', agir_uid(),
      (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'role_set', role_set, 'read_role', read_role) order by id), '[]'::jsonb)
       from documents where deal_id = p_deal and retired_at is null))
    returning id into v_id;
  for m in select * from jsonb_array_elements(p->'metrics') loop
    insert into run_metrics (run_id, scenario, metric_key, value, status, unit, reason)
      values (v_id, m->>'scenario', m->>'key', (m->>'value')::double precision, m->>'status', m->>'unit', m->>'reason');
  end loop;
  for g in select * from jsonb_array_elements(p->'gates') loop
    insert into run_gates (run_id, gate_key, label, scenario, metric_key, threshold, actual, status)
      values (v_id, g->>'key', g->>'label', g->>'scenario', g->>'metricKey', (g->>'threshold')::double precision,
        (g->>'actual')::double precision, g->>'status');
  end loop;
  for c in select * from jsonb_array_elements(p->'checks') loop
    insert into run_checks (run_id, check_key, kind, severity, message)
      values (v_id, c->>'key', c->>'kind', c->>'severity', c->>'message');
  end loop;
  perform agir_audit(v_ws, p_deal, 'run.completed', 'run', v_id::text, jsonb_build_object(
    'run_number', v_number, 'verdict', p->>'verdict_code', 'input_hash', p->>'input_hash',
    'result_hash', p->>'result_hash', 'engine_version', p->>'engine_version', 'policy_hash', p->>'policy_hash'));
  return v_id;
end $$;

-- The documents/runs member-read policies and table grants already cover these columns.
revoke execute on function fn_set_document_role(uuid, text) from public;
grant execute on function fn_set_document_role(uuid, text) to agir_app;
