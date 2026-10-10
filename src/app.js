// HTTP application. Every /api route except /api/login requires a valid
// login session, and every state-changing route is CSRF-checked. `db` is
// either store (src/db.js for SQLite, src/store/postgres.js for PostgreSQL);
// every call is awaited, so both work unchanged. The browser
// never supplies template content to a send: /api/send takes a session id
// (s1–s4) plus the recipient's name and email, and loads that session's saved
// template from the database itself.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  validateTemplate, validateRecipient, validateEmailAddress, validateSessionName, renderEmail,
  noTemplateMessage, TEST_RECIPIENT_NAME, PLACEHOLDERS, LIMITS,
} from './templatePolicy.js';
import { SESSION_IDS, defaultLabel } from './db.js';
import {
  verifyPassword, dummyVerify, newToken, sha256, safeEqual, parseCookies,
  sessionCookie, clearedSessionCookie, MemoryLoginLimiter, assertLoginLimiter, SESSION_COOKIE,
} from './auth.js';
import { sendViaResend, checkSenderDomain } from './resend.js';
import { reviewCsv, templateContentHash, CsvError, CSV_MAX_RECIPIENTS, CSV_MAX_ROWS } from './csvImport.js';
import { createCampaignRoutes } from './campaigns.js';
import { createUnsubscribeRoute } from './unsubscribe.js';
import { safeDbError } from './store/pgConfig.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

// The app page allows inline *styles* only because the preview iframe's
// srcdoc document inherits this policy and emails are styled inline. Scripts
// are 'self' only; the preview iframe is additionally sandboxed with no
// permissions at all, so nothing inside it can run.
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:", "font-src 'self' https: data:", "connect-src 'self'",
  "frame-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

// Sent on every response from this handler. On Vercel the static files are
// served by the CDN, so vercel.json repeats exactly these headers (a test
// keeps the two in sync). HSTS is added when APP_ORIGIN is https.
export const SECURITY_HEADERS = Object.freeze([
  ['Content-Security-Policy', CSP],
  ['X-Content-Type-Options', 'nosniff'],
  ['X-Frame-Options', 'DENY'],
  ['Referrer-Policy', 'no-referrer'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
  ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
]);
export const HSTS = ['Strict-Transport-Security', 'max-age=31536000'];
export const STATIC_PATHS = Object.freeze(Object.keys(STATIC));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT_TEMPLATE_BODY = 1024 * 1024;
const LIMIT_SMALL_BODY = 8 * 1024;
const TEMPLATE_SIZE_HINT = `A template is one HTML document of at most ${LIMITS.html.toLocaleString('en')} characters. Embedded images (data:…base64) make emails huge — host images at https:// URLs instead.`;
const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n % (1024 * 1024) ? 1 : 0)} MB` : `${Math.round(n / 1024)} KB`);
// Template fields the editor sends. The template is one HTML document:
// styles go inline or in a <style> block inside it (there is no CSS field).
const TEMPLATE_FIELDS = ['name', 'subject', 'html', 'text'];
const SENDER_CACHE_MS = 10 * 60 * 1000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// loginLimiter: any object implementing the async limiter interface in
// auth.js (defaults to the in-process MemoryLoginLimiter).
// serveStatic: false on Vercel — the CDN serves public/, so the function
// never reads files from disk and answers only /api/* (anything else 404s).
// sleep: campaign request pacing (injectable for tests).
export function createApp({ config, db, fetchImpl = fetch, now = Date.now, log = console, loginLimiter, serveStatic = true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const limiter = assertLoginLimiter(loginLimiter ?? new MemoryLoginLimiter({ now }));
  const files = serveStatic
    ? Object.fromEntries(Object.entries(STATIC).map(([path, [file, type]]) => [path, { body: readFileSync(join(PUBLIC_DIR, file)), type }]))
    : {};
  let senderCache = null;
  // Preview tokens are signed with PREVIEW_TOKEN_SECRET (config.js), so every
  // instance sharing that secret accepts the same tokens.
  const previewKey = config.previewSecret;
  if (!Buffer.isBuffer(previewKey) || previewKey.length < 32) throw new Error('Preview-token secret is not configured.');

  // ------------------------------------------------------------ helpers --
  const securityHeaders = (res) => {
    for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
    if (config.secureCookies) res.setHeader(...HSTS);
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const clientIp = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  // Refuses bodies over `limit` bytes before buffering them. The message
  // states the limit so the admin knows what to shrink; `hint` adds advice
  // for the specific endpoint (e.g. templates: embedded images).
  async function readJson(req, limit, hint = '') {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Requests must be JSON.');
    const tooLarge = () => new HttpError(413, `Request is too large: the limit is ${formatBytes(limit)}.${hint ? ` ${hint}` : ''}`, { code: 'too_large', limit_bytes: limit });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) throw tooLarge();
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object.');
    return body;
  }

  function onlyFields(body, allowed) {
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length) throw new HttpError(400, `Unexpected field: ${extra[0]}.`);
  }

  // Same-origin check for every state-changing request.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (origin ? !config.allowedOrigins.has(origin) : req.headers['sec-fetch-site'] !== 'same-origin') {
      throw new HttpError(403, 'Request refused: it did not come from this app.');
    }
  }

  async function currentSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const s = await db.getSession(hash);
    const t = now();
    if (!s) return null;
    if (s.disabled || t - s.last_seen > config.session.idleMs || t - s.created_at > config.session.absoluteMs) {
      await db.deleteSession(hash);
      return null;
    }
    if (t - s.last_seen > 60_000) await db.touchSession(hash, t);
    return { hash, adminId: s.admin_id, email: s.email, csrf: s.csrf_token };
  }

  async function requireSession(req, { mutating }) {
    const session = await currentSession(req);
    if (!session) throw new HttpError(401, 'Sign in required.');
    if (mutating && !safeEqual(req.headers['x-csrf-token'], session.csrf)) throw new HttpError(403, 'Request refused (missing or stale CSRF token). Reload the page.');
    return session;
  }

  function emailState() {
    const e = config.email;
    const missing = [];
    if (!e.dryRun && !e.apiKey) missing.push('RESEND_API_KEY');
    if (!e.sender) missing.push('EMAIL_FROM');
    return { configured: missing.length === 0, missing, dryRun: e.dryRun, from: e.sender?.display ?? null };
  }

  async function senderStatus(force = false) {
    const e = config.email;
    if (e.dryRun) return { state: 'dry_run', message: 'Dry-run mode: Resend is never called.' };
    if (!e.apiKey || !e.sender) return { state: 'unknown', message: 'Email is not configured.' };
    if (!force && senderCache && now() - senderCache.at < SENDER_CACHE_MS) return senderCache.value;
    const value = await checkSenderDomain({ email: e, fetchImpl });
    senderCache = { at: now(), value };
    return value;
  }

  // ------------------------------------------------------------ routes --
  async function login(req, res) {
    checkOrigin(req);
    const body = await readJson(req, LIMIT_SMALL_BODY);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const ip = clientIp(req);
    if (await limiter.isBlocked(email, ip)) throw new HttpError(429, 'Too many failed sign-in attempts. Wait 15 minutes and try again.');
    const admin = email ? await db.getAdminByEmail(email) : null;
    const ok = admin ? await verifyPassword(password, admin.password_hash) : await dummyVerify(password);
    if (!admin || admin.disabled || !ok) {
      await limiter.recordFailure(email, ip);
      throw new HttpError(401, 'Incorrect email or password.');
    }
    await limiter.recordSuccess(email, ip);
    const t = now();
    await db.purgeSessions(t - config.session.idleMs, t - config.session.absoluteMs);
    const token = newToken();
    const csrf = newToken();
    await db.createSession(sha256(token), admin.id, csrf, t);
    log.info?.(`[auth] sign-in admin=${admin.id}`);
    send(res, 200, { admin: { email: admin.email }, csrf_token: csrf }, {
      'Set-Cookie': sessionCookie(token, { secure: config.secureCookies, maxAgeSeconds: Math.floor(config.session.absoluteMs / 1000) }),
    });
  }

  async function logout(req, res) {
    checkOrigin(req);
    const session = await currentSession(req);
    if (session) await db.deleteSession(session.hash);
    send(res, 200, { ok: true }, { 'Set-Cookie': clearedSessionCookie({ secure: config.secureCookies }) });
  }

  async function getSession(req, res) {
    const session = await requireSession(req, { mutating: false });
    send(res, 200, { admin: { email: session.email }, csrf_token: session.csrf });
  }

  async function getStatus(req, res, url) {
    await requireSession(req, { mutating: false });
    const state = emailState();
    const sender = await senderStatus(url.searchParams.get('refresh') === '1');
    send(res, 200, {
      email: { ...state, sender },
      placeholders: PLACEHOLDERS,
      limits: LIMITS,
      send_limit_per_10_min: config.sendLimitPer10Min,
    });
  }

  // ----------------------------------------------------- session slots --
  function sessionIdOf(value) {
    if (typeof value !== 'string' || !SESSION_IDS.includes(value)) throw new HttpError(400, 'Unknown session. Choose Session 1, 2, 3 or 4.', { code: 'invalid_session' });
    return value;
  }

  // A saved session that may be sent: configured, active, and still valid
  // under the current policy. The server always loads it itself.
  async function sendableSession(id) {
    const s = await db.getSessionTemplate(id);
    if (!s.configured) throw new HttpError(409, noTemplateMessage(s.label), { code: 'no_template', session_id: id });
    if (!s.active) throw new HttpError(409, `${s.label} is turned off for sending. Turn it on in its template settings first.`, { code: 'session_inactive', session_id: id });
    return s;
  }

  // Preview tokens: an HMAC (keyed with PREVIEW_TOKEN_SECRET) over exactly
  // what the admin previewed. /api/send requires one that matches the
  // session, the template version and the recipient, so any change after
  // previewing — a template save, another session, other recipient details —
  // forces a new preview. Valid for 30 minutes. Changing the secret (or, in
  // development without one, restarting) invalidates outstanding previews.
  function previewToken(f, issuedAt = now()) {
    const mac = createHmac('sha256', previewKey)
      .update(JSON.stringify([f.adminId, f.sessionId, f.version, !!f.test, f.name, f.email, issuedAt]))
      .digest('base64url');
    return `${issuedAt}.${mac}`;
  }

  function previewTokenValid(token, f) {
    if (typeof token !== 'string' || token.length > 200) return false;
    const issued = Number(token.split('.')[0]);
    const t = now();
    if (!Number.isSafeInteger(issued) || t - issued > PREVIEW_TTL_MS || issued > t + 60_000) return false;
    return safeEqual(previewToken(f, issued), token);
  }

  async function listSessions(req, res) {
    await requireSession(req, { mutating: false });
    send(res, 200, { sessions: await db.listSessionTemplates() });
  }

  async function getSessionTemplate(req, res, url, id) {
    await requireSession(req, { mutating: false });
    send(res, 200, { session: await db.getSessionTemplate(sessionIdOf(id)) });
  }

  async function putSessionTemplate(req, res, url, rawId) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const id = sessionIdOf(rawId);
    const body = await readJson(req, LIMIT_TEMPLATE_BODY, TEMPLATE_SIZE_HINT);
    onlyFields(body, [...TEMPLATE_FIELDS, 'active', 'expected_version']);
    const draft = { subject: body.subject, html: body.html, css: '', text: body.text ?? '' };
    const { errors, warnings } = validateTemplate(draft);
    const sessionName = validateSessionName(body.name);
    if (sessionName.error) errors.unshift({ level: 'error', field: 'name', message: sessionName.error });
    if (body.active !== undefined && typeof body.active !== 'boolean') errors.push({ level: 'error', field: 'active', message: 'active must be true or false.' });
    if (errors.length) throw new HttpError(422, 'The template was not saved. Fix the problems listed and save again.', { issues: [...errors, ...warnings] });
    if (!Number.isInteger(body.expected_version) || body.expected_version < 0) throw new HttpError(400, 'expected_version is required.');
    const result = await db.saveSessionTemplate(id, { ...draft, name: sessionName.name, active: body.active !== false }, body.expected_version, session.adminId, now());
    if (result.conflict) {
      throw new HttpError(409, `Someone saved a newer version of this session's template (version ${result.currentVersion}) since you loaded it. Reload it before saving.`, { code: 'version_conflict', current_version: result.currentVersion });
    }
    log.info?.(`[template] saved session=${id} version=${result.version} admin=${session.adminId}`);
    send(res, 200, { session: await db.getSessionTemplate(id), issues: warnings });
  }

  // Renders exactly what /api/send would send. Never calls Resend and never
  // writes anything.
  async function preview(req, res) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_TEMPLATE_BODY, TEMPLATE_SIZE_HINT);
    onlyFields(body, ['session_id', 'source', 'draft', 'name', 'email', 'test']);
    const sessionId = sessionIdOf(body.session_id);
    let template;
    let label;
    let issues = [];
    if (body.source === 'draft') {
      const d = body.draft;
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new HttpError(400, 'draft must be an object with the template fields.');
      onlyFields(d, TEMPLATE_FIELDS);
      template = { subject: d.subject, html: d.html, css: '', text: d.text ?? '' };
      const v = validateTemplate(template);
      if (v.errors.length) throw new HttpError(422, 'The draft has problems — fix them to preview.', { issues: [...v.errors, ...v.warnings] });
      issues = v.warnings;
      label = validateSessionName(d.name).name || defaultLabel(sessionId);
    } else if (body.source === 'saved') {
      template = await db.getSessionTemplate(sessionId);
      if (!template.configured) throw new HttpError(409, noTemplateMessage(template.label), { code: 'no_template', session_id: sessionId });
      label = template.label;
    } else throw new HttpError(400, 'source must be "saved" or "draft".');

    const test = body.test === true;
    const hasName = typeof body.name === 'string' && body.name.trim() !== '';
    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const name = test ? TEST_RECIPIENT_NAME : (hasName ? body.name : 'Recipient Name');
    const email = hasEmail ? body.email : 'recipient@example.com';
    const v = validateRecipient({ name, email });
    if (v.errors) throw new HttpError(400, 'Check the recipient details.', { fields: v.errors });
    const rendered = renderEmail(template, v.recipient, { test });
    if (rendered.errors) throw new HttpError(422, 'This recipient produces an email that fails validation.', { issues: rendered.errors });

    // Only a preview of the SAVED, sendable template for a real recipient
    // can authorize a send.
    const sendable = body.source === 'saved' && template.active && hasEmail && (test || hasName);
    send(res, 200, {
      session_id: sessionId, session_label: label, source: body.source,
      subject: rendered.subject, html: rendered.html, text: rendered.text ?? null,
      to: v.recipient.email, name: v.recipient.name, from: config.email.sender?.display ?? null,
      template_version: body.source === 'saved' ? template.version : null,
      test, issues,
      preview_token: sendable
        ? previewToken({ adminId: session.adminId, sessionId, version: template.version, test, name: v.recipient.name, email: v.recipient.email })
        : null,
    });
  }

  // Campaign review (Phase 2A): parses and validates a CSV of recipients
  // against a session's SAVED template and renders one personalized
  // preview. Stateless: nothing is stored, queued or sent, Resend is never
  // called, and the response carries no preview token (it cannot authorize
  // a send). The browser re-sends the CSV for each review; its own checks
  // are never trusted. Logs counts only — never names, addresses or bodies.
  async function reviewCampaign(req, res) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_TEMPLATE_BODY, 'Split the CSV into smaller files.');
    onlyFields(body, ['session_id', 'csv', 'preview_row']);
    const sessionId = sessionIdOf(body.session_id);
    if (typeof body.csv !== 'string') throw new HttpError(400, 'csv must be the text of the CSV file.');
    if (body.preview_row !== undefined && body.preview_row !== null && (!Number.isSafeInteger(body.preview_row) || body.preview_row < 2)) {
      throw new HttpError(400, 'preview_row must be a CSV row number.');
    }
    const template = await db.getSessionTemplate(sessionId);
    if (!template.configured) throw new HttpError(409, noTemplateMessage(template.label), { code: 'no_template', session_id: sessionId });
    const saved = validateTemplate(template);
    if (saved.errors.length) throw new HttpError(422, 'The saved template fails validation. Fix and re-save it before reviewing a list.', { issues: saved.errors });

    let result;
    try {
      result = reviewCsv(body.csv);
    } catch (err) {
      if (err instanceof CsvError) throw new HttpError(err.code === 'too_many_recipients' || err.code === 'too_many_rows' ? 413 : 422, err.message, { code: `csv_${err.code}` });
      throw err;
    }

    let previewOut = null;
    const pick = body.preview_row == null ? result.recipients[0] : result.recipients.find((r) => r.row === body.preview_row);
    if (body.preview_row != null && !pick) throw new HttpError(400, `Row ${body.preview_row} is not a valid recipient in this CSV.`);
    if (pick) {
      // Exactly what a campaign sends: plain text derived if the template has
      // none, and the server-added unsubscribe footer (inactive sample link).
      const rendered = renderEmail(template, pick, { autoText: true });
      if (rendered.errors) {
        previewOut = { row: pick.row, name: pick.name, to: pick.email, errors: rendered.errors };
      } else {
        const withFooter = campaigns.previewFooter(rendered);
        previewOut = { row: pick.row, name: pick.name, to: pick.email, subject: withFooter.subject, html: withFooter.html, text: withFooter.text };
      }
    }
    const availability = await campaigns.availability();
    const previously = await campaigns.previouslySent(sessionId, result.recipients.map((r) => r.email));
    const suppressedRows = await campaigns.suppressedRows(result.recipients);
    log.info?.(`[campaign-review] session=${sessionId} admin=${session.adminId} rows=${result.counts.total} valid=${result.counts.valid} invalid=${result.counts.invalid} duplicate=${result.counts.duplicate} blank=${result.counts.blank}`);
    send(res, 200, {
      session_id: sessionId, session_label: template.label, session_active: template.active,
      template_version: template.version, template_hash: templateContentHash(template), template_warnings: saved.warnings,
      from: config.email.sender?.display ?? null, reply_to: config.email.replyTo || null, dry_run: config.email.dryRun,
      counts: result.counts, recipients: result.recipients, problems: result.problems, recipients_hash: result.recipients_hash,
      limits: { max_recipients: CSV_MAX_RECIPIENTS, max_rows: CSV_MAX_ROWS, max_bytes: LIMIT_TEMPLATE_BODY },
      preview: previewOut,
      // Not blocking: these addresses already received an email from an
      // earlier campaign of this session (Resend accepted it).
      previously_sent: previously,
      // Rows whose address unsubscribed: kept for the record, never sent.
      suppressed_rows: suppressedRows,
      campaigns: availability,
    });
  }

  async function sendEmail(req, res, { test }) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_SMALL_BODY);
    onlyFields(body, test
      ? ['session_id', 'email', 'template_version', 'preview_token', 'idempotency_key']
      : ['session_id', 'name', 'email', 'template_version', 'preview_token', 'idempotency_key']);
    const sessionId = sessionIdOf(body.session_id);

    let recipient;
    if (test) {
      const e = validateEmailAddress(body.email);
      if (e.error) throw new HttpError(400, e.error, { fields: { email: e.error } });
      recipient = { name: TEST_RECIPIENT_NAME, email: e.email };
    } else {
      const v = validateRecipient({ name: body.name, email: body.email });
      if (v.errors) throw new HttpError(400, 'Check the recipient details.', { fields: v.errors });
      recipient = v.recipient;
    }
    if (typeof body.idempotency_key !== 'string' || !UUID_RE.test(body.idempotency_key)) throw new HttpError(400, 'Missing send id. Reload the page.');
    const key = body.idempotency_key.toLowerCase();

    const template = await sendableSession(sessionId);
    // Invitations are not sent to addresses that unsubscribed (test emails
    // go to the admin's own address and are not invitations).
    if (!test && await campaigns.isSuppressedAddress(recipient.email)) {
      throw new HttpError(409, 'This address unsubscribed from Tangy Sessions invitations. Nothing was sent.', { code: 'suppressed' });
    }
    if (body.template_version !== template.version) {
      throw new HttpError(409, `${template.label}'s template changed (now version ${template.version}) after you reviewed it. Preview again before sending.`, { code: 'template_changed', current_version: template.version });
    }
    if (!previewTokenValid(body.preview_token, { adminId: session.adminId, sessionId, version: template.version, test, name: recipient.name, email: recipient.email })) {
      throw new HttpError(409, 'Preview this exact email again before sending (the session, template or recipient changed since the last preview, or the preview expired).', { code: 'preview_required' });
    }
    const saved = validateTemplate(template);
    if (saved.errors.length) throw new HttpError(422, 'The saved template fails validation and cannot be sent. Fix and re-save it.', { issues: saved.errors });
    const rendered = renderEmail(template, recipient, { test });
    if (rendered.errors) throw new HttpError(422, 'This recipient produces an email that fails validation.', { issues: rendered.errors });

    const state = emailState();
    if (!state.configured) {
      throw new HttpError(503, `Email is not configured on the server. Missing: ${state.missing.join(', ')}. Nothing was sent.`, { code: 'not_configured' });
    }
    if (!config.email.dryRun) {
      const sender = await senderStatus();
      if (sender.state === 'not_verified') {
        throw new HttpError(503, `The sender ${config.email.sender.display} is not verified in Resend: ${sender.message} Nothing was sent.`, { code: 'sender_not_verified' });
      }
    }

    const t = now();
    const common = { session_id: sessionId, session_label: template.label, to: recipient.email, subject: rendered.subject, from: state.from, test };
    // Atomically claim this send id before calling Resend (both stores; see
    // src/store/sendClaim.js). Only 'claimed' and 'reclaimed' may send.
    const claim = await db.claimSend({
      key, adminId: session.adminId, sessionId, sessionName: template.label, email: recipient.email,
      subject: rendered.subject, test, version: template.version, now: t, limit: config.sendLimitPer10Min,
    });
    switch (claim.outcome) {
      case 'claimed':
        break;
      case 'reclaimed':
        // An explicit retry of the SAME attempt after an uncertain outcome.
        // The same Idempotency-Key goes to Resend, which returns the original
        // result instead of sending a second copy if the first request was in
        // fact accepted (Resend keeps keys for 24 hours).
        break;
      case 'mismatch':
        throw new HttpError(409, 'This send id was already used for a different message. Reload the page.');
      case 'done':
        return send(res, 200, { ...common, status: claim.row.status, message_id: claim.row.provider_message_id, duplicate: true });
      case 'in_progress':
        throw new HttpError(409, 'This send is already in progress.');
      case 'finished_error':
        throw new HttpError(409, 'This attempt already finished with an error. Start a new send.');
      case 'rate_limited':
        throw new HttpError(429, `Send limit reached (${config.sendLimitPer10Min} per 10 minutes). Wait a few minutes.`);
      default:
        throw new Error('Unexpected send-claim outcome.');
    }

    // No database transaction or pooled connection is held from here until
    // completeSend. Never retried automatically.
    let result;
    try {
      result = config.email.dryRun
        ? { status: 'dry_run' }
        : await sendViaResend({
          email: config.email,
          message: { to: recipient.email, subject: rendered.subject, html: rendered.html, text: rendered.text, test, sessionId },
          idempotencyKey: `tangy-custom-email/${key}`,
          fetchImpl,
        });
    } catch (err) {
      log.error?.(`[send] unexpected error while sending: ${safeDbError(err)}`);
      result = { status: 'ambiguous', error: 'An unexpected error occurred while contacting Resend. The outcome is unknown — check the Resend dashboard (Emails) before retrying.' };
    }
    let historyWarning = null;
    try {
      await db.completeSend(key, result.status, result.id, result.error, now());
    } catch (err) {
      // The provider result is still reported truthfully. The row stays
      // 'pending' and becomes retryable (same send id) after a few minutes.
      log.error?.(`[send] could not record the outcome: ${safeDbError(err)}`);
      historyWarning = 'The send history could not be updated, so this attempt may show as pending. The result above is what Resend reported.';
    }
    log.info?.(`[send] status=${result.status} session=${sessionId} test=${test} admin=${session.adminId}${result.id ? ` id=${result.id}` : ''}`);

    const payload = { ...common, status: result.status, message_id: result.id ?? null, idempotency_key: key, ...(historyWarning ? { history_warning: historyWarning } : {}) };
    if (result.status === 'accepted' || result.status === 'dry_run') return send(res, 200, payload);
    const status = result.status === 'ambiguous' ? 504 : 502;
    return send(res, status, { ...payload, error: result.error });
  }

  async function listSends(req, res) {
    await requireSession(req, { mutating: false });
    send(res, 200, { sends: await db.recentSends(25), stats: await db.sendStats(now()) });
  }

  const campaigns = createCampaignRoutes({
    config, db, now, log, fetchImpl, sleep, HttpError, send, readJson, onlyFields, checkOrigin, requireSession,
    sessionIdOf, emailState, senderStatus, LIMIT_TEMPLATE_BODY, LIMIT_SMALL_BODY,
  });

  const unsubscribe = createUnsubscribeRoute({ db, now, log });

  const routes = {
    'POST /api/login': login,
    'POST /api/logout': logout,
    'GET /api/session': getSession,
    'GET /api/status': getStatus,
    'GET /api/sessions': listSessions,
    'POST /api/preview': preview,
    'POST /api/send': (req, res) => sendEmail(req, res, { test: false }),
    'POST /api/send-test': (req, res) => sendEmail(req, res, { test: true }),
    'POST /api/campaigns/review': reviewCampaign,
    'GET /api/sends': listSends,
  };
  // /api/sessions/:id — the id is validated against s1–s4 inside each handler.
  const sessionRoutes = { GET: getSessionTemplate, PUT: putSessionTemplate };

  return async function handler(req, res) {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://local');
    } catch {
      return send(res, 400, { error: 'Bad request.' });
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        // Public: the unsubscribe token is the only credential (no sign-in,
        // no origin check — mail providers POST it directly, RFC 8058).
        const u = /^\/api\/unsubscribe\/([^/]{1,100})$/.exec(url.pathname);
        if (u && ['GET', 'HEAD', 'POST'].includes(req.method)) return await unsubscribe(req, res, u[1]);
        const m = /^\/api\/sessions\/([^/]{1,16})$/.exec(url.pathname);
        if (m && sessionRoutes[req.method]) return await sessionRoutes[req.method](req, res, url, decodeURIComponent(m[1]));
        const route = routes[`${req.method} ${url.pathname}`] ?? campaigns.route(req.method, url.pathname);
        if (!route) throw new HttpError(404, 'Not found.');
        return await route(req, res, url);
      }
      const file = (req.method === 'GET' || req.method === 'HEAD') && files[url.pathname];
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : file.body);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      // Never log raw error text that could contain a connection string.
      log.error?.(`[server] unexpected error: ${safeDbError(err)}`);
      return send(res, 500, { error: 'Unexpected server error. Nothing was changed.' });
    }
  };
}
