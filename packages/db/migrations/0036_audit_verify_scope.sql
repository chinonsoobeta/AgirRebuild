-- Card B. The chain check a workspace's members may run. The chain is one chain across every workspace (each row's
-- prev_hash is the row before it, whatever its workspace), so the check still walks every row with
-- fn_verify_audit_chain. What it answers is limited to the caller's workspace: whether the whole chain holds, how many
-- events this workspace has, and whether the first broken row, if any, is one of this workspace's. Never the
-- installation's count or a row's seq. fn_verify_audit_chain stays for the audit package.
create function fn_verify_audit_chain_for(p_workspace uuid) returns table (ok boolean, events bigint, broken boolean)
language plpgsql stable security definer set search_path = public as $$
declare v record;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  -- A workspace that does not exist answers like one the caller is not a member of.
  if not agir_is_member(p_workspace) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
  select * into v from fn_verify_audit_chain();
  return query select v.ok,
    (select count(*) from audit_events where workspace_id = p_workspace),
    coalesce(v.broken_at is not null and exists (select 1 from audit_events where seq = v.broken_at and workspace_id = p_workspace), false);
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_verify_audit_chain_for(uuid) to agir_app;
