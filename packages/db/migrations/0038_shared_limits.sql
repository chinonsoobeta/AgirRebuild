-- Card D (readiness item 8). Rate limits and run stops shared by every API process. With Postgres the API may run as
-- several processes behind a load balancer: a limit counted in one process's memory would be per process, and a stop
-- could reach a process that is not running the run. Both live here instead. Like sessions, the tables are read and
-- written through these functions by the API's own connection only: row level security is on and agir_app gets no
-- policy and no grant. Nothing here is audited: a request counted or a run stop asked for changes no deal data.

-- One row a key and window. Keys are hashed by the API (an address or an email never lands here in clear).
create table rate_limit_hits (
  key text not null,
  window_start timestamptz not null,
  hits int not null,
  primary key (key, window_start)
);
create index rate_limit_hits_window on rate_limit_hits (window_start);
alter table rate_limit_hits enable row level security;

-- Counts one request for a key in the current fixed window and answers whether it is within the limit. Windows that
-- ended are deleted as it goes, so no scheduler is needed: no window is longer than an hour, so anything that started
-- more than an hour ago has ended.
create function fn_rate_hit(p_key text, p_limit int, p_window interval) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_secs double precision := extract(epoch from p_window);
  v_start timestamptz;
  v_hits int;
begin
  if v_secs <= 0 or p_window > interval '1 hour' then
    raise exception 'A rate limit window is longer than zero and at most an hour' using errcode = '22023';
  end if;
  delete from rate_limit_hits where window_start < now() - interval '1 hour';
  v_start := to_timestamp(floor(extract(epoch from now()) / v_secs) * v_secs);
  insert into rate_limit_hits as r (key, window_start, hits) values (p_key, v_start, 1)
    on conflict (key, window_start) do update set hits = r.hits + 1
    returning r.hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- Streamed runs in progress, by the hash of their run token (card R1). A row is deleted when its run ends; a row older
-- than two hours belongs to a process that went away and counts as no run at all.
create table run_stops (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,
  stop_requested boolean not null default false,
  started_at timestamptz not null default now()
);
alter table run_stops enable row level security;

-- Records a run as started; false when a live run already holds this token.
create function fn_run_start(p_token_hash text, p_user uuid, p_deal uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from run_stops where started_at < now() - interval '2 hours';
  insert into run_stops (token_hash, user_id, deal_id) values (p_token_hash, p_user, p_deal)
    on conflict (token_hash) do nothing;
  return found;
end $$;

create function fn_run_stop_requested(p_token_hash text) returns boolean
language sql security definer set search_path = public as $$
  select coalesce((select stop_requested from run_stops
    where token_hash = p_token_hash and started_at >= now() - interval '2 hours'), false)
$$;

-- Asks a live run to stop; false when no live run holds this token.
create function fn_run_request_stop(p_token_hash text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update run_stops set stop_requested = true
    where token_hash = p_token_hash and started_at >= now() - interval '2 hours';
  return found;
end $$;

create function fn_run_end(p_token_hash text) returns void
language sql security definer set search_path = public as $$
  delete from run_stops where token_hash = p_token_hash
$$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_rate_hit(text, int, interval), fn_run_start(text, uuid, uuid), fn_run_stop_requested(text),
  fn_run_request_stop(text), fn_run_end(text) to agir_app;
