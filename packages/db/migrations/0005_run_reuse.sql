-- A run is reused only when it is the deal's latest run and was made from the
-- same approved inputs. 0002 reused any run with the same input hash. When only
-- a status changed (a default approved as it stands), or the inputs changed and
-- then changed back, that gave back a run that no longer matched the approved
-- inputs, and a decision on it was refused until some value changed.
--
-- Two runs may now share an input hash: the same figures, approved at
-- different times. Each is still numbered, signed and append-only.

alter table runs drop constraint runs_deal_id_input_hash_engine_version_policy_hash_key;

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
      input_hash, assumptions_hash, result, result_hash, verdict_code, signature, created_by)
    values (p_deal, v_ws, v_number, p->>'engine_version', p->>'policy_version', p->>'policy_hash', p->'input_snapshot',
      p->>'input_hash', p->>'assumptions_hash', p->'result', p->>'result_hash', p->>'verdict_code', p->>'signature', agir_uid())
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

-- A replaced function keeps its grants; this keeps the rule of 0003_access.sql explicit.
revoke execute on all functions in schema public from public;
grant execute on function fn_persist_run(uuid, jsonb) to agir_app;
