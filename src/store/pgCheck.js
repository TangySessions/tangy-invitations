// Read-only PostgreSQL connection check (scripts/db-check.js).
//
//   owner   MIGRATION_DATABASE_URL — refuses port 6543 like the migration
//           runner; reports owner rights needed by migration 0001.
//   runtime DATABASE_URL — reports role membership and table privileges
//           against what the app needs.
//
// It never writes: it only runs SELECT/SHOW statements, plus one transaction
// (SET LOCAL timeouts, a transaction-scoped advisory lock and a parameterized
// SELECT) that always ends in ROLLBACK. Output never contains connection
// strings or passwords.
import { loadDatabaseConfig, poolOptions, assertSessionConnection, safeDbError } from './pgConfig.js';

// What the runtime role must, and must not, be allowed to do (migration 0001).
export const RUNTIME_PRIVILEGES = Object.freeze({
  'mailer.admins': { allow: ['SELECT'], deny: ['INSERT', 'UPDATE', 'DELETE'] },
  'mailer.login_sessions': { allow: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], deny: [] },
  'mailer.session_templates': { allow: ['SELECT', 'UPDATE'], deny: ['INSERT', 'DELETE'] },
  'mailer.send_log': { allow: ['SELECT', 'INSERT', 'UPDATE'], deny: ['DELETE'] },
  'mailer.login_attempts': { allow: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], deny: [] },
  'mailer.schema_migrations': { allow: ['SELECT'], deny: ['INSERT', 'UPDATE', 'DELETE'] },
});

export async function checkConnection({ mode, env = process.env, createClient, out = console.log } = {}) {
  const results = [];
  const report = (ok, label, detail = '') => {
    results.push({ ok, label });
    out(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'INFO'}  ${label}${detail ? ` — ${detail}` : ''}`);
  };
  if (mode !== 'owner' && mode !== 'runtime') throw new Error('Usage: node scripts/db-check.js owner|runtime');
  const db = loadDatabaseConfig(env, { purpose: mode === 'owner' ? 'owner' : 'runtime' });
  if (db.backend !== 'postgres') throw new Error('Set DB_BACKEND=postgres.');
  const url = mode === 'owner' ? db.migrationUrl : db.url;
  if (mode === 'owner') assertSessionConnection(url, 'MIGRATION_DATABASE_URL');
  const opts = poolOptions(db, url, { max: 1 });
  delete opts.max;
  const make = createClient ?? (async (o) => new (await import('pg')).default.Client(o));
  const client = await make(opts);

  report(null, `mode=${mode}`, `TLS=${db.ssl}${db.ssl === 'verify' ? ` (CA: ${db.sslCaSource})` : ''}, startup params: ${db.startupParams.length ? db.startupParams.join(', ') : 'none'}`);
  try {
    await client.connect();
  } catch (err) {
    report(false, 'connect', safeDbError(err));
    return { ok: false, results };
  }
  try {
    report(true, 'connect', 'authenticated; startup parameters accepted');
    const tls = client.connection?.stream;
    if (db.ssl === 'verify') {
      const encrypted = Boolean(tls?.encrypted);
      const cert = encrypted ? tls.getPeerCertificate?.() : null;
      report(encrypted && tls.authorized === true, 'TLS certificate verified',
        encrypted ? `${tls.getProtocol?.()}, issuer CN=${cert?.issuer?.CN ?? '?'}, valid until ${cert?.valid_to ?? '?'}` : 'not encrypted');
    } else {
      report(null, 'TLS disabled (localhost only)');
    }

    const q = async (text, values) => (await client.query({ text, values })).rows;
    const [who] = await q("select current_user as user, session_user as session, current_database() as db, current_setting('server_version') as version");
    report(null, 'identity', `user=${who.user}, database=${who.db}, server ${who.version}`);
    const [{ v: schemaExists }] = await q("select to_regclass('mailer.schema_migrations') is not null as v");
    let version = null;
    if (schemaExists) [{ version }] = await q('select coalesce(max(version), 0)::int as version from mailer.schema_migrations');
    report(null, 'schema', schemaExists ? `mailer.schema_migrations version ${version}` : 'not migrated yet (no mailer.schema_migrations)');

    if (mode === 'owner') {
      const [r] = await q('select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user');
      report(r.rolcreaterole || r.rolsuper, 'owner can create roles (needed by migration 0001)', `createrole=${r.rolcreaterole}, superuser=${r.rolsuper}`);
      const [{ can }] = await q("select has_database_privilege(current_user, current_database(), 'CREATE') as can");
      report(can, 'owner can create schemas in this database');
      const roles = await q("select rolname, rolcanlogin from pg_roles where rolname in ('mailer_runtime', 'mailer_app') order by 1");
      report(null, 'app roles present', roles.length ? roles.map((x) => `${x.rolname}${x.rolcanlogin ? ' (login)' : ''}`).join(', ') : 'none yet');
    } else {
      const [r] = await q("select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, pg_has_role(current_user, 'mailer_runtime', 'usage') as member from pg_roles where rolname = current_user");
      report(r.member === true, 'runtime role inherits mailer_runtime');
      report(!r.rolsuper && !r.rolcreaterole && !r.rolcreatedb && !r.rolbypassrls, 'runtime role has no elevated attributes');
      if (schemaExists) {
        for (const [table, { allow, deny }] of Object.entries(RUNTIME_PRIVILEGES)) {
          const got = await Promise.all([...allow, ...deny].map(async (p) => [p, (await q('select has_table_privilege($1, $2) as ok', [table, p]))[0].ok]));
          const bad = got.filter(([p, ok]) => (allow.includes(p) ? !ok : ok)).map(([p, ok]) => `${p}=${ok}`);
          report(bad.length === 0, `privileges on ${table}`, bad.length ? `unexpected: ${bad.join(', ')}` : `allowed: ${allow.join(', ') || '—'}`);
        }
        const [{ rows }] = await q('select count(*)::int as rows from mailer.session_templates');
        report(rows === 4, 'can read the four session slots (row-level security policy)', `${rows} rows visible`);
      }
    }

    // Transaction behaviour — always rolled back, nothing is written.
    await client.query('begin');
    try {
      await client.query(`set local statement_timeout = ${db.statementTimeoutMs}; set local idle_in_transaction_session_timeout = ${db.idleInTxTimeoutMs}`);
      const [st] = await q("select current_setting('statement_timeout') as st, current_setting('idle_in_transaction_session_timeout') as it");
      report(true, 'SET LOCAL timeouts inside a transaction', `statement_timeout=${st.st}, idle_in_transaction=${st.it}`);
      await q('select pg_advisory_xact_lock(hashtext($1::text), $2::int)', ['tangy-db-check', 0]);
      report(true, 'transaction-scoped advisory lock');
      const [{ n }] = await q('select $1::int + 1 as n', [41]);
      report(n === 42, 'parameterized query (unnamed prepared statement)');
    } finally {
      await client.query('rollback').catch(() => {});
    }
    const [after] = await q("select current_setting('statement_timeout') as st");
    report(null, 'after rollback', `statement_timeout=${after.st} (session value; '0' means no startup/role default)`);
  } catch (err) {
    report(false, 'check aborted', safeDbError(err));
  } finally {
    await client.end().catch(() => {});
  }
  return { ok: results.every((r) => r.ok !== false), results };
}
