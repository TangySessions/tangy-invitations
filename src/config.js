// Reads configuration from the environment. Secrets (RESEND_API_KEY,
// PREVIEW_TOKEN_SECRET) stay in this server process: they are never written to
// the database, sent to the browser, or logged.
import { randomBytes } from 'node:crypto';
import { loadDatabaseConfig } from './store/pgConfig.js';

export function parseSender(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  const named = /^(?:"?([^"<>\r\n]*?)"?\s*)<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/.exec(v);
  if (named) return { display: v, name: named[1].trim(), address: named[2].toLowerCase(), domain: named[2].split('@')[1].toLowerCase() };
  if (/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(v)) return { display: v, name: '', address: v.toLowerCase(), domain: v.split('@')[1].toLowerCase() };
  return null;
}

// PREVIEW_TOKEN_SECRET signs preview tokens (HMAC-SHA256). Every app
// instance that should accept each other's previews must share it.
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
export const PREVIEW_SECRET_MIN_LENGTH = 32;
// Words of 6+ letters only, so a genuinely random value essentially never matches.
const PLACEHOLDER_WORDS = /change.?me|replace|example|placeholder|secret|password|your.?(own|secret|key)/i;

// Returns an error message (never containing the value) or null.
export function previewSecretProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'PREVIEW_TOKEN_SECRET is not set.';
  if (value !== value.trim() || /\s/.test(value)) return 'PREVIEW_TOKEN_SECRET must not contain spaces.';
  if (value.length < PREVIEW_SECRET_MIN_LENGTH) return `PREVIEW_TOKEN_SECRET is too short (at least ${PREVIEW_SECRET_MIN_LENGTH} characters).`;
  if (new Set(value).size < 12) return 'PREVIEW_TOKEN_SECRET is too repetitive to be a random secret.';
  if (PLACEHOLDER_WORDS.test(value)) return 'PREVIEW_TOKEN_SECRET looks like a placeholder, not a random secret.';
  return null;
}

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

// Strict booleans: case-insensitive, surrounding spaces ignored. Anything
// else is an error — a typo must never be read as "off".
export const BOOLEAN_TRUE = Object.freeze(['true', '1', 'yes', 'on']);
export const BOOLEAN_FALSE = Object.freeze(['false', '0', 'no', 'off']);
const parseBoolean = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return undefined;
  if (BOOLEAN_TRUE.includes(s)) return true;
  if (BOOLEAN_FALSE.includes(s)) return false;
  return null;
};

// EMAIL_DRY_RUN fails closed:
//   - a value that isn't one of the accepted words stops startup (everywhere);
//   - missing/empty stops startup in production, where the intent must be
//     explicit, and means dry run (Resend never called) everywhere else.
// Real sending happens only with an explicit false value.
export function parseDryRun(value, { production }) {
  const parsed = parseBoolean(value);
  if (parsed === null) {
    throw new Error(`EMAIL_DRY_RUN must be one of ${BOOLEAN_TRUE.join('/')} (dry run) or ${BOOLEAN_FALSE.join('/')} (real sending).`);
  }
  if (parsed === undefined) {
    if (production) throw new Error('EMAIL_DRY_RUN must be set explicitly in production: "true" (dry run) or "false" (real sending).');
    return { dryRun: true, source: 'default' };
  }
  return { dryRun: parsed, source: 'env' };
}

// Whole numbers only ("30", not "30.5", "3e1" or "0x1e"). Missing/empty →
// the documented default; anything else outside [min, max] stops startup.
export function parseIntSetting(name, value, { def, min, max }) {
  const s = String(value ?? '').trim();
  if (s === '') return def;
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max} (default ${def}).`);
  }
  return Number(s);
}
export const SEND_LIMIT_RANGE = Object.freeze({ def: 30, min: 1, max: 1000 });
// Upper bound stays below Vercel's 30 s function limit (vercel.json maxDuration).
export const RESEND_TIMEOUT_RANGE = Object.freeze({ def: 15_000, min: 1000, max: 25_000 });
// Campaign pacing: provider requests per second (Resend's default team limit is 2/s).
export const RESEND_RATE_RANGE = Object.freeze({ def: 2, min: 1, max: 10 });
// Templates with embedded (data:) images. The imported HTML may be much
// larger than a stored template: its images are moved to the asset store on
// save and replaced by URLs (src/assets.js). Vercel caps request bodies at
// 4.5 MB, so the default import size stays below that.
const MB = 1024 * 1024;
export const TEMPLATE_IMPORT_RANGE = Object.freeze({ def: 4 * MB, min: MB, max: 20 * MB });
export const ASSET_IMAGE_RANGE = Object.freeze({ def: 5 * MB, min: 64 * 1024, max: 10 * MB });
export const ASSET_TOTAL_RANGE = Object.freeze({ def: 15 * MB, min: MB, max: 50 * MB });
export const ASSET_COUNT_RANGE = Object.freeze({ def: 50, min: 1, max: 200 });
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

// Where embedded images are hosted (src/assets.js):
//   local     DATA_DIR/assets, served by this app at /api/assets/… — local
//             development and dry runs only (default outside production)
//   supabase  a public Supabase Storage bucket (SUPABASE_URL,
//             SUPABASE_STORAGE_KEY, SUPABASE_STORAGE_BUCKET)
//   none      embedded images are refused (default in production)
function loadAssetStore(env, { production, vercel }) {
  const kind = String(env.ASSET_STORE ?? '').trim().toLowerCase() || (production ? 'none' : 'local');
  if (!['local', 'supabase', 'none'].includes(kind)) throw new Error('ASSET_STORE must be "local", "supabase" or "none".');
  if (kind === 'local' && (production || vercel)) {
    throw new Error('ASSET_STORE=local is for local development only (its files are served from this machine). In production use ASSET_STORE=supabase.');
  }
  if (kind !== 'supabase') return { kind };
  let url;
  try { url = new URL(String(env.SUPABASE_URL || '')); } catch { throw new Error('ASSET_STORE=supabase needs SUPABASE_URL (https://<project>.supabase.co).'); }
  if (url.protocol !== 'https:') throw new Error('SUPABASE_URL must use https.');
  const key = String(env.SUPABASE_STORAGE_KEY || '').trim();
  if (!key) throw new Error('ASSET_STORE=supabase needs SUPABASE_STORAGE_KEY (server-side secret; never sent to the browser).');
  const bucket = String(env.SUPABASE_STORAGE_BUCKET || '').trim();
  if (!BUCKET_RE.test(bucket)) throw new Error('SUPABASE_STORAGE_BUCKET must be a bucket name (lower-case letters, digits, . _ -).');
  const store = { kind, url: url.origin, bucket };
  Object.defineProperty(store, 'key', { value: key, enumerable: false }); // never serialized or logged
  return store;
}

// Vercel sets VERCEL=1 and VERCEL_ENV=production|preview|development. Any
// deployed Vercel environment (production or preview) runs with production
// rules, whatever NODE_ENV says.
export const onVercel = (env) => Boolean(env.VERCEL) && env.VERCEL_ENV !== 'development';

export function loadConfig(env = process.env) {
  const vercel = onVercel(env);
  const production = env.NODE_ENV === 'production' || vercel;
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid port number.');

  let appOrigin = null;
  if (env.APP_ORIGIN) {
    try {
      appOrigin = new URL(env.APP_ORIGIN).origin;
    } catch {
      throw new Error('APP_ORIGIN must be a URL such as https://mail.tangysessions.com');
    }
  }
  if (production && !appOrigin) throw new Error('APP_ORIGIN is required when NODE_ENV=production.');
  if (production && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use https in production.');
  appOrigin = appOrigin || `http://localhost:${port}`;

  // In development the app is reachable on both loopback names.
  const allowedOrigins = new Set([appOrigin]);
  if (!production) {
    const u = new URL(appOrigin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      allowedOrigins.add(`${u.protocol}//localhost${u.port ? `:${u.port}` : ''}`);
      allowedOrigins.add(`${u.protocol}//127.0.0.1${u.port ? `:${u.port}` : ''}`);
    }
  }

  // Preview-token key. Production: required and validated. Development:
  // a configured value is validated the same way; if none is set, a random
  // key is generated ONCE for this process (previews then stop working after
  // a restart and are not shared between processes).
  const rawSecret = env.PREVIEW_TOKEN_SECRET ?? '';
  let previewSecret;
  let previewSecretSource;
  if (rawSecret === '' && !production) {
    previewSecret = randomBytes(32);
    previewSecretSource = 'ephemeral';
  } else {
    const problem = previewSecretProblem(rawSecret);
    if (problem) throw new Error(`${problem} Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`);
    previewSecret = Buffer.from(rawSecret, 'utf8');
    previewSecretSource = 'env';
  }

  const senderRaw = (env.EMAIL_FROM || '').trim();
  const sender = parseSender(senderRaw);
  // Optional; when set it must be valid (never silently dropped).
  const replyTo = (env.EMAIL_REPLY_TO || '').trim();
  if (replyTo && !parseSender(replyTo)) throw new Error('EMAIL_REPLY_TO must be an email address or "Name <address>" (or left empty).');
  const sendLimitPer10Min = parseIntSetting('SEND_LIMIT_PER_10_MIN', env.SEND_LIMIT_PER_10_MIN, SEND_LIMIT_RANGE);
  const timeoutMs = parseIntSetting('RESEND_TIMEOUT_MS', env.RESEND_TIMEOUT_MS, RESEND_TIMEOUT_RANGE);
  const ratePerSecond = parseIntSetting('RESEND_RATE_LIMIT_PER_SECOND', env.RESEND_RATE_LIMIT_PER_SECOND, RESEND_RATE_RANGE);
  const assets = {
    store: loadAssetStore(env, { production, vercel }),
    maxImportBytes: parseIntSetting('TEMPLATE_IMPORT_MAX_BYTES', env.TEMPLATE_IMPORT_MAX_BYTES, TEMPLATE_IMPORT_RANGE),
    maxImageBytes: parseIntSetting('ASSET_MAX_IMAGE_BYTES', env.ASSET_MAX_IMAGE_BYTES, ASSET_IMAGE_RANGE),
    maxTotalBytes: parseIntSetting('ASSET_MAX_TOTAL_BYTES', env.ASSET_MAX_TOTAL_BYTES, ASSET_TOTAL_RANGE),
    maxImages: parseIntSetting('ASSET_MAX_IMAGES', env.ASSET_MAX_IMAGES, ASSET_COUNT_RANGE),
  };

  // Storage must be chosen deliberately in production, and SQLite can never
  // run on Vercel (its filesystem is not persistent). There is no fallback:
  // if PostgreSQL is selected and unavailable, startup fails.
  const database = loadDatabaseConfig(env);
  if (production && !String(env.DB_BACKEND || '').trim()) {
    throw new Error('DB_BACKEND must be set explicitly in production ("postgres", or "sqlite" on a host with a persistent disk).');
  }
  if (vercel && database.backend !== 'postgres') {
    throw new Error('On Vercel, DB_BACKEND must be "postgres": SQLite data would be lost because the function filesystem is not persistent.');
  }
  // Behind Vercel's proxy the socket address is the proxy, not the visitor:
  // without TRUST_PROXY every visitor would share one login-limiter IP.
  if (vercel && !truthy(env.TRUST_PROXY)) {
    throw new Error('On Vercel, TRUST_PROXY must be "true" so the login limiter sees each visitor\'s address (X-Forwarded-For set by Vercel).');
  }

  const { dryRun, source: dryRunSource } = parseDryRun(env.EMAIL_DRY_RUN, { production });

  const config = {
    production,
    platform: vercel ? 'vercel' : 'node',
    port,
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    appOrigin,
    allowedOrigins,
    secureCookies: appOrigin.startsWith('https://'),
    dataDir: env.DATA_DIR || './data',
    assets,
    // DB_BACKEND=sqlite (default in development) or postgres — never switched implicitly.
    database,
    trustProxy: truthy(env.TRUST_PROXY),
    sendLimitPer10Min,
    session: { idleMs: 2 * 60 * 60 * 1000, absoluteMs: 12 * 60 * 60 * 1000 },
    email: {
      apiKey: (env.RESEND_API_KEY || '').trim(),
      senderRaw,
      sender,
      replyTo,
      dryRun,
      dryRunSource,
      timeoutMs,
      ratePerSecond,
      apiBase: 'https://api.resend.com',
    },
    previewSecretSource,
  };
  // Not enumerable: JSON.stringify(config), util.inspect and spread copies
  // never include the key.
  Object.defineProperty(config, 'previewSecret', { value: previewSecret, enumerable: false });
  return config;
}

// Storage settings for the admin CLI (scripts/admin.js). It manages accounts
// with the schema OWNER connection, so in PostgreSQL mode it needs
// MIGRATION_DATABASE_URL but not DATABASE_URL, and none of the web-app
// settings (APP_ORIGIN, PREVIEW_TOKEN_SECRET, email). SQLite stays the
// default; selecting postgres never falls back to SQLite.
export function loadAdminCliConfig(env = process.env) {
  return { dataDir: env.DATA_DIR || './data', database: loadDatabaseConfig(env, { purpose: 'owner' }) };
}
