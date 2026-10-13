-- The build decision report is a third kind of artifact. fn_request_artifact does not check kinds, so only the table's check changes.

alter table artifacts drop constraint artifacts_kind_check;
alter table artifacts add constraint artifacts_kind_check
  check (kind in ('ic_memo', 'lender_package', 'build_decision', 'model_export'));
