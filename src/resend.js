// Resend API client (https://resend.com/docs/api-reference). Plain fetch —
// no SDK dependency. The API key only ever goes into the Authorization header
// of requests to api.resend.com.
//
// sendViaResend() reports one of:
//   accepted   Resend returned 200 with a message id. This is ACCEPTANCE, not
//              delivery — delivery/bounce events arrive later in Resend.
//   rejected   Resend refused the message (4xx). Nothing was sent.
//   failed     The request never reached Resend (DNS/connection refused).
//   ambiguous  Timeout, dropped connection or 5xx: Resend may or may not have
//              accepted it. Never retried automatically. A manual retry reuses
//              the same Idempotency-Key, which Resend de-duplicates for 24 h.
//              `cause` says why: timeout | connection | server_error | no_id.

const MAX_PROVIDER_MESSAGE = 300;

const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function errorCode(err) {
  return err?.cause?.code || err?.code || '';
}

async function providerMessage(res) {
  try {
    const body = await res.json();
    const msg = [body?.name, body?.message].filter(Boolean).join(': ');
    return msg.slice(0, MAX_PROVIDER_MESSAGE);
  } catch {
    return '';
  }
}

export async function sendViaResend({ email, message, idempotencyKey, fetchImpl = fetch }) {
  const body = {
    from: email.senderRaw,
    to: [message.to], // exactly one recipient; no cc/bcc ever
    subject: message.subject,
    html: message.html,
    ...(message.text ? { text: message.text } : {}),
    ...(email.replyTo ? { reply_to: email.replyTo } : {}),
    ...(message.headers ? { headers: message.headers } : {}),
    tags: [
      { name: 'source', value: 'custom_email_sender' },
      { name: 'kind', value: message.test ? 'test' : (message.campaignId ? 'campaign' : 'live') },
      ...(message.sessionId ? [{ name: 'session', value: message.sessionId }] : []),
      ...(message.campaignId ? [{ name: 'campaign', value: message.campaignId }] : []),
    ],
  };
  let res;
  try {
    res = await fetchImpl(`${email.apiBase}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${email.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(email.timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    if (NOT_SENT_CODES.has(errorCode(err))) {
      return { status: 'failed', error: 'Could not connect to Resend. Nothing was sent — check the server\'s network and try again.' };
    }
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'ambiguous',
      cause: timeout ? 'timeout' : 'connection',
      error: timeout
        ? 'Resend did not answer in time. The email may or may not have been accepted — check the Resend dashboard (Emails) before retrying.'
        : 'The connection to Resend was interrupted. The email may or may not have been accepted — check the Resend dashboard (Emails) before retrying.',
    };
  }

  if (res.ok) {
    let id = null;
    try { id = (await res.json())?.id ?? null; } catch { /* handled below */ }
    if (typeof id === 'string' && id) return { status: 'accepted', id };
    return { status: 'ambiguous', cause: 'no_id', error: 'Resend answered without a message id. Check the Resend dashboard before retrying.' };
  }
  const detail = await providerMessage(res);
  if (res.status >= 500) {
    return { status: 'ambiguous', cause: 'server_error', error: `Resend returned a server error (${res.status}). The outcome is uncertain — check the Resend dashboard before retrying.` };
  }
  const hints = {
    401: 'The Resend API key is missing or invalid (check RESEND_API_KEY on the server).',
    403: 'Resend refused this sender — the domain in EMAIL_FROM is probably not verified, or the key cannot send from it.',
    422: 'Resend rejected the message as invalid.',
    429: 'Resend rate limit reached. Wait a minute and send again.',
    409: 'Resend reported an idempotency conflict for this send.',
  };
  return {
    status: 'rejected',
    httpStatus: res.status,
    error: [hints[res.status] || `Resend rejected the message (${res.status}).`, detail && `Resend says: ${detail}`].filter(Boolean).join(' '),
  };
}

// Is the EMAIL_FROM domain verified in Resend? Needs a full-access key; a
// sending-only key gets 401/403 here and the state is reported as unknown
// (Resend still refuses unverified senders at send time).
export async function checkSenderDomain({ email, fetchImpl = fetch }) {
  if (!email.apiKey || !email.sender) return { state: 'unknown', message: 'Sender not configured.' };
  try {
    const res = await fetchImpl(`${email.apiBase}/domains`, {
      headers: { Authorization: `Bearer ${email.apiKey}` },
      signal: AbortSignal.timeout(email.timeoutMs),
      redirect: 'error',
    });
    if (res.status === 401 || res.status === 403) {
      return { state: 'unknown', message: 'This API key cannot list domains (sending-only key). Confirm the domain is verified in the Resend dashboard → Domains.' };
    }
    if (!res.ok) return { state: 'unknown', message: `Could not check domains (Resend ${res.status}).` };
    const list = (await res.json())?.data ?? [];
    const domain = email.sender.domain;
    const match = list.find((d) => String(d?.name).toLowerCase() === domain);
    if (!match) return { state: 'not_verified', message: `${domain} is not added to this Resend account.` };
    if (match.status === 'verified') return { state: 'verified', message: `${domain} is verified in Resend.` };
    return { state: 'not_verified', message: `${domain} is in Resend but its status is "${match.status}", not verified.` };
  } catch {
    return { state: 'unknown', message: 'Could not reach Resend to check the sender domain.' };
  }
}
