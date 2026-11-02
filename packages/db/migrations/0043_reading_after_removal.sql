create or replace function fn_retire_document(p_document uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d documents;
begin
  select * into d from documents where id = p_document;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  perform agir_require(d.workspace_id, 'analyst');
  update documents set retired_at = now(), updated_at = now() where id = p_document and retired_at is null;
  insert into jobs (kind, payload) values ('reconcile_deal', jsonb_build_object('deal_id', d.deal_id));
  insert into jobs (kind, payload) values ('read_deal', jsonb_build_object('deal_id', d.deal_id::text, 'only_unread', 'true'));
  perform agir_audit(d.workspace_id, d.deal_id, 'document.retired', 'document', p_document::text, jsonb_build_object('name', d.name));
end $$;
