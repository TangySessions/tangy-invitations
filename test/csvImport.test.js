// CSV recipient import (src/csvImport.js): parsing, header rules,
// validation, duplicates and limits. Pure functions — no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, reviewCsv, CsvError, CSV_MAX_RECIPIENTS, CSV_MAX_ROWS, templateContentHash } from '../src/csvImport.js';

const fails = (text, code, re) => {
  assert.throws(() => reviewCsv(text), (err) => err instanceof CsvError && err.code === code && (!re || re.test(err.message)), `${code}: ${JSON.stringify(text.slice(0, 60))}`);
};
const emails = (r) => r.recipients.map((x) => x.email);

test('valid CSV in either column order; header case-insensitive with spaces; leading BOM ignored', () => {
  for (const text of [
    'name,email\nAsha,asha@example.com\nBen,ben@example.com\n',
    'email,name\nasha@example.com,Asha\nben@example.com,Ben',
    '\uFEFFName , EMAIL\r\nAsha,asha@example.com\r\nBen,ben@example.com\r\n',
  ]) {
    const r = reviewCsv(text);
    assert.deepEqual(r.recipients, [{ row: 2, name: 'Asha', email: 'asha@example.com', people: 1 }, { row: 3, name: 'Ben', email: 'ben@example.com', people: 1 }], JSON.stringify(text));
    assert.deepEqual(r.counts, { total: 2, valid: 2, invalid: 0, duplicate: 0, blank: 0, skipped: 0 });
    assert.deepEqual(r.problems, []);
  }
  assert.equal(reviewCsv('name,email\nA,a@b.co\n').recipients_hash, reviewCsv('email,name\na@b.co,A').recipients_hash, 'same list, same fingerprint');
});

test('quoted fields: commas, doubled quotes, quoted header, line endings CRLF/LF/CR', () => {
  const r = reviewCsv('"name","email"\r"Doe, Jane",jane@example.com\r\n"Say ""hi"" Sam","sam@example.com"\n"",\n');
  assert.deepEqual(r.recipients.map((x) => x.name), ['Doe, Jane', 'Say "hi" Sam']);
  assert.equal(r.counts.blank, 1, 'a row of empty fields is blank');
  assert.deepEqual(parseCsv('a,"b\nc"\nd').map((x) => [x.line, x.fields]), [[1, ['a', 'b\nc']], [3, ['d']]], 'row numbers follow physical lines');
});

test('header problems refuse the whole file', () => {
  fails('', 'empty');
  fails('\uFEFF  \n\n', 'empty');
  fails('\nname,email\nA,a@b.co', 'bad_header', /first line must be the header/);
  fails('name\nA', 'bad_header', /missing the email column/);
  fails('email\na@b.co', 'bad_header', /missing the name column/);
  fails('full name,email\nA,a@b.co', 'bad_header', /unexpected column "full name"/);
  fails('name,email,phone\nA,a@b.co,1', 'bad_header', /unexpected column "phone"/);
  fails('name,email,\nA,a@b.co,', 'bad_header', /unexpected column ""/);
  fails('name,Name,email\n', 'bad_header', /"name" appears twice/);
  fails('name,email,EMAIL\n', 'bad_header', /"email" appears twice/);
  fails('na"me,email\n', 'bad_header', /Header \(row 1\)/);
  fails('Recipient,Address\nA,a@b.co', 'bad_header');
});

test('invalid names and emails are reported by row, using the single-send validators', () => {
  const r = reviewCsv([
    'name,email',
    'Asha,asha@example.com',       // 2 ok
    'Ben,not-an-email',            // 3
    ',carl@example.com',           // 4 no name
    'Dee,',                        // 5 no email
    '"Eve {{recipient_name}}",eve@example.com', // 6 placeholder in name
    `${'x'.repeat(101)},long@example.com`,       // 7 name too long
    '"Fay\u0007",fay@example.com',  // 8 control character
    'Gus,"gus@example.com, h@example.com"',      // 9 two addresses
    'Hal,hal@example..com',         // 10
    'Ivy,ivy@example.com,extra',    // 11 three columns
    'Jo',                           // 12 one column
  ].join('\n'));
  assert.deepEqual(emails(r), ['asha@example.com']);
  assert.equal(r.counts.invalid, 10);
  const byRow = Object.fromEntries(r.problems.map((p) => [p.row, p]));
  assert.match(byRow[3].message, /^Email: Enter a valid email address/);
  assert.match(byRow[4].message, /^Name: Enter the recipient name/);
  assert.match(byRow[5].message, /^Email:/);
  assert.match(byRow[6].message, /\{\{ or \}\}/);
  assert.match(byRow[7].message, /under 100 characters/);
  assert.match(byRow[8].message, /invalid characters/);
  assert.match(byRow[9].message, /exactly one email address/);
  assert.match(byRow[10].message, /valid email address/);
  assert.match(byRow[11].message, /Expected 2 columns.*found 3/);
  assert.match(byRow[12].message, /found 1/);
  assert.ok(r.problems.every((p) => p.kind === 'invalid'));
});

test('duplicates are detected after normalization (trim + lower-case) and point at the first row', () => {
  const r = reviewCsv('name,email\nAsha,Asha@Example.com\nAsha Again, asha@example.COM \nBen,ben@example.com\nAsha 3,ASHA@EXAMPLE.COM\nBad,bad\nBad 2,bad\n');
  assert.deepEqual(emails(r), ['asha@example.com', 'ben@example.com']);
  assert.deepEqual(r.counts, { total: 6, valid: 2, invalid: 2, duplicate: 2, blank: 0, skipped: 4 });
  assert.deepEqual(r.problems.filter((p) => p.kind === 'duplicate').map((p) => [p.row, p.first_row]), [[3, 2], [5, 2]]);
});

test('blank rows are counted and listed; a final line break is not a blank row', () => {
  const r = reviewCsv('name,email\n\nAsha,asha@example.com\n  \n,\r\n\nBen,ben@example.com\n');
  assert.deepEqual(r.counts, { total: 6, valid: 2, invalid: 0, duplicate: 0, blank: 4, skipped: 4 });
  assert.deepEqual(r.problems.map((p) => [p.row, p.kind]), [[2, 'blank'], [4, 'blank'], [5, 'blank'], [6, 'blank']]);
  assert.equal(reviewCsv('name,email\nA,a@b.co\n').counts.blank, 0);
  assert.equal(reviewCsv('name,email\nA,a@b.co').counts.blank, 0);
});

test('malformed quoting: stray quotes invalidate one row; an unclosed quote refuses the file', () => {
  const r = reviewCsv('name,email\nAs"ha,asha@example.com\n"Ben"x,ben@example.com\nCal,cal@example.com\n');
  assert.deepEqual(emails(r), ['cal@example.com'], 'parsing resumes on the next line');
  assert.deepEqual(r.problems.map((p) => [p.row, p.kind]), [[2, 'invalid'], [3, 'invalid']]);
  assert.match(r.problems[0].message, /quote .* not quoted/);
  assert.match(r.problems[1].message, /after a closing quote/);
  fails('name,email\nAsha,asha@example.com\n"Ben,ben@example.com\nCal,cal@example.com\n', 'unterminated_quote', /Row 3/);
});

test('limits: more than the recipient limit (or the row limit) refuses the whole file, never truncates', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => `R${i},r${i}@example.com`).join('\n');
  assert.equal(reviewCsv(`name,email\n${rows(CSV_MAX_RECIPIENTS)}`).counts.valid, CSV_MAX_RECIPIENTS);
  fails(`name,email\n${rows(CSV_MAX_RECIPIENTS + 1)}`, 'too_many_recipients', new RegExp(`${CSV_MAX_RECIPIENTS + 1} recipient rows; the limit is ${CSV_MAX_RECIPIENTS}`));
  assert.equal(reviewCsv(`name,email\nA,a@b.co${'\n'.repeat(1000)}`).counts.blank, 999, 'blank rows do not count as recipients');
  fails(`name,email\n${'\n'.repeat(CSV_MAX_ROWS + 1)}`, 'too_many_rows');
});

test('content is treated as plain data: formulas, markup and scripts stay literal strings', () => {
  const r = reviewCsv('name,email\n"=HYPERLINK(""http://x"")",a@example.com\n<script>alert(1)</script>,b@example.com\n+SUM(A1),c@example.com\n');
  assert.deepEqual(r.recipients.map((x) => x.name), ['=HYPERLINK("http://x")', '<script>alert(1)</script>', '+SUM(A1)']);
});

test('template content hash changes with any content field, not with metadata', () => {
  const t = { subject: 'S', html: '<p>x</p>', css: '', text: '' };
  const h = templateContentHash(t);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(templateContentHash({ ...t, version: 9, label: 'Other' }), h);
  for (const k of ['subject', 'html', 'css', 'text']) assert.notEqual(templateContentHash({ ...t, [k]: `${t[k]} ` }), h, k);
});

// ----------------------------------------------------- name,people,email ---
test('name,people,email: each row maps to its own name, people count and email', () => {
  const r = reviewCsv('name,people,email\nDeepa,3,deepa@tangysessions.com\nKomal,1,komal@tangysessions.com\nRahul,4,rahul@example.com\n');
  assert.equal(r.format, 'name,people,email');
  assert.deepEqual(r.recipients, [
    { row: 2, name: 'Deepa', email: 'deepa@tangysessions.com', people: 3 },
    { row: 3, name: 'Komal', email: 'komal@tangysessions.com', people: 1 },
    { row: 4, name: 'Rahul', email: 'rahul@example.com', people: 4 },
  ]);
  assert.deepEqual(r.problems, []);
  // Case and spaces in the header are tolerated; quoted names with commas work.
  const q = reviewCsv('﻿ Name , PEOPLE , Email \r\n"Doe, Jane", 2 ,jane@example.com\r\n');
  assert.deepEqual(q.recipients, [{ row: 2, name: 'Doe, Jane', email: 'jane@example.com', people: 2 }]);
  // The people count is part of the list fingerprint.
  assert.notEqual(reviewCsv('name,people,email\nA,2,a@b.co').recipients_hash, reviewCsv('name,people,email\nA,3,a@b.co').recipients_hash);
});

test('people values: only whole numbers 1–50; zero, negatives, decimals, text and blanks are row errors', () => {
  const rows = ['A,0,a@x.co', 'B,-2,b@x.co', 'C,1.5,c@x.co', 'D,three,d@x.co', 'E,,e@x.co', 'F,51,f@x.co', 'G,+2,g@x.co', 'H,2e1,h@x.co', 'I,1,i@x.co', 'J,50,j@x.co'];
  const r = reviewCsv(`name,people,email\n${rows.join('\n')}\n`);
  assert.deepEqual(r.recipients.map((x) => [x.name, x.people]), [['I', 1], ['J', 50]]);
  assert.equal(r.counts.invalid, 8);
  for (const p of r.problems) assert.match(p.message, /^People: (".*" is not|missing —) a whole number from 1 to 50\.$/);
  assert.match(r.problems.find((p) => p.row === 4).message, /"1\.5" is not/);
  // The people value is never taken as the email (and vice versa).
  const swapped = reviewCsv('name,people,email\nA,a@x.co,3\n');
  assert.equal(swapped.recipients.length, 0);
  assert.match(swapped.problems[0].message, /People: "a@x\.co" is not a whole number.*Email:/);
});

test('header rules: name,people,email in that order; the older name,email still works; clear errors otherwise', () => {
  const legacy = reviewCsv('email,name\na@x.co,A\n');
  assert.deepEqual([legacy.format, legacy.recipients[0].people], ['name,email', 1], 'old files: 1 person each');
  for (const [header, re] of [
    ['name,email,people', /with a people column the header must be exactly name,people,email \(in that order\); found name,email,people/],
    ['people,name,email', /must be exactly name,people,email/],
    ['email,people,name', /must be exactly name,people,email/],
    ['name,people', /missing the email column\. Use: name,people,email \(or the older name,email\)/],
    ['people,email', /missing the name column/],
    ['name,people,email,phone', /unexpected column "phone"/],
    ['name,people,people,email', /"people" appears twice/],
  ]) assert.throws(() => reviewCsv(`${header}\nA,1,a@x.co\n`), (err) => re.test(err.message), header);
  const short = reviewCsv('name,people,email\nA,2\nB,1,b@x.co,extra\n');
  assert.deepEqual(short.problems.map((p) => p.message), [
    'Expected 3 columns (name, people, email); found 2. Quote any name that contains a comma.',
    'Expected 3 columns (name, people, email); found 4. Quote any name that contains a comma.']);
});
