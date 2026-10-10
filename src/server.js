import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { openStore } from './store/index.js';
import { createApp } from './app.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`[config] ${err.message}`);
  process.exit(1);
}

let store;
try {
  store = await openStore(config);
} catch (err) {
  // Messages from openStore never include connection strings.
  console.error(`[db] ${err.message}`);
  process.exit(1);
}
const server = createServer({ requestTimeout: 60_000, headersTimeout: 20_000 }, createApp({ config, db: store.db, loginLimiter: store.loginLimiter }));

server.listen(config.port, config.host, async () => {
  const e = config.email;
  console.log(`Tangy Invitation Sender on ${config.appOrigin} (listening ${config.host}:${config.port})`);
  console.log(`[db] backend=${store.backend}${store.backend === 'sqlite' ? ` dir=${config.dataDir}` : ' (connection details not logged)'}`);
  console.log(`[auth] login limiter: ${store.backend === 'postgres' ? 'shared (PostgreSQL)' : 'in-process (single server only)'}`);
  console.log(`[email] mode=${e.dryRun ? `dry-run (Resend is never called${e.dryRunSource === 'default' ? '; EMAIL_DRY_RUN not set' : ''})` : 'resend'} key=${e.apiKey ? 'set' : 'MISSING'} from=${e.sender ? e.sender.display : 'MISSING'}`);
  if (e.senderRaw && !e.sender) console.log('[email] EMAIL_FROM is not a valid "Name <address>" or address.');
  console.log(config.previewSecretSource === 'env'
    ? '[preview] signing key: PREVIEW_TOKEN_SECRET'
    : '[preview] signing key: random for this process only (set PREVIEW_TOKEN_SECRET to keep previews valid across restarts)');
  try {
    if ((await store.db.listAdmins()).length === 0) console.log('[auth] No admin accounts yet. Create one: npm run admin:create -- you@example.com');
  } catch { /* listing admins is informational only */ }
});

const shutdown = () => server.close(async () => { await store.close().catch(() => {}); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
