// Applies PostgreSQL migrations with the OWNER connection.
//   DB_BACKEND=postgres MIGRATION_DATABASE_URL=... node scripts/db-migrate.js
// MIGRATION_DATABASE_URL must be session-preserving (Supabase Session pooler
// or a direct connection, port 5432); port 6543 (transaction pooler) is
// refused before connecting. DATABASE_URL is not needed here.
// Applies files only up to APPROVED_MIGRATION_VERSION (src/store/pgMigrate.js).
// Prints migration names only — never connection strings or credentials.
import { runMigrations } from '../src/store/pgMigrate.js';
import { safeDbError } from '../src/store/pgConfig.js';

//   node scripts/db-migrate.js --plan   read-only: shows what would be applied
if (process.argv.includes('--plan')) {
  try {
    const p = await runMigrations({ plan: true });
    console.log(`[migrate] plan (read-only) — schema version ${p.current}`);
    console.log(`[migrate]   applied:  ${p.applied.join(', ') || 'none'}`);
    console.log(`[migrate]   would apply now: ${p.pending.join(', ') || 'nothing'}`);
    console.log(`[migrate]   prepared but not approved: ${p.held.join(', ') || 'none'}`);
    for (const problem of p.problems) console.log(`[migrate]   PROBLEM: ${problem}`);
    process.exitCode = p.problems.length ? 1 : 0;
  } catch (err) {
    console.error(`[migrate] plan failed: ${safeDbError(err)}`);
    process.exitCode = 1;
  }
} else try {
  const { applied, current, held } = await runMigrations({ log: (m) => console.log(`[migrate] ${m}`) });
  console.log(`[migrate] done — ${applied.length} applied, schema version ${current}${held.length ? ` (${held.length} prepared but not approved: ${held.join(', ')})` : ''}`);
} catch (err) {
  console.error(`[migrate] failed: ${safeDbError(err)}`);
  process.exitCode = 1;
}
