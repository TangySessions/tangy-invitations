// Send-claim rules shared by the SQLite and PostgreSQL stores, so both make
// exactly the same decision about an existing send id.
//
// A send attempt is identified by its idempotency key. Before calling Resend
// the app must CLAIM the key (store.claimSend). Possible outcomes:
//   claimed         new row inserted as 'pending' — go ahead and send
//   reclaimed       an 'ambiguous' (or abandoned 'pending') row of the SAME
//                   attempt was atomically set back to 'pending' — send again
//                   with the same Idempotency-Key
//   rate_limited    new attempt refused by the per-admin limit (no row written)
//   done            the attempt already ended accepted / dry_run
//   in_progress     another request holds the claim right now
//   finished_error  the attempt already ended rejected / failed
//   mismatch        the key belongs to a different message
export const STALE_PENDING_MS = 2 * 60 * 1000;
export const RATE_WINDOW_MS = 10 * 60 * 1000;

// fp = { adminId, sessionId, email, subject, test, version }
export function sameAttempt(row, fp) {
  return Number(row.admin_id) === Number(fp.adminId)
    && row.session_id === fp.sessionId
    && row.recipient_email === fp.email
    && row.subject === fp.subject
    && Boolean(row.is_test) === Boolean(fp.test)
    && Number(row.template_version) === Number(fp.version);
}

// claimedAtMs: when the current 'pending' claim was taken. inFlight: the
// claim is known to be held by a live request in this process (SQLite).
export function existingDecision(row, fp, { nowMs, claimedAtMs, inFlight = false, staleMs = STALE_PENDING_MS }) {
  if (!sameAttempt(row, fp)) return 'mismatch';
  if (row.status === 'accepted' || row.status === 'dry_run') return 'done';
  if (row.status === 'rejected' || row.status === 'failed') return 'finished_error';
  if (row.status === 'pending' && (inFlight || nowMs - claimedAtMs < staleMs)) return 'in_progress';
  return 'reclaim'; // 'ambiguous', or a 'pending' claim abandoned for longer than staleMs
}
