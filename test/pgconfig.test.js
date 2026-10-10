// Phase 4B: Supabase-compatibility settings, tested locally without any
// database or network access (the PostgreSQL integration counterparts live
// in test/pg/postgres.test.js). Certificates in test/fixtures are throwaway
// self-signed test CAs — public certificates only, no private keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  loadDatabaseConfig, poolOptions, parseCaPem, assertSessionConnection, safeDbError, STARTUP_PARAMS,
} from '../src/store/pgConfig.js';
import { runMigrations } from '../src/store/pgMigrate.js';
import { loadConfig, loadAdminCliConfig } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const fixture = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const CA_A = fixture('test-ca-a.pem');
const CA_B = fixture('test-ca-b.pem');
const CA_EXPIRED = fixture('test-ca-expired.pem');
const PW = 'Sup3rSecretOwnerPw';
const REMOTE_RUNTIME = 'postgres://mailer_app.projref:RuntimePw123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres';
const SESSION_OWNER = `postgres://postgres.projref:${PW}@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const TX_OWNER = `postgres://postgres.projref:${PW}@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;
const pg = (extra = {}) => ({ DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME, ...extra });
const noSecrets = (text, label) => {
  // The PEM *marker* may appear in guidance text; certificate content may not.
  for (const s of [PW, 'RuntimePw123', CA_A.split('\n')[1], CA_A.split('\n')[2]]) assert.ok(!String(text).includes(s), `${label}: leaked ${s.slice(0, 12)}…`);
};

// ---------------------------------------------------- migration connection --
test('migrations refuse a transaction-pooler connection (port 6543 / pgbouncer=true) without echoing it', () => {
  for (const url of [TX_OWNER, `${SESSION_OWNER}?pgbouncer=true`, TX_OWNER.replace('postgres://', 'postgresql://')]) {
    let err;
    try { assertSessionConnection(url); } catch (e) { err = e; }
    assert.ok(err, url.replace(PW, '***'));
    assert.match(err.message, /Session pooler or a direct connection|session-preserving/);
    noSecrets(err.message, 'guard error');
  }
  assert.doesNotThrow(() => assertSessionConnection(SESSION_OWNER), 'session pooler (5432)');
  assert.doesNotThrow(() => assertSessionConnection(`postgres://postgres:${PW}@db.projref.supabase.co:5432/postgres`), 'direct');
  assert.doesNotThrow(() => assertSessionConnection('postgres://u:p@localhost/x'), 'default port');
});

test('runMigrations rejects unsafe or incomplete configuration BEFORE creating any client', async () => {
  let created = 0;
  const createClient = async () => { created++; throw new Error('must not connect'); };
  const cases = {
    'transaction pooler': { DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: TX_OWNER },
    'no owner URL': { DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME },
    'sqlite backend': { MIGRATION_DATABASE_URL: SESSION_OWNER },
    'bad CA': { DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER, DATABASE_SSL_CA_PEM: 'not a cert' },
  };
  for (const [label, env] of Object.entries(cases)) {
    let err;
    try { await runMigrations({ env, createClient }); } catch (e) { err = e; }
    assert.ok(err, label);
    noSecrets(err.message, label);
  }
  assert.equal(created, 0, 'no client was ever created');

  // A valid session connection with ONLY the owner URL (no DATABASE_URL) gets
  // as far as creating the client — with TLS verification and no statement timeout.
  let opts;
  await assert.rejects(runMigrations({
    env: { DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER },
    createClient: async (o) => { opts = o; return { connect: async () => { throw new Error('stop here (test)'); }, end: async () => {} }; },
  }), /stop here/);
  assert.equal(opts.connectionString, SESSION_OWNER);
  assert.deepEqual(opts.ssl, { rejectUnauthorized: true });
  assert.equal(opts.statement_timeout, undefined, 'DDL is not limited by the app statement timeout');
  assert.equal(opts.query_timeout, 120_000);
});

test('db-migrate.js (real script) refuses port 6543 and exits 1 without connecting or printing the URL', () => {
  const r = spawnSync(process.execPath, ['scripts/db-migrate.js'], {
    cwd: ROOT, encoding: 'utf8', timeout: 20_000,
    env: { PATH: process.env.PATH, DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: TX_OWNER },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /port 6543, a transaction pooler.*Nothing was run/);
  noSecrets(r.stdout + r.stderr, 'script output');
  assert.ok(!(r.stdout + r.stderr).includes('pooler.supabase.com'), 'host not printed');
});

// --------------------------------------------------- migration-only config --
test('owner-purpose config needs MIGRATION_DATABASE_URL only; the app runtime still needs DATABASE_URL', () => {
  const owner = loadDatabaseConfig({ DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER }, { purpose: 'owner' });
  assert.equal(owner.backend, 'postgres');
  assert.equal(owner.migrationUrl, SESSION_OWNER);
  assert.equal(owner.url, undefined);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres' }, { purpose: 'owner' }), /needs MIGRATION_DATABASE_URL/);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER }), /requires DATABASE_URL/, 'runtime default');
  assert.throws(() => loadConfig({ DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER }), /requires DATABASE_URL/, 'the app');
  assert.throws(() => loadDatabaseConfig({}, { purpose: 'bogus' }), /purpose/);
  // Admin CLI: storage only — no APP_ORIGIN / PREVIEW_TOKEN_SECRET needed, SQLite default kept.
  assert.deepEqual(loadAdminCliConfig({}).database, { backend: 'sqlite' });
  assert.equal(loadAdminCliConfig({ DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: SESSION_OWNER, NODE_ENV: 'production' }).database.backend, 'postgres');
  assert.throws(() => loadAdminCliConfig({ DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME }), /needs MIGRATION_DATABASE_URL/);
  // Production app rules are unchanged.
  assert.throws(() => loadConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://x.example', PREVIEW_TOKEN_SECRET: 'x'.repeat(5) + 'aB3$kLm9QwErTyUiOp1234567890zxcv' }), /DB_BACKEND must be set explicitly/);
});

test('admin.js (real script): postgres without the owner URL fails safely; SQLite default still works', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tangy-admin-'));
  try {
    const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', 'list'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /needs MIGRATION_DATABASE_URL/);
    noSecrets(bad.stdout + bad.stderr, 'admin output');
    const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/admin.js', 'list'], {
      cwd: ROOT, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, DATA_DIR: tmp },
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /No admin accounts/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ certificates --
test('CA from DATABASE_SSL_CA_PEM: valid PEM, bundles and the single-line "\\n" form are accepted', () => {
  const one = loadDatabaseConfig(pg({ DATABASE_SSL_CA_PEM: CA_A }));
  assert.equal(one.sslCaSource, 'env');
  assert.match(one.sslCa, /^-----BEGIN CERTIFICATE-----/);
  assert.deepEqual(poolOptions(one).ssl, { rejectUnauthorized: true, ca: one.sslCa });
  const bundle = loadDatabaseConfig(pg({ DATABASE_SSL_CA_PEM: `${CA_A}\n${CA_B}` }));
  assert.equal(bundle.sslCa.match(/BEGIN CERTIFICATE/g).length, 2);
  const single = loadDatabaseConfig(pg({ DATABASE_SSL_CA_PEM: CA_A.trim().replace(/\n/g, '\\n') }));
  assert.equal(single.sslCa, one.sslCa);
  // Expired + valid in one bundle is accepted (at least one usable certificate).
  assert.doesNotThrow(() => loadDatabaseConfig(pg({ DATABASE_SSL_CA_PEM: `${CA_EXPIRED}\n${CA_A}` })));
});

test('CA from a local file (DATABASE_SSL_CA); unreadable files fail without echoing the path contents', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tangy-ca-'));
  try {
    const f = join(tmp, 'ca.pem');
    writeFileSync(f, CA_A);
    const c = loadDatabaseConfig(pg({ DATABASE_SSL_CA: f }));
    assert.equal(c.sslCaSource, 'file');
    assert.match(c.sslCa, /BEGIN CERTIFICATE/);
    assert.throws(() => loadDatabaseConfig(pg({ DATABASE_SSL_CA: join(tmp, 'missing.pem') })), /could not be read/);
    writeFileSync(f, 'garbage');
    assert.throws(() => loadDatabaseConfig(pg({ DATABASE_SSL_CA: f })), /does not contain a PEM certificate/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('no CA configured → TLS still verified against Node\'s trusted CAs', () => {
  const c = loadDatabaseConfig(pg());
  assert.equal(c.sslCaSource, 'system');
  assert.deepEqual(poolOptions(c).ssl, { rejectUnauthorized: true });
});

test('malformed or unsafe CA configuration is rejected with safe errors', () => {
  const truncated = CA_A.replace(/-----END CERTIFICATE-----\s*$/, '');
  const corrupt = CA_A.replace(/^(-----BEGIN CERTIFICATE-----\n)(.{8})/m, '$1AAAAAAAA');
  const withKey = `${CA_A}\n-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n`;
  const cases = {
    garbage: [{ DATABASE_SSL_CA_PEM: 'hello' }, /does not contain a PEM certificate/],
    empty_bundle_marker: [{ DATABASE_SSL_CA_PEM: '-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----' }, /does not contain a PEM certificate|malformed/],
    truncated: [{ DATABASE_SSL_CA_PEM: truncated }, /does not contain a PEM certificate|other than PEM/],
    corrupt: [{ DATABASE_SSL_CA_PEM: corrupt }, /malformed certificate/],
    private_key: [{ DATABASE_SSL_CA_PEM: withKey }, /contains a private key/],
    trailing_text: [{ DATABASE_SSL_CA_PEM: `${CA_A}\nextra stuff` }, /other than PEM certificates/],
    only_expired: [{ DATABASE_SSL_CA_PEM: CA_EXPIRED }, /expired/],
    too_large: [{ DATABASE_SSL_CA_PEM: CA_A.repeat(Math.ceil((70 * 1024) / CA_A.length)) }, /too large/],
    both_sources: [{ DATABASE_SSL_CA_PEM: CA_A, DATABASE_SSL_CA: '/some/file.pem' }, /only one of DATABASE_SSL_CA_PEM .* or DATABASE_SSL_CA/],
    ca_with_ssl_disabled: [{ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x', DATABASE_SSL: 'disable', DATABASE_SSL_CA_PEM: CA_A }, /not "verify"/],
  };
  for (const [label, [extra, re]] of Object.entries(cases)) {
    let err;
    try { loadDatabaseConfig(pg(extra)); } catch (e) { err = e; }
    assert.ok(err, label);
    assert.match(err.message, re, label);
    noSecrets(err.message, label);
  }
});

test('verification can never be disabled for a remote database (runtime or owner URL)', () => {
  assert.throws(() => loadDatabaseConfig(pg({ DATABASE_SSL: 'disable' })), /only allowed for a database on localhost/);
  assert.throws(() => loadDatabaseConfig({ DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://u:p@localhost/x', MIGRATION_DATABASE_URL: SESSION_OWNER, DATABASE_SSL: 'disable' }), /only allowed for a database on localhost/);
  assert.throws(() => loadDatabaseConfig(pg({ DATABASE_SSL: 'no-verify' })), /must be "verify"/);
  // Vercel production: remote database, verification on, CA from the environment.
  const v = loadConfig({
    VERCEL: '1', VERCEL_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME,
    TRUST_PROXY: 'true', PREVIEW_TOKEN_SECRET: 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE', DATABASE_SSL_CA_PEM: CA_A, PG_STARTUP_PARAMS: 'none', EMAIL_DRY_RUN: 'true',
  });
  assert.deepEqual([v.database.ssl, v.database.sslCaSource, v.database.startupParams], ['verify', 'env', []]);
  assert.throws(() => loadConfig({
    VERCEL: '1', VERCEL_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', DB_BACKEND: 'postgres', DATABASE_URL: REMOTE_RUNTIME,
    TRUST_PROXY: 'true', PREVIEW_TOKEN_SECRET: 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE', DATABASE_SSL: 'disable',
  }), /only allowed for a database on localhost/);
});

test('certificate contents and URLs never appear when the config is serialized or logged', () => {
  const c = loadDatabaseConfig({ ...pg({ DATABASE_SSL_CA_PEM: CA_A }), MIGRATION_DATABASE_URL: SESSION_OWNER });
  for (const out of [JSON.stringify(c), inspect(c, { depth: 5 }), JSON.stringify({ ...c })]) noSecrets(out, 'serialized config');
  const e = Object.assign(new Error(`tls failed for ${SESSION_OWNER} with ${CA_A}`), { code: 'SELF_SIGNED_CERT_IN_CHAIN' });
  const safe = safeDbError(e);
  noSecrets(safe, 'safeDbError');
  assert.match(safe, /SELF_SIGNED_CERT_IN_CHAIN/);
});

// ------------------------------------------------------- startup parameters --
test('startup parameters: all (default), none, or an explicit subset; timeouts keep their values', () => {
  const all = poolOptions(loadDatabaseConfig(pg()));
  assert.deepEqual([all.application_name, all.statement_timeout, all.idle_in_transaction_session_timeout], ['tangy-invitations', 10_000, 15_000]);
  const none = poolOptions(loadDatabaseConfig(pg({ PG_STARTUP_PARAMS: 'none' })));
  for (const k of STARTUP_PARAMS) assert.equal(k in none, false, `${k} not sent`);
  assert.equal(none.query_timeout, 15_000, 'client-side query timeout is always on');
  const some = poolOptions(loadDatabaseConfig(pg({ PG_STARTUP_PARAMS: ' Application_Name , statement_timeout ' })));
  assert.deepEqual(['application_name' in some, 'statement_timeout' in some, 'idle_in_transaction_session_timeout' in some], [true, true, false]);
  const custom = loadDatabaseConfig(pg({ PG_STATEMENT_TIMEOUT_MS: '8000', PG_IDLE_TX_TIMEOUT_MS: '20000' }));
  assert.deepEqual([custom.statementTimeoutMs, custom.idleInTxTimeoutMs], [8000, 20_000]);
  assert.equal(poolOptions(loadDatabaseConfig(pg({ PG_STARTUP_PARAMS: 'all' }))).idle_in_transaction_session_timeout, 15_000);
});

test('invalid pooler settings are rejected', () => {
  const bad = {
    PG_STARTUP_PARAMS: ['options', 'all,none', 'statement_timeout,bogus', ','],
    PG_STATEMENT_TIMEOUT_MS: ['0', '-1', '500', '200000', 'ten'],
    PG_IDLE_TX_TIMEOUT_MS: ['0', '999', '120001', '1.5'],
    PG_POOL_MAX: ['0', '21'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const v of values) assert.throws(() => loadDatabaseConfig(pg({ [key]: v })), new RegExp(key), `${key}=${v}`);
  }
});
