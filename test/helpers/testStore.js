// Test storage factory. SQLite by default; with TEST_DB_BACKEND=postgres
// (set by .env.pgtest after `npm run pg:test:up`) every store is a fresh
// database on the disposable local container, created from a migrated
// template, and the app connects as a real least-privilege runtime role
// (member of mailer_runtime). Admin-account helpers go through the owner
// connection, as the admin CLI does in production.
import { createHash, randomBytes } from 'node:crypto';
import { openDb } from '../../src/db.js';

export const PG = process.env.TEST_DB_BACKEND === 'postgres';

// These helpers create and drop whole databases and roles, so they may only
// ever talk to the disposable container from `npm run pg:test:up`, which
// listens on 127.0.0.1. Anything else (e.g. a Supabase URL pasted into
// .env.pgtest) is refused before any connection is made.
export function assertLocalTestUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Error('PG_TEST_URL is not a valid postgres:// URL. Run: npm run pg:test:up'); }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    throw new Error('PG_TEST_URL must point at the local disposable test database (127.0.0.1). Refusing to run PostgreSQL tests against another host.');
  }
  if (u.searchParams.has('host')) throw new Error('PG_TEST_URL must not override the host with a query parameter.');
}
if (PG && process.env.PG_TEST_URL) assertLocalTestUrl(process.env.PG_TEST_URL);
const RUNTIME_ROLE = 'tangy_runtime_test';

let pgMod;
let tplPromise;
const urlFor = (base, database, user, password) => {
  const u = new URL(base);
  u.pathname = `/${database}`;
  if (user) { u.username = user; u.password = password; }
  return u.toString();
};
const runtimePassword = () => createHash('sha256').update(`${process.env.PG_TEST_URL}|runtime`).digest('base64url');
export const pgTestDbConfig = {
  backend: 'postgres', ssl: 'disable', sslCaSource: 'system', poolMax: 2, connectTimeoutMs: 3000, queryTimeoutMs: 15_000,
  statementTimeoutMs: 10_000, idleInTxTimeoutMs: 15_000, startupParams: ['application_name', 'statement_timeout', 'idle_in_transaction_session_timeout'],
};

async function adminQuery(sql, params) {
  const client = new pgMod.Client({ connectionString: process.env.PG_TEST_URL });
  await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}

// Once per test process: a migrated template database + the runtime login
// role. Node runs test files as parallel processes, and roles are
// cluster-wide, so this setup is serialized across processes with an
// advisory lock held on the container's admin database.
async function template() {
  tplPromise ??= (async () => {
    if (!process.env.PG_TEST_URL) throw new Error('PG_TEST_URL is not set. Run: npm run pg:test:up');
    pgMod = (await import('pg')).default;
    const { migrate } = await import('../../src/store/pgMigrate.js');
    const name = `tangy_tpl_${process.pid}_${randomBytes(3).toString('hex')}`;
    const admin = new pgMod.Client({ connectionString: process.env.PG_TEST_URL });
    await admin.connect();
    try {
      await admin.query('select pg_advisory_lock(424242)');
      await admin.query(`create database ${name}`);
      const owner = new pgMod.Client({ connectionString: urlFor(process.env.PG_TEST_URL, name) });
      await owner.connect();
      try { await migrate(owner); } finally { await owner.end(); }
      await admin.query(`do $$ begin create role ${RUNTIME_ROLE} login; exception when duplicate_object then null; end $$`);
      await admin.query(`alter role ${RUNTIME_ROLE} password '${runtimePassword()}'`);
      await admin.query(`grant mailer_runtime to ${RUNTIME_ROLE}`);
    } finally {
      await admin.query('select pg_advisory_unlock(424242)').catch(() => {});
      await admin.end();
    }
    return name;
  })();
  return tplPromise;
}

const createdDbs = new Set();
// A database per key: ':memory:' → brand new; any other key (e.g. a temp
// dir used by "restart" tests) → the same database every time.
export async function pgDatabase(key = ':memory:') {
  const tpl = await template();
  const name = key === ':memory:'
    ? `tangy_t_${randomBytes(6).toString('hex')}`
    : `tangy_k_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  if (!createdDbs.has(name)) {
    await adminQuery(`create database ${name} template ${tpl}`).catch((err) => { if (err.code !== '42P04') throw err; });
    createdDbs.add(name);
  }
  return {
    name,
    ownerUrl: urlFor(process.env.PG_TEST_URL, name),
    runtimeUrl: urlFor(process.env.PG_TEST_URL, name, RUNTIME_ROLE, runtimePassword()),
  };
}

// An empty database (no schema) for migration tests.
export async function emptyPgDatabase() {
  await template(); // ensures pg is loaded and the cluster is set up
  const name = `tangy_e_${randomBytes(6).toString('hex')}`;
  await adminQuery(`create database ${name}`);
  createdDbs.add(name);
  return { name, ownerUrl: urlFor(process.env.PG_TEST_URL, name) };
}

export async function dropDatabase(name) {
  await adminQuery(`drop database if exists ${name} with (force)`);
  createdDbs.delete(name);
}

// { db, loginLimiter, close, info } — loginLimiter is undefined for SQLite
// (the app then uses MemoryLoginLimiter, as in production SQLite mode).
// schema: the PostgreSQL schema version for this test database. The template
// is at the APPROVED version (1); campaign tests ask for 2, which applies
// 0002 to this disposable database only (explicit target, as in
// test/pg/campaigns.test.js). SQLite always has the campaign tables.
export async function makeTestStore({ dataDir = ':memory:', now = Date.now, schema = 1 } = {}) {
  if (!PG) return { db: openDb(dataDir), loginLimiter: undefined, close: async () => {} };
  const { openPgStore } = await import('../../src/store/postgres.js');
  const info = await pgDatabase(dataDir);
  if (schema > 1) {
    const { migrate } = await import('../../src/store/pgMigrate.js');
    const c = new pgMod.Client({ connectionString: info.ownerUrl });
    await c.connect();
    try { await migrate(c, { target: schema }); } finally { await c.end(); }
  }
  const runtime = await openPgStore(pgTestDbConfig, { url: info.runtimeUrl, now, log: { error() {}, info() {} } });
  const owner = await openPgStore({ ...pgTestDbConfig, poolMax: 1 }, { url: info.ownerUrl, now, log: { error() {}, info() {} } });
  await runtime.assertSchema();
  let closed = false;
  // A fresh (':memory:') database is dropped again on close, so test runs do
  // not pile up databases in the container's RAM-backed storage.
  const close = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
    await owner.close();
    if (dataDir === ':memory:') await dropDatabase(info.name).catch(() => {});
  };
  const db = {
    ...runtime,
    // Account management uses the owner, like scripts/admin.js.
    createAdmin: owner.createAdmin,
    setAdminPassword: owner.setAdminPassword,
    setAdminDisabled: owner.setAdminDisabled,
    close,
  };
  return { db, loginLimiter: runtime.createLoginLimiter({ now }), close, info, runtime, owner };
}
