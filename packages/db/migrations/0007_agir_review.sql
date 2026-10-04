-- Agir review: the paid, done-with-you confirmation. A reviewer is a time-limited member who can read the
-- workspace and confirm a sponsor-stated value (second_approve), and do nothing else. An expired membership
-- grants nothing, but the row is kept so a confirmation stays labelled as Agir review.

alter table workspace_members drop constraint workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'analyst', 'viewer', 'reviewer'));
alter table workspace_members add column expires_at timestamptz;

create or replace function agir_role_rank(p_role text) returns int
language sql immutable as $$
  select case p_role when 'owner' then 4 when 'admin' then 3 when 'analyst' then 2 when 'viewer' then 1 when 'reviewer' then 1 else 0 end
$$;

create or replace function agir_is_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = agir_uid()
    and (expires_at is null or expires_at > now()))
$$;

create or replace function agir_require(p_workspace uuid, p_min_role text) returns void
language plpgsql stable security definer set search_path = public as $$
declare v_role text;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select role into v_role from workspace_members where workspace_id = p_workspace and user_id = agir_uid()
    and (expires_at is null or expires_at > now());
  if v_role is null or agir_role_rank(v_role) < agir_role_rank(p_min_role) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
end $$;

create or replace function fn_add_member(p_workspace uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform agir_require(p_workspace, 'admin');
  if p_role = 'owner' then raise exception 'Ownership is not granted by invitation' using errcode = '42501'; end if;
  if p_role = 'reviewer' then raise exception 'A reviewer is added by requesting Agir review' using errcode = '22023'; end if;
  select id into v_user from users where email = lower(p_email);
  if v_user is null then raise exception 'No user with that email has an account' using errcode = 'P0002'; end if;
  if exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = v_user and role = 'reviewer') then
    raise exception 'This person is an Agir reviewer; their access is changed by requesting Agir review' using errcode = '22023';
  end if;
  insert into workspace_members (workspace_id, user_id, role) values (p_workspace, v_user, p_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  perform agir_audit(p_workspace, null, 'member.added', 'workspace_member', v_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function fn_grant_review(p_workspace uuid, p_email text, p_days int) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid; v_expires timestamptz;
begin
  perform agir_require(p_workspace, 'owner');
  if p_days is null or p_days < 1 or p_days > 90 then raise exception 'Review access lasts between 1 and 90 days' using errcode = '22023'; end if;
  select id into v_user from users where email = lower(p_email);
  if v_user is null then raise exception 'No user with that email has an account' using errcode = 'P0002'; end if;
  if exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = v_user and role <> 'reviewer') then
    raise exception 'This person is already a member of the workspace; a reviewer must be someone outside it' using errcode = '22023';
  end if;
  v_expires := now() + make_interval(days => p_days);
  insert into workspace_members (workspace_id, user_id, role, expires_at) values (p_workspace, v_user, 'reviewer', v_expires)
    on conflict (workspace_id, user_id) do update set expires_at = excluded.expires_at;
  perform agir_audit(p_workspace, null, 'review.granted', 'workspace_member', v_user::text,
    jsonb_build_object('user', v_user, 'expires_at', v_expires));
end $$;

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

revoke execute on all functions in schema public from public;
grant execute on function
  agir_uid(), agir_is_member(uuid), fn_create_workspace(text), fn_add_member(uuid, text, text),
  fn_create_deal(uuid, text, text, text, text, text, text), fn_register_document(uuid, text, text, bigint, text, text),
  fn_retire_document(uuid), fn_retry_document(uuid), fn_review(uuid, text, double precision, text, int),
  fn_enter_value(uuid, text, text, double precision, text), fn_accept_defaults(uuid, text[]),
  fn_assumptions_hash(uuid), fn_persist_run(uuid, jsonb),
  fn_record_decision(uuid, text, text, text, text), fn_request_artifact(uuid, text, text), fn_verify_audit_chain(),
  fn_set_review_mode(uuid, text), fn_grant_review(uuid, text, int)
  to agir_app;
