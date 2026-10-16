-- A person working alone is not blocked on day one. In solo review a value that is waiting for a second approver and was
-- entered (or labelled) by the caller can be used as stated: approved, entered by a person, no second approver, which is the
-- derived sponsor-stated label. In team review it is refused. The rest of fn_review is 0010's, including agir_own_label.

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

  elsif p_action = 'use_as_stated' then
    -- A person working alone uses their own waiting value: the end state is what a solo entry ends in.
    if v_team then raise exception 'Only a workspace in solo review can use its own value as stated; here a second person must confirm it' using errcode = '22023'; end if;
    if a.status <> 'awaiting_second_approval' then raise exception 'Only a value waiting for a second approver can be used as stated' using errcode = '22023'; end if;
    if a.decided_by is distinct from agir_uid() then raise exception 'Only the person who entered this value can use it as stated' using errcode = '42501'; end if;
    -- The source is kept: a hand entry is already 'analyst' (sponsor-stated once approved), and a value waiting because the
    -- caller labelled a figure stays a document value with its source, as a solo approval of that label would be (task 59 audit).
    update assumptions set status = 'approved', value = coalesce(pending_value, value), pending_value = null,
      second_approver = null, second_approved_at = null, version = version + 1, updated_at = now() where id = a.id returning * into a;

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

