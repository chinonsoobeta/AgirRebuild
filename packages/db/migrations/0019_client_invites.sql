-- Card 89b. An invite link makes a person a client of one deal. The secret is never stored, only its SHA-256.
-- A link is for one deal, works once, and lasts seven days.
create table client_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users(id),
  revoked_at timestamptz,
  revoked_by uuid references users(id)
);
create index client_invites_deal on client_invites(deal_id);
alter table client_invites enable row level security;
-- Invitations are managed by the workspace's admins and owners, so only they read them.
create policy member_read on client_invites for select to agir_app using (exists (
  select 1 from workspace_members m where m.workspace_id = client_invites.workspace_id and m.user_id = agir_uid()
    and m.role in ('owner', 'admin') and (m.expires_at is null or m.expires_at > now())));
grant select on client_invites to agir_app;

create function fn_create_client_invite(p_deal uuid, p_token_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_id uuid; v_expires timestamptz := now() + interval '7 days';
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(v_ws, 'admin');
  insert into client_invites (workspace_id, deal_id, token_hash, created_by, expires_at)
    values (v_ws, p_deal, p_token_hash, agir_uid(), v_expires) returning id into v_id;
  perform agir_audit(v_ws, p_deal, 'invite.created', 'client_invite', v_id::text, jsonb_build_object('expires_at', v_expires));
  return v_id;
end $$;

create function fn_revoke_client_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i client_invites;
begin
  select * into i from client_invites where id = p_invite for update;
  if i.id is null then raise exception 'Invitation not found' using errcode = 'P0002'; end if;
  perform agir_require(i.workspace_id, 'admin');
  if i.revoked_at is not null or i.used_at is not null then
    raise exception 'This invitation is already used or revoked.' using errcode = '22023';
  end if;
  update client_invites set revoked_at = now(), revoked_by = agir_uid() where id = i.id;
  perform agir_audit(i.workspace_id, i.deal_id, 'invite.revoked', 'client_invite', i.id::text, '{}'::jsonb);
end $$;

-- A live invitation: not used, not revoked, not expired, and its maker is still an admin or owner of the workspace.
create function agir_live_invite(p_token_hash text) returns client_invites
language sql stable security definer set search_path = public as $$
  select i.* from client_invites i
  where i.token_hash = p_token_hash and i.used_at is null and i.revoked_at is null and i.expires_at > now()
    and exists (select 1 from workspace_members m where m.workspace_id = i.workspace_id and m.user_id = i.created_by
      and m.role in ('owner', 'admin') and (m.expires_at is null or m.expires_at > now()))
$$;

-- The names an invitation shows before anyone signs in. Called only by the API service principal.
create function fn_peek_client_invite(p_token_hash text) returns table (workspace text, deal text)
language sql stable security definer set search_path = public as $$
  select w.name, d.name from client_invites i join workspaces w on w.id = i.workspace_id join deals d on d.id = i.deal_id
  where i.id = (agir_live_invite(p_token_hash)).id
$$;

-- Uses an invitation for p_user: a client member of the workspace, assigned to the deal. Called only by the API
-- service principal, after it signed the person up or found their session. Nothing is returned for a dead link.
create function fn_use_client_invite(p_token_hash text, p_user uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare i client_invites; v_role text;
begin
  select * into i from client_invites where id = (agir_live_invite(p_token_hash)).id for update;
  if i.id is null or i.used_at is not null then return null; end if;
  select role into v_role from workspace_members where workspace_id = i.workspace_id and user_id = p_user;
  if v_role is not null and v_role <> 'client' then
    raise exception 'You are already a member of this workspace.' using errcode = '23505';
  end if;
  if v_role is null then insert into workspace_members (workspace_id, user_id, role) values (i.workspace_id, p_user, 'client'); end if;
  insert into deal_clients (deal_id, user_id, workspace_id, assigned_by) values (i.deal_id, p_user, i.workspace_id, i.created_by) on conflict do nothing;
  update client_invites set used_at = now(), used_by = p_user where id = i.id;
  perform agir_audit(i.workspace_id, i.deal_id, 'invite.used', 'client_invite', i.id::text, jsonb_build_object('user', p_user));
  return i.deal_id;
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_create_client_invite(uuid, text), fn_revoke_client_invite(uuid) to agir_app;
-- fn_peek_client_invite and fn_use_client_invite are called only by the API service principal.
