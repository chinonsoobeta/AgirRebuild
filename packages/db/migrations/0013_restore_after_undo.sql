-- When a person's label reopens a settled value, the reopened event records what the value was (card 58b), so that undoing the
-- label can put it back exactly, when the label was the only thing that disagreed. Only a `reopened` event written by the
-- reconcile has it: { status, value, reason, sources, by_label }. The table stays append-only; this adds a column.

alter table assumption_events add column restore_to jsonb;
