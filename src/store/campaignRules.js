// Campaign rules shared by the SQLite and PostgreSQL stores (the schemas —
// migrations/postgres/0002_campaigns.sql and the SQLite v3 schema in
// src/db.js — enforce the same rules again with checks and triggers).

export const RECIPIENT_STATUSES = Object.freeze(['pending', 'claimed', 'accepted', 'rejected', 'failed', 'unresolved', 'skipped', 'dry_run']);
export const CAMPAIGN_STATUSES = Object.freeze(['confirmed', 'sending', 'paused', 'completed', 'cancelled']);
export const STOP_REASONS = Object.freeze(['admin', 'template_changed', 'session_inactive', 'provider_rate_limited', 'provider_unavailable', 'sender_not_verified', 'error']);
// Hard ceiling on provider requests per recipient (also a database check).
export const MAX_ATTEMPTS = 10;

// Admin/worker actions on a campaign: which statuses they apply to and what
// they set. Every update is a compare-and-swap on the current status.
export const CAMPAIGN_ACTIONS = Object.freeze({
  start: { from: ['confirmed'], to: 'sending' },
  pause: { from: ['sending'], to: 'paused' },
  resume: { from: ['paused'], to: 'sending' },
  cancel: { from: ['confirmed', 'sending', 'paused'], to: 'cancelled' },
  complete: { from: ['sending'], to: 'completed' },
});

// Counts per status, plus `suppressed`: the skipped recipients whose
// address opted out (a subset of `skipped`, not an extra status).
export const emptyCounts = () => ({ ...Object.fromEntries(RECIPIENT_STATUSES.map((s) => [s, 0])), suppressed: 0 });

export function countsFrom(rows) {
  const counts = emptyCounts();
  for (const r of rows) {
    if (Object.hasOwn(counts, r.status)) counts[r.status] = Number(r.n);
    if (r.status === 'skipped') counts.suppressed += Number(r.sup || 0);
  }
  return counts;
}
