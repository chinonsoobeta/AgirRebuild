-- Card C. The model boundary (ADR 0002 §5 and §3.3).
-- ai_reading: the owner may turn reading with the model off for a workspace. On by default, as it is today. Off, no
-- deal text is sent and stored readings stop counting, so only the rule reader's values reach review.
-- ai_readings.request held the full text sent to the model; nothing reads it, so it is no longer kept. A stored
-- reading's verification now names the documents it used ({ id, name, sha256 }) and the worker parses them again from
-- the blob store to replay it. Rows written before this keep their parsed documents; the worker accepts both shapes.

alter table workspaces add column ai_reading boolean not null default true;
alter table ai_readings drop column request;

create or replace function fn_set_ai_reading(p_workspace uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform agir_require(p_workspace, 'owner');
  update workspaces set ai_reading = p_on where id = p_workspace;
  -- Stored readings count only while it is on, so every deal is reconciled again.
  insert into jobs (kind, payload) select 'reconcile_deal', jsonb_build_object('deal_id', id) from deals where workspace_id = p_workspace;
  perform agir_audit(p_workspace, null, 'workspace.ai_reading', 'workspace', p_workspace::text, jsonb_build_object('on', p_on));
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_set_ai_reading(uuid, boolean) to agir_app;
