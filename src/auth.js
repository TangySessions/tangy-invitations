// Authentication for this standalone tool (it does not share Tangy World's
// Supabase accounts). Admin accounts exist only if someone with server access
// created them with `npm run admin:create`; there is no sign-up route.
//
//   passwords  scrypt (N=2^15, r=8, p=1), random 16-byte salt, constant-time compare
//   sessions   32 random bytes in an HttpOnly, SameSite=Strict cookie; only the
//              SHA-256 hash is stored; 2 h idle / 12 h absolute expiry
//   CSRF       every state-changing request must come from APP_ORIGIN, be JSON,
//              and (when signed in) carry the session's CSRF token header
//   brute force failed logins are limited per email and per IP
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
export const SESSION_COOKIE = 'tm_session';

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new Error(`Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > PASSWORD_MAX || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Used when the email is unknown so the response time doesn't reveal which
// admin emails exist.
let dummyHash = null;
export async function dummyVerify(password) {
  dummyHash ??= await hashPassword('x'.repeat(PASSWORD_MIN));
  await verifyPassword(String(password ?? ''), dummyHash);
  return false;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie({ secure }) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------------------
// Failed-login limiter
//
// Policy (unchanged): a fixed 15-minute window; sign-in is refused (429) once
// an email has 5 failures, or an IP address 20, inside the window. Emails are
// compared case-insensitively. A successful sign-in clears that email's
// counter (not the IP's). The check runs BEFORE the password is verified.
//
// Interface — every method returns a Promise, so a shared store can
// implement it without changing app.js:
//   isBlocked(email, ip)      → Promise<boolean>  (true = refuse with 429)
//   recordFailure(email, ip)  → Promise<void>     (the password was wrong)
//   recordSuccess(email, ip)  → Promise<void>     (signed in)
// A shared implementation may RESERVE the attempt inside isBlocked() (so
// concurrent requests cannot all pass the check) and release it in
// recordSuccess(); see PgLoginLimiter in src/store/postgres.js.
// A limiter that throws makes sign-in fail closed (500), never open.
//
// MemoryLoginLimiter keeps counts in this process only. It protects a single
// long-running server (the SQLite deployment) but NOT several instances: each
// would count separately and start from zero. PgLoginLimiter
// (src/store/postgres.js) is the shared implementation.
// ---------------------------------------------------------------------------
export const LOGIN_POLICY = Object.freeze({ perEmail: 5, perIp: 20, windowMs: 15 * 60 * 1000 });
export const LOGIN_LIMITER_METHODS = Object.freeze(['isBlocked', 'recordFailure', 'recordSuccess']);

// The counter keys any implementation should use.
export const limiterKeys = (email, ip) => ({ email: `e:${String(email).toLowerCase()}`, ip: `i:${ip}` });

export function assertLoginLimiter(limiter) {
  const missing = LOGIN_LIMITER_METHODS.filter((m) => typeof limiter?.[m] !== 'function');
  if (missing.length) throw new TypeError(`Login limiter is missing: ${missing.join(', ')}.`);
  return limiter;
}

export class MemoryLoginLimiter {
  #hits = new Map();
  constructor({ perEmail = LOGIN_POLICY.perEmail, perIp = LOGIN_POLICY.perIp, windowMs = LOGIN_POLICY.windowMs, now = Date.now, maxKeys = 10_000 } = {}) {
    Object.assign(this, { perEmail, perIp, windowMs, now, maxKeys });
  }
  #count(key) {
    const h = this.#hits.get(key);
    if (!h || this.now() - h.start > this.windowMs) return 0;
    return h.n;
  }
  async isBlocked(email, ip) {
    const k = limiterKeys(email, ip);
    return this.#count(k.email) >= this.perEmail || this.#count(k.ip) >= this.perIp;
  }
  async recordFailure(email, ip) {
    const k = limiterKeys(email, ip);
    for (const key of [k.email, k.ip]) {
      const h = this.#hits.get(key);
      if (!h || this.now() - h.start > this.windowMs) this.#hits.set(key, { start: this.now(), n: 1 });
      else h.n++;
    }
    // Memory bound (unchanged behaviour): forget everything past maxKeys.
    if (this.#hits.size > this.maxKeys) this.#hits.clear();
  }
  async recordSuccess(email, _ip) {
    this.#hits.delete(limiterKeys(email, '').email);
  }
}

// Previous name, kept so existing imports keep working.
export const LoginLimiter = MemoryLoginLimiter;
