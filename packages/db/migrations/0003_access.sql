-- Access. Signed-in requests run as agir_app with agir.user_id set for the
-- transaction. agir_app may read what its workspaces own and may call the
-- governed functions; it holds no INSERT, UPDATE or DELETE on any table.
-- The worker and the auth endpoints run as the service principal.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agir_app') then
    create role agir_app nologin;
  end if;
end $$;

grant usage on schema public to agir_app;

-- Functions are executable by everyone by default. Take that away, then grant
-- back only the governed API: an internal helper such as agir_audit must never
-- be callable directly, or the audit chain could be written by hand.
revoke execute on all functions in schema public from public;

alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table deals enable row level security;
alter table documents enable row level security;
alter table candidates enable row level security;
alter table assumptions enable row level security;
alter table assumption_events enable row level security;
alter table runs enable row level security;
alter table run_metrics enable row level security;
alter table run_gates enable row level security;
alter table run_checks enable row level security;
alter table decisions enable row level security;
alter table artifacts enable row level security;
alter table audit_events enable row level security;
alter table users enable row level security;
alter table sessions enable row level security;
alter table jobs enable row level security;

create policy member_read on workspaces for select to agir_app using (agir_is_member(id));
create policy member_read on workspace_members for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on deals for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on documents for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on candidates for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on assumptions for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on assumption_events for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on runs for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on run_metrics for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_is_member(r.workspace_id)));
create policy member_read on run_gates for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_is_member(r.workspace_id)));
create policy member_read on run_checks for select to agir_app
  using (exists (select 1 from runs r where r.id = run_id and agir_is_member(r.workspace_id)));
create policy member_read on decisions for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on artifacts for select to agir_app using (agir_is_member(workspace_id));
create policy member_read on audit_events for select to agir_app using (agir_is_member(workspace_id));
-- A member may see the names of the people in their workspaces, never credentials.
create policy colleague_read on users for select to agir_app using (
  id = agir_uid() or exists (
    select 1 from workspace_members a join workspace_members b on a.workspace_id = b.workspace_id
    where a.user_id = agir_uid() and b.user_id = users.id));

grant select on workspaces, workspace_members, deals, documents, candidates, assumptions, assumption_events,
  runs, run_metrics, run_gates, run_checks, decisions, artifacts, audit_events, field_catalog, latest_runs to agir_app;
grant select (id, email, name, created_at) on users to agir_app;

grant execute on function
  agir_uid(), agir_is_member(uuid), fn_create_workspace(text), fn_add_member(uuid, text, text),
  fn_create_deal(uuid, text, text, text), fn_register_document(uuid, text, text, bigint, text, text),
  fn_retire_document(uuid), fn_retry_document(uuid), fn_review(uuid, text, double precision, text, int),
  fn_enter_value(uuid, text, text, double precision, text), fn_accept_defaults(uuid, text[]),
  fn_assumptions_hash(uuid), fn_persist_run(uuid, jsonb),
  fn_record_decision(uuid, text, text, text, text), fn_request_artifact(uuid, text, text), fn_verify_audit_chain()
  to agir_app;
