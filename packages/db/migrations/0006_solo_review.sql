-- Solo mode that keeps the governance. A workspace reviews in 'team' mode (a material value entered by
-- hand waits for a different person) or in 'solo' mode (it is approved at once). A solo value is not
-- hidden: it is sponsor-stated, a fact derived from the row (approved, stated by a person, a material
-- field, no second approver), so no review path can remove the label. It is part of the assumptions
-- hash, so confirming a value makes an earlier run out of date.

alter table workspaces add column review_mode text not null default 'team' check (review_mode in ('team', 'solo'));

create or replace function agir_sponsor_stated(a assumptions) returns boolean
language sql stable security definer set search_path = public as $$
  select a.status = 'approved' and a.source_kind = 'analyst' and a.second_approver is null
    and coalesce((select material from field_catalog where key = a.field_key), false)
$$;

create or replace function fn_set_review_mode(p_workspace uuid, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare a assumptions; v_from text; v_old double precision; v_converted int := 0;
begin
  perform agir_require(p_workspace, 'owner');
  select review_mode into v_from from workspaces where id = p_workspace;
  update workspaces set review_mode = p_mode where id = p_workspace;
  if p_mode = 'team' then
    for a in select * from assumptions x where x.workspace_id = p_workspace and agir_sponsor_stated(x) loop
      v_old := a.value;
      update assumptions set status = 'awaiting_second_approval', pending_value = value, value = null,
        version = version + 1, updated_at = now() where id = a.id returning * into a;
      perform agir_log_assumption(a, 'needs_second_approver', 'approved', v_old, 'The workspace now requires a second approver');
      v_converted := v_converted + 1;
    end loop;
  end if;
  perform agir_audit(p_workspace, null, 'workspace.review_mode_changed', 'workspace', p_workspace::text,
    jsonb_build_object('from', v_from, 'to', p_mode, 'converted', v_converted));
end $$;

create or replace function fn_review(
  p_assumption uuid, p_action text, p_value double precision, p_reason text, p_expected_version int
) returns assumptions
language plpgsql security definer set search_path = public as $$
declare a assumptions; v_from_status text; v_from_value double precision; v_material boolean; v_ok boolean; v_team boolean;
begin
  select * into a from assumptions where id = p_assumption for update;
  if a.id is null then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  perform agir_require(a.workspace_id, 'analyst');
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'Someone changed this value while you were looking at it. Reload and try again.' using errcode = '40001';
  end if;
  v_from_status := a.status; v_from_value := coalesce(a.pending_value, a.value);
  select material into v_material from field_catalog where key = a.field_key;
  select review_mode = 'team' into v_team from workspaces where id = a.workspace_id;

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

-- A value no document states, entered by hand. In team mode a material field waits for a second approver.
create or replace function fn_enter_value(p_deal uuid, p_field text, p_item text, p_value double precision, p_reason text)
returns assumptions language plpgsql security definer set search_path = public as $$
declare v_ws uuid := agir_deal_workspace(p_deal); a assumptions; v_material boolean; v_team boolean; v_from text; v_from_value double precision;
begin
  perform agir_require(v_ws, 'analyst');
  perform agir_check_value(p_field, p_value);
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'Say where this value comes from (at least 10 characters)' using errcode = '22023';
  end if;
  select material into v_material from field_catalog where key = p_field;
  select review_mode = 'team' into v_team from workspaces where id = v_ws;
  v_material := v_material and v_team;
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

-- The approved inputs of a deal, as the hash a run is bound to. A sponsor-stated value is marked in it.
create or replace function fn_assumptions_hash(p_deal uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(coalesce((
    select jsonb_agg(jsonb_build_array(field_key, item_key, status, value)
      || case when agir_sponsor_stated(a) then '["sponsor_stated"]'::jsonb else '[]'::jsonb end order by field_key, item_key)
    from assumptions a where deal_id = p_deal and status in ('approved', 'default_accepted')
  ), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

revoke execute on all functions in schema public from public;
grant execute on function
  fn_set_review_mode(uuid, text), fn_review(uuid, text, double precision, text, int),
  fn_enter_value(uuid, text, text, double precision, text), fn_assumptions_hash(uuid)
  to agir_app;
