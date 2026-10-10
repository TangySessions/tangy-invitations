-- 0001_init — PostgreSQL schema for the Tangy Sessions Invitation Manager.
--
-- Applied by scripts/db-migrate.js using the OWNER connection
-- (MIGRATION_DATABASE_URL), inside one transaction, and recorded in
-- mailer.schema_migrations. Every statement is idempotent: re-running it
-- never duplicates the four slots and never touches saved content.
--
-- Security model
--   * All objects live in schema "mailer" (not "public"), so Supabase's Data
--     API (which exposes "public" by default) cannot reach them.
--   * The app connects as a LOGIN role that is a member of the NOLOGIN group
--     role "mailer_runtime". That login role (and its password) is created by
--     an operator, never by a migration. mailer_runtime gets only the table
--     privileges the app needs: no DDL, no ownership, no superuser.
--   * Row-level security is enabled on every table with a single policy for
--     mailer_runtime. Any other non-owner role (e.g. Supabase's anon /
--     authenticated) sees nothing even if it were granted table access.

create schema if not exists mailer;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mailer_runtime') then
    create role mailer_runtime nologin;
  end if;
end
$$;

-- --------------------------------------------------------------- admins --
create table if not exists mailer.admins (
  id          integer generated always as identity primary key,
  email       text not null
              check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and position('@' in email) > 1),
  password_hash text not null check (password_hash like 'scrypt$%'),
  disabled    boolean not null default false,
  created_at  timestamptz not null default now()
);
-- Case-insensitive uniqueness (SQLite: unique collate nocase).
create unique index if not exists admins_email_lower_key on mailer.admins (lower(email));

-- -------------------------------------------------------- login sessions --
-- SQLite table "sessions". Only SHA-256 hashes of session tokens are stored.
create table if not exists mailer.login_sessions (
  token_hash  text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  admin_id    integer not null references mailer.admins (id) on delete cascade,
  csrf_token  text not null check (char_length(csrf_token) between 20 and 100),
  created_at  timestamptz not null,
  last_seen   timestamptz not null
);
create index if not exists login_sessions_admin_idx on mailer.login_sessions (admin_id);
create index if not exists login_sessions_last_seen_idx on mailer.login_sessions (last_seen);
create index if not exists login_sessions_created_idx on mailer.login_sessions (created_at);

-- ----------------------------------------------------- session templates --
create table if not exists mailer.session_templates (
  id          text primary key check (id in ('s1', 's2', 's3', 's4')),
  slot        smallint not null unique check (slot between 1 and 4),
  name        text not null default '' check (char_length(name) <= 80),
  subject     text,
  html        text,
  css         text not null default '',
  text_body   text not null default '',
  configured  boolean not null default false,
  active      boolean not null default true,
  version     integer not null default 0 check (version >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  updated_by  integer references mailer.admins (id) on delete set null,
  constraint session_templates_slot_matches_id check (slot = substr(id, 2)::int),
  constraint session_templates_configured_has_content
    check (not configured or (subject is not null and html is not null and version > 0 and char_length(name) > 0))
);

-- Exactly four slots. ON CONFLICT DO NOTHING keeps existing rows untouched.
insert into mailer.session_templates (id, slot)
values ('s1', 1), ('s2', 2), ('s3', 3), ('s4', 4)
on conflict (id) do nothing;

-- -------------------------------------------------------------- send log --
create table if not exists mailer.send_log (
  id                  bigint generated always as identity primary key,
  idempotency_key     uuid not null unique,
  admin_id            integer not null references mailer.admins (id),
  session_id          text references mailer.session_templates (id),
  session_name        text,
  recipient_email     text not null check (char_length(recipient_email) <= 254),
  subject             text not null,
  is_test             boolean not null,
  template_version    integer not null check (template_version >= 0),
  status              text not null check (status in ('pending', 'accepted', 'dry_run', 'rejected', 'failed', 'ambiguous')),
  provider_message_id text,
  error               text,
  created_at          timestamptz not null,
  -- When the current claim was taken (first claim, or a later explicit
  -- retry). A 'pending' row is only reclaimable once this is stale.
  claimed_at          timestamptz not null,
  -- Incremented on every (re)claim. A retry may only reclaim the row if
  -- this still has the value it read (compare-and-swap), so two retries can
  -- never both claim the same send — independent of any locking.
  claim_count         integer not null default 1 check (claim_count >= 1),
  completed_at        timestamptz
);
create index if not exists send_log_admin_created_idx on mailer.send_log (admin_id, created_at desc);
create index if not exists send_log_created_idx on mailer.send_log (created_at desc);

-- ------------------------------------------------------- login attempts --
-- Shared failed-login counters. key_hash = sha256 of 'e:<email>' or
-- 'i:<ip>', so neither emails nor IP addresses are stored in plain text.
create table if not exists mailer.login_attempts (
  key_hash      text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  window_start  timestamptz not null,
  failures      integer not null check (failures >= 0)
);
create index if not exists login_attempts_window_idx on mailer.login_attempts (window_start);

-- ------------------------------------------------------------ privileges --
revoke all on schema mailer from public;
revoke all on all tables in schema mailer from public;
revoke all on all sequences in schema mailer from public;

do $$
declare r text;
begin
  -- Supabase API roles: explicitly no access (they may not exist elsewhere).
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema mailer from %I', r);
      execute format('revoke all on all tables in schema mailer from %I', r);
      execute format('revoke all on all sequences in schema mailer from %I', r);
    end if;
  end loop;
end
$$;

grant usage on schema mailer to mailer_runtime;
grant select                         on mailer.admins            to mailer_runtime;  -- accounts are managed by the owner (CLI)
grant select, insert, update, delete on mailer.login_sessions    to mailer_runtime;
grant select, update                 on mailer.session_templates to mailer_runtime;  -- no insert/delete: the four slots are fixed
grant select, insert, update         on mailer.send_log          to mailer_runtime;  -- no delete: history is kept
grant select, insert, update, delete on mailer.login_attempts    to mailer_runtime;
grant usage on all sequences in schema mailer to mailer_runtime;
-- Created by the migration runner; the app reads it at startup to refuse an
-- unmigrated or outdated database.
grant select on mailer.schema_migrations to mailer_runtime;

-- ------------------------------------------------------ row-level security --
do $$
declare t text;
begin
  foreach t in array array['admins', 'login_sessions', 'session_templates', 'send_log', 'login_attempts'] loop
    execute format('alter table mailer.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'mailer' and tablename = t and policyname = 'mailer_runtime_access') then
      execute format('create policy mailer_runtime_access on mailer.%I for all to mailer_runtime using (true) with check (true)', t);
    end if;
  end loop;
end
$$;
