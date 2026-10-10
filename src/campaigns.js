// Campaigns: confirm a reviewed CSV list, then send it one recipient at a
// time under server control. Routes (all signed-in; every POST also checks
// the origin and the CSRF token):
//
//   GET  /api/campaigns                         list + whether campaigns are available
//   POST /api/campaigns                         confirm a reviewed list (creates the campaign)
//   GET  /api/campaigns/:id                     detail with live counts
//   GET  /api/campaigns/:id/recipients?page=&status=
//   POST /api/campaigns/:id/start|pause|resume|cancel|complete
//   POST /api/campaigns/:id/retry               { kind: 'failed' | 'unresolved' }
//   POST /api/campaigns/:id/process             send the next small batch (see below)
//
// Confirmation re-parses the CSV on the server and must match what was
// reviewed: the recipient-list fingerprint, the template version and the
// template-content hash. Anything that changed means "review again".
//
// Sending: there is no background job. While a campaign is 'sending', the
// open campaign page asks the server to process the next batch; the server
// decides everything — it claims ONE recipient at a time in a short
// transaction (one in-flight request per campaign), calls Resend with no
// transaction open, records the outcome only if it still holds the claim,
// paces requests to RESEND_RATE_LIMIT_PER_SECOND and stops each batch well
// inside the request time limit. Closing the page simply stops progress;
// stale claims are recovered by the next batch with the SAME idempotency key.
//
// Outcomes (Resend reports acceptance, never delivery):
//   accepted                → accepted (provider message id stored)
//   dry run                 → dry_run (simulated; nothing sent)
//   not sent (no connection)→ retried automatically with backoff, then failed
//   429 rate limited        → retried after a pause, then failed
//   timeout / 5xx / no id   → unresolved: NEVER retried automatically (it may
//                             have been accepted); an admin may retry it with
//                             the same idempotency key while Resend still
//                             remembers it (~24 h), or check Resend
//   401 / 403               → campaign paused (configuration), recipient back to pending
//   409 / other 4xx         → unresolved (409) / rejected
//
// Unsubscribe and suppression (src/unsubscribe.js): every campaign email
// carries a visible unsubscribe link and List-Unsubscribe /
// List-Unsubscribe-Post (RFC 8058) headers. Addresses that already opted out
// are skipped at confirmation, and the suppression list is checked again
// after each claim, immediately before the provider request — so an opt-out
// that arrives while a recipient is queued, retried or claimed is honoured.
// (A request already in flight cannot be recalled.)
import { randomUUID } from 'node:crypto';
import { reviewCsv, templateContentHash, CsvError } from './csvImport.js';
import { validateTemplate, renderEmail, noTemplateMessage, addUnsubscribeFooter, liveImageProblem } from './templatePolicy.js';
import { unsubscribeKey, unsubscribeToken, tokenHash, suppressionHash, unsubscribeUrl } from './unsubscribe.js';
import { sendViaResend } from './resend.js';
import { RECIPIENT_STATUSES, MAX_ATTEMPTS } from './store/campaignRules.js';
import { safeDbError } from './store/pgConfig.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
// Resend keeps idempotency keys for 24 h; stay safely inside that.
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
// Automatic retries when Resend was never reached / rate-limited us.
export const AUTO_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 30_000; // 30 s, 60 s, …
export const RATE_LIMIT_PAUSE_MS = 60_000;
// One process request must finish inside the serverless time limit (30 s).
export const PROCESS_BUDGET_MS = 25_000;
const MAX_PER_BATCH = { live: 20, dry: 50 };
const PAGE_SIZE = 50;
// Reasons that mean "a request may have been accepted" (from unresolved).
const UNCERTAIN_REASONS = new Set(['timeout', 'provider_unavailable', 'unknown']);
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,100}$/;

const STOP_MESSAGES = {
  template_changed: 'The session\'s template changed after this campaign was confirmed. Nothing changed was sent. Cancel this campaign, then review and confirm the list again.',
  session_inactive: 'The session is turned off for sending. Turn it back on, then resume.',
  sender_not_verified: 'The sender domain is not verified in Resend. Nothing more was sent.',
  provider_rate_limited: 'Resend rate limit reached.',
  provider_unavailable: 'Resend is not available right now.',
  error: 'Email sending is not configured correctly on the server (missing key/sender, or the key was refused). Nothing more was sent.',
  insecure_origin: 'Real sending needs APP_ORIGIN to be an https:// address, so unsubscribe links work. Nothing was sent.',
  unsubscribe_key: 'The unsubscribe links for this campaign can no longer be generated (PREVIEW_TOKEN_SECRET changed after confirmation, or the campaign predates unsubscribe support). Nothing more was sent — cancel it and confirm the list again.',
  admin: 'Paused by an admin.',
};

export function createCampaignRoutes(ctx) {
  const {
    config, db, now, log, fetchImpl, sleep, HttpError, send, readJson, onlyFields, checkOrigin, requireSession,
    sessionIdOf, emailState, senderStatus, LIMIT_TEMPLATE_BODY, LIMIT_SMALL_BODY,
  } = ctx;
  const staleMs = config.email.timeoutMs + 60_000;
  const unsubKey = unsubscribeKey(config.previewSecret);

  async function availability() {
    return db.campaignsAvailable();
  }
  async function requireCampaigns() {
    const a = await availability();
    if (!a.available) throw new HttpError(503, a.reason, { code: 'campaigns_unavailable', ...a });
  }
  async function loadCampaign(id) {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Campaign not found.');
    const c = await db.getCampaign(id.toLowerCase());
    if (!c) throw new HttpError(404, 'Campaign not found.');
    return c;
  }

  // --------------------------------------------------------- confirm --
  async function confirm(req, res) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_TEMPLATE_BODY, 'Split the CSV into smaller files.');
    onlyFields(body, ['session_id', 'csv', 'name', 'creation_key', 'template_version', 'template_hash', 'recipients_hash', 'confirm_count']);
    const sessionId = sessionIdOf(body.session_id);
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!NAME_RE.test(name)) throw new HttpError(400, 'Give the campaign a name (at most 100 characters).', { fields: { name: 'required' } });
    if (typeof body.creation_key !== 'string' || !UUID_RE.test(body.creation_key)) throw new HttpError(400, 'Missing confirmation id. Review the list again.');
    if (!Number.isSafeInteger(body.template_version) || typeof body.template_hash !== 'string' || !HEX64.test(body.template_hash)
        || typeof body.recipients_hash !== 'string' || !HEX64.test(body.recipients_hash)) {
      throw new HttpError(400, 'The confirmation must include the reviewed template version, template hash and list fingerprint. Review the list again.');
    }
    if (typeof body.csv !== 'string') throw new HttpError(400, 'csv must be the text of the CSV file.');
    await requireCampaigns();

    const template = await db.getSessionTemplate(sessionId);
    if (!template.configured) throw new HttpError(409, noTemplateMessage(template.label), { code: 'no_template' });
    if (!template.active) throw new HttpError(409, `${template.label} is turned off for sending. Turn it on before confirming a campaign.`, { code: 'session_inactive' });
    if (validateTemplate(template).errors.length) throw new HttpError(422, 'The saved template fails validation. Fix and re-save it, then review again.', { code: 'template_invalid' });
    const hash = templateContentHash(template);
    if (template.version !== body.template_version || hash !== body.template_hash) {
      throw new HttpError(409, `${template.label}'s template changed since you reviewed this list (now version ${template.version}). Review the list again before confirming.`,
        { code: 'template_changed', current_version: template.version });
    }
    let review;
    try {
      review = reviewCsv(body.csv);
    } catch (err) {
      if (err instanceof CsvError) throw new HttpError(err.code === 'too_many_recipients' || err.code === 'too_many_rows' ? 413 : 422, err.message, { code: `csv_${err.code}` });
      throw err;
    }
    if (review.recipients_hash !== body.recipients_hash) {
      throw new HttpError(409, 'The recipient list is not the one you reviewed. Review it again before confirming.', { code: 'list_changed' });
    }
    if (review.counts.valid === 0) throw new HttpError(422, 'The list has no valid recipients.', { code: 'no_recipients' });
    if (body.confirm_count !== review.counts.valid) {
      throw new HttpError(400, `Type the number of recipients (${review.counts.valid}) to confirm.`, { code: 'confirm_count' });
    }

    const t = now();
    const recipients = review.recipients.map((r) => {
      const sendId = randomUUID();
      return { ...r, sendId, unsubscribeHash: tokenHash(unsubscribeToken(unsubKey, sendId)) };
    });
    const suppressed = new Set(await db.suppressedAmong(recipients.map((r) => suppressionHash(r.email))));
    const result = await db.createCampaign({
      id: randomUUID(), creationKey: body.creation_key.toLowerCase(), adminId: session.adminId, sessionId, sessionName: template.label, name,
      templateVersion: template.version, templateHash: hash, recipientsHash: review.recipients_hash,
      counts: { total: review.counts.total, invalid: review.counts.invalid, duplicate: review.counts.duplicate, blank: review.counts.blank },
      recipients, suppressedEmails: recipients.filter((r) => suppressed.has(suppressionHash(r.email))).map((r) => r.email), now: t,
    });
    if (result.outcome === 'session_busy') {
      throw new HttpError(409, `${template.label} already has an open campaign (confirmed, sending or paused). Finish or cancel it first.`, { code: 'session_busy', campaign_id: result.campaignId });
    }
    if (result.outcome === 'key_mismatch') throw new HttpError(409, 'This confirmation id was already used for a different list. Review the list again.', { code: 'key_mismatch' });
    const campaign = await db.getCampaign(result.campaignId);
    if (result.outcome === 'created') log.info?.(`[campaign] confirmed id=${campaign.id} session=${sessionId} recipients=${campaign.total_recipients} admin=${session.adminId}`);
    send(res, result.outcome === 'created' ? 201 : 200, { campaign, duplicate: result.outcome === 'existing' });
  }

  // ------------------------------------------------------------ reads --
  async function list(req, res) {
    await requireSession(req, { mutating: false });
    const a = await availability();
    send(res, 200, { availability: a, dry_run: config.email.dryRun, campaigns: a.available ? await db.listCampaigns(50) : [] });
  }

  async function detail(req, res, url, id) {
    await requireSession(req, { mutating: false });
    await requireCampaigns();
    send(res, 200, { campaign: await loadCampaign(id), dry_run: config.email.dryRun, stop_message: null });
  }

  async function recipients(req, res, url, id) {
    await requireSession(req, { mutating: false });
    await requireCampaigns();
    const c = await loadCampaign(id);
    const page = Number(url.searchParams.get('page') || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new HttpError(400, 'page must be a positive whole number.');
    const status = url.searchParams.get('status') || null;
    if (status && !RECIPIENT_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status filter.');
    const r = await db.listCampaignRecipients(c.id, { offset: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE, status });
    send(res, 200, { page, page_size: PAGE_SIZE, total: r.total, recipients: r.rows });
  }

  // ---------------------------------------------------------- actions --
  async function action(req, res, url, id, name) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_SMALL_BODY);
    onlyFields(body, name === 'retry' ? ['kind'] : []);
    await requireCampaigns();
    const c = await loadCampaign(id);
    const t = now();
    if (name === 'retry') {
      if (body.kind !== 'failed' && body.kind !== 'unresolved') throw new HttpError(400, 'kind must be "failed" or "unresolved".');
      const r = await db.retryRecipients(c.id, body.kind, { now: t, windowStart: t - IDEMPOTENCY_WINDOW_MS });
      if (!r.ok) throw new HttpError(409, `Recipients can only be retried while the campaign is sending or paused (it is ${r.status}).`, { code: 'invalid_state' });
      log.info?.(`[campaign] retry id=${c.id} kind=${body.kind} recipients=${r.retried} admin=${session.adminId}`);
      return send(res, 200, { campaign: await db.getCampaign(c.id), retried: r.retried });
    }
    const r = await db.transitionCampaign(c.id, name, { now: t, stopReason: name === 'pause' || name === 'cancel' ? 'admin' : null });
    if (!r.ok) {
      const msg = r.unfinished
        ? 'Some recipients are still pending or being sent. Wait for them, or cancel the campaign.'
        : `A ${r.status} campaign cannot be ${{ start: 'started', pause: 'paused', resume: 'resumed', cancel: 'cancelled', complete: 'completed' }[name]}.`;
      throw new HttpError(409, msg, { code: 'invalid_state', status: r.status });
    }
    log.info?.(`[campaign] ${name} id=${c.id} ${r.from}->${r.status} admin=${session.adminId}`);
    send(res, 200, { campaign: await db.getCampaign(c.id) });
  }

  // ---------------------------------------------------------- process --
  // Decides what a provider result means for one recipient.
  function decide(result, r, t) {
    if (result.status === 'dry_run') return { status: 'dry_run', tally: 'dry_run' };
    if (result.status === 'accepted') return { status: 'accepted', providerMessageId: result.id, tally: 'accepted' };
    const exhausted = r.attempts >= AUTO_RETRY_ATTEMPTS;
    if (result.status === 'failed') {
      // Never reached Resend: nothing was sent, so retrying is safe.
      return exhausted
        ? { status: 'failed', reason: 'retries_exhausted', tally: 'failed' }
        : { status: 'pending', reason: 'network', nextAttemptAt: t + RETRY_BACKOFF_MS * 2 ** (r.attempts - 1), tally: 'retry_later' };
    }
    if (result.status === 'ambiguous') {
      return { status: 'unresolved', reason: result.cause === 'timeout' ? 'timeout' : 'provider_unavailable', tally: 'unresolved' };
    }
    // rejected (4xx)
    switch (result.httpStatus) {
      case 429:
        return exhausted
          ? { status: 'failed', reason: 'retries_exhausted', tally: 'failed' }
          : { status: 'pending', reason: 'rate_limited', nextAttemptAt: t + RATE_LIMIT_PAUSE_MS, tally: 'retry_later', stopBatch: RATE_LIMIT_PAUSE_MS };
      case 401:
        return { status: 'pending', reason: 'provider_rejected', tally: 'retry_later', pause: 'error' };
      case 403:
        return { status: 'pending', reason: 'provider_rejected', tally: 'retry_later', pause: 'sender_not_verified' };
      case 409:
        return { status: 'unresolved', reason: 'unknown', tally: 'unresolved' };
      default:
        return { status: 'rejected', reason: 'provider_rejected', tally: 'rejected' };
    }
  }

  // Checks that must hold before anything is claimed: [stop reason, message] or null.
  async function precondition(campaign, template) {
    const stop = (reason, key = reason) => [reason, STOP_MESSAGES[key]];
    if (!template.configured || template.version !== campaign.template_version || templateContentHash(template) !== campaign.template_hash) return stop('template_changed');
    if (!template.active) return stop('session_inactive');
    if (validateTemplate(template).errors.length) return stop('error');
    if (!config.email.dryRun) {
      if (!emailState().configured) return stop('error');
      if (!config.appOrigin.startsWith('https://')) return stop('error', 'insecure_origin');
      const imageProblem = liveImageProblem({ html: template.html, text: template.text, subject: template.subject });
      if (imageProblem) return ['error', `${imageProblem} Nothing was sent.`];
      if ((await senderStatus()).state === 'not_verified') return stop('sender_not_verified');
    }
    return null;
  }

  async function process(req, res, url, id) {
    checkOrigin(req);
    const session = await requireSession(req, { mutating: true });
    const body = await readJson(req, LIMIT_SMALL_BODY);
    onlyFields(body, []);
    await requireCampaigns();
    let campaign = await loadCampaign(id);
    const dryRun = config.email.dryRun;
    const tally = { accepted: 0, dry_run: 0, retry_later: 0, failed: 0, rejected: 0, unresolved: 0, suppressed: 0 };
    if (campaign.status !== 'sending') return send(res, 200, { campaign, processed: 0, tally, dry_run: dryRun, next_delay_ms: null });

    const template = await db.getSessionTemplate(campaign.session_id);
    const blocked = await precondition(campaign, template);
    if (blocked) {
      await db.transitionCampaign(campaign.id, 'pause', { now: now(), stopReason: blocked[0] });
      log.info?.(`[campaign] paused id=${campaign.id} reason=${blocked[0]}`);
      return send(res, 200, { campaign: await db.getCampaign(campaign.id), processed: 0, tally, dry_run: dryRun, stopped: blocked[0], stop_message: blocked[1], next_delay_ms: null });
    }

    const started = now();
    const interval = Math.ceil(1000 / config.email.ratePerSecond);
    const maxPerBatch = dryRun ? MAX_PER_BATCH.dry : MAX_PER_BATCH.live;
    let processed = 0;
    let lastRequestAt = 0;
    let nextDelay = null;
    let stopped = null;
    let stopMessage = null;
    // More may be due right away: come back after one pacing interval.
    const comeBack = dryRun ? 0 : interval;
    for (;;) {
      if (processed >= maxPerBatch) { nextDelay = comeBack; break; }
      // Never start a request that could outlive the request budget.
      if (processed > 0 && now() - started + config.email.timeoutMs + interval > PROCESS_BUDGET_MS) { nextDelay = comeBack; break; }
      const claim = await db.claimNextRecipient(campaign.id, { now: now(), staleMs });
      if (claim.outcome === 'busy') { nextDelay = 2000; break; }
      if (claim.outcome === 'idle') { nextDelay = claim.nextAttemptAt == null ? null : Math.max(1000, claim.nextAttemptAt - now()); break; }
      if (claim.outcome !== 'claimed') break; // paused/cancelled meanwhile
      const r = claim.recipient;
      processed++;
      const record = (d) => db.completeRecipient({
        id: r.id, claimCount: r.claim_count, status: d.status, reason: d.reason ?? null,
        providerMessageId: d.providerMessageId ?? null, nextAttemptAt: d.nextAttemptAt ?? null, now: now(),
      });

      // An earlier request may have been accepted (stale claim, or a manual
      // retry of an unresolved one) and Resend no longer remembers the key:
      // sending again could duplicate the email, so stop and surface it.
      if ((r.taken_over || UNCERTAIN_REASONS.has(r.reason)) && r.attempts > 1 && now() - r.first_attempt_at > IDEMPOTENCY_WINDOW_MS) {
        await record({ status: 'unresolved', reason: 'unknown' });
        tally.unresolved++;
        continue;
      }
      // Opted out (possibly moments ago, or before an admin retry): never send.
      if (await db.isSuppressed(suppressionHash(r.email))) {
        await record({ status: 'skipped', reason: 'suppressed' });
        tally.suppressed++;
        continue;
      }
      // The unsubscribe link must match what was stored at confirmation.
      const token = unsubscribeToken(unsubKey, r.send_id);
      if (!r.unsubscribe_hash || tokenHash(token) !== r.unsubscribe_hash) {
        if (!dryRun) {
          await record({ status: 'pending', reason: null });
          await db.transitionCampaign(campaign.id, 'pause', { now: now(), stopReason: 'error' });
          stopped = 'error';
          stopMessage = STOP_MESSAGES.unsubscribe_key;
          break;
        }
      }
      const link = unsubscribeUrl(config.appOrigin, token);
      const personalized = renderEmail(template, { name: r.name, email: r.email }, { autoText: true });
      if (personalized.errors) {
        await record({ status: 'failed', reason: 'render_failed' });
        tally.failed++;
        continue;
      }
      const rendered = addUnsubscribeFooter(personalized, link);
      let result;
      if (dryRun) {
        result = { status: 'dry_run' };
      } else {
        const wait = lastRequestAt + interval - now();
        if (wait > 0) await sleep(wait);
        lastRequestAt = now();
        try {
          result = await sendViaResend({
            email: config.email,
            message: {
              to: r.email, subject: rendered.subject, html: rendered.html, text: rendered.text, test: false, sessionId: campaign.session_id, campaignId: campaign.id,
              // RFC 2369 / RFC 8058 one-click unsubscribe (Gmail / Yahoo bulk-sender rules).
              headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
            },
            idempotencyKey: `tangy-campaign/${r.send_id}`,
            fetchImpl,
          });
        } catch (err) {
          log.error?.(`[campaign] unexpected send error id=${campaign.id}: ${safeDbError(err)}`);
          result = { status: 'ambiguous', cause: 'unknown' };
        }
      }
      const d = decide(result, r, now());
      if (!(await record(d))) log.error?.(`[campaign] outcome not recorded id=${campaign.id} row=${r.row_number}: the claim was taken over`);
      tally[d.tally]++;
      if (d.pause) {
        await db.transitionCampaign(campaign.id, 'pause', { now: now(), stopReason: d.pause });
        stopped = d.pause;
        stopMessage = STOP_MESSAGES[d.pause];
        break;
      }
      if (d.stopBatch) { nextDelay = d.stopBatch; break; }
    }

    campaign = await db.getCampaign(campaign.id);
    const k = campaign.counts;
    if (campaign.status === 'sending' && k.pending === 0 && k.claimed === 0 && k.failed === 0 && k.unresolved === 0) {
      const done = await db.transitionCampaign(campaign.id, 'complete', { now: now() });
      if (done.ok) campaign = await db.getCampaign(campaign.id);
    }
    if (processed) {
      log.info?.(`[campaign] batch id=${campaign.id} admin=${session.adminId} processed=${processed} accepted=${tally.accepted} dry_run=${tally.dry_run} retry_later=${tally.retry_later} failed=${tally.failed} rejected=${tally.rejected} unresolved=${tally.unresolved} suppressed=${tally.suppressed} status=${campaign.status}`);
    }
    send(res, 200, {
      campaign, processed, tally, dry_run: dryRun, stopped, stop_message: stopMessage,
      next_delay_ms: campaign.status === 'sending' ? nextDelay : null,
    });
  }

  // Review-time warning: addresses an earlier campaign of this session
  // already sent to (Resend accepted). Empty when campaigns are unavailable.
  async function previouslySent(sessionId, emails) {
    if (!emails.length || !(await availability()).available) return [];
    return db.previouslyAccepted(sessionId, emails);
  }

  const ACTIONS = new Set(['start', 'pause', 'resume', 'cancel', 'complete', 'retry']);
  // Returns a handler for /api/campaigns… or null.
  function route(method, pathname) {
    if (pathname === '/api/campaigns') return { GET: list, POST: confirm }[method] ?? null;
    const m = /^\/api\/campaigns\/([^/]{1,64})(?:\/([a-z]+))?$/.exec(pathname);
    if (!m || m[1] === 'review') return null;
    const [, id, sub] = m;
    if (!sub) return method === 'GET' ? (req, res, url) => detail(req, res, url, id) : null;
    if (sub === 'recipients') return method === 'GET' ? (req, res, url) => recipients(req, res, url, id) : null;
    if (sub === 'process') return method === 'POST' ? (req, res, url) => process(req, res, url, id) : null;
    if (ACTIONS.has(sub)) return method === 'POST' ? (req, res, url) => action(req, res, url, id, sub) : null;
    return null;
  }

  // Review-time: rows whose address already opted out (skipped if confirmed).
  async function suppressedRows(recipients) {
    if (!recipients.length || !(await availability()).available) return [];
    const hit = new Set(await db.suppressedAmong(recipients.map((r) => suppressionHash(r.email))));
    return recipients.filter((r) => hit.has(suppressionHash(r.email))).map((r) => r.row);
  }

  // Whether a single (non-campaign) invitation may go to this address.
  async function isSuppressedAddress(email) {
    if (!(await availability()).available) return false;
    return db.isSuppressed(suppressionHash(email));
  }

  // What the review preview shows at the end of every campaign email.
  const previewFooter = (rendered) => addUnsubscribeFooter(rendered, unsubscribeUrl(config.appOrigin, 'preview'));

  return { route, availability, previouslySent, suppressedRows, isSuppressedAddress, previewFooter, decide, MAX_ATTEMPTS };
}
