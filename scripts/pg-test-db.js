// Disposable local PostgreSQL for integration tests (Docker).
//   npm run pg:test:up     start container "tangy-invitations-pgtest"
//   npm run test:pg        run the PostgreSQL test suites against it
//   npm run pg:test:down   remove the container and .env.pgtest
//
// Safety: the container listens on 127.0.0.1 only, keeps its data in RAM
// (tmpfs — nothing survives removal), and has a random password written only
// to .env.pgtest (git-ignored, mode 600). Nothing here touches data/, the
// SQLite database, or any remote database.
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

const NAME = 'tangy-invitations-pgtest';
const IMAGE = 'postgres:17-alpine';
const PORT = Number(process.env.PG_TEST_PORT || 55432);
const ENV_FILE = '.env.pgtest';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dockerReady() {
  try { docker('info', '--format', '{{.ServerVersion}}'); return true; } catch { return false; }
}
const containerState = () => { try { return docker('inspect', '-f', '{{.State.Status}}', NAME); } catch { return null; } };
const portInUse = (port) => new Promise((resolve) => {
  const s = createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});

async function up() {
  if (!dockerReady()) throw new Error('Docker is not running. Start Docker Desktop, then retry.');
  const state = containerState();
  if (state === 'running' && existsSync(ENV_FILE)) { console.log(`${NAME} is already running on 127.0.0.1:${PORT}.`); return; }
  if (state) throw new Error(`A container named ${NAME} exists (${state}) but ${ENV_FILE} is missing. Run npm run pg:test:down first.`);
  if (await portInUse(PORT)) throw new Error(`127.0.0.1:${PORT} is already in use. Set PG_TEST_PORT to a free port.`);
  const password = randomBytes(24).toString('base64url');
  docker('run', '-d', '--name', NAME, '--label', 'purpose=tangy-invitations-tests',
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_USER=postgres',
    '-p', `127.0.0.1:${PORT}:5432`, '--tmpfs', '/var/lib/postgresql/data:rw', IMAGE,
    // Parallel test processes each hold small pools.
    'postgres', '-c', 'max_connections=200');
  for (let i = 0; i < 60; i++) {
    try { docker('exec', NAME, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'); break; } catch { await sleep(500); }
    if (i === 59) throw new Error('PostgreSQL did not become ready in 30 s.');
  }
  await sleep(500);
  writeFileSync(ENV_FILE, [
    '# Disposable local test database (npm run pg:test:up). Not a real credential.',
    'TEST_DB_BACKEND=postgres',
    `PG_TEST_URL=postgres://postgres:${password}@127.0.0.1:${PORT}/postgres`,
    '',
  ].join('\n'), { mode: 0o600 });
  console.log(`${NAME} running on 127.0.0.1:${PORT} (${docker('exec', NAME, 'postgres', '--version')}). Connection saved to ${ENV_FILE}.`);
}

function down() {
  if (containerState()) { docker('rm', '-f', NAME); console.log(`Removed ${NAME}.`); } else console.log(`${NAME} is not running.`);
  rmSync(ENV_FILE, { force: true });
}

try {
  const cmd = process.argv[2];
  if (cmd === 'up') await up();
  else if (cmd === 'down') down();
  else throw new Error('Usage: node scripts/pg-test-db.js up|down');
} catch (err) {
  console.error(`[pg-test-db] ${err.message}`);
  process.exit(1);
}
