-- Card 89a. Clients per deal. A broker's client is a workspace member with the role 'client', which sees only the
-- deals assigned to it and may only confirm a value the broker stated. Its confirmation is recorded beside the
-- value; it is not an independent confirmation, so the value stays sponsor-stated.

alter table workspace_members drop constraint workspace_members_role_check;
alter table workspace_members add constraint workspace_members_role_check
  check (role in ('owner', 'admin', 'analyst', 'viewer', 'reviewer', 'client'));
-- agir_role_rank gives 'client' 0, so agir_require refuses a client every governed action.

create table deal_clients (
  deal_id uuid not null references deals(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  assigned_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (deal_id, user_id)
);
create index deal_clients_user on deal_clients(user_id);

alter table assumptions add column client_confirmed_by uuid references users(id);
alter table assumptions add column client_confirmed_at timestamptz;

-- A live member who is not a client.
create function agir_is_staff(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = agir_uid()
    and role <> 'client' and (expires_at is null or expires_at > now()))
$$;

-- Staff see every deal of their workspace; a client sees the deals assigned to it while it is a member.
create function agir_can_see_deal(p_workspace uuid, p_deal uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select agir_is_staff(p_workspace) or exists (
    select 1 from deal_clients dc join workspace_members m on m.workspace_id = dc.workspace_id and m.user_id = dc.user_id
    where dc.deal_id = p_deal and dc.workspace_id = p_workspace and dc.user_id = agir_uid()
      and m.role = 'client' and (m.expires_at is null or m.expires_at > now()))
$$;

alter table deal_clients enable row level security;
create policy member_read on deal_clients for select to agir_app using (agir_is_staff(workspace_id) or user_id = agir_uid());

drop policy member_read on deals;
create policy member_read on deals for select to agir_app using (agir_can_see_deal(workspace_id, id));
drop policy member_read on documents;
create policy member_read on documents for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on candidates;
create policy member_read on candidates for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on assumptions;
create policy member_read on assumptions for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on assumption_events;
create policy member_read on assumption_events for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on runs;
create policy member_read on runs for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on run_metrics;
create policy member_read on run_metrics for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_can_see_deal(r.workspace_id, r.deal_id)));
drop policy member_read on run_gates;
create policy member_read on run_gates for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_can_see_deal(r.workspace_id, r.deal_id)));
drop policy member_read on run_checks;
create policy member_read on run_checks for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_can_see_deal(r.workspace_id, r.deal_id)));
drop policy member_read on decisions;
create policy member_read on decisions for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on artifacts;
create policy member_read on artifacts for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
drop policy member_read on figure_labels;
create policy member_read on figure_labels for select to agir_app using (agir_can_see_deal(workspace_id, deal_id));
-- Model suggestions and share links are the broker's working tools: staff only.
drop policy member_read on label_suggestions;
create policy member_read on label_suggestions for select to agir_app using (agir_is_staff(workspace_id));
drop policy member_read on share_links;
create policy member_read on share_links for select to agir_app using (agir_is_staff(workspace_id));
-- A client reads the events of its deals, never the workspace's own events.
drop policy member_read on audit_events;
create policy member_read on audit_events for select to agir_app
  using (agir_is_staff(workspace_id) or (deal_id is not null and agir_can_see_deal(workspace_id, deal_id)));
-- A client sees the staff and itself, never another client.
drop policy member_read on workspace_members;
create policy member_read on workspace_members for select to agir_app
  using (agir_is_staff(workspace_id) or (agir_is_member(workspace_id) and (user_id = agir_uid() or role <> 'client')));
drop policy colleague_read on users;
create policy colleague_read on users for select to agir_app using (
  id = agir_uid() or exists (
    select 1 from workspace_members a join workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = agir_uid() and b.user_id = users.id and (a.role <> 'client' or b.role <> 'client')));

grant select on deal_clients to agir_app;

create or replace function fn_add_member(p_workspace uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  perform agir_require(p_workspace, 'admin');
  if p_role = 'owner' then raise exception 'Ownership is not granted by invitation' using errcode = '42501'; end if;
  if p_role = 'reviewer' then raise exception 'A reviewer is added by requesting Agir review' using errcode = '22023'; end if;
  if p_role = 'client' then raise exception 'A client is added to a deal, not to the workspace' using errcode = '22023'; end if;
  select id into v_user from users where email = lower(p_email);
  if v_user is null then raise exception 'No user with that email has an account' using errcode = 'P0002'; end if;
  if exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = v_user and role = 'reviewer') then
    raise exception 'This person is an Agir reviewer; their access is changed by requesting Agir review' using errcode = '22023';
  end if;
  insert into workspace_members (workspace_id, user_id, role) values (p_workspace, v_user, p_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  perform agir_audit(p_workspace, null, 'member.added', 'workspace_member', v_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function fn_deal_updating(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null or not agir_can_see_deal(v_ws, p_deal) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
  return exists (select 1 from jobs where kind = 'reconcile_deal' and status in ('queued', 'running') and payload->>'deal_id' = p_deal::text);
end $$;

-- An existing account becomes a client of one deal (and a client member of the workspace, if it is not one yet).
create function fn_assign_client(p_deal uuid, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_user uuid; v_role text;
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(v_ws, 'admin');
  select id into v_user from users where email = lower(p_email);
  if v_user is null then raise exception 'No user with that email has an account' using errcode = 'P0002'; end if;
  select role into v_role from workspace_members where workspace_id = v_ws and user_id = v_user;
  if v_role is not null and v_role <> 'client' then
    raise exception 'This person is already a member of the workspace' using errcode = '22023';
  end if;
  if v_role is null then insert into workspace_members (workspace_id, user_id, role) values (v_ws, v_user, 'client'); end if;
  insert into deal_clients (deal_id, user_id, workspace_id, assigned_by) values (p_deal, v_user, v_ws, agir_uid()) on conflict do nothing;
  if found then
    perform agir_audit(v_ws, p_deal, 'client.assigned', 'deal_client', v_user::text, jsonb_build_object('user', v_user));
  end if;
end $$;

-- The membership stays, so the client's earlier confirmations keep their label.
create function fn_unassign_client(p_deal uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid;
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null then raise exception 'Deal not found' using errcode = 'P0002'; end if;
  perform agir_require(v_ws, 'admin');
  delete from deal_clients where deal_id = p_deal and user_id = p_user;
  if not found then raise exception 'This person is not a client on this deal' using errcode = 'P0002'; end if;
  perform agir_audit(v_ws, p_deal, 'client.unassigned', 'deal_client', p_user::text, jsonb_build_object('user', p_user));
end $$;

-- A client says a value the broker stated is right. The value stays sponsor-stated: the client is the sponsor.
create function fn_client_confirm(p_assumption uuid, p_expected_version int) returns assumptions
language plpgsql security definer set search_path = public as $$
declare a assumptions; v_from_status text; v_from_value double precision;
begin
  select * into a from assumptions where id = p_assumption for update;
  if a.id is null then raise exception 'Assumption not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from workspace_members where workspace_id = a.workspace_id and user_id = agir_uid() and role = 'client'
                   and (expires_at is null or expires_at > now()))
     or not agir_can_see_deal(a.workspace_id, a.deal_id) then
    raise exception 'Only a client of this deal can confirm a value as the client' using errcode = '42501';
  end if;
  if p_expected_version is not null and a.version <> p_expected_version then
    raise exception 'Someone changed this value while you were looking at it. Reload and try again.' using errcode = '40001';
  end if;
  if not agir_sponsor_stated(a) or a.client_confirmed_at is not null then
    raise exception 'Only a value stated by the broker and not yet confirmed can be confirmed by the client' using errcode = '22023';
  end if;
  v_from_status := a.status; v_from_value := a.value;
  update assumptions set client_confirmed_by = agir_uid(), client_confirmed_at = now(), version = version + 1, updated_at = now()
    where id = a.id returning * into a;
  perform agir_log_assumption(a, 'client_confirm', v_from_status, v_from_value, null);
  return a;
end $$;

-- A confirmation is of a value: when the value, its status or its source changes, the confirmation goes.
create function agir_clear_client_confirmation() returns trigger
language plpgsql as $$
begin
  if (new.value, new.pending_value, new.status, new.source_kind) is distinct from (old.value, old.pending_value, old.status, old.source_kind) then
    new.client_confirmed_by := null;
    new.client_confirmed_at := null;
  end if;
  return new;
end $$;
create trigger assumptions_client_confirmation before update on assumptions
  for each row execute function agir_clear_client_confirmation();

-- A client's confirmation is part of what a run used; a deal without one hashes exactly as before.
create or replace function fn_assumptions_hash(p_deal uuid) returns text
language sql stable security definer set search_path = public as $$
  select encode(sha256(convert_to(coalesce((
    select jsonb_agg(jsonb_build_array(field_key, item_key, status, value)
      || case when agir_sponsor_stated(a) then '["sponsor_stated"]'::jsonb else '[]'::jsonb end
      || case when a.client_confirmed_at is not null then '["client_confirmed"]'::jsonb else '[]'::jsonb end order by field_key, item_key)
    from assumptions a where deal_id = p_deal and status in ('approved', 'default_accepted')
  ), '[]'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function agir_is_staff(uuid), agir_can_see_deal(uuid, uuid), fn_assign_client(uuid, text),
  fn_unassign_client(uuid, uuid), fn_client_confirm(uuid, int) to agir_app;
