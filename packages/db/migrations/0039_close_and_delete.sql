-- Card F: closing a workspace and deleting an account. The API offers both only when AGIR_ACCOUNT_CLOSURE=1, and
-- purges a closed workspace only when AGIR_RETENTION_DAYS is set: the retention period is the lawyer's to give.
-- This is row deletion and anonymisation, not ADR 0002's crypto-shredding (S5): backups and the audit trail keep
-- what they recorded. The audit trail is hash-chained and is never edited or deleted.

alter table workspaces add column closed_at timestamptz;
alter table users add column deleted_at timestamptz;

-- The one place a closed workspace is refused: every governed function that changes a workspace's data checks the
-- caller's role here first, so adding the check here covers them all, in the database, whoever calls. The role is
-- checked first, so someone outside the workspace learns nothing about it. 55000: the object is not in a state that
-- allows the action. Reading is not refused: membership checks (agir_is_member, agir_is_staff) are unchanged.
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
  if exists (select 1 from workspaces where id = p_workspace and closed_at is not null) then
    raise exception 'This workspace is closed.' using errcode = '55000';
  end if;
end $$;

-- The owner closes the workspace: it becomes read-only at once. Every share link of its deals and every open client
-- invitation ends, and everyone but the owner leaves it, each with its own audit event as the single actions record.
create function fn_close_workspace(p_workspace uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_reason text := btrim(coalesce(p_reason, '')); r record; v_members int := 0; v_links int := 0;
begin
  perform agir_require(p_workspace, 'owner');
  if length(v_reason) < 10 or length(v_reason) > 500 then
    raise exception 'Say why the workspace is closing (10 to 500 characters)' using errcode = '22023';
  end if;
  update workspaces set closed_at = now() where id = p_workspace;
  for r in update share_links set revoked_at = now(), revoked_by = agir_uid()
      where workspace_id = p_workspace and revoked_at is null returning id, deal_id, artifact_id loop
    v_links := v_links + 1;
    perform agir_audit(p_workspace, r.deal_id, 'share.revoked', 'share_link', r.id::text, jsonb_build_object('artifact_id', r.artifact_id));
  end loop;
  for r in update client_invites set revoked_at = now(), revoked_by = agir_uid()
      where workspace_id = p_workspace and revoked_at is null and used_at is null returning id, deal_id loop
    perform agir_audit(p_workspace, r.deal_id, 'invite.revoked', 'client_invite', r.id::text, '{}'::jsonb);
  end loop;
  delete from deal_clients where workspace_id = p_workspace;
  for r in delete from workspace_members where workspace_id = p_workspace and role <> 'owner' returning user_id, role loop
    v_members := v_members + 1;
    perform agir_audit(p_workspace, null, 'member.removed', 'workspace_member', r.user_id::text, jsonb_build_object('role', r.role));
  end loop;
  perform agir_audit(p_workspace, null, 'workspace.closed', 'workspace', p_workspace::text,
    jsonb_build_object('reason', v_reason, 'members_removed', v_members, 'links_ended', v_links));
end $$;

-- runs, run_metrics, run_gates, run_checks, decisions and assumption_events are append-only. The purge below is the
-- one thing allowed to delete them, and only while it runs (agir.purging is set for its transaction). agir_app holds
-- no DELETE on these tables, so setting the flag by hand opens nothing. audit_events is never deleted.
create or replace function agir_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and tg_table_name <> 'audit_events' and current_setting('agir.purging', true) = 'on' then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

-- Deletes every workspace closed longer than p_after ago, by the foreign keys' cascades: workspace_members, deals,
-- documents, candidates, label_suggestions, figure_labels, label_memory, assumptions, assumption_events, runs,
-- run_metrics, run_gates, run_checks, decisions, artifacts, share_links, share_link_files, deal_clients,
-- client_invites, ai_readings and deal_metrics; and the queued jobs that name its documents, deals or artifacts.
-- Audit events stay: they are the record that it existed, and one more says it was purged.
-- Returns the storage keys of its documents, artifacts and logo that no remaining row uses, for the caller to delete
-- the files: storage is content-addressed, so the same bytes can belong to a workspace that is still live.
-- Called by the service principal only.
create function fn_purge_closed_workspaces(p_after interval) returns table (storage_key text)
language plpgsql security definer set search_path = public as $$
declare v_ws uuid[]; v_keys text[]; v_deals text[]; v_docs text[]; v_artifacts text[]; v_id uuid;
begin
  if p_after is null or p_after < interval '1 day' then
    raise exception 'The retention period is at least one day' using errcode = '22023';
  end if;
  select coalesce(array_agg(id), '{}') into v_ws from workspaces where closed_at is not null and closed_at < now() - p_after;
  if cardinality(v_ws) = 0 then return; end if;
  select coalesce(array_agg(distinct k), '{}') into v_keys from (
    select d.storage_key as k from documents d where d.workspace_id = any(v_ws)
    union select a.storage_key from artifacts a where a.workspace_id = any(v_ws) and a.storage_key is not null
    union select w.logo_key from workspaces w where w.id = any(v_ws) and w.logo_key is not null) keys;
  select coalesce(array_agg(id::text), '{}') into v_deals from deals where workspace_id = any(v_ws);
  select coalesce(array_agg(id::text), '{}') into v_docs from documents where workspace_id = any(v_ws);
  select coalesce(array_agg(id::text), '{}') into v_artifacts from artifacts where workspace_id = any(v_ws);
  delete from jobs where payload->>'deal_id' = any(v_deals) or payload->>'document_id' = any(v_docs)
    or payload->>'artifact_id' = any(v_artifacts);
  perform set_config('agir.purging', 'on', true);
  delete from workspaces where id = any(v_ws);
  perform set_config('agir.purging', '', true);
  foreach v_id in array v_ws loop
    perform agir_audit(v_id, null, 'workspace.purged', 'workspace', v_id::text, jsonb_build_object('after', p_after::text));
  end loop;
  return query select k from unnest(v_keys) k
    where not exists (select 1 from documents d where d.storage_key = k)
      and not exists (select 1 from artifacts a where a.storage_key = k)
      and not exists (select 1 from workspaces w where w.logo_key = k);
end $$;

-- The signed-in person deletes their account, once they own no open workspace. Their sessions, memberships, client
-- assignments, open invitations and email links end; the users row stays as a tombstone, because runs, decisions and
-- audit events point at it: no name, an address that cannot receive mail, and no password that can sign in.
-- The audit trail is not edited: events recorded before keep what they recorded.
create function fn_delete_my_account() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := agir_uid(); v_ws uuid; v_any boolean := false;
begin
  if v_uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if exists (select 1 from workspace_members m join workspaces w on w.id = m.workspace_id
             where m.user_id = v_uid and m.role = 'owner' and w.closed_at is null) then
    raise exception 'Close the workspaces you own before deleting your account.' using errcode = '22023';
  end if;
  for v_ws in select workspace_id from workspace_members where user_id = v_uid order by workspace_id loop
    v_any := true;
    perform agir_audit(v_ws, null, 'user.deleted', 'user', v_uid::text, '{}'::jsonb);
  end loop;
  if not v_any then perform agir_audit(null, null, 'user.deleted', 'user', v_uid::text, '{}'::jsonb); end if;
  update client_invites set revoked_at = now(), revoked_by = v_uid where created_by = v_uid and revoked_at is null and used_at is null;
  delete from deal_clients where user_id = v_uid;
  delete from workspace_members where user_id = v_uid;
  delete from sessions where user_id = v_uid;
  delete from email_tokens where user_id = v_uid;
  update users set name = 'Deleted account', email = 'deleted-' || v_uid::text || '@invalid', password_hash = 'deleted',
    email_verified_at = null, deleted_at = now() where id = v_uid;
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_close_workspace(uuid, text), fn_delete_my_account() to agir_app;
-- fn_purge_closed_workspaces is called only by the service principal.
