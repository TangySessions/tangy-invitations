// Vercel adapter. A single serverless function (api/handler.js) runs the
// same createApp() handler as the local Node server (src/server.js), so
// routes, responses, body limits, sessions, CSRF/origin checks and security
// headers are identical. Static files (public/) are served by Vercel's CDN,
// with the same security headers configured in vercel.json.
//
// Per function instance, configuration, the database pool and the app are
// initialized once (on the first request) and reused. If initialization
// fails — bad configuration or an unreachable database — the request gets a
// generic 503 (no details, no secrets), nothing falls back to SQLite, and
// the next request tries again. The adapter only ever runs with
// DB_BACKEND=postgres, even where the VERCEL variable is absent.
import { loadConfig } from './config.js';
import { openStore } from './store/index.js';
import { createApp, SECURITY_HEADERS } from './app.js';
import { safeDbError } from './store/pgConfig.js';

export const FUNCTION_PATH = '/api/handler';
// One or more path segments of unreserved characters or %-escapes.
const ROUTE_RE = /^[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*$/;

// Returns the app URL (/api/…?query) for an incoming request URL, or null.
// Vercel may deliver either
//   /api/sessions/s1?x=1                 the original request URL, or
//   /api/handler?route=sessions/s1&x=1   the rewrite destination (vercel.json).
export function resolveApiUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl || '/', 'http://local');
  } catch {
    return null;
  }
  if (u.pathname === FUNCTION_PATH) {
    const route = u.searchParams.get('route');
    u.searchParams.delete('route');
    if (!route || route.length > 200 || !ROUTE_RE.test(route) || route.split('/').some((seg) => seg === '.' || seg === '..')) return null;
    const qs = u.searchParams.toString();
    return `/api/${route}${qs ? `?${qs}` : ''}`;
  }
  if (u.pathname.startsWith('/api/') && u.pathname.length > 5) return `${u.pathname}${u.search}`;
  return null;
}

function reply(res, status, body) {
  for (const [name, value] of SECURITY_HEADERS) res.setHeader(name, value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Options are for tests; the deployed function uses the defaults.
export function createVercelHandler({ env = process.env, openStoreImpl = openStore, fetchImpl, now, log = console } = {}) {
  let ready = null;

  async function init() {
    const config = loadConfig(env); // on Vercel: production rules, PostgreSQL required
    // Independent of platform detection: a serverless function must never
    // open (or create) a SQLite file — its filesystem is not persistent.
    if (config.database.backend !== 'postgres') {
      throw new Error('The serverless adapter requires DB_BACKEND=postgres (SQLite needs a persistent disk; use the Node server for it).');
    }
    const store = await openStoreImpl(config, { log, ...(now ? { now } : {}) });
    const app = createApp({
      config, db: store.db, loginLimiter: store.loginLimiter, log, serveStatic: false,
      ...(fetchImpl ? { fetchImpl } : {}), ...(now ? { now } : {}),
    });
    log.info?.(`[vercel] ready: backend=${store.backend} limiter=${store.backend === 'postgres' ? 'shared' : 'in-process'}`);
    return { app, store, config };
  }

  return async function vercelHandler(req, res) {
    const url = resolveApiUrl(req.url);
    if (!url) return reply(res, 404, { error: 'Not found.' });
    let ctx;
    try {
      ready ??= init();
      ctx = await ready;
    } catch (err) {
      ready = null; // retry on the next request
      log.error?.(`[vercel] startup failed: ${safeDbError(err)}`);
      return reply(res, 503, { error: 'The service is not available right now (configuration or database). Nothing was changed.' });
    }
    req.url = url;
    return ctx.app(req, res);
  };
}
