// Embedded images → hosted images.
//
// Claude-generated invitations often embed every image as a base64 data:
// URL (<img src="data:…">, background="data:…", CSS url(data:…)). Email
// clients block or strip those, and they make the HTML huge. On save, the
// template's embedded images are:
//   1. found — only in image positions (src / background attributes and CSS
//      url()); a data: URL anywhere else is an error, never silently left;
//   2. validated — PNG, JPEG, GIF or WebP only (no SVG: it can carry
//      scripts and email clients drop it), strict base64, and the decoded
//      bytes must really be that image type (magic bytes), within the size
//      and count limits — checked before anything is uploaded;
//   3. stored byte-for-byte (never re-encoded: dimensions, transparency and
//      appearance are exactly the original), content-addressed by SHA-256 so
//      identical images are stored once;
//   4. replaced in the HTML by their hosted URL, in place (order and every
//      other character of the document are unchanged).
// If any image fails, nothing is rewritten and the template is not saved.
// The same scan (without storing) powers draft previews.
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, stat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const IMAGE_TYPES = Object.freeze({
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  gif: { mime: 'image/gif', ext: 'gif' },
  webp: { mime: 'image/webp', ext: 'webp' },
});
const MIME_TO_TYPE = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/pjpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const ASSET_NAME_RE = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const IMAGE_ATTRS = new Set(['src', 'background']);

export class AssetError extends Error {
  constructor(message, issues = []) { super(message); this.issues = issues; }
}

// What the bytes actually are (the declared MIME type is not trusted).
export function sniffImage(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

const lineAt = (html, i) => {
  let n = 1;
  for (let k = html.indexOf('\n'); k !== -1 && k < i; k = html.indexOf('\n', k + 1)) n++;
  return n;
};

// Finds every data: URL in an image position. Returns { items, issues }.
// items: [{ start, end, line, context, mime, payload }] — [start, end) is the
// exact data URL text to replace.
export function findEmbeddedImages(html) {
  const items = [];
  const issues = [];
  const re = /data:/gi;
  let m;
  while ((m = re.exec(html))) {
    const i = m.index;
    // Only a data URL if a MIME type follows ("data:" in prose is ignored).
    const head = /^data:([a-z]+\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,"')\s]*)*)(;base64)?,/i.exec(html.slice(i, i + 200));
    if (!head) continue;
    // Look back for the context: an attribute value or a CSS url(. Inside a
    // style="…" attribute the url() quote is often an entity (&quot;).
    let j = i - 1;
    let quote = null;
    const entity = /(&quot;|&#0*34;|&#x0*22;|&#0*39;|&#x0*27;|&apos;)$/i.exec(html.slice(Math.max(0, i - 8), i));
    if (entity) { quote = entity[1]; j = i - entity[1].length - 1; } else if (html[j] === '"' || html[j] === "'") { quote = html[j]; j--; }
    while (j >= 0 && /\s/.test(html[j])) j--;
    let context = null;
    let end = -1;
    const line = lineAt(html, i);
    if (html[j] === '(' && /url\s*$/i.test(html.slice(Math.max(0, j - 10), j))) {
      context = 'css';
      end = quote ? html.indexOf(quote, i) : html.indexOf(')', i);
    } else if (html[j] === '=') {
      const attr = /([a-z_:][-a-z0-9_:.]*)\s*$/i.exec(html.slice(Math.max(0, j - 40), j));
      if (attr && IMAGE_ATTRS.has(attr[1].toLowerCase())) {
        context = attr[1].toLowerCase();
        if (quote) end = html.indexOf(quote, i);
        else { const rest = /[\s>]/.exec(html.slice(i)); end = rest ? i + rest.index : html.length; }
      }
    }
    if (!context) {
      issues.push({ level: 'error', field: 'html', line, message: `An embedded data: URL (${head[1]}) is in an unsupported place. Images may be embedded only in src="…", background="…" or CSS url(…).` });
      continue;
    }
    if (end === -1) {
      issues.push({ level: 'error', field: 'html', line, message: 'An embedded image is not terminated (missing closing quote or parenthesis).' });
      break;
    }
    items.push({ start: i, end, line, context, mime: head[1].toLowerCase(), base64: Boolean(head[3]), payload: html.slice(i + head[0].length, end) });
    re.lastIndex = end;
  }
  return { items, issues };
}

// Decodes and validates every embedded image, enforcing the limits BEFORE
// anything is stored. Returns { images: [{ ...item, bytes, type, sha256 }], issues }.
export function decodeEmbeddedImages(html, { maxImageBytes, maxTotalBytes, maxImages }) {
  const { items, issues } = findEmbeddedImages(html);
  if (items.length > maxImages) {
    issues.push({ level: 'error', field: 'html', message: `The template embeds ${items.length} images; the limit is ${maxImages}.` });
    return { images: [], issues };
  }
  const images = [];
  let total = 0;
  for (const it of items) {
    const at = { field: 'html', line: it.line };
    if (!it.mime.startsWith('image/')) { issues.push({ level: 'error', ...at, message: `Embedded "${it.mime}" data is not an image.` }); continue; }
    if (it.mime === 'image/svg+xml') { issues.push({ level: 'error', ...at, message: 'Embedded SVG images are not supported (they can carry scripts, and Gmail/Outlook drop them). Export the image as PNG.' }); continue; }
    const declared = MIME_TO_TYPE[it.mime];
    if (!declared) { issues.push({ level: 'error', ...at, message: `Embedded image type "${it.mime}" is not supported. Use PNG, JPEG, GIF or WebP.` }); continue; }
    if (!it.base64) { issues.push({ level: 'error', ...at, message: 'Embedded images must be base64-encoded.' }); continue; }
    const b64 = it.payload.replace(/[\s]+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0 || !b64.length) { issues.push({ level: 'error', ...at, message: 'An embedded image has malformed base64 data.' }); continue; }
    const estimated = (b64.length / 4) * 3;
    if (estimated > maxImageBytes + 3) { issues.push({ level: 'error', ...at, message: `An embedded image is ${(estimated / 1048576).toFixed(1)} MB; the limit per image is ${(maxImageBytes / 1048576).toFixed(1)} MB.` }); continue; }
    total += estimated;
    if (total > maxTotalBytes + 3) { issues.push({ level: 'error', ...at, message: `The embedded images total more than ${(maxTotalBytes / 1048576).toFixed(1)} MB.` }); break; }
    const bytes = Buffer.from(b64, 'base64');
    const type = sniffImage(bytes);
    if (!type) { issues.push({ level: 'error', ...at, message: `An embedded image declared as ${it.mime} is not a valid PNG, JPEG, GIF or WebP file.` }); continue; }
    if (type !== declared) issues.push({ level: 'warning', ...at, message: `An embedded image declared as ${it.mime} is actually ${IMAGE_TYPES[type].mime}; it is stored with its real type.` });
    images.push({ ...it, bytes, type, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { images, issues };
}

// Replaces each image's data URL with urlFor(image), in place.
export function rewriteImages(html, images, urlFor) {
  let out = '';
  let pos = 0;
  for (const img of [...images].sort((a, b) => a.start - b.start)) {
    out += html.slice(pos, img.start) + urlFor(img);
    pos = img.end;
  }
  return out + html.slice(pos);
}

export const assetName = (img) => `${img.sha256}.${IMAGE_TYPES[img.type].ext}`;

// The full save-time pipeline. Stores every unique image (stopping at the
// first failure) and returns the rewritten HTML. Throws AssetError — nothing
// is returned on any failure, so the caller never saves a partial result.
export async function hostEmbeddedImages(html, { store, limits }) {
  const { images, issues } = decodeEmbeddedImages(html, limits);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new AssetError('The embedded images could not be processed. Nothing was saved.', issues);
  if (!images.length) return { html, issues, summary: { embedded: 0, unique: 0, bytes: 0 } };
  if (!store || store.kind === 'none') {
    throw new AssetError(`This template embeds ${images.length} image${images.length === 1 ? '' : 's'}, but image hosting is not configured (ASSET_STORE). Nothing was saved.`, issues);
  }
  const urls = new Map();
  for (const img of images) {
    if (urls.has(img.sha256)) continue;
    try {
      urls.set(img.sha256, await store.put({ name: assetName(img), mime: IMAGE_TYPES[img.type].mime, bytes: img.bytes }));
    } catch (err) {
      throw new AssetError(`Uploading an embedded image (line ${img.line}) failed: ${err.message} Nothing was saved; ${urls.size} of ${new Set(images.map((x) => x.sha256)).size} images had been stored.`, issues);
    }
  }
  const unique = [...new Set(images.map((x) => x.sha256))];
  return {
    html: rewriteImages(html, images, (img) => urls.get(img.sha256)),
    issues,
    summary: { embedded: images.length, unique: unique.length, bytes: unique.reduce((n, h) => n + images.find((x) => x.sha256 === h).bytes.length, 0) },
  };
}

// ------------------------------------------------------------- stores --

// Development / dry runs: files in DATA_DIR/assets, served by this app at
// /api/assets/<sha256>.<ext>. Content-addressed and written atomically.
export function localAssetStore({ dataDir, origin }) {
  const dir = join(resolve(dataDir), 'assets');
  return {
    kind: 'local',
    dir,
    async put({ name, bytes }) {
      if (!ASSET_NAME_RE.test(name)) throw new Error('invalid asset name');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, name);
      try { await stat(file); } catch {
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, bytes, { mode: 0o644 });
        await rename(tmp, file);
      }
      return `${origin}/api/assets/${name}`;
    },
    async get(name) {
      const m = ASSET_NAME_RE.exec(name);
      if (!m) return null;
      try { return { bytes: await readFile(join(dir, name)), mime: EXT_MIME[m[2]] }; } catch { return null; }
    },
  };
}

// Production: a PUBLIC Supabase Storage bucket, via its REST API (plain
// fetch — no SDK). Objects are content-addressed under "invitations/" and
// never overwritten (x-upsert: false); "already exists" counts as stored.
// The key stays server-side and never appears in errors or logs.
export function supabaseAssetStore({ url, key, bucket }, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const path = (name) => `invitations/${name}`;
  return {
    kind: 'supabase',
    async put({ name, mime, bytes }) {
      if (!ASSET_NAME_RE.test(name)) throw new Error('invalid asset name');
      let res;
      try {
        res = await fetchImpl(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${path(name)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': mime, 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
          body: bytes,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        throw new Error(err?.name === 'TimeoutError' ? 'the storage service did not answer in time.' : 'could not reach the storage service.');
      }
      if (!res.ok) {
        let body = '';
        try { body = JSON.stringify(await res.json()); } catch { /* ignore */ }
        const duplicate = res.status === 409 || /already exists|Duplicate/i.test(body);
        if (!duplicate) throw new Error(`the storage service refused the upload (${res.status}).`);
      }
      return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path(name)}`;
    },
  };
}

export function createAssetStore(config, { fetchImpl } = {}) {
  const s = config.assets.store;
  if (s.kind === 'local') return localAssetStore({ dataDir: config.dataDir, origin: config.appOrigin });
  if (s.kind === 'supabase') return supabaseAssetStore(s, { ...(fetchImpl ? { fetchImpl } : {}), timeoutMs: config.email.timeoutMs });
  return { kind: 'none' };
}
