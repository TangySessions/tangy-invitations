// Startup validation of the email settings (EMAIL_DRY_RUN, SEND_LIMIT_PER_10_MIN,
// RESEND_TIMEOUT_MS, EMAIL_REPLY_TO) and the secret scanner. No network, no
// database, no provider calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { loadConfig, parseDryRun } from '../src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE';
const KEY = 'test-resend-key-not-real-0000';
const dev = (extra = {}) => ({ EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', ...extra });
const prod = (extra = {}) => ({ NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: SECRET, DB_BACKEND: 'sqlite', ...dev(extra) });
const vercel = (extra = {}) => ({
  VERCEL: '1', VERCEL_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: SECRET, TRUST_PROXY: 'true',
  DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://mailer_app.ref:pw@db.example.test:6543/postgres', ...dev(extra),
});

// ------------------------------------------------------- EMAIL_DRY_RUN --
test('EMAIL_DRY_RUN: documented true/false words, case-insensitive, surrounding spaces ignored', () => {
  for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'Yes', ' on ', 'On']) {
    assert.equal(loadConfig(dev({ EMAIL_DRY_RUN: v })).email.dryRun, true, JSON.stringify(v));
    assert.equal(loadConfig(prod({ EMAIL_DRY_RUN: v })).email.dryRun, true, `production ${JSON.stringify(v)}`);
  }
  for (const v of ['false', '0', 'no', 'off', 'FALSE', 'No', ' off ']) {
    assert.equal(loadConfig(dev({ EMAIL_DRY_RUN: v })).email.dryRun, false, JSON.stringify(v));
    assert.equal(loadConfig(prod({ EMAIL_DRY_RUN: v })).email.dryRun, false, `production ${JSON.stringify(v)}`);
  }
});

test('EMAIL_DRY_RUN missing, empty or whitespace: dry run in development, even with a Resend key', () => {
  for (const env of [dev(), dev({ EMAIL_DRY_RUN: '' }), dev({ EMAIL_DRY_RUN: '   ' }), dev({ RESEND_API_KEY: KEY }), dev({ RESEND_API_KEY: KEY, EMAIL_DRY_RUN: '' })]) {
    const c = loadConfig(env);
    assert.equal(c.email.dryRun, true, JSON.stringify(env.EMAIL_DRY_RUN));
    assert.equal(c.email.dryRunSource, 'default');
  }
  assert.equal(loadConfig(dev({ EMAIL_DRY_RUN: 'true' })).email.dryRunSource, 'env');
});

test('EMAIL_DRY_RUN missing or empty: production and Vercel refuse to start', () => {
  for (const env of [prod(), prod({ EMAIL_DRY_RUN: '' }), prod({ EMAIL_DRY_RUN: ' ' }), prod({ RESEND_API_KEY: KEY }), vercel(), vercel({ RESEND_API_KEY: KEY })]) {
    assert.throws(() => loadConfig(env), /EMAIL_DRY_RUN must be set explicitly in production/);
  }
  assert.equal(loadConfig(vercel({ EMAIL_DRY_RUN: 'false' })).email.dryRun, false, 'an explicit false is accepted');
  assert.equal(loadConfig(vercel({ EMAIL_DRY_RUN: 'true' })).email.dryRun, true);
});

test('EMAIL_DRY_RUN invalid: refused everywhere, never read as "off"', () => {
  for (const v of ['treu', 'abc', 'fasle', 'tru', 'enabled', 'disabled', 'y', 'n', '2', '-1', 'true false', '"true"', 'null', 'undefined']) {
    for (const env of [dev({ EMAIL_DRY_RUN: v }), dev({ EMAIL_DRY_RUN: v, RESEND_API_KEY: KEY }), prod({ EMAIL_DRY_RUN: v }), vercel({ EMAIL_DRY_RUN: v })]) {
      assert.throws(() => loadConfig(env), /EMAIL_DRY_RUN must be one of/, JSON.stringify(v));
    }
  }
  assert.throws(() => parseDryRun('treu', { production: false }), /must be one of/);
  assert.deepEqual(parseDryRun(undefined, { production: false }), { dryRun: true, source: 'default' });
});

// ----------------------------------------------- SEND_LIMIT_PER_10_MIN --
test('SEND_LIMIT_PER_10_MIN: whole number 1–1000; missing means 30; anything else refused', () => {
  assert.equal(loadConfig(dev()).sendLimitPer10Min, 30);
  assert.equal(loadConfig(dev({ SEND_LIMIT_PER_10_MIN: '' })).sendLimitPer10Min, 30);
  for (const [v, n] of [['1', 1], ['30', 30], [' 45 ', 45], ['1000', 1000]]) assert.equal(loadConfig(dev({ SEND_LIMIT_PER_10_MIN: v })).sendLimitPer10Min, n, v);
  for (const v of ['0', '-1', '-30', '2.5', '30.0', 'abc', 'NaN', 'Infinity', '1e2', '0x1e', '30abc', '1001', '99999999999999999999']) {
    assert.throws(() => loadConfig(dev({ SEND_LIMIT_PER_10_MIN: v })), /SEND_LIMIT_PER_10_MIN must be a whole number from 1 to 1000/, v);
  }
});

// --------------------------------------------------- RESEND_TIMEOUT_MS --
test('RESEND_TIMEOUT_MS: whole number 1000–25000 ms; missing means 15000; anything else refused', () => {
  assert.equal(loadConfig(dev()).email.timeoutMs, 15_000);
  assert.equal(loadConfig(dev({ RESEND_TIMEOUT_MS: '' })).email.timeoutMs, 15_000);
  for (const [v, n] of [['1000', 1000], ['15000', 15_000], ['25000', 25_000]]) assert.equal(loadConfig(dev({ RESEND_TIMEOUT_MS: v })).email.timeoutMs, n, v);
  for (const v of ['0', '-1', '-15000', '1500.5', 'abc', 'NaN', '1e4', '999', '1', '25001', '60000']) {
    assert.throws(() => loadConfig(dev({ RESEND_TIMEOUT_MS: v })), /RESEND_TIMEOUT_MS must be a whole number from 1000 to 25000/, v);
  }
});

// ------------------------------------------------------ EMAIL_REPLY_TO --
test('EMAIL_REPLY_TO: optional; valid values kept; invalid values refused instead of dropped', () => {
  assert.equal(loadConfig(dev()).email.replyTo, '');
  assert.equal(loadConfig(dev({ EMAIL_REPLY_TO: '  ' })).email.replyTo, '');
  assert.equal(loadConfig(dev({ EMAIL_REPLY_TO: 'hello@tangysessions.com' })).email.replyTo, 'hello@tangysessions.com');
  assert.equal(loadConfig(dev({ EMAIL_REPLY_TO: 'Tangy Sessions <hello@tangysessions.com>' })).email.replyTo, 'Tangy Sessions <hello@tangysessions.com>');
  for (const v of ['hello', 'hello@', '@tangysessions.com', 'hello@tangysessions', 'a b@c.co', 'Name <not-an-address>', 'x@y.co, z@y.co']) {
    assert.throws(() => loadConfig(dev({ EMAIL_REPLY_TO: v })), /EMAIL_REPLY_TO must be an email address/, v);
  }
});

// ------------------------------------------------- invalid config, end to end --
test('server.js refuses to start on invalid email settings, before opening storage or contacting Resend', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-config-'));
  try {
    for (const [name, value] of [['EMAIL_DRY_RUN', 'treu'], ['SEND_LIMIT_PER_10_MIN', 'abc'], ['RESEND_TIMEOUT_MS', 'NaN'], ['EMAIL_REPLY_TO', 'nope']]) {
      const dataDir = join(dir, name);
      // RESEND_API_KEY is fake and api.resend.com is never reachable here:
      // the process must exit during configuration, before any request.
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
        cwd: ROOT, encoding: 'utf8', timeout: 20_000,
        env: { PATH: process.env.PATH, PORT: '0', DATA_DIR: dataDir, RESEND_API_KEY: KEY, EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', [name]: value },
      });
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, new RegExp(`^\\[config\\] ${name}`), name);
      assert.ok(!r.stdout.includes('listening'), `${name}: never listened`);
      assert.ok(!existsSync(dataDir), `${name}: storage never opened`);
      assert.ok(!(r.stdout + r.stderr).includes(KEY));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------- check:secrets --
const scan = (...files) => spawnSync(process.execPath, ['scripts/check-secrets.js', ...files], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 });

test('check:secrets flags a SCRAM-SHA-256 verifier (synthetic, built at run time) without printing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-secrets-'));
  try {
    // Random bytes in the verifier's shape — not a hash of any password.
    const b64 = (n) => randomBytes(n).toString('base64');
    const fake = `${['SCRAM', 'SHA', '256'].join('-')}$4096:${b64(16)}$${b64(32)}:${b64(32)}`;
    const planted = join(dir, '01_runtime_role.sql');
    writeFileSync(planted, `create role x with login\n  password '${fake}';\n`);
    const lower = join(dir, 'lower.txt');
    writeFileSync(lower, fake.toLowerCase());
    const r = scan(planted, lower);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /01_runtime_role\.sql:2 {2}value that looks like a SCRAM-SHA-256 password verifier/);
    assert.match(r.stderr, /lower\.txt:1 /);
    assert.ok(!(r.stdout + r.stderr).includes(fake) && !(r.stdout + r.stderr).includes(fake.split('$')[1]), 'the value is never printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('check:secrets passes the placeholder runtime-role template', () => {
  const r = scan('docs/supabase/01_runtime_role.sql');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 files scanned, no secrets found/);
});
