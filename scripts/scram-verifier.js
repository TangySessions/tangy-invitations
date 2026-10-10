// Prints a SCRAM-SHA-256 verifier for a database role password, computed on
// this machine. Paste the VERIFIER (not the password) into
// docs/supabase/01_runtime_role.sql. The password is read from a hidden
// prompt (or the first line of stdin) and never printed, logged or stored.
//   node scripts/scram-verifier.js
// Treat the verifier as sensitive too: it can be attacked offline.
import { createInterface } from 'node:readline';
import { scramVerifier } from '../src/store/scram.js';

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  const ask = (q) => new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.startsWith(q)) rl.output.write(q); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
  const first = await ask('Runtime role password (hidden): ');
  const second = await ask('Repeat: ');
  if (first !== second) throw new Error('The passwords do not match.');
  return first;
}

try {
  const verifier = scramVerifier(await readPassword());
  console.log(verifier);
} catch (err) {
  console.error(`[scram-verifier] ${err.message}`);
  process.exit(1);
}
