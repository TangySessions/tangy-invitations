// Schema migration: a database created by the single-template version (v1)
// must upgrade to four sessions without losing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { openDb, SESSION_IDS, SCHEMA_VERSION } from '../src/db.js';

// The exact schema shipped by the single-template version.
const V1_SCHEMA = `
create table if not exists admins (id integer primary key, email text not null unique collate nocase, password_hash text not null, disabled integer not null default 0, created_at text not null);
create table if not exists sessions (token_hash text primary key, admin_id integer not null references admins(id) on delete cascade, csrf_token text not null, created_at integer not null, last_seen integer not null);
create index if not exists sessions_admin_idx on sessions(admin_id);
create table if not exists template (id integer primary key check (id = 1), subject text not null, html text not null, css text not null default '', text_body text not null default '', version integer not null, updated_at text not null, updated_by integer references admins(id) on delete set null);
create table if not exists send_log (id integer primary key, idempotency_key text not null unique, admin_id integer not null references admins(id), recipient_email text not null, subject text not null, is_test integer not null, template_version integer not null, status text not null check (status in ('pending', 'accepted', 'dry_run', 'rejected', 'failed', 'ambiguous')), provider_message_id text, error text, created_at integer not null, completed_at integer);
create index if not exists send_log_admin_created_idx on send_log(admin_id, created_at);
`;

function makeV1(dir, { withTemplate = true, withSend = true } = {}) {
  const db = new DatabaseSync(join(dir, 'mailer.db'));
  db.exec('pragma journal_mode = wal;');
  db.exec(V1_SCHEMA);
  db.prepare('insert into admins (email, password_hash, created_at) values (?, ?, ?)').run('old@tangy.test', 'scrypt$hash', '2026-10-01T00:00:00.000Z');
  db.prepare("insert into sessions values ('tokhash', 1, 'csrf', 1, 1)").run();
  if (withTemplate) {
    db.prepare('insert into template values (1, ?, ?, ?, ?, 7, ?, 1)').run('Legacy {{recipient_name}}', '<p>Legacy body {{recipient_name}}</p>', 'p{color:red}', 'legacy text', '2026-10-02T00:00:00.000Z');
  }
  if (withSend) {
    db.prepare(`insert into send_log (idempotency_key, admin_id, recipient_email, subject, is_test, template_version, status, provider_message_id, created_at, completed_at)
                values ('11111111-1111-4111-8111-111111111111', 1, 'past@example.com', 'Legacy Past', 0, 7, 'accepted', 'msg_old', 1000, 1001)`).run();
  }
  db.close();
}

test('a new database starts with four unconfigured slots at the current schema version', () => {
  const db = openDb(':memory:');
  assert.equal(db.raw.prepare('pragma user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual(db.listSessionTemplates().map((s) => [s.id, s.slot, s.configured, s.version]), [['s1', 1, false, 0], ['s2', 2, false, 0], ['s3', 3, false, 0], ['s4', 4, false, 0]]);
  assert.equal(db.migration.backup ?? null, null);
  db.close();
});

test('v1 → current: backup taken, legacy template moves to Session 1 only, history and accounts preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-mig-'));
  try {
    makeV1(dir);
    const db = openDb(dir);
    assert.equal(db.migration.migrated, true);

    // Backup exists, is private, and still has the v1 data.
    const backups = readdirSync(join(dir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], new RegExp(`^mailer-before-v${SCHEMA_VERSION}-.*\\.db$`));
    assert.equal(statSync(join(dir, 'backups', backups[0])).mode & 0o777, 0o600);
    const bk = new DatabaseSync(join(dir, 'backups', backups[0]), { readOnly: true });
    assert.equal(bk.prepare('select subject from template').get().subject, 'Legacy {{recipient_name}}');
    assert.equal(bk.prepare('select count(*) n from send_log').get().n, 1);
    bk.close();

    // s1 = the legacy template, with its version; s2–s4 untouched.
    const s1 = db.getSessionTemplate('s1');
    assert.deepEqual([s1.configured, s1.name, s1.subject, s1.html, s1.css, s1.text, s1.version, s1.updated_by],
      [true, 'Session 1', 'Legacy {{recipient_name}}', '<p>Legacy body {{recipient_name}}</p>', 'p{color:red}', 'legacy text', 7, 'old@tangy.test']);
    for (const id of ['s2', 's3', 's4']) {
      const s = db.getSessionTemplate(id);
      assert.deepEqual([s.configured, s.html, s.subject, s.version], [false, '', '', 0], id);
    }

    // History, accounts and login sessions intact; old rows have no session.
    const log = db.recentSends(10);
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].recipient_email, log[0].subject, log[0].provider_message_id, log[0].session_id], ['past@example.com', 'Legacy Past', 'msg_old', null]);
    assert.equal(db.getAdminByEmail('old@tangy.test').password_hash, 'scrypt$hash');
    assert.ok(db.getSession('tokhash'));

    // The old table is kept (renamed), not dropped.
    assert.ok(db.raw.prepare("select 1 from sqlite_master where name = 'legacy_template_v1'").get());
    assert.equal(db.raw.prepare("select 1 from sqlite_master where name = 'template'").get(), undefined);
    db.close();

    // Re-opening is a no-op: no second backup, nothing changes.
    const again = openDb(dir);
    assert.equal(again.migration.migrated, false);
    assert.equal(readdirSync(join(dir, 'backups')).length, 1);
    assert.equal(again.getSessionTemplate('s1').version, 7);
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v1 database without a saved template: all four slots unconfigured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-mig-'));
  try {
    makeV1(dir, { withTemplate: false, withSend: false });
    const db = openDb(dir);
    assert.ok(db.listSessionTemplates().every((s) => !s.configured));
    assert.equal(readdirSync(join(dir, 'backups')).length, 1, 'still backed up');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed migration rolls back completely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-mig-'));
  try {
    makeV1(dir);
    // Sabotage: a table named session_templates already exists, so the
    // migration's CREATE TABLE fails midway.
    const raw = new DatabaseSync(join(dir, 'mailer.db'));
    raw.exec('create table session_templates (x int)');
    raw.close();
    assert.throws(() => openDb(dir));
    const check = new DatabaseSync(join(dir, 'mailer.db'), { readOnly: true });
    assert.equal(check.prepare('pragma user_version').get().user_version, 0);
    assert.equal(check.prepare('select subject from template').get().subject, 'Legacy {{recipient_name}}', 'legacy template untouched');
    assert.ok(!check.prepare('pragma table_info(send_log)').all().some((c) => c.name === 'session_id'), 'send_log not altered');
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the database refuses invalid or duplicate session slots', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  assert.throws(() => db.raw.prepare("insert into session_templates (id, slot, created_at) values ('s5', 5, ?)").run(now));
  assert.throws(() => db.raw.prepare("insert into session_templates (id, slot, created_at) values ('s1', 1, ?)").run(now));
  assert.throws(() => db.raw.prepare("update session_templates set configured = 1 where id = 's2'").run(), 'configured requires content');
  assert.equal(db.listSessionTemplates().length, SESSION_IDS.length);
  db.close();
});

test('saving one slot changes exactly one row', () => {
  const db = openDb(':memory:');
  const before = db.listSessionTemplates();
  const r = db.saveSessionTemplate('s3', { name: 'Three', subject: 'x', html: '<p>x</p>', css: '', text: '', active: true }, 0, null, Date.now());
  assert.deepEqual(r, { version: 1 });
  const after = db.listSessionTemplates();
  assert.deepEqual(after.filter((s) => s.id !== 's3'), before.filter((s) => s.id !== 's3'));
  assert.deepEqual(db.saveSessionTemplate('s3', { name: 'Three', subject: 'y', html: '<p>y</p>', css: '', text: '', active: true }, 0, null, Date.now()), { conflict: true, currentVersion: 1 });
  db.close();
});

test('v2 → current: backup taken first; only campaign and suppression tables are added; templates, accounts and history untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-v3-'));
  try {
    // A version-2 database with data: build one, then remove what v3 adds.
    const db = openDb(dir);
    db.createAdmin('ann@tangy.test', 'scrypt$x');
    const admin = db.getAdminByEmail('ann@tangy.test');
    db.saveSessionTemplate('s2', { name: 'Kept', subject: 'S', html: '<p>x</p>', css: '', text: '', active: true }, 0, admin.id, Date.now());
    db.claimSend({ key: '00000000-0000-4000-8000-000000000001', adminId: admin.id, sessionId: 's2', sessionName: 'Kept', email: 'a@b.co', subject: 'S', test: false, version: 1, now: Date.now(), limit: 30 });
    for (const t of db.raw.prepare("select name from sqlite_master where type = 'trigger'").all()) db.raw.exec(`drop trigger ${t.name}`);
    db.raw.exec('drop table suppressions; drop table campaign_recipients; drop table campaigns; pragma user_version = 2');
    db.close();

    const up = openDb(dir);
    try {
      assert.equal(up.raw.prepare('pragma user_version').get().user_version, SCHEMA_VERSION);
      assert.match(basename(up.migration.backup), new RegExp(`^mailer-before-v${SCHEMA_VERSION}-.*\\.db$`));
      const bk = new DatabaseSync(up.migration.backup, { readOnly: true });
      assert.equal(bk.prepare('pragma user_version').get().user_version, 2, 'the backup is the untouched v2 file');
      bk.close();
      assert.deepEqual([up.getSessionTemplate('s2').name, up.getSessionTemplate('s2').version], ['Kept', 1]);
      assert.equal(up.listAdmins().length, 1);
      assert.equal(up.recentSends(10).length, 1);
      assert.deepEqual(up.listCampaigns(10), []);
      assert.deepEqual(up.campaignsAvailable(), { available: true });
    } finally { up.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
