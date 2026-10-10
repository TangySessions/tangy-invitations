// Versioned PostgreSQL migrations (migrations/postgres/NNNN_name.sql).
//
// Run with the OWNER connection only (MIGRATION_DATABASE_URL). Each file is
// applied in its own transaction and recorded in mailer.schema_migrations
// with a SHA-256 checksum; an applied file that has since changed stops the
// run. A session advisory lock keeps two runners from overlapping.
//
// Approval gate: a migration file can exist (for review and local tests)
// before it is approved for real databases. migrate() applies files only up
// to APPROVED_MIGRATION_VERSION unless a caller passes an explicit target —
// only the disposable test databases do. Raising this constant is the
// reviewed, deliberate step that lets scripts/db-migrate.js apply a new file.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'postgres');
const LOCK_KEY = 7_302_154_011; // arbitrary constant for pg_advisory_lock
export const APPROVED_MIGRATION_VERSION = 1; // 0002_campaigns is proposed, not approved

export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: Number(file.slice(0, 4)), name: file.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

// client: a connected pg.Client (owner role). Returns { applied: [...names], current, held: [...names] }
// where `held` lists files above the target that were deliberately not applied.
export async function migrate(client, { dir = MIGRATIONS_DIR, log = () => {}, target = APPROVED_MIGRATION_VERSION } = {}) {
  if (!Number.isSafeInteger(target) || target < 0) throw new Error('Migration target must be a whole number.');
  const migrations = listMigrations(dir);
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    await client.query('create schema if not exists mailer');
    await client.query(`create table if not exists mailer.schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz not null default now())`);
    const { rows } = await client.query('select version, name, checksum from mailer.schema_migrations order by version');
    const done = new Map(rows.map((r) => [r.version, r]));
    for (const r of rows) {
      const m = migrations.find((x) => x.version === r.version);
      if (!m) throw new Error(`Database has migration ${r.name}, which is not in ${dir}. Refusing to continue.`);
      if (m.checksum !== r.checksum) throw new Error(`Migration ${r.name} was changed after it was applied (checksum mismatch). Add a new migration instead.`);
    }
    const applied = [];
    const held = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      if (m.version > target) {
        held.push(m.name);
        log(`not applied: ${m.name} (above the approved version ${target})`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(m.sql);
        await client.query('insert into mailer.schema_migrations (version, name, checksum) values ($1, $2, $3)', [m.version, m.name, m.checksum]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      }
      applied.push(m.name);
      log(`applied ${m.name}`);
    }
    const { rows: [cur] } = await client.query('select coalesce(max(version), 0)::int as v from mailer.schema_migrations');
    return { applied, current: cur.v, held };
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

// Read-only: what `migrate` would do, without locking, creating or writing
// anything. Returns { current, applied, pending, held, problems }.
export async function planMigrations(client, { dir = MIGRATIONS_DIR, target = APPROVED_MIGRATION_VERSION } = {}) {
  const migrations = listMigrations(dir);
  const { rows: [{ present }] } = await client.query("select to_regclass('mailer.schema_migrations') is not null as present");
  const rows = present ? (await client.query('select version, name, checksum from mailer.schema_migrations order by version')).rows : [];
  const problems = [];
  for (const r of rows) {
    const m = migrations.find((x) => x.version === r.version);
    if (!m) problems.push(`database has ${r.name}, which is not in the migrations folder`);
    else if (m.checksum !== r.checksum) problems.push(`${r.name} was changed after it was applied (checksum mismatch)`);
  }
  const done = new Set(rows.map((r) => r.version));
  const todo = migrations.filter((m) => !done.has(m.version));
  return {
    current: rows.length ? Math.max(...rows.map((r) => r.version)) : 0,
    applied: rows.map((r) => r.name),
    pending: todo.filter((m) => m.version <= target).map((m) => m.name),
    held: todo.filter((m) => m.version > target).map((m) => m.name),
    problems,
  };
}

// Validates the owner configuration, refuses connections that cannot hold a
// session (transaction pooler), and only then connects and migrates.
// createClient is injectable for tests; it is never called when validation
// fails. Error messages never contain connection strings.
// plan: true only reads (planMigrations) — nothing is locked or written.
export async function runMigrations({ env = process.env, createClient, log = () => {}, plan = false } = {}) {
  const { loadDatabaseConfig, poolOptions, assertSessionConnection } = await import('./pgConfig.js');
  const db = loadDatabaseConfig(env, { purpose: 'owner' });
  if (db.backend !== 'postgres') throw new Error('Set DB_BACKEND=postgres to run PostgreSQL migrations.');
  assertSessionConnection(db.migrationUrl, 'MIGRATION_DATABASE_URL');
  const opts = poolOptions(db, db.migrationUrl, { max: 1 });
  delete opts.max;
  delete opts.statement_timeout; // DDL may legitimately take longer than the app's limit
  const make = createClient ?? (async (o) => new (await import('pg')).default.Client(o));
  const client = await make({ ...opts, query_timeout: 120_000 });
  await client.connect();
  try {
    return plan ? await planMigrations(client) : await migrate(client, { log });
  } finally {
    await client.end().catch(() => {});
  }
}
