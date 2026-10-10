// Read-only PostgreSQL connection check. Never writes anything.
//   node --env-file=.env.migrate  scripts/db-check.js owner     (Session pooler, schema owner)
//   node --env-file=.env.supabase scripts/db-check.js runtime   (Transaction pooler, runtime role)
// Exit code 0 = every check passed. Output never contains connection strings or passwords.
import { checkConnection } from '../src/store/pgCheck.js';
import { safeDbError } from '../src/store/pgConfig.js';

try {
  const { ok } = await checkConnection({ mode: process.argv[2] });
  console.log(ok ? 'RESULT: all checks passed (nothing was written)' : 'RESULT: some checks FAILED (nothing was written)');
  process.exitCode = ok ? 0 : 1;
} catch (err) {
  console.error(`[db-check] ${safeDbError(err)}`);
  process.exitCode = 1;
}
