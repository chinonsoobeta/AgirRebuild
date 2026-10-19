-- Add the partner memo kind; fn_request_artifact uses the table's kind check.

alter table artifacts drop constraint artifacts_kind_check;
alter table artifacts add constraint artifacts_kind_check
  check (kind in ('ic_memo', 'lender_package', 'build_decision', 'partner_memo', 'model_export'));
