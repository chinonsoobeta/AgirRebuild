-- Card 89d. The broker's logo, printed on the lender package only. The API checks the file (PNG or JPEG by its
-- first bytes, at most 500 KB, a readable size) and stores it in the blob store; the workspace keeps the key.

alter table workspaces add column logo_key text;
alter table workspaces add column logo_mime text check (logo_mime in ('image/png', 'image/jpeg'));
alter table workspaces add column logo_width int check (logo_width > 0);
alter table workspaces add column logo_height int check (logo_height > 0);
alter table workspaces add constraint workspaces_logo_complete
  check ((logo_key is null) = (logo_mime is null) and (logo_key is null) = (logo_width is null) and (logo_key is null) = (logo_height is null));

-- The storage key stays out of the audit payload.
create function fn_set_logo(p_workspace uuid, p_key text, p_mime text, p_width int, p_height int) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform agir_require(p_workspace, 'owner');
  update workspaces set logo_key = p_key, logo_mime = p_mime, logo_width = p_width, logo_height = p_height where id = p_workspace;
  perform agir_audit(p_workspace, null, 'logo.set', 'workspace', p_workspace::text,
    jsonb_build_object('mime', p_mime, 'width', p_width, 'height', p_height));
end $$;

create function fn_clear_logo(p_workspace uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform agir_require(p_workspace, 'owner');
  update workspaces set logo_key = null, logo_mime = null, logo_width = null, logo_height = null where id = p_workspace and logo_key is not null;
  if found then
    perform agir_audit(p_workspace, null, 'logo.cleared', 'workspace', p_workspace::text, '{}'::jsonb);
  end if;
end $$;

revoke execute on all functions in schema public from public;
grant execute on function fn_set_logo(uuid, text, text, int, int), fn_clear_logo(uuid) to agir_app;
