-- Card 137: retain the reader's region as optional provenance.
alter table candidates add column region jsonb;
