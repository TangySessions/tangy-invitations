-- ⚠ CHANGES THE REMOTE DATABASE — run manually, once, ONLY after approval.
--
-- Creates the login role the app connects as (DATABASE_URL). Run it in the
-- Supabase SQL editor as `postgres` AFTER migration 0001 has been applied —
-- the migration creates the NOLOGIN group role `mailer_runtime` and all of
-- its table grants and row-level-security policies; this script only adds a
-- LOGIN role that inherits them, plus per-role safety settings.
--
-- Before running: replace <SCRAM_VERIFIER> with the output of
--   node scripts/scram-verifier.js
-- (a SCRAM-SHA-256 hash computed on your machine — never paste the plaintext
-- password here), and <MAX_CONNECTIONS> with a small number (e.g. 20) not
-- above the pooler's pool size. Do not save the filled-in copy anywhere.

begin;

-- Must INHERIT (the default) to receive mailer_runtime's privileges and its
-- row-level-security policy access. No elevated attributes.
create role mailer_app with
  login inherit
  nosuperuser nocreatedb nocreaterole noreplication nobypassrls
  connection limit <MAX_CONNECTIONS>
  password '<SCRAM_VERIFIER>';

grant mailer_runtime to mailer_app;

-- Server-side limits that apply to every connection of this role, so they
-- hold even when PG_STARTUP_PARAMS=none (the app also SETs LOCAL timeouts in
-- every transaction).
alter role mailer_app set statement_timeout = '10s';
alter role mailer_app set idle_in_transaction_session_timeout = '15s';
alter role mailer_app set lock_timeout = '5s';

commit;
