-- Card 155: production counts for pilot deals. Counts, durations, ids and timestamps only: never a value, a label,
-- a field key, a file name or any other text. Documents are counted by the fixed kind and role enums, one column each.
create table deal_metrics (
  deal_id uuid primary key references deals(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  docs_pdf int not null default 0,
  docs_xlsx int not null default 0,
  docs_csv int not null default 0,
  docs_docx int not null default 0,
  docs_txt int not null default 0,
  docs_deal_source int not null default 0,
  docs_evidence int not null default 0,
  docs_context int not null default 0,
  docs_no_candidates int not null default 0,
  figures_read int not null default 0,
  figures_confirmed_from_suggestion int not null default 0,
  figures_typed int not null default 0,
  actions_until_runnable int not null default 0,
  first_upload_at timestamptz,
  first_run_at timestamptz,
  minutes_upload_to_run int,
  updated_at timestamptz not null default now()
);
alter table deal_metrics enable row level security;
create policy staff_read on deal_metrics for select to agir_app using (agir_is_staff(workspace_id));
grant select on deal_metrics to agir_app;

-- Recount one deal from what is already stored. Called by the audit trigger below, so the counts change in the
-- same transaction as the event that changed them.
create or replace function agir_refresh_deal_metrics(p_deal uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_run timestamptz; v_upload timestamptz;
  v_person text[] := array['assumption.approve', 'assumption.second_approve', 'assumption.use_as_stated', 'assumption.modify',
    'assumption.reject', 'assumption.resolve', 'assumption.enter', 'assumption.accept_default', 'figure.labelled'];
begin
  select workspace_id into v_ws from deals where id = p_deal;
  if v_ws is null then return; end if;
  select min(created_at) into v_run from audit_events where deal_id = p_deal and action = 'run.completed';
  select min(created_at) into v_upload from documents where deal_id = p_deal;
  insert into deal_metrics as m (deal_id, workspace_id, docs_pdf, docs_xlsx, docs_csv, docs_docx, docs_txt,
      docs_deal_source, docs_evidence, docs_context, docs_no_candidates, figures_read, figures_confirmed_from_suggestion,
      figures_typed, actions_until_runnable, first_upload_at, first_run_at, minutes_upload_to_run, updated_at)
  select p_deal, v_ws,
    (select count(*) from documents where deal_id = p_deal and kind = 'pdf'),
    (select count(*) from documents where deal_id = p_deal and kind = 'xlsx'),
    (select count(*) from documents where deal_id = p_deal and kind = 'csv'),
    (select count(*) from documents where deal_id = p_deal and kind = 'docx'),
    (select count(*) from documents where deal_id = p_deal and kind = 'txt'),
    (select count(*) from documents where deal_id = p_deal and role_set = 'deal_source'),
    (select count(*) from documents where deal_id = p_deal and role_set = 'evidence'),
    (select count(*) from documents where deal_id = p_deal and role_set = 'context'),
    (select count(*) from documents d where d.deal_id = p_deal and d.retired_at is null and d.stage = 'extracted'
      and not exists (select 1 from candidates c where c.document_id = d.id)),
    coalesce((select (payload->>'proposals')::int from audit_events where deal_id = p_deal and action = 'assumptions.reconciled'
      order by seq desc limit 1), 0),
    (select count(*) from assumptions a where a.deal_id = p_deal and a.status in ('approved', 'awaiting_second_approval')
      and exists (select 1 from jsonb_array_elements(a.sources) e where e->>'rule' in ('suggested', 'remembered', 'ai'))),
    (select count(*) from audit_events where deal_id = p_deal and action = 'assumption.enter'),
    (select count(*) from audit_events where deal_id = p_deal and actor is not null and action = any(v_person)
      and (v_run is null or created_at < v_run)),
    v_upload, v_run,
    case when v_run is not null and v_upload is not null then floor(extract(epoch from v_run - v_upload) / 60)::int end,
    now()
  on conflict (deal_id) do update set
    docs_pdf = excluded.docs_pdf, docs_xlsx = excluded.docs_xlsx, docs_csv = excluded.docs_csv, docs_docx = excluded.docs_docx,
    docs_txt = excluded.docs_txt, docs_deal_source = excluded.docs_deal_source, docs_evidence = excluded.docs_evidence,
    docs_context = excluded.docs_context, docs_no_candidates = excluded.docs_no_candidates, figures_read = excluded.figures_read,
    figures_confirmed_from_suggestion = excluded.figures_confirmed_from_suggestion, figures_typed = excluded.figures_typed,
    actions_until_runnable = excluded.actions_until_runnable, first_upload_at = excluded.first_upload_at,
    first_run_at = excluded.first_run_at, minutes_upload_to_run = excluded.minutes_upload_to_run, updated_at = now();
end $$;

create or replace function agir_deal_metrics_on_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Counts are for learning only: a failure to count never blocks the action being audited.
  if new.deal_id is not null then
    begin perform agir_refresh_deal_metrics(new.deal_id);
    exception when others then raise warning 'deal_metrics not updated for %: %', new.deal_id, sqlerrm;
    end;
  end if;
  return null;
end $$;
create trigger audit_events_deal_metrics after insert on audit_events
  for each row execute function agir_deal_metrics_on_audit();

revoke execute on function agir_refresh_deal_metrics(uuid), agir_deal_metrics_on_audit() from public;
