// Production-readiness preflight (npm run preflight). Read-only by design:
//   - never prints secret values (only "set"/"missing");
//   - never contacts Resend (domain verification is a MANUAL check — it is
//     reported as unknown, never assumed);
//   - touches a database only with --db, and then only reads: SQLite is
//     opened read-only (never migrated), PostgreSQL gets one SELECT.
// Returns { lines: [{ level, area, text }], dryRunReady, liveReady, blockers }.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { APPROVED_MIGRATION_VERSION } from './store/pgMigrate.js';

export const SQLITE_CAMPAIGN_VERSION = 4; // src/db.js SCHEMA_VERSION with campaigns + suppression
export const PG_CAMPAIGN_VERSION = 2;     // migrations/postgres/0002_campaigns.sql

export const MANUAL_STEPS = Object.freeze([
  'Resend → Domains: the EMAIL_FROM domain shows "Verified" (DKIM and SPF/return-path records exactly as Resend lists them).',
  'DNS: a DMARC record exists at _dmarc.<domain> (start with p=none and a reporting address), aligned with the sending domain.',
  'Resend → API Keys: a sending-only production key is stored only in the host\'s secret settings.',
  'Resend account: note the plan\'s rate limit and daily/monthly quota; keep RESEND_RATE_LIMIT_PER_SECOND at or below it.',
  'EMAIL_REPLY_TO points at a monitored inbox (replies to noreply@ go nowhere).',
  'Send one real campaign to 1–3 internal addresses first; check Gmail and Outlook rendering, the unsubscribe link and the List-Unsubscribe button.',
]);

// domainConfirmed: the operator checked Resend → Domains by hand (--domain-verified).
export async function runPreflight({ env = process.env, checkDb = false, domainConfirmed = false, readSqliteVersion, readPgVersion } = {}) {
  const lines = [];
  const blockers = [];
  const add = (level, area, text) => lines.push({ level, area, text });
  const block = (text) => { blockers.push(text); };

  let config;
  try {
    config = loadConfig(env);
    add('pass', 'config', 'Configuration loads and passes startup validation.');
  } catch (err) {
    add('fail', 'config', `Configuration is invalid: ${err.message}`);
    block('fix the configuration error above');
    return { lines, dryRunReady: false, liveReady: false, blockers };
  }
  const e = config.email;

  // --- sending mode
  if (e.dryRun) {
    add('pass', 'email', `EMAIL_DRY_RUN is on (${e.dryRunSource === 'default' ? 'not set — dry run by default' : 'set explicitly'}): nothing is sent.`);
    block('EMAIL_DRY_RUN is on — set it to false explicitly, only after approval');
  } else {
    add('warn', 'email', 'EMAIL_DRY_RUN=false: real sending is ENABLED.');
  }
  // --- provider settings (values never shown)
  if (e.apiKey) add('pass', 'email', 'RESEND_API_KEY is set (value not shown).');
  else { add(e.dryRun ? 'info' : 'fail', 'email', 'RESEND_API_KEY is missing.'); block('RESEND_API_KEY is missing'); }
  if (e.sender) add('pass', 'email', `EMAIL_FROM is valid: ${e.sender.display} (domain ${e.sender.domain}).`);
  else { add('fail', 'email', e.senderRaw ? 'EMAIL_FROM is not a valid address or "Name <address>".' : 'EMAIL_FROM is missing.'); block('EMAIL_FROM is missing or invalid'); }
  if (e.replyTo) add('pass', 'email', `EMAIL_REPLY_TO is valid: ${e.replyTo}.`);
  else add('warn', 'email', 'EMAIL_REPLY_TO is not set: replies go to the sender address (noreply@ inboxes are usually not read).');
  add('pass', 'email', `RESEND_TIMEOUT_MS=${e.timeoutMs} (1000–25000) and RESEND_RATE_LIMIT_PER_SECOND=${e.ratePerSecond} (1–10).`);
  if (domainConfirmed) {
    add('info', 'email', 'Sender domain verification: confirmed MANUALLY by the operator (--domain-verified); not checked by this tool.');
  } else {
    add('info', 'email', 'Sender domain verification in Resend: UNKNOWN — not checked (this preflight never contacts Resend). Check it manually (below), then rerun with --domain-verified.');
    block('confirm the sender domain is verified in Resend (manual), then rerun with --domain-verified');
  }

  // --- public URLs and unsubscribe
  if (config.appOrigin.startsWith('https://')) add('pass', 'unsubscribe', `APP_ORIGIN uses https: unsubscribe links will be ${config.appOrigin}/api/unsubscribe/<token>.`);
  else { add(e.dryRun ? 'warn' : 'fail', 'unsubscribe', `APP_ORIGIN is ${config.appOrigin}: unsubscribe links would not work outside this machine. Real campaign sending is refused until it is https.`); block('APP_ORIGIN must be the public https address'); }
  if (config.previewSecretSource === 'env') add('pass', 'unsubscribe', 'PREVIEW_TOKEN_SECRET is set (value not shown): unsubscribe links stay valid across restarts and instances.');
  else { add('warn', 'unsubscribe', 'PREVIEW_TOKEN_SECRET is not set: a random key is used per process, so unsubscribe links would change on restart.'); block('set PREVIEW_TOKEN_SECRET'); }

  // --- database
  const backend = config.database.backend;
  add('info', 'database', `Backend: ${backend}.`);
  if (backend === 'postgres') {
    add(APPROVED_MIGRATION_VERSION >= PG_CAMPAIGN_VERSION ? 'pass' : 'warn', 'database',
      `APPROVED_MIGRATION_VERSION=${APPROVED_MIGRATION_VERSION}: migration 0002_campaigns (campaigns + unsubscribe) is ${APPROVED_MIGRATION_VERSION >= PG_CAMPAIGN_VERSION ? 'approved' : 'NOT approved'}.`);
    if (APPROVED_MIGRATION_VERSION < PG_CAMPAIGN_VERSION) block('approve and apply migration 0002 (campaigns + unsubscribe)');
  }
  if (!checkDb) {
    add('info', 'database', 'Schema version not checked (run with --db for a read-only check).');
    block('check the database schema version (--db)');
  } else {
    try {
      if (backend === 'postgres') {
        const v = await readPgVersion(config);
        const ok = v >= PG_CAMPAIGN_VERSION;
        add(ok ? 'pass' : 'warn', 'database', `PostgreSQL schema version ${v}: campaigns ${ok ? 'available' : `unavailable (needs ${PG_CAMPAIGN_VERSION})`}.`);
        if (!ok) block(`PostgreSQL schema version must be ${PG_CAMPAIGN_VERSION}`);
      } else {
        const file = join(resolve(config.dataDir), 'mailer.db');
        if (!existsSync(file)) {
          add('info', 'database', `SQLite file ${file} does not exist yet (created with the current schema on first start).`);
        } else {
          const v = readSqliteVersion(file);
          add(v >= SQLITE_CAMPAIGN_VERSION ? 'pass' : 'info', 'database', `SQLite schema version ${v}${v >= SQLITE_CAMPAIGN_VERSION ? ': campaigns and unsubscribe available' : `: upgraded to ${SQLITE_CAMPAIGN_VERSION} on the next start (backup first)`}.`);
        }
      }
    } catch (err) {
      add('fail', 'database', `Could not read the schema version: ${err.message}`);
      block('the database could not be checked');
    }
  }
  return { lines, dryRunReady: true, liveReady: blockers.length === 0, blockers };
}

export function formatPreflight(result) {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
  const out = ['Tangy Invitation Manager — production preflight (read-only: no email, no provider request, no secret values)', ''];
  for (const l of result.lines) out.push(`${tag[l.level].padEnd(4)}  [${l.area}] ${l.text}`);
  out.push('', `Ready for dry runs:      ${result.dryRunReady ? 'yes' : 'NO'}`);
  out.push(`Ready for real sending:  ${result.liveReady ? 'yes' : 'NO'}`);
  if (!result.liveReady) for (const b of result.blockers) out.push(`  - ${b}`);
  out.push('', 'Manual checks before the first real campaign (not verifiable from here):', ...MANUAL_STEPS.map((s, i) => `  ${i + 1}. ${s}`));
  return out.join('\n');
}
