// Production preflight (src/preflight.js, scripts/preflight.js): read-only,
// no provider requests, never prints secret values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflight, formatPreflight } from '../src/preflight.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'test-preflight-key-never-printed-0000';
const SECRET = 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE';
const live = (extra = {}) => ({
  NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: SECRET, DB_BACKEND: 'sqlite',
  EMAIL_DRY_RUN: 'false', RESEND_API_KEY: KEY, EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', EMAIL_REPLY_TO: 'hello@tangysessions.com', ...extra,
});
const noDb = { readSqliteVersion: () => { throw new Error('must not open the database'); }, readPgVersion: async () => { throw new Error('must not connect'); } };

test('a fully configured SQLite setup is ready only after the manual domain check and a schema check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-preflight-'));
  try {
    writeFileSync(join(dir, 'mailer.db'), '');
    const env = live({ DATA_DIR: dir });
    let r = await runPreflight({ env, ...noDb });
    assert.equal(r.liveReady, false);
    assert.deepEqual(r.blockers, ['confirm the sender domain is verified in Resend (manual), then rerun with --domain-verified', 'check the database schema version (--db)']);
    r = await runPreflight({ env, checkDb: true, domainConfirmed: true, readSqliteVersion: () => 4 });
    assert.deepEqual([r.liveReady, r.blockers], [true, []]);
    r = await runPreflight({ env, checkDb: true, domainConfirmed: true, readSqliteVersion: () => 2 });
    assert.equal(r.liveReady, true, 'an older SQLite file is upgraded on start (reported, not blocking)');
    assert.ok(r.lines.some((l) => /SQLite schema version 2: upgraded to 4 on the next start/.test(l.text)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dry run, http origin, missing key/sender, ephemeral secret and unapproved PostgreSQL migration all block real sending', async () => {
  const r = await runPreflight({ env: { EMAIL_DRY_RUN: 'true', DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://u:p@localhost:5432/x', DATABASE_SSL: 'disable' }, ...noDb });
  assert.equal(r.dryRunReady, true);
  assert.equal(r.liveReady, false);
  for (const re of [/EMAIL_DRY_RUN is on/, /RESEND_API_KEY is missing/, /EMAIL_FROM is missing/, /APP_ORIGIN must be the public https address/, /set PREVIEW_TOKEN_SECRET/, /approve and apply migration 0002/]) {
    assert.ok(r.blockers.some((b) => re.test(b)), String(re));
  }
  const pg = await runPreflight({ env: live({ DB_BACKEND: 'postgres', DATABASE_URL: 'postgres://u:p@db.example.test:6543/x' }), checkDb: true, domainConfirmed: true, readPgVersion: async () => 1 });
  assert.ok(pg.lines.some((l) => /PostgreSQL schema version 1: campaigns unavailable \(needs 2\)/.test(l.text)));
  assert.equal(pg.liveReady, false);
});

test('invalid configuration fails the preflight without touching anything', async () => {
  const r = await runPreflight({ env: { EMAIL_DRY_RUN: 'treu' }, checkDb: true, ...noDb });
  assert.deepEqual([r.dryRunReady, r.liveReady], [false, false]);
  assert.match(r.lines[0].text, /EMAIL_DRY_RUN must be one of/);
});

test('the real script prints no secret values, makes no provider request, and --live fails until ready', () => {
  const run = (args, env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/preflight.js', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH, ...env } });
  const dir = mkdtempSync(join(tmpdir(), 'tangy-preflight-'));
  try {
    const env = live({ DATA_DIR: dir, DATABASE_URL: 'postgres://user:SuperSecretDbPw@db.example.test:6543/x' });
    const r = run([], env);
    assert.equal(r.status, 0, r.stderr);
    const out = r.stdout + r.stderr;
    for (const secret of [KEY, SECRET, 'SuperSecretDbPw', 'postgres://']) assert.ok(!out.includes(secret), `leaks ${secret.slice(0, 12)}`);
    assert.match(out, /RESEND_API_KEY is set \(value not shown\)/);
    assert.match(out, /UNKNOWN — not checked \(this preflight never contacts Resend\)/);
    assert.equal(run(['--live'], env).status, 1);
    const ready = run(['--live', '--db', '--domain-verified'], env);
    assert.equal(ready.status, 0, ready.stdout);
    assert.match(ready.stdout, /does not exist yet/);
    assert.match(ready.stdout, /Ready for real sending: {2}yes/);
    assert.equal(run([], { EMAIL_DRY_RUN: 'nope' }).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the formatted report lists the manual Resend/DNS steps', async () => {
  const text = formatPreflight(await runPreflight({ env: { EMAIL_DRY_RUN: 'true' }, ...noDb }));
  for (const re of [/Domains: the EMAIL_FROM domain shows "Verified"/, /_dmarc\.<domain>/, /List-Unsubscribe button/]) assert.match(text, re);
});
