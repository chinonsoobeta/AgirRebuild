-- Card Y2: the invitation page says when the link ends. A function's return table cannot be changed with
-- create or replace, so the function is dropped and made again with expires_at added.
drop function fn_peek_client_invite(text);

-- The names an invitation shows before anyone signs in, and when it ends. Called only by the API service principal.
create function fn_peek_client_invite(p_token_hash text) returns table (workspace text, deal text, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select w.name, d.name, i.expires_at from client_invites i join workspaces w on w.id = i.workspace_id join deals d on d.id = i.deal_id
  where i.id = (agir_live_invite(p_token_hash)).id
$$;

-- A new function is executable by everyone until revoked (see 0003_access.sql); agir_app gets no grant.
revoke execute on function fn_peek_client_invite(text) from public;
