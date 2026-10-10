-- 0002_campaigns — campaigns, per-recipient send state, unsubscribe and
-- suppression (PROPOSED; not approved for any real database).
--
-- ⚠ Not approved for any real database yet. scripts/db-migrate.js applies
-- migrations only up to APPROVED_MIGRATION_VERSION (src/store/pgMigrate.js),
-- which is still 1, so this file is skipped there; only the disposable local
-- test databases apply it (explicitly). Once applied anywhere real, this file
-- must never change (the runner records its checksum).
--
-- Same conventions as 0001: everything in schema "mailer", applied by the
-- OWNER in one transaction, idempotent statements, row-level security with
-- one policy for the NOLOGIN group role mailer_runtime, explicit grants, and
-- no access for public / anon / authenticated.
--
-- A campaign row is created only when an admin CONFIRMS a reviewed list (the
-- CSV review itself stays stateless). It records exactly what was reviewed —
-- template version, template-content hash and recipient-list fingerprint —
-- so the sender can refuse to send anything that changed since. The
-- template content itself is not copied: if the session's template changes
-- (version or hash), sending stops and the list must be reviewed again.
--
-- Rules the application must not be able to break are enforced here as well
-- (checks, unique indexes and triggers): allowed status transitions, fields
-- that are fixed after confirmation, claim/attempt counters that only move
-- forward, recipients only claimable while their campaign is sending, and a
-- recipient list that is complete at commit and can never be extended.

-- ------------------------------------------------------------- campaigns --
-- Status model:
--   confirmed  created by the confirmation request; nothing sent yet
--   sending    workers may claim recipients
--   paused     no new claims; claims already in flight finish and record
--   completed  every recipient is final (none pending or claimed)
--   cancelled  stopped for good; pending recipients are marked skipped
-- Transitions: confirmed → sending | cancelled
--              sending   → paused | completed | cancelled
--              paused    → sending | cancelled
--              completed, cancelled: final.
create table if not exists mailer.campaigns (
  id                uuid primary key,
  -- Sent by the browser with the confirmation (generated when the review is
  -- shown). A repeated or concurrent confirmation with the same key finds the
  -- existing campaign instead of creating a second one.
  creation_key      uuid not null unique,
  created_by        integer not null references mailer.admins (id),
  session_id        text not null references mailer.session_templates (id),
  session_name      text not null check (char_length(session_name) between 1 and 80),
  -- Admin-facing campaign name (never inserted into the email).
  name              text not null check (char_length(name) between 1 and 100 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  -- What was reviewed and confirmed.
  template_version  integer not null check (template_version > 0),
  template_hash     text not null check (template_hash ~ '^[0-9a-f]{64}$'),
  recipients_hash   text not null check (recipients_hash ~ '^[0-9a-f]{64}$'),
  -- Review counts at confirmation (audit only; no CSV content is stored).
  -- Live progress is counted from campaign_recipients, never duplicated here.
  total_recipients  integer not null check (total_recipients between 1 and 1000),
  csv_rows          integer not null check (csv_rows >= 1),
  invalid_rows      integer not null default 0 check (invalid_rows >= 0),
  duplicate_rows    integer not null default 0 check (duplicate_rows >= 0),
  blank_rows        integer not null default 0 check (blank_rows >= 0),
  status            text not null default 'confirmed'
                    check (status in ('confirmed', 'sending', 'paused', 'completed', 'cancelled')),
  -- Why the campaign is paused or was cancelled (fixed vocabulary, no free text).
  stop_reason       text check (stop_reason in ('admin', 'template_changed', 'session_inactive', 'provider_rate_limited', 'provider_unavailable', 'sender_not_verified', 'error')),
  confirmed_at      timestamptz not null,
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null,
  constraint campaigns_counts_add_up
    check (total_recipients + invalid_rows + duplicate_rows + blank_rows = csv_rows),
  constraint campaigns_status_timestamps check (
    case status
      when 'confirmed' then started_at is null and finished_at is null
      when 'sending'   then started_at is not null and finished_at is null
      when 'paused'    then started_at is not null and finished_at is null
      when 'completed' then started_at is not null and finished_at is not null
      when 'cancelled' then finished_at is not null
    end),
  constraint campaigns_stop_reason_matches_status check (
    (status = 'paused' and stop_reason is not null)
    or (status = 'cancelled')
    or (status in ('confirmed', 'sending', 'completed') and stop_reason is null)),
  constraint campaigns_time_order check (
    updated_at >= confirmed_at
    and (started_at is null or started_at >= confirmed_at)
    and (finished_at is null or finished_at >= confirmed_at))
);
-- At most one OPEN campaign per session: confirmed, sending or paused. A
-- paused campaign still blocks a new one (cancel it first), so two lists can
-- never be sent through the same session at the same time.
create unique index if not exists campaigns_one_open_per_session
  on mailer.campaigns (session_id) where status in ('confirmed', 'sending', 'paused');
create index if not exists campaigns_created_idx on mailer.campaigns (confirmed_at desc);
create index if not exists campaigns_status_idx on mailer.campaigns (status) where status in ('sending', 'paused');

-- --------------------------------------------------- campaign recipients --
-- Status model:
--   pending     waiting to be sent (next_attempt_at, if set, is the earliest retry time)
--   claimed     a worker took it (claimed_at); a provider request may be in flight
--   accepted    Resend accepted it (provider_message_id set)          final
--   rejected    Resend refused it permanently                         final
--   failed      not sent, and retries were given up                   final
--   unresolved  outcome unknown (timeout / 5xx); check Resend manually
--   skipped     not sent: campaign cancelled, or address suppressed   final
--               (checked again immediately before every provider request)
--   dry_run     processed in dry-run mode; nothing was sent           final
-- Transitions: pending → pending (reschedule) | claimed | skipped
--              claimed → claimed (stale claim taken over: claim_count + 1)
--                      | pending (retry later) | accepted | rejected | failed
--                      | unresolved | dry_run
--                      | skipped (only reason 'suppressed': unsubscribed meanwhile)
--              unresolved → accepted | failed (manual resolution after checking Resend)
--                         | pending (manual retry with the SAME idempotency key)
--              failed     → pending (manual retry; nothing was accepted)
--              Manual retries need the campaign to be sending or paused.
--              everything else is final.
create table if not exists mailer.campaign_recipients (
  id                  bigint generated always as identity primary key,
  campaign_id         uuid not null references mailer.campaigns (id),
  -- Line of the CSV the recipient came from (the header is line 1).
  row_number          integer not null check (row_number between 2 and 5000),
  name                text not null
                      check (char_length(name) between 1 and 100 and name = btrim(name) and name !~ '[[:cntrl:]]' and position('{{' in name) = 0 and position('}}' in name) = 0),
  -- Normalized as in src/csvImport.js (trimmed, lower-cased).
  email               text not null
                      check (email = lower(btrim(email)) and char_length(email) between 3 and 254 and position('@' in email) > 1 and email !~ '[[:space:],;<>]'),
  -- Stable per recipient: every provider request for this recipient uses
  -- Idempotency-Key "tangy-campaign/<send_id>", including retries.
  send_id             uuid not null unique,
  -- SHA-256 of this recipient's unsubscribe token. The token itself is
  -- never stored: it is an HMAC of send_id under a server key, recomputed
  -- when sending (so retries send byte-identical emails) and looked up by
  -- this hash when the recipient follows the link.
  unsubscribe_hash    text not null unique check (unsubscribe_hash ~ '^[0-9a-f]{64}$'),
  status              text not null default 'pending'
                      check (status in ('pending', 'claimed', 'accepted', 'rejected', 'failed', 'unresolved', 'skipped', 'dry_run')),
  -- Provider requests started (attempts) and claims taken (claim_count).
  -- Each claim counts one attempt (the request follows the claim), so
  -- attempts <= claim_count. Both only ever increase.
  attempts            smallint not null default 0 check (attempts between 0 and 10),
  claim_count         smallint not null default 0 check (claim_count between 0 and 20),
  claimed_at          timestamptz,
  next_attempt_at     timestamptz,
  -- First provider request: Resend keeps idempotency keys ~24 h, so an
  -- unknown outcome may only be retried with the same key inside that window.
  first_attempt_at    timestamptz,
  provider_message_id text check (char_length(provider_message_id) between 1 and 200),
  -- Fixed vocabulary — never provider response bodies, message content or secrets.
  reason              text check (reason in (
                        'rate_limited', 'provider_rejected', 'provider_unavailable', 'network', 'timeout',
                        'invalid_recipient', 'render_failed', 'template_changed', 'cancelled', 'suppressed',
                        'retries_exhausted', 'unknown')),
  created_at          timestamptz not null,
  updated_at          timestamptz not null,
  completed_at        timestamptz,
  constraint campaign_recipients_email_unique unique (campaign_id, email),
  constraint campaign_recipients_row_unique unique (campaign_id, row_number),
  constraint campaign_recipients_attempts_le_claims check (attempts <= claim_count),
  constraint campaign_recipients_claimed_has_time check (status <> 'claimed' or claimed_at is not null),
  constraint campaign_recipients_accepted_has_id check (status <> 'accepted' or provider_message_id is not null),
  constraint campaign_recipients_final_has_time check (
    (status in ('pending', 'claimed') and completed_at is null)
    or (status not in ('pending', 'claimed') and completed_at is not null)),
  constraint campaign_recipients_reason_matches_status check (
    case status
      when 'accepted'   then reason is null
      when 'dry_run'    then reason is null
      when 'rejected'   then reason is not null
      when 'failed'     then reason is not null
      when 'unresolved' then reason is not null
      when 'skipped'    then reason in ('cancelled', 'suppressed', 'invalid_recipient', 'render_failed')
      else true
    end),
  constraint campaign_recipients_attempt_time check ((attempts = 0) = (first_attempt_at is null)),
  constraint campaign_recipients_time_order check (updated_at >= created_at and (completed_at is null or completed_at >= created_at))
);
-- Claiming: the next due recipients of a campaign, in CSV order.
create index if not exists campaign_recipients_due_idx
  on mailer.campaign_recipients (campaign_id, next_attempt_at nulls first, row_number) where status = 'pending';
-- Recovery: claims left behind by a crashed worker.
create index if not exists campaign_recipients_claimed_idx
  on mailer.campaign_recipients (campaign_id, claimed_at) where status = 'claimed';
-- Progress counts per campaign.
create index if not exists campaign_recipients_status_idx on mailer.campaign_recipients (campaign_id, status);
-- "Already sent in an earlier campaign" warnings at review time.
create index if not exists campaign_recipients_accepted_email_idx on mailer.campaign_recipients (email) where status = 'accepted';
-- An unsubscribe skips that address's pending recipients in every campaign.
create index if not exists campaign_recipients_pending_email_idx on mailer.campaign_recipients (email) where status = 'pending';

-- ---------------------------------------------------------- suppressions --
-- Addresses that must not receive campaign (invitation) emails. Only a
-- SHA-256 hash of the normalized address is stored ("tangy-suppression/v1:"
-- + lower-case address), so the list can be checked without keeping a
-- plain-text copy of who opted out. Rows are never updated or deleted by the
-- app: an opt-out is permanent unless an operator removes it.
create table if not exists mailer.suppressions (
  email_hash  text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  reason      text not null check (reason in ('unsubscribe', 'manual', 'bounce', 'complaint')),
  -- link: the page's button; one_click: RFC 8058 List-Unsubscribe-Post.
  source      text not null check (source in ('link', 'one_click', 'admin', 'provider')),
  -- The campaign whose email carried the link (audit; never the token).
  campaign_id uuid references mailer.campaigns (id),
  created_at  timestamptz not null
);

-- --------------------------------------------------------- integrity rules --
-- Trigger functions run with the caller's rights (not SECURITY DEFINER) and
-- a fixed search_path. They only read mailer tables the caller can already read.

create or replace function mailer.campaigns_guard() returns trigger
language plpgsql set search_path = pg_catalog, mailer as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'confirmed' then
      raise exception 'a campaign is created as confirmed' using errcode = '23514';
    end if;
    return new;
  end if;
  -- Fixed once confirmed.
  if (new.id, new.creation_key, new.created_by, new.session_id, new.session_name, new.name, new.template_version,
      new.template_hash, new.recipients_hash, new.total_recipients, new.csv_rows, new.invalid_rows,
      new.duplicate_rows, new.blank_rows, new.confirmed_at)
     is distinct from
     (old.id, old.creation_key, old.created_by, old.session_id, old.session_name, old.name, old.template_version,
      old.template_hash, old.recipients_hash, old.total_recipients, old.csv_rows, old.invalid_rows,
      old.duplicate_rows, old.blank_rows, old.confirmed_at) then
    raise exception 'confirmed campaign details cannot change' using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'confirmed' and new.status in ('sending', 'cancelled'))
    or (old.status = 'sending'   and new.status in ('paused', 'completed', 'cancelled'))
    or (old.status = 'paused'    and new.status in ('sending', 'cancelled'))) then
    raise exception 'campaign status cannot change from % to %', old.status, new.status using errcode = '23514';
  end if;
  if old.status in ('completed', 'cancelled') and new is distinct from old then
    raise exception 'a % campaign is final', old.status using errcode = '23514';
  end if;
  if new.status = 'completed' and old.status <> 'completed' and exists (
       select 1 from mailer.campaign_recipients r
        where r.campaign_id = new.id and r.status in ('pending', 'claimed')) then
    raise exception 'a campaign with pending or claimed recipients cannot complete' using errcode = '23514';
  end if;
  return new;
end
$$;

-- At commit, a newly confirmed campaign must have exactly total_recipients
-- recipients: a confirmation is all or nothing.
create or replace function mailer.campaigns_complete_list() returns trigger
language plpgsql set search_path = pg_catalog, mailer as $$
declare n integer;
begin
  select count(*) into n from mailer.campaign_recipients where campaign_id = new.id;
  if n <> new.total_recipients then
    raise exception 'campaign has % recipients, expected %', n, new.total_recipients using errcode = '23514';
  end if;
  return null;
end
$$;

-- Recipients can be added only to a campaign that is still 'confirmed' and
-- never beyond its total — so a list cannot grow after confirmation (the
-- deferred check above then requires the exact total at commit).
create or replace function mailer.campaign_recipients_insert_guard() returns trigger
language plpgsql set search_path = pg_catalog, mailer as $$
declare bad uuid;
begin
  select c.id into bad
    from (select distinct campaign_id from inserted) i
    join mailer.campaigns c on c.id = i.campaign_id
   where c.status <> 'confirmed'
      or (select count(*) from mailer.campaign_recipients r where r.campaign_id = c.id) > c.total_recipients
   limit 1;
  if bad is not null then
    raise exception 'recipients can only be added once, when the campaign is confirmed' using errcode = '23514';
  end if;
  return null;
end
$$;

create or replace function mailer.campaign_recipients_guard() returns trigger
language plpgsql set search_path = pg_catalog, mailer as $$
declare campaign_status text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.attempts <> 0 or new.claim_count <> 0 or new.claimed_at is not null
       or new.first_attempt_at is not null or new.provider_message_id is not null or new.reason is not null then
      raise exception 'a recipient is created as pending, with no attempts' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.id, new.campaign_id, new.row_number, new.name, new.email, new.send_id, new.unsubscribe_hash, new.created_at)
     is distinct from (old.id, old.campaign_id, old.row_number, old.name, old.email, old.send_id, old.unsubscribe_hash, old.created_at) then
    raise exception 'recipient details cannot change' using errcode = '23514';
  end if;
  if new.attempts < old.attempts or new.claim_count < old.claim_count then
    raise exception 'attempt and claim counters only increase' using errcode = '23514';
  end if;
  if old.first_attempt_at is not null and new.first_attempt_at is distinct from old.first_attempt_at then
    raise exception 'first_attempt_at cannot change' using errcode = '23514';
  end if;
  if not (
       (old.status = 'pending'    and new.status in ('pending', 'claimed', 'skipped'))
    or (old.status = 'claimed'    and new.status in ('claimed', 'pending', 'accepted', 'rejected', 'failed', 'unresolved', 'dry_run'))
    or (old.status = 'claimed'    and new.status = 'skipped' and new.reason = 'suppressed')
    or (old.status = 'unresolved' and new.status in ('unresolved', 'accepted', 'failed', 'pending'))
    or (old.status = 'failed'     and new.status = 'pending')) then
    raise exception 'recipient status cannot change from % to %', old.status, new.status using errcode = '23514';
  end if;
  -- A manual retry only while the campaign can still send.
  if old.status in ('failed', 'unresolved') and new.status = 'pending' then
    select status into campaign_status from mailer.campaigns where id = new.campaign_id;
    if campaign_status not in ('sending', 'paused') then
      raise exception 'recipients can only be retried while the campaign is sending or paused (it is %)', campaign_status using errcode = '23514';
    end if;
  end if;
  if old.status = 'unresolved' and new.status = 'unresolved' and new is distinct from old then
    raise exception 'an unresolved recipient can only be resolved' using errcode = '23514';
  end if;
  -- Every claim (first, or take-over of a stale one) increments claim_count
  -- by exactly one, so two workers can never both win the same claim
  -- (compare-and-swap on claim_count). Updates by the worker holding the
  -- claim (recording an attempt) keep it unchanged.
  if new.claim_count = old.claim_count + 1 then
    if new.status <> 'claimed' then
      raise exception 'claim_count changes only when claiming' using errcode = '23514';
    end if;
    select status into campaign_status from mailer.campaigns where id = new.campaign_id;
    if campaign_status <> 'sending' then
      raise exception 'recipients can only be claimed while the campaign is sending (it is %)', campaign_status using errcode = '23514';
    end if;
  elsif new.claim_count <> old.claim_count then
    raise exception 'claim_count increases by one per claim' using errcode = '23514';
  elsif new.status = 'claimed' and old.status <> 'claimed' then
    raise exception 'a claim must increment claim_count by one' using errcode = '23514';
  end if;
  -- One attempt per claim: counted when claiming, or by the claim holder.
  if new.attempts > old.attempts + 1
     or (new.attempts > old.attempts and not (old.status = 'claimed' or new.claim_count = old.claim_count + 1)) then
    raise exception 'attempts increase by one, only when claiming or while claimed' using errcode = '23514';
  end if;
  return new;
end
$$;

drop trigger if exists campaigns_guard on mailer.campaigns;
create trigger campaigns_guard before insert or update on mailer.campaigns
  for each row execute function mailer.campaigns_guard();
drop trigger if exists campaigns_complete_list on mailer.campaigns;
create constraint trigger campaigns_complete_list after insert on mailer.campaigns
  deferrable initially deferred for each row execute function mailer.campaigns_complete_list();
drop trigger if exists campaign_recipients_guard on mailer.campaign_recipients;
create trigger campaign_recipients_guard before insert or update on mailer.campaign_recipients
  for each row execute function mailer.campaign_recipients_guard();
drop trigger if exists campaign_recipients_insert_guard on mailer.campaign_recipients;
create trigger campaign_recipients_insert_guard after insert on mailer.campaign_recipients
  referencing new table as inserted for each statement execute function mailer.campaign_recipients_insert_guard();

-- Trigger functions are not callable as plain functions; keep them private anyway.
revoke all on function mailer.campaigns_guard(), mailer.campaigns_complete_list(),
  mailer.campaign_recipients_insert_guard(), mailer.campaign_recipients_guard() from public;

-- ------------------------------------------------------------ privileges --
revoke all on mailer.campaigns, mailer.campaign_recipients, mailer.suppressions from public;
revoke all on sequence mailer.campaign_recipients_id_seq from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on mailer.campaigns, mailer.campaign_recipients, mailer.suppressions from %I', r);
      execute format('revoke all on sequence mailer.campaign_recipients_id_seq from %I', r);
    end if;
  end loop;
end
$$;

-- No DELETE: campaign history is kept (removal/retention is an owner task).
grant select, insert, update on mailer.campaigns           to mailer_runtime;
grant select, insert, update on mailer.campaign_recipients to mailer_runtime;
grant usage on sequence mailer.campaign_recipients_id_seq  to mailer_runtime;
-- Opt-outs are added, never changed or removed by the app.
grant select, insert         on mailer.suppressions        to mailer_runtime;

-- ------------------------------------------------------ row-level security --
do $$
declare t text;
begin
  foreach t in array array['campaigns', 'campaign_recipients', 'suppressions'] loop
    execute format('alter table mailer.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'mailer' and tablename = t and policyname = 'mailer_runtime_access') then
      execute format('create policy mailer_runtime_access on mailer.%I for all to mailer_runtime using (true) with check (true)', t);
    end if;
  end loop;
end
$$;
