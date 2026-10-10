// Client for the Invitation Sender. It holds no secrets and makes no security
// decisions: the server authenticates every call, loads the selected
// session's saved template itself for every send, requires a matching
// preview, and validates everything again.

const $ = (id) => document.getElementById(id);
const state = {
  csrf: null,
  admin: null,
  status: null,
  sessions: [],          // summaries of s1–s4 (no HTML)
  editing: null,         // { id, saved } — the session open in the editor
  preview: null,         // the last send-authorizing preview (see previewInvitation)
  shown: null,           // what the preview panel currently displays
  sending: false,
  stats: null,           // send-log counts from /api/sends (what the app recorded)
  review: null,          // the last /api/campaigns/review result (memory only; never stored)
  reviewPage: 0,
  reviewCsv: null,       // the exact CSV text that review describes
  reviewKey: null,       // confirmation id for this review (repeated confirms → one campaign)
  campaign: null,        // { id, data, page, filter } — the campaign page that is open
  pump: null,            // timer of the sending loop (only while a campaign page is open)
};

// ------------------------------------------------------------------ api --
class ApiError extends Error {
  constructor(message, status, data, network = false) {
    super(message);
    Object.assign(this, { status, data, network });
  }
}

async function api(method, path, body, { timeoutMs = 30_000 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf && method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  let res;
  try {
    res = await fetch(path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ApiError(err?.name === 'TimeoutError' ? 'The server did not answer in time.' : 'Network error — could not reach the server.', 0, null, true);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && path !== '/api/login') {
    showLogin('Your session ended. Sign in again.');
    throw new ApiError('Sign in required.', 401, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status}).`, res.status, data);
  return data;
}

// ---------------------------------------------------------------- views --
function show(view) {
  $('boot').hidden = view !== 'boot';
  $('login-view').hidden = view !== 'login';
  $('app-view').hidden = view !== 'app';
}

function showLogin(message = '') {
  state.csrf = null;
  state.admin = null;
  state.editing = null;
  state.preview = null;
  show('login');
  const err = $('login-error');
  err.textContent = message;
  err.hidden = !message;
  $('login-password').value = '';
  $('login-email').focus();
}

async function enterApp(session) {
  state.csrf = session.csrf_token;
  state.admin = session.admin;
  $('who').textContent = `Signed in as ${session.admin.email}`;
  show('app');
  await Promise.all([loadStatus(), loadSessions(), loadSends(), loadCampaigns()]);
  if (!state.editing && state.sessions.length) await openEditor(state.sessions[0].id, { scroll: false });
}

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
};

// --------------------------------------------------------------- status --
async function loadStatus(refresh = false) {
  const strip = $('status-strip');
  try {
    state.status = await api('GET', `/api/status${refresh ? '?refresh=1' : ''}`);
  } catch (err) {
    if (err.status === 401) return;
    strip.replaceChildren(pill('bad', `Could not load email status: ${err.message}`));
    return;
  }
  const e = state.status.email;
  renderModeBanner(e);
  const items = [];
  if (e.dryRun) items.push(pill('dark', 'Dry-run mode — nothing is sent'));
  else if (e.configured) items.push(pill('good', 'Resend configured'));
  else items.push(pill('bad', `Email not configured — missing ${e.missing.join(', ')}`));
  items.push(pill(e.from ? 'plain' : 'bad', `From: ${e.from || 'not set (EMAIL_FROM)'}`));
  const s = e.sender;
  if (s && s.state !== 'dry_run') {
    items.push(pill(s.state === 'verified' ? 'good' : s.state === 'not_verified' ? 'bad' : 'warn', `Sender domain: ${s.message}`));
  }
  strip.replaceChildren(...items, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => loadStatus(true) }, 'Re-check'));
}

function renderModeBanner(e) {
  const banner = $('mode-banner');
  if (e.dryRun) {
    banner.className = 'mode-banner';
    banner.replaceChildren(el('span', { class: 'mode-tag' }, 'DRY RUN'),
      el('span', {}, 'No real email is sent. Every send is fully checked and logged, but Resend is never called.'));
    banner.hidden = false;
  } else if (e.configured) {
    banner.className = 'mode-banner live';
    banner.replaceChildren(el('span', { class: 'mode-tag' }, 'LIVE'), el('span', {}, 'Sends deliver real email through Resend.'));
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function pill(tone, text) {
  return el('span', { class: `pill ${tone}` }, text);
}

// ------------------------------------------------------------- sessions --
const sessionById = (id) => state.sessions.find((s) => s.id === id);

function statusOf(s) {
  if (!s.configured) return { cls: 'none', text: 'Not configured' };
  if (!s.active) return { cls: 'off', text: 'Off' };
  return { cls: 'good', text: 'Available' };
}
const shortTime = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function loadSessions() {
  try {
    ({ sessions: state.sessions } = await api('GET', '/api/sessions'));
  } catch (err) {
    if (err.status !== 401) $('session-cards').replaceChildren(el('li', { class: 'alert alert-bad' }, `Could not load sessions: ${err.message}`));
    return;
  }
  renderCards();
  renderWorkspaceList();
  renderSelect();
  renderSummary();
}

function renderCards() {
  $('session-cards').replaceChildren(...state.sessions.map((s) => {
    const st = statusOf(s);
    const selected = state.editing?.id === s.id;
    return el('li', { class: 'session-card', dataset: { session: s.id, selected: String(selected) } },
      el('div', { class: 'slot-row' },
        el('span', { class: 'slot-num' }, `Session ${s.slot}`),
        selected ? el('span', { class: 'pill lime plain' }, 'Selected') : null),
      el('p', { class: `name${s.configured ? '' : ' unset'}` }, s.configured ? s.name : 'Not configured yet'),
      el('div', { class: 'badges' },
        el('span', { class: `pill ${s.configured ? 'saved' : 'none'}` }, s.configured ? `Configured · v${s.version}` : 'Not configured'),
        s.configured ? el('span', { class: `pill ${s.active ? 'good' : 'off'}` }, s.active ? 'Available for sending' : 'Off — not sendable') : null),
      s.configured ? el('p', { class: 'subject' }, el('span', { class: 'label' }, 'Subject'), s.subject) : null,
      el('p', { class: 'meta' }, s.updated_at
        ? `Updated ${shortTime(s.updated_at)}${s.updated_by ? ` by ${s.updated_by}` : ''}`
        : 'No template saved yet.'),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'btn btn-sm btn-dark', onclick: () => openEditor(s.id), 'aria-label': `${s.configured ? 'Edit' : 'Configure'} ${s.label}` }, s.configured ? 'Edit' : 'Configure'),
        el('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled: !s.configured, onclick: () => previewCard(s.id), 'aria-label': `Preview ${s.label}` }, 'Preview')));
  }));
}

// Dark workspace: the four sessions as a compact list; the selected one is
// open in the editor next to it.
function renderWorkspaceList() {
  $('ws-list').replaceChildren(...state.sessions.map((s) => {
    const st = statusOf(s);
    const current = state.editing?.id === s.id;
    return el('li', {}, el('button', {
      type: 'button', class: 'ws-item', 'aria-current': current ? 'true' : null,
      onclick: () => openEditor(s.id, { scroll: false }),
    },
    el('span', { class: 'ws-num', 'aria-hidden': 'true' }, String(s.slot)),
    el('span', { class: 'ws-name' }, s.configured ? s.name : `Session ${s.slot}`),
    el('span', { class: 'ws-status' }, s.configured ? `${st.text} · v${s.version}` : 'Not configured')));
  }));
}

// Only figures the app actually records. Delivery is not known here.
function renderSummary() {
  const sessions = state.sessions;
  const configured = sessions.filter((s) => s.configured).length;
  const available = sessions.filter((s) => s.configured && s.active).length;
  const st = state.stats;
  const tile = (label, value, sub, feature = false) => el('li', { class: `stat${feature ? ' feature' : ''}` },
    el('span', { class: 'stat-label' }, label), value, el('span', { class: 'stat-sub' }, sub));
  const num = (n, of) => el('span', { class: 'stat-value' }, String(n), of ? el('span', { class: 'of' }, ` / ${of}`) : null);
  $('summary').replaceChildren(
    tile('Configured sessions', num(configured, 4), configured === 4 ? 'All slots have a saved template' : `${4 - configured} slot${4 - configured === 1 ? '' : 's'} not configured`),
    tile('Available for sending', num(available, 4), available ? sessions.filter((s) => s.configured && s.active).map((s) => `S${s.slot}`).join(' · ') : 'Configure a session to start', true),
    tile('Invitation attempts', st ? num(st.total) : el('span', { class: 'stat-value text' }, 'Unavailable'),
      st ? `${st.total - st.tests} invitations · ${st.tests} tests${st.dry_run ? ` · ${st.dry_run} dry run` : ''}` : 'Could not load the send log'),
    tile('Recent activity', st ? num(st.last_24h) : el('span', { class: 'stat-value text' }, 'Unavailable'),
      st ? (st.last_at ? `attempts in the last 24 h · last ${shortTime(st.last_at)}` : 'attempts in the last 24 h · none yet') : ''));
}

function renderSelect() {
  const select = $('send-session');
  const previous = select.value;
  select.replaceChildren(...state.sessions.map((s) => el('option', { value: s.id },
    `Session ${s.slot} — ${s.configured ? s.name : 'not configured'}${s.configured && !s.active ? ' (off)' : ''}`)));
  const firstReady = state.sessions.find((s) => s.configured && s.active);
  select.value = sessionById(previous) ? previous : (firstReady?.id || 's1');
  const rselect = $('review-session');
  const rprevious = rselect.value;
  rselect.replaceChildren(...state.sessions.map((s) => el('option', { value: s.id },
    `Session ${s.slot} — ${s.configured ? s.name : 'not configured'}${s.configured && !s.active ? ' (off)' : ''}`)));
  rselect.value = sessionById(rprevious) ? rprevious : select.value;
  renderSendState();
}

// ------------------------------------------------------- template editor --
// A template is ONE HTML document (styles inline or in a <style> block).
const tplFields = { name: 'tpl-name', subject: 'tpl-subject', html: 'tpl-html', text: 'tpl-text' };
// The server's limits (from /api/status; defaults until it loads). Checked
// here only to explain a problem before uploading — the server decides.
// import_bytes: a whole imported document including embedded images (they
// are moved to the image store on save); html: the stored document after that.
const serverLimits = () => ({ import_bytes: 4 * 1024 * 1024, html: 500_000, images: 50, ...(state.status?.limits || {}) });
const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

// Templates saved before the CSS field was removed: show their CSS inside
// the HTML exactly where the server's renderer (injectCss in
// src/templatePolicy.js) puts it, so the email is unchanged.
function mergeLegacyCss(html, css) {
  if (!css || !css.trim()) return html;
  const block = `<style type="text/css">\n${css}\n</style>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (m) => `${block}\n${m}`);
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${block}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n<head>${block}</head>`);
  return `${block}\n${html}`;
}

// What the editor shows for a saved session (legacy CSS merged into the HTML).
const editorValues = (s) => ({ name: s?.name ?? '', subject: s?.subject ?? '', html: mergeLegacyCss(s?.html ?? '', s?.css ?? ''), text: s?.text ?? '' });

function readDraft() {
  return { ...Object.fromEntries(Object.entries(tplFields).map(([k, id]) => [k, $(id).value])), active: $('tpl-active').checked };
}

function isDirty() {
  if (!state.editing) return false;
  const d = readDraft();
  const s = state.editing.saved;
  const shown = editorValues(s);
  return Object.keys(tplFields).some((k) => d[k] !== shown[k]) || d.active !== (s.configured ? s.active : true);
}

function fillEditor(s) {
  const v = editorValues(s);
  for (const [k, id] of Object.entries(tplFields)) $(id).value = v[k];
  $('tpl-active').checked = s?.configured ? s.active : true;
  $('tpl-css-merged').hidden = !(s?.css && s.css.trim());
  renderHtmlSize();
}

// Counting without a regex over the whole (possibly multi-MB) document.
function countEmbedded(html) {
  let n = 0;
  for (let i = html.indexOf('data:image/'); i !== -1; i = html.indexOf('data:image/', i + 11)) n++;
  return n;
}

// Debounced: typing in a multi-megabyte document stays responsive.
let sizeTimer = null;
function renderHtmlSize({ now = false } = {}) {
  clearTimeout(sizeTimer);
  if (!now) { sizeTimer = setTimeout(() => renderHtmlSize({ now: true }), 250); return; }
  const html = $('tpl-html').value;
  const lim = serverLimits();
  const bytes = utf8Bytes(html);
  const images = countEmbedded(html);
  const store = state.status?.asset_store;
  $('tpl-html-size').textContent = html
    ? `${kb(bytes)} of ${kb(lim.import_bytes)}${images ? ` · ${images} embedded image${images === 1 ? '' : 's'} — ${store === 'none' ? 'image hosting is NOT configured, so saving will be refused' : 'hosted automatically when you save (the stored HTML gets https image links)'}` : ''}`
    : '';
  $('tpl-html-size').className = `small ${bytes > lim.import_bytes || (images && store === 'none') ? 'field-error' : 'muted'}`;
}

// Explains an oversized template before it is sent (the server would answer
// 413 "Request is too large"). Returns an issue list, or null when it fits.
function templateSizeProblems(body) {
  const lim = serverLimits();
  const total = utf8Bytes(JSON.stringify(body));
  const d = body.draft || body;
  const issues = [];
  if (total > lim.import_bytes + 256 * 1024) {
    const parts = Object.keys(tplFields).map((k) => `${k} ${kb(utf8Bytes(d[k] || ''))}`).join(', ');
    issues.push({ level: 'error', field: 'template', message: `The template is ${kb(total)}; the limit is ${kb(lim.import_bytes)} including embedded images (${parts}). Use smaller images, or raise TEMPLATE_IMPORT_MAX_BYTES on the server.` });
  }
  const images = countEmbedded(d.html || '');
  if (images > lim.images) issues.push({ level: 'error', field: 'html', message: `The HTML embeds ${images} images; the limit is ${lim.images}.` });
  return issues.length ? issues : null;
}

// Imports a whole .html file into the editor (read locally; nothing is
// uploaded until Save or Preview).
async function importHtmlFile() {
  const file = $('tpl-import').files[0];
  $('tpl-import').value = '';
  if (!file) return;
  const lim = serverLimits();
  if (file.size > lim.import_bytes) {
    showIssues([{ level: 'error', field: 'html', message: `${file.name} is ${kb(file.size)}; the limit is ${kb(lim.import_bytes)} (TEMPLATE_IMPORT_MAX_BYTES).` }], 'Not imported');
    return;
  }
  const text = await file.text();
  if (!/<html[\s>]|<body[\s>]|<table[\s>]/i.test(text)) {
    showIssues([{ level: 'error', field: 'html', message: `${file.name} does not look like an HTML email.` }], 'Not imported');
    return;
  }
  $('tpl-html').value = text;
  showIssues([{ level: 'warning', field: 'html', message: `Imported ${file.name} (${kb(file.size)}, ${countEmbedded(text)} embedded image${countEmbedded(text) === 1 ? '' : 's'}). Preview it, then Save to host its images.` }], 'Imported — not saved yet');
  renderHtmlSize({ now: true });
  renderTemplateState();
}

function confirmDialog(dialog) {
  return new Promise((resolve) => {
    dialog.returnValue = '';
    const onClose = () => { dialog.removeEventListener('close', onClose); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

async function okToLeaveEditor() {
  if (!isDirty()) return true;
  $('dd-session').textContent = state.editing.saved.label;
  return confirmDialog($('discard-dialog'));
}

async function openEditor(id, { scroll = true } = {}) {
  if (state.editing?.id === id) { if (scroll) $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  if (!(await okToLeaveEditor())) return;
  let saved;
  try {
    ({ session: saved } = await api('GET', `/api/sessions/${id}`));
  } catch (err) {
    if (err.status !== 401) showResult('bad', `Could not open ${id}: ${err.message}`);
    return;
  }
  state.editing = { id, saved };
  fillEditor(saved);
  showIssues([]);
  $('editor-slot').textContent = `Session ${saved.slot}${saved.configured ? '' : ' · not configured yet'}`;
  $('editor-heading').textContent = saved.configured ? `Edit template — ${saved.name}` : `Configure Session ${saved.slot}`;
  $('editor').hidden = false;
  renderTemplateState();
  renderCards();
  renderWorkspaceList();
  if (scroll) {
    $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('tpl-name').focus({ preventScroll: true });
  }
}

function renderTemplateState() {
  if (!state.editing) return;
  const { saved } = state.editing;
  const dirty = isDirty();
  const badge = $('tpl-state');
  if (!saved.configured) {
    badge.className = `pill ${dirty ? 'unsaved' : 'none'}`;
    badge.textContent = dirty ? 'Not saved yet' : 'Not configured';
  } else {
    badge.className = `pill ${dirty ? 'unsaved' : 'saved'}`;
    badge.textContent = dirty ? 'Unsaved changes' : `Saved · v${saved.version}`;
  }
  $('tpl-revert').hidden = !dirty;
  $('tpl-meta').textContent = saved.configured
    ? `Version ${saved.version} saved ${new Date(saved.updated_at).toLocaleString()}${saved.updated_by ? ` by ${saved.updated_by}` : ''}. Saving changes only ${saved.label}.`
    : `Saving creates ${saved.label}'s first version. The other sessions are not affected.`;
  renderSendState();
}

function showIssues(issues, heading) {
  const box = $('tpl-issues');
  if (!issues || !issues.length) { box.hidden = true; box.replaceChildren(); return; }
  const errors = issues.filter((i) => i.level === 'error').length;
  box.replaceChildren(
    el('h3', { class: errors ? 'st-rejected' : 'st-ambiguous' }, heading || (errors ? `${errors} problem${errors === 1 ? '' : 's'} — not saved` : 'Warnings')),
    el('ul', {}, ...issues.map((i) => el('li', { class: i.level }, `${i.field ? `${i.field.toUpperCase()}${i.line ? ` line ${i.line}` : ''}: ` : ''}${i.message}`))));
  box.hidden = false;
}

async function saveTemplate(e) {
  e.preventDefault();
  if (!state.editing) return;
  const { id, saved } = state.editing;
  const btn = $('tpl-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const payload = { ...readDraft(), expected_version: saved.version };
  const tooBig = templateSizeProblems(payload);
  if (tooBig) {
    showIssues(tooBig, 'Too large — not saved');
    btn.disabled = false;
    btn.textContent = 'Save changes';
    return;
  }
  try {
    const data = await api('PUT', `/api/sessions/${id}`, payload);
    state.editing = { id, saved: data.session };
    fillEditor(data.session);
    $('editor-slot').textContent = `Session ${data.session.slot}`;
    $('editor-heading').textContent = `Edit template — ${data.session.name}`;
    const hosted = data.assets?.embedded
      ? [{ level: 'warning', field: 'html', message: `${data.assets.embedded} embedded image${data.assets.embedded === 1 ? '' : 's'} hosted (${data.assets.unique} unique, ${kb(data.assets.bytes)}); the saved HTML links to them.` }]
      : [];
    const all = [...hosted, ...(data.issues || [])];
    showIssues(all, all.length ? 'Saved' : undefined);
    // Any preview of this session is now stale.
    invalidatePreview(id);
    await loadSessions();
  } catch (err) {
    if (err.data?.issues) showIssues(err.data.issues);
    else if (err.status !== 401) showIssues([{ level: 'error', message: err.message }], 'Not saved');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
    renderTemplateState();
    renderCards();
    renderWorkspaceList();
  }
}

// -------------------------------------------------------------- preview --
// The preview runs in a sandbox="" iframe (no scripts, opaque origin) with
// this CSP; images may also come from this app's own origin (the local
// development image store).
const PREVIEW_CSP = `default-src 'none'; img-src https: data: cid: ${location.origin}; style-src 'unsafe-inline'; font-src https: data:`;

function srcdocFor(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}${meta}`);
  if (/<html\b[^>]*>/i.test(html)) return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${meta}</head>`);
  return meta + html;
}

function showPreview(p, source) {
  state.shown = { sessionId: p.session_id, source: p.source, version: p.template_version, name: p.name, email: p.to, test: p.test };
  $('pv-session').textContent = `${p.session_label} (${p.session_id})`;
  $('pv-from').textContent = p.from || '(EMAIL_FROM not set)';
  $('pv-to').textContent = `${p.name} <${p.to}>`;
  $('pv-subject').textContent = p.subject;
  $('pv-source').textContent = source;
  $('preview-meta').hidden = false;
  $('preview-empty').hidden = true;
  $('preview-stale').hidden = true;
  $('frame-wrap').hidden = false;
  // The frame is sandbox="" — no scripts, opaque origin, no access to this page.
  $('preview-frame').srcdoc = srcdocFor(p.html);
  const box = $('preview').getBoundingClientRect();
  if (box.top > window.innerHeight || box.bottom < 0) $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Marks previews stale. With a session id: only previews of that session.
function invalidatePreview(sessionId = null) {
  if (state.preview && (!sessionId || state.preview.sessionId === sessionId)) state.preview = null;
  if (state.shown && (!sessionId || state.shown.sessionId === sessionId)) $('preview-stale').hidden = false;
  renderSendState();
}

async function previewDraft() {
  if (!state.editing) return;
  const { active, ...draft } = readDraft(); // a preview needs only the template fields
  const body = { session_id: state.editing.id, source: 'draft', draft, name: $('rcpt-name').value, email: $('rcpt-email').value };
  const tooBig = templateSizeProblems(body);
  if (tooBig) { showIssues(tooBig, 'Too large to preview'); return; }
  const btn = $('tpl-preview');
  btn.disabled = true;
  try {
    const p = await api('POST', '/api/preview', body);
    showIssues(p.issues, p.issues?.length ? 'Warnings' : undefined);
    showPreview(p, `Unsaved draft of Session ${state.editing.saved.slot}`);
  } catch (err) {
    if (err.data?.issues) showIssues(err.data.issues, 'Fix these to preview');
    else if (err.status !== 401) showIssues([{ level: 'error', message: err.message }], 'Preview failed');
  } finally {
    btn.disabled = false;
  }
}

async function previewSaved(sessionId, { test = false, email = $('rcpt-email').value, name = $('rcpt-name').value } = {}) {
  const p = await api('POST', '/api/preview', { session_id: sessionId, source: 'saved', name, email, test });
  showPreview(p, `Saved template v${p.template_version}${test ? ' — TEST' : ''}`);
  return p;
}

async function previewCard(id) {
  try { await previewSaved(id); } catch (err) { if (err.status !== 401) showResult('bad', err.message); }
}

// ----------------------------------------------------------------- send --
const selectedSession = () => sessionById($('send-session').value);
const norm = (v) => String(v || '').trim().replace(/\s+/g, ' ');

function fieldError(inputId, message) {
  const input = $(inputId);
  const err = $(`${inputId}-err`);
  input.setAttribute('aria-invalid', message ? 'true' : 'false');
  err.textContent = message || '';
  err.hidden = !message;
}

// The current send preview is valid only for the exact session, template
// version and recipient it was made for (the server enforces this too).
function previewIsCurrent() {
  const p = state.preview;
  const s = selectedSession();
  return !!(p && s && p.sessionId === s.id && p.version === s.version && p.name === norm($('rcpt-name').value) && p.email === $('rcpt-email').value.trim());
}

function renderSendState() {
  const s = selectedSession();
  const info = $('send-session-info');
  const blocked = $('send-blocked');
  let reason = '';
  if (!s) reason = 'Loading sessions…';
  else if (!s.configured) reason = `No email template has been configured yet for Session ${s.slot}. Configure and save the email template before sending.`;
  else if (!s.active) reason = `${s.label} is turned off for sending. Turn on “Available for sending” in its template to use it.`;
  blocked.textContent = reason;
  blocked.hidden = !reason;
  info.textContent = s?.configured ? `Sends ${s.label}'s saved template (v${s.version}). Only the recipient changes.` : '';
  $('send-unsaved').hidden = !(s && state.editing?.id === s.id && isDirty());

  const usable = !!s && s.configured && s.active && !state.sending;
  $('send-preview').disabled = !usable;
  $('send-test').disabled = !usable;
  const current = previewIsCurrent();
  $('send-real').disabled = !usable || !current;
  $('send-real').textContent = state.sending ? 'Sending…' : 'Send invitation';
  $('send-hint').textContent = usable && !current ? 'Preview the invitation for this recipient before sending.' : '';
}

function validateRecipientLocally() {
  const name = $('rcpt-name').value.trim();
  const email = $('rcpt-email').value.trim();
  fieldError('rcpt-name', name ? '' : 'Enter the recipient name.');
  fieldError('rcpt-email', !email ? 'Enter the recipient email address.' : /[,;\s<>]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email) ? 'Enter exactly one valid email address.' : '');
  return name && !$('rcpt-email-err').textContent;
}

async function previewInvitation() {
  const s = selectedSession();
  if (!s || !validateRecipientLocally()) return;
  try {
    const p = await previewSaved(s.id);
    state.preview = p.preview_token
      ? { sessionId: p.session_id, label: p.session_label, version: p.template_version, name: norm($('rcpt-name').value), email: $('rcpt-email').value.trim(), token: p.preview_token, data: p }
      : null;
  } catch (err) {
    state.preview = null;
    if (err.data?.fields) {
      fieldError('rcpt-name', err.data.fields.name);
      fieldError('rcpt-email', err.data.fields.email);
    } else if (err.status !== 401) showResult('bad', err.message);
    if (err.data?.code === 'no_template' || err.data?.code === 'session_inactive') loadSessions();
  }
  renderSendState();
}

function showResult(kind, title, rows = [], actions = []) {
  const alert = el('div', { class: `alert alert-${kind}`, role: kind === 'bad' ? 'alert' : 'status' }, el('strong', {}, title));
  if (rows.length) alert.append(el('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v ?? '')])));
  if (actions.length) alert.append(el('div', { class: 'actions' }, ...actions));
  $('send-result').replaceChildren(alert);
  $('send-result').hidden = false;
}

async function confirmAttempt(attempt, p) {
  const test = attempt.kind === 'test';
  $('confirm-title').textContent = test ? 'Send this TEST email?' : 'Send this invitation?';
  $('cf-warning').replaceChildren(test
    ? 'This sends a real TEST email to the test address below — not to any invitation recipient.'
    : 'This sends a real email to the address below.');
  $('cf-session').textContent = `${p.session_label} (Session ${attempt.sessionId.slice(1)})`;
  $('cf-name').textContent = attempt.name;
  $('cf-email').textContent = attempt.email;
  $('cf-subject').textContent = p.subject;
  $('cf-from').textContent = p.from || '(not configured)';
  $('cf-version').textContent = `Saved template v${attempt.version}`;
  $('cf-confirm').textContent = test ? 'Send test' : 'Send invitation';
  return confirmDialog($('confirm-dialog'));
}

async function startRealSend(e) {
  e?.preventDefault();
  if (state.sending || !previewIsCurrent()) { renderSendState(); return; }
  const p = state.preview;
  const attempt = { kind: 'real', sessionId: p.sessionId, label: p.label, name: p.name, email: p.email, version: p.version, token: p.token, key: crypto.randomUUID() };
  if (!(await confirmAttempt(attempt, p.data))) return;
  if (!previewIsCurrent()) { renderSendState(); return; }
  await doSend(attempt);
}

async function startTestSend() {
  const s = selectedSession();
  if (state.sending || !s?.configured || !s.active) return;
  $('tf-session').textContent = s.label;
  const input = $('test-email');
  if (!input.value) input.value = state.admin?.email || '';
  fieldError('test-email', '');
  if (!(await confirmDialog($('test-dialog')))) return;
  const email = input.value.trim();
  if (!email || /[,;\s<>]/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    showResult('bad', 'Test not sent: enter exactly one valid test email address.');
    return;
  }
  let p;
  try {
    p = await previewSaved(s.id, { test: true, email });
  } catch (err) {
    if (err.status !== 401) showResult('bad', `Test not sent. ${err.message}`);
    return;
  }
  const attempt = { kind: 'test', sessionId: s.id, label: p.session_label, name: p.name, email: p.to, version: p.template_version, token: p.preview_token, key: crypto.randomUUID() };
  if (!(await confirmAttempt(attempt, p))) return;
  await doSend(attempt);
}

async function doSend(attempt) {
  if (state.sending) return;
  state.sending = true;
  renderSendState();
  const test = attempt.kind === 'test';
  showResult('info', test ? `Sending test of ${attempt.label} to ${attempt.email}…` : `Sending ${attempt.label} to ${attempt.email}…`);
  const body = { session_id: attempt.sessionId, email: attempt.email, template_version: attempt.version, preview_token: attempt.token, idempotency_key: attempt.key };
  if (!test) body.name = attempt.name;
  try {
    const r = await api('POST', test ? '/api/send-test' : '/api/send', body, { timeoutMs: 45_000 });
    const rows = [['Session', r.session_label], ['To', r.to], ['Subject', r.subject], ['From', r.from || '']];
    if (r.status === 'dry_run') {
      showResult('dry', 'DRY RUN — nothing was sent. The email rendered and passed every check; Resend was not called.', rows);
    } else {
      rows.push(['Resend message id', r.message_id]);
      showResult('good', `${r.duplicate ? 'Already accepted earlier (not sent twice). ' : ''}Accepted by Resend for delivery${r.test ? ' (test email)' : ''}. Acceptance is not delivery — check Resend → Emails for delivered/bounced status.`, rows);
    }
    if (!test) {
      // Keep the selected session and every template; clear only the recipient.
      $('rcpt-name').value = '';
      $('rcpt-email').value = '';
      state.preview = null;
      if (state.shown && !state.shown.test) $('preview-stale').hidden = false;
      $('rcpt-name').focus();
    }
  } catch (err) {
    handleSendError(err, attempt);
  } finally {
    state.sending = false;
    renderSendState();
    loadSends();
  }
}

function handleSendError(err, attempt) {
  if (err.status === 401) return;
  const status = err.data?.status;
  if (err.network || status === 'ambiguous') {
    // Never retried automatically. A manual retry keeps this attempt's send
    // id, so the server and Resend treat it as the same email, not a new one.
    const retry = el('button', {
      type: 'button', class: 'btn btn-sm',
      onclick: async () => {
        try {
          const p = await previewSaved(attempt.sessionId, attempt.kind === 'test' ? { test: true, email: attempt.email } : { name: attempt.name, email: attempt.email });
          if (p.template_version !== attempt.version || !p.preview_token) {
            showResult('bad', 'The template changed since this attempt. Start a new send instead of retrying.');
            return;
          }
          const again = { ...attempt, token: p.preview_token };
          if (await confirmAttempt(again, p)) await doSend(again);
        } catch (e) { handleSendError(e, attempt); }
      },
    }, 'Retry this same send');
    showResult('warn', `Outcome unknown. ${err.data?.error || err.message} Check the Resend dashboard (Emails) first. If it isn't there, "Retry this same send" re-uses this attempt's id, so Resend returns the original instead of sending again if the first one was accepted (within 24 hours).`,
      [['Session', attempt.label], ['To', attempt.email]], [retry]);
    return;
  }
  if (err.data?.fields && attempt.kind === 'real') {
    fieldError('rcpt-name', err.data.fields.name);
    fieldError('rcpt-email', err.data.fields.email);
  }
  if (['template_changed', 'preview_required', 'no_template', 'session_inactive'].includes(err.data?.code)) {
    state.preview = null;
    loadSessions();
  }
  const detail = err.data?.issues?.map((i) => i.message).join(' ');
  showResult('bad', `Not sent. ${err.message}${detail ? ` ${detail}` : ''}`, [['Session', attempt.label], ['To', attempt.email]]);
}

// --------------------------------------------------------- list review --
// The CSV stays in this page's memory (the textarea) and is sent to the
// server for every review; the server parses and validates it itself and
// stores nothing. Nothing here can send.
const REVIEW_PAGE_SIZE = 25;
const MAX_CSV_BYTES = 1024 * 1024;

function reviewError(message) {
  $('review-error').textContent = message;
  $('review-error').hidden = !message;
}

async function runReview(previewRow = null) {
  const csv = $('review-csv').value;
  reviewError('');
  if (!csv.trim()) { reviewError('Paste the CSV or choose a file first.'); return; }
  if (new Blob([csv]).size > MAX_CSV_BYTES - 1024) { reviewError('The CSV is larger than 1 MB. Split it into smaller files.'); return; }
  const btn = $('review-run');
  btn.disabled = true;
  btn.textContent = 'Reviewing…';
  try {
    const r = await api('POST', '/api/campaigns/review', { session_id: $('review-session').value, csv, ...(previewRow ? { preview_row: previewRow } : {}) }, { timeoutMs: 45_000 });
    if (previewRow === null) {
      state.reviewPage = 0;
      state.reviewKey = crypto.randomUUID();
    }
    state.reviewCsv = csv;
    state.review = r;
    renderReview();
  } catch (err) {
    if (err.status === 401) return;
    if (previewRow === null) { state.review = null; $('review-out').hidden = true; }
    reviewError(err.data?.issues?.length ? `${err.message} ${err.data.issues.map((i) => i.message).join(' ')}` : err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Review list';
  }
}

function renderReview() {
  const r = state.review;
  if (!r) { $('review-out').hidden = true; return; }
  const c = r.counts;
  const tile = (label, n, feature = false) => el('li', { class: `stat${feature ? ' feature' : ''}` },
    el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, String(n)));
  $('review-counts').replaceChildren(tile('Rows', c.total), tile('Valid', c.valid, true), tile('Invalid', c.invalid),
    tile('Duplicates', c.duplicate), tile('Blank', c.blank), tile('Skipped', c.skipped));
  const kv = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
  $('review-meta').replaceChildren(
    ...kv('Session', `${r.session_label} (${r.session_id})${r.session_active ? '' : ' — turned off for sending'}`),
    ...kv('Template', `version ${r.template_version} · content ${r.template_hash.slice(0, 12)}`),
    ...kv('List', `${c.valid} recipient${c.valid === 1 ? '' : 's'} · fingerprint ${r.recipients_hash.slice(0, 12)}`),
    ...kv('From', r.from || '(EMAIL_FROM not set)'),
    ...kv('Reply-to', r.reply_to || '(none)'),
    ...kv('Mode', r.dry_run ? 'Dry run' : 'Real sending configured (this screen never sends)'));
  const warn = [!r.session_active && 'This session is turned off for sending.', ...r.template_warnings.map((w) => w.message)].filter(Boolean);
  $('review-warn').textContent = warn.join(' ');
  $('review-warn').hidden = !warn.length;

  const pages = Math.max(1, Math.ceil(r.recipients.length / REVIEW_PAGE_SIZE));
  state.reviewPage = Math.min(state.reviewPage, pages - 1);
  const slice = r.recipients.slice(state.reviewPage * REVIEW_PAGE_SIZE, (state.reviewPage + 1) * REVIEW_PAGE_SIZE);
  $('review-rows').replaceChildren(...(slice.length ? slice.map((x) => el('tr', { 'aria-current': String(r.preview?.row === x.row) },
    el('td', {}, String(x.row)), el('td', {}, x.name), el('td', {}, x.email),
    el('td', {}, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => runReview(x.row), 'aria-label': `Preview row ${x.row}` }, 'Preview'))))
    : [el('tr', {}, el('td', { colspan: '4', class: 'muted' }, 'No valid recipients.'))]));
  $('review-page').textContent = `Page ${state.reviewPage + 1} of ${pages}`;
  $('review-prev').disabled = state.reviewPage === 0;
  $('review-next').disabled = state.reviewPage >= pages - 1;

  const kindLabel = { invalid: ['bad', 'Invalid'], duplicate: ['warn', 'Duplicate'], blank: ['none', 'Blank'] };
  $('review-problems').replaceChildren(...(r.problems.length ? r.problems.map((p) => el('li', {},
    el('span', { class: 'muted' }, `Row ${p.row}`), el('span', { class: `pill plain ${kindLabel[p.kind][0]}` }, kindLabel[p.kind][1]), el('span', {}, p.message)))
    : [el('li', { class: 'muted' }, 'Every row is included.')]));

  const pv = r.preview;
  $('rv-to').textContent = pv ? `Row ${pv.row}: ${pv.name} <${pv.to}>` : '—';
  $('rv-subject').textContent = pv?.subject ?? '—';
  $('rv-error').textContent = pv?.errors ? `This recipient produces an email that fails validation: ${pv.errors.map((e) => e.message).join(' ')}` : '';
  $('rv-error').hidden = !pv?.errors;
  // sandbox="" — no scripts, opaque origin.
  $('review-frame').srcdoc = pv?.html ? srcdocFor(pv.html) : '';

  const sup = r.suppressed_rows || [];
  const prev = r.previously_sent || [];
  $('review-previous').hidden = !prev.length && !sup.length;
  $('review-previous').replaceChildren(...(sup.length ? [
    el('strong', {}, `${sup.length} address${sup.length === 1 ? ' has' : 'es have'} unsubscribed `),
    `(row${sup.length === 1 ? '' : 's'} ${sup.slice(0, 20).join(', ')}${sup.length > 20 ? ', …' : ''}). They stay in the campaign for the record but are never sent. `,
  ] : []), ...(prev.length ? [
    el('strong', {}, `${prev.length} address${prev.length === 1 ? ' has' : 'es have'} already received an email from an earlier campaign of this session: `),
    prev.slice(0, 10).map((p) => `${p.email} (${p.campaign_name})`).join(', ') + (prev.length > 10 ? ', …' : ''),
    '. Confirming would email them again — remove them from the CSV if that is not intended.',
  ] : []));
  const available = r.campaigns?.available !== false;
  const canConfirm = available && r.counts.valid > 0 && r.session_active;
  $('review-confirm').disabled = !canConfirm;
  $('review-unavailable').hidden = canConfirm;
  $('review-unavailable').textContent = !available ? r.campaigns.reason
    : !r.session_active ? 'Turn this session on for sending before confirming a campaign.'
      : r.counts.valid === 0 ? 'No valid recipients to confirm.' : '';
  $('review-out').hidden = false;
}

// ---------------------------------------------------- campaign confirm --
function openConfirm() {
  const r = state.review;
  if (!r) return;
  $('cc-session').textContent = `${r.session_label} (${r.session_id})`;
  $('cc-template').textContent = `version ${r.template_version} · content ${r.template_hash.slice(0, 12)}`;
  $('cc-count').textContent = `${r.counts.valid} recipient${r.counts.valid === 1 ? '' : 's'} · list fingerprint ${r.recipients_hash.slice(0, 12)}`;
  const sup = (r.suppressed_rows || []).length;
  $('cc-skipped').textContent = [r.counts.skipped ? `${r.counts.invalid} invalid, ${r.counts.duplicate} duplicate, ${r.counts.blank} blank — not included` : '',
    sup ? `${sup} unsubscribed — kept but never sent` : ''].filter(Boolean).join('; ') || 'none';
  const sample = r.recipients.slice(0, 3).map((x) => `${x.name} <${x.email}>`).join(' · ');
  $('cc-sample').textContent = `${sample}${r.recipients.length > 3 ? ' · …' : ''}${r.preview?.subject ? ` — e.g. subject “${r.preview.subject}”` : ''}`;
  $('cc-from').textContent = r.from || '(EMAIL_FROM not set)';
  $('cc-mode').textContent = r.dry_run ? 'Dry run — sending will be simulated; no email is sent.' : 'Real sending is configured — emails will go out when you press Start.';
  $('cc-expected').textContent = String(r.counts.valid);
  $('cc-typed').value = '';
  if (!$('cc-name').value) $('cc-name').value = `${r.session_label} — ${new Date().toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
  $('cc-error').hidden = true;
  $('campaign-dialog').showModal();
  $('cc-typed').focus();
}

async function submitConfirm(e) {
  if (e.submitter?.value !== 'confirm') return; // Cancel closes the dialog
  e.preventDefault();
  const r = state.review;
  const err = $('cc-error');
  err.hidden = true;
  const typed = Number($('cc-typed').value.trim());
  if (typed !== r.counts.valid) { err.textContent = `Type ${r.counts.valid} to confirm.`; err.hidden = false; return; }
  const btn = $('cc-confirm');
  btn.disabled = true;
  try {
    const out = await api('POST', '/api/campaigns', {
      session_id: r.session_id, csv: state.reviewCsv, name: $('cc-name').value, creation_key: state.reviewKey,
      template_version: r.template_version, template_hash: r.template_hash, recipients_hash: r.recipients_hash, confirm_count: typed,
    }, { timeoutMs: 45_000 });
    $('campaign-dialog').close();
    $('cc-name').value = '';
    clearReview();
    await openCampaign(out.campaign.id);
  } catch (ex) {
    if (ex.status === 401) { $('campaign-dialog').close(); return; }
    if (ex.data?.code === 'session_busy' && ex.data.campaign_id) {
      err.replaceChildren(ex.message, ' ', el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { $('campaign-dialog').close(); openCampaign(ex.data.campaign_id); } }, 'Open that campaign'));
    } else {
      err.textContent = ex.message;
    }
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------ campaigns --
const C_STATUS = { confirmed: ['none', 'Confirmed · not started'], sending: ['lime', 'Sending'], paused: ['warn', 'Paused'], completed: ['good', 'Completed'], cancelled: ['off', 'Cancelled'] };
const R_STATUS = {
  pending: ['none', 'Pending'], claimed: ['warn', 'Sending now'], accepted: ['good', 'Accepted by Resend'], dry_run: ['dark', 'Simulated (dry run)'],
  failed: ['bad', 'Failed — not sent'], rejected: ['bad', 'Rejected by Resend'], unresolved: ['warn', 'Unresolved — check Resend'], skipped: ['off', 'Skipped'],
};
const REASONS = {
  rate_limited: 'Resend rate limit — retrying later', provider_rejected: 'Refused by Resend', provider_unavailable: 'Resend error — outcome unknown',
  network: 'Could not reach Resend — retrying later', timeout: 'Resend did not answer — outcome unknown', invalid_recipient: 'Invalid recipient',
  render_failed: 'Personalized email failed validation', template_changed: 'Template changed', cancelled: 'Campaign cancelled', suppressed: 'Unsubscribed — not sent',
  retries_exhausted: 'Gave up after retries', unknown: 'Outcome unknown — check Resend',
};
const fmtTime = (iso) => (iso ? shortTime(iso) : '—');

async function loadCampaigns() {
  let data;
  try {
    data = await api('GET', '/api/campaigns');
  } catch (err) {
    if (err.status !== 401) $('campaign-rows').replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'muted' }, `Could not load campaigns: ${err.message}`)));
    return;
  }
  const a = data.availability;
  $('campaigns-unavailable').hidden = a.available;
  $('campaigns-unavailable').textContent = a.available ? '' : a.reason;
  const rows = data.campaigns;
  $('campaign-rows').replaceChildren(...(rows.length ? rows.map((c) => {
    const k = c.counts;
    return el('tr', { onclick: () => openCampaign(c.id) },
      el('td', {}, el('button', { type: 'button', class: 'linklike', onclick: (e) => { e.stopPropagation(); openCampaign(c.id); } }, c.name)),
      el('td', {}, c.session_name),
      el('td', {}, fmtTime(c.confirmed_at)),
      el('td', {}, String(c.total_recipients)),
      el('td', {}, el('span', { class: `pill ${C_STATUS[c.status][0]}` }, C_STATUS[c.status][1])),
      el('td', {}, k.dry_run ? `${k.accepted} (+${k.dry_run} simulated)` : String(k.accepted)),
      el('td', {}, String(k.failed + k.rejected + k.unresolved)),
      el('td', {}, String(k.pending + k.claimed)));
  }) : [el('tr', {}, el('td', { colspan: '8', class: 'muted' }, a.available ? 'No campaigns yet. Review a list under New Campaign, then confirm it.' : 'Campaigns are not available on this database yet.'))]));
}

function stopPump() {
  if (state.pump) clearTimeout(state.pump);
  state.pump = null;
}

async function openCampaign(id) {
  stopPump();
  state.campaign = { id, data: null, page: 1, filter: '', stopMessage: null };
  $('campaign-list-view').hidden = true;
  $('campaign-detail').hidden = false;
  $('cd-filter').value = '';
  setActiveNav('campaigns');
  $('campaigns').scrollIntoView({ behavior: 'smooth', block: 'start' });
  await refreshCampaign();
}

function closeCampaign() {
  stopPump();
  state.campaign = null;
  $('campaign-detail').hidden = true;
  $('campaign-list-view').hidden = false;
  loadCampaigns();
}

async function refreshCampaign() {
  const cur = state.campaign;
  if (!cur) return;
  try {
    const [d, r] = await Promise.all([
      api('GET', `/api/campaigns/${cur.id}`),
      api('GET', `/api/campaigns/${cur.id}/recipients?page=${cur.page}${cur.filter ? `&status=${cur.filter}` : ''}`),
    ]);
    if (state.campaign !== cur) return;
    cur.data = d.campaign;
    cur.dryRun = d.dry_run;
    cur.rows = r;
    renderCampaign();
    if (cur.data.status === 'sending' && !state.pump) schedulePump(0);
  } catch (err) {
    if (err.status !== 401) $('cd-progress').textContent = `Could not load the campaign: ${err.message}`;
  }
}

function renderCampaign() {
  const cur = state.campaign;
  const c = cur.data;
  const k = c.counts;
  $('cd-title').textContent = c.name;
  $('cd-sub').textContent = `${c.session_name} (${c.session_id}) · confirmed ${fmtTime(c.confirmed_at)} by ${c.created_by}`;
  $('cd-status').className = `pill ${C_STATUS[c.status][0]}`;
  $('cd-status').textContent = C_STATUS[c.status][1];
  $('cd-mode').hidden = false;
  $('cd-mode').className = `alert small ${cur.dryRun ? 'alert-info' : 'alert-warn'}`;
  $('cd-mode').textContent = cur.dryRun
    ? 'Dry-run mode: processing is simulated — no email is sent, and results show as “Simulated”, never as accepted or delivered.'
    : 'Real sending is configured: processing sends real emails through Resend. “Accepted” means Resend accepted the email, not that it was delivered.';
  const stop = cur.stopMessage || (c.status === 'paused' && c.stop_reason && c.stop_reason !== 'admin' ? `Paused automatically (${c.stop_reason.replace(/_/g, ' ')}).` : '');
  $('cd-stop').hidden = !stop;
  $('cd-stop').textContent = stop;
  const tile = (label, n, feature = false) => el('li', { class: `stat${feature ? ' feature' : ''}` }, el('span', { class: 'stat-label' }, label), el('span', { class: 'stat-value' }, String(n)));
  $('cd-counts').replaceChildren(
    tile('Total', c.total_recipients), tile('Pending', k.pending), tile('Sending now', k.claimed),
    tile(cur.dryRun && !k.accepted ? 'Simulated' : 'Accepted by Resend', cur.dryRun && !k.accepted ? k.dry_run : k.accepted, true),
    tile('Failed / rejected', k.failed + k.rejected), tile('Unresolved', k.unresolved), tile('Unsubscribed', k.suppressed), tile('Skipped (other)', k.skipped - k.suppressed));
  const kv = (a, b) => [el('dt', {}, a), el('dd', {}, b)];
  $('cd-meta').replaceChildren(
    ...kv('Template', `version ${c.template_version} · content ${c.template_hash.slice(0, 12)}`),
    ...kv('List', `${c.total_recipients} recipients from ${c.csv_rows} CSV rows (${c.invalid_rows} invalid, ${c.duplicate_rows} duplicate, ${c.blank_rows} blank left out) · fingerprint ${c.recipients_hash.slice(0, 12)}`),
    ...kv('Started', fmtTime(c.started_at)), ...kv('Finished', fmtTime(c.finished_at)), ...kv('Updated', fmtTime(c.updated_at)));

  const btn = (label, onclick, cls = 'btn-secondary') => el('button', { type: 'button', class: `btn ${cls}`, onclick }, label);
  const actions = [];
  if (c.status === 'confirmed') actions.push(btn(cur.dryRun ? 'Start dry run' : 'Start sending…', startCampaign, 'btn-primary'));
  if (c.status === 'sending') actions.push(btn('Pause', () => campaignAction('pause')));
  if (c.status === 'paused') actions.push(btn('Resume', () => campaignAction('resume'), 'btn-primary'));
  if ((c.status === 'sending' || c.status === 'paused') && k.failed) actions.push(btn(`Retry ${k.failed} failed`, () => campaignAction('retry', { kind: 'failed' })));
  if ((c.status === 'sending' || c.status === 'paused') && k.unresolved) actions.push(btn(`Retry ${k.unresolved} unresolved…`, retryUnresolved));
  if (c.status === 'sending' && !k.pending && !k.claimed) actions.push(btn('Mark complete', () => campaignAction('complete')));
  if (['confirmed', 'sending', 'paused'].includes(c.status)) actions.push(btn('Cancel campaign…', cancelCampaign, 'btn-ghost'));
  $('cd-actions').replaceChildren(...actions);
  if (c.status !== 'sending') $('cd-progress').textContent = c.status === 'completed' ? 'Finished.' : '';

  const rows = cur.rows;
  const pages = Math.max(1, Math.ceil(rows.total / rows.page_size));
  $('cd-rows').replaceChildren(...(rows.recipients.length ? rows.recipients.map((x) => el('tr', {},
    el('td', {}, String(x.row_number)), el('td', {}, x.name), el('td', {}, x.email),
    el('td', {}, el('span', { class: `pill plain ${R_STATUS[x.status][0]}` }, R_STATUS[x.status][1])),
    el('td', {}, String(x.attempts)),
    el('td', { class: 'small' }, [x.reason ? REASONS[x.reason] || x.reason : '', x.provider_message_id ? `id ${x.provider_message_id}` : '',
      x.status === 'pending' && x.next_attempt_at ? `next try ${fmtTime(x.next_attempt_at)}` : ''].filter(Boolean).join(' · '))))
    : [el('tr', {}, el('td', { colspan: '6', class: 'muted' }, 'No recipients match.'))]));
  $('cd-page').textContent = `Page ${cur.page} of ${pages} · ${rows.total} recipient${rows.total === 1 ? '' : 's'}`;
  $('cd-prev').disabled = cur.page <= 1;
  $('cd-next').disabled = cur.page >= pages;
}

function askAction(title, body, confirmLabel) {
  $('ad-title').textContent = title;
  $('ad-body').textContent = body;
  $('ad-confirm').textContent = confirmLabel;
  return confirmDialog($('action-dialog'));
}

async function startCampaign() {
  const c = state.campaign.data;
  if (!state.campaign.dryRun && !(await askAction('Start sending real emails?',
    `This sends ${c.counts.pending} real email${c.counts.pending === 1 ? '' : 's'} through Resend, one at a time, while this page stays open. Accepted emails cannot be recalled.`, 'Start sending'))) return;
  await campaignAction('start');
}

async function cancelCampaign() {
  if (!(await askAction('Cancel this campaign?', 'Pending recipients will be skipped and nothing more will be sent. Emails Resend has already accepted cannot be undone. A cancelled campaign cannot be restarted.', 'Cancel campaign'))) return;
  await campaignAction('cancel');
}

async function retryUnresolved() {
  if (!(await askAction('Retry unresolved recipients?', 'Resend may already have accepted these emails. Retrying reuses the same idempotency key, so Resend will not send a second copy if it did — but only within about 24 hours of the first attempt; older ones are left for you to check in the Resend dashboard.', 'Retry'))) return;
  await campaignAction('retry', { kind: 'unresolved' });
}

async function campaignAction(name, body = {}) {
  const cur = state.campaign;
  if (!cur) return;
  try {
    await api('POST', `/api/campaigns/${cur.id}/${name}`, body);
    cur.stopMessage = null;
  } catch (err) {
    if (err.status !== 401) $('cd-progress').textContent = err.message;
  }
  await refreshCampaign();
}

// The sending loop: each call asks the SERVER to process one bounded batch;
// the server claims, paces, sends and records. Runs only while this
// campaign page is open and visible.
function schedulePump(ms) {
  stopPump();
  state.pump = setTimeout(pump, ms);
}

async function pump() {
  state.pump = null;
  const cur = state.campaign;
  if (!cur || cur.data?.status !== 'sending') return;
  if (document.visibilityState === 'hidden') { $('cd-progress').textContent = 'Paused while this tab is in the background — sending continues when you come back.'; return; }
  $('cd-progress').textContent = cur.dryRun ? 'Simulating… keep this page open.' : 'Sending… keep this page open.';
  let out;
  try {
    out = await api('POST', `/api/campaigns/${cur.id}/process`, {}, { timeoutMs: 60_000 });
  } catch (err) {
    if (err.status === 401 || state.campaign !== cur) return;
    $('cd-progress').textContent = `${err.message} Retrying in 10 s.`;
    schedulePump(10_000);
    return;
  }
  if (state.campaign !== cur) return;
  cur.stopMessage = out.stop_message;
  await refreshCampaign();
  if (state.campaign !== cur) return;
  const k = out.campaign.counts;
  if (out.campaign.status !== 'sending') return;
  if (out.next_delay_ms == null) {
    $('cd-progress').textContent = k.failed || k.unresolved
      ? 'Nothing more to send automatically. Retry the failed/unresolved recipients, or mark the campaign complete.'
      : 'Waiting.';
    return;
  }
  $('cd-progress').textContent = out.next_delay_ms > 2000 ? `Waiting ${Math.round(out.next_delay_ms / 1000)} s before the next attempt…` : $('cd-progress').textContent;
  schedulePump(Math.max(300, out.next_delay_ms));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.campaign?.data?.status === 'sending' && !state.pump) schedulePump(0);
});

function clearReview() {
  state.review = null;
  state.reviewPage = 0;
  $('review-csv').value = '';
  $('review-file').value = '';
  $('review-frame').srcdoc = '';
  reviewError('');
  $('review-out').hidden = true;
}

// ------------------------------------------------------------------ log --
async function loadSends() {
  let sends;
  try {
    ({ sends, stats: state.stats } = await api('GET', '/api/sends'));
  } catch {
    state.stats = null;
    renderSummary();
    return;
  }
  renderSummary();
  const body = $('log-body');
  if (!sends.length) {
    body.replaceChildren(el('li', { class: 'send-empty' }, 'Nothing sent yet.'));
    return;
  }
  const label = { accepted: 'Accepted', dry_run: 'Dry run', rejected: 'Rejected', failed: 'Failed', ambiguous: 'Unknown', pending: 'Pending' };
  const tone = { accepted: 'good', dry_run: 'dark', rejected: 'bad', failed: 'bad', ambiguous: 'warn', pending: 'warn' };
  body.replaceChildren(...sends.map((s) => el('li', { class: 'send-row' },
    el('div', { class: 'who-col' },
      el('div', { class: 'primary' }, s.recipient_email),
      el('div', { class: 'secondary' }, `${shortTime(s.created_at)} · by ${s.sent_by}`)),
    el('div', { class: 'session-col' },
      el('div', { class: 'primary' }, s.session_id ? s.session_name : '—'),
      el('div', { class: 'secondary' }, s.session_id ? `Session ${s.session_id.slice(1)}` : 'Before sessions')),
    el('div', { class: 'subject-col' },
      el('div', { class: 'secondary' }, 'Subject'),
      el('div', {}, s.subject)),
    el('div', { class: 'status-col' },
      el('span', { class: `pill ${tone[s.status] || ''}` }, `${label[s.status] || s.status}${s.is_test ? ' · test' : ''}`),
      el('span', { class: 'msgid' }, s.provider_message_id || (s.error ? s.error.slice(0, 120) : ''))))));
}

// ---------------------------------------------------------------- wiring --
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-submit');
  const err = $('login-error');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const session = await api('POST', '/api/login', { email: $('login-email').value, password: $('login-password').value });
    $('login-password').value = '';
    await enterApp(session);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

$('logout').addEventListener('click', async () => {
  if (!(await okToLeaveEditor())) return;
  try { await api('POST', '/api/logout', {}); } catch { /* signed out locally regardless */ }
  fillEditor(null);
  clearReview();
  stopPump();
  state.campaign = null;
  showLogin('Signed out.');
});

$('tpl-form').addEventListener('submit', saveTemplate);
$('tpl-form').addEventListener('input', renderTemplateState);
$('tpl-html').addEventListener('input', () => renderHtmlSize());
$('tpl-import').addEventListener('change', importHtmlFile);
$('tpl-form').addEventListener('change', renderTemplateState);
$('tpl-preview').addEventListener('click', previewDraft);
$('tpl-revert').addEventListener('click', () => { fillEditor(state.editing.saved); showIssues([]); renderTemplateState(); });

$('send-form').addEventListener('submit', startRealSend);
$('send-session').addEventListener('change', () => { invalidatePreview(); $('send-result').hidden = true; });
$('send-preview').addEventListener('click', previewInvitation);
$('send-test').addEventListener('click', startTestSend);
for (const id of ['rcpt-name', 'rcpt-email']) {
  $(id).addEventListener('input', () => {
    fieldError(id, '');
    if (state.preview && !previewIsCurrent()) invalidatePreview();
    renderSendState();
  });
}
$('log-refresh').addEventListener('click', loadSends);
$('review-form').addEventListener('submit', (e) => { e.preventDefault(); runReview(); });
$('review-confirm').addEventListener('click', openConfirm);
$('cc-form').addEventListener('submit', submitConfirm);
$('campaigns-refresh').addEventListener('click', loadCampaigns);
$('campaign-back').addEventListener('click', closeCampaign);
$('cd-filter').addEventListener('change', () => { state.campaign.filter = $('cd-filter').value; state.campaign.page = 1; refreshCampaign(); });
$('cd-prev').addEventListener('click', () => { state.campaign.page--; refreshCampaign(); });
$('cd-next').addEventListener('click', () => { state.campaign.page++; refreshCampaign(); });
$('review-clear').addEventListener('click', clearReview);
$('review-prev').addEventListener('click', () => { state.reviewPage--; renderReview(); });
$('review-next').addEventListener('click', () => { state.reviewPage++; renderReview(); });
// Changing the list or the session makes the shown review out of date.
for (const id of ['review-csv', 'review-session']) $(id).addEventListener(id === 'review-csv' ? 'input' : 'change', () => { if (state.review) { state.review = null; $('review-out').hidden = true; } });
$('review-file').addEventListener('change', async () => {
  const file = $('review-file').files[0];
  reviewError('');
  if (!file) return;
  if (file.size > MAX_CSV_BYTES - 1024) { reviewError('The file is larger than 1 MB. Split it into smaller files.'); $('review-file').value = ''; return; }
  $('review-csv').value = await file.text(); // read locally; only its text is sent, as JSON
  state.review = null;
  $('review-out').hidden = true;
});
for (const btn of document.querySelectorAll('.seg-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.seg-btn')) b.setAttribute('aria-pressed', String(b === btn));
    $('frame-wrap').dataset.width = btn.dataset.width;
  });
}

// Top navigation: in-page sections. Highlights the section in view; on small
// screens the links live in a toggle menu.
const navLinks = [...document.querySelectorAll('.nav-link')];
function setActiveNav(section) {
  for (const a of navLinks) a.setAttribute('aria-current', String(a.dataset.section === section));
}
function closeNav() {
  $('main-nav').classList.remove('open');
  $('nav-toggle').setAttribute('aria-expanded', 'false');
}
$('nav-toggle').addEventListener('click', () => {
  const open = !$('main-nav').classList.contains('open');
  $('main-nav').classList.toggle('open', open);
  $('nav-toggle').setAttribute('aria-expanded', String(open));
});
for (const a of navLinks) a.addEventListener('click', () => { setActiveNav(a.dataset.section); closeNav(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });
if ('IntersectionObserver' in window) {
  const visible = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0);
    const best = [...visible.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) setActiveNav(best[0]);
  }, { rootMargin: '-80px 0px -40% 0px', threshold: [0, 0.25, 0.5, 1] });
  for (const id of ['dashboard', 'sessions', 'send', 'review', 'campaigns', 'recent']) io.observe($(id));
}
setActiveNav('dashboard');
$('cta-send').addEventListener('click', () => {
  setActiveNav('send');
  setTimeout(() => $('send-session').focus({ preventScroll: true }), 350);
});

window.addEventListener('beforeunload', (e) => {
  if (state.admin && isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

(async function boot() {
  show('boot');
  try {
    await enterApp(await api('GET', '/api/session'));
  } catch (err) {
    if (err.status !== 401) showLogin(err.network ? 'Cannot reach the server.' : '');
  }
})();
