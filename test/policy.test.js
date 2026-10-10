import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplate, renderEmail, validateRecipient, validateEmailAddress, injectCss, TEST_SUBJECT_PREFIX } from '../src/templatePolicy.js';

const base = { subject: 'Hello {{recipient_name}}', html: '<html><head></head><body><h1>Hello {{recipient_name}},</h1></body></html>', css: '', text: '' };
const errorsOf = (patch) => validateTemplate({ ...base, ...patch }).errors.map((e) => e.message).join(' | ');
const rejects = (html, re, label) => test(label, () => assert.match(errorsOf({ html }), re));

// ------------------------------------------------------------ accepted ---
test('a realistic email template passes', () => {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width"><style>.btn{background:#8B2E00} @media (max-width:600px){.wrap{width:100%!important}}</style></head>
<body style="margin:0;background-color:#11100C;font-family:Georgia,serif;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="wrap" background="https://cdn.example.com/bg.png">
<tr><td><img src="https://cdn.example.com/logo.png" alt="Tangy" width="120" srcset="https://cdn.example.com/logo@2x.png 2x"></td></tr>
<tr><td><h1>Hi {{recipient_name}},</h1><p>You're invited. Reply to <a href="mailto:hello@tangysessions.com">us</a> or call <a href="tel:+911234">us</a>.</p>
<a class="btn" href="https://tangysessions.com/rsvp?e={{recipient_email}}&amp;s=1" style="display:inline-block;padding:12px 24px;color:#fff;background-image:url('https://cdn.example.com/x.png')">RSVP →</a>
<p><a href="#top">Top</a></p></td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</body></html>`;
  const { errors } = validateTemplate({ subject: "You're invited, {{recipient_name}}", html, css: '.footer { color: #999; }', text: 'Hi {{recipient_name}}' });
  assert.deepEqual(errors, []);
});

// ------------------------------------------------------------ rejected ---
rejects('<p>x</p><script>alert(1)</script>', /Scripts are not allowed/, 'script tag rejected');
rejects('<p>x</p><SCRIPT src="https://x/y.js"></SCRIPT>', /Scripts are not allowed/, 'uppercase script tag rejected');
rejects('<img src="https://x/a.png" onerror="alert(1)">', /event-handler/, 'onerror rejected');
rejects('<body onload=alert(1)><p>x</p></body>', /event-handler/, 'unquoted onload rejected');
rejects('<img/src="https://x/a.png"/onerror=alert(1)>', /event-handler/, 'slash-separated event handler rejected');
rejects('<a href="javascript:alert(1)">x</a>', /javascript|not allowed/, 'javascript: href rejected');
rejects('<a href="jav&#x61;script&colon;alert(1)">x</a>', /not allowed|obfuscated/, 'entity-obfuscated javascript: rejected');
rejects('<a href="  java\tscript:alert(1)">x</a>', /not allowed|obfuscated/, 'whitespace-obfuscated javascript: rejected');
rejects('<a href="java&Tab;script:alert(1)">x</a>', /not allowed|obfuscated/, 'unknown-entity obfuscation fails closed');
rejects('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', /data:text\/html|not allowed/, 'data:text/html rejected');
rejects('<a href="vbscript:msgbox(1)">x</a>', /vbscript|not allowed/, 'vbscript: rejected');
rejects('<img src="http://x/a.png">', /https/, 'http image rejected');
rejects('<iframe src="https://evil"></iframe>', /frames/, 'iframe rejected');
rejects('<svg><script>alert(1)</script></svg>', /SVG/, 'svg rejected');
rejects('<object data="https://x"></object>', /objects/, 'object rejected');
rejects('<form action="https://x"><input name=a></form>', /Form/, 'form rejected');
rejects('<base href="https://evil/">', /base/, 'base rejected');
rejects('<meta http-equiv="refresh" content="0;url=https://evil">', /refresh/, 'meta refresh rejected');
rejects('<iframe srcdoc="<p>x</p>"></iframe>', /srcdoc|frames/, 'srcdoc rejected');
rejects('<p style="width:expression(alert(1))">x</p>', /expression/, 'CSS expression() rejected');
rejects('<p style="background:url(javascript:alert(1))">x</p>', /Script URLs|not allowed/, 'CSS javascript url rejected');
rejects('<p style="behavior:url(x.htc)">x</p>', /behaviors/, 'CSS behavior rejected');
rejects('<style>p{background:url(\\6a avascript:x)}</style>', /backslashes/, 'CSS escapes rejected');
rejects('<!--> <img src="https://x/a.png" onerror=alert(1)> -->', /event-handler/, 'comment parser differential is still scanned');
rejects('<!--[if mso]><script>alert(1)</script><![endif]-->', /Scripts are not allowed/, 'script inside conditional comment rejected');
rejects('<a {{recipient_name}}>x</a>', /placeholders can only be used/, 'placeholder as attribute name rejected');
rejects('<a href="{{recipient_name}}">x</a>', /placeholder can't be the start of a URL/, 'placeholder at URL start rejected');
rejects('<p style="color:{{recipient_name}}">x</p>', /Placeholders are not allowed inside CSS/, 'placeholder inside CSS rejected');

test('CSS field: </style> breakout, http url and placeholders rejected', () => {
  assert.match(errorsOf({ css: 'p{}</style><script>alert(1)</script>' }), /may not contain "<"/);
  assert.match(errorsOf({ css: 'p{background:url(http://x/a.png)}' }), /https/);
  assert.match(errorsOf({ css: '@import url(http://x/a.css);' }), /@import must use an https/);
});

test('unknown placeholders and bad subjects rejected', () => {
  assert.match(errorsOf({ html: '<p>Hi {{first_name}}</p>' }), /Unknown placeholder \{\{first_name\}\}/);
  assert.match(errorsOf({ subject: 'Hi\nBcc: x@y.z' }), /single line/);
  assert.match(errorsOf({ subject: '' }), /subject is required/);
  assert.match(errorsOf({ html: '' }), /HTML body is required/);
});

// ------------------------------------------------------- personalization ---
test('recipient name is substituted and HTML-escaped; template object untouched', () => {
  const template = Object.freeze({ ...base, html: '<p title="{{recipient_name}}">Hello {{recipient_name}}, {{recipient_email}}</p>' });
  const nasty = `<img src=x onerror=alert(1)> "Bob" & 'Al' $& $1`;
  const out = renderEmail(template, { name: nasty, email: 'a@b.co' });
  assert.equal(out.errors, undefined);
  assert.match(out.html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;Bob&quot; &amp; &#39;Al&#39; \$&amp; \$1/);
  assert.doesNotMatch(out.html, /<img/);
  assert.equal(out.subject, `Hello ${nasty}`);
  assert.equal(template.html, '<p title="{{recipient_name}}">Hello {{recipient_name}}, {{recipient_email}}</p>');
});

test('name like "javascript:" in a URL query is caught by post-render validation', () => {
  const template = { ...base, html: '<a href="https://x.example/?n={{recipient_name}}">x</a>' };
  assert.ok(renderEmail(template, { name: 'Ann', email: 'a@b.co' }).html.includes('?n=Ann'));
  assert.ok(renderEmail(template, { name: 'javascript:alert(1)', email: 'a@b.co' }).errors?.length);
});

test('placeholder values are inserted once, never re-expanded', () => {
  const out = renderEmail(base, { name: '{{recipient_email}}', email: 'a@b.co' });
  assert.match(out.html, /Hello \{\{recipient_email\}\},/);
});

test('test mode prefixes the subject and marks the text body', () => {
  const out = renderEmail({ ...base, text: 'Hi {{recipient_name}}' }, { name: 'Test Recipient', email: 't@b.co' }, { test: true });
  assert.equal(out.subject, `${TEST_SUBJECT_PREFIX}Hello Test Recipient`);
  assert.match(out.text, /^\[TEST EMAIL\]/);
});

test('CSS field is injected into <head>', () => {
  assert.match(injectCss('<html><head><title>x</title></head><body></body></html>', 'p{color:red}'), /<style type="text\/css">\np\{color:red\}\n<\/style>\n<\/head>/);
  assert.match(injectCss('<p>x</p>', 'p{}'), /^<style/);
  assert.equal(injectCss('<p>x</p>', '  '), '<p>x</p>');
});

// ------------------------------------------------------------ recipients ---
test('recipient validation: exactly one address, sane name', () => {
  assert.ok(validateRecipient({ name: 'Arjun', email: 'arjun@example.com' }).recipient);
  for (const email of ['a@b.co,c@d.co', 'a@b.co; c@d.co', 'Arjun <a@b.co>', 'a b@c.co', 'a@b', '', 'a@@b.co', 'a@b..co', `${'x'.repeat(65)}@b.co`]) {
    assert.ok(validateEmailAddress(email).error, `should reject ${JSON.stringify(email)}`);
  }
  assert.ok(validateEmailAddress(['a@b.co']).error, 'arrays rejected');
  assert.ok(validateRecipient({ name: '', email: 'a@b.co' }).errors.name);
  assert.ok(validateRecipient({ name: 'x'.repeat(101), email: 'a@b.co' }).errors.name);
  assert.ok(validateRecipient({ name: 'Bob\r\nBcc: x', email: 'a@b.co' }).errors.name);
  assert.equal(validateRecipient({ name: '  Arjun   Rao ', email: ' arjun@example.com ' }).recipient.name, 'Arjun Rao');
});
