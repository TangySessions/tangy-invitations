// Admin account management — the ONLY way accounts are created (no sign-up
// route exists). Needs shell access to the server / its data directory.
//
//   npm run admin:create -- you@example.com
//   npm run admin:reset-password -- you@example.com
//   npm run admin:disable -- you@example.com     (also ends their sessions)
//   npm run admin:enable -- you@example.com
//   npm run admin:list
//
// Storage: SQLite by default (DATA_DIR). With DB_BACKEND=postgres it uses
// MIGRATION_DATABASE_URL (the schema owner): the app's runtime role is
// deliberately not allowed to create or change admin accounts. DATABASE_URL
// is not needed. (Unlike migrations, these are short single transactions,
// so a transaction pooler would also work — the Session pooler is
// recommended so one owner URL serves both.)
//
// The password is read from a hidden prompt (or the first line of stdin when
// not run in a terminal). It is never accepted as a command-line argument,
// because arguments end up in shell history and process listings.
import { createInterface } from 'node:readline';
import { loadAdminCliConfig } from '../src/config.js';
import { openStore } from '../src/store/index.js';
import { hashPassword, PASSWORD_MIN } from '../src/auth.js';
import { validateEmailAddress } from '../src/templatePolicy.js';

const [command, emailArg] = process.argv.slice(2);
const fail = (msg) => { console.error(msg); process.exit(1); };

async function readPasswordFromStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(question)) rl.output.write(question); };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function askPassword() {
  if (!process.stdin.isTTY) return readPasswordFromStdin();
  const first = await promptHidden(`New password (min ${PASSWORD_MIN} characters): `);
  const second = await promptHidden('Repeat password: ');
  if (first !== second) fail('Passwords do not match.');
  return first;
}

let config;
let store;
try {
  config = loadAdminCliConfig();
  store = await openStore(config, config.database.backend === 'postgres' ? { url: config.database.migrationUrl, log: { error() {}, info() {} } } : {});
} catch (err) {
  fail(err.message);
}
const db = store.db;

if (command === 'list') {
  const admins = await db.listAdmins();
  if (!admins.length) console.log('No admin accounts.');
  for (const a of admins) console.log(`${a.email}${a.disabled ? '  (disabled)' : ''}  created ${a.created_at}`);
  await store.close();
  process.exit(0);
}

const { email, error } = validateEmailAddress(emailArg ?? '');
if (error) fail(`Usage: npm run admin:${command ?? '<create|reset-password|disable|enable|list>'} -- you@example.com\n${error}`);
const existing = await db.getAdminByEmail(email);

if (command === 'create' || command === 'reset-password') {
  if (command === 'create' && existing) fail(`${email} already exists. Use admin:reset-password to change the password.`);
  if (command === 'reset-password' && !existing) fail(`${email} does not exist.`);
  let hash;
  try { hash = await hashPassword(await askPassword()); } catch (err) { fail(err.message); }
  if (command === 'create') await db.createAdmin(email, hash);
  else {
    await db.setAdminPassword(email, hash);
    await db.deleteSessionsForAdmin(existing.id);
  }
  console.log(command === 'create' ? `Created admin ${email}.` : `Password updated for ${email}; their sessions were signed out.`);
} else if (command === 'disable' || command === 'enable') {
  if (!existing) fail(`${email} does not exist.`);
  await db.setAdminDisabled(email, command === 'disable');
  console.log(`${email} ${command === 'disable' ? 'disabled (sessions ended)' : 'enabled'}.`);
} else {
  fail('Unknown command. Use create, reset-password, disable, enable or list.');
}
await store.close();
