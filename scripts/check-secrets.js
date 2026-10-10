// Fails if any file git would commit contains something that looks like a
// Resend API key, a filled-in RESEND_API_KEY= line, or a PostgreSQL
// SCRAM-SHA-256 password verifier (e.g. a filled-in docs/supabase/01_runtime_role.sql).
// Prints the file and line only — never the value.
//   npm run check:secrets                 (files git would commit)
//   node scripts/check-secrets.js FILE…   (only the named files)
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const KEY_RE = /\bre_[A-Za-z0-9_]{16,}/;
const ASSIGNED_RE = /^\s*(export\s+)?RESEND_API_KEY\s*=\s*["']?[^\s"'#]+/;
// Any "SCRAM-SHA-256$<digits>:" — the start of every PostgreSQL verifier,
// whatever follows (case-insensitive, so a mangled copy is still caught).
const SCRAM_RE = /SCRAM-SHA-256\$\d+:/i;

let files = process.argv.slice(2);
if (!files.length) {
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    console.error('check:secrets needs git (run it inside the repository).');
    process.exit(2);
  }
}

const findings = [];
for (const file of files) {
  let text;
  try {
    if (statSync(file).size > 2_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch { continue; }
  text.split('\n').forEach((line, i) => {
    if (KEY_RE.test(line)) findings.push(`${file}:${i + 1}  value that looks like a Resend API key`);
    else if (ASSIGNED_RE.test(line)) findings.push(`${file}:${i + 1}  RESEND_API_KEY has a value`);
    if (SCRAM_RE.test(line)) findings.push(`${file}:${i + 1}  value that looks like a SCRAM-SHA-256 password verifier`);
  });
}

if (findings.length) {
  console.error('Possible secrets in files git would commit (values not shown):');
  for (const f of findings) console.error(`  ${f}`);
  console.error('Move real keys to .env (git-ignored) or the host\'s secret settings, leave RESEND_API_KEY= empty in .env.example, keep <SCRAM_VERIFIER> as a placeholder in SQL templates, and rotate anything that was exposed.');
  process.exit(1);
}
console.log(`check:secrets — ${files.length} files scanned, no secrets found.`);
