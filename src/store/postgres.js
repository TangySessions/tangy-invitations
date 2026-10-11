// PostgreSQL store — same methods and return shapes as the SQLite store
// (src/db.js), but every method returns a Promise. Used only when
// DB_BACKEND=postgres. All SQL is parameterized ($1, $2, …) and every table
// is schema-qualified (mailer.*).
//
// Times: the app passes millisecond timestamps (so tests can use a fake
// clock); they are stored as timestamptz. Values the app does arithmetic on
// (session times, send created_at) come back as milliseconds, display values
// as ISO strings — exactly as from SQLite.
//
// Connections: a small pool (PG_POOL_MAX, default 3) suits serverless. Every
// checkout is released in `finally`; a client whose rollback failed is
// destroyed rather than returned to the pool. Every transaction SETs LOCAL
// statement_timeout and idle_in_transaction_session_timeout, so these limits
// hold even when the startup parameters are switched off for a pooler
// (PG_STARTUP_PARAMS). Single statements outside a transaction are bounded by
// the client-side query_timeout and by role-level settings on the server.
// No transaction is ever held open while calling Resend: claimSend and
// completeSend are separate short transactions.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { poolOptions, safeDbError } from './pgConfig.js';
import { existingDecision, RATE_WINDOW_MS } from './sendClaim.js';
import { LOGIN_POLICY, limiterKeys } from '../auth.js';
import { CAMPAIGN_ACTIONS, MAX_ATTEMPTS, countsFrom } from './campaignRules.js';

// Schema versions this code can run on. Version 1 (0001_init) is everything
// except campaigns; version 2 (0002_campaigns) adds them. Applying 0002 to a
// real database is gated separately (APPROVED_MIGRATION_VERSION in
// pgMigrate.js); on version 1 the app runs and reports campaigns as
// unavailable. Anything older or newer is refused at startup.
export const MIN_SCHEMA_VERSION = 1;
export const MAX_SCHEMA_VERSION = 2;
export const CAMPAIGNS_SCHEMA_VERSION = 2;
// Compare-and-swap reclaim: succeeds only if nobody re-claimed the row since
// it was read ($3 = the claim_count that was read).
export const RECLAIM_SQL = `update mailer.send_log
    set status = 'pending', error = null, completed_at = null, claimed_at = to_timestamp($2::float8 / 1000.0), claim_count = claim_count + 1
  where idempotency_key = $1 and claim_count = $3 and status in ('ambiguous', 'pending')
  returning id`;
const SLOTS = ['s1', 's2', 's3', 's4'];
const ms = (col) => `(extract(epoch from ${col}) * 1000)::float8`;
const ts = (n) => `to_timestamp($${n}::float8 / 1000.0)`;
const iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const label = (row) => row.name || `Session ${SLOTS.indexOf(row.id) + 1}`;

function toSession(row) {
  if (!row) return null;
  return {
    id: row.id, slot: row.slot, label: label(row), name: row.name,
    configured: row.configured, active: row.active, version: row.version,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), updated_by: row.updated_by_email ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function campaignOut(row, counts) {
  return {
    id: row.id, name: row.name, session_id: row.session_id, session_name: row.session_name, created_by: row.created_by_email ?? null,
    template_version: row.template_version, template_hash: row.template_hash, recipients_hash: row.recipients_hash,
    total_recipients: row.total_recipients, csv_rows: row.csv_rows, invalid_rows: row.invalid_rows,
    duplicate_rows: row.duplicate_rows, blank_rows: row.blank_rows, status: row.status, stop_reason: row.stop_reason,
    confirmed_at: iso(row.confirmed_at), started_at: iso(row.started_at), finished_at: iso(row.finished_at),
    updated_at: iso(row.updated_at), counts,
  };
}

function sendRow(r) {
  return r && {
    ...r,
    admin_id: Number(r.admin_id),
    template_version: Number(r.template_version),
    created_at: Math.round(r.created_ms),
    claimed_at: Math.round(r.claimed_ms),
    completed_at: r.completed_ms == null ? null : Math.round(r.completed_ms),
  };
}

export async function openPgStore(dbConfig, { url = dbConfig.url, log = console, now = Date.now } = {}) {
  const pool = new pg.Pool(poolOptions(dbConfig, url));
  // An idle client dying (e.g. the server restarted) must not crash the process.
  pool.on('error', (err) => log.error?.(`[db] idle connection error: ${safeDbError(err)}`));
  const stmtTimeout = Math.trunc(Number(dbConfig.statementTimeoutMs) || 10_000);
  const idleTxTimeout = Math.trunc(Number(dbConfig.idleInTxTimeoutMs) || 15_000);

  const one = async (text, values) => (await pool.query({ text, values })).rows[0];
  const all = async (text, values) => (await pool.query({ text, values })).rows;

  async function tx(fn) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('begin');
      // Integers from validated config — not user input.
      await client.query(`set local statement_timeout = ${stmtTimeout}; set local idle_in_transaction_session_timeout = ${idleTxTimeout}`);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (err) {
      try { await client.query('rollback'); } catch { broken = true; }
      throw err;
    } finally {
      client.release(broken);
    }
  }

  let schemaV = null;
  const campaignSelect = `select c.*, a.email as created_by_email from mailer.campaigns c join mailer.admins a on a.id = c.created_by`;
  const sessionSelect = `select t.*, a.email as updated_by_email
                           from mailer.session_templates t left join mailer.admins a on a.id = t.updated_by`;
  const sendSelect = `select l.*, ${ms('l.created_at')} as created_ms, ${ms('l.claimed_at')} as claimed_ms,
                             ${ms('l.completed_at')} as completed_ms
                        from mailer.send_log l`;

  const store = {
    backend: 'postgres',
    pool,
    transaction: tx,
    close: () => pool.end(),

    async schemaVersion() {
      const r = await one('select coalesce(max(version), 0)::int as v from mailer.schema_migrations');
      schemaV = r.v;
      return r.v;
    },
    // Refuses to run against an unmigrated or newer-than-code database.
    async assertSchema() {
      let v;
      try { v = await store.schemaVersion(); } catch (err) {
        // 42P01 undefined_table / 3F000 invalid_schema_name: not migrated.
        if (err.code === '42P01' || err.code === '3F000') throw new Error('PostgreSQL schema is missing. Run: npm run db:migrate');
        throw new Error(`Could not query PostgreSQL (${safeDbError(err)}). Check the connection settings and that the database is reachable.`);
      }
      if (v < MIN_SCHEMA_VERSION) throw new Error(`PostgreSQL schema version is ${v}, this code needs at least ${MIN_SCHEMA_VERSION}. Run: npm run db:migrate`);
      if (v > MAX_SCHEMA_VERSION) throw new Error(`PostgreSQL schema version is ${v}, newer than this code supports (${MAX_SCHEMA_VERSION}). Deploy the matching code.`);
      return v;
    },

    // ---- campaigns (rules: campaignRules.js; schema: migrations/postgres/0002_campaigns.sql)
    async campaignsAvailable() {
      const v = schemaV ?? await store.schemaVersion();
      return v >= CAMPAIGNS_SCHEMA_VERSION
        ? { available: true }
        : {
          available: false, schema_version: v, required_version: CAMPAIGNS_SCHEMA_VERSION,
          reason: `Campaigns need database schema version ${CAMPAIGNS_SCHEMA_VERSION} (migration 0002_campaigns). This database is at version ${v}: the migration has not been applied to this database yet. Reviewing a list still works; confirming and sending campaigns is unavailable.`,
        };
    },

    // Atomic confirmation (one transaction): the campaign and every
    // recipient, or nothing (0002 also re-checks the total at commit). The
    // creation key resolves repeated/concurrent confirmations to one campaign.
    createCampaign: (c) => tx(async (cl) => {
      // Serializes confirmations per session (and per key) so the outcome is
      // a clean answer, never a unique-violation error.
      await cl.query('select pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', ['tangy-campaign-confirm', c.sessionId]);
      const { rows: [existing] } = await cl.query('select id, created_by, session_id, recipients_hash, template_hash from mailer.campaigns where creation_key = $1', [c.creationKey]);
      if (existing) {
        const same = Number(existing.created_by) === Number(c.adminId) && existing.session_id === c.sessionId
          && existing.recipients_hash === c.recipientsHash && existing.template_hash === c.templateHash;
        return { outcome: same ? 'existing' : 'key_mismatch', campaignId: existing.id };
      }
      const { rows: [open] } = await cl.query("select id from mailer.campaigns where session_id = $1 and status in ('confirmed', 'sending', 'paused')", [c.sessionId]);
      if (open) return { outcome: 'session_busy', campaignId: open.id };
      await cl.query(
        `insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
                                       recipients_hash, total_recipients, csv_rows, invalid_rows, duplicate_rows, blank_rows, confirmed_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, ${ts(15)}, ${ts(15)})`,
        [c.id, c.creationKey, c.adminId, c.sessionId, c.sessionName, c.name, c.templateVersion, c.templateHash, c.recipientsHash,
          c.recipients.length, c.counts.total, c.counts.invalid, c.counts.duplicate, c.counts.blank, c.now]);
      await cl.query(
        `insert into mailer.campaign_recipients (campaign_id, row_number, name, email, people, send_id, unsubscribe_hash, created_at, updated_at)
         select $1::uuid, r.row_number, r.name, r.email, r.people, r.send_id, r.unsubscribe_hash, ${ts(5)}, ${ts(5)}
           from unnest($2::int[], $3::text[], $4::text[], $6::uuid[], $7::text[], $8::smallint[]) as r(row_number, name, email, send_id, unsubscribe_hash, people)`,
        [c.id, c.recipients.map((r) => r.row), c.recipients.map((r) => r.name), c.recipients.map((r) => r.email), c.now,
          c.recipients.map((r) => r.sendId), c.recipients.map((r) => r.unsubscribeHash), c.recipients.map((r) => r.people ?? 1)]);
      // Already opted out: kept in the campaign (for the record), never sent.
      if (c.suppressedEmails?.length) {
        await cl.query(`update mailer.campaign_recipients set status = 'skipped', reason = 'suppressed', completed_at = ${ts(2)}, updated_at = ${ts(2)}
                         where campaign_id = $1 and status = 'pending' and email = any($3::text[])`, [c.id, c.now, c.suppressedEmails]);
      }
      return { outcome: 'created', campaignId: c.id };
    }),

    getCampaign: async (id) => {
      if (!UUID_RE.test(String(id))) return null;
      const row = await one(`${campaignSelect} where c.id = $1`, [id]);
      if (!row) return null;
      return campaignOut(row, countsFrom(await all(`select status, count(*)::int as n, count(*) filter (where reason = 'suppressed')::int as sup
                                                      from mailer.campaign_recipients where campaign_id = $1 group by status`, [id])));
    },

    listCampaigns: async (limit) => {
      const rows = await all(`${campaignSelect} order by c.confirmed_at desc limit $1`, [limit]);
      const counts = rows.length ? await all(`select campaign_id, status, count(*)::int as n, count(*) filter (where reason = 'suppressed')::int as sup
                                                from mailer.campaign_recipients where campaign_id = any($1::uuid[]) group by campaign_id, status`, [rows.map((r) => r.id)]) : [];
      return rows.map((r) => campaignOut(r, countsFrom(counts.filter((x) => x.campaign_id === r.id))));
    },

    listCampaignRecipients: async (id, { offset = 0, limit = 50, status = null } = {}) => {
      const args = status ? [id, status] : [id];
      const where = `campaign_id = $1${status ? ' and status = $2' : ''}`;
      const { n: total } = await one(`select count(*)::int as n from mailer.campaign_recipients where ${where}`, args);
      const rows = (await all(
        `select row_number, name, email, people, status, attempts, reason, provider_message_id, next_attempt_at, updated_at, completed_at
           from mailer.campaign_recipients where ${where} order by row_number limit $${args.length + 1} offset $${args.length + 2}`, [...args, limit, offset]))
        .map((r) => ({ ...r, next_attempt_at: iso(r.next_attempt_at), updated_at: iso(r.updated_at), completed_at: iso(r.completed_at) }));
      return { total, rows };
    },

    // Compare-and-swap on the status; the campaign row is locked FOR UPDATE,
    // so a pause/cancel waits for an in-progress claim transaction (and no
    // claim can start after it). Cancel also skips pending recipients.
    transitionCampaign: (id, action, { now, stopReason = null }) => tx(async (cl) => {
      const rule = CAMPAIGN_ACTIONS[action];
      const { rows: [cur] } = await cl.query('select status from mailer.campaigns where id = $1 for update', [id]);
      if (!cur) return { ok: false, notFound: true };
      if (!rule.from.includes(cur.status)) return { ok: false, status: cur.status };
      if (action === 'complete') {
        const { rowCount } = await cl.query("select 1 from mailer.campaign_recipients where campaign_id = $1 and status in ('pending', 'claimed') limit 1", [id]);
        if (rowCount) return { ok: false, status: cur.status, unfinished: true };
      }
      const set = {
        start: [`status = 'sending', started_at = ${ts(3)}, stop_reason = null`, [now]],
        pause: ["status = 'paused', stop_reason = $3", [stopReason || 'admin']],
        resume: ["status = 'sending', stop_reason = null", []],
        cancel: [`status = 'cancelled', finished_at = ${ts(3)}, stop_reason = $4`, [now, stopReason || 'admin']],
        complete: [`status = 'completed', finished_at = ${ts(3)}, stop_reason = null`, [now]],
      }[action];
      const nowParam = set[1].length + 3;
      await cl.query(`update mailer.campaigns set ${set[0]}, updated_at = ${ts(nowParam)} where id = $1 and status = $2`, [id, cur.status, ...set[1], now]);
      if (action === 'cancel') {
        await cl.query(`update mailer.campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = ${ts(2)}, updated_at = ${ts(2)}
                         where campaign_id = $1 and status = 'pending'`, [id, now]);
      }
      return { ok: true, from: cur.status, status: rule.to };
    }),

    // One recipient per call; see the SQLite store for the rules. The
    // campaign row is locked FOR UPDATE for the (short) claim transaction,
    // which serializes claimers of the same campaign.
    claimNextRecipient: (id, { now, staleMs }) => tx(async (cl) => {
      const { rows: [c] } = await cl.query('select status from mailer.campaigns where id = $1 for update', [id]);
      if (!c) return { outcome: 'not_found' };
      if (c.status !== 'sending') return { outcome: 'not_sending', status: c.status };
      await cl.query(`update mailer.campaign_recipients set status = 'unresolved', reason = 'retries_exhausted', completed_at = ${ts(2)}, updated_at = ${ts(2)}
                       where campaign_id = $1 and status = 'claimed' and claimed_at <= ${ts(3)} and attempts >= $4`, [id, now, now - staleMs, MAX_ATTEMPTS]);
      const busy = await cl.query(`select 1 from mailer.campaign_recipients where campaign_id = $1 and status = 'claimed' and claimed_at > ${ts(2)} limit 1`, [id, now - staleMs]);
      if (busy.rowCount) return { outcome: 'busy' };
      const { rows: [r] } = await cl.query(
        `select id, row_number, name, email, people, send_id, unsubscribe_hash, status, reason, claim_count, attempts, ${ms('first_attempt_at')} as first_ms
           from mailer.campaign_recipients
          where campaign_id = $1 and attempts < $2
            and ((status = 'claimed' and claimed_at <= ${ts(3)}) or (status = 'pending' and (next_attempt_at is null or next_attempt_at <= ${ts(4)})))
          order by (status = 'claimed') desc, row_number limit 1 for update skip locked`, [id, MAX_ATTEMPTS, now - staleMs, now]);
      if (!r) {
        const { rows: [n] } = await cl.query(`select ${ms('min(next_attempt_at)')} as t from mailer.campaign_recipients where campaign_id = $1 and status = 'pending' and attempts < $2`, [id, MAX_ATTEMPTS]);
        return { outcome: 'idle', nextAttemptAt: n?.t == null ? null : Math.round(n.t) };
      }
      const u = await cl.query(
        `update mailer.campaign_recipients set status = 'claimed', claim_count = claim_count + 1, attempts = attempts + 1,
                claimed_at = ${ts(3)}, first_attempt_at = coalesce(first_attempt_at, ${ts(3)}), updated_at = ${ts(3)}
          where id = $1 and claim_count = $2`, [r.id, r.claim_count, now]);
      if (u.rowCount !== 1) return { outcome: 'busy' };
      return {
        outcome: 'claimed',
        recipient: {
          id: Number(r.id), row_number: r.row_number, name: r.name, email: r.email, people: r.people, send_id: r.send_id, unsubscribe_hash: r.unsubscribe_hash, reason: r.reason,
          claim_count: r.claim_count + 1, attempts: r.attempts + 1, first_attempt_at: r.first_ms == null ? now : Math.round(r.first_ms), taken_over: r.status === 'claimed',
        },
      };
    }),

    completeRecipient: async ({ id, claimCount, status, reason = null, providerMessageId = null, nextAttemptAt = null, now }) => (await pool.query(
      `update mailer.campaign_recipients set status = $3, reason = $4, provider_message_id = coalesce($5, provider_message_id),
              next_attempt_at = ${ts(6)}, completed_at = case when $3 = 'pending' then null else ${ts(7)} end, updated_at = ${ts(7)}
        where id = $1 and status = 'claimed' and claim_count = $2`,
      [id, claimCount, status, reason, providerMessageId, nextAttemptAt, now])).rowCount === 1,

    retryRecipients: (id, kind, { now, windowStart }) => tx(async (cl) => {
      const { rows: [c] } = await cl.query('select status from mailer.campaigns where id = $1 for update', [id]);
      if (!c) return { ok: false, notFound: true };
      if (c.status !== 'sending' && c.status !== 'paused') return { ok: false, status: c.status };
      const r = kind === 'unresolved'
        ? await cl.query(`update mailer.campaign_recipients set status = 'pending', next_attempt_at = null, completed_at = null, updated_at = ${ts(3)}
                           where campaign_id = $1 and status = 'unresolved' and attempts < $2 and first_attempt_at >= ${ts(4)}`, [id, MAX_ATTEMPTS, now, windowStart])
        : await cl.query(`update mailer.campaign_recipients set status = 'pending', next_attempt_at = null, completed_at = null, updated_at = ${ts(3)}
                           where campaign_id = $1 and status = 'failed' and attempts < $2`, [id, MAX_ATTEMPTS, now]);
      return { ok: true, retried: r.rowCount };
    }),

    // ---- suppression (src/unsubscribe.js)
    isSuppressed: async (emailHash) => !!(await one('select 1 as x from mailer.suppressions where email_hash = $1', [emailHash])),
    suppressedAmong: async (hashes) => (hashes.length ? (await all('select email_hash from mailer.suppressions where email_hash = any($1::text[])', [hashes])).map((r) => r.email_hash) : []),
    findRecipientByUnsubscribeHash: async (hash) => {
      const r = await one(`select campaign_id, email, ${ms('created_at')} as created_ms from mailer.campaign_recipients where unsubscribe_hash = $1`, [hash]);
      return r ? { campaign_id: r.campaign_id, email: r.email, created_at: Math.round(r.created_ms) } : null;
    },
    // Idempotent; skips this address's pending recipients in every campaign
    // in the same transaction.
    recordUnsubscribe: ({ emailHash, email, campaignId, source, now }) => tx(async (cl) => {
      const ins = await cl.query(`insert into mailer.suppressions (email_hash, reason, source, campaign_id, created_at)
                                  values ($1, 'unsubscribe', $2, $3, ${ts(4)}) on conflict (email_hash) do nothing`, [emailHash, source, campaignId, now]);
      const upd = await cl.query(`update mailer.campaign_recipients set status = 'skipped', reason = 'suppressed', completed_at = ${ts(2)}, updated_at = ${ts(2)}
                                   where email = $1 and status = 'pending'`, [email, now]);
      return { created: ins.rowCount === 1, skipped: upd.rowCount };
    }),

    previouslyAccepted: async (sessionId, emails) => (await all(
      `select r.email, c.id as campaign_id, c.name as campaign_name, max(r.completed_at) as at
         from mailer.campaign_recipients r join mailer.campaigns c on c.id = r.campaign_id
        where c.session_id = $1 and r.status = 'accepted' and r.email = any($2::text[])
        group by r.email, c.id, c.name order by r.email`, [sessionId, emails]))
      .map((r) => ({ ...r, at: iso(r.at) })),

    // ---- admins (create / reset / disable need the owner connection)
    getAdminByEmail: (email) => one('select id, email, password_hash, disabled, created_at from mailer.admins where lower(email) = lower(btrim($1))', [String(email)]),
    getAdminById: (id) => one('select id, email, password_hash, disabled, created_at from mailer.admins where id = $1', [id]),
    listAdmins: async () => (await all('select id, email, disabled, created_at from mailer.admins order by id'))
      .map((a) => ({ ...a, created_at: iso(a.created_at) })),
    createAdmin: async (email, passwordHash) => {
      const r = await one('insert into mailer.admins (email, password_hash) values (lower(btrim($1)), $2) returning id', [String(email), passwordHash]);
      return { lastInsertRowid: r.id, changes: 1 };
    },
    setAdminPassword: async (email, passwordHash) => (await pool.query('update mailer.admins set password_hash = $2 where lower(email) = lower($1)', [email, passwordHash])).rowCount,
    setAdminDisabled: (email, disabled) => tx(async (c) => {
      const r = await c.query('update mailer.admins set disabled = $2 where lower(email) = lower($1) returning id', [email, !!disabled]);
      if (disabled && r.rows[0]) await c.query('delete from mailer.login_sessions where admin_id = $1', [r.rows[0].id]);
      return r.rowCount;
    }),
    deleteSessionsForAdmin: async (adminId) => (await pool.query('delete from mailer.login_sessions where admin_id = $1', [adminId])).rowCount,

    // ---- login sessions
    createSession: (tokenHash, adminId, csrf, now) => pool.query(
      `insert into mailer.login_sessions (token_hash, admin_id, csrf_token, created_at, last_seen) values ($1, $2, $3, ${ts(4)}, ${ts(4)})`,
      [tokenHash, adminId, csrf, now]),
    getSession: async (tokenHash) => {
      const r = await one(`select s.token_hash, s.admin_id, s.csrf_token, ${ms('s.created_at')} as created_ms, ${ms('s.last_seen')} as last_ms,
                                  a.email, a.disabled
                             from mailer.login_sessions s join mailer.admins a on a.id = s.admin_id where s.token_hash = $1`, [tokenHash]);
      return r && { token_hash: r.token_hash, admin_id: r.admin_id, csrf_token: r.csrf_token, created_at: Math.round(r.created_ms), last_seen: Math.round(r.last_ms), email: r.email, disabled: r.disabled };
    },
    touchSession: (tokenHash, now) => pool.query(`update mailer.login_sessions set last_seen = ${ts(2)} where token_hash = $1`, [tokenHash, now]),
    deleteSession: (tokenHash) => pool.query('delete from mailer.login_sessions where token_hash = $1', [tokenHash]),
    purgeSessions: (idleBefore, createdBefore) => pool.query(
      `delete from mailer.login_sessions where last_seen < ${ts(1)} or created_at < ${ts(2)}`, [idleBefore, createdBefore]),

    // ---- session templates
    listSessionTemplates: async () => (await all(`${sessionSelect} order by t.slot`)).map((row) => ({ ...toSession(row), subject: row.subject ?? '' })),
    getSessionTemplate: async (id) => {
      if (!SLOTS.includes(id)) return null;
      const row = await one(`${sessionSelect} where t.id = $1`, [id]);
      return row && { ...toSession(row), subject: row.subject ?? '', html: row.html ?? '', css: row.css, text: row.text_body };
    },
    // Single-statement optimistic concurrency, exactly like SQLite: only
    // this slot, only if the stored version is the one the editor loaded.
    saveSessionTemplate: async (id, { name, subject, html, css, text, active }, expectedVersion, adminId, now) => {
      if (!SLOTS.includes(id)) return { notFound: true };
      const r = await one(
        `update mailer.session_templates
            set name = $2, subject = $3, html = $4, css = $5, text_body = $6, active = $7, configured = true,
                version = version + 1, updated_at = ${ts(8)}, updated_by = $9
          where id = $1 and version = $10
      returning version`,
        [id, name, subject, html, css, text, !!active, now, adminId, expectedVersion]);
      if (r) return { version: r.version };
      const cur = await one('select version from mailer.session_templates where id = $1', [id]);
      return cur ? { conflict: true, currentVersion: cur.version } : { notFound: true };
    },

    // ---- send log
    findSend: async (key) => sendRow(await one(`${sendSelect} where l.idempotency_key = $1`, [key])),

    // Atomic claim (outcomes in src/store/sendClaim.js). One short
    // transaction:
    //   1. a transaction-scoped advisory lock per admin serializes that
    //      admin's claims, so the rate-limit count cannot be overshot;
    //   2. an existing row is locked FOR UPDATE and either re-claimed with a
    //      compare-and-swap on claim_count (ambiguous / stale pending, same
    //      attempt) or reported;
    //   3. a new row is inserted with ON CONFLICT DO NOTHING — if another
    //      admin's request inserted the same key concurrently, that row is
    //      read back and reported instead of raising a unique-violation.
    claimSend: ({ key, adminId, sessionId, sessionName, email, subject, test, version, now, limit }) => tx(async (c) => {
      const fp = { adminId, sessionId, email, subject, test, version };
      await c.query('select pg_advisory_xact_lock(hashtext($1::text), $2::int)', ['tangy-send-claim', adminId]);
      const decide = async (row) => {
        const d = existingDecision(row, fp, { nowMs: now, claimedAtMs: row.claimed_at });
        if (d !== 'reclaim') return { outcome: d, row };
        const r = await c.query(RECLAIM_SQL, [key, now, row.claim_count]);
        return r.rowCount === 1 ? { outcome: 'reclaimed', row } : { outcome: 'in_progress', row };
      };
      const existing = sendRow((await c.query(`${sendSelect} where l.idempotency_key = $1 for update`, [key])).rows[0]);
      if (existing) return decide(existing);

      const { rows: [{ n }] } = await c.query(
        `select count(*)::int as n from mailer.send_log where admin_id = $1 and created_at >= ${ts(2)} and status <> 'dry_run'`,
        [adminId, now - RATE_WINDOW_MS]);
      if (n >= limit) return { outcome: 'rate_limited' };

      const ins = await c.query(
        `insert into mailer.send_log (idempotency_key, admin_id, session_id, session_name, recipient_email, subject, is_test,
                                      template_version, status, created_at, claimed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', ${ts(9)}, ${ts(9)})
         on conflict (idempotency_key) do nothing returning id`,
        [key, adminId, sessionId, sessionName, email, subject, !!test, version, now]);
      if (ins.rowCount === 1) return { outcome: 'claimed' };
      // Lost a race with a concurrent insert of the same key.
      const raced = sendRow((await c.query(`${sendSelect} where l.idempotency_key = $1 for update`, [key])).rows[0]);
      return decide(raced);
    }),
    completeSend: (key, status, messageId, error, now) => pool.query(
      `update mailer.send_log set status = $2, provider_message_id = $3, error = $4, completed_at = ${ts(5)} where idempotency_key = $1`,
      [key, status, messageId ?? null, error ?? null, now]),
    countRecentSends: async (adminId, since) => (await one(
      `select count(*)::int as n from mailer.send_log where admin_id = $1 and created_at >= ${ts(2)} and status <> 'dry_run'`, [adminId, since])).n,
    recentSends: async (limit) => (await all(
      `select l.created_at, l.session_id, l.session_name, l.recipient_email, l.subject, l.is_test, l.status,
              l.provider_message_id, l.error, a.email as sent_by
         from mailer.send_log l join mailer.admins a on a.id = l.admin_id order by l.id desc limit $1`, [limit]))
      .map((r) => ({ ...r, created_at: iso(r.created_at) })),
    sendStats: async (now) => {
      const r = await one(
        `select count(*)::int as total,
                count(*) filter (where is_test)::int as tests,
                count(*) filter (where status = 'accepted')::int as accepted,
                count(*) filter (where status = 'dry_run')::int as dry_run,
                count(*) filter (where status in ('rejected', 'failed'))::int as failed,
                count(*) filter (where status in ('ambiguous', 'pending'))::int as unknown,
                count(*) filter (where created_at >= ${ts(1)})::int as last_24h,
                max(created_at) as last_at
           from mailer.send_log`, [now - 24 * 60 * 60 * 1000]);
      return { ...r, last_at: iso(r.last_at) };
    },

    createLoginLimiter: (opts = {}) => new PgLoginLimiter({ tx, now, ...opts }),
  };
  return store;
}

// ---------------------------------------------------------------------------
// Shared failed-login limiter (implements the interface in src/auth.js).
//
// Same policy as MemoryLoginLimiter: fixed window, 5 per email / 20 per IP,
// checked before the password, success clears the email's counter. To stay
// correct when many instances check at once, isBlocked() RESERVES the
// attempt atomically — it locks both counter rows, and only if neither is
// at its limit increments them — so concurrent guesses cannot all slip past
// a "check, then record" gap. recordFailure() therefore has nothing left to
// do; recordSuccess() clears the email counter and releases the IP
// reservation (successful sign-ins never count against an IP).
// Keys are stored as SHA-256 hashes, never as plain emails or IPs.
// ---------------------------------------------------------------------------
const keyHash = (k) => createHash('sha256').update(k).digest('hex');

export class PgLoginLimiter {
  constructor({ tx, now = Date.now, perEmail = LOGIN_POLICY.perEmail, perIp = LOGIN_POLICY.perIp, windowMs = LOGIN_POLICY.windowMs }) {
    Object.assign(this, { tx, now, perEmail, perIp, windowMs });
  }

  async isBlocked(email, ip) {
    const k = limiterKeys(email, ip);
    const eh = keyHash(k.email);
    const ih = keyHash(k.ip);
    const t = this.now();
    // Rows are always inserted and locked in key order, so two requests can
    // never wait on each other's rows in opposite orders (no deadlock).
    const [k1, k2] = [eh, ih].sort();
    return this.tx(async (c) => {
      await c.query(`insert into mailer.login_attempts (key_hash, window_start, failures)
                     values ($1, ${ts(3)}, 0), ($2, ${ts(3)}, 0) on conflict (key_hash) do nothing`, [k1, k2, t]);
      const { rows } = await c.query(
        `select key_hash, failures, ${ms('window_start')} as start_ms from mailer.login_attempts
          where key_hash = any($1::text[]) order by key_hash for update`, [[eh, ih]]);
      const live = (h) => {
        const r = rows.find((x) => x.key_hash === h);
        const expired = !r || t - r.start_ms > this.windowMs;
        return { count: expired ? 0 : r.failures, start: expired ? t : r.start_ms };
      };
      const e = live(eh);
      const i = live(ih);
      if (e.count >= this.perEmail || i.count >= this.perIp) return true;
      for (const [h, s] of [[eh, e], [ih, i]]) {
        await c.query(`update mailer.login_attempts set failures = $2, window_start = ${ts(3)} where key_hash = $1`, [h, s.count + 1, s.start]);
      }
      return false;
    });
  }

  async recordFailure() {
    // Already counted by isBlocked() (reservation). Nothing to undo.
  }

  async recordSuccess(email, ip) {
    const k = limiterKeys(email, ip ?? '');
    const t = this.now();
    await this.tx(async (c) => {
      await c.query('delete from mailer.login_attempts where key_hash = $1', [keyHash(k.email)]);
      if (ip != null) {
        await c.query('update mailer.login_attempts set failures = failures - 1 where key_hash = $1 and failures > 0', [keyHash(k.ip)]);
        await c.query('delete from mailer.login_attempts where key_hash = $1 and failures = 0', [keyHash(k.ip)]);
      }
      // Housekeeping: forget counters whose window ended long ago.
      await c.query(`delete from mailer.login_attempts where window_start < ${ts(1)}`, [t - 2 * this.windowMs]);
    });
  }
}
