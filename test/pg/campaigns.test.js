// Migration 0002 (campaigns) against the disposable local PostgreSQL
// (npm run pg:test:up, then npm run test:pg). 0002 is not approved for real
// databases, so every database here is migrated to it EXPLICITLY
// (migrate(..., { target: 2 })). Nothing here can reach a remote database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import { migrate, listMigrations } from '../../src/store/pgMigrate.js';
import { openPgStore, MAX_SCHEMA_VERSION } from '../../src/store/postgres.js';
import { pgDatabase, emptyPgDatabase, dropDatabase, pgTestDbConfig, PG } from '../helpers/testStore.js';

if (!PG || !process.env.PG_TEST_URL) throw new Error('PostgreSQL tests need the disposable test database: npm run pg:test:up, then npm run test:pg');

const ADMIN_HASH = 'scrypt$32768$8$1$c2FsdA==$aGFzaA==';
const HEX = (s) => createHash('sha256').update(s).digest('hex');
const clients = [];
const dbs = [];
after(async () => {
  for (const c of clients) await c.end().catch(() => {});
  for (const d of dbs) await dropDatabase(d).catch(() => {});
});

async function client(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  clients.push(c);
  return c;
}
async function rejects(promise, code, label) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err, `${label}: expected an error`);
  if (code) assert.equal(err.code, code, `${label}: ${err.code} ${err.message}`);
  return err;
}

// A fresh database migrated to 0002, an admin, and connections as the owner
// and as the least-privilege runtime role (a member of mailer_runtime).
async function campaignDb() {
  const info = await pgDatabase(':memory:');
  dbs.push(info.name);
  const owner = await client(info.ownerUrl);
  const r = await migrate(owner, { target: 2 });
  assert.deepEqual(r.applied, ['0002_campaigns']);
  const { rows: [admin] } = await owner.query("insert into mailer.admins (email, password_hash) values ('ann@tangy.test', $1) returning id", [ADMIN_HASH]);
  const app = await client(info.runtimeUrl);
  return { info, owner, app, adminId: admin.id };
}

// Confirms a campaign the way the future confirmation endpoint will: one
// transaction, campaign row + every recipient in one statement.
// csv_rows mirrors the review's counts.total (data rows, header excluded);
// with no invalid/duplicate/blank rows it equals total_recipients.
async function confirm(c, { adminId, session = 's1', recipients = [['Asha', 'asha@example.com'], ['Ben', 'ben@example.com']], total = recipients.length, creationKey = randomUUID(), id = randomUUID() } = {}) {
  await c.query('begin');
  try {
    await c.query(
      `insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
                                     recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
       values ($1, $2, $3, $4, 'Folk Evening', 'Kickoff invites', 1, $5, $6, $7, $7, now(), now())`,
      [id, creationKey, adminId, session, HEX('template'), HEX(JSON.stringify(recipients)), total]);
    if (recipients.length) {
      await c.query(
        `insert into mailer.campaign_recipients (campaign_id, row_number, name, email, send_id, unsubscribe_hash, created_at, updated_at)
         select $1::uuid, r.n + 1, r.name, r.email, gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), now(), now()
           from unnest($2::text[], $3::text[]) with ordinality as r(name, email, n)`,
        [id, recipients.map((x) => x[0]), recipients.map((x) => x[1])]);
    }
    await c.query('commit');
  } catch (err) {
    await c.query('rollback').catch(() => {});
    throw err;
  }
  return id;
}
const setStatus = (c, id, status, extra = '') => c.query(`update mailer.campaigns set status = $2, updated_at = now() ${extra} where id = $1`, [id, status]);
const start = (c, id) => setStatus(c, id, 'sending', ', started_at = now()');
const recipientsOf = async (c, id) => (await c.query('select * from mailer.campaign_recipients where campaign_id = $1 order by row_number', [id])).rows;
// The claim the future worker will use: compare-and-swap on claim_count.
const claim = (c, r) => c.query(
  `update mailer.campaign_recipients set status = 'claimed', claim_count = claim_count + 1, claimed_at = now(), updated_at = now()
    where id = $1 and status = $2 and claim_count = $3 returning id`, [r.id, r.status, r.claim_count]);

// ---------------------------------------------------------------- runner --
test('0002 applies to a fresh database (from empty, and on top of 0001); re-running applies nothing; the file is re-runnable', async () => {
  const { ownerUrl, name } = await emptyPgDatabase();
  dbs.push(name);
  const c = await client(ownerUrl);
  const first = await migrate(c, { target: 2 });
  assert.deepEqual([first.applied, first.current], [['0001_init', '0002_campaigns'], 2]);
  const again = await migrate(c, { target: 2 });
  assert.deepEqual([again.applied, again.current], [[], 2]);
  await c.query(listMigrations()[1].sql); // executing the file again directly is harmless
  const { rows } = await c.query('select version, name, checksum from mailer.schema_migrations order by version');
  assert.deepEqual(rows.map((r) => [r.version, r.name, r.checksum]), listMigrations().map((m) => [m.version, m.name, m.checksum]));
});

test('without an explicit target the runner leaves a version-1 database at version 1 (0002 held)', async () => {
  const info = await pgDatabase(':memory:');
  dbs.push(info.name);
  const c = await client(info.ownerUrl);
  const r = await migrate(c);
  assert.deepEqual([r.applied, r.held, r.current], [[], ['0002_campaigns'], 1]);
  const { rows } = await c.query("select to_regclass('mailer.campaigns') is null as absent");
  assert.equal(rows[0].absent, true);
});

test('the app runs on version 2 with campaigns, on version 1 without them, and refuses a newer schema', async () => {
  const { info, owner } = await campaignDb();
  const quiet = { info() {}, error() {} };
  assert.equal(MAX_SCHEMA_VERSION, 2);
  const s2 = await openPgStore({ ...pgTestDbConfig }, { url: info.runtimeUrl, log: quiet });
  try {
    assert.equal(await s2.assertSchema(), 2);
    assert.deepEqual(await s2.campaignsAvailable(), { available: true });
  } finally { await s2.close(); }
  const v1 = await pgDatabase(':memory:');
  dbs.push(v1.name);
  const s1 = await openPgStore({ ...pgTestDbConfig }, { url: v1.runtimeUrl, log: quiet });
  try {
    assert.equal(await s1.assertSchema(), 1);
    const a = await s1.campaignsAvailable();
    assert.equal(a.available, false);
    assert.match(a.reason, /schema version 2 \(migration 0002_campaigns\).*version 1.*not been approved/);
  } finally { await s1.close(); }
  await owner.query("insert into mailer.schema_migrations (version, name, checksum) values (3, '0003_future', repeat('a', 64))");
  const s3 = await openPgStore({ ...pgTestDbConfig }, { url: info.runtimeUrl, log: quiet });
  try {
    await assert.rejects(s3.assertSchema(), /schema version is 3, newer than this code supports \(2\)/);
  } finally { await s3.close(); }
});

test('a failing 0002 leaves nothing behind (one transaction)', async () => {
  const info = await pgDatabase(':memory:');
  dbs.push(info.name);
  const c = await client(info.ownerUrl);
  // A conflicting object makes 0002 fail part-way (its indexes need columns
  // this table lacks); everything 0002 did before that is rolled back.
  await c.query('create table mailer.campaign_recipients (x int)');
  await rejects(migrate(c, { target: 2 }), null, 'conflicting table');
  const { rows } = await c.query("select to_regclass('mailer.campaigns') is null as absent, (select max(version) from mailer.schema_migrations) as v");
  assert.deepEqual([rows[0].absent, rows[0].v], [true, 1]);
});

// ------------------------------------------------------------ confirmation --
test('confirmation is all or nothing, and a list can never grow afterwards', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  assert.equal((await recipientsOf(app, id)).length, 2);
  // Too few recipients for the declared total: the commit fails, nothing is kept.
  const short = randomUUID();
  await rejects(confirm(app, { adminId, session: 's2', id: short, total: 3 }), '23514', 'incomplete list');
  assert.equal((await app.query('select count(*)::int n from mailer.campaigns where id = $1', [short])).rows[0].n, 0);
  // No recipients added later, in another transaction.
  await rejects(app.query(`insert into mailer.campaign_recipients (campaign_id, row_number, name, email, send_id, unsubscribe_hash, created_at, updated_at)
                           values ($1, 9, 'Late', 'late@example.com', gen_random_uuid(), repeat('b', 64), now(), now())`, [id]), '23514', 'late recipient');
});

test('repeated or concurrent confirmations with the same creation key create one campaign', async () => {
  const { info, app, adminId } = await campaignDb();
  const key = randomUUID();
  const other = await client(info.runtimeUrl);
  const results = await Promise.allSettled([confirm(app, { adminId, creationKey: key }), confirm(other, { adminId, creationKey: key })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, '23505');
  assert.equal((await app.query('select count(*)::int n from mailer.campaigns where creation_key = $1', [key])).rows[0].n, 1);
  // The endpoint's pattern: insert ... on conflict (creation_key) do nothing, then read the existing row.
  const { rowCount } = await app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
      recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
    values (gen_random_uuid(), $1, $2, 's3', 'X', 'X', 1, $3, $3, 1, 1, now(), now()) on conflict (creation_key) do nothing`, [key, adminId, HEX('x')]);
  assert.equal(rowCount, 0);
});

test('one open campaign per session: confirmed, sending and paused block a second; cancelled and completed do not', async () => {
  const { app, adminId } = await campaignDb();
  const a = await confirm(app, { adminId });
  await rejects(confirm(app, { adminId }), '23505', 'second confirmed campaign');
  await start(app, a);
  await rejects(confirm(app, { adminId }), '23505', 'while sending');
  await setStatus(app, a, 'paused', ", stop_reason = 'admin'");
  await rejects(confirm(app, { adminId }), '23505', 'while paused');
  const other = await confirm(app, { adminId, session: 's2' });
  assert.ok(other, 'other sessions are independent');
  await app.query("update mailer.campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = now(), updated_at = now() where campaign_id = $1", [a]);
  await setStatus(app, a, 'cancelled', ", stop_reason = 'admin', finished_at = now()");
  assert.ok(await confirm(app, { adminId }), 'allowed once the previous one is cancelled');
});

// ------------------------------------------------------------- constraints --
test('recipients: normalized unique emails, valid names, sane counters', async () => {
  const { app, adminId } = await campaignDb();
  await rejects(confirm(app, { adminId, recipients: [['A', 'a@example.com'], ['B', 'a@example.com']] }), '23505', 'duplicate email');
  for (const [name, email] of [['A', 'A@Example.com'], ['A', ' a@example.com'], ['A', 'a b@example.com'], ['A', 'noat'], ['', 'a@example.com'], [' A', 'a@example.com'], ['A{{x}}', 'a@example.com'], ['A\u0007', 'a@example.com'], ['x'.repeat(101), 'a@example.com']]) {
    await rejects(confirm(app, { adminId, recipients: [[name, email]] }), '23514', JSON.stringify([name, email]));
  }
  const id = await confirm(app, { adminId });
  const [r] = await recipientsOf(app, id);
  assert.deepEqual([r.status, r.attempts, r.claim_count], ['pending', 0, 0]);
  const bad = [
    "status = 'sent'", 'attempts = -1', 'claim_count = -1', 'attempts = 11',
    "status = 'accepted', completed_at = now()", // accepted needs a provider id
    "status = 'failed', completed_at = now()",   // failed needs a reason
    "status = 'skipped', reason = 'timeout', completed_at = now()",
    "reason = 'some free text'",
    "email = 'changed@example.com'", "name = 'Changed'", 'send_id = gen_random_uuid()', 'row_number = 99',
  ];
  for (const set of bad) await rejects(app.query(`update mailer.campaign_recipients set ${set} where id = $1`, [r.id]), null, set);
  assert.deepEqual((await recipientsOf(app, id))[0].status, 'pending', 'unchanged');
});

test('campaigns: status model, fixed details, counts that add up', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  for (const [set, label] of [
    ["status = 'completed', started_at = now(), finished_at = now()", 'confirmed → completed'],
    ["status = 'paused', stop_reason = 'admin', started_at = now()", 'confirmed → paused'],
    ['template_version = 2', 'template version fixed'],
    ["template_hash = repeat('a', 64)", 'template hash fixed'],
    ["recipients_hash = repeat('a', 64)", 'list fingerprint fixed'],
    ["session_id = 's2'", 'session fixed'],
    ['total_recipients = 3', 'total fixed'],
    ["status = 'sending'", 'sending needs started_at'],
  ]) await rejects(app.query(`update mailer.campaigns set ${set} where id = $1`, [id]), '23514', label);
  await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash, recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at, status, started_at)
    values (gen_random_uuid(), gen_random_uuid(), $1, 's4', 'X', 'X', 1, $2, $2, 1, 1, now(), now(), 'sending', now())`, [adminId, HEX('x')]), '23514', 'created as sending');
  await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash, recipients_hash, total_recipients, csv_rows, invalid_rows, confirmed_at, updated_at)
    values (gen_random_uuid(), gen_random_uuid(), $1, 's4', 'X', 'X', 1, $2, $2, 1, 1, 1, now(), now())`, [adminId, HEX('x')]), '23514', 'counts must add up');
  await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash, recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
    values (gen_random_uuid(), gen_random_uuid(), $1, 's9', 'X', 'X', 1, $2, $2, 1, 1, now(), now())`, [adminId, HEX('x')]), '23503', 'unknown session');
  await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash, recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
    values (gen_random_uuid(), gen_random_uuid(), 99999, 's4', 'X', 'X', 1, $1, $1, 1, 1, now(), now())`, [HEX('x')]), '23503', 'unknown admin');

  // Completing requires every recipient to be final.
  await start(app, id);
  await rejects(setStatus(app, id, 'completed', ', finished_at = now()'), '23514', 'pending recipients');
  await app.query("update mailer.campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = now(), updated_at = now() where campaign_id = $1", [id]);
  await setStatus(app, id, 'completed', ', finished_at = now()');
  await rejects(setStatus(app, id, 'sending'), '23514', 'completed is final');
});

// ----------------------------------------------------------------- claims --
test('claims: only while sending; compare-and-swap lets exactly one of two workers win; paused/cancelled stop new claims', async () => {
  const { info, app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  let [r] = await recipientsOf(app, id);
  await rejects(claim(app, r), '23514', 'campaign not started');
  await start(app, id);
  const other = await client(info.runtimeUrl);
  const [a, b] = await Promise.all([claim(app, r), claim(other, r)]);
  assert.equal(a.rowCount + b.rowCount, 1, 'exactly one claim');
  [r] = await recipientsOf(app, id);
  assert.deepEqual([r.status, r.claim_count], ['claimed', 1]);
  const [, pendingOne] = await recipientsOf(app, id);
  await rejects(app.query("update mailer.campaign_recipients set status = 'claimed', claimed_at = now(), updated_at = now() where id = $1", [pendingOne.id]), '23514', 'claim without incrementing');
  await rejects(app.query("update mailer.campaign_recipients set status = 'claimed', claim_count = 2, claimed_at = now(), updated_at = now() where id = $1", [pendingOne.id]), '23514', 'claim_count +2');
  // Take-over of a stale claim: claim_count goes 1 → 2, again compare-and-swap.
  const [x, y] = await Promise.all([claim(app, r), claim(other, r)]);
  assert.equal(x.rowCount + y.rowCount, 1);
  // Updates by the claim holder (recording the request) keep claim_count.
  [r] = await recipientsOf(app, id);
  assert.equal(r.claim_count, 2);
  await app.query("update mailer.campaign_recipients set attempts = 1, first_attempt_at = now(), updated_at = now() where id = $1", [r.id]);
  await rejects(app.query('update mailer.campaign_recipients set attempts = 3 where id = $1', [r.id]), '23514', 'attempts +1 at a time');
  await app.query("update mailer.campaign_recipients set status = 'accepted', provider_message_id = 'msg_1', completed_at = now(), updated_at = now() where id = $1", [r.id]);
  await rejects(app.query("update mailer.campaign_recipients set status = 'pending', completed_at = null where id = $1", [r.id]), '23514', 'accepted is final');

  // Paused: the second recipient cannot be claimed.
  await setStatus(app, id, 'paused', ", stop_reason = 'admin'");
  const [, r2] = await recipientsOf(app, id);
  await rejects(claim(app, r2), '23514', 'paused');
  await setStatus(app, id, 'cancelled', ", finished_at = now()");
  await rejects(claim(app, r2), '23514', 'cancelled');
});

test('claims: batch claiming with SKIP LOCKED gives two workers disjoint recipients', async () => {
  const { info, app, adminId } = await campaignDb();
  const list = Array.from({ length: 10 }, (_, i) => [`R${i}`, `r${i}@example.com`]);
  const id = await confirm(app, { adminId, recipients: list });
  await start(app, id);
  const other = await client(info.runtimeUrl);
  const batch = (c) => c.query(
    `update mailer.campaign_recipients r set status = 'claimed', claim_count = r.claim_count + 1, claimed_at = now(), updated_at = now()
      where r.id in (select id from mailer.campaign_recipients
                      where campaign_id = $1 and status = 'pending' and (next_attempt_at is null or next_attempt_at <= now())
                      order by row_number limit 5 for update skip locked)
      returning r.id`, [id]);
  const [a, b] = await Promise.all([batch(app), batch(other)]);
  const ids = [...a.rows, ...b.rows].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'no recipient claimed twice');
  assert.equal(ids.length, 10);
});

// ------------------------------------------------------- least privilege --
test('runtime role: select/insert/update only — no DELETE, TRUNCATE or DDL on campaign tables', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  for (const sql of [
    'delete from mailer.campaign_recipients', 'delete from mailer.campaigns', 'truncate mailer.campaigns cascade',
    'alter table mailer.campaigns disable trigger all', 'drop trigger campaigns_guard on mailer.campaigns',
    'alter table mailer.campaign_recipients disable row level security', 'drop table mailer.campaign_recipients',
  ]) await rejects(app.query(sql), '42501', sql);
  const { rows } = await app.query(`select t, p, has_table_privilege(t, p) ok from
      unnest(array['mailer.campaigns', 'mailer.campaign_recipients']) t, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`);
  for (const r of rows) assert.equal(r.ok, ['SELECT', 'INSERT', 'UPDATE'].includes(r.p), `${r.t} ${r.p}`);
  assert.equal((await recipientsOf(app, id)).length, 2);
});

test('row-level security on the new tables: enabled, one mailer_runtime policy, outsiders see nothing', async () => {
  const { info, owner, app, adminId } = await campaignDb();
  await confirm(app, { adminId });
  const { rows: rls } = await owner.query(`select c.relname, c.relrowsecurity, (select array_agg(policyname || ':' || array_to_string(roles, ',')) from pg_policies p where p.schemaname = 'mailer' and p.tablename = c.relname) pol
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mailer' and c.relname in ('campaigns', 'campaign_recipients') order by 1`);
  assert.deepEqual(rls.map((r) => [r.relname, r.relrowsecurity, r.pol]), [
    ['campaign_recipients', true, ['mailer_runtime_access:mailer_runtime']], ['campaigns', true, ['mailer_runtime_access:mailer_runtime']]]);
  const role = `tangy_outsider_${randomBytes(3).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  try {
    await owner.query(`create role ${role} login password '${pw}'`);
    const u = new URL(info.ownerUrl);
    u.username = role; u.password = pw;
    const outsider = await client(u.toString());
    await rejects(outsider.query('select * from mailer.campaigns'), '42501', 'no grant');
    await owner.query(`grant usage on schema mailer to ${role}; grant select on mailer.campaigns, mailer.campaign_recipients to ${role}`);
    const { rows } = await outsider.query('select (select count(*) from mailer.campaigns)::int c, (select count(*) from mailer.campaign_recipients)::int r');
    assert.deepEqual(rows[0], { c: 0, r: 0 }, 'RLS hides every row');
    await outsider.end();
  } finally {
    await owner.query(`drop owned by ${role}; drop role if exists ${role}`).catch(() => {});
  }
  const { rows: pub } = await owner.query(`select count(*)::int n from information_schema.role_table_grants
      where table_schema = 'mailer' and table_name in ('campaigns', 'campaign_recipients') and grantee in ('PUBLIC', 'anon', 'authenticated')`);
  assert.equal(pub[0].n, 0);
});

test('manual retry: failed/unresolved → pending only while sending or paused; one attempt per claim', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  await start(app, id);
  let [r] = await recipientsOf(app, id);
  // A claim may count its attempt at the same time (+1 each); never +2.
  await rejects(app.query(`update mailer.campaign_recipients set status = 'claimed', claim_count = 1, attempts = 2, claimed_at = now(), first_attempt_at = now(), updated_at = now() where id = $1`, [r.id]), '23514', 'attempts +2');
  await app.query(`update mailer.campaign_recipients set status = 'claimed', claim_count = 1, attempts = 1, claimed_at = now(), first_attempt_at = now(), updated_at = now() where id = $1`, [r.id]);
  await app.query("update mailer.campaign_recipients set status = 'failed', reason = 'retries_exhausted', completed_at = now(), updated_at = now() where id = $1", [r.id]);
  await app.query("update mailer.campaign_recipients set status = 'pending', completed_at = null, updated_at = now() where id = $1", [r.id]);
  [r] = await recipientsOf(app, id);
  assert.deepEqual([r.status, r.attempts, r.claim_count], ['pending', 1, 1], 'retried; counters kept');
  await rejects(app.query("update mailer.campaign_recipients set status = 'failed', reason = 'unknown', completed_at = now() where id = $1", [r.id]), '23514', 'pending → failed is not a transition');
  // Retrying needs the campaign to be sending or paused.
  await app.query("update mailer.campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = now(), updated_at = now() where campaign_id = $1 and status = 'pending'", [id]);
  const id2 = await confirm(app, { adminId, session: 's2', recipients: [['Cy', 'cy@example.com']] });
  await start(app, id2);
  const [c] = await recipientsOf(app, id2);
  await app.query(`update mailer.campaign_recipients set status = 'claimed', claim_count = 1, attempts = 1, claimed_at = now(), first_attempt_at = now(), updated_at = now() where id = $1`, [c.id]);
  await app.query("update mailer.campaign_recipients set status = 'unresolved', reason = 'timeout', completed_at = now(), updated_at = now() where id = $1", [c.id]);
  await setStatus(app, id2, 'cancelled', ", stop_reason = 'admin', finished_at = now()");
  await rejects(app.query("update mailer.campaign_recipients set status = 'pending', completed_at = null where id = $1", [c.id]), '23514', 'no retry after cancel');
});

test('campaign name is required, trimmed and fixed after confirmation', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  await rejects(app.query("update mailer.campaigns set name = 'Renamed' where id = $1", [id]), '23514', 'name fixed');
  for (const bad of ['', ' padded ', 'x'.repeat(101), 'tab\there']) {
    await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash, recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
      values (gen_random_uuid(), gen_random_uuid(), $1, 's4', 'X', $2, 1, $3, $3, 1, 1, now(), now())`, [adminId, bad, HEX('x')]), '23514', JSON.stringify(bad));
  }
});

test('suppressions: append-only for the runtime role, hashed addresses only, RLS hides them from outsiders', async () => {
  const { info, owner, app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  const h = HEX('tangy-suppression/v1:asha@example.com');
  await app.query("insert into mailer.suppressions (email_hash, reason, source, campaign_id, created_at) values ($1, 'unsubscribe', 'one_click', $2, now())", [h, id]);
  const again = await app.query("insert into mailer.suppressions (email_hash, reason, source, created_at) values ($1, 'unsubscribe', 'link', now()) on conflict (email_hash) do nothing", [h]);
  assert.equal(again.rowCount, 0, 'idempotent');
  for (const sql of ['update mailer.suppressions set reason = $$manual$$', 'delete from mailer.suppressions', 'truncate mailer.suppressions']) await rejects(app.query(sql), '42501', sql);
  for (const [cols, label] of [
    ["'asha@example.com', 'unsubscribe', 'link'", 'plain address instead of a hash'],
    [`'${'c'.repeat(64)}', 'bored', 'link'`, 'unknown reason'],
    [`'${'d'.repeat(64)}', 'unsubscribe', 'email'`, 'unknown source'],
  ]) await rejects(app.query(`insert into mailer.suppressions (email_hash, reason, source, created_at) values (${cols}, now())`), '23514', label);
  const { rows } = await app.query(`select p, has_table_privilege('mailer.suppressions', p) ok from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`);
  assert.deepEqual(rows.map((r) => [r.p, r.ok]), [['SELECT', true], ['INSERT', true], ['UPDATE', false], ['DELETE', false], ['TRUNCATE', false]]);
  const role = `tangy_outsider_${randomBytes(3).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  try {
    await owner.query(`create role ${role} login password '${pw}'`);
    await owner.query(`grant usage on schema mailer to ${role}; grant select on mailer.suppressions to ${role}`);
    const u = new URL(info.ownerUrl);
    u.username = role; u.password = pw;
    const outsider = await client(u.toString());
    assert.equal((await outsider.query('select count(*)::int n from mailer.suppressions')).rows[0].n, 0, 'RLS hides every row');
    await outsider.end();
  } finally {
    await owner.query(`drop owned by ${role}; drop role if exists ${role}`).catch(() => {});
  }
});

test('unsubscribe hash: required, unique and fixed; a claimed recipient may only be skipped as suppressed', async () => {
  const { app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  await start(app, id);
  const [r1, r2] = await recipientsOf(app, id);
  await rejects(app.query('update mailer.campaign_recipients set unsubscribe_hash = $2 where id = $1', [r1.id, r2.unsubscribe_hash]), null, 'unique + fixed');
  await rejects(app.query("update mailer.campaign_recipients set unsubscribe_hash = repeat('e', 64) where id = $1", [r1.id]), '23514', 'fixed');
  await claim(app, r1);
  await rejects(app.query("update mailer.campaign_recipients set status = 'skipped', reason = 'cancelled', completed_at = now(), updated_at = now() where id = $1", [r1.id]), '23514', 'claimed → skipped(cancelled)');
  await app.query("update mailer.campaign_recipients set status = 'skipped', reason = 'suppressed', completed_at = now(), updated_at = now() where id = $1", [r1.id]);
  const { rows: [after] } = await app.query('select status, reason from mailer.campaign_recipients where id = $1', [r1.id]);
  assert.deepEqual(after, { status: 'skipped', reason: 'suppressed' });
});

// ------------------------------------------- recipient-count concurrency ---
// The database must keep count(recipients) = total_recipients for every
// committed campaign, whatever other transactions do at the same time. The
// app itself only inserts recipients in the confirming transaction, but the
// guarantee is the database's, so these tests attack it directly as the
// runtime role (the role the app connects as).
//
// Why it holds (no lock needed):
//   1. A recipient row can only be inserted by a transaction that can SEE its
//      campaign — the foreign key check fails (23503) otherwise.
//   2. The campaign and all its recipients commit atomically, so whoever sees
//      the campaign also sees its complete list.
//   3. Hence campaign_recipients_insert_guard always counts >= total plus the
//      new rows and refuses (23514); campaigns_complete_list (deferred, in the
//      creating transaction) refuses anything but exactly the total.
const lateInsert = (row, email) => ({
  text: `insert into mailer.campaign_recipients (campaign_id, row_number, name, email, send_id, unsubscribe_hash, created_at, updated_at)
         values ($1, $2, 'Late', $3, gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea), 'hex'), now(), now())`,
  values: [null, row, email],
});
async function countOf(c, id) {
  return (await c.query('select count(*)::int n from mailer.campaign_recipients where campaign_id = $1', [id])).rows[0].n;
}
// Runs `fn` in its own transaction; resolves to 'committed' or the SQLSTATE.
async function attempt(c, fn) {
  try {
    await fn();
    await c.query('commit');
    return 'committed';
  } catch (err) {
    await c.query('rollback').catch(() => {});
    return err.code ?? err.message;
  }
}

test('count guard: two concurrent late inserts into a committed campaign (READ COMMITTED) are both refused', async () => {
  const { info, app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  const [b, c] = [await client(info.runtimeUrl), await client(info.runtimeUrl)];
  const ins = (cl, row) => { const q = lateInsert(row, `late${row}@example.com`); q.values[0] = id; return cl.query(q); };
  await b.query('begin');
  await c.query('begin');
  const results = await Promise.all([attempt(b, () => ins(b, 10)), attempt(c, () => ins(c, 11))]);
  assert.deepEqual(results, ['23514', '23514']);
  assert.equal(await countOf(app, id), 2);
});

test('count guard: an insert racing the uncommitted confirmation is refused — the campaign does not exist for it yet (READ COMMITTED)', async () => {
  const { info, app, adminId } = await campaignDb();
  const a = await client(info.runtimeUrl);
  const b = await client(info.runtimeUrl);
  const id = randomUUID();
  await a.query('begin');
  await a.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
                 recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
                 values ($1, gen_random_uuid(), $2, 's1', 'S', 'N', 1, $3, $3, 1, 1, now(), now())`, [id, adminId, HEX('x')]);
  const q1 = lateInsert(2, 'first@example.com'); q1.values[0] = id;
  await a.query(q1);
  await b.query('begin');
  const q2 = lateInsert(3, 'racer@example.com'); q2.values[0] = id;
  // The uncommitted campaign row is invisible to B, so its foreign key check
  // fails at once (no waiting); A then commits its exact list.
  assert.equal(await attempt(b, () => b.query(q2)), '23503');
  assert.equal(await attempt(a, async () => {}), 'committed');
  assert.equal(await countOf(app, id), 1);
  // Retried after the commit, B now sees the full list and the count guard refuses.
  await b.query('begin');
  assert.equal(await attempt(b, () => b.query(q2)), '23514');
  assert.equal(await countOf(app, id), 1);
});

for (const level of ['repeatable read', 'serializable']) {
  test(`count guard: an inserter whose snapshot predates the confirmation cannot exceed total_recipients (${level.toUpperCase()})`, async () => {
    const { info, app, adminId } = await campaignDb();
    const b = await client(info.runtimeUrl);
    await b.query(`begin isolation level ${level}`);
    await b.query('select count(*) from mailer.campaign_recipients'); // B's snapshot is taken now
    const id = await confirm(app, { adminId }); // A confirms (2 of 2) and commits afterwards
    const q = lateInsert(10, 'late@example.com'); q.values[0] = id;
    // The count guard would see an empty list in B's old snapshot, but B
    // cannot get that far: its foreign key check cannot see the campaign.
    assert.equal(await attempt(b, () => b.query(q)), '23503', `${level}: refused by the foreign key`);
    assert.equal(await countOf(app, id), 2, 'count(recipients) = total_recipients');
  });
}

test('count guard: two old-snapshot inserters at once cannot both add recipients (REPEATABLE READ)', async () => {
  const { info, app, adminId } = await campaignDb();
  const [b, c] = [await client(info.runtimeUrl), await client(info.runtimeUrl)];
  for (const cl of [b, c]) {
    await cl.query('begin isolation level repeatable read');
    await cl.query('select 1 from mailer.campaigns limit 1');
  }
  const id = await confirm(app, { adminId });
  const ins = (cl, row) => { const q = lateInsert(row, `late${row}@example.com`); q.values[0] = id; return cl.query(q); };
  const results = await Promise.all([attempt(b, () => ins(b, 10)), attempt(c, () => ins(c, 11))]);
  assert.deepEqual(results, ['23503', '23503']);
  assert.equal(await countOf(app, id), 2);
});

test('count guard: eight concurrent late inserters (READ COMMITTED) — none commits', async () => {
  const { info, app, adminId } = await campaignDb();
  const id = await confirm(app, { adminId });
  const clients = await Promise.all(Array.from({ length: 8 }, () => client(info.runtimeUrl)));
  for (const cl of clients) await cl.query('begin');
  const results = await Promise.all(clients.map((cl, i) => attempt(cl, () => { const q = lateInsert(20 + i, `late${i}@example.com`); q.values[0] = id; return cl.query(q); })));
  assert.deepEqual(results, Array(8).fill('23514'));
  assert.equal(await countOf(app, id), 2);
});

test('count guard: the confirming transaction can commit neither fewer nor more than the total, even forcing the check early', async () => {
  const { app, adminId } = await campaignDb();
  const three = [['A', 'a@example.com'], ['B', 'b@example.com'], ['C', 'c@example.com']];
  await rejects(confirm(app, { adminId, recipients: three, total: 2 }), '23514', 'more than the total (statement guard)');
  await rejects(confirm(app, { adminId, session: 's2', recipients: three.slice(0, 1), total: 2 }), '23514', 'fewer than the total (deferred check at commit)');
  // SET CONSTRAINTS … IMMEDIATE only moves the deferred check earlier, where
  // the list is still empty: it cannot be used to skip it.
  await app.query('begin');
  await app.query('set constraints mailer.campaigns_complete_list immediate');
  await rejects(app.query(`insert into mailer.campaigns (id, creation_key, created_by, session_id, session_name, name, template_version, template_hash,
                 recipients_hash, total_recipients, csv_rows, confirmed_at, updated_at)
                 values (gen_random_uuid(), gen_random_uuid(), $1, 's3', 'S', 'N', 1, $2, $2, 1, 1, now(), now())`, [adminId, HEX('x')]), '23514', 'immediate check with no recipients');
  await app.query('rollback');
  const { rows } = await app.query('select count(*)::int n from mailer.campaigns');
  assert.equal(rows[0].n, 0, 'nothing was committed');
});
