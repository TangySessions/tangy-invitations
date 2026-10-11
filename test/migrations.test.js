// Migration files and the runner's approval gate, without a database: the
// runner is driven with a fake client that records every query. The SQL
// itself is executed against PostgreSQL in test/pg/campaigns.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { listMigrations, migrate, planMigrations, APPROVED_MIGRATION_VERSION, MIGRATIONS_DIR } from '../src/store/pgMigrate.js';

const files = listMigrations();
const byName = Object.fromEntries(files.map((m) => [m.name, m]));
const sql0002 = byName['0002_campaigns'].sql;
// Code only: comments and the bodies of strings removed.
const code0002 = sql0002.replace(/--.*$/gm, '');

// Applied to Supabase (Phase 4D). An applied migration must never change:
// the runner would refuse to continue (checksum mismatch).
const APPLIED_0001_SHA256 = '82bf7d0f0439d52500d86b33662039ab76881e6176550d9dfdca66ae94fdfd1d';

function fakeClient(applied) {
  const queries = [];
  return {
    queries,
    async query(text, params) {
      queries.push(String(text));
      if (/^select version, name, checksum from mailer\.schema_migrations/.test(text)) return { rows: applied.map((m) => ({ version: m.version, name: m.name, checksum: m.checksum })) };
      if (/^insert into mailer\.schema_migrations/.test(text)) { applied.push({ version: params[0], name: params[1], checksum: params[2] }); return { rows: [] }; }
      if (/^select coalesce\(max\(version\)/.test(text)) return { rows: [{ v: Math.max(0, ...applied.map((m) => m.version)) }] };
      if (/to_regclass\('mailer\.schema_migrations'\)/.test(text)) return { rows: [{ present: applied.length > 0 }] };
      return { rows: [] };
    },
  };
}

test('migration files: numbered 0001, 0002, … with no gaps; 0001 is unchanged since it was applied', () => {
  assert.deepEqual(files.map((m) => m.version), files.map((_, i) => i + 1));
  assert.deepEqual(files.map((m) => m.name), ['0001_init', '0002_campaigns']);
  assert.equal(byName['0001_init'].checksum, APPLIED_0001_SHA256);
  assert.equal(createHash('sha256').update(readFileSync(new URL('../migrations/postgres/0001_init.sql', import.meta.url))).digest('hex'), APPLIED_0001_SHA256);
});

test('approval gate: 0002 is approved — by default a version-1 database is migrated to 2', async () => {
  assert.equal(APPROVED_MIGRATION_VERSION, 2, '0002_campaigns (campaigns, unsubscribe, people) is approved');
  // A database at version 1 (like the Supabase project before applying 0002).
  const db = fakeClient([files[0]]);
  const r = await migrate(db);
  assert.deepEqual([r.applied, r.held, r.current], [['0002_campaigns'], [], 2]);
  // An empty database: both.
  const e = await migrate(fakeClient([]));
  assert.deepEqual([e.applied, e.held, e.current], [['0001_init', '0002_campaigns'], [], 2]);
  // A lower explicit target still holds 0002 back (nothing of it is sent).
  const v1 = fakeClient([files[0]]);
  const held = await migrate(v1, { target: 1 });
  assert.deepEqual([held.applied, held.held, held.current], [[], ['0002_campaigns'], 1]);
  assert.ok(!v1.queries.some((q) => q.includes('mailer.campaigns')), '0002 SQL never sent');
});

test('approval gate still holds back any FUTURE migration above the approved version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-migrations-'));
  try {
    for (const f of ['0001_init.sql', '0002_campaigns.sql']) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    writeFileSync(join(dir, '0003_future.sql'), 'select 1;');
    const db = fakeClient([files[0], files[1]]);
    const r = await migrate(db, { dir });
    assert.deepEqual([r.applied, r.held, r.current], [[], ['0003_future'], 2]);
    assert.ok(!db.queries.includes('select 1;'), 'the unapproved file is never sent');
    const p = await planMigrations(fakeClient([files[0]]), { dir });
    assert.deepEqual([p.pending, p.held], [['0002_campaigns'], ['0003_future']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('0002 is applied in its own transaction and records its checksum', async () => {
  const applied = [files[0]];
  const db = fakeClient(applied);
  const r = await migrate(db, { target: 2 });
  assert.deepEqual([r.applied, r.held, r.current], [['0002_campaigns'], [], 2]);
  const i = db.queries.indexOf(sql0002);
  assert.ok(i > 0);
  assert.deepEqual([db.queries[i - 1], db.queries[i + 2]], ['begin', 'commit']);
  assert.equal(applied.at(-1).checksum, byName['0002_campaigns'].checksum);
  for (const bad of [-1, 1.5, '2', Infinity]) await assert.rejects(migrate(fakeClient([]), { target: bad }), /whole number/);
});

test('the runner still refuses an applied migration whose file changed (checksum)', async () => {
  const db = fakeClient([{ ...files[0], checksum: '0'.repeat(64) }]);
  await assert.rejects(migrate(db, { target: 2 }), /checksum mismatch/);
  assert.ok(!db.queries.includes(sql0002));
});

test('0002 follows the 0001 conventions: mailer schema, RLS + policy on every new table, explicit grants', () => {
  const tables = [...code0002.matchAll(/create table if not exists mailer\.([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual(tables, ['campaigns', 'campaign_recipients', 'suppressions']);
  assert.ok(!/create table (?!if not exists mailer\.)/.test(code0002), 'every table is created in schema mailer, idempotently');
  assert.match(code0002, /foreach t in array array\['campaigns', 'campaign_recipients', 'suppressions'\] loop\s+execute format\('alter table mailer\.%I enable row level security', t\);/);
  assert.match(code0002, /create policy mailer_runtime_access on mailer\.%I for all to mailer_runtime/);
  assert.match(code0002, /grant select, insert, update on mailer\.campaigns\s+to mailer_runtime;/);
  assert.match(code0002, /grant select, insert, update on mailer\.campaign_recipients to mailer_runtime;/);
  assert.match(code0002, /grant usage on sequence mailer\.campaign_recipients_id_seq\s+to mailer_runtime;/);
  assert.match(code0002, /grant select, insert\s+on mailer\.suppressions\s+to mailer_runtime;/);
  assert.match(code0002, /revoke all on mailer\.campaigns, mailer\.campaign_recipients, mailer\.suppressions from public;/);
  assert.match(code0002, /revoke all on mailer\.campaigns, mailer\.campaign_recipients, mailer\.suppressions from %I/);
});

test('0002 grants no DELETE/TRUNCATE, nothing to public/anon/authenticated, and changes nothing from 0001', () => {
  const grants = code0002.match(/^\s*grant [^;]+;/gim) || [];
  assert.ok(grants.length >= 3);
  for (const g of grants) {
    assert.ok(!/\b(delete|truncate|all|references|trigger)\b/i.test(g.replace(/\bon all\b/i, '')), g);
    assert.match(g, /to mailer_runtime;$/, g);
  }
  assert.ok(!/security\s+definer/i.test(code0002), 'trigger functions run with the caller\'s rights');
  assert.ok(!/\b(drop|alter)\s+table\s+(if exists\s+)?mailer\.(admins|login_sessions|session_templates|send_log|login_attempts|schema_migrations)\b/i.test(code0002), '0001 tables untouched');
  assert.ok(!/\b(alter|drop|create)\s+role\b/i.test(code0002), 'no role changes');
  assert.ok(!/\bdrop\s+(table|schema|policy)\b/i.test(code0002), 'nothing destructive (only "drop trigger if exists" before re-creating)');
  assert.ok(!/\bset\s+search_path\s*=\s*public/i.test(code0002));
  for (const fn of code0002.match(/create or replace function [^(]+/g)) assert.match(fn, /function mailer\./);
  assert.equal((code0002.match(/set search_path = pg_catalog, mailer/g) || []).length, 4, 'every trigger function pins its search_path');
});

test('the PostgreSQL test harness refuses any non-local PG_TEST_URL before connecting', async () => {
  const { assertLocalTestUrl } = await import('./helpers/testStore.js');
  for (const ok of ['postgres://postgres:x@127.0.0.1:55432/postgres', 'postgresql://u:p@localhost:5432/db', 'postgres://u:p@[::1]:5432/db']) assert.doesNotThrow(() => assertLocalTestUrl(ok), ok);
  for (const bad of [
    'postgres://postgres.ref:pw@aws-0-region.pooler.supabase.com:5432/postgres', 'postgres://u:p@db.example.com/x',
    'postgres://u:p@127.0.0.2:5432/x', 'postgres://u:p@localhost.evil.example/x', 'postgres://u:p@127.0.0.1:5432/x?host=db.example.com',
    'mysql://u:p@127.0.0.1/x', 'not a url', '',
  ]) assert.throws(() => assertLocalTestUrl(bad), /PG_TEST_URL/, bad);
});

test('plan (db-migrate.js --plan) only reads, and reports applied / approved-pending / held / problems', async () => {
  const db = fakeClient([files[0]]);
  const p = await planMigrations(db);
  assert.deepEqual(p, { current: 1, applied: ['0001_init'], pending: ['0002_campaigns'], held: [], problems: [] });
  assert.ok(db.queries.every((q) => /^select /i.test(q.trim())), 'select statements only — no lock, no create, no insert');
  const empty = await planMigrations(fakeClient([]));
  assert.deepEqual([empty.current, empty.pending, empty.held], [0, ['0001_init', '0002_campaigns'], []]);
  const bad = await planMigrations(fakeClient([{ ...files[0], checksum: '0'.repeat(64) }]));
  assert.match(bad.problems[0], /0001_init was changed after it was applied/);
  const lower = await planMigrations(fakeClient([files[0]]), { target: 1 });
  assert.deepEqual([lower.pending, lower.held], [[], ['0002_campaigns']]);
  const done = await planMigrations(fakeClient([files[0], files[1]]));
  assert.deepEqual([done.current, done.pending, done.held], [2, [], []]);
});
