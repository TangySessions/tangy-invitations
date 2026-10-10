// Chooses the data store from config.database.backend:
//   sqlite   (default) the existing node:sqlite file in DATA_DIR, with the
//            in-process MemoryLoginLimiter — unchanged behaviour
//   postgres only when DB_BACKEND=postgres: the pg pool + PgLoginLimiter;
//            refuses to start on an unmigrated/outdated schema
// Each backend's module is loaded only when selected: SQLite mode never
// loads pg, and PostgreSQL mode (e.g. on Vercel) never loads node:sqlite.
// There is no fallback: if PostgreSQL is selected and fails, this throws.

export async function openStore(config, { log = console, now = Date.now, url } = {}) {
  if (config.database.backend === 'postgres') {
    const { openPgStore } = await import('./postgres.js');
    const db = await openPgStore(config.database, { log, now, ...(url ? { url } : {}) });
    try {
      await db.assertSchema();
    } catch (err) {
      await db.close().catch(() => {});
      throw err;
    }
    return { backend: 'postgres', db, loginLimiter: db.createLoginLimiter(), close: () => db.close() };
  }
  const { openDb } = await import('../db.js');
  const db = openDb(config.dataDir);
  return { backend: 'sqlite', db, loginLimiter: undefined, close: async () => db.close() };
}
