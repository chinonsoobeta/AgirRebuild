-- Share secrets are never stored: only their SHA-256 hashes reach this table.
create table share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  artifact_id uuid not null references artifacts(id) on delete cascade,
  token_hash text not null unique,
  term text not null check (term in ('24h', '7d', '30d', 'none')),
  expires_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references users(id),
  check ((term = 'none' and expires_at is null) or (term <> 'none' and expires_at is not null))
);
create index share_links_deal on share_links(deal_id);
alter table share_links enable row level security;
create policy member_read on share_links for select to agir_app using (agir_is_member(workspace_id));
grant select on share_links to agir_app;

create function fn_create_share_link(p_artifact uuid, p_term text, p_token_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare a artifacts; v_id uuid; v_expires timestamptz;
begin
  select * into a from artifacts where id = p_artifact;
  if a.id is null then raise exception 'Report not found' using errcode = 'P0002'; end if;
  perform agir_require(a.workspace_id, 'viewer');
  if a.status <> 'ready' then raise exception 'Only a finished report can be shared.' using errcode = '22023'; end if;
  if p_term is null or p_term not in ('24h', '7d', '30d', 'none') then
    raise exception 'Choose 24 hours, 7 days, 30 days or no expiry.' using errcode = '22023';
  end if;
  v_expires := case p_term when '24h' then now() + interval '1 day' when '7d' then now() + interval '7 days'
    when '30d' then now() + interval '30 days' else null end;
  insert into share_links (workspace_id, deal_id, artifact_id, token_hash, term, expires_at, created_by)
    values (a.workspace_id, a.deal_id, a.id, p_token_hash, p_term, v_expires, agir_uid()) returning id into v_id;
  perform agir_audit(a.workspace_id, a.deal_id, 'share.created', 'share_link', v_id::text,
    jsonb_build_object('artifact_id', a.id, 'run_id', a.run_id, 'kind', a.kind, 'format', a.format, 'term', p_term, 'expires_at', v_expires));
  return v_id;
end $$;

create function fn_revoke_share_link(p_link uuid) returns void
language plpgsql security definer set search_path = public as $$
declare l share_links;
begin
  select * into l from share_links where id = p_link for update;
  if l.id is null then raise exception 'Shared link not found' using errcode = 'P0002'; end if;
  perform agir_require(l.workspace_id, 'viewer');
  if l.revoked_at is not null then raise exception 'This link is already revoked.' using errcode = '22023'; end if;
  update share_links set revoked_at = now(), revoked_by = agir_uid() where id = l.id;
  perform agir_audit(l.workspace_id, l.deal_id, 'share.revoked', 'share_link', l.id::text, jsonb_build_object('artifact_id', l.artifact_id));
end $$;

create function fn_open_share_link(p_token_hash text, p_what text)
returns table (link_id uuid, artifact_id uuid, run_id uuid, created_by uuid, kind text, format text,
  storage_key text, run_number int, deal_name text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if p_what is null or p_what not in ('page', 'file', 'audit_package') then
    raise exception 'Unknown shared link request' using errcode = '22023';
  end if;
  select l.id as link_id, l.workspace_id, l.deal_id, l.artifact_id, a.run_id, l.created_by, a.kind, a.format,
    a.storage_key, r.run_number, d.name as deal_name, l.expires_at into v
    from share_links l join artifacts a on a.id = l.artifact_id join runs r on r.id = a.run_id join deals d on d.id = l.deal_id
    where l.token_hash = p_token_hash and l.revoked_at is null and (l.expires_at is null or l.expires_at > now()) and a.status = 'ready'
      and exists (select 1 from workspace_members m where m.workspace_id = l.workspace_id and m.user_id = l.created_by
        and (m.expires_at is null or m.expires_at > now()));
  if not found then return; end if;
  perform agir_audit(v.workspace_id, v.deal_id, 'share.opened', 'share_link', v.link_id::text, jsonb_build_object('what', p_what));
  return query select v.link_id, v.artifact_id, v.run_id, v.created_by, v.kind, v.format, v.storage_key, v.run_number, v.deal_name, v.expires_at;
end $$;

revoke execute on function fn_create_share_link(uuid, text, text), fn_revoke_share_link(uuid), fn_open_share_link(text, text) from public;
grant execute on function fn_create_share_link(uuid, text, text), fn_revoke_share_link(uuid) to agir_app;
-- fn_open_share_link is called only by the API service principal, without a user session.
