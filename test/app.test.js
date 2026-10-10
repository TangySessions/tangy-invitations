// End-to-end tests of the HTTP app. Resend is a stubbed fetch — no request
// ever leaves the machine and no real email is sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { makeTestStore } from './helpers/testStore.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { noTemplateMessage } from '../src/templatePolicy.js';

const ORIGIN = 'http://app.test';
const API_KEY = 'test-resend-key-not-real-0000';
const PASSWORD = 'correct horse battery staple';
const silent = { info() {}, error() {} };

let adminHash;
const getHash = async () => (adminHash ??= await hashPassword(PASSWORD));

function resendStub() {
  const calls = [];
  const queue = [];
  const stub = {
    calls,
    sends: () => calls.filter((c) => c.url.endsWith('/emails')),
    next: (fn) => queue.push(fn),
    domains: { data: [{ name: 'tangysessions.com', status: 'verified' }] },
    fetch: async (url, init = {}) => {
      const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
      calls.push(call);
      if (call.url.endsWith('/domains')) return Response.json(stub.domains);
      const fn = queue.shift();
      if (fn) return fn(call);
      return Response.json({ id: `msg_${calls.length}` });
    },
  };
  return stub;
}

async function boot({ env = {}, dataDir = ':memory:', now, log = silent } = {}) {
  const config = loadConfig({ APP_ORIGIN: ORIGIN, RESEND_API_KEY: API_KEY, EMAIL_FROM: 'Tangy Sessions <hello@tangysessions.com>', EMAIL_DRY_RUN: 'false', ...env });
  // SQLite by default; PostgreSQL with TEST_DB_BACKEND=postgres (npm run test:pg).
  const store = await makeTestStore({ dataDir, ...(now ? { now } : {}) });
  const db = store.db;
  if (!(await db.getAdminByEmail('admin@tangy.test'))) await db.createAdmin('admin@tangy.test', await getHash());
  const resend = resendStub();
  const server = createServer(createApp({ config, db, fetchImpl: resend.fetch, log, loginLimiter: store.loginLimiter, ...(now ? { now } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, { cookie, csrf, origin = ORIGIN, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const login = async () => {
    const r = await call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { cookie, csrf: r.data.csrf_token };
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((r) => server.close(r));
    await store.close();
  };
  return { base, call, login, close, db, resend, config };
}

const TEMPLATE = {
  name: 'Evening Session',
  subject: 'You are invited, {{recipient_name}}',
  // One HTML document: styles live in a <style> block (there is no CSS field).
  html: '<!doctype html><html><head><meta charset="utf-8"><style type="text/css">h1 { color: #8B2E00; }</style></head><body><h1>Hello {{recipient_name}},</h1><p>See you soon.</p><a href="https://tangysessions.com/rsvp">RSVP</a></body></html>',
  text: 'Hello {{recipient_name}}, see you soon.',
};

// Four deliberately different templates.
const DISTINCT = {
  s1: { name: 'Slot One Test', subject: 'S1 subject for {{recipient_name}}', html: '<html><head><style>h1{color:#111}</style></head><body><table><tr><td><h1>ONE-LAYOUT {{recipient_name}}</h1></td></tr></table></body></html>', text: 'one {{recipient_name}}' },
  s2: { name: 'Slot Two Test', subject: 'S2 subject — {{recipient_name}}', html: '<html><head><style>p{color:#222}</style></head><body><div><p>TWO-LAYOUT dear {{recipient_name}}</p><a href="https://example.com/two">Two</a></div></body></html>', text: '' },
  s3: { name: 'Slot Three Test', subject: 'S3 {{recipient_email}}', html: '<html><head></head><body><p>THREE-LAYOUT for {{recipient_email}}</p><img src="https://example.com/three.png" alt=""></body></html>', text: 'three' },
  s4: { name: 'Slot Four Test', subject: 'S4 only subject', html: '<html><head><style>h2{font-size:20px}</style></head><body><h2>FOUR-LAYOUT hi {{recipient_name}}</h2></body></html>', text: '' },
};

async function saveSession(t, s, id = 's1', overrides = {}) {
  const current = (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
  const r = await t.call('PUT', `/api/sessions/${id}`, { ...TEMPLATE, ...overrides, expected_version: current.version }, s);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.session;
}

// Previews exactly like the UI and returns what a send needs.
async function previewFor(t, s, { session = 's1', name = 'Arjun', email = 'arjun@example.com', test: isTest = false } = {}) {
  const r = await t.call('POST', '/api/preview', { session_id: session, source: 'saved', name, email, test: isTest }, s);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function sendBody(t, s, { session = 's1', name = 'Arjun', email = 'arjun@example.com', ...extra } = {}) {
  const p = await previewFor(t, s, { session, name, email });
  return { session_id: session, name, email, template_version: p.template_version, preview_token: p.preview_token, idempotency_key: randomUUID(), ...extra };
}

async function testBody(t, s, { session = 's1', email = 'me@example.com', ...extra } = {}) {
  const p = await previewFor(t, s, { session, email, test: true });
  return { session_id: session, email, template_version: p.template_version, preview_token: p.preview_token, idempotency_key: randomUUID(), ...extra };
}

// ---------------------------------------------------------------- auth ---
test('unauthenticated requests are rejected on every protected route', async () => {
  const t = await boot();
  try {
    const any = { session_id: 's1', name: 'A', email: 'a@b.co', template_version: 1, preview_token: 'x', idempotency_key: randomUUID() };
    for (const [m, p, b] of [['GET', '/api/session'], ['GET', '/api/sessions'], ['GET', '/api/sessions/s1'], ['GET', '/api/status'], ['GET', '/api/sends'],
      ['PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }], ['POST', '/api/preview', { session_id: 's1', source: 'saved' }],
      ['POST', '/api/send', any], ['POST', '/api/send-test', { ...any, name: undefined }]]) {
      const r = await t.call(m, p, b);
      assert.equal(r.status, 401, `${m} ${p}`);
    }
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('login: wrong password, unknown user, disabled user, rate limit', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('POST', '/api/login', { email: 'admin@tangy.test', password: 'nope-nope-nope' })).status, 401);
    assert.equal((await t.call('POST', '/api/login', { email: 'ghost@tangy.test', password: PASSWORD })).status, 401);
    const ok = await t.call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    for (let i = 0; i < 5; i++) await t.call('POST', '/api/login', { email: 'admin@tangy.test', password: 'wrong-password-x' });
    assert.equal((await t.call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD })).status, 429, 'locked after repeated failures');

    const t2 = await boot();
    const s = await t2.login();
    await t2.db.setAdminDisabled('admin@tangy.test', true);
    assert.equal((await t2.call('GET', '/api/sessions', undefined, s)).status, 401, 'disabling ends sessions');
    assert.equal((await t2.call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD })).status, 401);
    await t2.close();
  } finally { await t.close(); }
});

test('there is no sign-up route', async () => {
  const t = await boot();
  try {
    for (const p of ['/api/signup', '/api/register', '/api/admins']) {
      assert.equal((await t.call('POST', p, { email: 'x@y.z', password: 'whatever-long-pass' })).status, 404, p);
    }
  } finally { await t.close(); }
});

test('CSRF: wrong origin, missing origin, missing token and non-JSON are refused', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const body = { ...TEMPLATE, expected_version: 0 };
    assert.equal((await t.call('PUT', '/api/sessions/s1', body, { ...s, origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.call('PUT', '/api/sessions/s1', body, { ...s, origin: null })).status, 403);
    assert.equal((await t.call('PUT', '/api/sessions/s1', body, { cookie: s.cookie })).status, 403);
    assert.equal((await t.call('PUT', '/api/sessions/s1', body, { ...s, csrf: 'x'.repeat(43) })).status, 403);
    assert.equal((await t.call('POST', '/api/preview', { session_id: 's1', source: 'saved' }, { cookie: s.cookie })).status, 403);
    assert.equal((await t.call('POST', '/api/send', { session_id: 's1' }, { cookie: s.cookie })).status, 403);
    assert.equal((await t.call('POST', '/api/login', 'email=a', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await t.call('GET', '/api/sessions/s1', undefined, s)).data.session.configured, false, 'nothing was saved');
  } finally { await t.close(); }
});

// ----------------------------------------------------- session slots ---
test('exactly four session slots exist, all unconfigured on a new database', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const { sessions } = (await t.call('GET', '/api/sessions', undefined, s)).data;
    assert.deepEqual(sessions.map((x) => x.id), ['s1', 's2', 's3', 's4']);
    assert.deepEqual(sessions.map((x) => x.label), ['Session 1', 'Session 2', 'Session 3', 'Session 4']);
    assert.ok(sessions.every((x) => !x.configured && x.version === 0 && x.name === ''));
    assert.ok(sessions.every((x) => x.html === undefined), 'the list carries no HTML');
  } finally { await t.close(); }
});

test('invalid session ids are rejected everywhere', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    for (const bad of ['s5', 's0', 'S1', '1', 'template', "s1' or 1=1", '%2e%2e']) {
      assert.equal((await t.call('GET', `/api/sessions/${encodeURIComponent(bad)}`, undefined, s)).status, 400, `GET ${bad}`);
      assert.equal((await t.call('PUT', `/api/sessions/${encodeURIComponent(bad)}`, { ...TEMPLATE, expected_version: 0 }, s)).status, 400, `PUT ${bad}`);
    }
    for (const bad of ['s5', 'S1', '', null, 1, ['s1']]) {
      assert.equal((await t.call('POST', '/api/preview', { session_id: bad, source: 'saved' }, s)).status, 400);
      const r = await t.call('POST', '/api/send', { session_id: bad, name: 'A', email: 'a@b.co', template_version: 1, preview_token: 'x', idempotency_key: randomUUID() }, s);
      assert.equal(r.status, 400);
      assert.equal(r.data.code, 'invalid_session');
    }
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('each session is configured independently and keeps its own content', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    for (const id of ['s1', 's2', 's3', 's4']) await saveSession(t, s, id, DISTINCT[id]);
    for (const id of ['s1', 's2', 's3', 's4']) {
      const got = (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
      for (const k of ['name', 'subject', 'html', 'text']) assert.equal(got[k], DISTINCT[id][k], `${id}.${k}`);
      assert.equal(got.css, '', `${id}: no separate CSS is stored`);
      assert.equal(got.version, 1);
      assert.equal(got.configured, true);
    }

    // Editing s2 (twice) never touches s1, s3 or s4.
    const before = Object.fromEntries(await Promise.all(['s1', 's3', 's4'].map(async (id) => [id, (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session])));
    await saveSession(t, s, 's2', { ...DISTINCT.s2, subject: 'S2 changed {{recipient_name}}' });
    const s2 = await saveSession(t, s, 's2', { ...DISTINCT.s2, html: '<html><body><p>TWO v3 {{recipient_name}}</p></body></html>' });
    assert.equal(s2.version, 3);
    for (const id of ['s1', 's3', 's4']) {
      assert.deepEqual((await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session, before[id], `${id} unchanged`);
    }
  } finally { await t.close(); }
});

test('saving one session never copies its content into an unconfigured slot', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1', DISTINCT.s1);
    for (const id of ['s2', 's3', 's4']) {
      const got = (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
      assert.equal(got.configured, false);
      assert.equal(got.html, '');
      assert.equal(got.subject, '');
    }
  } finally { await t.close(); }
});

test('all four sessions persist across a server restart (same data dir)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tangy-mailer-'));
  try {
    const a = await boot({ dataDir: dir });
    const sa = await a.login();
    for (const id of ['s1', 's2', 's3', 's4']) await saveSession(a, sa, id, DISTINCT[id]);
    await saveSession(a, sa, 's3', { ...DISTINCT.s3, active: false });
    await a.close();
    await a.db.close();

    const b = await boot({ dataDir: dir });
    const s = await b.login();
    for (const id of ['s1', 's2', 's3', 's4']) {
      const got = (await b.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
      for (const k of ['name', 'subject', 'html', 'text']) assert.equal(got[k], DISTINCT[id][k], `${id}.${k}`);
      assert.equal(got.css, '', `${id}: no separate CSS is stored`);
      assert.equal(got.updated_by, 'admin@tangy.test');
    }
    assert.equal((await b.call('GET', '/api/sessions/s3', undefined, s)).data.session.active, false);
    assert.equal((await b.call('GET', '/api/sessions/s3', undefined, s)).data.session.version, 2);
    await b.close();
    await b.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server rejects unsafe templates even when the browser is bypassed', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    for (const html of ['<p>x</p><script>alert(1)</script>', '<img src="https://x/a.png" onerror="alert(1)">', '<a href="javascript:alert(1)">x</a>', '<p>{{unknown}}</p>']) {
      const r = await t.call('PUT', '/api/sessions/s2', { ...TEMPLATE, html, expected_version: 0 }, s);
      assert.equal(r.status, 422, html);
      assert.ok(r.data.issues.some((i) => i.level === 'error'));
    }
    assert.equal((await t.call('PUT', '/api/sessions/s2', { ...TEMPLATE, name: '', expected_version: 0 }, s)).status, 422, 'a session name is required');
    assert.equal((await t.call('PUT', '/api/sessions/s2', { ...TEMPLATE, active: 'yes', expected_version: 0 }, s)).status, 422);
    assert.equal((await t.call('PUT', '/api/sessions/s2', { ...TEMPLATE, expected_version: 0, bcc: 'x@y.z' }, s)).status, 400);
    assert.equal((await t.call('GET', '/api/sessions/s2', undefined, s)).data.session.configured, false);
  } finally { await t.close(); }
});

test('optimistic concurrency: a stale editor cannot overwrite a newer template', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const stale = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, subject: 'Other', expected_version: 0 }, s);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'version_conflict');
    assert.equal((await t.call('GET', '/api/sessions/s1', undefined, s)).data.session.subject, TEMPLATE.subject);
  } finally { await t.close(); }
});

test('request size limit', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const r = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, html: 'x'.repeat(1_100_000), expected_version: 0 }, s);
    assert.equal(r.status, 413);
  } finally { await t.close(); }
});

// ------------------------------------------------------------- preview ---
test('unconfigured and inactive sessions cannot be previewed for sending or sent', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const p = await t.call('POST', '/api/preview', { session_id: 's3', source: 'saved', name: 'A', email: 'a@b.co' }, s);
    assert.equal(p.status, 409);
    assert.equal(p.data.error, noTemplateMessage('Session 3'));
    // Forging a send for s3 with s1's version and preview token is refused.
    const forged = await sendBody(t, s, { session: 's1' });
    const r = await t.call('POST', '/api/send', { ...forged, session_id: 's3' }, s);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'no_template');

    await saveSession(t, s, 's2', { ...DISTINCT.s2, active: false });
    const off = await t.call('POST', '/api/send', { ...(await sendBody(t, s, { session: 's1' })), session_id: 's2' }, s);
    assert.equal(off.status, 409);
    assert.equal(off.data.code, 'session_inactive');
    const offPreview = await previewFor(t, s, { session: 's2' });
    assert.equal(offPreview.preview_token, null, 'an inactive session never gets a sendable preview');
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('preview renders the selected session only, never calls Resend and never writes', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    for (const id of ['s1', 's2', 's3', 's4']) await saveSession(t, s, id, DISTINCT[id]);
    const markers = { s1: 'ONE-LAYOUT', s2: 'TWO-LAYOUT', s3: 'THREE-LAYOUT', s4: 'FOUR-LAYOUT' };
    for (const id of Object.keys(markers)) {
      const p = await previewFor(t, s, { session: id, name: 'Arjun', email: 'arjun@example.com' });
      assert.equal(p.session_id, id);
      assert.equal(p.session_label, DISTINCT[id].name);
      assert.ok(p.html.includes(markers[id]), `${id} shows its own content`);
      for (const other of Object.keys(markers).filter((o) => o !== id)) assert.ok(!p.html.includes(markers[other]), `${id} never shows ${other}`);
    }
    const draft = await t.call('POST', '/api/preview', { session_id: 's1', source: 'draft', draft: { ...TEMPLATE, html: '<script>x</script>' } }, s);
    assert.equal(draft.status, 422);
    const okDraft = await t.call('POST', '/api/preview', { session_id: 's1', source: 'draft', draft: { ...DISTINCT.s2 }, name: 'A', email: 'a@b.co' }, s);
    assert.equal(okDraft.status, 200);
    assert.equal(okDraft.data.preview_token, null, 'a draft preview can never authorize a send');
    assert.equal((await t.call('GET', '/api/sessions/s1', undefined, s)).data.session.html, DISTINCT.s1.html, 'draft preview did not save');
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('a send requires a current preview: editing the template, switching session or recipient invalidates it', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1', DISTINCT.s1);
    await saveSession(t, s, 's2', DISTINCT.s2);
    const body = await sendBody(t, s, { session: 's1', name: 'Arjun', email: 'arjun@example.com' });

    const noToken = await t.call('POST', '/api/send', { ...body, preview_token: undefined }, s);
    assert.equal(noToken.data.code, 'preview_required');
    assert.equal((await t.call('POST', '/api/send', { ...body, preview_token: 'garbage' }, s)).data.code, 'preview_required');
    assert.equal((await t.call('POST', '/api/send', { ...body, name: 'Someone Else' }, s)).data.code, 'preview_required', 'other recipient name');
    assert.equal((await t.call('POST', '/api/send', { ...body, email: 'other@example.com' }, s)).data.code, 'preview_required', 'other recipient email');
    const s2v = (await t.call('GET', '/api/sessions/s2', undefined, s)).data.session.version;
    assert.equal((await t.call('POST', '/api/send', { ...body, session_id: 's2', template_version: s2v }, s)).data.code, 'preview_required', 'other session');

    // The template is edited after previewing.
    await saveSession(t, s, 's1', { ...DISTINCT.s1, subject: 'Edited {{recipient_name}}' });
    const stale = await t.call('POST', '/api/send', body, s);
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'template_changed');
    const forgedVersion = await t.call('POST', '/api/send', { ...body, template_version: 2 }, s);
    assert.equal(forgedVersion.data.code, 'preview_required', 'bumping the version without a new preview is refused');
    assert.equal(t.resend.sends().length, 0);

    const fresh = await sendBody(t, s, { session: 's1' });
    assert.equal((await t.call('POST', '/api/send', fresh, s)).status, 200);
    assert.equal(t.resend.sends()[0].body.subject, 'Edited Arjun');
  } finally { await t.close(); }
});

test('preview tokens expire after 30 minutes', async () => {
  let clock = Date.now();
  const t = await boot({ now: () => clock });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const body = await sendBody(t, s);
    clock += 31 * 60 * 1000;
    const r = await t.call('POST', '/api/send', body, s);
    assert.equal(r.data.code, 'preview_required');
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

// --------------------------------------------------------------- send ---
test('sending is blocked with the exact message when a session has no template', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const r = await t.call('POST', '/api/send', { session_id: 's1', name: 'A', email: 'a@example.com', template_version: 0, preview_token: 'x', idempotency_key: randomUUID() }, s);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'No email template has been configured yet for Session 1. Configure and save the email template before sending.');
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('a send uses the SAVED template, the right recipient, one address, and leaves the template unchanged', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const saved = await saveSession(t, s, 's1');
    const r = await t.call('POST', '/api/send', await sendBody(t, s, { name: 'Arjun <b>&"' }), s);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'accepted');
    assert.equal(r.data.session_id, 's1');
    assert.equal(r.data.session_label, 'Evening Session');
    assert.match(r.data.message_id, /^msg_/);

    const [call] = t.resend.sends();
    assert.equal(call.url, 'https://api.resend.com/emails');
    assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
    assert.match(call.headers['Idempotency-Key'], /^tangy-custom-email\/[0-9a-f-]{36}$/);
    assert.deepEqual(call.body.to, ['arjun@example.com']);
    assert.equal(call.body.cc, undefined);
    assert.equal(call.body.bcc, undefined);
    assert.equal(call.body.from, 'Tangy Sessions <hello@tangysessions.com>');
    assert.equal(call.body.subject, 'You are invited, Arjun <b>&"');
    assert.match(call.body.html, /<h1>Hello Arjun &lt;b&gt;&amp;&quot;,<\/h1>/);
    assert.ok(call.body.html.includes('<style type="text/css">h1 { color: #8B2E00; }</style></head>'), 'the document\'s own <style> block is sent unchanged');
    assert.equal(call.body.text, 'Hello Arjun <b>&", see you soon.');
    assert.ok(call.body.tags.some((tag) => tag.name === 'session' && tag.value === 's1'));

    // Second recipient: same template, only recipient details change.
    const r2 = await t.call('POST', '/api/send', await sendBody(t, s, { name: 'Meera', email: 'meera@example.com' }), s);
    assert.equal(r2.status, 200);
    const second = t.resend.sends()[1];
    assert.deepEqual(second.body.to, ['meera@example.com']);
    assert.equal(second.body.html, call.body.html.replace('Arjun &lt;b&gt;&amp;&quot;', 'Meera'));

    const after = (await t.call('GET', '/api/sessions/s1', undefined, s)).data.session;
    assert.equal(after.version, saved.version);
    assert.equal(after.html, TEMPLATE.html);
    assert.equal(after.subject, TEMPLATE.subject);
  } finally { await t.close(); }
});

test('each session sends its own content; placeholder values never leak between sends', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    for (const id of ['s1', 's2', 's3', 's4']) await saveSession(t, s, id, DISTINCT[id]);
    const people = { s1: ['Asha', 'asha@example.com'], s2: ['Bilal', 'bilal@example.com'], s3: ['Chen', 'chen@example.com'], s4: ['Dana', 'dana@example.com'] };
    for (const [id, [name, email]] of Object.entries(people)) {
      assert.equal((await t.call('POST', '/api/send', await sendBody(t, s, { session: id, name, email }), s)).status, 200);
    }
    const sent = t.resend.sends();
    assert.equal(sent.length, 4);
    assert.equal(sent[0].body.subject, 'S1 subject for Asha');
    assert.match(sent[0].body.html, /ONE-LAYOUT Asha/);
    assert.equal(sent[1].body.subject, 'S2 subject — Bilal');
    assert.match(sent[1].body.html, /TWO-LAYOUT dear Bilal/);
    assert.equal(sent[2].body.subject, 'S3 chen@example.com');
    assert.match(sent[2].body.html, /THREE-LAYOUT for chen@example.com/);
    assert.equal(sent[3].body.subject, 'S4 only subject');
    assert.match(sent[3].body.html, /FOUR-LAYOUT hi Dana/);
    assert.equal(sent[1].body.text, undefined, 's2 has no plain text');
    assert.equal(sent[0].body.text, 'one Asha');
    for (const [i, [name]] of Object.values(people).entries()) {
      for (const [j, [other]] of Object.values(people).entries()) if (i !== j) assert.ok(!JSON.stringify(sent[i].body).includes(other), `send ${i} has no ${other}`);
    }
    // Templates are untouched by personalization.
    for (const id of Object.keys(people)) {
      const got = (await t.call('GET', `/api/sessions/${id}`, undefined, s)).data.session;
      assert.equal(got.html, DISTINCT[id].html);
      assert.equal(got.version, 1);
    }
  } finally { await t.close(); }
});

test('the browser cannot supply template content, lists, cc/bcc or extra recipients', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const base = await sendBody(t, s);
    const bad = [
      { ...base, html: '<p>evil</p>' },
      { ...base, subject: 'evil' },
      { ...base, bcc: 'x@y.z' },
      { ...base, cc: 'x@y.z' },
      { ...base, to: ['x@y.z'] },
      { ...base, email: 'a@b.co,c@d.co' },
      { ...base, email: ['a@b.co', 'c@d.co'] },
      { ...base, email: 'Arjun <a@b.co>' },
      { ...base, name: '' },
      { ...base, idempotency_key: 'not-a-uuid' },
    ];
    for (const body of bad) assert.equal((await t.call('POST', '/api/send', body, s)).status, 400, JSON.stringify(body));
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('missing Resend configuration fails safely without calling Resend', async () => {
  const t = await boot({ env: { RESEND_API_KEY: '', EMAIL_FROM: '' } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const r = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(r.status, 503);
    assert.match(r.data.error, /RESEND_API_KEY, EMAIL_FROM/);
    assert.match(r.data.error, /Nothing was sent/);
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('an unverified sender domain blocks sending', async () => {
  const t = await boot();
  t.resend.domains = { data: [{ name: 'tangysessions.com', status: 'pending' }] };
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const r = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'sender_not_verified');
    assert.equal(t.resend.sends().length, 0);
  } finally { await t.close(); }
});

test('provider rejection is reported as not sent, with Resend\'s reason', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    t.resend.next(() => Response.json({ name: 'validation_error', message: 'The tangysessions.com domain is not verified.' }, { status: 403 }));
    const r = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(r.status, 502);
    assert.equal(r.data.status, 'rejected');
    assert.match(r.data.error, /not verified/);
    assert.equal(r.data.message_id, null);
    const log = (await t.call('GET', '/api/sends', undefined, s)).data.sends;
    assert.equal(log[0].status, 'rejected');
  } finally { await t.close(); }
});

test('a timeout is ambiguous, is NOT retried automatically, and a manual retry reuses the idempotency key', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const body = await sendBody(t, s);
    t.resend.next(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    const r = await t.call('POST', '/api/send', body, s);
    assert.equal(r.status, 504);
    assert.equal(r.data.status, 'ambiguous');
    assert.match(r.data.error, /may or may not/);
    assert.equal(t.resend.sends().length, 1, 'exactly one attempt — no automatic retry');

    // The UI re-previews before a manual retry: new token, SAME send id.
    const p = await previewFor(t, s);
    const retry = await t.call('POST', '/api/send', { ...body, preview_token: p.preview_token }, s);
    assert.equal(retry.status, 200);
    const [first, second] = t.resend.sends();
    assert.equal(second.headers['Idempotency-Key'], first.headers['Idempotency-Key'], 'same key → Resend de-duplicates');
    assert.deepEqual(second.body, first.body, 'identical request body, as Resend requires for a key');

    // After acceptance, the same attempt is never sent again.
    const again = await t.call('POST', '/api/send', body, s);
    assert.equal(again.status, 200);
    assert.equal(again.data.duplicate, true);
    assert.equal(t.resend.sends().length, 2);

    // Re-using the id for a different recipient is refused.
    const other = await previewFor(t, s, { email: 'other@example.com' });
    assert.equal((await t.call('POST', '/api/send', { ...body, email: 'other@example.com', preview_token: other.preview_token }, s)).status, 409);
  } finally { await t.close(); }
});

test('connection refused is reported as not sent; 5xx as ambiguous', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    t.resend.next(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    const a = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(a.data.status, 'failed');
    t.resend.next(() => new Response('oops', { status: 500 }));
    const b = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(b.data.status, 'ambiguous');
  } finally { await t.close(); }
});

test('test send: explicit endpoint, selected session, fixed test name, [TEST] subject, test address only', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1', DISTINCT.s1);
    await saveSession(t, s, 's2', DISTINCT.s2);
    assert.equal(t.resend.sends().length, 0, 'saving never sends a test');
    const r = await t.call('POST', '/api/send-test', await testBody(t, s, { session: 's2', email: 'me@example.com' }), s);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.test, true);
    const [call] = t.resend.sends();
    assert.deepEqual(call.body.to, ['me@example.com']);
    assert.equal(call.body.subject, '[TEST] S2 subject — Test Recipient');
    assert.match(call.body.html, /TWO-LAYOUT dear Test Recipient/);
    assert.ok(call.body.tags.some((tag) => tag.name === 'kind' && tag.value === 'test'));

    // A test preview token can't authorize a real send, and vice versa.
    const tp = await previewFor(t, s, { session: 's2', email: 'arjun@example.com', test: true });
    const asReal = await t.call('POST', '/api/send', { session_id: 's2', name: 'Arjun', email: 'arjun@example.com', template_version: 1, preview_token: tp.preview_token, idempotency_key: randomUUID() }, s);
    assert.equal(asReal.data.code, 'preview_required');
    const rp = await previewFor(t, s, { session: 's2', name: 'Test Recipient', email: 'me@example.com' });
    const asTest = await t.call('POST', '/api/send-test', { session_id: 's2', email: 'me@example.com', template_version: 1, preview_token: rp.preview_token, idempotency_key: randomUUID() }, s);
    assert.equal(asTest.data.code, 'preview_required');
    assert.equal((await t.call('POST', '/api/send-test', { ...(await testBody(t, s)), name: 'X' }, s)).status, 400);
    assert.equal(t.resend.sends().length, 1);
  } finally { await t.close(); }
});

test('send history records session id and name at send time', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1', DISTINCT.s1);
    await saveSession(t, s, 's4', DISTINCT.s4);
    await t.call('POST', '/api/send', await sendBody(t, s, { session: 's4', name: 'Dana', email: 'dana@example.com' }), s);
    await t.call('POST', '/api/send-test', await testBody(t, s, { session: 's1' }), s);
    // Renaming afterwards does not rewrite history.
    await saveSession(t, s, 's4', { ...DISTINCT.s4, name: 'Renamed Four' });
    const log = (await t.call('GET', '/api/sends', undefined, s)).data.sends;
    assert.equal(log.length, 2);
    assert.deepEqual([log[0].session_id, log[0].session_name, log[0].is_test, log[0].sent_by], ['s1', 'Slot One Test', true, 'admin@tangy.test']);
    assert.deepEqual([log[1].session_id, log[1].session_name, log[1].recipient_email, log[1].status], ['s4', 'Slot Four Test', 'dana@example.com', 'accepted']);
    assert.ok(log[1].provider_message_id);
    assert.ok(!('html' in log[0]) && !JSON.stringify(log).includes('FOUR-LAYOUT'), 'no email bodies in the log');
  } finally { await t.close(); }
});

test('dashboard data: session summaries carry the subject (no bodies); send stats count only recorded attempts', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const empty = (await t.call('GET', '/api/sends', undefined, s)).data.stats;
    assert.deepEqual(empty, { total: 0, tests: 0, accepted: 0, dry_run: 0, failed: 0, unknown: 0, last_24h: 0, last_at: null });

    await saveSession(t, s, 's1', DISTINCT.s1);
    const list = (await t.call('GET', '/api/sessions', undefined, s)).data.sessions;
    assert.equal(list[0].subject, DISTINCT.s1.subject);
    assert.equal(list[1].subject, '', 'unconfigured slot has no subject');
    assert.ok(list.every((x) => x.html === undefined && x.css === undefined && x.text === undefined), 'no template bodies in the list');

    await t.call('POST', '/api/send', await sendBody(t, s), s);
    await t.call('POST', '/api/send-test', await testBody(t, s), s);
    t.resend.next(() => Response.json({ name: 'validation_error', message: 'nope' }, { status: 422 }));
    await t.call('POST', '/api/send', await sendBody(t, s), s);
    const stats = (await t.call('GET', '/api/sends', undefined, s)).data.stats;
    assert.equal(stats.total, 3);
    assert.equal(stats.tests, 1);
    assert.equal(stats.accepted, 2);
    assert.equal(stats.failed, 1);
    assert.equal(stats.last_24h, 3);
    assert.match(stats.last_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!('delivered' in stats) && !('opened' in stats), 'no delivery/open figures — the app cannot know them');
  } finally { await t.close(); }
});

test('per-admin send rate limit', async () => {
  const t = await boot({ env: { SEND_LIMIT_PER_10_MIN: '2' } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    await saveSession(t, s, 's2', DISTINCT.s2);
    assert.equal((await t.call('POST', '/api/send', await sendBody(t, s), s)).status, 200);
    assert.equal((await t.call('POST', '/api/send', await sendBody(t, s, { session: 's2' }), s)).status, 200);
    assert.equal((await t.call('POST', '/api/send', await sendBody(t, s), s)).status, 429, 'the limit spans all sessions');
    assert.equal(t.resend.sends().length, 2);
  } finally { await t.close(); }
});

test('dry-run mode never calls Resend and says so', async () => {
  const t = await boot({ env: { EMAIL_DRY_RUN: 'true', RESEND_API_KEY: '' } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const r = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'dry_run');
    assert.equal(r.data.message_id, null);
    const status = (await t.call('GET', '/api/status', undefined, s)).data.email;
    assert.equal(status.dryRun, true);
    assert.equal(status.sender.state, 'dry_run');
    assert.equal(t.resend.calls.length, 0, 'not even the domain check');
    assert.equal((await t.call('GET', '/api/sends', undefined, s)).data.sends[0].status, 'dry_run');
  } finally { await t.close(); }
});

test('dry run with a key present still never calls Resend', async () => {
  const t = await boot({ env: { EMAIL_DRY_RUN: 'true' } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    await t.call('POST', '/api/send', await sendBody(t, s), s);
    await t.call('POST', '/api/send-test', await testBody(t, s), s);
    await t.call('GET', '/api/status?refresh=1', undefined, s);
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('EMAIL_DRY_RUN not set: dry run even with a key and sender configured; Resend is never called', async () => {
  const t = await boot({ env: { EMAIL_DRY_RUN: undefined } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const r = await t.call('POST', '/api/send', await sendBody(t, s), s);
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'dry_run');
    await t.call('POST', '/api/send-test', await testBody(t, s), s);
    const status = (await t.call('GET', '/api/status?refresh=1', undefined, s)).data.email;
    assert.equal(status.dryRun, true);
    assert.equal(t.resend.calls.length, 0, 'no send and no domain check');
  } finally { await t.close(); }
});

test('an invalid EMAIL_DRY_RUN stops configuration, so no app (and no provider request) can exist', async () => {
  for (const v of ['treu', 'abc', ' ']) {
    if (v.trim()) assert.throws(() => loadConfig({ APP_ORIGIN: ORIGIN, RESEND_API_KEY: API_KEY, EMAIL_FROM: 'Tangy Sessions <hello@tangysessions.com>', EMAIL_DRY_RUN: v }), /EMAIL_DRY_RUN must be one of/);
    else assert.equal(loadConfig({ APP_ORIGIN: ORIGIN, RESEND_API_KEY: API_KEY, EMAIL_FROM: 'Tangy Sessions <hello@tangysessions.com>', EMAIL_DRY_RUN: v }).email.dryRun, true, 'whitespace = not set = dry run');
  }
});

// ------------------------------------------------------------- secrets ---
test('the API key never appears in browser files or API responses', async () => {
  const t = await boot();
  try {
    for (const f of readdirSync(new URL('../public/', import.meta.url))) {
      const body = readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
      assert.ok(!/RESEND_API_KEY|re_[A-Za-z0-9]{8,}/.test(body), `public/${f}`);
    }
    const s = await t.login();
    await saveSession(t, s, 's1');
    const responses = [
      await t.call('GET', '/api/status', undefined, s),
      await t.call('GET', '/api/sessions', undefined, s),
      await t.call('GET', '/api/sessions/s1', undefined, s),
      await t.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'A', email: 'a@b.co' }, s),
      await t.call('POST', '/api/send', await sendBody(t, s), s),
      await t.call('GET', '/api/sends', undefined, s),
      await t.call('GET', '/'),
      await t.call('GET', '/app.js'),
    ];
    for (const r of responses) assert.ok(!JSON.stringify(r.data).includes(API_KEY));
  } finally { await t.close(); }
});

test('server logs contain no bodies, recipients or secrets', async () => {
  const lines = [];
  const config = loadConfig({ APP_ORIGIN: ORIGIN, RESEND_API_KEY: API_KEY, EMAIL_FROM: 'Tangy Sessions <hello@tangysessions.com>', EMAIL_DRY_RUN: 'false' });
  const store = await makeTestStore();
  const db = store.db;
  await db.createAdmin('admin@tangy.test', await getHash());
  const resend = resendStub();
  const log = { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const server = createServer(createApp({ config, db, fetchImpl: resend.fetch, log, loginLimiter: store.loginLimiter }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, b, h = {}) => fetch(base + p, { method: p.includes('sessions') ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...h }, body: JSON.stringify(b) });
    const login = await post('/api/login', { email: 'admin@tangy.test', password: PASSWORD });
    const h = { Cookie: login.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': (await login.json()).csrf_token };
    await post('/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, h);
    const p = await (await post('/api/preview', { session_id: 's1', source: 'saved', name: 'Arjun', email: 'arjun@example.com' }, h)).json();
    const r = await post('/api/send', { session_id: 's1', name: 'Arjun', email: 'arjun@example.com', template_version: 1, preview_token: p.preview_token, idempotency_key: randomUUID() }, h);
    assert.equal(r.status, 200);
    const all = lines.join('\n');
    assert.ok(lines.some((l) => l.includes('[send] status=accepted session=s1')));
    for (const secret of [API_KEY, PASSWORD, 'arjun@example.com', 'Hello', '<h1>', h.Cookie.split('=')[1], h['X-CSRF-Token']]) assert.ok(!all.includes(secret), `log must not include ${secret.slice(0, 12)}`);
  } finally { await new Promise((r) => server.close(r)); await store.close(); }
});

test('pages are served with a strict CSP and anti-framing headers', async () => {
  const t = await boot();
  try {
    const r = await t.call('GET', '/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.data, /<iframe id="preview-frame"[^>]*sandbox=""/, 'preview iframe is fully sandboxed');
    const iframes = r.data.match(/<iframe\b[^>]*>/g);
    assert.deepEqual(iframes.map((f) => /id="([^"]+)"/.exec(f)[1]), ['preview-frame', 'review-frame'], 'the template preview and the list-review preview');
    for (const f of iframes) {
      assert.match(f, /\ssandbox=""/, 'every iframe is fully sandboxed');
      assert.ok(!/allow-/.test(f), 'no iframe grants sandbox permissions');
    }
    assert.equal((await t.call('GET', '/../src/config.js')).status, 404);
    assert.equal((await t.call('GET', '/.env')).status, 404);
    assert.equal((await t.call('GET', '/data/mailer.db')).status, 404);
  } finally { await t.close(); }
});

// ------------------------------------------------------- list review ---
// Runs with EMAIL_DRY_RUN=false and a key set (boot's default), so any
// provider call would be visible in t.resend.calls.
const CSV = 'name,email\nAsha,asha@example.com\n"Doe, Jane",JANE@example.com\nBad,not-an-email\nJane again,jane@example.com\n\n';
const review = (t, s, body) => t.call('POST', '/api/campaigns/review', { session_id: 's1', csv: CSV, ...body }, s);

test('list review: counts, recipients, problems, template snapshot, sender and a personalized preview', async () => {
  const t = await boot({ env: { EMAIL_REPLY_TO: 'Replies <hello@tangysessions.com>' } });
  try {
    const s = await t.login();
    const saved = await saveSession(t, s, 's1');
    const r = await review(t, s, {});
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const d = r.data;
    assert.deepEqual(d.counts, { total: 5, valid: 2, invalid: 1, duplicate: 1, blank: 1, skipped: 3 });
    assert.deepEqual(d.recipients, [{ row: 2, name: 'Asha', email: 'asha@example.com' }, { row: 3, name: 'Doe, Jane', email: 'jane@example.com' }]);
    assert.deepEqual(d.problems.map((p) => [p.row, p.kind]), [[4, 'invalid'], [5, 'duplicate'], [6, 'blank']]);
    assert.equal(d.template_version, saved.version);
    assert.match(d.template_hash, /^[0-9a-f]{64}$/);
    assert.match(d.recipients_hash, /^[0-9a-f]{64}$/);
    assert.equal(d.from, 'Tangy Sessions <hello@tangysessions.com>');
    assert.equal(d.reply_to, 'Replies <hello@tangysessions.com>');
    assert.equal(d.preview.row, 2);
    assert.equal(d.preview.subject, 'You are invited, Asha');
    assert.match(d.preview.html, /Hello Asha,/);
    assert.equal(d.preview_token, undefined, 'a review can never authorize a send');
    const row3 = await review(t, s, { preview_row: 3 });
    assert.equal(row3.data.preview.subject, 'You are invited, Doe, Jane');
    for (const bad of [4, 5, 99]) assert.equal((await review(t, s, { preview_row: bad })).status, 400, `row ${bad} is not a valid recipient`);
    for (const bad of [1, 0, -1, 2.5, '2']) assert.equal((await review(t, s, { preview_row: bad })).status, 400, String(bad));
  } finally { await t.close(); }
});

test('list review never calls Resend, writes no send history and changes no template', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const saved = await saveSession(t, s, 's1');
    for (let i = 0; i < 3; i++) assert.equal((await review(t, s, { preview_row: 3 })).status, 200);
    await review(t, s, { csv: 'bad header\n' });
    assert.equal(t.resend.calls.length, 0, 'no provider request of any kind');
    assert.deepEqual(await t.db.recentSends(25), []);
    assert.equal((await t.call('GET', '/api/sessions/s1', undefined, s)).data.session.version, saved.version);
  } finally { await t.close(); }
});

test('list review: personalized values are escaped by the template renderer', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const r = await review(t, s, { csv: 'email,name\nx@example.com,"<img src=x onerror=alert(1)> & ""Co"""\n' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.recipients[0].name, '<img src=x onerror=alert(1)> & "Co"');
    assert.ok(r.data.preview.html.includes('Hello &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;,'), r.data.preview.html);
    assert.ok(!r.data.preview.html.includes('<img src=x'));
  } finally { await t.close(); }
});

test('list review: a template save changes the reviewed version and content hash', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const before = (await review(t, s, {})).data;
    await saveSession(t, s, 's1');
    const sameContent = (await review(t, s, {})).data;
    assert.equal(sameContent.template_version, before.template_version + 1);
    assert.equal(sameContent.template_hash, before.template_hash, 'identical content, identical hash');
    await saveSession(t, s, 's1', { subject: 'New subject for {{recipient_name}}' });
    const after = (await review(t, s, {})).data;
    assert.equal(after.template_version, before.template_version + 2);
    assert.notEqual(after.template_hash, before.template_hash);
    assert.equal(after.preview.subject, 'New subject for Asha');
    assert.equal(after.recipients_hash, before.recipients_hash, 'same list');
  } finally { await t.close(); }
});

test('list review: bad requests are refused safely', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    let r = await review(t, s, {});
    assert.equal(r.status, 409, 'no saved template yet');
    assert.equal(r.data.code, 'no_template');
    await saveSession(t, s, 's1');
    r = await review(t, s, { csv: 'name,phone\nA,1\n' });
    assert.deepEqual([r.status, r.data.code], [422, 'csv_bad_header']);
    r = await review(t, s, { csv: 'name,email\n"open,a@b.co\n' });
    assert.deepEqual([r.status, r.data.code], [422, 'csv_unterminated_quote']);
    r = await review(t, s, { csv: `name,email\n${Array.from({ length: 1001 }, (_, i) => `R${i},r${i}@example.com`).join('\n')}` });
    assert.deepEqual([r.status, r.data.code], [413, 'csv_too_many_recipients']);
    r = await review(t, s, { csv: `name,email\nA,a@example.com\n${'x'.repeat(1024 * 1024)}` });
    assert.equal(r.status, 413, 'over the 1 MB body limit');
    assert.equal((await review(t, s, { csv: 42 })).status, 400);
    assert.equal((await review(t, s, { session_id: 's9' })).status, 400);
    assert.equal((await review(t, s, { recipients: [] })).status, 400, 'unexpected fields (e.g. browser-side results) are refused');
    assert.equal((await t.call('POST', '/api/campaigns/review', 'name,email', { ...s, headers: { 'Content-Type': 'text/csv' } })).status, 415);
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('list review requires sign-in, a CSRF token and this app\'s origin', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    const body = { session_id: 's1', csv: CSV };
    assert.equal((await t.call('POST', '/api/campaigns/review', body)).status, 401, 'not signed in');
    assert.equal((await t.call('POST', '/api/campaigns/review', body, { cookie: s.cookie })).status, 403, 'no CSRF token');
    assert.equal((await t.call('POST', '/api/campaigns/review', body, { cookie: s.cookie, csrf: 'wrong' })).status, 403, 'wrong CSRF token');
    assert.equal((await t.call('POST', '/api/campaigns/review', body, { ...s, origin: 'https://evil.example' })).status, 403, 'foreign origin');
    assert.equal((await t.call('POST', '/api/campaigns/review', body, { ...s, origin: null })).status, 403, 'no origin, not same-site');
    assert.equal((await t.call('GET', '/api/campaigns/review', undefined, s)).status, 404, 'POST only');
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('list review logs counts only — never names, addresses, CSV text or bodies', async () => {
  const lines = [];
  const t = await boot({ log: { info: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) } });
  try {
    const s = await t.login();
    await saveSession(t, s, 's1');
    await review(t, s, { preview_row: 3 });
    await review(t, s, { csv: 'name,email\n"open,secret-row@example.com\n' });
    const out = lines.join('\n');
    assert.match(out, /\[campaign-review\] session=s1 admin=\d+ rows=5 valid=2 invalid=1 duplicate=1 blank=1/);
    for (const needle of ['asha', 'Asha', 'jane', 'Doe', 'not-an-email', 'secret-row', 'You are invited', '<h1>']) assert.ok(!out.includes(needle), needle);
  } finally { await t.close(); }
});

// ------------------------------------- single-file HTML templates (ticket) ---
// templates/tangy-ticket-demo.html: the demo ticket as ONE HTML document
// (inline styles, no CSS field, no embedded images) with mock event details;
// {{recipient_name}} and {{recipient_email}} are its only placeholders.
const TICKET_HTML = readFileSync(new URL('../templates/tangy-ticket-demo.html', import.meta.url), 'utf8');
const TICKET = { name: 'Ticket', subject: 'Your Tangy Sessions ticket, {{recipient_name}}', html: TICKET_HTML, text: 'Hi {{recipient_name}}, your sample ticket is inside.' };
const draftPreview = (t, s, draft, extra = {}) => t.call('POST', '/api/preview', { session_id: 's1', source: 'draft', draft, name: 'Asha', email: 'asha@example.com', ...extra }, s);

test('single-file ticket: saves, previews (draft and saved) and sends as one HTML document', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    assert.ok(TICKET_HTML.length < 20_000 && !/data:image|<link\b|<style\b/i.test(TICKET_HTML), 'compact, inline styles only');
    const draft = await draftPreview(t, s, TICKET);
    assert.equal(draft.status, 200, JSON.stringify(draft.data));
    assert.equal(draft.data.subject, 'Your Tangy Sessions ticket, Asha');
    assert.equal(draft.data.preview_token, null, 'a draft preview never authorizes a send');
    const saved = await saveSession(t, s, 's1', TICKET);
    assert.equal(saved.css, '');
    assert.equal(saved.html, TICKET_HTML, 'stored exactly as given');
    const body = await sendBody(t, s, { name: 'Asha', email: 'asha@example.com' });
    assert.ok(body.preview_token, 'a saved preview still issues a signed, recipient-bound token');
    const r = await t.call('POST', '/api/send', body, s);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const [call] = t.resend.sends();
    assert.ok(call.body.html.includes('HEY Asha,'));
    assert.ok(call.body.html.startsWith('<!doctype html>') && !call.body.html.includes('<style type="text/css">'), 'nothing appended to the document');
  } finally { await t.close(); }
});

test('single-file ticket: recipient values are HTML-escaped in the rendered ticket', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    await saveSession(t, s, 's1', TICKET);
    const p = await t.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: '<script>alert(1)</script> & "Co"', email: 'x@example.com' }, s);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.ok(p.data.html.includes('HEY &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;,'));
    assert.ok(!p.data.html.includes('<script>'));
    assert.equal(p.data.subject, 'Your Tangy Sessions ticket, <script>alert(1)</script> & "Co"', 'subject is plain text (not HTML)');
  } finally { await t.close(); }
});

test('regression: an oversized draft gets a clear 413 (limit + cause), the compact ticket does not', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    // The failure: the editor sent more than 1 MB (e.g. an old version with an embedded base64 image).
    const huge = { ...TICKET, html: TICKET_HTML.replace('</body>', `<img src="data:image/png;base64,${'A'.repeat(1100 * 1024)}" alt=""></body>`) };
    for (const r of [await draftPreview(t, s, huge), await t.call('PUT', '/api/sessions/s1', { ...huge, expected_version: 0 }, s)]) {
      assert.equal(r.status, 413);
      assert.equal(r.data.code, 'too_large');
      assert.equal(r.data.limit_bytes, 1024 * 1024);
      assert.match(r.data.error, /^Request is too large: the limit is 1 MB\. A template is one HTML document of at most 500,000 characters\. Embedded images \(data:…base64\) make emails huge — host images at https:\/\/ URLs instead\.$/);
    }
    // Under the body limit but over the HTML limit: refused by validation, with the field named.
    const long = { ...TICKET, html: TICKET_HTML.replace('</body>', `<p>${'x'.repeat(500_000)}</p></body>`) };
    const v = await draftPreview(t, s, long);
    assert.equal(v.status, 422);
    assert.ok(v.data.issues.some((i) => i.field === 'html' && /larger than 500,000 characters/.test(i.message)));
    assert.equal((await draftPreview(t, s, TICKET)).status, 200);
    assert.equal((await t.call('GET', '/api/sessions/s1', undefined, s)).data.session.version, 0, 'nothing was saved');
    assert.equal(t.resend.calls.length, 0);
  } finally { await t.close(); }
});

test('template requests: no CSS field, only template fields, required fields enforced', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    let r = await draftPreview(t, s, { ...TICKET, css: 'p{}' });
    assert.deepEqual([r.status, r.data.error], [400, 'Unexpected field: css.']);
    r = await t.call('PUT', '/api/sessions/s1', { ...TICKET, css: 'p{}', expected_version: 0 }, s);
    assert.deepEqual([r.status, r.data.error], [400, 'Unexpected field: css.']);
    r = await draftPreview(t, s, { ...TICKET, active: true });
    assert.deepEqual([r.status, r.data.error], [400, 'Unexpected field: active.']);
    for (const bad of [undefined, null, 'html', ['x']]) {
      assert.equal((await draftPreview(t, s, bad)).status, 400, JSON.stringify(bad));
    }
    for (const field of ['subject', 'html']) {
      const { [field]: _, ...missing } = TICKET;
      assert.equal((await draftPreview(t, s, missing)).status, 422, `draft without ${field}`);
      assert.equal((await t.call('PUT', '/api/sessions/s1', { ...missing, expected_version: 0 }, s)).status, 422, `save without ${field}`);
    }
    const { text: _t, ...noText } = TICKET;
    assert.equal((await draftPreview(t, s, noText)).status, 200, 'plain text stays optional');
  } finally { await t.close(); }
});

test('templates saved with a separate CSS field still render the same; re-saving stores one document and bumps the version', async () => {
  const t = await boot();
  try {
    const s = await t.login();
    const admin = await t.db.getAdminByEmail('admin@tangy.test');
    // A row written before the CSS field was removed.
    await t.db.saveSessionTemplate('s2', { name: 'Legacy', subject: 'Hi {{recipient_name}}', html: '<html><head></head><body><h1>Hi {{recipient_name}}</h1></body></html>', css: 'h1{color:#123456}', text: '', active: true }, 0, admin.id, Date.now());
    const legacy = (await t.call('GET', '/api/sessions/s2', undefined, s)).data.session;
    assert.equal(legacy.css, 'h1{color:#123456}');
    const before = await t.call('POST', '/api/preview', { session_id: 's2', source: 'saved', name: 'Asha', email: 'asha@example.com' }, s);
    assert.ok(before.data.html.includes('<style type="text/css">\nh1{color:#123456}\n</style>\n</head>'));
    const review1 = (await t.call('POST', '/api/campaigns/review', { session_id: 's2', csv: 'name,email\nAsha,asha@example.com\n' }, s)).data;
    // The editor shows (and saves) the merged document — exactly the rendered HTML.
    const merged = '<html><head><style type="text/css">\nh1{color:#123456}\n</style>\n</head><body><h1>Hi {{recipient_name}}</h1></body></html>';
    const r = await t.call('PUT', '/api/sessions/s2', { name: 'Legacy', subject: legacy.subject, html: merged, text: '', expected_version: legacy.version }, s);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.session.css, r.data.session.version], ['', legacy.version + 1]);
    const after = await t.call('POST', '/api/preview', { session_id: 's2', source: 'saved', name: 'Asha', email: 'asha@example.com' }, s);
    assert.equal(after.data.html, before.data.html, 'the email is unchanged');
    const review2 = (await t.call('POST', '/api/campaigns/review', { session_id: 's2', csv: 'name,email\nAsha,asha@example.com\n' }, s)).data;
    assert.equal(review2.template_version, review1.template_version + 1);
    assert.notEqual(review2.template_hash, review1.template_hash, 'campaign review sees the stored change');
    // Campaign previews are the same document plus the server-added unsubscribe footer.
    assert.ok(review2.preview.html.includes('<style type="text/css">\nh1{color:#123456}\n</style>\n</head>'));
    assert.equal(review2.preview.html.replace(/<table role="presentation" width="100%"[^]*?Unsubscribe<\/a> from future invitations\.<\/td><\/tr><\/table>\n/, ''), before.data.html);
  } finally { await t.close(); }
});
