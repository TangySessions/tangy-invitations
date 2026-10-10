// Unsubscribe links and the suppression list for campaign (invitation)
// emails.
//
// Token: base64url(HMAC-SHA256(key, "unsubscribe:" + send_id)), where key is
// derived from PREVIEW_TOKEN_SECRET (domain-separated). 256 bits, so it
// cannot be guessed, and the URL contains neither the address nor any
// database id. Only SHA-256(token) is stored (campaign_recipients
// .unsubscribe_hash); the token is recomputed when sending, so a retry sends
// a byte-identical email (required for Resend's idempotency) and nothing
// usable is kept at rest. Rotating PREVIEW_TOKEN_SECRET changes future
// tokens; links already sent keep working because they are looked up by hash.
//
// Endpoint (public — the token is the only credential):
//   GET  /api/unsubscribe/<token>   confirmation page; changes nothing (mail
//                                   scanners prefetch links)
//   POST /api/unsubscribe/<token>   body "List-Unsubscribe=One-Click" (RFC 8058,
//                                   also sent by the page's button): records
//                                   the opt-out. Idempotent.
// The opt-out is stored as SHA-256("tangy-suppression/v1:" + address) and
// skips that address in every campaign — checked again right before each
// provider request. Logs carry the campaign id only, never tokens or addresses.
import { createHmac, createHash } from 'node:crypto';

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
// Links stay valid for a year after the campaign was confirmed.
export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

export const unsubscribeKey = (previewSecret) => createHmac('sha256', previewSecret).update('tangy-unsubscribe-key/v1').digest();
export const unsubscribeToken = (key, sendId) => createHmac('sha256', key).update(`unsubscribe:${String(sendId).toLowerCase()}`).digest('base64url');
export const tokenHash = (token) => sha256hex(`tangy-unsubscribe/v1:${token}`);
export const suppressionHash = (email) => sha256hex(`tangy-suppression/v1:${String(email).trim().toLowerCase()}`);
export const unsubscribeUrl = (origin, token) => `${origin}/api/unsubscribe/${token}`;

// Same headers as the rest of the app (CSP etc. are set by the caller).
function page(res, status, title, body, { form = null } = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)} · Tangy Sessions</title></head>
<body style="margin:0;background:#111;color:#f5f5f5;font-family:Arial,Helvetica,sans-serif">
<main style="max-width:520px;margin:48px auto;padding:28px 24px;background:#080909;border:1px solid #282828;border-radius:16px">
<p style="margin:0 0 6px;color:#E8F13A;font-size:12px;font-weight:bold;letter-spacing:2px">TANGY SESSIONS</p>
<h1 style="margin:0 0 14px;font-size:24px">${esc(title)}</h1>
<p style="margin:0 0 18px;line-height:1.5;color:#ddd">${esc(body)}</p>
${form ? `<form method="post" action="${esc(form)}"><input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit" style="padding:12px 22px;border:0;border-radius:10px;background:#35D5BA;color:#07111D;font-weight:bold;font-size:14px;cursor:pointer">Unsubscribe</button></form>` : ''}
</main></body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.end(html);
}

export function createUnsubscribeRoute({ db, now, log }) {
  async function find(token) {
    if (!TOKEN_RE.test(token)) return { state: 'invalid' };
    if (!(await db.campaignsAvailable()).available) return { state: 'invalid' };
    const r = await db.findRecipientByUnsubscribeHash(tokenHash(token));
    if (!r) return { state: 'invalid' };
    if (now() - r.created_at > UNSUBSCRIBE_TTL_MS) return { state: 'expired', r };
    return { state: 'ok', r };
  }

  async function readSmallBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2048) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const INVALID = ['Link not valid', 'This unsubscribe link is not valid. If you copied it from an email, make sure the whole link was copied, or reply to the email to ask us to stop.'];
  const EXPIRED = ['Link expired', 'This unsubscribe link has expired. Reply to the email you received and we will stop sending you invitations.'];

  return async function handle(req, res, token) {
    const found = await find(token);
    if (found.state === 'invalid') return page(res, 404, ...INVALID);
    if (found.state === 'expired') return page(res, 410, ...EXPIRED);
    if (req.method === 'GET' || req.method === 'HEAD') {
      return page(res, 200, 'Unsubscribe from invitations?', 'Press the button to stop receiving Tangy Sessions invitation emails at this address.', { form: `/api/unsubscribe/${token}` });
    }
    // RFC 8058 one-click: "List-Unsubscribe=One-Click", form-urlencoded or multipart.
    const body = await readSmallBody(req);
    const oneClick = body != null && /List-Unsubscribe/.test(body) && /One-Click/.test(body);
    if (!oneClick) return page(res, 400, 'Not unsubscribed', 'The request was incomplete. Open the link from the email again and press the Unsubscribe button.');
    const source = /urlencoded/i.test(req.headers['content-type'] || '') && !req.headers.origin ? 'one_click' : 'link';
    const r = found.r;
    const out = await db.recordUnsubscribe({ emailHash: suppressionHash(r.email), email: r.email, campaignId: r.campaign_id, source, now: now() });
    log.info?.(`[unsubscribe] campaign=${r.campaign_id} new=${out.created} skipped_pending=${out.skipped}`);
    return page(res, 200, 'You are unsubscribed', 'This address will not receive Tangy Sessions invitation emails any more. Emails that were already on their way may still arrive.');
  };
}
