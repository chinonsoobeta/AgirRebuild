-- Where a deal is, and the one currency its figures are in (plan decision 7).
-- Stated when the deal is created and not edited afterwards, so every run and
-- report of a deal agrees on it. Deals created before this migration record
-- none, and their reports say so; nothing is inferred from a location.

alter table deals
  add column currency text check (currency in ('CAD', 'USD')),
  add column country text check (country in ('CA', 'US')),
  add column province text check (province in ('AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT')),
  add constraint deals_province_in_canada check (province is null or country = 'CA');

drop function fn_create_deal(uuid, text, text, text);

create function fn_create_deal(
  p_workspace uuid, p_name text, p_asset_type text, p_location text,
  p_currency text default null, p_country text default null, p_province text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform agir_require(p_workspace, 'analyst');
  insert into deals (workspace_id, name, asset_type, location, currency, country, province, created_by)
    values (p_workspace, p_name, coalesce(p_asset_type, 'Multifamily'), coalesce(p_location, ''), p_currency, p_country, p_province, agir_uid())
    returning id into v_id;
  perform agir_audit(p_workspace, v_id, 'deal.created', 'deal', v_id::text,
    jsonb_build_object('name', p_name, 'currency', p_currency, 'country', p_country, 'province', p_province));
  return v_id;
end $$;

-- A new function is executable by everyone until revoked (see 0003_access.sql).
revoke execute on all functions in schema public from public;
grant execute on function fn_create_deal(uuid, text, text, text, text, text, text) to agir_app;
