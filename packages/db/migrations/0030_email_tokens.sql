-- Card U17. Email verification and password reset. A token is sent once by email and stored only as its sha256 hash,
-- like a session; a verification email also carries a six-digit code, stored only as a hash. A token is single use:
-- used_at is set when it is spent, and asking again deletes the person's earlier tokens of that kind. Like users and
-- sessions, the table is read and written by the API's own connection only: row level security is on and agir_app gets
-- no policy and no grant. Nothing is gated on verification; email_verified_at only records it.
alter table users add column email_verified_at timestamptz;

create table email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('verify_email', 'reset_password')),
  token_hash text not null unique,
  code_hash text check (code_hash is null or kind = 'verify_email'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index email_tokens_user on email_tokens (user_id, kind);
alter table email_tokens enable row level security;
