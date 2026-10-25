-- People and your account (card Y1): the owner's role is fixed, an admin removes a member, the owner renames the
-- workspace and ends a reviewer's access at once, and a person changes their own name.

-- The 0018 body, plus one check: the owner's own row is never changed through an invitation.
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
  if exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = v_user and role = 'owner') then
    raise exception 'The owner''s role cannot be changed' using errcode = '42501';
  end if;
  if exists (select 1 from workspace_members where workspace_id = p_workspace and user_id = v_user and role = 'reviewer') then
    raise exception 'This person is an Agir reviewer; their access is changed by requesting Agir review' using errcode = '22023';
  end if;
  insert into workspace_members (workspace_id, user_id, role) values (p_workspace, v_user, p_role)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  perform agir_audit(p_workspace, null, 'member.added', 'workspace_member', v_user::text, jsonb_build_object('role', p_role));
end $$;

-- An admin or the owner removes an admin, analyst or viewer. A reviewer's access is ended instead; a client is
-- removed from the deal.
create function fn_remove_member(p_workspace uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_role text;
begin
  perform agir_require(p_workspace, 'admin');
  select role into v_role from workspace_members where workspace_id = p_workspace and user_id = p_user for update;
  if v_role is null then raise exception 'This person is not a member of the workspace' using errcode = 'P0002'; end if;
  if v_role = 'owner' then raise exception 'The owner cannot be removed from the workspace' using errcode = '42501'; end if;
  if v_role = 'reviewer' then raise exception 'This person is an Agir reviewer; end their review access instead' using errcode = '22023'; end if;
  if v_role = 'client' then raise exception 'This person is a client; remove them from the deal instead' using errcode = '22023'; end if;
  delete from workspace_members where workspace_id = p_workspace and user_id = p_user;
  perform agir_audit(p_workspace, null, 'member.removed', 'workspace_member', p_user::text, jsonb_build_object('role', v_role));
end $$;

create function fn_rename_workspace(p_workspace uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_from text; v_to text := btrim(coalesce(p_name, ''));
begin
  perform agir_require(p_workspace, 'owner');
  if length(v_to) < 1 or length(v_to) > 120 then
    raise exception 'A workspace name is between 1 and 120 characters' using errcode = '22023';
  end if;
  select name into v_from from workspaces where id = p_workspace for update;
  update workspaces set name = v_to where id = p_workspace;
  perform agir_audit(p_workspace, null, 'workspace.renamed', 'workspace', p_workspace::text, jsonb_build_object('from', v_from, 'to', v_to));
end $$;

-- The owner ends a reviewer's access now. The row is kept, as an expired grant is, so a confirmation stays
-- labelled as Agir review; fn_grant_review opens access again.
create function fn_end_review(p_workspace uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform agir_require(p_workspace, 'owner');
  update workspace_members set expires_at = now()
    where workspace_id = p_workspace and user_id = p_user and role = 'reviewer' and (expires_at is null or expires_at > now());
  if not found then raise exception 'This person has no review access to end' using errcode = 'P0002'; end if;
  perform agir_audit(p_workspace, null, 'review.ended', 'workspace_member', p_user::text, jsonb_build_object('user', p_user));
end $$;

-- A person changes their own name. The audit event carries no name: the chain cannot be erased later.
create function fn_set_my_name(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text := btrim(coalesce(p_name, '')); v_ws uuid;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if length(v_name) < 1 or length(v_name) > 120 then
    raise exception 'A name is between 1 and 120 characters' using errcode = '22023';
  end if;
  update users set name = v_name where id = agir_uid();
  for v_ws in select workspace_id from workspace_members where user_id = agir_uid()
      and (expires_at is null or expires_at > now()) order by workspace_id loop
    perform agir_audit(v_ws, null, 'user.renamed', 'user', agir_uid()::text, '{}'::jsonb);
  end loop;
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_remove_member(uuid, uuid), fn_rename_workspace(uuid, text), fn_end_review(uuid, uuid),
  fn_set_my_name(text) to agir_app;
