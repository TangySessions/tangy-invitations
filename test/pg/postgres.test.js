// PostgreSQL-only integration tests. Run with `npm run test:pg` after
// `npm run pg:test:up` (a disposable local container). Every test uses its
// own fresh database; nothing here can reach a remote database.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate, listMigrations, APPROVED_MIGRATION_VERSION } from '../../src/store/pgMigrate.js';
import { openPgStore } from '../../src/store/postgres.js';
import { LOGIN_POLICY } from '../../src/auth.js';
import { STALE_PENDING_MS } from '../../src/store/sendClaim.js';
import { pgDatabase, dropDatabase, pgTestDbConfig, PG } from '../helpers/testStore.js';

if (!PG || !process.env.PG_TEST_URL) throw new Error('PostgreSQL tests need the disposable test database: npm run pg:test:up, then npm run test:pg');

const quiet = { error() {}, info() {} };
const opened = [];
const dbs = [];
after(async () => {
  for (const s of opened) await s.close().catch(() => {});
  for (const d of dbs) await dropDatabase(d).catch(() => {});
});

async function fresh() {
  const info = await pgDatabase(':memory:');
  dbs.push(info.name);
  return info;
}
async function store(url, opts = {}) {
  const s = await openPgStore({ ...pgTestDbConfig, ...(opts.config || {}) }, { url, log: quiet, ...opts });
  opened.push(s);
  return s;
}
async function client(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
async function rejects(promise, code, label) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: expected an error`);
  if (code) assert.equal(err.code, code, `${label}: ${err.code} ${err.message}`);
}
const ADMIN_HASH = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';

// ------------------------------------------------------------- migrations --
test('fresh database: schema version, exactly four unconfigured slots, checksums recorded', async () => {
  const info = await fresh();
  const s = await store(info.runtimeUrl);
  assert.equal(await s.assertSchema(), APPROVED_MIGRATION_VERSION);
  const slots = await s.listSessionTemplates();
  assert.deepEqual(slots.map((x) => [x.id, x.slot, x.configured, x.version, x.label]), [
    ['s1', 1, false, 0, 'Session 1'], ['s2', 2, false, 0, 'Session 2'], ['s3', 3, false, 0, 'Session 3'], ['s4', 4, false, 0, 'Session 4']]);
  const c = await client(info.ownerUrl);
  const { rows } = await c.query('select version, name, checksum from mailer.schema_migrations');
  await c.end();
  // Only approved migrations are applied by default (see test/pg/campaigns.test.js for 0002).
  assert.deepEqual(rows.map((r) => [r.version, r.name, r.checksum]), listMigrations().filter((m) => m.version <= APPROVED_MIGRATION_VERSION).map((m) => [m.version, m.name, m.checksum]));
});

test('re-running migrations changes nothing: no duplicate slots, saved content preserved', async () => {
  const info = await fresh();
  const owner = await store(info.ownerUrl);
  await owner.createAdmin('a@tangy.test', ADMIN_HASH);
  const admin = await owner.getAdminByEmail('a@tangy.test');
  await owner.saveSessionTemplate('s2', { name: 'Kept', subject: 'S', html: '<p>x</p>', css: '', text: '', active: true }, 0, admin.id, Date.now());
  const c = await client(info.ownerUrl);
  const r1 = await migrate(c);
  const r2 = await migrate(c);
  assert.deepEqual([r1.applied, r2.applied], [[], []]);
  const sql = listMigrations()[0].sql;
  await c.query(sql); // even executing the file again directly is harmless
  const { rows } = await c.query('select count(*)::int n from mailer.session_templates');
  await c.end();
  assert.equal(rows[0].n, 4);
  const s2 = await owner.getSessionTemplate('s2');
  assert.deepEqual([s2.name, s2.subject, s2.version], ['Kept', 'S', 1]);
});

test('an applied migration that was edited is refused (checksum)', async () => {
  const info = await fresh();
  const c = await client(info.ownerUrl);
  await c.query("update mailer.schema_migrations set checksum = repeat('0', 64) where version = 1");
  await rejects(migrate(c), null, 'tampered checksum');
  await c.end();
});

test('the app refuses an unmigrated database', async () => {
  const info = await fresh();
  const c = await client(info.ownerUrl);
  await c.query('delete from mailer.schema_migrations');
  await c.end();
  const s = await store(info.ownerUrl);
  await assert.rejects(s.assertSchema(), /schema version is 0/);
});

// ------------------------------------------------------------ constraints --
test('constraints: slots, content rule, statuses, emails, foreign keys', async () => {
  const info = await fresh();
  const c = await client(info.ownerUrl);
  try {
    await rejects(c.query("insert into mailer.session_templates (id, slot) values ('s5', 5)"), '23514', 'slot s5');
    await rejects(c.query("insert into mailer.session_templates (id, slot) values ('s1', 1)"), '23505', 'duplicate slot');
    await rejects(c.query("update mailer.session_templates set slot = 2 where id = 's1'"), '23514', 'slot reuse (blocked by slot = id check, before uniqueness)');
    await rejects(c.query("update mailer.session_templates set configured = true where id = 's2'"), '23514', 'configured without content');
    await c.query('insert into mailer.admins (email, password_hash) values ($1, $2)', ['ann@tangy.test', ADMIN_HASH]);
    await rejects(c.query('insert into mailer.admins (email, password_hash) values ($1, $2)', ['ANN@tangy.test', ADMIN_HASH]), '23514', 'mixed-case email stored');
  } finally { await c.end(); }
  // Case-insensitive uniqueness through the store (stores lower-case).
  const info2 = await fresh();
  const o = await store(info2.ownerUrl);
  await o.createAdmin('Ann@Tangy.test', ADMIN_HASH);
  await rejects(o.createAdmin('ann@tangy.TEST', ADMIN_HASH), '23505', 'case-insensitive unique email');
  assert.equal((await o.getAdminByEmail('ANN@TANGY.TEST')).email, 'ann@tangy.test', 'lookup is case-insensitive; stored lower-case');
  const admin = await o.getAdminByEmail('ann@tangy.test');
  const c2 = await client(info2.ownerUrl);
  try {
    await rejects(c2.query(`insert into mailer.send_log (idempotency_key, admin_id, recipient_email, subject, is_test, template_version, status, created_at, claimed_at)
                            values ($1, $2, 'x@y.z', 's', false, 1, 'sent', now(), now())`, [randomUUID(), admin.id]), '23514', 'invalid status');
    await rejects(c2.query(`insert into mailer.send_log (idempotency_key, admin_id, recipient_email, subject, is_test, template_version, status, created_at, claimed_at)
                            values ($1, 99999, 'x@y.z', 's', false, 1, 'pending', now(), now())`, [randomUUID()]), '23503', 'unknown admin');
    await rejects(c2.query(`insert into mailer.send_log (idempotency_key, admin_id, session_id, recipient_email, subject, is_test, template_version, status, created_at, claimed_at)
                            values ($1, $2, 's9', 'x@y.z', 's', false, 1, 'pending', now(), now())`, [randomUUID(), admin.id]), '23503', 'unknown session');
    const key = randomUUID();
    const ins = `insert into mailer.send_log (idempotency_key, admin_id, recipient_email, subject, is_test, template_version, status, created_at, claimed_at)
                 values ($1, $2, 'x@y.z', 's', false, 1, 'pending', now(), now())`;
    await c2.query(ins, [key, admin.id]);
    await rejects(c2.query(ins, [key, admin.id]), '23505', 'duplicate send id');
    await rejects(c2.query('delete from mailer.admins where id = $1', [admin.id]), '23503', 'admin with send history cannot be deleted');
    await rejects(c2.query("insert into mailer.login_sessions values ('nothex', $1, 'abcdefghijklmnopqrstuvwxyz', now(), now())", [admin.id]), '23514', 'session token must be a hash');
  } finally { await c2.end(); }
});

// ----------------------------------------------------- least privilege --
test('runtime role: app operations only — no DDL, no account changes, no slot insert/delete, no history delete', async () => {
  const info = await fresh();
  const owner = await store(info.ownerUrl);
  await owner.createAdmin('ann@tangy.test', ADMIN_HASH);
  const c = await client(info.runtimeUrl);
  try {
    const denied = [
      'create table mailer.evil (x int)',
      'drop table mailer.send_log',
      'alter table mailer.admins add column x int',
      'truncate mailer.login_attempts',
      "insert into mailer.admins (email, password_hash) values ('x@y.z', 'scrypt$x')",
      "update mailer.admins set disabled = true",
      "delete from mailer.admins",
      "insert into mailer.session_templates (id, slot) values ('s1', 1)",
      "delete from mailer.session_templates where id = 's1'",
      'delete from mailer.send_log',
      'delete from mailer.schema_migrations',
      'create table public.evil (x int)',
    ];
    for (const sql of denied) await rejects(c.query(sql), '42501', sql);
    const { rows } = await c.query("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user");
    assert.deepEqual(rows[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
  } finally { await c.end(); }
});

test('row-level security: a role outside mailer_runtime sees nothing, even with table grants', async () => {
  const info = await fresh();
  const o = await client(info.ownerUrl);
  const role = `tangy_outsider_${randomBytes(3).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  try {
    await o.query("insert into mailer.admins (email, password_hash) values ('ann@tangy.test', $1)", [ADMIN_HASH]);
    await o.query(`create role ${role} login password '${pw}'`);
    const u = new URL(info.ownerUrl);
    u.username = role; u.password = pw;
    const outsider = await client(u.toString());
    await rejects(outsider.query('select * from mailer.admins'), '42501', 'no schema/table grant');
    await o.query(`grant usage on schema mailer to ${role}; grant select on mailer.admins, mailer.session_templates to ${role}`);
    const { rows } = await outsider.query('select count(*)::int n from mailer.admins');
    const { rows: slots } = await outsider.query('select count(*)::int n from mailer.session_templates');
    await outsider.end();
    assert.deepEqual([rows[0].n, slots[0].n], [0, 0], 'RLS hides every row');
  } finally {
    await o.query(`drop owned by ${role}; drop role if exists ${role}`).catch(() => {});
    await o.end();
  }
});

// ------------------------------------------------------- login sessions --
test('login sessions: create, read, touch, expire', async () => {
  const info = await fresh();
  const o = await store(info.ownerUrl);
  await o.createAdmin('ann@tangy.test', ADMIN_HASH);
  const admin = await o.getAdminByEmail('ann@tangy.test');
  const s = await store(info.runtimeUrl);
  const t0 = 1_700_000_000_000;
  const h = 'a'.repeat(64);
  await s.createSession(h, admin.id, 'csrf-token-0123456789abcdef', t0);
  const got = await s.getSession(h);
  assert.deepEqual([got.admin_id, got.email, got.created_at, got.last_seen, got.disabled], [admin.id, 'ann@tangy.test', t0, t0, false]);
  await s.touchSession(h, t0 + 5000);
  assert.equal((await s.getSession(h)).last_seen, t0 + 5000);
  await s.createSession('b'.repeat(64), admin.id, 'csrf-token-0123456789abcdef', t0 + 10 * 3600_000);
  await s.purgeSessions(t0 + 2 * 3600_000, t0 - 1); // idle cutoff after the first session's last_seen
  assert.equal(await s.getSession(h), undefined, 'idle session purged');
  assert.ok(await s.getSession('b'.repeat(64)), 'active session kept');
  await o.setAdminDisabled('ann@tangy.test', true);
  assert.equal(await s.getSession('b'.repeat(64)), undefined, 'disabling ends sessions');
});

// -------------------------------------------------------------- templates --
test('templates: version increments, stale updates conflict, concurrent saves → exactly one wins, other slots untouched', async () => {
  const info = await fresh();
  const o = await store(info.ownerUrl);
  await o.createAdmin('ann@tangy.test', ADMIN_HASH);
  const admin = await o.getAdminByEmail('ann@tangy.test');
  const a = await store(info.runtimeUrl);
  const b = await store(info.runtimeUrl);
  const tpl = (n) => ({ name: `N${n}`, subject: `S${n}`, html: `<p>${n}</p>`, css: '', text: '', active: true });
  assert.deepEqual(await a.saveSessionTemplate('s3', tpl(1), 0, admin.id, Date.now()), { version: 1 });
  assert.deepEqual(await a.saveSessionTemplate('s3', tpl(2), 0, admin.id, Date.now()), { conflict: true, currentVersion: 1 });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).saveSessionTemplate('s3', tpl(i + 10), 1, admin.id, Date.now())));
  assert.equal(results.filter((r) => r.version === 2).length, 1);
  assert.equal(results.filter((r) => r.conflict && r.currentVersion === 2).length, 9);
  for (const id of ['s1', 's2', 's4']) {
    const s = await a.getSessionTemplate(id);
    assert.deepEqual([s.configured, s.version, s.html], [false, 0, ''], id);
  }
  assert.equal(await a.getSessionTemplate('s5'), null);
  assert.deepEqual(await a.saveSessionTemplate('s5', tpl(1), 0, admin.id, Date.now()), { notFound: true });
});

// ---------------------------------------------------- shared login limiter --
test('login limiter is shared across instances (separate pools) and stores no plain emails or IPs', async () => {
  const info = await fresh();
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const A = (await store(info.runtimeUrl)).createLoginLimiter({ now });
  const B = (await store(info.runtimeUrl)).createLoginLimiter({ now });
  // 5 failed attempts spread over two instances block the email on both.
  for (let i = 0; i < 5; i++) {
    const l = i % 2 ? A : B;
    assert.equal(await l.isBlocked('Ann@Example.com', '10.0.0.1'), false);
    await l.recordFailure('Ann@Example.com', '10.0.0.1');
  }
  assert.equal(await A.isBlocked('ann@example.com', '10.0.0.9'), true);
  assert.equal(await B.isBlocked('ANN@example.com', '10.0.0.9'), true);
  assert.equal(await A.isBlocked('bob@example.com', '10.0.0.2'), false, 'other emails unaffected');
  clock += LOGIN_POLICY.windowMs; // exactly 15 min: still inside
  assert.equal(await B.isBlocked('ann@example.com', '10.0.0.9'), true);
  clock += 1;
  assert.equal(await A.isBlocked('ann@example.com', '10.0.0.9'), false, 'window over');
  const c = await client(info.ownerUrl);
  const { rows } = await c.query('select key_hash from mailer.login_attempts');
  await c.end();
  assert.ok(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.key_hash)), 'only hashes stored');
});

test('login limiter: concurrent guesses cannot exceed the limit; IP limit; success clears email and releases the IP slot', async () => {
  const info = await fresh();
  const s1 = await store(info.runtimeUrl);
  const s2 = await store(info.runtimeUrl);
  const A = s1.createLoginLimiter();
  const B = s2.createLoginLimiter();
  const answers = await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? A : B).isBlocked('target@example.com', `10.1.0.${i}`)));
  assert.equal(answers.filter((blocked) => !blocked).length, LOGIN_POLICY.perEmail, 'exactly 5 attempts allowed through, concurrently');

  const ipAnswers = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? A : B).isBlocked(`u${i}@example.com`, '10.9.9.9')));
  assert.equal(ipAnswers.filter((blocked) => !blocked).length, LOGIN_POLICY.perIp, 'exactly 20 per IP');

  // Success clears the email counter and does not count against the IP.
  const C = s1.createLoginLimiter();
  for (let i = 0; i < 4; i++) { assert.equal(await C.isBlocked('ok@example.com', '10.2.0.1'), false); await C.recordFailure('ok@example.com', '10.2.0.1'); }
  assert.equal(await C.isBlocked('ok@example.com', '10.2.0.1'), false); // 5th attempt reserved…
  await C.recordSuccess('OK@example.com', '10.2.0.1'); // …and it succeeds
  for (let i = 0; i < 4; i++) assert.equal(await C.isBlocked('ok@example.com', '10.2.0.1'), false, 'email counter was cleared');
  const c = await client(info.ownerUrl);
  const { createHash } = await import('node:crypto');
  const ipRow = (await c.query('select failures from mailer.login_attempts where key_hash = $1', [createHash('sha256').update('i:10.2.0.1').digest('hex')])).rows[0];
  await c.end();
  assert.equal(ipRow.failures, 8, '4 failures + 4 pending reservations; the successful attempt was released');
});

test('login limiter fails closed when the database is unreachable', async () => {
  const dead = await openPgStore({ ...pgTestDbConfig, connectTimeoutMs: 500 }, { url: 'postgres://nobody:wrong@127.0.0.1:1/none', log: quiet });
  await assert.rejects(dead.createLoginLimiter().isBlocked('a@b.co', '1.1.1.1'));
  await dead.close();
});

// ------------------------------------------------------------ send claims --
async function sendSetup() {
  const info = await fresh();
  const o = await store(info.ownerUrl);
  await o.createAdmin('ann@tangy.test', ADMIN_HASH);
  await o.createAdmin('bob@tangy.test', ADMIN_HASH);
  const ann = await o.getAdminByEmail('ann@tangy.test');
  const bob = await o.getAdminByEmail('bob@tangy.test');
  await o.saveSessionTemplate('s1', { name: 'One', subject: 'S', html: '<p>x</p>', css: '', text: '', active: true }, 0, ann.id, Date.now());
  const a = await store(info.runtimeUrl, { config: { poolMax: 5 } });
  const b = await store(info.runtimeUrl, { config: { poolMax: 5 } });
  const claim = (s, adminId, key, extra = {}) => s.claimSend({
    key, adminId, sessionId: 's1', sessionName: 'One', email: 'arjun@example.com', subject: 'S', test: false, version: 1, now: Date.now(), limit: 30, ...extra,
  });
  return { info, a, b, ann, bob, claim };
}

test('claims: concurrent requests for the same send id → exactly one claim, no errors', async () => {
  const { a, b, ann, claim } = await sendSetup();
  const key = randomUUID();
  const out = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(i % 2 ? a : b, ann.id, key)));
  assert.equal(out.filter((r) => r.outcome === 'claimed').length, 1);
  assert.equal(out.filter((r) => r.outcome === 'in_progress').length, 11);
});

test('claims: the same id inserted concurrently by two admins → one claim, one mismatch, no unique-violation error', async () => {
  const { a, b, ann, bob, claim } = await sendSetup();
  for (let round = 0; round < 5; round++) {
    const key = randomUUID();
    const out = await Promise.all([claim(a, ann.id, key), claim(b, bob.id, key)]);
    assert.deepEqual(out.map((r) => r.outcome).sort(), ['claimed', 'mismatch']);
  }
});

test('claims: concurrent retries of an uncertain send → exactly one reclaim; stale pending becomes reclaimable', async () => {
  const { a, b, ann, claim } = await sendSetup();
  const key = randomUUID();
  assert.equal((await claim(a, ann.id, key)).outcome, 'claimed');
  await a.completeSend(key, 'ambiguous', null, 'timed out', Date.now());
  const out = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(i % 2 ? a : b, ann.id, key)));
  assert.equal(out.filter((r) => r.outcome === 'reclaimed').length, 1);
  assert.equal(out.filter((r) => r.outcome === 'in_progress').length, 9);
  // Still pending (process "crashed"): reclaimable only after the stale window, measured from the latest claim.
  assert.equal((await claim(a, ann.id, key, { now: Date.now() + STALE_PENDING_MS - 5000 })).outcome, 'in_progress');
  assert.equal((await claim(b, ann.id, key, { now: Date.now() + STALE_PENDING_MS + 5000 })).outcome, 'reclaimed');
  // A finished send is never reclaimed.
  await a.completeSend(key, 'accepted', 'msg_1', null, Date.now());
  const done = await claim(a, ann.id, key);
  assert.deepEqual([done.outcome, done.row.provider_message_id], ['done', 'msg_1']);
});

test('claims: reclaim is a compare-and-swap — the worst-case interleaving of two retries lets only one win', async () => {
  const { info, a, ann, claim } = await sendSetup();
  const { RECLAIM_SQL } = await import('../../src/store/postgres.js');
  const key = randomUUID();
  await claim(a, ann.id, key);
  await a.completeSend(key, 'ambiguous', null, 'timed out', Date.now());
  // Two connections both read the row (no locks), then both try to reclaim.
  const c1 = await client(info.runtimeUrl);
  const c2 = await client(info.runtimeUrl);
  try {
    await c1.query('begin');
    await c2.query('begin');
    const read1 = (await c1.query('select claim_count from mailer.send_log where idempotency_key = $1', [key])).rows[0].claim_count;
    const read2 = (await c2.query('select claim_count from mailer.send_log where idempotency_key = $1', [key])).rows[0].claim_count;
    assert.equal(read1, read2);
    const r1 = await c1.query(RECLAIM_SQL, [key, Date.now(), read1]);
    const pending2 = c2.query(RECLAIM_SQL, [key, Date.now(), read2]); // blocks on c1's row lock
    await c1.query('commit');
    const r2 = await pending2; // re-checked after c1 committed: claim_count changed
    await c2.query('commit');
    assert.deepEqual([r1.rowCount, r2.rowCount], [1, 0]);
  } finally { await c1.end(); await c2.end(); }
});

test('claims: the per-admin rate limit holds under concurrency (dry runs and other admins excluded)', async () => {
  const { a, b, ann, bob, claim } = await sendSetup();
  const out = await Promise.all(Array.from({ length: 15 }, (_, i) => claim(i % 2 ? a : b, ann.id, randomUUID(), { limit: 4 })));
  assert.equal(out.filter((r) => r.outcome === 'claimed').length, 4);
  assert.equal(out.filter((r) => r.outcome === 'rate_limited').length, 11);
  assert.equal((await claim(a, bob.id, randomUUID(), { limit: 4 })).outcome, 'claimed', 'per admin');
  // A dry-run attempt does not count toward the limit.
  const k = randomUUID();
  assert.equal((await claim(a, bob.id, k, { limit: 2 })).outcome, 'claimed');
  await a.completeSend(k, 'dry_run', null, null, Date.now());
  assert.equal((await claim(a, bob.id, randomUUID(), { limit: 2 })).outcome, 'claimed');
});

test('send history and stats come back in the same shapes as SQLite', async () => {
  const { a, ann, claim } = await sendSetup();
  const k1 = randomUUID();
  const k2 = randomUUID();
  await claim(a, ann.id, k1);
  await a.completeSend(k1, 'accepted', 'msg_9', null, Date.now());
  await claim(a, ann.id, k2, { test: true });
  await a.completeSend(k2, 'dry_run', null, null, Date.now());
  const rows = await a.recentSends(25);
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['created_at', 'error', 'is_test', 'provider_message_id', 'recipient_email', 'sent_by', 'session_id', 'session_name', 'status', 'subject']);
  assert.match(rows[0].created_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(typeof rows[0].is_test, 'boolean');
  const st = await a.sendStats(Date.now());
  assert.deepEqual({ ...st, last_at: typeof st.last_at }, { total: 2, tests: 1, accepted: 1, dry_run: 1, failed: 0, unknown: 0, last_24h: 2, last_at: 'string' });
});

// --------------------------------------------- failures and connections --
test('database failure: errors surface (never hang), are safe to log, and pools clean up', async () => {
  const dead = await openPgStore({ ...pgTestDbConfig, connectTimeoutMs: 500 }, { url: 'postgres://ghost:hunter2-secret@127.0.0.1:1/nowhere', log: quiet });
  const started = Date.now();
  let err;
  try { await dead.getSession('a'.repeat(64)); } catch (e) { err = e; }
  assert.ok(err, 'rejects');
  assert.ok(Date.now() - started < 5000, 'within the connect timeout');
  const { safeDbError } = await import('../../src/store/pgConfig.js');
  assert.ok(!safeDbError(err).includes('hunter2'));
  await dead.close();

  // A failing transaction rolls back and returns its connection to the pool.
  const info = await fresh();
  const s = await store(info.runtimeUrl, { config: { poolMax: 2 } });
  for (let i = 0; i < 6; i++) {
    await assert.rejects(s.claimSend({ key: 'not-a-uuid', adminId: 1, sessionId: 's1', sessionName: 'x', email: 'a@b.co', subject: 's', test: false, version: 1, now: Date.now(), limit: 5 }));
  }
  assert.equal(s.pool.waitingCount, 0);
  assert.ok(s.pool.totalCount <= 2);
  assert.equal((await s.listSessionTemplates()).length, 4, 'pool still healthy after failures');
});

test('statement timeout applies inside transactions', async () => {
  const info = await fresh();
  const s = await store(info.ownerUrl, { config: { statementTimeoutMs: 300 } });
  const c = await s.pool.connect();
  try {
    await c.query('begin');
    await c.query('set local statement_timeout = 300');
    await rejects(c.query('select pg_sleep(2)'), '57014', 'canceled by statement timeout');
    await c.query('rollback');
  } finally { c.release(); }
});

test('app with an unreachable database: generic 500s, sign-in fails closed, no connection details in responses or logs', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../../src/app.js');
  const { loadConfig } = await import('../../src/config.js');
  const secretUrl = 'postgres://app_user:Sup3rSecretPw@127.0.0.1:1/nowhere';
  const dead = await openPgStore({ ...pgTestDbConfig, connectTimeoutMs: 500 }, { url: secretUrl, log: quiet });
  const logs = [];
  const log = { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
  const config = loadConfig({ APP_ORIGIN: 'http://app.test', EMAIL_DRY_RUN: 'true', EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', PREVIEW_TOKEN_SECRET: randomBytes(32).toString('base64url') });
  const server = createServer(createApp({ config, db: dead, log, loginLimiter: dead.createLoginLimiter() }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://app.test' }, body: JSON.stringify({ email: 'a@b.co', password: 'whatever-long-pass' }) });
    const loginText = await login.text();
    assert.equal(login.status, 500);
    assert.equal(login.headers.get('set-cookie'), null, 'no session issued');
    const list = await fetch(`${base}/api/sessions`, { headers: { Cookie: 'tm_session=abc' } });
    const listText = await list.text();
    assert.equal(list.status, 500);
    for (const text of [loginText, listText, logs.join('\n')]) {
      assert.ok(!text.includes('Sup3rSecretPw') && !text.includes('app_user') && !text.includes('postgres://'), 'nothing leaks');
    }
    assert.match(loginText, /Unexpected server error/);
  } finally {
    await new Promise((r) => server.close(r));
    await dead.close();
  }
});

// ------------------------------------------------ Phase 4B: pooler settings --
test('timeouts: SET LOCAL inside every transaction even with no startup parameters; startup params add session-wide limits', async () => {
  const info = await fresh();
  const show = async (q, name) => (await q.query(`show ${name}`)).rows[0][name];
  const none = await store(info.runtimeUrl, { config: { startupParams: [], statementTimeoutMs: 7000, idleInTxTimeoutMs: 9000 } });
  const inside = await none.transaction(async (c) => [await show(c, 'statement_timeout'), await show(c, 'idle_in_transaction_session_timeout')]);
  assert.deepEqual(inside, ['7s', '9s'], 'transaction limits applied without startup parameters');
  const outside = await none.pool.query('show statement_timeout');
  assert.equal(outside.rows[0].statement_timeout, '0', 'nothing sent at connection time');
  const appName = await none.pool.query('show application_name');
  assert.equal(appName.rows[0].application_name, '', 'application_name not sent');

  const all = await store(info.runtimeUrl, { config: { startupParams: ['application_name', 'statement_timeout', 'idle_in_transaction_session_timeout'], statementTimeoutMs: 7000, idleInTxTimeoutMs: 9000 } });
  const session = await all.pool.query("select current_setting('statement_timeout') st, current_setting('idle_in_transaction_session_timeout') it, current_setting('application_name') app");
  assert.deepEqual(session.rows[0], { st: '7s', it: '9s', app: 'tangy-invitations' });
});

test('db-migrate.js (real script) migrates an empty database with ONLY MIGRATION_DATABASE_URL; a second run applies nothing', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { ownerUrl, name } = await (await import('../helpers/testStore.js')).emptyPgDatabase();
  dbs.push(name);
  const env = { PATH: process.env.PATH, DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: ownerUrl, DATABASE_SSL: 'disable', PG_STARTUP_PARAMS: 'none' };
  const run = () => spawnSync(process.execPath, ['scripts/db-migrate.js'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /applied 0001_init[\s\S]*applied 0002_campaigns[\s\S]*2 applied, schema version 2/);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /0 applied, schema version 2/);
  const pw = new URL(ownerUrl).password;
  assert.ok(!(first.stdout + first.stderr + second.stdout + second.stderr).includes(pw), 'no password printed');
  const c = await client(ownerUrl);
  const { rows } = await c.query('select count(*)::int n from mailer.session_templates');
  await c.end();
  assert.equal(rows[0].n, 4);
});

test('admin.js (real script) manages accounts with ONLY MIGRATION_DATABASE_URL (no DATABASE_URL)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const info = await fresh();
  const env = { PATH: process.env.PATH, DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: info.ownerUrl, DATABASE_SSL: 'disable', PG_STARTUP_PARAMS: 'none' };
  const adminPw = randomBytes(16).toString('base64url');
  const run = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', ...args], { cwd: root, env, input, encoding: 'utf8', timeout: 60_000 });
  const created = run(['create', 'Owner.Test@Example.com'], `${adminPw}\n`);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created admin owner\.test@example\.com/i, 'echoes the address as typed');
  const listed = run(['list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^owner\.test@example\.com /m, 'stored lower-case');
  const out = created.stdout + created.stderr + listed.stdout + listed.stderr;
  assert.ok(!out.includes(adminPw) && !out.includes(new URL(info.ownerUrl).password), 'no secrets printed');
});

// ---------------------------------------- Phase 4C: runbook rehearsal (local) --
test('runbook rehearsal on a local empty database: owner check → migrate → 01_runtime_role.sql → 02_verify.sql → runtime check (read-only)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { readFileSync } = await import('node:fs');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { emptyPgDatabase } = await import('../helpers/testStore.js');
  const { scramVerifier } = await import('../../src/store/scram.js');
  const { ownerUrl, name } = await emptyPgDatabase();
  dbs.push(name);
  const node = (args, env, input) => spawnSync(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH, ...env }, input, encoding: 'utf8', timeout: 60_000 });
  const ownerEnv = { DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: ownerUrl, DATABASE_SSL: 'disable' };

  // 1. read-only owner check before anything exists
  const pre = node(['scripts/db-check.js', 'owner'], ownerEnv);
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  assert.match(pre.stdout, /not migrated yet/);
  assert.match(pre.stdout, /PASS {2}owner can create roles/);

  // 2. migrate (the real script)
  const mig = node(['scripts/db-migrate.js'], ownerEnv);
  assert.equal(mig.status, 0, mig.stderr);

  // 3. the actual role script, placeholders filled: verifier from the real script
  const password = `Rehearsal-${randomBytes(12).toString('hex')}`;
  const ver = node(['scripts/scram-verifier.js'], {}, `${password}\n`);
  assert.equal(ver.status, 0, ver.stderr);
  const roleSql = readFileSync(new URL('../../docs/supabase/01_runtime_role.sql', import.meta.url), 'utf8')
    .replaceAll('<MAX_CONNECTIONS>', '10').replaceAll('<SCRAM_VERIFIER>', ver.stdout.trim());
  assert.ok(!roleSql.includes(password), 'the SQL never contains the plaintext password');
  const owner = await client(ownerUrl);
  try {
    await owner.query('drop role if exists mailer_app');
    await owner.query(roleSql);

    // 4. every statement of the read-only verification script runs
    const verifySql = readFileSync(new URL('../../docs/supabase/02_verify.sql', import.meta.url), 'utf8');
    const statements = verifySql.split(/;\s*(?:--[^\n]*)?\n/).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
    assert.ok(statements.length >= 10);
    for (const s of statements) await owner.query(s);
    const { rows: [m] } = await owner.query("select pg_has_role('mailer_app', 'mailer_runtime', 'usage') as ok, (select rolconfig from pg_roles where rolname = 'mailer_app') as cfg");
    assert.equal(m.ok, true);
    assert.deepEqual(m.cfg.sort(), ['idle_in_transaction_session_timeout=15s', 'lock_timeout=5s', 'statement_timeout=10s']);

    // 5. PostgreSQL accepts the locally computed verifier: right password in, wrong out
    const u = new URL(ownerUrl);
    u.username = 'mailer_app';
    u.password = password;
    const runtimeUrl = u.toString();
    const ok = await client(runtimeUrl);
    assert.equal((await ok.query('select current_user u')).rows[0].u, 'mailer_app');
    assert.equal((await ok.query("show statement_timeout")).rows[0].statement_timeout, '10s', 'role-level timeout applies with no startup params');
    await ok.end();
    u.password = 'Wrong-password-0123456789abc';
    await assert.rejects(client(u.toString()), /password authentication failed/);

    // 6. runtime check, read-only, with and without startup parameters
    const before = (await owner.query("select (select count(*) from mailer.login_attempts) a, (select count(*) from mailer.send_log) s, (select string_agg(id || ':' || version, ',' order by id) from mailer.session_templates) t")).rows[0];
    for (const startup of ['all', 'none']) {
      const rt = node(['scripts/db-check.js', 'runtime'], { DB_BACKEND: 'postgres', DATABASE_URL: runtimeUrl, DATABASE_SSL: 'disable', PG_STARTUP_PARAMS: startup });
      assert.equal(rt.status, 0, rt.stdout + rt.stderr);
      assert.match(rt.stdout, /PASS {2}runtime role inherits mailer_runtime/);
      assert.match(rt.stdout, /PASS {2}privileges on mailer\.admins/);
      assert.match(rt.stdout, /PASS {2}SET LOCAL timeouts inside a transaction/);
      assert.match(rt.stdout, /PASS {2}parameterized query/);
      assert.match(rt.stdout, /4 rows visible/);
      assert.ok(!(rt.stdout + rt.stderr).includes(password));
    }
    const after = (await owner.query("select (select count(*) from mailer.login_attempts) a, (select count(*) from mailer.send_log) s, (select string_agg(id || ':' || version, ',' order by id) from mailer.session_templates) t")).rows[0];
    assert.deepEqual(after, before, 'db-check wrote nothing');

    // 7. owner check now sees the migrated schema and both roles
    const post = node(['scripts/db-check.js', 'owner'], ownerEnv);
    assert.equal(post.status, 0, post.stdout);
    assert.match(post.stdout, /schema_migrations version 2/);
    assert.match(post.stdout, /mailer_app \(login\), mailer_runtime/);
  } finally {
    await owner.query("select pg_terminate_backend(pid) from pg_stat_activity where usename = 'mailer_app'").catch(() => {});
    await owner.query('drop role if exists mailer_app').catch(() => {});
    await owner.end();
  }
});
