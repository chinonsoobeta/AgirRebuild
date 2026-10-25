-- Card R6. Changing a person's email address. Two more kinds of email token, stored like the others (sha256 hash only,
-- single use):
--   change_email: sent to the new address; opening it within 60 minutes switches the account to that address.
--     email holds the new address.
--   undo_email_change: sent to the old address once a confirmed address has been replaced; for 7 days, opening it puts
--     the old address back, signs every device out and turns the password off. email holds the address to put back.
--     While one is live and unused, the API refuses that address to everyone else (sign-up and changes), so nobody can
--     take the address and block the undo.
-- email follows the rule of users.email (lowercase, an @ after the first character) and is present exactly for these
-- two kinds. The partial index serves the API's lookup of held addresses.
alter table email_tokens drop constraint email_tokens_kind_check;
alter table email_tokens add constraint email_tokens_kind_check
  check (kind in ('verify_email', 'reset_password', 'change_email', 'undo_email_change'));
alter table email_tokens add column email text check (email = lower(email) and position('@' in email) > 1);
alter table email_tokens add constraint email_tokens_email_kind_check
  check ((email is not null) = (kind in ('change_email', 'undo_email_change')));
create index email_tokens_held_email on email_tokens (email) where kind = 'undo_email_change' and used_at is null;
