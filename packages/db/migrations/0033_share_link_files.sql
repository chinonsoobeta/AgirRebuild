-- Card R2: a share link opens a run and a set of that run's files, not a single file.
-- Existing links keep working: each gets its run and its one file below. Secrets stay unstored: only hashes, as in 0017.
alter table share_links add column run_id uuid references runs(id) on delete cascade;
update share_links l set run_id = a.run_id from artifacts a where a.id = l.artifact_id;
alter table share_links alter column run_id set not null;
alter table share_links alter column artifact_id drop not null;
comment on column share_links.artifact_id is 'Kept only for links made before 0033, which shared one file. A link''s files are in share_link_files.';

create table share_link_files (
  link_id uuid not null references share_links(id) on delete cascade,
  artifact_id uuid not null references artifacts(id) on delete cascade,
  primary key (link_id, artifact_id)
);
insert into share_link_files (link_id, artifact_id) select id, artifact_id from share_links where artifact_id is not null;
alter table share_link_files enable row level security;
-- The same staff-only read as share_links (0018).
create policy member_read on share_link_files for select to agir_app
  using (exists (select 1 from share_links l where l.id = link_id and agir_is_staff(l.workspace_id)));
grant select on share_link_files to agir_app;

-- The single-file route keeps its checks; it now also records the link's run and its one file.
create or replace function fn_create_share_link(p_artifact uuid, p_term text, p_token_hash text) returns uuid
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
  insert into share_links (workspace_id, deal_id, run_id, artifact_id, token_hash, term, expires_at, created_by)
    values (a.workspace_id, a.deal_id, a.run_id, a.id, p_token_hash, p_term, v_expires, agir_uid()) returning id into v_id;
  insert into share_link_files (link_id, artifact_id) values (v_id, a.id);
  perform agir_audit(a.workspace_id, a.deal_id, 'share.created', 'share_link', v_id::text,
    jsonb_build_object('artifact_id', a.id, 'run_id', a.run_id, 'kind', a.kind, 'format', a.format, 'term', p_term, 'expires_at', v_expires));
  return v_id;
end $$;

-- A link to 1 to 20 ready files of one run. Any staff member who can see the run may make one; a client cannot.
create function fn_create_run_share_link(p_run uuid, p_artifacts uuid[], p_term text, p_token_hash text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r runs; v_id uuid; v_expires timestamptz; v_files uuid[];
begin
  select * into r from runs where id = p_run;
  if r.id is null then raise exception 'Run not found' using errcode = 'P0002'; end if;
  perform agir_require(r.workspace_id, 'viewer');
  v_files := coalesce(p_artifacts, '{}');
  if cardinality(v_files) < 1 or cardinality(v_files) > 20 then
    raise exception 'Choose between 1 and 20 files to share.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_files) x where x is null)
     or (select count(distinct x) from unnest(v_files) x) <> cardinality(v_files) then
    raise exception 'Choose each file once.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_files) x where not exists (select 1 from artifacts a where a.id = x and a.run_id = r.id)) then
    raise exception 'Every file shared must come from this run.' using errcode = '22023';
  end if;
  if exists (select 1 from artifacts a where a.id = any(v_files) and a.status <> 'ready') then
    raise exception 'Only a finished report can be shared.' using errcode = '22023';
  end if;
  if p_term is null or p_term not in ('24h', '7d', '30d', 'none') then
    raise exception 'Choose 24 hours, 7 days, 30 days or no expiry.' using errcode = '22023';
  end if;
  v_expires := case p_term when '24h' then now() + interval '1 day' when '7d' then now() + interval '7 days'
    when '30d' then now() + interval '30 days' else null end;
  insert into share_links (workspace_id, deal_id, run_id, artifact_id, token_hash, term, expires_at, created_by)
    values (r.workspace_id, r.deal_id, r.id, null, p_token_hash, p_term, v_expires, agir_uid()) returning id into v_id;
  insert into share_link_files (link_id, artifact_id) select v_id, x from unnest(v_files) x;
  perform agir_audit(r.workspace_id, r.deal_id, 'share.created', 'share_link', v_id::text,
    jsonb_build_object('run_id', r.id, 'artifact_ids', to_jsonb(v_files), 'term', p_term, 'expires_at', v_expires));
  return v_id;
end $$;

-- One row per file the request may serve. A link opens only while it is not revoked or expired, every file is
-- still ready and its maker is still a member. 'file' serves p_artifact, which must be one of the link's files;
-- without it, the link's file when it has exactly one (the old address), and nothing otherwise.
-- 'audit_package' answers one row. Each call that opens writes one share.opened event.
drop function fn_open_share_link(text, text);
create function fn_open_share_link(p_token_hash text, p_what text, p_artifact uuid default null)
returns table (link_id uuid, run_id uuid, created_by uuid, run_number int, deal_name text, expires_at timestamptz,
  artifact_id uuid, kind text, format text, lang text, storage_key text, provenance_entries int)
language plpgsql security definer set search_path = public as $$
declare v record; v_count int;
begin
  if p_what is null or p_what not in ('page', 'file', 'audit_package') then
    raise exception 'Unknown shared link request' using errcode = '22023';
  end if;
  select l.id, l.workspace_id, l.deal_id, l.run_id, l.created_by, l.expires_at, r.run_number, d.name as deal_name into v
    from share_links l join runs r on r.id = l.run_id join deals d on d.id = l.deal_id
    where l.token_hash = p_token_hash and l.revoked_at is null and (l.expires_at is null or l.expires_at > now())
      and exists (select 1 from workspace_members m where m.workspace_id = l.workspace_id and m.user_id = l.created_by
        and (m.expires_at is null or m.expires_at > now()))
      and exists (select 1 from share_link_files f where f.link_id = l.id)
      and not exists (select 1 from share_link_files f join artifacts a on a.id = f.artifact_id where f.link_id = l.id and a.status <> 'ready');
  if not found then return; end if;
  if p_what = 'file' then
    if p_artifact is null then
      select count(*) into v_count from share_link_files f where f.link_id = v.id;
      if v_count <> 1 then return; end if;
    elsif not exists (select 1 from share_link_files f where f.link_id = v.id and f.artifact_id = p_artifact) then
      return;
    end if;
  end if;
  perform agir_audit(v.workspace_id, v.deal_id, 'share.opened', 'share_link', v.id::text,
    case when p_what = 'file' and p_artifact is not null then jsonb_build_object('what', p_what, 'artifact_id', p_artifact)
      else jsonb_build_object('what', p_what) end);
  return query select v.id, v.run_id, v.created_by, v.run_number, v.deal_name, v.expires_at,
      a.id, a.kind, a.format, a.lang, a.storage_key, (a.provenance->>'entries')::int
    from share_link_files f join artifacts a on a.id = f.artifact_id
    where f.link_id = v.id and (p_what <> 'file' or p_artifact is null or a.id = p_artifact)
    order by a.created_at, a.id
    limit case when p_what = 'audit_package' then 1 end;
end $$;

revoke execute on function fn_create_run_share_link(uuid, uuid[], text, text), fn_open_share_link(text, text, uuid) from public;
grant execute on function fn_create_run_share_link(uuid, uuid[], text, text) to agir_app;
-- fn_open_share_link is called only by the API service principal, without a user session.
