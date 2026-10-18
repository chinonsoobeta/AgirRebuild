-- Card 58c. The review page needs to know whether a reconcile for a deal is still to run, so it can show that and refetch when it is done.
-- jobs has no read policy for the app, so this reads it for a member and returns only the answer: it reads kind and status, and nothing else.

create or replace function fn_deal_updating(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null or not agir_is_member(v_ws) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
  return exists (select 1 from jobs where kind = 'reconcile_deal' and status in ('queued', 'running') and payload->>'deal_id' = p_deal::text);
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_deal_updating(uuid) to agir_app;
