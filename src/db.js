// SQLite storage (Node's built-in node:sqlite — no dependency). One file in
// DATA_DIR holds:
//   session_templates  exactly four rows, s1–s4: each session's own name,
//                      subject, HTML, CSS, plain text, version, status.
//                      Rows are created once by the migration and only ever
//                      UPDATEd — never inserted or deleted by the app.
//   admins             accounts allowed to use the tool (created from the CLI only)
//   sessions           SHA-256 hashes of login-session tokens (never the tokens)
//   send_log           minimal audit trail: who sent which session's subject to
//                      which address, test or real, the provider message id and
//                      the outcome. Never the email body, never secrets.
//
//   campaigns /        confirmed recipient lists and per-recipient send
//   campaign_recipients state (same rules as PostgreSQL migration 0002)
//
// Schema versions (pragma user_version):
//   0 → 1-template schema (table `template`), or a brand-new file
//   2 → four session templates
//   3 → + campaigns and campaign_recipients
//   4 → + suppressions and per-recipient unsubscribe hashes
//   5 → + campaign_recipients.people (number of people per invitation; this version)
// Any upgrade backs the file up first (DATA_DIR/backups/, VACUUM INTO), then
// runs in one transaction. 0→2: the legacy single template — if any — moves
// into s1 only; s2–s4 start unconfigured; send_log gains session columns
// (old rows keep NULL = "before sessions"); the old table is renamed, not
// dropped. 2→3 only adds the two campaign tables; 3→4 only adds the
// suppression table, one column and updated triggers; 4→5 only adds the
// people column (existing recipients get 1) and its trigger. Nothing existing
// is rewritten.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { existingDecision, RATE_WINDOW_MS } from './store/sendClaim.js';
import { CAMPAIGN_ACTIONS, MAX_ATTEMPTS, countsFrom } from './store/campaignRules.js';

export const SESSION_IDS = Object.freeze(['s1', 's2', 's3', 's4']);
export const SCHEMA_VERSION = 5;
export const defaultLabel = (id) => `Session ${SESSION_IDS.indexOf(id) + 1}`;

const BASE_SCHEMA = `
create table if not exists admins (
  id integer primary key,
  email text not null unique collate nocase,
  password_hash text not null,
  disabled integer not null default 0,
  created_at text not null
);

create table if not exists sessions (
  token_hash text primary key,
  admin_id integer not null references admins(id) on delete cascade,
  csrf_token text not null,
  created_at integer not null,
  last_seen integer not null
);
create index if not exists sessions_admin_idx on sessions(admin_id);

create table if not exists send_log (
  id integer primary key,
  idempotency_key text not null unique,
  admin_id integer not null references admins(id),
  recipient_email text not null,
  subject text not null,
  is_test integer not null,
  template_version integer not null,
  status text not null check (status in ('pending', 'accepted', 'dry_run', 'rejected', 'failed', 'ambiguous')),
  provider_message_id text,
  error text,
  created_at integer not null,
  completed_at integer
);
create index if not exists send_log_admin_created_idx on send_log(admin_id, created_at);
`;

const SESSION_TEMPLATES = `
create table session_templates (
  id text primary key check (id in ('s1', 's2', 's3', 's4')),
  slot integer not null unique check (slot between 1 and 4),
  name text not null default '' check (length(name) <= 80),
  subject text,
  html text,
  css text not null default '',
  text_body text not null default '',
  configured integer not null default 0 check (configured in (0, 1)),
  active integer not null default 1 check (active in (0, 1)),
  version integer not null default 0 check (version >= 0),
  created_at text not null,
  updated_at text,
  updated_by integer references admins(id) on delete set null,
  check (configured = 0 or (subject is not null and html is not null and version > 0 and length(name) > 0))
);
`;

// Mirrors migrations/postgres/0002_campaigns.sql (times are epoch ms).
// Triggers enforce the same transitions and fixed fields; a confirmation
// inserts the campaign and all recipients in one transaction.
const CAMPAIGNS = `
create table campaigns (
  id text primary key check (length(id) = 36),
  creation_key text not null unique check (length(creation_key) = 36),
  created_by integer not null references admins(id),
  session_id text not null references session_templates(id),
  session_name text not null check (length(session_name) between 1 and 80),
  name text not null check (length(name) between 1 and 100 and name = trim(name)),
  template_version integer not null check (template_version > 0),
  template_hash text not null check (length(template_hash) = 64 and template_hash not glob '*[^0-9a-f]*'),
  recipients_hash text not null check (length(recipients_hash) = 64 and recipients_hash not glob '*[^0-9a-f]*'),
  total_recipients integer not null check (total_recipients between 1 and 1000),
  csv_rows integer not null check (csv_rows >= 1),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  duplicate_rows integer not null default 0 check (duplicate_rows >= 0),
  blank_rows integer not null default 0 check (blank_rows >= 0),
  status text not null default 'confirmed' check (status in ('confirmed', 'sending', 'paused', 'completed', 'cancelled')),
  stop_reason text check (stop_reason in ('admin', 'template_changed', 'session_inactive', 'provider_rate_limited', 'provider_unavailable', 'sender_not_verified', 'error')),
  confirmed_at integer not null,
  started_at integer,
  finished_at integer,
  updated_at integer not null,
  check (total_recipients + invalid_rows + duplicate_rows + blank_rows = csv_rows),
  check (case status
    when 'confirmed' then started_at is null and finished_at is null
    when 'sending' then started_at is not null and finished_at is null
    when 'paused' then started_at is not null and finished_at is null
    when 'completed' then started_at is not null and finished_at is not null
    when 'cancelled' then finished_at is not null end),
  check ((status = 'paused' and stop_reason is not null) or status = 'cancelled'
    or (status in ('confirmed', 'sending', 'completed') and stop_reason is null)),
  check (updated_at >= confirmed_at)
);
create unique index campaigns_one_open_per_session on campaigns (session_id) where status in ('confirmed', 'sending', 'paused');
create index campaigns_confirmed_idx on campaigns (confirmed_at);

create table campaign_recipients (
  id integer primary key,
  campaign_id text not null references campaigns(id),
  row_number integer not null check (row_number between 2 and 5000),
  name text not null check (length(name) between 1 and 100 and name = trim(name) and instr(name, '{{') = 0 and instr(name, '}}') = 0),
  email text not null check (email = lower(trim(email)) and length(email) between 3 and 254 and instr(email, '@') > 1
                             and instr(email, ' ') = 0 and instr(email, ',') = 0 and instr(email, ';') = 0 and instr(email, '<') = 0 and instr(email, '>') = 0),
  send_id text not null unique check (length(send_id) = 36),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'accepted', 'rejected', 'failed', 'unresolved', 'skipped', 'dry_run')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  claim_count integer not null default 0 check (claim_count between 0 and 20),
  claimed_at integer,
  next_attempt_at integer,
  first_attempt_at integer,
  provider_message_id text check (length(provider_message_id) between 1 and 200),
  reason text check (reason in ('rate_limited', 'provider_rejected', 'provider_unavailable', 'network', 'timeout',
                                'invalid_recipient', 'render_failed', 'template_changed', 'cancelled', 'suppressed', 'retries_exhausted', 'unknown')),
  created_at integer not null,
  updated_at integer not null,
  completed_at integer,
  unique (campaign_id, email),
  unique (campaign_id, row_number),
  check (attempts <= claim_count),
  check (status <> 'claimed' or claimed_at is not null),
  check (status <> 'accepted' or provider_message_id is not null),
  check ((status in ('pending', 'claimed') and completed_at is null) or (status not in ('pending', 'claimed') and completed_at is not null)),
  check (case status
    when 'accepted' then reason is null when 'dry_run' then reason is null
    when 'rejected' then reason is not null when 'failed' then reason is not null when 'unresolved' then reason is not null
    when 'skipped' then reason in ('cancelled', 'suppressed', 'invalid_recipient', 'render_failed')
    else 1 end),
  check ((attempts = 0) = (first_attempt_at is null))
);
create index campaign_recipients_due_idx on campaign_recipients (campaign_id, status, next_attempt_at, row_number);
create index campaign_recipients_accepted_email_idx on campaign_recipients (email) where status = 'accepted';

create trigger campaigns_insert before insert on campaigns when new.status <> 'confirmed'
begin select raise(abort, 'a campaign is created as confirmed'); end;
create trigger campaigns_fixed before update on campaigns
  when new.id is not old.id or new.creation_key is not old.creation_key or new.created_by is not old.created_by
    or new.session_id is not old.session_id or new.session_name is not old.session_name or new.name is not old.name
    or new.template_version is not old.template_version or new.template_hash is not old.template_hash
    or new.recipients_hash is not old.recipients_hash or new.total_recipients is not old.total_recipients
    or new.csv_rows is not old.csv_rows or new.invalid_rows is not old.invalid_rows or new.duplicate_rows is not old.duplicate_rows
    or new.blank_rows is not old.blank_rows or new.confirmed_at is not old.confirmed_at
begin select raise(abort, 'confirmed campaign details cannot change'); end;
create trigger campaigns_final before update on campaigns when old.status in ('completed', 'cancelled')
begin select raise(abort, 'a completed or cancelled campaign is final'); end;
create trigger campaigns_transition before update of status on campaigns
  when new.status <> old.status and not (
       (old.status = 'confirmed' and new.status in ('sending', 'cancelled'))
    or (old.status = 'sending' and new.status in ('paused', 'completed', 'cancelled'))
    or (old.status = 'paused' and new.status in ('sending', 'cancelled')))
begin select raise(abort, 'campaign status cannot change that way'); end;
create trigger campaigns_complete before update of status on campaigns
  when new.status = 'completed' and old.status <> 'completed'
   and exists (select 1 from campaign_recipients r where r.campaign_id = new.id and r.status in ('pending', 'claimed'))
begin select raise(abort, 'a campaign with pending or claimed recipients cannot complete'); end;

create trigger campaign_recipients_insert before insert on campaign_recipients
  when new.status <> 'pending' or new.attempts <> 0 or new.claim_count <> 0 or new.claimed_at is not null
    or new.first_attempt_at is not null or new.provider_message_id is not null or new.reason is not null
    or (select status from campaigns where id = new.campaign_id) is not 'confirmed'
    or (select count(*) from campaign_recipients where campaign_id = new.campaign_id)
       >= (select total_recipients from campaigns where id = new.campaign_id)
begin select raise(abort, 'recipients can only be added once, as pending, when the campaign is confirmed'); end;
create trigger campaign_recipients_fixed before update on campaign_recipients
  when new.id is not old.id or new.campaign_id is not old.campaign_id or new.row_number is not old.row_number
    or new.name is not old.name or new.email is not old.email or new.send_id is not old.send_id or new.created_at is not old.created_at
    or new.attempts < old.attempts or new.claim_count < old.claim_count
    or (old.first_attempt_at is not null and new.first_attempt_at is not old.first_attempt_at)
begin select raise(abort, 'recipient details are fixed and counters only increase'); end;
create trigger campaign_recipients_transition before update on campaign_recipients
  when not (
       (old.status = 'pending' and new.status in ('pending', 'claimed', 'skipped'))
    or (old.status = 'claimed' and new.status in ('claimed', 'pending', 'accepted', 'rejected', 'failed', 'unresolved', 'dry_run'))
    or (old.status = 'unresolved' and new.status in ('unresolved', 'accepted', 'failed', 'pending'))
    or (old.status = 'failed' and new.status = 'pending'))
begin select raise(abort, 'recipient status cannot change that way'); end;
create trigger campaign_recipients_retry before update on campaign_recipients
  when old.status in ('failed', 'unresolved') and new.status = 'pending'
   and (select status from campaigns where id = new.campaign_id) not in ('sending', 'paused')
begin select raise(abort, 'recipients can only be retried while the campaign is sending or paused'); end;
create trigger campaign_recipients_claim before update on campaign_recipients
  when new.claim_count > old.claim_count + 1
    or (new.claim_count = old.claim_count + 1 and (new.status <> 'claimed' or (select status from campaigns where id = new.campaign_id) <> 'sending'))
    or (new.claim_count = old.claim_count and new.status = 'claimed' and old.status <> 'claimed')
    or new.attempts > old.attempts + 1
    or (new.attempts > old.attempts and not (old.status = 'claimed' or new.claim_count = old.claim_count + 1))
begin select raise(abort, 'claims increment claim_count by one while the campaign is sending; one attempt per claim'); end;
`;

// v4: unsubscribe + suppression (mirrors the same parts of 0002). The column
// is nullable only for rows confirmed under v3; new rows always have it.
const SUPPRESSION = `
alter table campaign_recipients add column unsubscribe_hash text
  check (unsubscribe_hash is null or (length(unsubscribe_hash) = 64 and unsubscribe_hash not glob '*[^0-9a-f]*'));
create unique index campaign_recipients_unsubscribe_idx on campaign_recipients (unsubscribe_hash);
create index campaign_recipients_pending_email_idx on campaign_recipients (email) where status = 'pending';

create table suppressions (
  email_hash text primary key check (length(email_hash) = 64 and email_hash not glob '*[^0-9a-f]*'),
  reason text not null check (reason in ('unsubscribe', 'manual', 'bounce', 'complaint')),
  source text not null check (source in ('link', 'one_click', 'admin', 'provider')),
  campaign_id text references campaigns(id),
  created_at integer not null
);
create trigger suppressions_append_only_update before update on suppressions
begin select raise(abort, 'suppressions are never changed by the app'); end;
create trigger suppressions_append_only_delete before delete on suppressions
begin select raise(abort, 'suppressions are never removed by the app'); end;

drop trigger campaign_recipients_transition;
create trigger campaign_recipients_transition before update on campaign_recipients
  when not (
       (old.status = 'pending' and new.status in ('pending', 'claimed', 'skipped'))
    or (old.status = 'claimed' and new.status in ('claimed', 'pending', 'accepted', 'rejected', 'failed', 'unresolved', 'dry_run'))
    or (old.status = 'claimed' and new.status = 'skipped' and new.reason = 'suppressed')
    or (old.status = 'unresolved' and new.status in ('unresolved', 'accepted', 'failed', 'pending'))
    or (old.status = 'failed' and new.status = 'pending'))
begin select raise(abort, 'recipient status cannot change that way'); end;
create trigger campaign_recipients_unsubscribe_fixed before update of unsubscribe_hash on campaign_recipients
  when old.unsubscribe_hash is not null and new.unsubscribe_hash is not old.unsubscribe_hash
begin select raise(abort, 'recipient details are fixed and counters only increase'); end;
`;

// v5: number of people per campaign recipient (mirrors 0002's
// campaign_recipients.people). Existing rows get 1 — correct, because lists
// with other counts could not be confirmed before this version.
const PEOPLE = `
alter table campaign_recipients add column people integer not null default 1 check (people between 1 and 50);
create trigger campaign_recipients_people_fixed before update of people on campaign_recipients
  when new.people is not old.people
begin select raise(abort, 'recipient details are fixed and counters only increase'); end;
`;

const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (ms) => (ms == null ? null : iso(ms));
const tableExists = (db, name) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
const columns = (db, table) => db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);

function migrate(db, file, { now = Date.now } = {}) {
  const version = db.prepare('pragma user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return { migrated: false };
  const legacy = tableExists(db, 'template');

  // Back up an existing database before changing its schema.
  let backup = null;
  if (file !== ':memory:' && (legacy || tableExists(db, 'send_log'))) {
    const dir = join(resolve(file, '..'), 'backups');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    backup = join(dir, `mailer-before-v${SCHEMA_VERSION}-${iso(now()).replace(/[:.]/g, '-')}.db`);
    db.prepare('vacuum into ?').run(backup);
    try { chmodSync(backup, 0o600); } catch { /* best effort */ }
  }

  db.exec('begin immediate');
  try {
    if (version < 2) migrateToV2(db, legacy, now);
    if (version < 3) db.exec(CAMPAIGNS);
    if (version < 4) db.exec(SUPPRESSION);
    if (version < 5) db.exec(PEOPLE);
    db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  return { migrated: true, backup };
}

function migrateToV2(db, legacy, now) {
  db.exec(BASE_SCHEMA);
  const logCols = columns(db, 'send_log');
  if (!logCols.includes('session_id')) db.exec('alter table send_log add column session_id text');
  if (!logCols.includes('session_name')) db.exec('alter table send_log add column session_name text');

  db.exec(SESSION_TEMPLATES);
  const created = iso(now());
  const insert = db.prepare('insert into session_templates (id, slot, created_at) values (?, ?, ?)');
  SESSION_IDS.forEach((id, i) => insert.run(id, i + 1, created));

  if (legacy) {
    const old = db.prepare('select * from template where id = 1').get();
    if (old) {
      // The one pre-existing template becomes Session 1 — and only Session 1.
      db.prepare(`update session_templates set name = ?, subject = ?, html = ?, css = ?, text_body = ?, configured = 1,
                    version = ?, updated_at = ?, updated_by = ? where id = 's1'`)
        .run(defaultLabel('s1'), old.subject, old.html, old.css, old.text_body, old.version, old.updated_at, old.updated_by);
    }
    db.exec('alter table template rename to legacy_template_v1');
  }
}

export function openDb(dataDir, opts = {}) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    const dir = resolve(dataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    file = join(dir, 'mailer.db');
  }
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  const migration = migrate(db, file, opts);
  if (file !== ':memory:') {
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  return wrap(db, migration);
}

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    slot: row.slot,
    label: row.name || defaultLabel(row.id),
    name: row.name,
    configured: !!row.configured,
    active: !!row.active,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    updated_by: row.updated_by_email ?? null,
  };
}

function wrap(db, migration) {
  const q = (sql) => db.prepare(sql);
  const sessionSelect = 'select t.*, a.email as updated_by_email from session_templates t left join admins a on a.id = t.updated_by';
  // Send ids claimed by a request that is still running in THIS process.
  // SQLite is single-process, so this is authoritative: a second request for
  // the same id sees 'in_progress' instead of re-claiming it. (The schema has
  // no claimed_at column; a 'pending' row is only treated as abandoned when
  // it is not in this set and is older than STALE_PENDING_MS, as before.)
  const inFlight = new Set();
  // Runs fn in one IMMEDIATE transaction (SQLite has one writer; this
  // serializes claims and transitions exactly like row locks in PostgreSQL).
  const tx = (fn) => {
    db.exec('begin immediate');
    try {
      const out = fn();
      db.exec('commit');
      return out;
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  };
  const campaignSelect = 'select c.*, a.email as created_by_email from campaigns c join admins a on a.id = c.created_by';
  return {
    raw: db,
    backend: 'sqlite',
    migration,
    close: () => db.close(),

    // ---- admins
    getAdminByEmail: (email) => q('select * from admins where email = ?').get(String(email).trim()),
    getAdminById: (id) => q('select * from admins where id = ?').get(id),
    listAdmins: () => q('select id, email, disabled, created_at from admins order by id').all(),
    createAdmin: (email, passwordHash) => q('insert into admins (email, password_hash, created_at) values (?, ?, ?)')
      .run(String(email).trim().toLowerCase(), passwordHash, iso(Date.now())),
    setAdminPassword: (email, passwordHash) => q('update admins set password_hash = ? where email = ?').run(passwordHash, email).changes,
    setAdminDisabled: (email, disabled) => {
      const changes = q('update admins set disabled = ? where email = ?').run(disabled ? 1 : 0, email).changes;
      if (disabled) q('delete from sessions where admin_id = (select id from admins where email = ?)').run(email);
      return changes;
    },

    // ---- login sessions
    createSession: (tokenHash, adminId, csrf, now) => q('insert into sessions (token_hash, admin_id, csrf_token, created_at, last_seen) values (?, ?, ?, ?, ?)')
      .run(tokenHash, adminId, csrf, now, now),
    getSession: (tokenHash) => q(`select s.*, a.email, a.disabled from sessions s join admins a on a.id = s.admin_id where s.token_hash = ?`).get(tokenHash),
    touchSession: (tokenHash, now) => q('update sessions set last_seen = ? where token_hash = ?').run(now, tokenHash),
    deleteSession: (tokenHash) => q('delete from sessions where token_hash = ?').run(tokenHash),
    deleteSessionsForAdmin: (adminId) => q('delete from sessions where admin_id = ?').run(adminId).changes,
    purgeSessions: (idleBefore, createdBefore) => q('delete from sessions where last_seen < ? or created_at < ?').run(idleBefore, createdBefore),

    // ---- session templates
    // Summaries for the dashboard: everything except the HTML/CSS/text bodies.
    listSessionTemplates: () => q(`${sessionSelect} order by t.slot`).all().map((row) => ({ ...toSession(row), subject: row.subject ?? '' })),
    // The full saved template for one session (null for an unknown id).
    getSessionTemplate: (id) => {
      const row = q(`${sessionSelect} where t.id = ?`).get(id);
      if (!row) return null;
      return {
        ...toSession(row),
        subject: row.subject ?? '', html: row.html ?? '', css: row.css, text: row.text_body,
      };
    },
    // Optimistic concurrency in a single statement: the row changes only if
    // the caller edited the version that is stored, and only this session's
    // row (WHERE id = ?) can change.
    saveSessionTemplate: (id, { name, subject, html, css, text, active }, expectedVersion, adminId, now) => {
      const r = q(`update session_templates
                     set name = ?, subject = ?, html = ?, css = ?, text_body = ?, active = ?, configured = 1,
                         version = version + 1, updated_at = ?, updated_by = ?
                   where id = ? and version = ?`)
        .run(name, subject, html, css, text, active ? 1 : 0, iso(now), adminId, id, expectedVersion);
      const current = q('select version from session_templates where id = ?').get(id);
      if (!current) return { notFound: true };
      if (r.changes !== 1) return { conflict: true, currentVersion: current.version };
      return { version: current.version };
    },

    // ---- send log
    findSend: (key) => q('select * from send_log where idempotency_key = ?').get(key),
    insertSend: (row) => q(`insert into send_log (idempotency_key, admin_id, session_id, session_name, recipient_email, subject, is_test, template_version, status, created_at)
                            values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(row.key, row.adminId, row.sessionId, row.sessionName, row.email, row.subject, row.test ? 1 : 0, row.version, row.now),
    markSendPending: (key) => q("update send_log set status = 'pending', error = null, completed_at = null where idempotency_key = ?").run(key),
    completeSend: (key, status, messageId, error, now) => {
      inFlight.delete(key);
      return q('update send_log set status = ?, provider_message_id = ?, error = ?, completed_at = ? where idempotency_key = ?')
        .run(status, messageId ?? null, error ?? null, now, key);
    },
    // Atomic claim (see src/store/sendClaim.js for the outcomes).
    claimSend: ({ key, adminId, sessionId, sessionName, email, subject, test, version, now, limit }) => {
      const fp = { adminId, sessionId, email, subject, test, version };
      db.exec('begin immediate');
      try {
        let result;
        const row = q('select * from send_log where idempotency_key = ?').get(key);
        if (row) {
          const decision = existingDecision(row, fp, { nowMs: now, claimedAtMs: row.created_at, inFlight: inFlight.has(key) });
          if (decision === 'reclaim') {
            q("update send_log set status = 'pending', error = null, completed_at = null where idempotency_key = ?").run(key);
            result = { outcome: 'reclaimed', row };
          } else {
            result = { outcome: decision, row };
          }
        } else if (q("select count(*) as n from send_log where admin_id = ? and created_at >= ? and status <> 'dry_run'").get(adminId, now - RATE_WINDOW_MS).n >= limit) {
          result = { outcome: 'rate_limited' };
        } else {
          q(`insert into send_log (idempotency_key, admin_id, session_id, session_name, recipient_email, subject, is_test, template_version, status, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
            .run(key, adminId, sessionId, sessionName, email, subject, test ? 1 : 0, version, now);
          result = { outcome: 'claimed' };
        }
        db.exec('commit');
        if (result.outcome === 'claimed' || result.outcome === 'reclaimed') inFlight.add(key);
        return result;
      } catch (err) {
        db.exec('rollback');
        throw err;
      }
    },
    countRecentSends: (adminId, since) => q("select count(*) as n from send_log where admin_id = ? and created_at >= ? and status <> 'dry_run'").get(adminId, since).n,
    // Counts of what the app itself recorded — attempts and outcomes, not
    // delivery (which only Resend knows).
    sendStats: (now) => {
      const r = q(`select count(*) as total,
                          coalesce(sum(is_test), 0) as tests,
                          coalesce(sum(status = 'accepted'), 0) as accepted,
                          coalesce(sum(status = 'dry_run'), 0) as dry_run,
                          coalesce(sum(status in ('rejected', 'failed')), 0) as failed,
                          coalesce(sum(status in ('ambiguous', 'pending')), 0) as unknown,
                          coalesce(sum(created_at >= ?), 0) as last_24h,
                          max(created_at) as last_at
                   from send_log`).get(now - 24 * 60 * 60 * 1000);
      return { ...r, last_at: r.last_at == null ? null : iso(r.last_at) };
    },
    recentSends: (limit) => q(`select l.created_at, l.session_id, l.session_name, l.recipient_email, l.subject, l.is_test, l.status,
                                      l.provider_message_id, l.error, a.email as sent_by
                               from send_log l join admins a on a.id = l.admin_id order by l.id desc limit ?`).all(limit)
      .map((r) => ({ ...r, created_at: iso(r.created_at), is_test: !!r.is_test })),

    // ---- campaigns (rules: src/store/campaignRules.js; schema: CAMPAIGNS above)
    campaignsAvailable: () => ({ available: true }),

    // Atomic confirmation: the campaign and every recipient, or nothing.
    // The same creation key always resolves to the one campaign it created.
    createCampaign: (c) => tx(() => {
      const existing = q('select * from campaigns where creation_key = ?').get(c.creationKey);
      if (existing) {
        const same = existing.created_by === c.adminId && existing.session_id === c.sessionId
          && existing.recipients_hash === c.recipientsHash && existing.template_hash === c.templateHash;
        return { outcome: same ? 'existing' : 'key_mismatch', campaignId: existing.id };
      }
      const open = q("select id from campaigns where session_id = ? and status in ('confirmed', 'sending', 'paused')").get(c.sessionId);
      if (open) return { outcome: 'session_busy', campaignId: open.id };
      q(`insert into campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
                                recipients_hash, total_recipients, csv_rows, invalid_rows, duplicate_rows, blank_rows, confirmed_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(c.id, c.creationKey, c.adminId, c.sessionId, c.sessionName, c.name, c.templateVersion, c.templateHash, c.recipientsHash,
          c.recipients.length, c.counts.total, c.counts.invalid, c.counts.duplicate, c.counts.blank, c.now, c.now);
      const ins = q(`insert into campaign_recipients (campaign_id, row_number, name, email, people, send_id, unsubscribe_hash, created_at, updated_at)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of c.recipients) ins.run(c.id, r.row, r.name, r.email, r.people ?? 1, r.sendId, r.unsubscribeHash, c.now, c.now);
      // Already opted out: kept in the campaign (for the record), never sent.
      const skip = q(`update campaign_recipients set status = 'skipped', reason = 'suppressed', completed_at = ?, updated_at = ?
                       where campaign_id = ? and email = ? and status = 'pending'`);
      for (const email of c.suppressedEmails ?? []) skip.run(c.now, c.now, c.id, email);
      return { outcome: 'created', campaignId: c.id };
    }),

    getCampaign: (id) => {
      const row = q(`${campaignSelect} where c.id = ?`).get(id);
      return row ? campaignOut(row, countsFrom(q(`select status, count(*) as n, sum(reason = 'suppressed') as sup from campaign_recipients where campaign_id = ? group by status`).all(id))) : null;
    },

    listCampaigns: (limit) => {
      const rows = q(`${campaignSelect} order by c.confirmed_at desc limit ?`).all(limit);
      const counts = q(`select campaign_id, status, count(*) as n, sum(reason = 'suppressed') as sup from campaign_recipients
                         where campaign_id in (select id from campaigns order by confirmed_at desc limit ?) group by campaign_id, status`).all(limit);
      return rows.map((r) => campaignOut(r, countsFrom(counts.filter((x) => x.campaign_id === r.id))));
    },

    listCampaignRecipients: (id, { offset = 0, limit = 50, status = null } = {}) => {
      const where = `campaign_id = ?${status ? ' and status = ?' : ''}`;
      const args = status ? [id, status] : [id];
      const total = q(`select count(*) as n from campaign_recipients where ${where}`).get(...args).n;
      const rows = q(`select row_number, name, email, people, status, attempts, reason, provider_message_id, next_attempt_at, updated_at, completed_at
                        from campaign_recipients where ${where} order by row_number limit ? offset ?`).all(...args, limit, offset)
        .map((r) => ({ ...r, next_attempt_at: isoOrNull(r.next_attempt_at), updated_at: iso(r.updated_at), completed_at: isoOrNull(r.completed_at) }));
      return { total, rows };
    },

    // Compare-and-swap on the campaign status (CAMPAIGN_ACTIONS). Cancelling
    // also marks every pending recipient skipped, in the same transaction.
    transitionCampaign: (id, action, { now, stopReason = null }) => tx(() => {
      const rule = CAMPAIGN_ACTIONS[action];
      const cur = q('select status from campaigns where id = ?').get(id);
      if (!cur) return { ok: false, notFound: true };
      if (!rule.from.includes(cur.status)) return { ok: false, status: cur.status };
      if (action === 'complete' && q("select 1 from campaign_recipients where campaign_id = ? and status in ('pending', 'claimed') limit 1").get(id)) {
        return { ok: false, status: cur.status, unfinished: true };
      }
      const set = {
        start: ["status = 'sending', started_at = ?, stop_reason = null", [now]],
        pause: ["status = 'paused', stop_reason = ?", [stopReason || 'admin']],
        resume: ["status = 'sending', stop_reason = null", []],
        cancel: ["status = 'cancelled', finished_at = ?, stop_reason = ?", [now, stopReason || 'admin']],
        complete: ["status = 'completed', finished_at = ?, stop_reason = null", [now]],
      }[action];
      q(`update campaigns set ${set[0]}, updated_at = ? where id = ? and status = ?`).run(...set[1], now, id, cur.status);
      if (action === 'cancel') {
        q("update campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = ?, updated_at = ? where campaign_id = ? and status = 'pending'")
          .run(now, now, id);
      }
      return { ok: true, from: cur.status, status: rule.to };
    }),

    // Claims ONE recipient for sending: only while the campaign is sending,
    // only when no other fresh claim of this campaign is in flight (one
    // provider request at a time per campaign), preferring a stale claim
    // (crashed worker) over the next due pending recipient. A claim counts
    // one attempt; claim_count is the compare-and-swap token for the outcome.
    claimNextRecipient: (id, { now, staleMs }) => tx(() => {
      const c = q('select status from campaigns where id = ?').get(id);
      if (!c) return { outcome: 'not_found' };
      if (c.status !== 'sending') return { outcome: 'not_sending', status: c.status };
      q(`update campaign_recipients set status = 'unresolved', reason = 'retries_exhausted', completed_at = ?, updated_at = ?
          where campaign_id = ? and status = 'claimed' and claimed_at <= ? and attempts >= ?`).run(now, now, id, now - staleMs, MAX_ATTEMPTS);
      if (q("select 1 from campaign_recipients where campaign_id = ? and status = 'claimed' and claimed_at > ? limit 1").get(id, now - staleMs)) {
        return { outcome: 'busy' };
      }
      const r = q(`select * from campaign_recipients
                    where campaign_id = ? and attempts < ?
                      and ((status = 'claimed' and claimed_at <= ?) or (status = 'pending' and (next_attempt_at is null or next_attempt_at <= ?)))
                    order by (status = 'claimed') desc, row_number limit 1`).get(id, MAX_ATTEMPTS, now - staleMs, now);
      if (!r) {
        const next = q("select min(next_attempt_at) as t from campaign_recipients where campaign_id = ? and status = 'pending' and attempts < ?").get(id, MAX_ATTEMPTS).t;
        return { outcome: 'idle', nextAttemptAt: next ?? null };
      }
      const u = q(`update campaign_recipients set status = 'claimed', claim_count = claim_count + 1, attempts = attempts + 1,
                          claimed_at = ?, first_attempt_at = coalesce(first_attempt_at, ?), updated_at = ?
                    where id = ? and claim_count = ?`).run(now, now, now, r.id, r.claim_count);
      if (u.changes !== 1) return { outcome: 'busy' };
      return {
        outcome: 'claimed',
        recipient: {
          id: r.id, row_number: r.row_number, name: r.name, email: r.email, people: r.people, send_id: r.send_id, unsubscribe_hash: r.unsubscribe_hash, reason: r.reason,
          claim_count: r.claim_count + 1, attempts: r.attempts + 1, first_attempt_at: r.first_attempt_at ?? now, taken_over: r.status === 'claimed',
        },
      };
    }),

    // Records an outcome — only if this worker still holds the claim
    // (status 'claimed' and the claim_count it was given).
    completeRecipient: ({ id, claimCount, status, reason = null, providerMessageId = null, nextAttemptAt = null, now }) => q(
      `update campaign_recipients set status = ?, reason = ?, provider_message_id = coalesce(?, provider_message_id),
              next_attempt_at = ?, completed_at = ?, updated_at = ?
        where id = ? and status = 'claimed' and claim_count = ?`)
      .run(status, reason, providerMessageId, nextAttemptAt, status === 'pending' ? null : now, now, id, claimCount).changes === 1,

    // Manual retry of failed (nothing accepted) or unresolved (same
    // idempotency key; only while Resend still remembers it) recipients.
    retryRecipients: (id, kind, { now, windowStart }) => tx(() => {
      const c = q('select status from campaigns where id = ?').get(id);
      if (!c) return { ok: false, notFound: true };
      if (c.status !== 'sending' && c.status !== 'paused') return { ok: false, status: c.status };
      const r = kind === 'unresolved'
        ? q(`update campaign_recipients set status = 'pending', next_attempt_at = null, completed_at = null, updated_at = ?
              where campaign_id = ? and status = 'unresolved' and attempts < ? and first_attempt_at >= ?`).run(now, id, MAX_ATTEMPTS, windowStart)
        : q(`update campaign_recipients set status = 'pending', next_attempt_at = null, completed_at = null, updated_at = ?
              where campaign_id = ? and status = 'failed' and attempts < ?`).run(now, id, MAX_ATTEMPTS);
      return { ok: true, retried: r.changes };
    }),

    // ---- suppression (src/unsubscribe.js)
    isSuppressed: (emailHash) => !!q('select 1 from suppressions where email_hash = ?').get(emailHash),
    suppressedAmong: (hashes) => q('select email_hash from suppressions where email_hash in (select value from json_each(?))').all(JSON.stringify(hashes)).map((r) => r.email_hash),
    findRecipientByUnsubscribeHash: (hash) => q('select campaign_id, email, created_at from campaign_recipients where unsubscribe_hash = ?').get(hash) ?? null,
    // Idempotent: the opt-out is recorded once; every pending recipient with
    // this address (any campaign) is skipped in the same transaction.
    recordUnsubscribe: ({ emailHash, email, campaignId, source, now }) => tx(() => {
      const created = q(`insert into suppressions (email_hash, reason, source, campaign_id, created_at) values (?, 'unsubscribe', ?, ?, ?)
                         on conflict (email_hash) do nothing`).run(emailHash, source, campaignId, now).changes === 1;
      const skipped = q(`update campaign_recipients set status = 'skipped', reason = 'suppressed', completed_at = ?, updated_at = ?
                          where email = ? and status = 'pending'`).run(now, now, email).changes;
      return { created, skipped };
    }),

    // Addresses of this list that an earlier campaign of the same session
    // already sent to (Resend accepted), for a review-time warning.
    previouslyAccepted: (sessionId, emails) => q(
      `select r.email, c.id as campaign_id, c.name as campaign_name, max(r.completed_at) as at
         from campaign_recipients r join campaigns c on c.id = r.campaign_id
        where c.session_id = ? and r.status = 'accepted' and r.email in (select value from json_each(?))
        group by r.email, c.id, c.name order by r.email`).all(sessionId, JSON.stringify(emails))
      .map((r) => ({ ...r, at: isoOrNull(r.at) })),
  };
}

function campaignOut(row, counts) {
  return {
    id: row.id, name: row.name, session_id: row.session_id, session_name: row.session_name, created_by: row.created_by_email ?? null,
    template_version: row.template_version, template_hash: row.template_hash, recipients_hash: row.recipients_hash,
    total_recipients: row.total_recipients, csv_rows: row.csv_rows, invalid_rows: row.invalid_rows,
    duplicate_rows: row.duplicate_rows, blank_rows: row.blank_rows, status: row.status, stop_reason: row.stop_reason,
    confirmed_at: iso(row.confirmed_at), started_at: isoOrNull(row.started_at), finished_at: isoOrNull(row.finished_at),
    updated_at: iso(row.updated_at), counts,
  };
}
