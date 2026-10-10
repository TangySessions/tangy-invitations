// PostgreSQL connection settings shared by the app store, the migration
// runner and the admin CLI. Connection strings and CA certificates are kept
// out of anything that serializes the config, and never appear in logs or
// error messages.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SSL_PARAMS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'uselibpqcompat'];
const APP_NAME = 'tangy-invitations';

// Connection *startup* parameters node-postgres can send. Some poolers
// (e.g. Supavisor in transaction mode) may reject unknown startup
// parameters, so each can be switched off with PG_STARTUP_PARAMS. The two
// timeouts are ALSO applied with SET LOCAL inside every transaction (see
// src/store/postgres.js), so turning the startup versions off does not
// remove the limits on transactions.
export const STARTUP_PARAMS = Object.freeze(['application_name', 'statement_timeout', 'idle_in_transaction_session_timeout']);
export const TRANSACTION_POOLER_PORT = '6543';

// Validates a postgres:// URL and removes TLS parameters from it, so that
// DATABASE_SSL is the single, explicit TLS setting (node-postgres would
// otherwise let URL parameters override it).
export function parseDatabaseUrl(value, name) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${name} is not a valid postgres:// URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error(`${name} must start with postgres:// or postgresql://.`);
  if (!url.hostname) throw new Error(`${name} has no host.`);
  for (const p of SSL_PARAMS) url.searchParams.delete(p);
  return { url: url.toString(), host: url.hostname.toLowerCase(), port: url.port || '5432' };
}

// Migrations hold a session-level advisory lock and run several separate
// transactions on ONE server connection. A transaction pooler (Supabase
// Supavisor on port 6543, or any pgbouncer in transaction mode) may move
// each transaction to a different server connection, so the lock would not
// protect anything. Refuse such URLs before any connection is attempted.
export function assertSessionConnection(url, name = 'MIGRATION_DATABASE_URL') {
  const u = new URL(url);
  if (u.port === TRANSACTION_POOLER_PORT) {
    throw new Error(`${name} uses port ${TRANSACTION_POOLER_PORT}, a transaction pooler. Migrations need a session-preserving connection: the Supabase Session pooler or a direct connection (port 5432). Nothing was run.`);
  }
  if (/^(true|1)$/i.test(u.searchParams.get('pgbouncer') || '')) {
    throw new Error(`${name} is marked pgbouncer=true (transaction pooling). Migrations need a session-preserving connection. Nothing was run.`);
  }
}

const intIn = (v, def, min, max, name, hint = '') => {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}.${hint}`);
  return n;
};

// --------------------------------------------------------- CA certificates --
const CERT_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;
const MAX_PEM = 64 * 1024;

// Returns normalized PEM text (one or more certificates) or throws an error
// that never includes the input.
export function parseCaPem(raw, name, { now = Date.now() } = {}) {
  let text = String(raw ?? '').trim();
  // Accept the single-line form some dashboards produce ("\n" escapes).
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n').trim();
  if (!text) throw new Error(`${name} is empty.`);
  if (text.length > MAX_PEM) throw new Error(`${name} is too large to be a CA certificate bundle.`);
  if (/PRIVATE KEY/.test(text)) throw new Error(`${name} contains a private key. Provide only the CA certificate(s) — and treat that key as exposed.`);
  const blocks = text.match(CERT_BLOCK) || [];
  if (!blocks.length) throw new Error(`${name} does not contain a PEM certificate (-----BEGIN CERTIFICATE----- … -----END CERTIFICATE-----).`);
  if (text.replace(CERT_BLOCK, '').trim()) throw new Error(`${name} contains data other than PEM certificates.`);
  const certs = blocks.map((b) => {
    try { return new X509Certificate(b); } catch { throw new Error(`${name} contains a malformed certificate.`); }
  });
  if (certs.every((c) => Date.parse(c.validTo) < now)) throw new Error(`${name}: every certificate in it has expired.`);
  return `${blocks.join('\n')}\n`;
}

function loadCa(env, ssl) {
  const pem = env.DATABASE_SSL_CA_PEM;
  const file = String(env.DATABASE_SSL_CA || '').trim();
  const hasPem = pem !== undefined && String(pem).trim() !== '';
  if (hasPem && file) throw new Error('Set only one of DATABASE_SSL_CA_PEM (certificate contents) or DATABASE_SSL_CA (file path), not both.');
  if ((hasPem || file) && ssl !== 'verify') throw new Error('A CA certificate is configured but DATABASE_SSL is not "verify".');
  if (hasPem) return { ca: parseCaPem(pem, 'DATABASE_SSL_CA_PEM'), source: 'env' };
  if (file) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { throw new Error('DATABASE_SSL_CA: the certificate file could not be read.'); }
    return { ca: parseCaPem(text, 'DATABASE_SSL_CA'), source: 'file' };
  }
  return { ca: null, source: 'system' }; // Node's built-in trusted CAs
}

function startupParams(value) {
  const v = String(value ?? 'all').trim().toLowerCase();
  if (v === '' || v === 'all') return [...STARTUP_PARAMS];
  if (v === 'none') return [];
  const list = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((p) => !STARTUP_PARAMS.includes(p));
  if (bad.length || !list.length) throw new Error(`PG_STARTUP_PARAMS must be "all", "none", or a comma list of: ${STARTUP_PARAMS.join(', ')}.`);
  return [...new Set(list)];
}

// Reads DB_* settings. Returns { backend, ... }; URLs and the CA are
// non-enumerable. purpose:
//   'runtime' (the app)              DATABASE_URL required
//   'owner'   (migrations, admin CLI) MIGRATION_DATABASE_URL required;
//                                      DATABASE_URL not needed
export function loadDatabaseConfig(env, { purpose = 'runtime' } = {}) {
  if (purpose !== 'runtime' && purpose !== 'owner') throw new Error('Invalid database config purpose.');
  const backend = String(env.DB_BACKEND || 'sqlite').trim().toLowerCase();
  if (backend !== 'sqlite' && backend !== 'postgres') throw new Error('DB_BACKEND must be "sqlite" (default) or "postgres".');
  const db = { backend };
  if (backend !== 'postgres') return db;

  let runtime = null;
  let owner = null;
  if (purpose === 'runtime' && !env.DATABASE_URL) throw new Error('DB_BACKEND=postgres requires DATABASE_URL.');
  if (purpose === 'owner' && !env.MIGRATION_DATABASE_URL) throw new Error('This command needs MIGRATION_DATABASE_URL (the schema-owner connection).');
  if (env.DATABASE_URL) runtime = parseDatabaseUrl(env.DATABASE_URL, 'DATABASE_URL');
  if (env.MIGRATION_DATABASE_URL) owner = parseDatabaseUrl(env.MIGRATION_DATABASE_URL, 'MIGRATION_DATABASE_URL');

  const ssl = String(env.DATABASE_SSL || 'verify').trim().toLowerCase();
  if (ssl !== 'verify' && ssl !== 'disable') throw new Error('DATABASE_SSL must be "verify" (default) or "disable".');
  // Certificate verification can only be turned off for a database on this machine.
  if (ssl === 'disable' && [runtime, owner].some((c) => c && !LOOPBACK.has(c.host))) {
    throw new Error('DATABASE_SSL=disable is only allowed for a database on localhost.');
  }
  const ca = loadCa(env, ssl);
  Object.assign(db, {
    ssl,
    sslCaSource: ca.source, // 'env' | 'file' | 'system' (not secret)
    poolMax: intIn(env.PG_POOL_MAX, 3, 1, 20, 'PG_POOL_MAX'),
    connectTimeoutMs: intIn(env.PG_CONNECT_TIMEOUT_MS, 5000, 500, 60_000, 'PG_CONNECT_TIMEOUT_MS'),
    queryTimeoutMs: intIn(env.PG_QUERY_TIMEOUT_MS, 15_000, 1000, 120_000, 'PG_QUERY_TIMEOUT_MS'),
    statementTimeoutMs: intIn(env.PG_STATEMENT_TIMEOUT_MS, 10_000, 1000, 120_000, 'PG_STATEMENT_TIMEOUT_MS',
      ' To stop sending it at connection time, use PG_STARTUP_PARAMS instead.'),
    idleInTxTimeoutMs: intIn(env.PG_IDLE_TX_TIMEOUT_MS, 15_000, 1000, 120_000, 'PG_IDLE_TX_TIMEOUT_MS'),
    startupParams: startupParams(env.PG_STARTUP_PARAMS),
  });
  Object.defineProperty(db, 'sslCa', { value: ca.ca, enumerable: false });
  if (runtime) Object.defineProperty(db, 'url', { value: runtime.url, enumerable: false });
  if (owner) Object.defineProperty(db, 'migrationUrl', { value: owner.url, enumerable: false });
  return db;
}

// node-postgres Pool/Client options. `url` picks which connection string.
export function poolOptions(db, url = db.url, { max = db.poolMax, startup = db.startupParams ?? STARTUP_PARAMS } = {}) {
  const send = new Set(startup);
  return {
    connectionString: url,
    ssl: db.ssl === 'verify' ? { rejectUnauthorized: true, ...(db.sslCa ? { ca: db.sslCa } : {}) } : false,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: db.connectTimeoutMs,
    query_timeout: db.queryTimeoutMs, // client-side limit on every query, always on
    ...(send.has('application_name') ? { application_name: APP_NAME } : {}),
    ...(send.has('statement_timeout') ? { statement_timeout: db.statementTimeoutMs } : {}),
    ...(send.has('idle_in_transaction_session_timeout') ? { idle_in_transaction_session_timeout: db.idleInTxTimeoutMs } : {}),
    allowExitOnIdle: true,
  };
}

// Error text safe for logs: never a connection string, password or PEM.
export function safeDbError(err) {
  const code = err?.code ? ` ${err.code}` : '';
  const msg = String(err?.message || '')
    .replace(/postgres(ql)?:\/\/\S+/gi, '<url>')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '<pem>')
    .replace(/password[^,;]*/gi, 'password <redacted>')
    .slice(0, 200);
  return `${err?.name || 'Error'}${code}: ${msg}`;
}
