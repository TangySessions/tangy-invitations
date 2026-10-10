// Production-readiness preflight. Read-only; see src/preflight.js.
//   npm run preflight            configuration only (no database access)
//   npm run preflight -- --db    also read the schema version (read-only)
//   npm run preflight -- --live  exit 1 unless ready for real sending
//   --domain-verified            you checked Resend → Domains by hand (never checked here)
// For the PostgreSQL setup: node --env-file=.env --env-file=.env.supabase scripts/preflight.js --db
import { runPreflight, formatPreflight } from '../src/preflight.js';
import { safeDbError } from '../src/store/pgConfig.js';

const args = process.argv.slice(2);
const result = await runPreflight({
  checkDb: args.includes('--db'),
  domainConfirmed: args.includes('--domain-verified'),
  readSqliteVersion: (file) => {
    // Lazy import, read-only open: the file is never migrated or written.
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('pragma user_version').get().user_version; } finally { db.close(); }
  },
  readPgVersion: async (config) => {
    const { openPgStore } = await import('../src/store/postgres.js');
    const store = await openPgStore(config.database, { log: { info() {}, error() {} } });
    try { return await store.schemaVersion(); } catch (err) { throw new Error(safeDbError(err)); } finally { await store.close(); }
  },
});
console.log(formatPreflight(result));
process.exitCode = !result.dryRunReady || (args.includes('--live') && !result.liveReady) ? 1 : 0;
