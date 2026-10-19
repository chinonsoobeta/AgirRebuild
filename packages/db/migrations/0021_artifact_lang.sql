alter table artifacts add column lang text not null default 'en' check (lang in ('en', 'fr'));
drop function fn_request_artifact(uuid, text, text);

create function fn_request_artifact(p_run uuid, p_kind text, p_format text, p_lang text default 'en') returns uuid
language plpgsql security definer set search_path = public as $$
declare r runs; v_id uuid;
begin
  select * into r from runs where id = p_run;
  if r.id is null then raise exception 'Run not found' using errcode = 'P0002'; end if;
  perform agir_require(r.workspace_id, 'analyst');
  insert into artifacts (deal_id, workspace_id, run_id, kind, format, created_by, lang)
    values (r.deal_id, r.workspace_id, r.id, p_kind, p_format, agir_uid(), p_lang) returning id into v_id;
  insert into jobs (kind, payload) values ('render_artifact', jsonb_build_object('artifact_id', v_id));
  perform agir_audit(r.workspace_id, r.deal_id, 'artifact.requested', 'artifact', v_id::text,
    jsonb_build_object('run_id', r.id, 'kind', p_kind, 'format', p_format, 'lang', p_lang));
  return v_id;
end $$;

revoke execute on function fn_request_artifact(uuid, text, text, text) from public;
grant execute on function fn_request_artifact(uuid, text, text, text) to agir_app;
