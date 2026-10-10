// Embedded-image hosting (src/assets.js) and its use by save / preview /
// send. A synthetic invitation with 19 embedded images (~840 KB) stands in
// for a Claude-generated template. Image stores are temp folders or stubs;
// nothing is written to ./data and no network request is made.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { makeTestStore } from './helpers/testStore.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { findEmbeddedImages, decodeEmbeddedImages, hostEmbeddedImages, AssetError, supabaseAssetStore, sniffImage } from '../src/assets.js';
import { liveImageProblem } from '../src/templatePolicy.js';

const dirs = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'tangy-assets-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const LIMITS = { maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 15 * 1024 * 1024, maxImages: 50 };

// ------------------------------------------------------- synthetic images --
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
// A real PNG (noise, so it does not compress away); alpha → RGBA with transparency.
function png(w, h, seed, alpha = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((w * bpp + 1) * h);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) {
    if (i % (w * bpp + 1) === 0) { raw[i] = 0; continue; }
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; raw[i] = x & 0xff;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.alloc(n, 7), Buffer.from([0xff, 0xd9])]);
const dataUrl = (mime, bytes, wrap = false) => {
  const b64 = bytes.toString('base64');
  return `data:${mime};base64,${wrap ? b64.replace(/(.{76})/g, '$1\n') : b64}`;
};

// 19 embedded references (16 unique images) in every supported position.
function invitation(src) {
  const imgs = [];
  for (let i = 0; i < 12; i++) imgs.push({ mime: 'image/png', bytes: png(96, 96, i + 1, i % 3 === 0) });
  imgs.push({ mime: 'image/jpeg', bytes: jpeg(9000) }, { mime: 'image/gif', bytes: GIF }, { mime: 'image/webp', bytes: WEBP }, { mime: 'image/png', bytes: png(40, 40, 99, true) });
  const refs = [...imgs, imgs[0], imgs[1], imgs[12]]; // 19 references, 3 repeats
  const u = (k, wrap) => src(refs[k], k, wrap);
  return {
    refs,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Utsav</title>
<style type="text/css">
  .hero { background-image: url('${u(0)}'); background-size: cover; }
  .border { background: url(${u(1)}) repeat-x; }
</style></head>
<body style="margin:0;background:#2b0a1a">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px" background="${u(2)}"><tr><td class="hero">
<p style="color:#f6d38b">Dear {{recipient_name}},</p>
<div style="background-image:url(&quot;${u(3)}&quot;)">Curve</div>
${[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((k) => `<img src="${u(k)}" width="120" height="80" alt="ornament ${k}" style="display:block">`).join('\n')}
<img src='${u(15)}' alt="seal">
<img src="${u(16, true)}" alt="wrapped base64">
<td style="background-image:url( '${u(17)}' )">Dance</td>
<img src="${u(18)}" alt="repeat">
<p>Sent to {{recipient_email}} · data: in text is not an image</p>
</td></tr></table></body></html>`,
  };
}
const ORIGINAL = invitation((r, k, wrap) => dataUrl(r.mime, r.bytes, wrap));

// --------------------------------------------------------------- pipeline --
test('the synthetic invitation is the real shape: 19 embedded images, > 500,000 characters (~840 KB)', () => {
  assert.equal(ORIGINAL.refs.length, 19);
  assert.ok(ORIGINAL.html.length > 500_000 && ORIGINAL.html.length < 1_000_000, String(ORIGINAL.html.length));
  const { images, issues } = decodeEmbeddedImages(ORIGINAL.html, LIMITS);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  assert.equal(images.length, 19);
  assert.deepEqual(images.map((i) => i.bytes.equals(ORIGINAL.refs[images.indexOf(i)].bytes)), Array(19).fill(true), 'every image decoded byte-for-byte, in document order');
  assert.deepEqual([...new Set(images.map((i) => i.context))].sort(), ['background', 'css', 'src']);
  assert.equal(new Set(images.map((i) => i.sha256)).size, 16);
  assert.deepEqual([...new Set(images.map((i) => i.type))].sort(), ['gif', 'jpeg', 'png', 'webp']);
});

test('hosting stores each unique image once, byte-for-byte, and rewrites only the image references', async () => {
  const stored = new Map();
  const store = { kind: 'test', put: async ({ name, mime, bytes }) => { stored.set(name, { mime, bytes }); return `https://cdn.example.test/${name}`; } };
  const out = await hostEmbeddedImages(ORIGINAL.html, { store, limits: LIMITS });
  const expected = invitation((r) => `https://cdn.example.test/${sha(r.bytes)}.${{ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[r.mime]}`).html;
  assert.equal(out.html, expected, 'identical document except each data: URL → its hosted URL, in place');
  assert.deepEqual(out.summary, { embedded: 19, unique: 16, bytes: [...stored.values()].reduce((n, v) => n + v.bytes.length, 0) });
  assert.equal(stored.size, 16);
  for (const r of ORIGINAL.refs) assert.ok(stored.get([...stored.keys()].find((k) => k.startsWith(sha(r.bytes)))).bytes.equals(r.bytes));
  assert.ok(!/data:image/.test(out.html));
  assert.ok(out.html.includes('Dear {{recipient_name}},') && out.html.includes('Sent to {{recipient_email}}'), 'placeholders untouched');
  assert.ok(out.html.length < 20_000, 'the stored HTML is small');
  const transparent = [...stored.values()].find((v) => v.bytes.equals(ORIGINAL.refs[0].bytes));
  assert.equal(transparent.bytes[25], 6, 'RGBA (alpha) PNG kept as RGBA');
});

test('unsafe or unsupported embedded data is refused with a line number, never silently kept or dropped', () => {
  const errs = (html, limits = LIMITS) => decodeEmbeddedImages(html, limits).issues.filter((i) => i.level === 'error').map((i) => i.message);
  const p = png(4, 4, 1).toString('base64');
  const cases = [
    [`<img src="data:image/svg+xml;base64,${Buffer.from('<svg onload="x()"/>').toString('base64')}">`, /SVG images are not supported/],
    [`<img src="data:text/html;base64,${Buffer.from('<script>x</script>').toString('base64')}">`, /is not an image/],
    ['<img src="data:image/png,%89PNG">', /must be base64/],
    ['<img src="data:image/png;base64,@@@@">', /malformed base64/],
    [`<img src="data:image/png;base64,${Buffer.from('not really an image').toString('base64')}">`, /not a valid PNG, JPEG, GIF or WebP/],
    [`<img src="data:image/bmp;base64,${p}">`, /"image\/bmp" is not supported/],
    [`<a href="data:image/png;base64,${p}">x</a>`, /unsupported place/],
    [`<img src="data:image/png;base64,${p}`, /not terminated/],
  ];
  for (const [html, re] of cases) assert.ok(errs(html).some((m) => re.test(m)), `${re}: ${errs(html)}`);
  assert.ok(errs(`<img src="${dataUrl('image/png', png(200, 200, 3))}">`, { ...LIMITS, maxImageBytes: 64 * 1024 }).some((m) => /limit per image/.test(m)));
  assert.ok(errs(ORIGINAL.html, { ...LIMITS, maxTotalBytes: 200 * 1024 }).some((m) => /total more than/.test(m)));
  assert.ok(errs(ORIGINAL.html, { ...LIMITS, maxImages: 10 }).some((m) => /embeds 19 images; the limit is 10/.test(m)));
  // A JPEG labelled as PNG is stored with its real type (warning), not rejected.
  const mislabeled = decodeEmbeddedImages(`<img src="data:image/png;base64,${jpeg(10).toString('base64')}">`, LIMITS);
  assert.deepEqual([mislabeled.images[0].type, mislabeled.issues[0].level], ['jpeg', 'warning']);
  assert.equal(sniffImage(Buffer.from('<svg/>')), null);
  // "data:" in prose is not an image reference.
  assert.deepEqual(findEmbeddedImages('<p>metadata: none, data: yes</p>').items, []);
});

test('a failed upload stops everything: an error, no HTML, no partial result', async () => {
  let n = 0;
  const store = { kind: 'test', put: async () => { if (++n === 7) throw new Error('the storage service refused the upload (500).'); return 'https://cdn.example.test/x.png'; } };
  await assert.rejects(hostEmbeddedImages(ORIGINAL.html, { store, limits: LIMITS }), (err) => err instanceof AssetError && /line \d+\) failed: the storage service refused the upload \(500\)\. Nothing was saved; 6 of 16 images had been stored\./.test(err.message));
  await assert.rejects(hostEmbeddedImages(ORIGINAL.html, { store: { kind: 'none' }, limits: LIMITS }), /image hosting is not configured/);
});

test('Supabase Storage adapter: content-addressed upload, no overwrite, public URL, safe errors (stubbed fetch)', async () => {
  const calls = [];
  const replies = [() => new Response('{}', { status: 200 }), () => Response.json({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }, { status: 400 }), () => new Response('nope', { status: 500 })];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return replies.shift()(); };
  const key = 'test-storage-key-not-real-0000';
  const store = supabaseAssetStore({ url: 'https://proj.supabase.co', key, bucket: 'invitation-assets' }, { fetchImpl });
  const name = `${'a'.repeat(64)}.png`;
  const url = await store.put({ name, mime: 'image/png', bytes: Buffer.from('x') });
  assert.equal(url, `https://proj.supabase.co/storage/v1/object/public/invitation-assets/invitations/${name}`);
  assert.equal(calls[0].url, `https://proj.supabase.co/storage/v1/object/invitation-assets/invitations/${name}`);
  assert.deepEqual([calls[0].init.method, calls[0].init.headers['x-upsert'], calls[0].init.headers['Content-Type'], calls[0].init.redirect], ['POST', 'false', 'image/png', 'error']);
  assert.equal(await store.put({ name, mime: 'image/png', bytes: Buffer.from('x') }), url, 'already stored (same content) counts as stored');
  await assert.rejects(store.put({ name, mime: 'image/png', bytes: Buffer.from('x') }), (err) => /refused the upload \(500\)/.test(err.message) && !err.message.includes(key));
  await assert.rejects(store.put({ name: '../etc/passwd', mime: 'image/png', bytes: Buffer.from('x') }), /invalid asset name/);
});

test('configuration: store choice, production defaults, limits, and the storage key never serializes', () => {
  const prod = { NODE_ENV: 'production', APP_ORIGIN: 'https://invite.example.test', PREVIEW_TOKEN_SECRET: 'aB3$kLm9QwErTyUiOp1234567890zxcvbnmQWE', DB_BACKEND: 'sqlite', EMAIL_DRY_RUN: 'true' };
  assert.equal(loadConfig({}).assets.store.kind, 'local', 'development default');
  assert.equal(loadConfig(prod).assets.store.kind, 'none', 'production default: refuse embedded images until configured');
  assert.throws(() => loadConfig({ ...prod, ASSET_STORE: 'local' }), /local development only/);
  assert.throws(() => loadConfig({ ASSET_STORE: 's3' }), /must be "local", "supabase" or "none"/);
  assert.throws(() => loadConfig({ ASSET_STORE: 'supabase' }), /needs SUPABASE_URL/);
  assert.throws(() => loadConfig({ ASSET_STORE: 'supabase', SUPABASE_URL: 'http://x.supabase.co' }), /must use https/);
  assert.throws(() => loadConfig({ ASSET_STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co' }), /needs SUPABASE_STORAGE_KEY/);
  assert.throws(() => loadConfig({ ASSET_STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_STORAGE_KEY: 'k', SUPABASE_STORAGE_BUCKET: 'Bad Bucket' }), /bucket name/);
  const c = loadConfig({ ASSET_STORE: 'supabase', SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_STORAGE_KEY: 'secret-key-value', SUPABASE_STORAGE_BUCKET: 'invitation-assets' });
  assert.deepEqual(c.assets.store, { kind: 'supabase', url: 'https://x.supabase.co', bucket: 'invitation-assets' });
  assert.ok(!JSON.stringify(c).includes('secret-key-value'));
  assert.equal(loadConfig({}).assets.maxImportBytes, 4 * 1024 * 1024);
  for (const bad of ['0', '512', 'abc', '99999999999']) assert.throws(() => loadConfig({ TEMPLATE_IMPORT_MAX_BYTES: bad }), /TEMPLATE_IMPORT_MAX_BYTES must be a whole number/);
  assert.throws(() => loadConfig({ ASSET_MAX_IMAGES: '0' }), /ASSET_MAX_IMAGES/);
});

test('real sends need hosted https images and must fit the provider limit', () => {
  const ok = { html: '<img src="https://cdn.example.test/a.png">', text: '', subject: 's' };
  assert.equal(liveImageProblem(ok), null);
  assert.match(liveImageProblem({ ...ok, html: `<img src="${dataUrl('image/png', GIF)}">` }), /data: URLs/);
  assert.match(liveImageProblem({ ...ok, html: `<td background="http://localhost:8787/api/assets/${'a'.repeat(64)}.png">` }), /local development store/);
  assert.match(liveImageProblem({ ...ok, html: '<div style="background:url( \'http://localhost:8787/x.png\')">' }), /local development store/);
});

// ------------------------------------------------------------ through the app --
const ORIGIN = 'http://localhost:8787';
const PASSWORD = 'correct horse battery staple';
let hash;
async function boot({ env = {}, assetStore, dryRun = true } = {}) {
  const dataDir = tempDir();
  const config = loadConfig({ APP_ORIGIN: ORIGIN, DATA_DIR: dataDir, RESEND_API_KEY: 'test-resend-key-not-real-0000', EMAIL_FROM: 'Tangy Sessions <noreply@tangysessions.com>', EMAIL_DRY_RUN: dryRun ? 'true' : 'false', ...env });
  const store = await makeTestStore();
  hash ??= await hashPassword(PASSWORD);
  await store.db.createAdmin('admin@tangy.test', hash);
  const sends = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/domains')) return Response.json({ data: [{ name: 'tangysessions.com', status: 'verified' }] });
    sends.push(JSON.parse(init.body));
    return Response.json({ id: `msg_${sends.length}` });
  };
  const server = createServer(createApp({ config, db: store.db, fetchImpl, log: { info() {}, error() {} }, loginLimiter: store.loginLimiter, ...(assetStore ? { assetStore } : {}) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, s = {}) => {
    const res = await fetch(base + path, { method, headers: { Origin: ORIGIN, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(s.cookie ? { Cookie: s.cookie, 'X-CSRF-Token': s.csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const r = await call('POST', '/api/login', { email: 'admin@tangy.test', password: PASSWORD });
  const s = { cookie: r.headers.get('set-cookie').split(';')[0], csrf: r.data.csrf_token };
  return { call, s, dataDir, sends, close: async () => { await new Promise((x) => server.close(x)); await store.close(); } };
}
const TEMPLATE = { name: 'Utsav Sandhya', subject: 'An evening for you, {{recipient_name}}', html: ORIGINAL.html, text: '' };

test('import → save: all 19 images hosted, stored HTML links to them, placeholders intact; the images are served byte-for-byte', async () => {
  const t = await boot();
  try {
    const r = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, t.s);
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 500));
    assert.deepEqual([r.data.assets.embedded, r.data.assets.unique], [19, 16]);
    assert.ok(r.data.issues.some((i) => /stored on this machine/.test(i.message)), 'says the local store is for development');
    const saved = (await t.call('GET', '/api/sessions/s1', undefined, t.s)).data.session;
    assert.ok(!saved.html.includes('data:image'));
    const urls = [...saved.html.matchAll(/http:\/\/localhost:8787\/api\/assets\/([0-9a-f]{64}\.(?:png|jpg|gif|webp))/g)].map((m) => m[1]);
    assert.equal(urls.length, 19);
    assert.equal(new Set(urls).size, 16);
    assert.ok(saved.html.includes('Dear {{recipient_name}},') && saved.html.includes('{{recipient_email}}'));
    assert.ok(saved.html.length < 500_000, 'the stored template is within the stored-HTML limit');
    assert.equal(readdirSync(join(t.dataDir, 'assets')).length, 16);
    for (const [k, name] of urls.entries()) {
      const a = await t.call('GET', `/api/assets/${name}`);
      assert.equal(a.status, 200);
      assert.ok(a.data.equals(ORIGINAL.refs[k].bytes), `image ${k} served byte-for-byte`);
      assert.equal(a.headers.get('content-type'), { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[name.split('.')[1]]);
      assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
      assert.match(a.headers.get('content-security-policy'), /sandbox/);
    }
    for (const bad of [`${'0'.repeat(64)}.png`, '..%2F..%2Fmailer.db', 'x.png', `${urls[0].split('.')[0]}.svg`]) assert.equal((await t.call('GET', `/api/assets/${bad}`)).status, 404, bad);
    // Saved preview and a dry-run send work with the hosted images.
    const p = await t.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Asha <b>', email: 'asha@example.com' }, t.s);
    assert.equal(p.status, 200);
    assert.ok(p.data.html.includes('Dear Asha &lt;b&gt;,'));
    const send = await t.call('POST', '/api/send', { session_id: 's1', name: 'Asha <b>', email: 'asha@example.com', template_version: p.data.template_version, preview_token: p.data.preview_token, idempotency_key: randomUUID() }, t.s);
    assert.deepEqual([send.status, send.data.status], [200, 'dry_run']);
    assert.equal(t.sends.length, 0);
  } finally { await t.close(); }
});

test('draft preview of the full document: nothing is uploaded; the preview shows the original embedded images', async () => {
  const t = await boot();
  try {
    const r = await t.call('POST', '/api/preview', { session_id: 's1', source: 'draft', draft: TEMPLATE, name: 'Asha', email: 'asha@example.com' }, t.s);
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 400));
    assert.equal((r.data.html.match(/data:image\//g) || []).length, 19, 'all 19 images rendered as embedded');
    assert.ok(r.data.html.includes('Dear Asha,') && r.data.html.includes('Sent to asha@example.com'));
    assert.ok(r.data.issues.some((i) => /19 embedded images \(16 unique\) will be hosted when you save/.test(i.message)));
    assert.equal(r.data.preview_token, null);
    assert.ok(!existsSync(join(t.dataDir, 'assets')), 'previewing stores nothing');
  } finally { await t.close(); }
});

test('failures never leave a partial template: invalid image, upload failure, no store, oversize import', async () => {
  let n = 0;
  const flaky = { kind: 'test', put: async ({ name }) => { if (++n === 5) throw new Error('the storage service did not answer in time.'); return `https://cdn.example.test/${name}`; } };
  const t = await boot({ assetStore: flaky });
  try {
    let r = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, t.s);
    assert.deepEqual([r.status, r.data.code], [502, 'image_hosting_failed']);
    assert.match(r.data.error, /did not answer in time\. Nothing was saved; 4 of 16 images had been stored\./);
    const bad = TEMPLATE.html.replace('alt="seal"', `alt="seal"><img src="data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}"`);
    r = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, html: bad, expected_version: 0 }, t.s);
    assert.equal(r.status, 422);
    assert.ok(r.data.issues.some((i) => /SVG/.test(i.message) && i.line > 1));
    r = await t.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 3 }, t.s);
    assert.equal(r.status, 409, 'a stale editor is refused before anything is uploaded');
    const before = n;
    const s1 = (await t.call('GET', '/api/sessions/s1', undefined, t.s)).data.session;
    assert.deepEqual([s1.version, s1.configured, n], [0, false, before], 'nothing saved; nothing uploaded for the invalid/stale requests');
  } finally { await t.close(); }

  const none = await boot({ env: { ASSET_STORE: 'none' } });
  try {
    const r = await none.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, none.s);
    assert.deepEqual([r.status, r.data.code], [503, 'image_hosting_not_configured']);
    const ok = await none.call('PUT', '/api/sessions/s1', { ...TEMPLATE, html: '<html><body><p>Hi {{recipient_name}}</p><img src="https://cdn.example.test/a.png"></body></html>', expected_version: 0 }, none.s);
    assert.equal(ok.status, 200, 'templates without embedded images are unaffected');
  } finally { await none.close(); }

  const small = await boot({ env: { TEMPLATE_IMPORT_MAX_BYTES: String(1024 * 1024) } });
  try {
    const big = TEMPLATE.html.replace('</body>', `<!-- ${'x'.repeat(1100 * 1024)} --></body>`);
    const r = await small.call('PUT', '/api/sessions/s1', { ...TEMPLATE, html: big, expected_version: 0 }, small.s);
    assert.deepEqual([r.status, r.data.code], [413, 'too_large']);
    assert.match(r.data.error, /TEMPLATE_IMPORT_MAX_BYTES/);
  } finally { await small.close(); }
});

test('real sending: refused while images are on the local store; with hosted https images the email goes out with links only', async () => {
  const local = await boot({ dryRun: false });
  try {
    assert.equal((await local.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, local.s)).status, 200);
    const p = await local.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Asha', email: 'asha@example.com' }, local.s);
    const r = await local.call('POST', '/api/send', { session_id: 's1', name: 'Asha', email: 'asha@example.com', template_version: p.data.template_version, preview_token: p.data.preview_token, idempotency_key: randomUUID() }, local.s);
    assert.deepEqual([r.status, r.data.code], [422, 'images_not_hosted']);
    assert.equal(local.sends.length, 0, 'nothing reached the provider');
  } finally { await local.close(); }

  const cdn = { kind: 'test', put: async ({ name }) => `https://cdn.example.test/${name}` };
  const hosted = await boot({ dryRun: false, assetStore: cdn });
  try {
    assert.equal((await hosted.call('PUT', '/api/sessions/s1', { ...TEMPLATE, expected_version: 0 }, hosted.s)).status, 200);
    const p = await hosted.call('POST', '/api/preview', { session_id: 's1', source: 'saved', name: 'Asha', email: 'asha@example.com' }, hosted.s);
    const r = await hosted.call('POST', '/api/send', { session_id: 's1', name: 'Asha', email: 'asha@example.com', template_version: p.data.template_version, preview_token: p.data.preview_token, idempotency_key: randomUUID() }, hosted.s);
    assert.deepEqual([r.status, r.data.status], [200, 'accepted']);
    const sent = hosted.sends[0];
    assert.equal((sent.html.match(/https:\/\/cdn\.example\.test\/[0-9a-f]{64}\./g) || []).length, 19);
    assert.ok(!sent.html.includes('data:image'), 'no embedded images in the sent email');
    assert.ok(Buffer.byteLength(sent.html) < 102 * 1024, 'under Gmail\'s clipping size');
  } finally { await hosted.close(); }
});
