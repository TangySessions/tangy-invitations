// Campaign workflow end to end over HTTP: review → confirm → start →
// process (dry run and stubbed Resend) → results, plus the failure,
// concurrency and recovery cases. Synthetic recipients only; Resend is a
// stubbed fetch, so no request ever leaves the machine. Runs on SQLite
// (npm test) and on the disposable PostgreSQL at schema 2 (npm run test:pg).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { makeTestStore } from './helpers/testStore.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { IDEMPOTENCY_WINDOW_MS, AUTO_RETRY_ATTEMPTS } from '../src/campaigns.js';

const ORIGIN = 'https://app.test'; // real sending requires an https APP_ORIGIN (unsubscribe links)
const API_KEY = 'test-resend-key-not-real-0000';
const PASSWORD = 'correct horse battery staple';
let hash;
const TICKET = {
  name: 'Kickoff',
  subject: 'You are invited, {{recipient_name}} (demo)',
  html: readFileSync(new URL('../templates/tangy-ticket-demo.html', import.meta.url), 'utf8'),
  text: '',
};
const csvOf = (n, start = 0) => `name,email\n${Array.from({ length: n }, (_, i) => `Guest ${i + start},guest${i + start}@example.com`).join('\n')}\n`;

// Resend stub: by default accepts with a fresh id; queue per-call behaviour.
function resendStub() {
  const calls = [];
  const queue = [];
  let gate = null;
  return {
    calls,
    sends: () => calls.filter((c) => c.url.endsWith('/emails')),
    next: (fn) => queue.push(fn),
    hold() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
    fetch: async (url, init = {}) => {
      const call = { url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (call.url.endsWith('/domains')) return Response.json({ data: [{ name: 'tangysessions.com', status: 'verified' }] });
      if (gate) await gate;
      const fn = queue.shift();
      if (fn) return fn(call);
      return Response.json({ id: `msg_${calls.length}` });
    },
  };
}
const timeout = () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
const refused = () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
const status = (code) => () => Response.json({ name: 'error', message: `status ${code}` }, { status: code });

const SECRET = 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE';
// shared: { store, clockBox } of another boot — a second app instance on the
// same database (e.g. with a different secret).
async function boot({ dryRun = true, env = {}, log = { info() {}, error() {} }, wrapDb, shared } = {}) {
  const clockBox = shared?.clockBox ?? { t: Date.parse('2026-11-01T10:00:00Z') };
  const now = () => clockBox.t;
  const config = loadConfig({
    APP_ORIGIN: ORIGIN, RESEND_API_KEY: API_KEY, EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>',
    EMAIL_DRY_RUN: dryRun ? 'true' : 'false', RESEND_RATE_LIMIT_PER_SECOND: '10', PREVIEW_TOKEN_SECRET: SECRET, ...env,
  });
  const store = shared?.store ?? await makeTestStore({ now, schema: 2 });
  hash ??= await hashPassword(PASSWORD);
  if (!shared) await store.db.createAdmin('admin@tangy.test', hash);
  const resend = resendStub();
  const sleeps = [];
  const db = wrapDb ? wrapDb(store.db) : store.db;
  const server = createServer(createApp({ config, db, fetchImpl: resend.fetch, log, now, loginLimiter: store.loginLimiter, sleep: async (ms) => { sleeps.push(ms); } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, { cookie, csrf, origin = ORIGIN } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const login = async () => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email: 'admin@tangy.test', password: PASSWORD }) });
    const data = await res.json();
    return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: data.csrf_token };
  };
  const close = async () => { await new Promise((r) => server.close(r)); if (!shared) await store.close(); };
  // raw: an unauthenticated request with any method/body/headers (public unsubscribe).
  const raw = (path, { method = 'GET', body, headers = {} } = {}) => fetch(base + path, { method, body, headers });
  return { call, raw, login, close, resend, db: store.db, store, clockBox, sleeps, config, advance: (ms) => { clockBox.t += ms; }, now };
}

async function saveTemplate(t, s, id = 's1', overrides = {}) {
  const cur = (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
  const r = await t.call('PUT', `/api/sessions/${id}`, { ...TICKET, ...overrides, expected_version: cur.version }, s);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.session;
}
async function review(t, s, csv, session = 's1') {
  const r = await t.call('POST', '/api/campaigns/review', { session_id: session, csv }, s);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function confirmBody(rv, csv, extra = {}) {
  return {
    session_id: rv.session_id, csv, name: 'Kickoff invites', creation_key: randomUUID(),
    template_version: rv.template_version, template_hash: rv.template_hash, recipients_hash: rv.recipients_hash, confirm_count: rv.counts.valid, ...extra,
  };
}
async function confirmed(t, s, csv = csvOf(3), session = 's1') {
  const rv = await review(t, s, csv, session);
  const r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.campaign;
}
const act = (t, s, id, name, body = {}) => t.call('POST', `/api/campaigns/${id}/${name}`, body, s);
async function drain(t, s, id, max = 30) {
  let last;
  for (let i = 0; i < max; i++) {
    last = await act(t, s, id, 'process');
    assert.equal(last.status, 200, JSON.stringify(last.data));
    if (last.data.campaign.status !== 'sending' || last.data.processed === 0) break;
  }
  return last.data;
}
const recipients = async (t, s, id, q = '') => (await t.call('GET', `/api/campaigns/${id}/recipients${q}`, undefined, s)).data;

// ------------------------------------------------------------ dry run ---
test('dry run end to end: review → confirm → start → process; simulated, never sent, never "accepted"', async () => {
  const t = await boot({ dryRun: true });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = 'email,name\n"guest1@example.com","Doe, Jane"\nguest2@example.com,"Say ""hi"" Sam"\nbad,Bad\nGUEST1@example.com,Dup\n\n';
    const rv = await review(t, s, csv);
    assert.deepEqual(rv.counts, { total: 5, valid: 2, invalid: 1, duplicate: 1, blank: 1, skipped: 3 });
    assert.deepEqual(rv.campaigns, { available: true });
    assert.deepEqual(rv.previously_sent, []);
    assert.equal(rv.preview.html.includes('HEY Doe, Jane,'), true);
    // Review stores nothing.
    assert.deepEqual((await t.call('GET', '/api/campaigns', undefined, s)).data.campaigns, []);

    const r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const c = r.data.campaign;
    assert.deepEqual([c.status, c.total_recipients, c.csv_rows, c.invalid_rows, c.duplicate_rows, c.blank_rows, c.template_version, c.template_hash, c.recipients_hash],
      ['confirmed', 2, 5, 1, 1, 1, rv.template_version, rv.template_hash, rv.recipients_hash]);
    assert.equal(c.counts.pending, 2);
    assert.equal(c.created_by, 'admin@tangy.test');

    assert.equal((await act(t, s, c.id, 'process')).data.processed, 0, 'nothing is sent before Start');
    assert.equal((await act(t, s, c.id, 'start')).data.campaign.status, 'sending');
    const out = await drain(t, s, c.id);
    assert.equal(out.dry_run, true);
    assert.equal(out.campaign.status, 'completed');
    assert.deepEqual([out.campaign.counts.dry_run, out.campaign.counts.accepted], [2, 0], 'simulated, not reported as accepted');
    assert.equal(t.resend.calls.length, 0, 'no provider request of any kind');
    const rows = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual(rows.map((x) => [x.row_number, x.name, x.email, x.status, x.attempts, x.provider_message_id]),
      [[2, 'Doe, Jane', 'guest1@example.com', 'dry_run', 1, null], [3, 'Say "hi" Sam', 'guest2@example.com', 'dry_run', 1, null]]);
    const list = (await t.call('GET', '/api/campaigns', undefined, s)).data;
    assert.deepEqual([list.campaigns.length, list.campaigns[0].id, list.dry_run], [1, c.id, true]);
  } finally { await t.close(); }
});

// ------------------------------------------------------- confirmation ---
test('confirmation is idempotent: repeated and concurrent submits with one key create one campaign', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = csvOf(4);
    const rv = await review(t, s, csv);
    const body = confirmBody(rv, csv);
    const [a, b] = await Promise.all([t.call('POST', '/api/campaigns', body, s), t.call('POST', '/api/campaigns', body, s)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    assert.equal(a.data.campaign.id, b.data.campaign.id);
    const again = await t.call('POST', '/api/campaigns', body, s);
    assert.deepEqual([again.status, again.data.duplicate, again.data.campaign.id], [200, true, a.data.campaign.id]);
    const list = (await t.call('GET', '/api/campaigns', undefined, s)).data.campaigns;
    assert.equal(list.length, 1);
    assert.equal(list[0].total_recipients, 4);
    assert.equal((await recipients(t, s, list[0].id)).total, 4, 'recipients inserted once');
    // The same key for a different list is refused.
    const csv2 = csvOf(2, 50);
    const rv2 = await review(t, s, csv2);
    const r = await t.call('POST', '/api/campaigns', confirmBody(rv2, csv2, { creation_key: body.creation_key }), s);
    assert.deepEqual([r.status, r.data.code], [409, 'key_mismatch']);
  } finally { await t.close(); }
});

test('stale reviews are refused: template changed, list changed, wrong count, session busy, bad input', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = csvOf(3);
    const rv = await review(t, s, csv);
    let r = await t.call('POST', '/api/campaigns', confirmBody(rv, csvOf(3, 1)), s);
    assert.deepEqual([r.status, r.data.code], [409, 'list_changed']);
    r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv, { confirm_count: 2 }), s);
    assert.deepEqual([r.status, r.data.code], [400, 'confirm_count']);
    r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv, { template_hash: 'a'.repeat(64) }), s);
    assert.deepEqual([r.status, r.data.code], [409, 'template_changed']);
    for (const bad of [{ name: '' }, { name: 'x'.repeat(101) }, { creation_key: 'nope' }, { template_hash: 'xyz' }, { csv: 5 }, { extra: 1 }]) {
      assert.equal((await t.call('POST', '/api/campaigns', confirmBody(rv, csv, bad), s)).status, 400, JSON.stringify(bad));
    }
    await saveTemplate(t, s, 's1', { subject: 'Changed {{recipient_name}}' });
    r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
    assert.deepEqual([r.status, r.data.code, r.data.current_version], [409, 'template_changed', rv.template_version + 1]);
    const first = await confirmed(t, s, csv);
    const rv3 = await review(t, s, csvOf(2, 9));
    r = await t.call('POST', '/api/campaigns', confirmBody(rv3, csvOf(2, 9)), s);
    assert.deepEqual([r.status, r.data.code, r.data.campaign_id], [409, 'session_busy', first.id]);
    await saveTemplate(t, s, 's2', { active: false });
    const rv4 = await review(t, s, csv, 's2');
    r = await t.call('POST', '/api/campaigns', confirmBody(rv4, csv), s);
    assert.deepEqual([r.status, r.data.code], [409, 'session_inactive']);
    assert.equal((await t.call('GET', '/api/campaigns', undefined, s)).data.campaigns.length, 1);
  } finally { await t.close(); }
});

test('campaign routes require sign-in, CSRF and this origin; unknown ids are 404', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s);
    assert.equal((await t.call('GET', '/api/campaigns')).status, 401);
    assert.equal((await t.call('GET', `/api/campaigns/${c.id}`)).status, 401);
    assert.equal((await t.call('GET', `/api/campaigns/${c.id}/recipients`)).status, 401);
    for (const path of ['/api/campaigns', `/api/campaigns/${c.id}/start`, `/api/campaigns/${c.id}/process`, `/api/campaigns/${c.id}/cancel`]) {
      assert.equal((await t.call('POST', path, {})).status, 401, `${path} signed out`);
      assert.equal((await t.call('POST', path, {}, { cookie: s.cookie })).status, 403, `${path} without CSRF`);
      assert.equal((await t.call('POST', path, {}, { ...s, origin: 'https://evil.example' })).status, 403, `${path} foreign origin`);
    }
    assert.equal((await t.call('GET', `/api/campaigns/${randomUUID()}`, undefined, s)).status, 404);
    assert.equal((await t.call('GET', '/api/campaigns/not-a-uuid', undefined, s)).status, 404);
    assert.equal((await t.call('POST', `/api/campaigns/${c.id}/explode`, {}, s)).status, 404);
    assert.equal((await t.call('GET', `/api/campaigns/${c.id}/recipients?status=nope`, undefined, s)).status, 400);
    assert.equal((await act(t, s, c.id, 'start', { force: true })).status, 400, 'no extra fields');
    assert.equal((await t.call('GET', `/api/campaigns/${c.id}`, undefined, s)).data.campaign.status, 'confirmed');
  } finally { await t.close(); }
});

// -------------------------------------------------------- state machine ---
test('state transitions are enforced by the server', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s);
    const expect409 = async (name) => {
      const r = await act(t, s, c.id, name);
      assert.deepEqual([r.status, r.data.code], [409, 'invalid_state'], name);
    };
    await expect409('pause');
    await expect409('resume');
    await expect409('complete');
    assert.equal((await act(t, s, c.id, 'retry', { kind: 'failed' })).status, 409);
    assert.equal((await act(t, s, c.id, 'start')).status, 200);
    await expect409('start');
    await expect409('resume');
    const done = await act(t, s, c.id, 'complete');
    assert.equal(done.status, 409, 'pending recipients block completion');
    assert.match(done.data.error, /still pending/);
    assert.equal((await act(t, s, c.id, 'pause')).data.campaign.status, 'paused');
    assert.equal((await act(t, s, c.id, 'process')).data.processed, 0, 'a paused campaign sends nothing');
    assert.equal((await act(t, s, c.id, 'resume')).data.campaign.status, 'sending');
    const cancelled = (await act(t, s, c.id, 'cancel')).data.campaign;
    assert.deepEqual([cancelled.status, cancelled.counts.skipped, cancelled.counts.pending], ['cancelled', 3, 0]);
    for (const name of ['start', 'pause', 'resume', 'cancel', 'complete']) await expect409(name);
    assert.equal((await act(t, s, c.id, 'process')).data.processed, 0);
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

// ---------------------------------------------------- real path (stub) ---
test('live path (stubbed Resend): one personalized message per recipient, stable idempotency keys, accepted ≠ delivered', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = 'name,email\n"<b>Eve</b> & ""Co""",eve@example.com\nAsha,asha@example.com\nBen,ben@example.com\n';
    const c = await confirmed(t, s, csv);
    await act(t, s, c.id, 'start');
    const out = await drain(t, s, c.id);
    assert.deepEqual([out.campaign.status, out.campaign.counts.accepted, out.dry_run], ['completed', 3, false]);
    const sends = t.resend.sends();
    assert.equal(sends.length, 3);
    for (const call of sends) {
      assert.equal(call.body.to.length, 1);
      assert.equal(call.body.cc, undefined);
      assert.equal(call.body.bcc, undefined);
      assert.match(call.headers['Idempotency-Key'], /^tangy-campaign\/[0-9a-f-]{36}$/);
      assert.ok(call.body.tags.some((x) => x.name === 'campaign' && x.value === c.id));
      assert.ok(call.body.tags.some((x) => x.name === 'kind' && x.value === 'campaign'));
      assert.ok(call.body.text && call.body.text.includes('DEMO INVITATION'), 'a plain-text part is always included');
    }
    assert.equal(new Set(sends.map((x) => x.headers['Idempotency-Key'])).size, 3, 'one key per recipient');
    const eve = sends.find((x) => x.body.to[0] === 'eve@example.com');
    assert.ok(eve.body.html.includes('HEY &lt;b&gt;Eve&lt;/b&gt; &amp; &quot;Co&quot;,'), 'name escaped in HTML');
    assert.ok(eve.body.html.includes('<td align="right">eve@example.com</td>'), '{{recipient_email}} filled');
    assert.equal(eve.body.subject, 'You are invited, <b>Eve</b> & "Co" (demo)');
    assert.ok(eve.body.text.includes('GUEST <b>Eve</b> & "Co"'), 'plain text is plain');
    const rows = (await recipients(t, s, c.id)).recipients;
    assert.ok(rows.every((x) => x.status === 'accepted' && /^msg_\d+$/.test(x.provider_message_id)));
    // A later review of the same session warns about these addresses.
    const rv = await review(t, s, 'name,email\nAsha,ASHA@example.com\nNew,new@example.com\n');
    assert.deepEqual(rv.previously_sent.map((p) => [p.email, p.campaign_id]), [['asha@example.com', c.id]]);
  } finally { await t.close(); }
});

test('provider failures: not-sent retries with backoff (same key), uncertain outcomes are never retried automatically', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(4));
    await act(t, s, c.id, 'start');
    t.resend.next(timeout);      // guest0: timeout → unresolved
    t.resend.next(refused);      // guest1: never reached Resend → retry later
    t.resend.next(status(422));  // guest2: rejected
    t.resend.next(status(500));  // guest3: 5xx → unresolved
    let out = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual(out.tally, { accepted: 0, dry_run: 0, retry_later: 1, failed: 0, rejected: 1, unresolved: 2, suppressed: 0 });
    assert.equal(out.campaign.status, 'sending', 'not complete: a retry is scheduled');
    assert.ok(out.next_delay_ms >= 1000, 'the page is told when to come back');
    let rows = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual(rows.map((x) => [x.email, x.status, x.reason, x.attempts]), [
      ['guest0@example.com', 'unresolved', 'timeout', 1], ['guest1@example.com', 'pending', 'network', 1],
      ['guest2@example.com', 'rejected', 'provider_rejected', 1], ['guest3@example.com', 'unresolved', 'provider_unavailable', 1]]);
    const keyOf = (email) => t.resend.sends().filter((x) => x.body.to[0] === email).map((x) => x.headers['Idempotency-Key']);
    // Before the backoff: nothing is due.
    out = (await act(t, s, c.id, 'process')).data;
    assert.equal(out.processed, 0);
    t.advance(31_000);
    out = (await act(t, s, c.id, 'process')).data;
    assert.equal(out.tally.accepted, 1);
    assert.equal(new Set(keyOf('guest1@example.com')).size, 1, 'the retry reused the same idempotency key');
    assert.equal(keyOf('guest0@example.com').length, 1, 'the timed-out one was not retried');
    assert.equal(out.campaign.status, 'sending', 'unresolved recipients keep it open for a decision');
    // An admin retries the unresolved ones: same keys, so Resend de-duplicates.
    const retry = await act(t, s, c.id, 'retry', { kind: 'unresolved' });
    assert.equal(retry.data.retried, 2);
    out = await drain(t, s, c.id);
    assert.deepEqual([out.campaign.status, out.campaign.counts.accepted, out.campaign.counts.rejected], ['completed', 3, 1]);
    for (const e of ['guest0@example.com', 'guest3@example.com']) assert.equal(new Set(keyOf(e)).size, 1, `${e}: one key for both attempts`);
    rows = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual(rows.map((x) => x.attempts), [2, 2, 1, 2]);
  } finally { await t.close(); }
});

test('bounded retries: repeated connection failures end as failed; admin can retry failed or complete', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(1));
    await act(t, s, c.id, 'start');
    for (let i = 0; i < AUTO_RETRY_ATTEMPTS; i++) {
      t.resend.next(refused);
      await act(t, s, c.id, 'process');
      t.advance(10 * 60_000);
    }
    let rows = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual([rows[0].status, rows[0].reason, rows[0].attempts], ['failed', 'retries_exhausted', AUTO_RETRY_ATTEMPTS]);
    assert.equal((await act(t, s, c.id, 'process')).data.processed, 0, 'no automatic retry after the limit');
    assert.equal((await act(t, s, c.id, 'retry', { kind: 'failed' })).data.retried, 1);
    const out = await drain(t, s, c.id);
    assert.deepEqual([out.campaign.status, out.campaign.counts.accepted], ['completed', 1]);
    rows = (await recipients(t, s, c.id)).recipients;
    assert.equal(rows[0].attempts, AUTO_RETRY_ATTEMPTS + 1);
  } finally { await t.close(); }
});

test('429 pauses the batch; 401/403 pause the campaign with nothing more sent', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(3));
    await act(t, s, c.id, 'start');
    t.resend.next(status(429));
    let out = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([out.processed, out.tally.retry_later, out.next_delay_ms], [1, 1, 60_000], 'stops this batch after a 429');
    t.advance(61_000);
    t.resend.next(status(403));
    out = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([out.stopped, out.campaign.status, out.campaign.stop_reason], ['sender_not_verified', 'paused', 'sender_not_verified']);
    assert.match(out.stop_message, /not verified/);
    const sent = t.resend.sends().length;
    assert.equal((await act(t, s, c.id, 'process')).data.processed, 0);
    assert.equal(t.resend.sends().length, sent);
    const rows = (await recipients(t, s, c.id)).recipients;
    assert.ok(rows.every((x) => x.status === 'pending'), 'refused requests were not accepted; recipients wait');
    await act(t, s, c.id, 'resume');
    t.resend.next(status(401));
    out = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([out.stopped, out.campaign.status], ['error', 'paused']);
  } finally { await t.close(); }
});

// ------------------------------------------------ concurrency / recovery ---
test('two workers at once (two tabs): every recipient is sent exactly once', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(6));
    await act(t, s, c.id, 'start');
    for (let round = 0; round < 6; round++) {
      const results = await Promise.all([act(t, s, c.id, 'process'), act(t, s, c.id, 'process'), act(t, s, c.id, 'process')]);
      for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.data));
      t.advance(5000);
    }
    const byTo = {};
    for (const x of t.resend.sends()) byTo[x.body.to[0]] = (byTo[x.body.to[0]] || 0) + 1;
    assert.deepEqual(Object.values(byTo), [1, 1, 1, 1, 1, 1]);
    const camp = (await t.call('GET', `/api/campaigns/${c.id}`, undefined, s)).data.campaign;
    assert.deepEqual([camp.status, camp.counts.accepted], ['completed', 6]);
  } finally { await t.close(); }
});

test('crash recovery: a stale claim is resent with the same key; after the key window it becomes unresolved instead', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(2));
    await act(t, s, c.id, 'start');
    // A worker claims guest0 and dies before recording anything.
    const claim = await t.db.claimNextRecipient(c.id, { now: t.now(), staleMs: t.config.email.timeoutMs + 60_000 });
    assert.equal(claim.outcome, 'claimed');
    let out = (await act(t, s, c.id, 'process')).data;
    assert.equal(out.processed, 0, 'a fresh claim is in flight: wait');
    t.advance(t.config.email.timeoutMs + 61_000);
    out = await drain(t, s, c.id);
    assert.equal(out.campaign.counts.accepted, 2);
    const key = t.resend.sends().find((x) => x.body.to[0] === 'guest0@example.com').headers['Idempotency-Key'];
    assert.equal(key, `tangy-campaign/${claim.recipient.send_id}`);
    const rows = (await recipients(t, s, c.id)).recipients;
    assert.equal(rows[0].attempts, 2);

    // Same, but the worker died long ago: Resend no longer remembers the key.
    await saveTemplate(t, s, 's2');
    const c2 = await confirmed(t, s, csvOf(1, 10), 's2');
    await act(t, s, c2.id, 'start');
    await t.db.claimNextRecipient(c2.id, { now: t.now(), staleMs: 1 });
    t.advance(IDEMPOTENCY_WINDOW_MS + 60_000);
    const s2 = await t.login(); // the old sign-in expired (12 h) while the clock jumped
    const before = t.resend.sends().length;
    out = await drain(t, s2, c2.id);
    assert.equal(t.resend.sends().length, before, 'not resent: it might already have been delivered');
    const r2 = (await recipients(t, s2, c2.id)).recipients[0];
    assert.deepEqual([r2.status, r2.reason], ['unresolved', 'unknown']);
    assert.equal((await act(t, s2, c2.id, 'retry', { kind: 'unresolved' })).data.retried, 0, 'outside the key window: no retry');
  } finally { await t.close(); }
});

test('cancel during sending: pending recipients are skipped, an in-flight request still records its outcome', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(3));
    await act(t, s, c.id, 'start');
    const release = t.resend.hold();
    const inflight = act(t, s, c.id, 'process');
    while (t.resend.sends().length === 0) await new Promise((r) => setTimeout(r, 5));
    const cancelled = (await act(t, s, c.id, 'cancel')).data.campaign;
    assert.equal(cancelled.status, 'cancelled');
    release();
    const out = (await inflight).data;
    assert.equal(t.resend.sends().length, 1, 'no new request after the cancel');
    assert.deepEqual([out.campaign.counts.accepted, out.campaign.counts.skipped], [1, 2], 'cannot undo an accepted email; the rest are skipped');
  } finally { await t.close(); }
});

test('the template changing after confirmation pauses sending; nothing changed is sent', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(2));
    await act(t, s, c.id, 'start');
    await saveTemplate(t, s, 's1', { subject: 'Edited {{recipient_name}}' });
    const out = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([out.stopped, out.campaign.status, out.processed], ['template_changed', 'paused', 0]);
    assert.match(out.stop_message, /review and confirm the list again/);
    assert.equal(t.resend.calls.length, 0);
    await act(t, s, c.id, 'resume');
    assert.equal((await act(t, s, c.id, 'process')).data.campaign.status, 'paused', 'still refuses after resume');
    await saveTemplate(t, s, 's1', { active: false });
  } finally { await t.close(); }
});

test('pacing: live requests are spaced by RESEND_RATE_LIMIT_PER_SECOND; dry runs are not', async () => {
  const t = await boot({ dryRun: false, env: { RESEND_RATE_LIMIT_PER_SECOND: '2' } });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(3));
    await act(t, s, c.id, 'start');
    await act(t, s, c.id, 'process');
    // Fake clock: each later request in the batch waits the full interval.
    assert.deepEqual(t.sleeps, [500, 500]);
  } finally { await t.close(); }
});

test('recipient list pagination and status filter', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(60));
    const p1 = await recipients(t, s, c.id);
    const p2 = await recipients(t, s, c.id, '?page=2');
    assert.deepEqual([p1.total, p1.recipients.length, p2.recipients.length, p1.page_size], [60, 50, 10, 50]);
    assert.deepEqual([p1.recipients[0].row_number, p2.recipients.at(-1).row_number], [2, 61]);
    assert.equal(p1.recipients[0].send_id, undefined, 'internal ids are not exposed');
    assert.equal((await recipients(t, s, c.id, '?status=accepted')).total, 0);
    assert.equal((await t.call('GET', `/api/campaigns/${c.id}/recipients?page=0`, undefined, s)).status, 400);
  } finally { await t.close(); }
});

test('logs carry ids and counts only — never names, addresses or bodies', async () => {
  const lines = [];
  const log = { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const t = await boot({ dryRun: false, log });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, 'name,email\nSecret Person,secret.person@example.com\n');
    await act(t, s, c.id, 'start');
    t.resend.next(timeout);
    await act(t, s, c.id, 'process');
    const out = lines.join('\n');
    assert.match(out, /\[campaign\] confirmed id=[0-9a-f-]{36} session=s1 recipients=1/);
    assert.match(out, /\[campaign\] batch id=.* unresolved=1/);
    for (const needle of ['Secret', 'secret.person', 'You are invited', API_KEY, '<html']) assert.ok(!out.includes(needle), needle);
  } finally { await t.close(); }
});

test('campaigns unavailable (database at schema version 1): review works, confirming explains why it is refused', async () => {
  const reason = 'Campaigns need database schema version 2 (migration 0002_campaigns). This database is at version 1.';
  const t = await boot({ wrapDb: (db) => ({ ...db, campaignsAvailable: async () => ({ available: false, schema_version: 1, required_version: 2, reason }) }) });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = csvOf(2);
    const rv = await review(t, s, csv);
    assert.equal(rv.campaigns.available, false);
    const r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
    assert.deepEqual([r.status, r.data.code, r.data.error], [503, 'campaigns_unavailable', reason]);
    const list = (await t.call('GET', '/api/campaigns', undefined, s)).data;
    assert.deepEqual([list.availability.available, list.campaigns], [false, []]);
    assert.equal((await t.call('GET', `/api/campaigns/${randomUUID()}`, undefined, s)).status, 503);
  } finally { await t.close(); }
});

// ------------------------------------------------ unsubscribe / suppression ---
const ONE_CLICK = { method: 'POST', body: 'List-Unsubscribe=One-Click', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
const linkOf = (call) => /^<(https:\/\/app\.test\/api\/unsubscribe\/([A-Za-z0-9_-]{43}))>$/.exec(call.headers ? call.body.headers['List-Unsubscribe'] : '');
async function sentCampaign(t, s, csv, session = 's1') {
  const c = await confirmed(t, s, csv, session);
  await act(t, s, c.id, 'start');
  return { c, out: await drain(t, s, c.id) };
}

test('every campaign email carries a visible unsubscribe link and RFC 8058 headers; the URL holds no address or id', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const { c } = await sentCampaign(t, s, csvOf(2));
    const sends = t.resend.sends();
    const tokens = new Set();
    for (const call of sends) {
      const m = linkOf(call);
      assert.ok(m, 'List-Unsubscribe is one https URL in <>');
      assert.equal(call.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
      assert.ok(call.body.html.includes(`<a href="${m[1]}" style="color:#8a8a8a;text-decoration:underline">Unsubscribe</a> from future invitations.`), 'visible link = header link');
      assert.ok(call.body.text.endsWith(`Unsubscribe from future invitations: ${m[1]}`), 'plain text has the link too');
      for (const leak of [call.body.to[0], c.id, encodeURIComponent(call.body.to[0])]) assert.ok(!m[1].includes(leak), 'no address or id in the URL');
      tokens.add(m[2]);
    }
    assert.equal(tokens.size, 2, 'one token per recipient');
  } finally { await t.close(); }
});

test('unsubscribe: GET only asks; one-click POST records it once (idempotent); later campaigns skip the address', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    await saveTemplate(t, s, 's2');
    await sentCampaign(t, s, 'name,email\nAsha,asha@example.com\nBen,ben@example.com\n');
    const link = linkOf(t.resend.sends().find((x) => x.body.to[0] === 'asha@example.com'))[1];
    const path = new URL(link).pathname;
    // A confirmed-but-not-yet-sent campaign that includes Asha.
    const later = await confirmed(t, s, 'name,email\nAsha,asha@example.com\nCy,cy@example.com\n', 's2');

    const get = await t.raw(path);
    assert.equal(get.status, 200);
    const page = await get.text();
    assert.match(page, /Unsubscribe from invitations\?/);
    assert.match(page, new RegExp(`<form method="post" action="${path}"><input type="hidden" name="List-Unsubscribe" value="One-Click">`));
    assert.ok(!page.includes('asha@example.com'));
    assert.equal(await t.db.isSuppressed((await import('../src/unsubscribe.js')).suppressionHash('asha@example.com')), false, 'a GET (e.g. a link scanner) changes nothing');

    for (let i = 0; i < 3; i++) {
      const r = await t.raw(path, ONE_CLICK);
      assert.equal(r.status, 200);
      assert.match(await r.text(), /You are unsubscribed/);
    }
    const { suppressionHash } = await import('../src/unsubscribe.js');
    assert.equal(await t.db.isSuppressed(suppressionHash('ASHA@example.com')), true);
    // The pending recipient in the later campaign was skipped at once.
    const rows = (await recipients(t, s, later.id)).recipients;
    assert.deepEqual(rows.map((x) => [x.email, x.status, x.reason]), [['asha@example.com', 'skipped', 'suppressed'], ['cy@example.com', 'pending', null]]);
    const before = t.resend.sends().length;
    await act(t, s, later.id, 'start');
    const out = await drain(t, s, later.id);
    assert.deepEqual(t.resend.sends().slice(before).map((x) => x.body.to[0]), ['cy@example.com'], 'Asha never reaches the provider');
    assert.deepEqual([out.campaign.status, out.campaign.counts.suppressed, out.campaign.counts.skipped, out.campaign.counts.accepted], ['completed', 1, 1, 1]);
    // A new review shows the opted-out row; confirming keeps it skipped.
    const csv = 'name,email\nAsha,asha@example.com\nDee,dee@example.com\n';
    const rv = await review(t, s, csv);
    assert.deepEqual(rv.suppressed_rows, [2]);
    const r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.deepEqual([r.data.campaign.counts.pending, r.data.campaign.counts.suppressed], [1, 1]);
    // Single invitations respect it too (test emails to the admin do not).
    const p = await t.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Asha', email: 'asha@example.com' }, s);
    const single = await t.call('POST', '/api/send', { session_id: 's1', name: 'Asha', email: 'asha@example.com', template_version: p.data.template_version, preview_token: p.data.preview_token, idempotency_key: randomUUID() }, s);
    assert.deepEqual([single.status, single.data.code], [409, 'suppressed']);
  } finally { await t.close(); }
});

test('unsubscribe: invalid, malformed and expired tokens; incomplete POSTs change nothing; nothing leaks', async () => {
  const lines = [];
  const t = await boot({ dryRun: false, log: { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) } });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    await sentCampaign(t, s, 'name,email\nAsha,asha@example.com\n');
    const [, link, token] = linkOf(t.resend.sends()[0]);
    const path = new URL(link).pathname;
    const { suppressionHash } = await import('../src/unsubscribe.js');
    for (const bad of ['x', 'preview', `${token}x`, token.slice(1), `${token.slice(0, 42)}!`, 'A'.repeat(43), '..%2F..%2Fadmin']) {
      const r = await t.raw(`/api/unsubscribe/${bad}`);
      assert.equal(r.status, 404, bad);
      const body = await r.text();
      assert.match(body, /Link not valid/);
      assert.ok(!body.includes(token));
      assert.equal((await t.raw(`/api/unsubscribe/${bad}`, ONE_CLICK)).status, 404);
    }
    for (const incomplete of [{ method: 'POST' }, { method: 'POST', body: 'unsubscribe=yes' }, { method: 'POST', body: 'x'.repeat(5000) }]) {
      assert.equal((await t.raw(path, incomplete)).status, 400);
    }
    assert.equal((await t.raw(path, { method: 'DELETE' })).status, 404);
    assert.equal(await t.db.isSuppressed(suppressionHash('asha@example.com')), false);
    // A year later the link has expired (410); nothing is recorded.
    t.advance(366 * 24 * 60 * 60 * 1000);
    const old = await t.raw(path, ONE_CLICK);
    assert.equal(old.status, 410);
    assert.match(await old.text(), /expired/);
    assert.equal(await t.db.isSuppressed(suppressionHash('asha@example.com')), false);
    t.advance(-366 * 24 * 60 * 60 * 1000);
    assert.equal((await t.raw(path, ONE_CLICK)).status, 200);
    const out = lines.join('\n');
    assert.match(out, /\[unsubscribe\] campaign=[0-9a-f-]{36} new=true skipped_pending=0/);
    for (const needle of [token, 'asha', 'Asha']) assert.ok(!out.includes(needle), `log leaks ${needle}`);
  } finally { await t.close(); }
});

test('suppression is checked immediately before sending: a stale claim, a queued recipient and an admin retry cannot bypass it', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const { suppressionHash } = await import('../src/unsubscribe.js');
    const optOut = (email) => t.db.recordUnsubscribe({ emailHash: suppressionHash(email), email, campaignId: null, source: 'admin', now: t.now() });
    const c = await confirmed(t, s, csvOf(3));
    await act(t, s, c.id, 'start');
    // Race 1: guest0 is claimed (in a worker's hands) when the opt-out lands.
    const claim = await t.db.claimNextRecipient(c.id, { now: t.now(), staleMs: t.config.email.timeoutMs + 60_000 });
    assert.equal(claim.recipient.email, 'guest0@example.com');
    await optOut('guest0@example.com');
    t.advance(t.config.email.timeoutMs + 61_000); // the claim goes stale; the next batch takes it over
    // Race 2: guest1 opts out while guest… is being sent (provider call held open).
    const release = t.resend.hold();
    const inflight = act(t, s, c.id, 'process');
    while (!t.resend.sends().length) await new Promise((r) => setTimeout(r, 5));
    await optOut('guest2@example.com');
    release();
    const out = (await inflight).data;
    const sentTo = t.resend.sends().map((x) => x.body.to[0]);
    assert.deepEqual(sentTo, ['guest1@example.com'], 'suppressed addresses never reached the provider');
    // guest0 (claimed) was caught by the pre-send check; guest2 (still queued)
    // was skipped by the unsubscribe itself.
    assert.equal(out.tally.suppressed, 1);
    let rows = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual(rows.map((x) => [x.status, x.reason]), [['skipped', 'suppressed'], ['accepted', null], ['skipped', 'suppressed']]);
    assert.equal(out.campaign.status, 'completed');

    // Retry cannot bypass it: a failed recipient opts out, then an admin retries.
    const c2 = await confirmed(t, s, csvOf(1, 7));
    await act(t, s, c2.id, 'start');
    for (let i = 0; i < 3; i++) { t.resend.next(refused); await act(t, s, c2.id, 'process'); t.advance(10 * 60_000); }
    rows = (await recipients(t, s, c2.id)).recipients;
    assert.equal(rows[0].status, 'failed');
    await optOut('guest7@example.com');
    const s2 = await t.login();
    assert.equal((await act(t, s2, c2.id, 'retry', { kind: 'failed' })).data.retried, 1);
    const before = t.resend.sends().length;
    const done = await drain(t, s2, c2.id);
    assert.equal(t.resend.sends().length, before, 'no request after the retry');
    assert.deepEqual([done.campaign.counts.suppressed, done.campaign.status], [1, 'completed']);
  } finally { await t.close(); }
});

test('real sending refuses a non-https APP_ORIGIN and a changed unsubscribe key; dry runs are unaffected', async () => {
  const http = await boot({ dryRun: false, env: { APP_ORIGIN: 'http://localhost:8787' } });
  try {
    const o = 'http://localhost:8787';
    const res = await http.raw('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: o }, body: JSON.stringify({ email: 'admin@tangy.test', password: PASSWORD }) });
    const s = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf_token, origin: o };
    const cur = (await http.call('GET', '/api/sessions/s1', undefined, s)).data.session;
    assert.equal((await http.call('PUT', '/api/sessions/s1', { ...TICKET, expected_version: cur.version }, s)).status, 200);
    const csv = csvOf(1);
    const rv = (await http.call('POST', '/api/campaigns/review', { session_id: 's1', csv }, s)).data;
    const c = (await http.call('POST', '/api/campaigns', confirmBody(rv, csv), s)).data.campaign;
    await http.call('POST', `/api/campaigns/${c.id}/start`, {}, s);
    const out = (await http.call('POST', `/api/campaigns/${c.id}/process`, {}, s)).data;
    assert.deepEqual([out.stopped, out.campaign.status], ['error', 'paused']);
    assert.match(out.stop_message, /https/);
    assert.equal(http.resend.sends().length, 0);
  } finally { await http.close(); }

  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(2));
    // Another instance with a different PREVIEW_TOKEN_SECRET (rotated after confirmation).
    const other = await boot({ dryRun: false, env: { PREVIEW_TOKEN_SECRET: 'Zz9$yYxXwWvVuUtTsSrRqQpPoOnNmMlLkKjJ' }, shared: { store: t.store, clockBox: t.clockBox } });
    try {
      const so = await other.login();
      await act(other, so, c.id, 'start');
      const out = (await act(other, so, c.id, 'process')).data;
      assert.deepEqual([out.stopped, out.campaign.status], ['error', 'paused']);
      assert.match(out.stop_message, /unsubscribe links/);
      assert.equal(other.resend.sends().length, 0, 'nothing sent with links that would not work');
      assert.equal(out.campaign.counts.pending, 2);
    } finally { await other.close(); }
  } finally { await t.close(); }
});

test('regression: a full batch tells the page to come back (sending did not stop after the first batch)', async () => {
  const t = await boot({ dryRun: true });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const c = await confirmed(t, s, csvOf(60));
    await act(t, s, c.id, 'start');
    const first = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([first.processed, first.campaign.status, first.next_delay_ms], [50, 'sending', 0]);
    const second = (await act(t, s, c.id, 'process')).data;
    assert.deepEqual([second.processed, second.campaign.status, second.next_delay_ms], [10, 'completed', null]);
  } finally { await t.close(); }

  const live = await boot({ dryRun: false });
  try {
    const s = await live.login();
    await saveTemplate(live, s);
    const c = await confirmed(live, s, csvOf(25));
    await act(live, s, c.id, 'start');
    const first = (await act(live, s, c.id, 'process')).data;
    assert.deepEqual([first.processed, first.next_delay_ms], [20, 100], 'live: one pacing interval (10/s in tests)');
  } finally { await live.close(); }
});

test('demo ticket template: one responsive document, supported placeholders only, no images or embedded data, honest wording', async () => {
  const { validateTemplate, renderEmail, addUnsubscribeFooter, PLACEHOLDERS } = await import('../src/templatePolicy.js');
  const html = TICKET.html;
  assert.equal(validateTemplate({ ...TICKET, css: '' }).errors.length, 0);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, 'mobile viewport');
  assert.match(html, /<table role="presentation" width="600"[^>]*style="width:100%;max-width:600px/, 'fluid 600px card (desktop) that shrinks on phones');
  assert.ok(!/<style\b|<link\b|<img\b|data:|base64|<script\b/i.test(html), 'inline styles only; no images, embedded data or scripts');
  assert.ok(Buffer.byteLength(html) < 20_000, 'well under Gmail\'s ~102 KB clipping limit');
  const used = [...new Set([...html.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ['number_of_people', 'recipient_email', 'recipient_name']);
  assert.ok(used.every((p) => PLACEHOLDERS.includes(p)));
  for (const c of ['#E8F13A', '#35D5BA', '#4299E8', '#F06AAE']) assert.ok(html.includes(c), `brand colour ${c}`);
  assert.match(html, /border-right:2px dashed #111/, 'ticket stub perforation');
  const text = html.replace(/<[^>]+>/g, ' ');
  assert.match(text, /NOT AN ENTRY PASS/);
  assert.match(text, /NO PAYMENT RECORDED/);
  assert.ok(!/guest list|ADMIT\s*\d|QR code|check-in|payment (confirmed|received)/i.test(text), 'no admission or payment claims');
  assert.ok(!/TS-[A-Z]+-\d{3,}/.test(text), 'no made-up ticket ids');
  const r = addUnsubscribeFooter(renderEmail({ ...TICKET, css: '' }, { name: 'Asha', email: 'asha@example.com' }, { autoText: true }), 'https://invite.example.test/api/unsubscribe/abc');
  assert.match(r.text, /^★ SEASON KICKOFF ★/);
  assert.match(r.text, /GUEST Asha\nEMAIL asha@example\.com/);
  assert.match(r.text, /Unsubscribe from future invitations: https:\/\/invite\.example\.test\/api\/unsubscribe\/abc$/);
  assert.ok(!/<|&lt;|style=/.test(r.text), 'plain text has no markup');
  assert.ok(r.html.indexOf('Unsubscribe</a>') < r.html.indexOf('</body>'), 'footer inside the body');
});

test('campaigns keep each recipient\'s people count: confirmed, stored, listed, claimed and rendered into that recipient\'s email', async () => {
  const t = await boot({ dryRun: false });
  try {
    const s = await t.login();
    await saveTemplate(t, s);
    const csv = 'name,people,email\nDeepa,3,deepa@example.com\nKomal,1,komal@example.com\nRahul,4,rahul@example.com\n';
    const rv = await review(t, s, csv);
    assert.deepEqual(rv.recipients.map((x) => x.people), [3, 1, 4]);
    const r = await t.call('POST', '/api/campaigns', confirmBody(rv, csv), s);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const c = r.data.campaign;
    const listed = (await recipients(t, s, c.id)).recipients;
    assert.deepEqual(listed.map((x) => [x.name, x.people, x.email]), [['Deepa', 3, 'deepa@example.com'], ['Komal', 1, 'komal@example.com'], ['Rahul', 4, 'rahul@example.com']]);
    await act(t, s, c.id, 'start');
    const out = await drain(t, s, c.id);
    assert.deepEqual([out.campaign.status, out.campaign.counts.accepted], ['completed', 3]);
    const byTo = Object.fromEntries(t.resend.sends().map((x) => [x.body.to[0], x.body]));
    for (const [name, people, email] of [['Deepa', 3, 'deepa@example.com'], ['Komal', 1, 'komal@example.com'], ['Rahul', 4, 'rahul@example.com']]) {
      const sent = byTo[email];
      assert.ok(sent, email);
      assert.ok(sent.html.includes(`HEY ${name},`), `${email}: name`);
      assert.ok(sent.html.includes(`<b>NUMBER OF PEOPLE</b></td><td align="right"><b>${people}</b>`), `${email}: people ${people}`);
      assert.match(sent.text, new RegExp(`NUMBER OF PEOPLE ${people}\\b`), `${email}: plain text`);
    }
    // An older name,email list still means 1 person each (s1 is free again: the campaign completed).
    const legacy = await confirmed(t, s, 'name,email\nAsha,asha@example.com\n', 's1');
    assert.deepEqual((await recipients(t, s, legacy.id)).recipients.map((x) => x.people), [1]);
  } finally { await t.close(); }
});
