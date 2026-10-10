// PostgreSQL SCRAM-SHA-256 password verifier (the format PostgreSQL stores in
// pg_authid). Passing a verifier to CREATE/ALTER ROLE ... PASSWORD means the
// plaintext password never appears in SQL text, a SQL editor's history or
// server logs. Format:
//   SCRAM-SHA-256$<iterations>:<salt b64>$<StoredKey b64>:<ServerKey b64>
import { pbkdf2Sync, createHmac, createHash, randomBytes } from 'node:crypto';

// URL-unreserved characters only, so the password can be placed in a
// postgres:// URL without percent-encoding (and needs no SASLprep).
export const PASSWORD_RE = /^[A-Za-z0-9._~-]{24,128}$/;

export function scramVerifier(password, { salt = randomBytes(16), iterations = 4096 } = {}) {
  if (typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    throw new Error('Use 24–128 characters from A–Z a–z 0–9 . _ ~ - (generate it with a password manager).');
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}
