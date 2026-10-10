// Phase 4C preparation tools, without any database or network access.
// (Their PostgreSQL integration tests are in test/pg/postgres.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scramVerifier, PASSWORD_RE } from '../src/store/scram.js';
import { checkConnection, RUNTIME_PRIVILEGES } from '../src/store/pgCheck.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = (args, env, input) => spawnSync(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, input, encoding: 'utf8', timeout: 20_000 });

test('scram verifier: PostgreSQL format, random salt, plaintext never in the output', () => {
  const pw = 'Abc123._~-xyzXYZ0987654321';
  const v1 = scramVerifier(pw);
  const v2 = scramVerifier(pw);
  assert.match(v1, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(v1, v2, 'fresh salt each time');
  assert.ok(!v1.includes(pw));
  const fixed = scramVerifier(pw, { salt: Buffer.alloc(16, 7) });
  assert.equal(fixed, scramVerifier(pw, { salt: Buffer.alloc(16, 7) }), 'deterministic for a given salt');
});

test('scram verifier: refuses weak or URL-unsafe passwords', () => {
  for (const bad of ['short', 'has space in it 1234567890', 'p@ssword-with-at-sign-123456', 'colon:in:password:1234567890', 'x'.repeat(129), '', null]) {
    assert.throws(() => scramVerifier(bad), /24–128 characters/, String(bad).slice(0, 20));
  }
  assert.ok(PASSWORD_RE.test('a'.repeat(24)));
});

test('scram-verifier.js (real script) reads stdin, prints only the verifier, never the password', () => {
  const pw = 'StdinPassword-0123456789abcdef';
  const r = run(['scripts/scram-verifier.js'], {}, `${pw}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^SCRAM-SHA-256\$4096:/);
  assert.ok(!(r.stdout + r.stderr).includes(pw));
  const bad = run(['scripts/scram-verifier.js'], {}, 'weak\n');
  assert.equal(bad.status, 1);
  assert.ok(!(bad.stdout + bad.stderr).includes('weak\n'));
});

test('db-check refuses before connecting: wrong mode, sqlite, transaction pooler for owner, missing URL', async () => {
  let created = 0;
  const createClient = async () => { created++; throw new Error('must not connect'); };
  const cases = [
    [{ mode: 'admin', env: {} }, /Usage/],
    [{ mode: 'owner', env: { MIGRATION_DATABASE_URL: 'postgres://u:p@h:5432/x' } }, /DB_BACKEND=postgres/],
    [{ mode: 'owner', env: { DB_BACKEND: 'postgres', MIGRATION_DATABASE_URL: 'postgres://postgres.ref:OwnerPw123@pooler.example.com:6543/postgres' } }, /port 6543/],
    [{ mode: 'owner', env: { DB_BACKEND: 'postgres' } }, /needs MIGRATION_DATABASE_URL/],
    [{ mode: 'runtime', env: { DB_BACKEND: 'postgres' } }, /requires DATABASE_URL/],
  ];
  for (const [args, re] of cases) {
    let err;
    try { await checkConnection({ ...args, createClient, out: () => {} }); } catch (e) { err = e; }
    assert.match(err?.message ?? '', re);
    assert.ok(!err.message.includes('OwnerPw123'));
  }
  assert.equal(created, 0);
});

test('db-check reports a failed connection safely (no URL, no password) and exits 1 (real script)', () => {
  // 127.0.0.1:1 refuses immediately — no remote host is ever contacted.
  const r = run(['scripts/db-check.js', 'runtime'], { DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://mailer_app.ref:RuntimePw123@127.0.0.1:1/postgres', DATABASE_SSL: 'disable', PG_CONNECT_TIMEOUT_MS: '1000' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL {2}connect/);
  assert.match(r.stdout, /nothing was written/);
  assert.ok(!(r.stdout + r.stderr).includes('RuntimePw123') && !(r.stdout + r.stderr).includes('postgres://'));
});

test('runtime privilege expectations match migration 0001 grants exactly', () => {
  const sql = readFileSync(new URL('../migrations/postgres/0001_init.sql', import.meta.url), 'utf8');
  const granted = {};
  for (const m of sql.matchAll(/^grant ([a-z, ]+?)\s+on (mailer\.[a-z_]+)\s+to mailer_runtime;/gm)) {
    granted[m[2]] = m[1].split(',').map((p) => p.trim().toUpperCase()).sort();
  }
  for (const [table, { allow }] of Object.entries(RUNTIME_PRIVILEGES)) assert.deepEqual(granted[table], [...allow].sort(), table);
  assert.deepEqual(Object.keys(granted).sort(), Object.keys(RUNTIME_PRIVILEGES).sort());
});

test('setup files: env templates are private placeholders; SQL files are labelled and contain no secrets', () => {
  for (const f of ['.env.migrate', '.env.supabase']) {
    if (!existsSync(new URL(`../${f}`, import.meta.url))) continue; // local-only files
    assert.equal(statSync(new URL(`../${f}`, import.meta.url)).mode & 0o777, 0o600, `${f} is chmod 600`);
    const ignored = spawnSync('git', ['check-ignore', '-q', f], { cwd: ROOT });
    assert.equal(ignored.status, 0, `${f} is git-ignored`);
  }
  const role = readFileSync(new URL('../docs/supabase/01_runtime_role.sql', import.meta.url), 'utf8');
  assert.match(role, /CHANGES THE REMOTE DATABASE/);
  assert.match(role, /password '<SCRAM_VERIFIER>'/, 'placeholder, never a plaintext password');
  assert.match(role, /connection limit <MAX_CONNECTIONS>/, 'placeholder');
  assert.doesNotMatch(role, /SCRAM-SHA-256\$\d/i, 'never a real verifier');
  assert.match(role, /login inherit/);
  assert.match(role, /grant mailer_runtime to mailer_app;/);
  for (const attr of ['nosuperuser', 'nocreatedb', 'nocreaterole', 'noreplication', 'nobypassrls']) assert.ok(role.includes(attr), attr);
  const verify = readFileSync(new URL('../docs/supabase/02_verify.sql', import.meta.url), 'utf8');
  assert.match(verify, /READ-ONLY/);
  const statements = verify.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.ok(statements.every((l) => !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(l.replace(/--.*$/, ''))), 'verify.sql only reads');
  for (const f of ['99_rollback.sql', '99_rollback_0002.sql']) {
    const rollback = readFileSync(new URL(`../docs/supabase/${f}`, import.meta.url), 'utf8');
    assert.match(rollback, /DESTRUCTIVE/, f);
    assert.ok(rollback.split('\n').every((l) => !l.trim() || l.trim().startsWith('--')), `${f}: every rollback statement is commented out`);
  }
  for (const f of ['03_preflight_0002.sql', '04_verify_0002.sql']) {
    const sql = readFileSync(new URL(`../docs/supabase/${f}`, import.meta.url), 'utf8');
    assert.match(sql, /READ-ONLY/, f);
    // Comments and quoted literals (e.g. has_schema_privilege(…, 'create')) are data, not statements.
    const code = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--')).map((l) => l.replace(/--.*$/, '').replace(/'[^']*'/g, "''"));
    assert.ok(code.every((l) => !/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate)\b/i.test(l)), `${f} only reads`);
  }
});
