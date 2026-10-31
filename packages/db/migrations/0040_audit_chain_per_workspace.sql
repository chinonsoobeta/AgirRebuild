-- Card S8 (ADR 0002 section 7): one audit chain per workspace instead of one chain through the whole installation, so
-- a workspace's chain can be checked, and handed over in an audit package, without anyone else's events.
--
-- The recipe. An event's hash is the lowercase hexadecimal SHA-256 of this UTF-8 text, its fields joined by "|":
--
--   prev_hash|workspace_id|action|entity|entity_id|actor|deal_id|payload::text|extract(epoch from created_at)::text
--
-- A missing workspace_id, entity_id, actor or deal_id is the empty string. payload::text is Postgres's text form of the
-- jsonb payload, and the epoch is Postgres's text form of the creation time in seconds. prev_hash is the hash of the
-- event before it IN THE SAME WORKSPACE (seq order), or the word genesis for a workspace's first event. Events with no
-- workspace (an account deleted when it had none left) form one chain of their own. What changed from 0002: prev_hash
-- follows the workspace, and the workspace id is the second field.

-- The one statement of the recipe; the trigger, the checks and the re-hash below all use it.
create function agir_audit_hash(p_prev text, e audit_events) returns text
language sql stable as $$
  select encode(sha256(convert_to(
    p_prev || '|' || coalesce(e.workspace_id::text, '') || '|' || e.action || '|' || e.entity || '|' || coalesce(e.entity_id, '') || '|' ||
    coalesce(e.actor::text, '') || '|' || coalesce(e.deal_id::text, '') || '|' || e.payload::text || '|' ||
    extract(epoch from e.created_at)::text, 'UTF8')), 'hex')
$$;

-- A workspace's last event is found by this index rather than by reading the table.
create index audit_events_workspace_seq on audit_events (workspace_id, seq);

-- The lock is per workspace (7201 as before, with the workspace as the second key), so two workspaces never wait for each
-- other. seq used to come from the column default before the lock was taken, so two events of one workspace could
-- commit in the other order from their seq and a later walk in seq order would report a break that is not one. seq is
-- now taken under the lock: within a workspace, seq order is the order the chain was built in.
alter table audit_events alter column seq drop default;

create or replace function agir_audit_chain() returns trigger
language plpgsql as $$
declare v_prev text;
begin
  perform pg_advisory_xact_lock(7201, hashtext(coalesce(new.workspace_id::text, '')));
  new.seq := nextval(pg_get_serial_sequence('audit_events', 'seq'));
  if new.workspace_id is null then
    select hash into v_prev from audit_events where workspace_id is null order by seq desc limit 1;
  else
    select hash into v_prev from audit_events where workspace_id = new.workspace_id order by seq desc limit 1;
  end if;
  new.prev_hash := coalesce(v_prev, 'genesis');
  new.hash := agir_audit_hash(new.prev_hash, new);
  return new;
end $$;

-- Re-hash every event written before this migration, once, in seq order within its workspace. Only prev_hash and hash
-- change: seq, created_at and every other field stay as they are. The append-only trigger is turned off for this one
-- block and turned on again right after it; the migration runs in one transaction, and the table is locked so that no
-- event is added meanwhile.
lock table audit_events in exclusive mode;
alter table audit_events disable trigger audit_events_append_only;
do $$
declare r audit_events; v_prev text; v_ws uuid; v_started boolean := false;
begin
  for r in select * from audit_events order by workspace_id nulls first, seq loop
    if not v_started or r.workspace_id is distinct from v_ws then
      v_prev := 'genesis';
      v_ws := r.workspace_id;
      v_started := true;
    end if;
    update audit_events set prev_hash = v_prev, hash = agir_audit_hash(v_prev, r) where seq = r.seq returning hash into v_prev;
  end loop;
end $$;
alter table audit_events enable trigger audit_events_append_only;

-- The checks. The installation-wide walk of 0002 is replaced: there is no longer one chain to walk.
drop function fn_verify_audit_chain_for(uuid);
drop function fn_verify_audit_chain();

-- One workspace's chain (null: the events with no workspace), walked in seq order. events counts up to the first break.
-- For operators; members call fn_verify_audit_chain_for.
create function fn_verify_audit_chain(p_workspace uuid) returns table (ok boolean, events bigint, broken_at bigint)
language plpgsql stable security definer set search_path = public as $$
declare r audit_events; v_prev text := 'genesis'; v_count bigint := 0;
begin
  for r in select * from audit_events e
    where e.workspace_id = p_workspace or (p_workspace is null and e.workspace_id is null) order by e.seq loop
    v_count := v_count + 1;
    if r.prev_hash <> v_prev or r.hash <> agir_audit_hash(v_prev, r) then
      return query select false, v_count, r.seq; return;
    end if;
    v_prev := r.hash;
  end loop;
  return query select true, v_count, null::bigint;
end $$;

-- Every workspace's chain, one row each, for operators.
create function fn_verify_audit_chains() returns table (workspace_id uuid, ok boolean, events bigint, broken_at bigint)
language sql stable security definer set search_path = public as $$
  select w.id, v.ok, v.events, v.broken_at
  from (select distinct e.workspace_id as id from audit_events e) w cross join lateral fn_verify_audit_chain(w.id) v
  order by w.id nulls first
$$;

-- The check a workspace's members run (card B, 0036). The chain is now theirs alone, so the answer names the event
-- where it breaks. events is the workspace's count of events.
create function fn_verify_audit_chain_for(p_workspace uuid) returns table (ok boolean, events bigint, broken_at bigint)
language plpgsql stable security definer set search_path = public as $$
declare v record;
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  -- A workspace that does not exist answers like one the caller is not a member of.
  if not agir_is_member(p_workspace) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
  select * into v from fn_verify_audit_chain(p_workspace);
  return query select v.ok, (select count(*) from audit_events e where e.workspace_id = p_workspace), v.broken_at;
end $$;

-- The links of a member's workspace chain, from genesis to its last event, for the audit package: seq and the two
-- hashes only, never an event's contents. A client of one deal reads them too, as it reads the count above.
create function fn_audit_chain_links(p_workspace uuid) returns table (seq bigint, prev_hash text, hash text)
language plpgsql stable security definer set search_path = public as $$
begin
  if agir_uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not agir_is_member(p_workspace) then
    raise exception 'Your role in this workspace does not allow this action' using errcode = '42501';
  end if;
  return query select e.seq, e.prev_hash, e.hash from audit_events e where e.workspace_id = p_workspace order by e.seq;
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_verify_audit_chain_for(uuid), fn_audit_chain_links(uuid) to agir_app;
