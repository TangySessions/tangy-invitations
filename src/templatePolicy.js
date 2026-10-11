// The one place that decides what a template may contain and how it is
// personalized. Used server-side for preview, save and send, so all three see
// exactly the same rules and the same rendered output.
//
// Policy: REJECT, never silently rewrite. A template containing anything on
// the list below cannot be saved, previewed as a draft, or sent; the admin
// gets the list of problems (with line numbers) and fixes the source.
//
//   Blocked elements   script, iframe, frame(set), object, embed, applet,
//                      form controls, base, link, svg, math, template,
//                      portal, audio/video/canvas, xmp/plaintext/noembed/
//                      noframes, param, dialog, slot
//   Blocked attributes every on* event handler, srcdoc, formaction,
//                      malformed attribute names, placeholders in names
//   URLs               links: https, http, mailto, tel, #fragment
//                      images: https, cid:, data:image/(png|jpeg|gif|webp)
//                      anything else (javascript:, vbscript:, data:text/html,
//                      obfuscated schemes) is rejected; entities and
//                      whitespace are decoded/stripped before checking
//   CSS                no expression(), javascript:, behavior, -moz-binding,
//                      backslash escapes or placeholders; url() and @import
//                      must be https (url() may also be data:image)
//   meta               http-equiv refresh / set-cookie rejected
//
// Comment contents (incl. Outlook conditional comments) are scanned as
// markup too. After personalization the final HTML is validated again, so a
// recipient value can never introduce something the policy forbids.

export const PLACEHOLDERS = Object.freeze(['recipient_name', 'recipient_email', 'number_of_people']);
// "Number of people" on a single invitation ({{number_of_people}}): a whole
// number; when not supplied (e.g. campaign emails) it is 1.
export const PEOPLE = Object.freeze({ min: 1, max: 50, def: 1 });

// Accepts only a JSON whole number in range (no strings, decimals, 0 or
// negatives); undefined/null means the default. Returns { people } or { error }.
export function validatePeople(value) {
  if (value === undefined || value === null) return { people: PEOPLE.def };
  if (!Number.isSafeInteger(value) || value < PEOPLE.min || value > PEOPLE.max) {
    return { error: `Enter the number of people as a whole number from ${PEOPLE.min} to ${PEOPLE.max}.` };
  }
  return { people: value };
}
export const TEST_RECIPIENT_NAME = 'Test Recipient';
export const TEST_SUBJECT_PREFIX = '[TEST] ';
export const NO_TEMPLATE_MESSAGE = 'No email template has been configured yet. Configure and save the email template before sending.';
export const noTemplateMessage = (label) => `No email template has been configured yet for ${label}. Configure and save the email template before sending.`;
export const LIMITS = Object.freeze({ subject: 200, html: 500_000, css: 100_000, text: 100_000, name: 100, email: 254, sessionName: 80 });

const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const BLOCKED_TAGS = new Map(Object.entries({
  script: 'Scripts are not allowed.',
  iframe: 'Embedded frames are not allowed.',
  frame: 'Frames are not allowed.',
  frameset: 'Frames are not allowed.',
  object: 'Embedded objects are not allowed.',
  embed: 'Embedded objects are not allowed.',
  applet: 'Applets are not allowed.',
  param: 'Embedded object parameters are not allowed.',
  form: 'Forms are not allowed in emails.',
  input: 'Form controls are not allowed in emails.',
  button: 'Form controls are not allowed — use a styled link for buttons.',
  textarea: 'Form controls are not allowed in emails.',
  select: 'Form controls are not allowed in emails.',
  option: 'Form controls are not allowed in emails.',
  base: '<base> can redirect every link and is not allowed.',
  link: 'External stylesheets (<link>) are not allowed — use inline styles or a <style> block in <head>.',
  svg: 'Inline SVG is not allowed (it can carry scripts and most email clients drop it) — use an https image.',
  math: 'MathML is not allowed.',
  template: '<template> is not allowed.',
  portal: '<portal> is not allowed.',
  audio: 'Audio is not supported in email.',
  video: 'Video is not supported in email — link to it instead.',
  canvas: 'Canvas is not supported in email.',
  dialog: '<dialog> is not allowed.',
  slot: '<slot> is not allowed.',
  xmp: '<xmp> is not allowed.',
  plaintext: '<plaintext> is not allowed.',
  noembed: '<noembed> is not allowed.',
  noframes: '<noframes> is not allowed.',
}));

const LINK_ATTRS = new Set(['href', 'cite', 'longdesc', 'action', 'xlink:href', 'data', 'codebase', 'usemap']);
const IMAGE_ATTRS = new Set(['src', 'background', 'poster', 'lowsrc', 'dynsrc']);
const LINK_SCHEMES = new Set(['https', 'http', 'mailto', 'tel']);
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i;
// Images hosted by the local development store (src/assets.js) — the only
// http image URLs accepted. Real sending refuses them (liveImageProblem).
const LOCAL_ASSET_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/api\/assets\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/i;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', nbsp: String.fromCharCode(0xa0),
  sol: '/', lpar: '(', rpar: ')', bsol: '\\', num: '#', period: '.', comma: ',', semi: ';', equals: '=',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]);
}

// Line number lookup for error messages.
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

class Issues {
  constructor() { this.list = []; }
  error(field, message, line) { this.add('error', field, message, line); }
  warning(field, message, line) { this.add('warning', field, message, line); }
  add(level, field, message, line) {
    if (this.list.some((i) => i.level === level && i.field === field && i.message === message && i.line === line)) return;
    this.list.push(line ? { level, field, message, line } : { level, field, message });
  }
  get errors() { return this.list.filter((i) => i.level === 'error'); }
  get warnings() { return this.list.filter((i) => i.level === 'warning'); }
}

// ---------------------------------------------------------------- URLs ----

// Control, whitespace, zero-width and BOM characters browsers ignore inside URLs.
const STRIP_URL_CHARS = new RegExp(`[${['0000-0020', '007f-009f', '00a0', '00ad', '1680', '180e', '2000-200f', '2028', '2029', '202f', '205f', '3000', 'feff']
  .map((r) => r.split('-').map((h) => String.fromCharCode(parseInt(h, 16))).join('-')).join('')}]`, 'g');

function checkUrl(kind, raw, issues, field, line, attr) {
  const v = decodeEntities(raw).replace(STRIP_URL_CHARS, '');
  if (!v) return;
  if (/^\{\{/.test(v)) {
    issues.error(field, `A placeholder can't be the start of a URL (${attr}). Write the full https:// address and put the placeholder after it.`, line);
    return;
  }
  const m = /^([^:/?#]*):/.exec(v);
  if (!m) {
    if (!v.startsWith('#')) issues.warning(field, `Relative URL "${raw.slice(0, 60)}" (${attr}) won't work in an email — use a full https:// address.`, line);
    return;
  }
  const scheme = m[1].toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    issues.error(field, `Unrecognised or obfuscated URL in ${attr}: "${raw.slice(0, 60)}".`, line);
    return;
  }
  if (kind === 'image') {
    if (scheme === 'https' || scheme === 'cid') return;
    if (scheme === 'http' && LOCAL_ASSET_RE.test(v)) return;
    if (scheme === 'http') { issues.error(field, `Images must use https:// (${attr}="${raw.slice(0, 60)}").`, line); return; }
    if (scheme === 'data' && DATA_IMAGE_RE.test(v)) {
      issues.warning(field, 'Embedded data: images are blocked by Gmail and others — prefer an https image URL.', line);
      return;
    }
    issues.error(field, `"${scheme}:" URLs are not allowed for images (${attr}).`, line);
    return;
  }
  if (!LINK_SCHEMES.has(scheme)) issues.error(field, `"${scheme}:" URLs are not allowed (${attr}). Use https, http, mailto or tel.`, line);
}

// ----------------------------------------------------------------- CSS ----

export function checkCss(css, issues, field, line = undefined, { standalone = false } = {}) {
  if (!css) return;
  if (standalone && css.includes('<')) issues.error(field, 'The CSS field may not contain "<" (no HTML or </style> in CSS).', line);
  if (css.includes('\\')) issues.error(field, 'CSS escape sequences (backslashes) are not allowed.', line);
  // Matches a whole {{…}}; nested CSS blocks legitimately end in "}}".
  if (/\{\{[^{}]*\}\}/.test(css)) issues.error(field, 'Placeholders are not allowed inside CSS.', line);
  if (/expression\s*\(/i.test(css)) issues.error(field, 'CSS expression() is not allowed.', line);
  if (/(javascript|vbscript)\s*:/i.test(css)) issues.error(field, 'Script URLs are not allowed in CSS.', line);
  if (/behavior\s*:|-moz-binding/i.test(css)) issues.error(field, 'CSS behaviors/bindings are not allowed.', line);
  const opens = (css.match(/url\s*\(/gi) || []).length;
  const urls = [...css.matchAll(/url\s*\(([^)]*)\)/gi)];
  if (opens !== urls.length) issues.error(field, 'Malformed url() in CSS.', line);
  for (const u of urls) checkUrl('image', u[1].trim().replace(/^['"]|['"]$/g, ''), issues, field, line, 'CSS url()');
  for (const imp of css.matchAll(/@import\s+(?:url\s*\()?\s*['"]?([^'")\s;]*)/gi)) {
    const target = imp[1].replace(STRIP_URL_CHARS, '');
    if (!/^https:\/\//i.test(target)) issues.error(field, '@import must use an https:// URL.', line);
    else issues.warning(field, '@import is ignored by many email clients (including Gmail) — inline the styles you depend on.', line);
  }
}

// ---------------------------------------------------------------- HTML ----

function checkTag(name, attrs, issues, field, line) {
  const blocked = BLOCKED_TAGS.get(name);
  if (blocked) issues.error(field, `<${name}>: ${blocked}`, line);
  for (const { name: an, value } of attrs) {
    if (!/^[a-z_:][a-z0-9_:.-]*$/.test(an)) {
      issues.error(field, an.includes('{{')
        ? `<${name}>: placeholders can only be used inside attribute values or text, not as attributes.`
        : `<${name}>: malformed attribute name "${an.slice(0, 40)}".`, line);
      continue;
    }
    if (an.startsWith('on')) { issues.error(field, `<${name}>: event-handler attributes (${an}) are not allowed.`, line); continue; }
    if (an === 'srcdoc' || an === 'formaction') { issues.error(field, `<${name}>: the ${an} attribute is not allowed.`, line); continue; }
    if (value == null) continue;
    if (an === 'style') checkCss(decodeEntities(value), issues, field, line);
    else if (IMAGE_ATTRS.has(an)) checkUrl('image', value, issues, field, line, an);
    else if (LINK_ATTRS.has(an)) checkUrl('link', value, issues, field, line, an);
    else if (an === 'srcset') {
      for (const part of decodeEntities(value).split(',')) {
        const url = part.trim().split(/\s+/)[0];
        if (url) checkUrl('image', url, issues, field, line, 'srcset');
      }
    } else if (an === 'http-equiv' && /^\s*(refresh|set-cookie)\s*$/i.test(decodeEntities(value))) {
      issues.error(field, `<meta http-equiv="${value}"> is not allowed.`, line);
    }
  }
}

function scanHtml(html, issues, field, lineOf, offset = 0) {
  const n = html.length;
  const ws = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    // Comments: their contents are scanned as markup too (Outlook renders
    // conditional comments, and it removes any parser-differential games).
    if (html.startsWith('<!--', lt)) {
      let end;
      if (html.startsWith('<!-->', lt)) end = lt + 5;
      else if (html.startsWith('<!--->', lt)) end = lt + 6;
      else {
        const a = html.indexOf('-->', lt + 4);
        const b = html.indexOf('--!>', lt + 4);
        const close = a === -1 ? b : b === -1 ? a : Math.min(a, b);
        const bodyEnd = close === -1 ? n : close;
        scanHtml(html.slice(lt + 4, bodyEnd), issues, field, lineOf, offset + lt + 4);
        end = close === -1 ? n : close + (close === b ? 4 : 3);
      }
      i = end;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') { // doctype, <![endif]>, CDATA, PIs
      const gt = html.indexOf('>', lt);
      i = gt === -1 ? n : gt + 1;
      continue;
    }
    let j = lt + 1;
    const closing = html[j] === '/';
    if (closing) j++;
    const m = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(j, j + 80));
    if (!m) { i = lt + 1; continue; } // a literal "<" in text
    const name = m[0].toLowerCase();
    j += m[0].length;
    const attrs = [];
    while (j < n) {
      while (j < n && (ws(html[j]) || html[j] === '/')) j++;
      if (j >= n || html[j] === '>') break;
      let k = j;
      while (k < n && !ws(html[k]) && html[k] !== '/' && html[k] !== '>' && (html[k] !== '=' || k === j)) k++;
      if (k === j) k++;
      const an = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && ws(html[j])) j++;
      let value = null;
      if (html[j] === '=') {
        j++;
        while (j < n && ws(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          value = html.slice(j + 1, e === -1 ? n : e);
          j = e === -1 ? n : e + 1;
        } else {
          let e = j;
          while (e < n && !ws(html[e]) && html[e] !== '>') e++;
          value = html.slice(j, e);
          j = e;
        }
      }
      attrs.push({ name: an, value });
    }
    const line = lineOf(offset + lt);
    i = j + 1;
    if (closing) continue;
    checkTag(name, attrs, issues, field, line);
    if (name === 'style') {
      // Raw text up to </style, exactly as a browser parses it.
      const close = html.toLowerCase().indexOf('</style', i);
      checkCss(html.slice(i, close === -1 ? n : close), issues, field, line);
      i = close === -1 ? n : close;
    }
  }
}

export function validateHtml(html, issues = new Issues(), field = 'html') {
  if (html.includes('\u0000')) issues.error(field, 'The HTML contains a NUL character.');
  // Belt and braces over the raw source (catches text the tokenizer treats as
  // content, e.g. inside <title>). Plain-text mentions are vanishingly rare in
  // real emails; if one trips this, reword it.
  if (/(javascript|vbscript)\s*:/i.test(html)) issues.error(field, 'Remove "javascript:"/"vbscript:" — script URLs are not allowed anywhere in the HTML.');
  if (/data\s*:\s*text\/html/i.test(html)) issues.error(field, 'data:text/html URLs are not allowed.');
  scanHtml(html, issues, field, lineIndex(html));
  return issues;
}

function checkPlaceholders(value, field, issues) {
  for (const m of String(value).matchAll(PLACEHOLDER_RE)) {
    if (!PLACEHOLDERS.includes(m[1])) {
      issues.error(field, `Unknown placeholder {{${m[1]}}}. Supported: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}.`);
    }
  }
}

const hasControlChars = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

// Validates a template as typed by the admin. Returns { errors, warnings }.
export function validateTemplate(t) {
  const issues = new Issues();
  const subject = typeof t?.subject === 'string' ? t.subject : null;
  const html = typeof t?.html === 'string' ? t.html : null;
  const css = typeof t?.css === 'string' ? t.css : t?.css == null ? '' : null;
  const text = typeof t?.text === 'string' ? t.text : t?.text == null ? '' : null;
  if (subject === null || html === null || css === null || text === null) {
    issues.error('template', 'Subject and HTML are required; CSS and plain text must be text.');
    return { errors: issues.errors, warnings: issues.warnings };
  }
  if (!subject.trim()) issues.error('subject', 'The subject is required.');
  if (subject.length > LIMITS.subject) issues.error('subject', `The subject is longer than ${LIMITS.subject} characters.`);
  if (/[\r\n]/.test(subject) || hasControlChars(subject)) issues.error('subject', 'The subject must be a single line without control characters.');
  if (!html.trim()) issues.error('html', 'The HTML body is required.');
  if (html.length > LIMITS.html) issues.error('html', `The HTML is larger than ${LIMITS.html.toLocaleString('en')} characters.`);
  if (css.length > LIMITS.css) issues.error('css', `The CSS is larger than ${LIMITS.css.toLocaleString('en')} characters.`);
  if (text.length > LIMITS.text) issues.error('text', `The plain text is larger than ${LIMITS.text.toLocaleString('en')} characters.`);
  if (hasControlChars(text)) issues.error('text', 'The plain text contains control characters.');
  checkPlaceholders(subject, 'subject', issues);
  checkPlaceholders(html, 'html', issues);
  checkPlaceholders(text, 'text', issues);
  if (html.length <= LIMITS.html) validateHtml(html, issues, 'html');
  if (css.length <= LIMITS.css) checkCss(css, issues, 'css', undefined, { standalone: true });
  if (html && !/<(html|body|table|div|p|h[1-6])\b/i.test(html)) issues.warning('html', 'This does not look like an HTML email (no html/body/table/div/p/heading tags).');
  if (!/\{\{\s*recipient_name\s*\}\}/.test(subject + html + text)) issues.warning('html', 'The template does not use {{recipient_name}}, so every recipient gets identical content.');
  return { errors: issues.errors, warnings: issues.warnings };
}

// The admin-facing display name of a session (shown in the dashboard,
// confirmation and send log — never inserted into the email).
export function validateSessionName(value) {
  if (typeof value !== 'string' || !value.trim()) return { error: 'Give the session a name.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length > LIMITS.sessionName) return { error: `Keep the session name under ${LIMITS.sessionName} characters.` };
  if (hasControlChars(name)) return { error: 'The session name contains invalid characters.' };
  return { name };
}

// --------------------------------------------------------- recipients ----

// One address, nothing that could smuggle a second recipient or a header.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_{|}~'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function validateEmailAddress(value) {
  if (typeof value !== 'string') return { error: 'Enter one email address.' };
  const email = value.trim();
  if (!email) return { error: 'Enter the recipient email address.' };
  if (/[,;\s<>]/.test(email)) return { error: 'Enter exactly one email address (no lists, spaces or names).' };
  if (email.length > LIMITS.email || !EMAIL_RE.test(email) || email.split('@')[0].length > 64 || email.includes('..')) {
    return { error: 'Enter a valid email address.' };
  }
  return { email };
}

// C0/C1 control characters and the Unicode line/paragraph separators.
const NAME_FORBIDDEN = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);

export function validateRecipient({ name, email }) {
  const errors = {};
  let cleanName = '';
  if (typeof name !== 'string' || !name.trim()) errors.name = 'Enter the recipient name.';
  else {
    cleanName = name.trim().replace(/\s+/g, ' ');
    if (cleanName.length > LIMITS.name) errors.name = `Keep the name under ${LIMITS.name} characters.`;
    else if (NAME_FORBIDDEN.test(name)) errors.name = 'The name contains invalid characters.';
    else if (/\{\{|\}\}/.test(cleanName)) errors.name = 'The name may not contain {{ or }}.';
  }
  const e = validateEmailAddress(email);
  if (e.error) errors.email = e.error;
  return Object.keys(errors).length ? { errors } : { recipient: { name: cleanName, email: e.email } };
}

// ---------------------------------------------------------- rendering ----

function substitute(str, values, encode) {
  // Single pass with a function replacer: values are never re-scanned, and
  // "$&"-style sequences in a name are inserted literally.
  return String(str).replace(PLACEHOLDER_RE, (m, key) => (Object.hasOwn(values, key) ? encode(values[key]) : m));
}

export function injectCss(html, css) {
  if (!css || !css.trim()) return html;
  const block = `<style type="text/css">\n${css}\n</style>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (m) => `${block}\n${m}`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${block}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${block}</head>`);
  return `${block}\n${html}`;
}

// Builds the outgoing message from the saved template. Never mutates the
// template. Returns { subject, html, text } or { errors }.
// A readable plain-text version of a rendered HTML email, for templates
// without their own plain text (campaign sends). Drops <head>, styles,
// comments and the hidden preheader; keeps link targets in brackets.
export function htmlToText(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<div\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div\s*>/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*"((?:https:|mailto:)[^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (m, href, inner) => `${inner} (${href.replace(/^mailto:/i, '')})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|li|table)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(text)
    .split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Campaign (invitation) emails always end with a visible unsubscribe link —
// added by the server, so no template can omit it. `url` is built by the
// server from APP_ORIGIN (src/unsubscribe.js) — https in production; real
// campaign sending refuses a non-https origin (src/campaigns.js), so http
// only ever appears in local dry runs. It is HTML-escaped anyway.
export function addUnsubscribeFooter(rendered, url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Unsubscribe URL must be an http(s) address.');
  const block = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:14px 12px 26px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:17px;color:#8a8a8a">You received this invitation from Tangy Sessions. <a href="${escapeHtml(url)}" style="color:#8a8a8a;text-decoration:underline">Unsubscribe</a> from future invitations.</td></tr></table>`;
  const html = /<\/body\s*>/i.test(rendered.html) ? rendered.html.replace(/<\/body\s*>/i, (m) => `${block}\n${m}`) : `${rendered.html}\n${block}`;
  const line = `You received this invitation from Tangy Sessions. Unsubscribe from future invitations: ${url}`;
  return { ...rendered, html, text: rendered.text ? `${rendered.text}\n\n${line}` : line };
}

// Resend's documented maximum email size (message including attachments).
export const PROVIDER_MAX_EMAIL_BYTES = 40 * 1024 * 1024;
// Gmail clips HTML bodies above about 102 KB ("[Message clipped]").
export const GMAIL_CLIP_BYTES = 102 * 1024;

// For REAL sends: every image must be a hosted https URL (embedded data:
// images are blocked by Gmail; local-store http URLs only work on this
// machine), and the message must fit the provider's size limit. Returns a
// message, or null when the email may be sent.
export function liveImageProblem(rendered) {
  const html = rendered.html;
  const img = /(?:\b(?:src|background)\s*=\s*["']?|url\(\s*["']?)\s*(data:|http:)/i.exec(html);
  if (img) {
    return img[1].toLowerCase() === 'data:'
      ? 'This email still embeds images as data: URLs (Gmail blocks them). Re-save the template so its images are hosted, then preview again.'
      : 'This email references images on the local development store (http://localhost), which recipients cannot load. Host the images (ASSET_STORE=supabase), re-save the template, then preview again.';
  }
  const size = Buffer.byteLength(html) + Buffer.byteLength(rendered.text || '') + Buffer.byteLength(rendered.subject || '');
  if (size > PROVIDER_MAX_EMAIL_BYTES - 64 * 1024) return 'This email is larger than the provider allows (40 MB).';
  return null;
}

// autoText: when the template has no plain text, derive it from the HTML.
export function renderEmail(template, recipient, { test = false, autoText = false } = {}) {
  const values = { recipient_name: recipient.name, recipient_email: recipient.email, number_of_people: String(recipient.people ?? PEOPLE.def) };
  const plain = (v) => String(v).replace(/[\r\n]+/g, ' ');
  const subject = (test ? TEST_SUBJECT_PREFIX : '') + substitute(template.subject, values, plain);
  const html = injectCss(substitute(template.html, values, escapeHtml), template.css || '');
  const textBody = template.text ? substitute(template.text, values, String) : (autoText ? htmlToText(html) : '');
  const text = textBody ? (test ? `[TEST EMAIL]\n\n${textBody}` : textBody) : undefined;

  // Re-validate the final message: the placeholder values must not have
  // introduced anything the policy forbids.
  const issues = new Issues();
  validateHtml(html, issues, 'html');
  // 998 = the RFC 5322 line-length limit.
  if (/[\r\n]/.test(subject) || hasControlChars(subject) || subject.length > 998) {
    issues.error('subject', 'The personalized subject is invalid.');
  }
  if (issues.errors.length) return { errors: issues.errors };
  return { subject, html, text };
}
