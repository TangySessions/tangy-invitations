// CSV recipient import for campaign review (Phase 2A: review only — nothing
// here stores, queues or sends anything).
//
// Format (RFC 4180, strict):
//   - first line: a header with exactly the columns `name` and `email`
//     (any case, either order, surrounding spaces ignored);
//   - fields separated by commas; records end with CRLF, LF or CR;
//   - a field may be wrapped in double quotes, which allows commas, line
//     breaks and doubled quotes ("") inside it;
//   - a leading UTF-8 byte-order mark is ignored.
// The content is only split into strings and checked with the same
// validators as single sends (validateRecipient). It is never evaluated,
// and nothing from it is logged.
import { createHash } from 'node:crypto';
import { validateRecipient, validatePeople, PEOPLE } from './templatePolicy.js';

// Non-blank data rows accepted in one import. Larger lists are refused
// whole (never truncated). The request body limit (1 MB) also applies.
export const CSV_MAX_RECIPIENTS = 1000;
// Blank lines count towards this bound on total work.
export const CSV_MAX_ROWS = 5000;

export class CsvError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Splits text into records: [{ line, fields, error }]. `line` is the
// physical line on which the record starts (the header is line 1), so
// messages match what a text editor or spreadsheet shows. A record with a
// stray quote gets `error` and parsing resumes on the next line; an
// unterminated quoted field swallows the rest of the file, so it is fatal.
export function parseCsv(text) {
  if (typeof text !== 'string') throw new CsvError('The CSV must be text.', 'csv_type');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    if (records.length >= CSV_MAX_ROWS) throw new CsvError(`The CSV has more than ${CSV_MAX_ROWS} rows. Split it into smaller files.`, 'too_many_rows');
    const start = line;
    const fields = [];
    let error = null;
    let field = '';
    for (;;) {
      if (text[i] === '"') {
        // Quoted field.
        i++;
        for (;;) {
          if (i >= n) throw new CsvError(`Row ${start}: a quoted field is never closed (missing ").`, 'unterminated_quote');
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
            i++;
            break;
          }
          if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
          field += c;
          i++;
        }
        if (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          error = 'Unexpected text after a closing quote. Wrap the whole field in quotes and double any quote inside it ("").';
        }
      } else {
        while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          if (text[i] === '"') error = 'A quote (") appears inside a field that is not quoted. Wrap the field in quotes and double the quote ("").';
          field += text[i];
          i++;
        }
      }
      if (error) {
        // Skip to the end of this physical line and move on.
        while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      }
      fields.push(field);
      field = '';
      if (!error && text[i] === ',') { i++; continue; }
      break;
    }
    // End of record.
    if (text[i] === '\r') i += text[i + 1] === '\n' ? 2 : 1;
    else if (text[i] === '\n') i++;
    line++;
    records.push({ line: start, fields, error });
  }
  return records;
}

const isBlank = (r) => !r.error && r.fields.every((f) => f.trim() === '');

// The emails of a campaign are compared and stored lower-cased (the whole
// address: a conservative choice — real providers treat addresses
// case-insensitively, so two spellings would reach the same inbox).
export const normalizeEmail = (email) => email.trim().toLowerCase();

// Parses and validates an import. Returns
//   { counts, recipients: [{ row, name, email, people }], problems: [{ row, kind, message, first_row? }], recipients_hash, format }
// where kind is 'invalid' | 'duplicate' | 'blank'. Throws CsvError for a
// file that cannot be reviewed at all (bad header, too many rows, unclosed quote).
// Accepted headers (case-insensitive, surrounding spaces ignored):
//   name,people,email  — the format with a number of people per invitation;
//                        exactly this order
//   name,email          — the original format (either order); people = 1
// Columns are always mapped by header name, never by position alone.
export const CSV_HEADER = 'name,people,email';
const FORMAT_HINT = `Use: ${CSV_HEADER} (or the older name,email)`;

export function reviewCsv(text) {
  if (typeof text !== 'string' || text.replace(/^\uFEFF/, '').trim() === '') throw new CsvError(`The CSV is empty. The first line must be the header: ${CSV_HEADER}`, 'empty');
  const records = parseCsv(text);
  const [header, ...rows] = records;
  if (header.error) throw new CsvError(`Header (row 1): ${header.error}`, 'bad_header');
  const cols = header.fields.map((f) => f.trim().toLowerCase());
  if (cols.every((c) => c === '')) throw new CsvError(`The first line must be the header: ${CSV_HEADER}`, 'bad_header');
  const dup = cols.find((c, k) => cols.indexOf(c) !== k);
  if (dup !== undefined) throw new CsvError(`Header (row 1): the column "${dup.slice(0, 40)}" appears twice. ${FORMAT_HINT}`, 'bad_header');
  const unknown = cols.filter((c) => c !== 'name' && c !== 'email' && c !== 'people');
  if (unknown.length) throw new CsvError(`Header (row 1): unexpected column${unknown.length > 1 ? 's' : ''} ${unknown.map((c) => `"${c.slice(0, 40)}"`).join(', ')}. ${FORMAT_HINT}`, 'bad_header');
  const missing = ['name', 'email'].filter((c) => !cols.includes(c));
  if (missing.length) throw new CsvError(`Header (row 1): missing the ${missing.join(' and ')} column. ${FORMAT_HINT}`, 'bad_header');
  const withPeople = cols.includes('people');
  if (withPeople && cols.join(',') !== CSV_HEADER) {
    throw new CsvError(`Header (row 1): with a people column the header must be exactly ${CSV_HEADER} (in that order); found ${cols.join(',')}.`, 'bad_header');
  }
  const nameAt = cols.indexOf('name');
  const emailAt = cols.indexOf('email');
  const peopleAt = cols.indexOf('people');
  const columnList = withPeople ? 'name, people, email' : 'name, email';

  // (A final line break ends the last record; it never adds a blank row.)
  const dataRows = rows.filter((r) => !isBlank(r)).length;
  if (dataRows > CSV_MAX_RECIPIENTS) {
    throw new CsvError(`The CSV has ${dataRows} recipient rows; the limit is ${CSV_MAX_RECIPIENTS} per import. Split it into smaller files.`, 'too_many_recipients');
  }

  const recipients = [];
  const problems = [];
  const firstRowOf = new Map();
  const counts = { total: rows.length, valid: 0, invalid: 0, duplicate: 0, blank: 0, skipped: 0 };
  for (const r of rows) {
    if (isBlank(r)) {
      counts.blank++;
      problems.push({ row: r.line, kind: 'blank', message: 'Blank row.' });
      continue;
    }
    if (r.error) {
      counts.invalid++;
      problems.push({ row: r.line, kind: 'invalid', message: r.error });
      continue;
    }
    if (r.fields.length !== cols.length) {
      counts.invalid++;
      problems.push({ row: r.line, kind: 'invalid', message: `Expected ${cols.length} columns (${columnList}); found ${r.fields.length}. Quote any name that contains a comma.` });
      continue;
    }
    const v = validateRecipient({ name: r.fields[nameAt], email: r.fields[emailAt] });
    // People: digits only (no sign, decimals or text), 1–PEOPLE.max.
    const rawPeople = withPeople ? r.fields[peopleAt].trim() : String(PEOPLE.def);
    const people = /^\d{1,6}$/.test(rawPeople) ? validatePeople(Number(rawPeople)) : { error: 'invalid' };
    if (v.errors || people.error) {
      counts.invalid++;
      problems.push({
        row: r.line, kind: 'invalid',
        message: [v.errors?.name && `Name: ${v.errors.name}`,
          people.error && `People: ${rawPeople ? `"${rawPeople.slice(0, 20)}" is not` : 'missing —'} a whole number from ${PEOPLE.min} to ${PEOPLE.max}.`,
          v.errors?.email && `Email: ${v.errors.email}`].filter(Boolean).join(' '),
      });
      continue;
    }
    const email = normalizeEmail(v.recipient.email);
    if (firstRowOf.has(email)) {
      counts.duplicate++;
      problems.push({ row: r.line, kind: 'duplicate', message: `Duplicate of row ${firstRowOf.get(email)} (same email address).`, first_row: firstRowOf.get(email) });
      continue;
    }
    firstRowOf.set(email, r.line);
    recipients.push({ row: r.line, name: v.recipient.name, email, people: people.people });
  }
  counts.valid = recipients.length;
  counts.skipped = counts.invalid + counts.duplicate + counts.blank;
  problems.sort((a, b) => a.row - b.row);
  // Identifies exactly this recipient list (order included), so a later
  // confirmation step can check that it is what was reviewed.
  const recipients_hash = createHash('sha256').update(JSON.stringify(recipients.map((x) => [x.name, x.email, x.people]))).digest('hex');
  return { counts, recipients, problems, recipients_hash, format: withPeople ? CSV_HEADER : 'name,email' };
}

// Identifies the exact saved template content that was reviewed.
export function templateContentHash(t) {
  return createHash('sha256').update(JSON.stringify([t.subject, t.html, t.css || '', t.text || ''])).digest('hex');
}
