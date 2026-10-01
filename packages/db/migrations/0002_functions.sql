-- Authority lives here. Every state change that carries a rule is one of these
-- SECURITY DEFINER functions: it checks the caller's role, enforces the rule,
-- writes the history and appends the audit event in the same transaction.
-- The application role can read, and can call these; it cannot write a
-- governed table directly.

create or replace function agir_uid() returns uuid
language sql stable as $$
  select nullif(current_setting('agir.user_id', true), '')::uuid
$$;

create or replace function agir_role_rank(p_role text) returns int
language sql immutable as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'analyst' then 2 when 'viewer' then 1 else 0 end
$$;

create or replace function agir_is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = agir_uid())
$$;

create or replace function agir_require(p_workspace uuid, p_min_role text) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select role into v_role from workspace_members where workspace_id = p_workspace and user_id = agir_uid();
  if v_role is null or agir_role_rank(v_role) < agir_role_rank(p_min_role) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
end $$;

create or replace function agir_deal_workspace(p_deal uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from deals where id = p_deal
$$;

-- ---- Audit chain ---------------------------------------------------------------

create or replace function agir_audit_chain() returns trigger
language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(7201);
  select hash into v_prev from audit_events order by seq desc limit 1;
  new.prev_hash := coalesce(v_prev, 'genesis');
  new.hash := encode(sha256(convert_to(
    new.prev_hash || '|' || new.action || '|' || new.entity || '|' || coalesce(new.entity_id, '') || '|' ||
    coalesce(new.actor::text, '') || '|' || coalesce(new.deal_id::text, '') || '|' || new.payload::text || '|' ||
    extract(epoch from new.created_at)::text, 'UTF8')), 'hex');
  return new;
end $$;

create trigger audit_events_chain before insert on audit_events
  for each row execute function agir_audit_chain();

create or replace function agir_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

create trigger audit_events_append_only before update or delete on audit_events
  for each row execute function agir_append_only();
create trigger runs_append_only before update or delete on runs
  for each row execute function agir_append_only();
create trigger run_metrics_append_only before update or delete on run_metrics
  for each row execute function agir_append_only();
create trigger run_gates_append_only before update or delete on run_gates
  for each row execute function agir_append_only();
create trigger run_checks_append_only before update or delete on run_checks
  for each row execute function agir_append_only();
create trigger decisions_append_only before update or delete on decisions
  for each row execute function agir_append_only();
create trigger assumption_events_append_only before update or delete on assumption_events
  for each row execute function agir_append_only();

create or replace function agir_audit(
  p_workspace uuid, p_deal uuid, p_action text, p_entity text, p_entity_id text, p_payload jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into audit_events (workspace_id, deal_id, actor, action, entity, entity_id, payload, prev_hash, hash)
  values (p_workspace, p_deal, agir_uid(), p_action, p_entity, p_entity_id, coalesce(p_payload, '{}'::jsonb), '', '')
$$;

create or replace function fn_verify_audit_chain() returns table (ok boolean, events bigint, broken_at bigint)
language plpgsql stable security definer set search_path = public as $$
declare r record; v_prev text := 'genesis'; v_expected text; v_count bigint := 0;
begin
  for r in select * from audit_events order by seq loop
    v_count := v_count + 1;
    v_expected := encode(sha256(convert_to(
      v_prev || '|' || r.action || '|' || r.entity || '|' || coalesce(r.entity_id, '') || '|' ||
      coalesce(r.actor::text, '') || '|' || coalesce(r.deal_id::text, '') || '|' || r.payload::text || '|' ||
      extract(epoch from r.created_at)::text, 'UTF8')), 'hex');
    if r.prev_hash <> v_prev or r.hash <> v_expected then
      return query select false, v_count, r.seq; return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select true, v_count, null::bigint;
end $$;

-- ---- Workspaces and deals -----------------------------------------------------------

create or replace function fn_create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into workspaces (name) values (p_name) returning id into v_id;
  insert into workspace_members (workspace_id, user_id, role) values (v_id, agir_uid(), 'owner');
  perform agir_audit(v_id, null, 'workspace.created', 'workspace', v_id::text, jsonb_build_object('name', p_name));
  return v_id;
end $$;

create or replace function fn_add_member(p_workspace uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform agir_require(p_workspace, 'admin');
  if p_role = 'owner' then raise exception 'Ownership is not granted by invitation' using errcode = '42501'; end if;
  select id into v_user from users where email = lower(p_email);
  if v_user is null then raise exception 'No user with that email has an account' using errcode = 'P0002'; end if;
  insert into workspace_members (workspace_id, user_id, role) values (p_workspace, v_user, p_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  perform agir_audit(p_workspace, null, 'member.added', 'workspace_member', v_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function fn_create_deal(p_workspace uuid, p_name text, p_asset_type text, p_location text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform agir_require(p_workspace, 'analyst');
  insert into deals (workspace_id, name, asset_type, location, created_by)
    values (p_workspace, p_name, coalesce(p_asset_type, 'Multifamily'), coalesce(p_location, ''), agir_uid())
    returning id into v_id;
  perform agir_audit(p_workspace, v_id, 'deal.created', 'deal', v_id::text, jsonb_build_object('name', p_name));
  return v_id;
end $$;

-- ---- Documents ------------------------------------------------------------------------

create or replace function fn_register_document(
  p_deal uuid, p_name text, p_kind text, p_size bigint, p_sha256 text, p_storage_key text
) returns table (document_id uuid, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); v_id uuid;
begin
  perform agir_require(v_ws, 'analyst');
  select id into v_id from documents where deal_id = p_deal and sha256 = p_sha256 and retired_at is null;
  if v_id is not null then
    perform agir_audit(v_ws, p_deal, 'document.duplicate_ignored', 'document', v_id::text, jsonb_build_object('name', p_name));
    return query select v_id, true; return;
  end if;
  insert into documents (deal_id, workspace_id, name, kind, size_bytes, sha256, storage_key, uploaded_by)
    values (p_deal, v_ws, p_name, p_kind, p_size, p_sha256, p_storage_key, agir_uid())
    returning id into v_id;
  insert into jobs (kind, payload) values ('verify_document', jsonb_build_object('document_id', v_id));
  perform agir_audit(v_ws, p_deal, 'document.uploaded', 'document', v_id::text,
    jsonb_build_object('name', p_name, 'sha256', p_sha256, 'size', p_size));
  return query select v_id, false;
end $$;

create or replace function fn_retire_document(p_document uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d documents;
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  update documents set retired_at = now(), updated_at = now() where id = p_document and retired_at is null;
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', d.deal_id));
  perform agir_audit(d.workspace_id, d.deal_id, 'document.retired', 'document', p_document::text, jsonb_build_object('name', d.name));
end $$;

create or replace function fn_retry_document(p_document uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d documents;
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  if d.stage not in ('read_failed') then raise exception 'Only a document that could not be read can be retried' using errcode = '22023'; end if;
  update documents set stage = 'reading', stage_detail = null, updated_at = now() where id = p_document;
  insert into jobs (kind, payload) values ('extract_document', jsonb_build_object('document_id', p_document));
  perform agir_audit(d.workspace_id, d.deal_id, 'document.retried', 'document', p_document::text, '{}'::jsonb);
end $$;

-- ---- Review ---------------------------------------------------------------------------

create or replace function agir_check_value(p_field text, p_value double precision) returns void
language plpgsql stable security definer set search_path = public as $$
declare f field_catalog;
begin
  select * into f from field_catalog where key = p_field;
  if f.key is null then raise exception 'Unknown field %', p_field using errcode = '22023'; end if;
  if p_value is null or p_value = 'NaN'::double precision or p_value in ('Infinity', '-Infinity') then
    raise exception '% needs a number', f.label using errcode = '22023';
  end if;
  if f.min_value is not null and p_value < f.min_value then raise exception '% cannot be below %', f.label, f.min_value using errcode = '22023'; end if;
  if f.max_value is not null and p_value > f.max_value then raise exception '% cannot be above %', f.label, f.max_value using errcode = '22023'; end if;
  if f.is_integer and p_value <> trunc(p_value) then raise exception '% must be a whole number', f.label using errcode = '22023'; end if;
end $$;

create or replace function agir_log_assumption(a assumptions, p_action text, p_from_status text, p_from_value double precision, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into assumption_events (assumption_id, deal_id, workspace_id, actor, action, from_status, to_status, from_value, to_value, reason)
    values (a.id, a.deal_id, a.workspace_id, agir_uid(), p_action, p_from_status, a.status, p_from_value, coalesce(a.pending_value, a.value), p_reason);
  perform agir_audit(a.workspace_id, a.deal_id, 'assumption.' || p_action, 'assumption', a.id::text,
    jsonb_build_object('field', a.field_key, 'item', a.item_key, 'from', p_from_status, 'to', a.status,
      'from_value', p_from_value, 'to_value', coalesce(a.pending_value, a.value), 'reason', p_reason));
end $$;

-- approve | resolve | modify | second_approve | reject | reopen
create or replace function fn_review(
  p_assumption uuid, p_action text, p_value double precision, p_reason text, p_expected_version int
) returns assumptions
language plpgsql security definer set search_path = public as $$
declare a assumptions; v_from_status text; v_from_value double precision; v_material boolean; v_ok boolean;
begin
  select * into a from assumptions where id = p_assumption for update;
  if a.id is null then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  perform agir_require(a.workspace_id, 'analyst');
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'Someone changed this value while you were looking at it. Reload and try again.' using errcode = '40001';
  end if;
  v_from_status := a.status; v_from_value := coalesce(a.pending_value, a.value);
  select material into v_material from field_catalog where key = a.field_key;

  if p_action = 'approve' then
    if a.status <> 'needs_review' then raise exception 'Only a value that needs review can be approved' using errcode = '22023'; end if;
    perform agir_check_value(a.field_key, a.value);
    update assumptions set status = 'approved', decided_by = agir_uid(), decided_at = now(), reason = p_reason,
      version = version + 1, updated_at = now() where id = a.id returning * into a;

  elsif p_action = 'resolve' then
    if a.status <> 'conflicting' then raise exception 'Only a conflicting value can be resolved' using errcode = '22023'; end if;
    select exists (select 1 from jsonb_array_elements(a.conflict_values) e
                   where abs((e->>'value')::double precision - p_value) <= 1e-9 * greatest(1, abs(p_value))) into v_ok;
    if not v_ok then
      raise exception 'A conflict can only be resolved to one of the documented values. Use "enter a different value" to override.' using errcode = '22023';
    end if;
    perform agir_check_value(a.field_key, p_value);
    update assumptions set status = 'approved', value = p_value, decided_by = agir_uid(), decided_at = now(),
      reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;

  elsif p_action = 'modify' then
    if p_reason is null or length(trim(p_reason)) < 10 then
      raise exception 'Say why you are entering a different value (at least 10 characters)' using errcode = '22023';
    end if;
    perform agir_check_value(a.field_key, p_value);
    if v_material then
      update assumptions set status = 'awaiting_second_approval', pending_value = p_value, source_kind = 'analyst',
        decided_by = agir_uid(), decided_at = now(), second_approver = null, second_approved_at = null,
        reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;
    else
      update assumptions set status = 'approved', value = p_value, pending_value = null, source_kind = 'analyst',
        decided_by = agir_uid(), decided_at = now(), reason = p_reason, version = version + 1, updated_at = now()
        where id = a.id returning * into a;
    end if;

  elsif p_action = 'second_approve' then
    if a.status <> 'awaiting_second_approval' then raise exception 'Nothing is waiting for a second approver' using errcode = '22023'; end if;
    if a.decided_by = agir_uid() then
      raise exception 'A second approver must be a different person from the one who entered the value' using errcode = '42501';
    end if;
    update assumptions set status = 'approved', value = pending_value, pending_value = null,
      second_approver = agir_uid(), second_approved_at = now(), version = version + 1, updated_at = now()
      where id = a.id returning * into a;

  elsif p_action = 'reject' then
    update assumptions set status = 'rejected', pending_value = null, decided_by = agir_uid(), decided_at = now(),
      reason = p_reason, version = version + 1, updated_at = now() where id = a.id returning * into a;

  elsif p_action = 'reopen' then
    update assumptions set status = case when conflict_values is not null and jsonb_array_length(conflict_values) > 1 then 'conflicting' else 'needs_review' end,
      pending_value = null, version = version + 1, updated_at = now() where id = a.id returning * into a;
    if a.status = 'needs_review' and a.value is null then
      update assumptions set status = 'rejected' where id = a.id returning * into a;
    end if;
  else
    raise exception 'Unknown review action %', p_action using errcode = '22023';
  end if;

  perform agir_log_assumption(a, p_action, v_from_status, v_from_value, p_reason);
  return a;
end $$;

-- A value no document states, entered by hand. Material fields wait for a second approver.
create or replace function fn_enter_value(p_deal uuid, p_field text, p_item text, p_value double precision, p_reason text)
returns assumptions language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); a assumptions; v_material boolean; v_from text; v_from_value double precision;
begin
  perform agir_require(v_ws, 'analyst');
  perform agir_check_value(p_field, p_value);
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'Say where this value comes from (at least 10 characters)' using errcode = '22023';
  end if;
  select material into v_material from field_catalog where key = p_field;
  select * into a from assumptions where deal_id = p_deal and field_key = p_field and item_key = coalesce(p_item, '') for update;
  if a.id is not null and a.status not in ('rejected') then
    raise exception 'This field already has a value; review it instead' using errcode = '23505';
  end if;
  v_from := a.status; v_from_value := a.value;
  if a.id is null then
    insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, pending_value, source_kind, reason, decided_by, decided_at)
      values (p_deal, v_ws, p_field, coalesce(p_item, ''),
        case when v_material then 'awaiting_second_approval' else 'approved' end,
        case when v_material then null else p_value end,
        case when v_material then p_value else null end,
        'analyst', p_reason, agir_uid(), now())
      returning * into a;
  else
    update assumptions set status = case when v_material then 'awaiting_second_approval' else 'approved' end,
      value = case when v_material then value else p_value end,
      pending_value = case when v_material then p_value else null end,
      source_kind = 'analyst', reason = p_reason, decided_by = agir_uid(), decided_at = now(),
      version = version + 1, updated_at = now() where id = a.id returning * into a;
  end if;
  perform agir_log_assumption(a, 'enter', v_from, v_from_value, p_reason);
  return a;
end $$;

-- Explicit acceptance of the static defaults for the named missing fields.
create or replace function fn_accept_defaults(p_deal uuid, p_fields text[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); f field_catalog; a assumptions; n int := 0;
begin
  perform agir_require(v_ws, 'analyst');
  for f in select * from field_catalog where key = any(p_fields) loop
    if f.default_value is null then raise exception '% has no default', f.label using errcode = '22023'; end if;
    if exists (select 1 from assumptions where deal_id = p_deal and field_key = f.key and item_key = '' and status <> 'rejected') then
      continue;
    end if;
    insert into assumptions (deal_id, workspace_id, field_key, item_key, status, value, source_kind, reason, decided_by, decided_at)
      values (p_deal, v_ws, f.key, '', 'default_accepted', f.default_value, 'default', 'Default accepted', agir_uid(), now())
      on conflict (deal_id, field_key, item_key) do update set status = 'default_accepted', value = excluded.value,
        source_kind = 'default', reason = excluded.reason, decided_by = excluded.decided_by, decided_at = now(),
        version = assumptions.version + 1, updated_at = now()
      returning * into a;
    perform agir_log_assumption(a, 'accept_default', null, null, 'Default accepted');
    n := n + 1;
  end loop;
  return n;
end $$;

-- The approved inputs of a deal, as the hash a run is bound to.
create or replace function fn_assumptions_hash(p_deal uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(coalesce((
    select jsonb_agg(jsonb_build_array(field_key, item_key, status, value) order by field_key, item_key)
    from assumptions where deal_id = p_deal and status in ('approved', 'default_accepted')
  ), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- ---- Runs ------------------------------------------------------------------------------

create or replace function fn_persist_run(p_deal uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); v_id uuid; v_number int; m jsonb; g jsonb; c jsonb;
begin
  perform agir_require(v_ws, 'analyst');
  perform pg_advisory_xact_lock(hashtext(p_deal::text));
  -- A run is bound to the inputs approved right now; anything else is refused.
  if p->>'assumptions_hash' is distinct from fn_assumptions_hash(p_deal) then
    raise exception 'The approved inputs changed while the run was being computed. Run it again.' using errcode = '40001';
  end if;
  select id into v_id from runs where deal_id = p_deal and input_hash = p->>'input_hash'
    and engine_version = p->>'engine_version' and policy_hash = p->>'policy_hash';
  if v_id is not null then return v_id; end if;
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

-- ---- Decisions ---------------------------------------------------------------------------

create or replace function fn_record_decision(
  p_run uuid, p_decision text, p_rationale text, p_conditions text, p_override_reason text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare r runs; v_latest uuid; v_id uuid; v_against boolean;
begin
  select * into r from runs where id = p_run;
  if r.id is null then raise exception 'Run not found' using errcode = 'P0002'; end if;
  perform agir_require(r.workspace_id, 'admin');
  select id into v_latest from latest_runs where deal_id = r.deal_id;
  if v_latest <> r.id then raise exception 'A newer run exists. Decide on the latest run.' using errcode = '22023'; end if;
  if r.assumptions_hash <> fn_assumptions_hash(r.deal_id) then
    raise exception 'The inputs changed after this run. Run underwriting again before recording a decision.' using errcode = '22023';
  end if;
  if p_decision = 'approve_with_conditions' and (p_conditions is null or length(trim(p_conditions)) < 5) then
    raise exception 'State the conditions' using errcode = '22023';
  end if;
  v_against := p_decision in ('approve', 'approve_with_conditions') and r.verdict_code in ('REJECT', 'NOT_EVALUATED');
  if v_against and (p_override_reason is null or length(trim(p_override_reason)) < 20) then
    raise exception 'Approving against a % verdict needs a written reason (at least 20 characters)', r.verdict_code using errcode = '22023';
  end if;
  insert into decisions (deal_id, workspace_id, run_id, decision, rationale, conditions, override_reason, decided_by)
    values (r.deal_id, r.workspace_id, r.id, p_decision, p_rationale, p_conditions, case when v_against then p_override_reason else null end, agir_uid())
    returning id into v_id;
  perform agir_audit(r.workspace_id, r.deal_id, 'decision.recorded', 'decision', v_id::text, jsonb_build_object(
    'run_id', r.id, 'run_number', r.run_number, 'decision', p_decision, 'verdict', r.verdict_code, 'against_verdict', v_against));
  return v_id;
end $$;

-- ---- Artifacts ----------------------------------------------------------------------------

create or replace function fn_request_artifact(p_run uuid, p_kind text, p_format text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r runs; v_id uuid;
begin
  select * into r from runs where id = p_run;
  if r.id is null then raise exception 'Run not found' using errcode = 'P0002'; end if;
  perform agir_require(r.workspace_id, 'analyst');
  insert into artifacts (deal_id, workspace_id, run_id, kind, format, created_by)
    values (r.deal_id, r.workspace_id, r.id, p_kind, p_format, agir_uid()) returning id into v_id;
  insert into jobs (kind, payload) values ('render_artifact', jsonb_build_object('artifact_id', v_id));
  perform agir_audit(r.workspace_id, r.deal_id, 'artifact.requested', 'artifact', v_id::text,
    jsonb_build_object('run_id', r.id, 'kind', p_kind, 'format', p_format));
  return v_id;
end $$;
