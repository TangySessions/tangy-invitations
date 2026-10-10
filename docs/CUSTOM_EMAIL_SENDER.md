# Tangy Sessions — Invitation Sender

A standalone internal app with **four independently configured session slots**. Each slot has its own saved email template. An administrator picks a session, enters one recipient's name and email address, previews, confirms, and sends **that session's** saved template through Resend. Only the recipient details change, through the placeholders below.

It is **independent of Tangy World**. It shares no code, database, accounts or deployment with it.

---

## 1. The four-session model

| Slot | Id | Starts as |
| --- | --- | --- |
| Session 1 | `s1` | Not configured |
| Session 2 | `s2` | Not configured |
| Session 3 | `s3` | Not configured |
| Session 4 | `s4` | Not configured |

Each slot is **its own database row** in `session_templates`, holding:

| Field | Notes |
| --- | --- |
| name | Display name, required on save, at most 80 characters. Shown to admins only; it is **not** inserted into the email. |
| subject | The email subject. |
| html | The email as **one complete HTML document**: inline styles, or a `<style>` block in `<head>`. At most 500,000 characters. |
| css | Legacy, read-only. Templates saved before the CSS field was removed may still have it; it is rendered into `<head>` as before. The editor shows it inside the HTML, and the next save stores one document (`css` empty, a new version). |
| text | Optional plain-text alternative. |
| active | "Available for sending" checkbox. |
| configured | Set once the slot has been saved. |
| version | Incremented on every save. |
| timestamps / editor | `created_at`, `updated_at`, `updated_by`. |

**How independence is enforced:**
- **Fixed slots.** There are exactly four rows, created once by the migration. The app never inserts or deletes rows. Database constraints allow only the ids `s1`–`s4` and slots 1–4 (each unique), and a slot can't be marked configured without a subject, HTML, name and a version above 0.
- **One-row saves.** A save is a single `UPDATE … WHERE id = ? AND version = ?`. It can only change that one row, and only if nobody saved a newer version in the meantime (otherwise you get a 409).
- **No copying.** Saving one session never copies content into another, and placeholders are filled per send, never stored.
- **Sends load by id.** Every send loads the template for the `session_id` in the request, validated against `s1`–`s4`. The browser never sends template HTML or a subject.

No real session names or content are included. The slots stay unconfigured until you fill them in.

## 2. Using it

### Manage sessions
1. Sign in. **Manage sessions** shows four cards, each with its name (or "Not configured yet"), status (*Ready · vN*, *Off · vN*, *Not configured*) and last update.
2. Click **Configure** or **Edit template** on a card. The editor opens for that session only.
3. Fill in the session name, subject, the HTML document and optional plain text. Under the HTML box, a counter shows its size and flags embedded `data:` images. Leave **Available for sending** checked unless you want to block this session temporarily.
4. **Preview draft** renders your unsaved edits. **Save template** saves this session only; the other three are unaffected.
5. Opening another session while you have unsaved edits asks you to confirm discarding them.

### Send an invitation
1. Under **Send invitation**, choose the session. Unconfigured or turned-off sessions are labelled and can't be sent, and the server enforces this too.
2. Enter the **recipient name** and **recipient email**: one person, one address.
3. Click **Preview invitation**. The preview shows the session name, from, to, the personalized subject and the email itself.
4. **Send invitation** only becomes available once the preview matches the current session, template version and recipient. Changing any of them, or saving that session's template, makes the preview stale, and you must preview again.
5. A confirmation shows the session, recipient name, recipient email, final subject, sender and template version. Nothing is sent until you confirm.
6. After Resend accepts the send, the result shows the Resend message id. The recipient fields clear, and the selected session and all templates stay as they are.

### Send a test email
**Send test email** asks for a test address (it defaults to your own). It then previews the selected session as *Test Recipient* with a `[TEST] ` subject prefix. The confirmation is clearly labelled as a test and shows the test destination. Tests go only to the address you type and carry a Resend tag of `kind=test`.

### Campaigns: CSV → review → confirm → send
1. **New Campaign** (review): choose a session, paste a CSV or choose a file, then click **Review list**. Nothing is saved or sent. Rules and limits are below.
2. **Confirm campaign…**: the dialog shows the session, the exact template version and hash, the recipient count, a sample, and the mode. Name the campaign and type the number of recipients.
   - The server re-parses the CSV and refuses with "review again" if the list fingerprint or the template (version or hash) changed.
   - It creates the campaign and all its recipients in one transaction.
   - Repeated or concurrent confirms with the same confirmation id give one campaign.
   - A session can have only one open (confirmed, sending or paused) campaign.
   - Confirming sends nothing.
3. **Start**: on the campaign page, **Start dry run** (with `EMAIL_DRY_RUN=true`) or **Start sending…** (real sending, after a confirmation).
4. **Sending runs while the campaign page is open.** There is no background job.
   - The page asks the server for the next batch, and the server does all the work: it claims one recipient at a time in a short transaction, sends with no transaction open, records the outcome only if it still holds the claim, paces requests to `RESEND_RATE_LIMIT_PER_SECOND`, and ends each batch well inside the 30-second function limit.
   - Two tabs or two admins can't send the same recipient: only one claim per campaign is in flight at a time.
   - Closing the page or hiding the tab stops progress; reopening continues it.
5. **Results:**
   - **Accepted by Resend**: Resend took the email. That is not proof of delivery; check Resend for delivery, bounces and complaints.
   - **Simulated**: dry run; nothing was sent.
   - **Failed**: never reached Resend. Retried automatically up to 3 times with backoff (30 s, 60 s), then failed.
   - **Rejected**: Resend refused it, for example as invalid.
   - **Unresolved**: a timeout, 5xx or 409, so Resend may have accepted it. It is **never retried automatically**.
   - **Skipped**: the campaign was cancelled.
6. **Actions** (each checked on the server against the state model):
   - **Pause** stops new claims; a request already in flight finishes.
   - **Resume.**
   - **Cancel** skips the pending recipients. It cannot undo emails Resend already accepted.
   - **Retry failed.**
   - **Retry unresolved** reuses the same idempotency key, so Resend won't send a second copy. It is only offered within 23 hours of the first attempt; older ones stay unresolved for a manual check in Resend.
   - **Mark complete.**
   - A campaign completes by itself when every recipient is accepted, simulated, rejected or skipped.
7. **Automatic pauses:**
   - the session's template changed after confirmation: nothing changed is sent; cancel, then review and confirm again;
   - the session was turned off;
   - Resend answered 401 or 403;
   - email isn't configured.

**Database:**
- **SQLite:** works with schema version 3, which is created automatically, with a backup first, like earlier versions.
- **PostgreSQL:** needs migration `0002_campaigns`, which is **not approved** (see `docs/CAMPAIGNS_0002.md`). On a version-1 database the app runs normally and the campaign pages explain that campaigns are unavailable; reviewing still works.

**Warning at review:** if an address in the list already received an email from an earlier campaign of the same session, the review says so. It doesn't block confirmation.

### Unsubscribe and suppression (campaign emails)
Campaign emails are invitations: non-essential mail that recipients can opt out of.

**What every campaign email carries:**
- a visible footer link: "You received this invitation from Tangy Sessions. Unsubscribe from future invitations.";
- the same link in the plain text;
- `List-Unsubscribe: <https://…/api/unsubscribe/<token>>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058 one-click, as Gmail and Yahoo require of bulk senders).

The server adds these, so no template can leave them out. Review previews show the footer with an inactive sample link.

**The link** (`src/unsubscribe.js`):
- The token is an HMAC of the recipient's random send id, under a key derived from `PREVIEW_TOKEN_SECRET`. It can't be guessed, and it contains no address or database id.
- Only its SHA-256 is stored. The token is recomputed when sending, so retries send identical emails, as Resend's idempotency needs.
- Links are valid for a year. After that the page says the link expired and asks the person to reply instead.
- If `PREVIEW_TOKEN_SECRET` changes between confirmation and sending, real sending pauses rather than send broken links.

**The page** (`/api/unsubscribe/<token>`, public):
- GET only shows a confirmation page, because mail scanners open links.
- The button, or a mail provider's one-click POST, records the opt-out. Repeating it is harmless.
- Invalid links get 404; expired links get 410.

**The suppression list** (`suppressions`):
- It stores only a SHA-256 hash of the lower-cased address, plus reason, source, campaign and time. The app can add entries but never change or remove them.
- An opt-out skips that address everywhere:
  - pending recipients in every campaign are skipped at once;
  - addresses already opted out are marked at review and skipped at confirmation;
  - the list is checked again after every claim, immediately before each provider request, which also covers a stale claim taken over after a crash and an admin retry;
  - single invitations (Send Invitations) to an opted-out address are refused. Test emails go to the admin's own address and aren't invitations.
- A request already in flight when the opt-out arrives cannot be recalled.

**Counts:** opted-out recipients have status `skipped` with reason `suppressed`. Campaign counts show them as **Unsubscribed** (a subset of skipped); they count as finished.

**Logs** record the campaign id only, never tokens or addresses.

**Not built (needs Resend webhooks):** adding bounces and spam complaints to the list automatically. The table already accepts reasons `bounce` and `complaint`.

### Production preflight
`npm run preflight` reports readiness without sending anything, contacting Resend or printing secret values:
- **Settings:** dry-run mode, key present, sender and reply-to, timeout and rate.
- **Public URL:** an https `APP_ORIGIN`, needed for unsubscribe links.
- **Unsubscribe key:** a stable `PREVIEW_TOKEN_SECRET`.
- **Database:** the backend and the migration approval.

Options:
- `-- --db` adds a read-only schema check: SQLite is opened read-only, PostgreSQL gets one `select`.
- `-- --live` exits with an error unless real sending is ready.
- `-- --domain-verified` records that **you** checked Resend → Domains by hand; the tool never checks it.
- For the Supabase setup: `node --env-file=.env --env-file=.env.supabase scripts/preflight.js --db`.

The manual Resend and DNS steps are printed at the end of the report.

### Sending safety: what is and isn't guaranteed
**Duplicates and recovery:**
- Each recipient has one stable `Idempotency-Key` (`tangy-campaign/<send_id>`), reused by every retry. Resend keeps keys for about 24 hours, and this app only resends within 23 hours.
- A crash after claiming leaves a stale claim. It's taken over after `RESEND_TIMEOUT_MS + 60 s` and resent with the same key.
- If it's too old for the key to protect against duplicates, the recipient becomes **unresolved** instead.
- Not exactly-once: an email Resend accepted can't be recalled, and nothing is guaranteed beyond Resend's key window.

**What "accepted" means:** Resend took the email, not that it was delivered. Delivery, bounces and opens are only visible in Resend.

**Retries:**
- "Never reached Resend" outcomes are retried automatically, at most 3 times, after 30 s and 60 s.
- A 429 waits 60 s.
- Timeouts, 5xx and 409 become **unresolved** and are never retried automatically.
- 401 or 403 pause the campaign.

**Concurrency and control:**
- Only one request per campaign is in flight at a time, so two tabs or admins can't double-send.
- Pause and cancel take effect before the next claim; an in-flight request finishes and is recorded.
- A template change after confirmation pauses sending.

**Limitation:** sending only runs while a campaign page is open in a browser. There is no scheduler. Closing the page leaves the campaign `sending` but idle; reopening it continues, and stale claims are recovered as above. A server-side scheduler would need its own design and tests.

### Recipient-list rules (CSV)
Reviewing never sends, saves, queues or calls Resend.

**Format** (`src/csvImport.js`):
- The first line is the header, with exactly the columns `name` and `email`, in any case and either order.
- Fields are separated by commas. Quote a field that contains a comma or a line break, and double any quote inside it: `"Doe, Jane"`, `"Say ""hi"""`.
- Line endings can be CRLF, LF or CR. A leading UTF-8 byte-order mark (as Excel adds) is ignored.

**Checks:**
- Each row is checked with the same validators as a single send.
- Addresses are compared lower-cased and trimmed. A repeat of an earlier address is listed as a duplicate of that row.
- Rows are numbered by the line they start on (the header is row 1).
- **Counts:** total rows, valid, invalid, duplicate, blank, and skipped (invalid + duplicate + blank).

**Refused whole file** (never truncated):
- a bad, missing or repeated header column;
- a quoted field that is never closed;
- more than **1,000** recipient rows, or 5,000 rows including blanks;
- a request over **1 MB**.

**The review shows:**
- the counts;
- valid recipients, 25 per page;
- every row that was left out, with the reason;
- the session, the template version and a SHA-256 hash of the template's content;
- a fingerprint of the recipient list;
- the sender, the reply-to and the dry-run mode;
- a personalized preview of any valid row, rendered and escaped by the normal renderer in a sandboxed frame. The review response carries no preview token, so it cannot authorize a send.

**Where the data is held:**
- **Browser:** the CSV text stays in the page's memory (the text box) until you clear it, sign out or close the tab. A chosen file is read in the browser and only its text is sent, as JSON. It is never put in browser storage.
- **Server:** the endpoint (`POST /api/campaigns/review`: signed in, CSRF and origin checked) parses the CSV, validates it, answers and keeps nothing. It never trusts the browser's checks, and it logs only counts, never names, addresses or bodies.
- **Export:** none exists. If one is added, cells starting with `=`, `+`, `-` or `@` must be prefixed to block spreadsheet formulas.

### Large, image-rich templates (embedded images)
Claude-generated invitations often embed every image as base64 (`data:image/…`). Email clients block or strip those, and they make the HTML huge (Gmail clips HTML above about 102 KB). The editor accepts such documents and handles the images automatically.

**Import:** paste the HTML, or use **Import an HTML file**. The file is read in the browser and nothing is uploaded until Preview or Save. The size counter is debounced, so multi-megabyte documents stay responsive.

**Preview draft:**
- Checks every embedded image and the rest of the template.
- Shows the document **with its original embedded images**, in the sandboxed preview (no scripts, opaque origin, its own CSP), in desktop and mobile widths.
- **Uploads nothing.**
- A browser preview is not proof of how Gmail or Outlook will render the email; send a test.

**Save** (`src/assets.js`):
1. **Find** every data URL in an image position: `src="…"`, `background="…"`, and CSS `url(…)` in `<style>` blocks or `style` attributes, including `&quot;`-quoted ones. A data URL anywhere else is an **error** with a line number, never silently kept or dropped.
2. **Validate** before anything is uploaded:
   - PNG, JPEG, GIF or WebP only. SVG is refused: it can carry scripts, and Gmail and Outlook drop it.
   - Strict base64; line-wrapped base64 is fine.
   - The decoded bytes must really be that image type (checked by file signature). A mislabeled type is stored as its real type, with a warning.
   - Per-image, total and count limits.
3. **Store** each image **byte-for-byte**: never re-encoded, so dimensions, transparency and appearance are exactly the original. Files are content-addressed (`<sha256>.<ext>`), so identical images are stored once.
4. **Rewrite** each reference in place with its hosted URL. Every other character of the document is unchanged, including placeholders.
5. **Validate the final HTML again, then save.**

If any image is invalid, or **any upload fails**, the save is refused, the template is unchanged, and the message says how many images had been uploaded. Content-addressed leftovers are harmless.

**Sending:** real sends (single or campaign) are refused while an email still contains `data:` images or images from the local development store (`http://localhost`). Messages must also fit Resend's 40 MB limit. Dry runs are unaffected.

**Settings** (all strictly validated; invalid values stop startup):

| Variable | Default | Meaning |
| --- | --- | --- |
| `TEMPLATE_IMPORT_MAX_BYTES` | 4 MB (1–20 MB) | A whole imported document including embedded images. Vercel caps requests at 4.5 MB, so stay at 4 MB or below there. |
| `ASSET_MAX_IMAGE_BYTES` | 5 MB (64 KB–10 MB) | One decoded image |
| `ASSET_MAX_TOTAL_BYTES` | 15 MB (1–50 MB) | All decoded images of one template |
| `ASSET_MAX_IMAGES` | 50 (1–200) | Embedded images per template |
| `ASSET_STORE` | `local` in development, `none` in production | `local`, `supabase` or `none` |
| `SUPABASE_URL`, `SUPABASE_STORAGE_KEY`, `SUPABASE_STORAGE_BUCKET` | — | For `ASSET_STORE=supabase` |

The *stored* HTML (after hosting) keeps the 500,000-character limit; with images hosted it is typically a few KB.

**The image stores:**
- **`local`** (development and dry runs only): files in `DATA_DIR/assets`, served by the app at `/api/assets/<sha256>.<ext>`.
  - Served with `nosniff`, a sandboxing CSP and long caching. Only these names are served.
  - It is refused in production and on Vercel.
  - Recipients cannot load these images, so real sending refuses them.
- **`supabase`** (production; **not set up yet**): a **public** Supabase Storage bucket, reached through its REST API with plain `fetch` (no new package).
  - Objects go to `invitations/<sha256>.<ext>` and are never overwritten.
  - Images are referenced as `https://<project>.supabase.co/storage/v1/object/public/<bucket>/invitations/…`.
  - The storage key stays on the server: never sent to the browser, logged or serialized.
- **`none`:** templates with embedded images are refused on save, with an explanation. Templates that already link https images work as before.

**Setting up Supabase Storage** (each step needs approval):
1. In the Supabase dashboard (Storage), create a **public** bucket, for example `invitation-assets`.
   - Public read is required: recipients' mail clients load the images without signing in.
   - Writes are not public; only the server key can upload.
   - Optionally restrict it to image MIME types and a 10 MB file limit.
2. Choose the server credential (`SUPABASE_STORAGE_KEY`). The simplest is the project's **service-role key**, but it bypasses row-level security for the **whole project**, including the database. This app otherwise connects as a least-privileged role, so prefer a narrower credential if you can, and treat this key like the database owner password. Store it only as a host secret (Vercel → Environment Variables), never in a file in the repo.
3. Set `ASSET_STORE=supabase`, `SUPABASE_URL=https://<project>.supabase.co`, `SUPABASE_STORAGE_BUCKET=invitation-assets` and the key.
4. Run `npm run preflight`; it reports the store without contacting it. Then save one template with images, open one hosted image URL in a browser, and send a **test** email.

### Template size: "Request is too large"
Saving a template or previewing a draft sends the editor's fields (name, subject, HTML, plain text) in one request. Its limit is `TEMPLATE_IMPORT_MAX_BYTES` (default 4 MB) plus a little overhead, and **embedded images count towards it**. A bigger request is refused with *"Request is too large: the limit is …"*. Use smaller images, or raise the limit (up to 4 MB on Vercel). The editor checks the size before sending.

A compact single-file demo ticket with mock event details is in `templates/tangy-ticket-demo.html` (about 9 KB, inline styles, no images). It uses only `{{recipient_name}}` and `{{recipient_email}}`. It is clearly labelled as a demo: it is not an entry pass, records no payment, and has no ticket ID or QR code. Those need a ticket data source this app does not have yet.

### Placeholders

| Placeholder | Value | In HTML | In subject / plain text |
| --- | --- | --- | --- |
| `{{recipient_name}}` | The name as entered (trimmed, single spaces) | HTML-escaped | Inserted as text (line breaks removed) |
| `{{recipient_email}}` | The recipient's address | HTML-escaped | Inserted as text |

**Syntax.** Double braces, with optional spaces inside: `{{ recipient_name }}` works too. Any other `{{…}}` is a save error. Placeholders aren't allowed in CSS, as an attribute name, or at the start of a URL. They are allowed later in a URL, for example `https://tangysessions.com/rsvp?e={{recipient_email}}`.

**How substitution works.** It is a single pass with no evaluation: a name containing `{{recipient_email}}` or `$&` is inserted literally. After filling in the values, the final HTML is validated again, so a recipient value can never add markup, scripts, attributes or a `javascript:` link.

## 3. How a send works

```
Browser: POST /api/send { session_id, name, email, template_version, preview_token, idempotency_key }
  ▼ src/app.js → sendEmail()
  checkOrigin()                 Origin must equal APP_ORIGIN
  requireSession()              valid session cookie + X-CSRF-Token
  onlyFields()                  only the fields above; html, subject, cc, bcc, to → 400
  sessionIdOf()                 must be s1|s2|s3|s4, else 400
  validateRecipient()           one address, sane name (templatePolicy.js)
  sendableSession(id)           db.getSessionTemplate(id): configured AND active, else 409
  template_version check        must equal the saved version, else 409 template_changed
  previewTokenValid()           HMAC over (admin, session, version, test flag, name, email, time),
                                at most 30 minutes old, signed with PREVIEW_TOKEN_SECRET,
                                else 409 preview_required
  validateTemplate()            the saved template, re-checked
  renderEmail()                 placeholders filled (legacy CSS put in <head>), final HTML re-validated
  emailState()                  key and sender configured, else 503 (nothing sent)
  senderStatus()                domain known to be unverified → 503 (skipped in dry run)
  send_log                      duplicate check / rate limit / insert as pending
  dry run → { status: 'dry_run' }  — Resend is NOT called
  otherwise sendViaResend()     POST https://api.resend.com/emails
                                one address in `to`, Idempotency-Key: tangy-custom-email/<uuid>
  send_log                      outcome + message id
  ▼
Browser shows one of: accepted (message id) · dry run · rejected (reason) · outcome unknown (check before retrying)
```

`POST /api/preview` runs the same rendering and **never** calls Resend or writes anything. Only a preview of a session's **saved**, **active** template for a real recipient returns a `preview_token`. Draft previews, and previews with blank recipient fields, can't authorize a send.

## 4. Storage and migration

The database is SQLite at `$DATA_DIR/mailer.db`. The data directory is created with mode 0700 and the files with 0600. It is git-ignored, along with `data/backups/`.

| Table | Contents |
| --- | --- |
| `session_templates` | The four slots (see §1). |
| `admins` | Admin email, scrypt hash, disabled flag. |
| `sessions` | SHA-256 hashes of login tokens, CSRF token, timestamps. |
| `send_log` | idempotency key, admin, `session_id`, `session_name` at send time, recipient email, personalized subject, test flag, template version, status, Resend message id, error, timestamps. **No email bodies.** |
| `legacy_template_v1` | Only on upgraded databases: the old single-template table, renamed and kept. |

**Schema versions** (`pragma user_version`):
- `0`: the single-template version, or a new file.
- `2`: the current version.

**Migration 0 → 2** runs automatically when the app (or `npm run admin:*`) opens the database:
1. If an existing database has tables, a backup is taken first with `VACUUM INTO data/backups/mailer-before-v2-<timestamp>.db` (mode 0600).
2. The rest runs in **one transaction** (`BEGIN IMMEDIATE … COMMIT`):
   - `send_log` gains `session_id` and `session_name`. Old rows keep `NULL` and show "—" in the history.
   - The four slots are created.
   - **If a template was already saved, it becomes Session 1 only.** Its content and version number are kept, and it is named "Session 1" (rename it in the editor). Sessions 2–4 start unconfigured; nothing is copied into them.
   - `template` is renamed to `legacy_template_v1` (not dropped).
   - `user_version` is set to 2.
3. Any error rolls everything back. This is tested.
4. Opening an already-migrated file does nothing (tested).

**Your local `data/mailer.db`** was migrated on 2026-10-09 at 21:03 IST by the running `npm run dev` watcher. It was empty (no admins, templates or sends). The backup is `data/backups/mailer-before-v2-2026-10-09T15-33-18-538Z.db`, and `integrity_check` passes on it.

## 4a. PostgreSQL store (Phase 2: built and tested locally, not deployed)

The app can run on PostgreSQL instead of SQLite. **SQLite stays the default.** PostgreSQL is used only when `DB_BACKEND=postgres` is set, and a `DATABASE_URL` on its own never switches the backend. The `pg` driver is loaded only in PostgreSQL mode. Both stores expose the same methods and return shapes, and the same app, Phase 1 and send tests pass on each.

| Piece | File |
|---|---|
| Store, plus the shared login limiter | `src/store/postgres.js` |
| Backend selection | `src/store/index.js` |
| Connection settings, TLS, safe error text | `src/store/pgConfig.js` |
| Migration runner | `src/store/pgMigrate.js`, `scripts/db-migrate.js` (`npm run db:migrate`) |
| Schema | `migrations/postgres/0001_init.sql` |
| Send-claim rules shared by both stores | `src/store/sendClaim.js` |

### Schema (`mailer` schema, version 1)
Tables:
- **`admins`:** lower-case email with a **case-insensitive unique index**, scrypt hash, `disabled`.
- **`login_sessions`:** SHA-256 token hash, CSRF token, created/last-seen, cascades when its admin is deleted.
- **`session_templates`:** exactly `s1`–`s4`, slot = id, a configured slot must have content, `version` for optimistic concurrency.
- **`send_log`:** unique `uuid` send id, foreign keys to admins and sessions, a status check, `claimed_at` and `claim_count`.
- **`login_attempts`:** SHA-256-hashed keys only, so no plain emails or IPs.
- **`schema_migrations`:** version, name, SHA-256 checksum.

Behaviour:
- **Same rules as SQLite.** Every constraint SQLite enforces is kept, plus foreign keys from the send log to sessions and admins.
- **Fixed slots.** The four slots are seeded with `ON CONFLICT DO NOTHING`, so re-running never duplicates slots or overwrites content.
- **Migration safety.** Each migration runs in its own transaction under an advisory lock. An already-applied file that has changed is refused (checksum). The app refuses to start on an unmigrated or outdated schema.

### Roles and access
- **Owner.** `MIGRATION_DATABASE_URL` connects as the schema owner and is used **only** by `npm run db:migrate` and `npm run admin:*`. Never configure it on the running app.
- **Runtime.** `DATABASE_URL` connects as a LOGIN role that is a member of the NOLOGIN group role **`mailer_runtime`**, which migration 0001 creates. It can only:
  - read admins;
  - read, write and delete login sessions and login attempts;
  - read and update session templates (no insert or delete);
  - read, insert and update the send log (no delete);
  - read schema versions.

  It has no DDL rights, no superuser and no bypass of row-level security (tested). Create the login role yourself; no password ever appears in a migration:
  ```sql
  create role mailer_app login password '<generated-password>';
  grant mailer_runtime to mailer_app;
  alter role mailer_app set statement_timeout = '10s';
  alter role mailer_app set idle_in_transaction_session_timeout = '15s';
  ```
- **Row-level security** is on for every table, with one policy for `mailer_runtime` only. Any other role, including Supabase's `anon`/`authenticated` (explicitly revoked), sees no rows (tested). The `mailer` schema is not exposed by Supabase's data API.

### Connections
- A `pg` pool of `PG_POOL_MAX` connections (default 3, suited to serverless instances).
- Timeouts: connect 5 s, client-side query 15 s, `statement_timeout` 10 s. The statement timeout is also applied with `SET LOCAL` in every transaction.
- **[Assumption]** some poolers reject startup parameters. In that case set `PG_STARTUP_PARAMS=none` and rely on the per-transaction `SET LOCAL` limits plus the role settings above (see "Supabase compatibility settings").
- Every checkout is released in `finally`; a connection whose rollback failed is destroyed.
- **TLS:** `DATABASE_SSL=verify` (default) checks certificates; give the provider's CA with `DATABASE_SSL_CA` if needed. `disable` is allowed only for localhost. TLS parameters in the URL are ignored, so `DATABASE_SSL` is the single, explicit setting.
- Connection strings are never logged, echoed in errors, or included when the config is serialized (tested).

### Supabase compatibility settings (Phase 4B; verified locally, not against Supabase)

**Two connections, two purposes**

| Variable | Used by | Supabase mode | Why |
|---|---|---|---|
| `DATABASE_URL` | The app (local PostgreSQL mode, later Vercel) | **Transaction pooler**, port 6543, as `mailer_app.<project-ref>` | Short transactions from many instances; the pooler shares server connections. |
| `MIGRATION_DATABASE_URL` | `scripts/db-migrate.js`, `scripts/admin.js`, locally only | **Session pooler** (port 5432 on the pooler host) or a direct connection, as the owner | Migrations hold a session advisory lock and run several transactions on **one** connection, which a transaction pooler can't guarantee. |

- **Port 6543 refused for migrations.** `scripts/db-migrate.js` refuses a `MIGRATION_DATABASE_URL` on port 6543 (or marked `pgbouncer=true`) **before connecting**, and never swaps in another URL.
- **Owner URL only for scripts.** Migrations and the admin CLI need only `MIGRATION_DATABASE_URL`; `DATABASE_URL` is not needed. The app still requires `DATABASE_URL` in PostgreSQL mode.
- **Keep it out of `.env`.** Put the owner URL in a separate git-ignored file, e.g. `.env.migrate`, and load it only for those commands:
  ```
  node --env-file=.env.migrate scripts/db-migrate.js
  node --env-file=.env.migrate scripts/admin.js create you@example.com
  ```

**TLS**
- **Always verified.** `DATABASE_SSL=verify` is the default and the only mode allowed for a remote host. `disable` works only when every configured host is localhost.
- **Extra CA, only if needed:** if verification against Node's built-in certificate authorities fails, supply the provider's CA in **one** of these ways:
  - `DATABASE_SSL_CA_PEM`: the PEM contents. Suits Vercel; the single-line form with `\n` escapes is also accepted.
  - `DATABASE_SSL_CA`: a local file path.

  Setting both is an error.
- **Validated at startup:** the CA must contain only PEM certificates (no private keys or other data) that parse correctly, and at least one must be unexpired.
- **Never echoed.** Errors never show the certificate, and the CA and URLs are hidden from any serialized config.
- **Not yet known** whether Supabase's pooler needs an extra CA. It must be tested against the real endpoint.

**Connection startup parameters**

| Parameter | Sent when | Also applied per transaction (`SET LOCAL`) |
|---|---|---|
| `application_name` | `PG_STARTUP_PARAMS` includes it | — |
| `statement_timeout` (`PG_STATEMENT_TIMEOUT_MS`, default 10 s) | includes it | **yes, always** |
| `idle_in_transaction_session_timeout` (`PG_IDLE_TX_TIMEOUT_MS`, default 15 s) | includes it | **yes, always** |

- `PG_STARTUP_PARAMS` is `all` (the default), `none`, or a comma list. Use `none` if the pooler rejects startup parameters.
- **What still limits queries with `none`:**
  - every transaction still gets both limits via `SET LOCAL`;
  - single statements outside transactions are bounded by the client-side `PG_QUERY_TIMEOUT_MS` (default 15 s, always on) and by the role settings `alter role mailer_app set statement_timeout / idle_in_transaction_session_timeout / lock_timeout`, which you set when creating the role.
- `PG_STATEMENT_TIMEOUT_MS=0` is no longer accepted; use `PG_STARTUP_PARAMS` instead.
- **Not proven by local tests:** that Supavisor accepts or rejects these parameters, unnamed prepared statements in transaction mode, and custom-role login (`mailer_app.<project-ref>`).

### Shared login limiting (`PgLoginLimiter`)
- **Same policy** as `MemoryLoginLimiter`: 5 per email or 20 per IP in a fixed 15-minute window, checked before the password, with a successful sign-in clearing the email.
- **Atomic.** `isBlocked()` locks both counter rows (always in the same order, so it can't deadlock) and **reserves** the attempt only if neither counter is at its limit. Concurrent guesses therefore can't all slip through: exactly 5 of 25 simultaneous attempts across two instances get through (tested).
- **Success releases the reservation.** `recordSuccess(email, ip)` clears the email and releases the IP slot, so successful sign-ins never count against an IP.
- **Shared and fail-closed.** Counters are shared by every instance using the database. If the database is unreachable, sign-in fails closed.

### Race-safe sends
- **One claim per send id.** `claimSend` runs in one short transaction:
  1. A per-admin transaction lock (`pg_advisory_xact_lock`) makes that admin's claims take turns, so the rate-limit count **can't be overshot** (tested: 4 of 15 simultaneous).
  2. An existing row is locked `FOR UPDATE`.
  3. A retry of an "outcome unknown" send succeeds only through a **compare-and-swap on `claim_count`**, so two retries can never both claim it, even without the locks. This is tested deterministically with the worst-case interleaving.
  4. A new row is inserted with `ON CONFLICT DO NOTHING`, so a concurrent insert of the same id is reported as a duplicate, never as a database error.
- **Outside the transaction.** Resend is called **after** the claim commits, with no transaction or connection held. The outcome is recorded in a second short statement.
- **Staleness.** It's measured from the latest claim (`claimed_at`), not from creation.
- **SQLite equivalent.** SQLite gets the same claim rules in a `BEGIN IMMEDIATE` transaction, plus an in-process set of claimed ids. This also fixes an older gap where a second retry of a send more than 2 minutes old could re-claim it while the first retry was still in flight (tested on both stores).

### What a database can't guarantee (remaining failure modes)
- **Retries can still reach Resend twice.** If Resend accepted an email but the response was lost, the row ends "outcome unknown". A manual retry sends the **same** `Idempotency-Key`. Resend documents keeping those keys for 24 hours **[assumption from Resend's docs]**, so a retry after that, or a provider-side failure to de-duplicate, could deliver twice.
- **The outcome may not get recorded.** If the database fails *after* Resend accepted, the response still reports Resend's result, with a `history_warning`. The row stays pending, becomes retryable after 2 minutes, and a retry then relies on Resend's idempotency.
- **Not exactly-once.** Exactly-once delivery across an external provider is not achievable with a database transaction; this design keeps duplicates to those provider-side cases.

### Local PostgreSQL testing (disposable Docker container)
```sh
npm run pg:test:up      # container tangy-invitations-pgtest on 127.0.0.1:55432, data in RAM
npm run test:pg         # PostgreSQL tests + the app/phase1/sends suites on PostgreSQL
npm run pg:test:down    # remove the container and .env.pgtest
```
`.env.pgtest` (git-ignored, mode 600) holds the throwaway connection. The tests create a fresh database per test from a migrated template, and connect the app as a real `mailer_runtime` member.

## 5. Preview and validation

The preview is rendered by the server using the same code that sends, and shown in `<iframe sandbox="">`. With no sandbox permissions, scripts can't run and the email runs in a separate, opaque origin. It can't read the app's cookies or storage, or call its API. The preview document also gets its own Content Security Policy (`default-src 'none'`, with images, inline styles and fonts allowed). Use the **Desktop / Mobile** toggle to view it at 600px or 375px wide.

**Stale previews.** A preview becomes stale, and is marked so in the UI, when you switch session, change the recipient, or save that session's template. The server enforces this through the template version and preview-token checks.

**HTML policy.** The server rejects unsafe content; it never silently rewrites it. The rules are in `src/templatePolicy.js` and are applied to draft previews, saves, the saved template at send time, and the final personalized HTML:

| Category | Rule |
| --- | --- |
| Blocked elements | `script`, `iframe`, `frame`, `frameset`, `object`, `embed`, `applet`, `param`, `form`, `input`, `button`, `textarea`, `select`, `option`, `base`, `link`, `svg`, `math`, `template`, `portal`, `audio`, `video`, `canvas`, `dialog`, `slot`, `xmp`, `plaintext`, `noembed`, `noframes` |
| Blocked attributes | Every `on*` event handler, `srcdoc`, `formaction`, malformed attribute names, placeholders used as attribute names |
| Link URLs | `https`, `http`, `mailto`, `tel`, `#fragment` (relative URLs get a warning) |
| Image URLs | `https`, `cid:`, `data:image/png\|jpeg\|gif\|webp` (with a warning) |
| URL obfuscation | Entities, control characters and whitespace are decoded or stripped before the scheme is checked. An unrecognised scheme is rejected. |
| CSS | No `expression()`, `javascript:`, `behavior`, `-moz-binding`, backslash escapes or placeholders. `url()` and `@import` must use https. Applies to `style="…"` attributes and `<style>` blocks (and legacy CSS). |
| `meta` | `http-equiv="refresh"` and `set-cookie` are rejected |
| Whole source | `javascript:`, `vbscript:` and `data:text/html` are rejected anywhere |
| Comments | Contents, including Outlook `<!--[if mso]>` blocks, are checked as markup |

Errors are listed with field and line number. Errors block saving and sending; warnings don't.

**Email client support varies.** Gmail drops `@import` and some `<style>` rules, Outlook on Windows uses Word's rendering engine, and Apple Mail is permissive. Prefer tables, inline styles, https images with `width` and `alt`, and bulletproof buttons. The browser preview is not proof of how the email will look, so send a test email.

## 6. Security

### Accounts and sign-in
- **Creating accounts.** There is **no sign-up page or route** (tested). Accounts are created only from a shell with access to the data directory:
  ```sh
  npm run admin:create -- you@tangysessions.com    # hidden prompt, min 12 characters
  npm run admin:reset-password -- you@tangysessions.com
  npm run admin:disable -- you@tangysessions.com   # also ends their sessions
  npm run admin:enable -- you@tangysessions.com
  npm run admin:list
  ```
  Passwords are never accepted as arguments. In a non-interactive shell, the first line of stdin is read.
- **Passwords** are hashed with scrypt (N=2^15, r=8, p=1) using a random salt, and compared in constant time. An unknown email still runs a hash, so timing doesn't reveal which accounts exist.
- **Sessions.** The token is 256 bits of randomness, sent in an `HttpOnly`, `SameSite=Strict` cookie (also `Secure` over https). The database stores only its SHA-256 hash. Sessions expire after 2 hours idle or 12 hours total; signing out or disabling the account removes them.
- **Login limits.** After 5 failures per email or 20 per IP within a fixed 15-minute window, sign-in is blocked (429), even with the right password. A successful sign-in clears that email's counter. The limiter sits behind a small async interface in `src/auth.js` (`isBlocked`, `recordFailure`, `recordSuccess`). The current implementation, `MemoryLoginLimiter`, counts **in this process only**: it protects a single long-running server but **not** several instances, which would need the planned shared database store. If the limiter fails, sign-in fails closed (no session is issued).
- **Preview-token key.** Preview tokens are HMAC-signed with **`PREVIEW_TOKEN_SECRET`**:
  - **Production:** required, at least 32 characters, random-looking (no spaces, not repetitive, no placeholder words such as "secret" or "change me"). The app refuses to start otherwise, and the error never shows the value.
  - **Development:** a configured value is validated the same way. If none is set, a random key is generated once per process and the startup log says so.
  - **Changing the secret** invalidates outstanding previews; admins just preview again.
  - **Every instance must share it**, so they accept each other's previews.
  - The key is kept out of logs, responses, the browser, and any serialized config.
- **CSRF protection.** Every POST and PUT, including preview, must come from `APP_ORIGIN`, use a JSON content type and, when signed in, carry the session's `X-CSRF-Token`.
- **Server-side checks.** Every `/api` route except `/api/login` checks the session on the server, including reading a template. The browser holds no authorization state.

**Before exposing it publicly,** put it behind an extra access layer: **Cloudflare Access** (SSO), a **VPN** or Tailscale, or an **IP allowlist** at the host or proxy. Two-factor login is not built in.

### Secrets
- **The Resend key** (`RESEND_API_KEY`) is read only from the server's environment and used only in the `Authorization` header of requests to `api.resend.com`. It is never stored in the database, returned by an endpoint, served to the browser, or logged. Tests check `public/`, every API response, and the server log.
- **Logs** record only status, session id, test flag, admin id and Resend message id: no recipients, subjects, bodies, passwords, cookies or keys (tested).
- **Git.** `.env`, `.env.*` (except `.env.example`) and `data/` are git-ignored. **`npm run check:secrets`** (part of `npm run check`) scans every file git would commit for Resend-key-shaped values or a filled-in `RESEND_API_KEY=`, and fails if it finds one, without printing the value.
- **Docker.** `.dockerignore` keeps `.env*` and `data/` out of the image.

### Accidental and duplicate sends
- **One recipient per send.** One address only, with no CC/BCC. Lists, arrays, `Name <addr>` forms and unexpected fields such as `to`, `cc`, `bcc`, `html` or `subject` are refused (400).
- **No automatic sends.** Nothing sends on page load, on save, or from preview. A confirmation dialog is required for every real and test send, and the send buttons are disabled while a request is in progress.
- **Previews can't be swapped.** A send needs a current preview token, and a test-send token can't be used for a real send, or the reverse (tested).
- **Send ids.** Each confirmed attempt gets a random UUID, stored in `send_log` (unique) and sent to Resend as `Idempotency-Key: tangy-custom-email/<uuid>`.
  - **Accepted already:** re-submitting the same id returns the stored result (`duplicate: true`) and doesn't call Resend.
  - **Outcome unknown** (timeout, dropped connection, Resend 5xx): **never retried automatically**. The UI offers *Retry this same send*. It re-previews to get a fresh token, refuses if the template changed, asks for confirmation, and resends with **the same id and an identical request body**. Resend then returns the original email instead of sending a second copy, if the first request did get through. This was tested: same `Idempotency-Key`, same body.
  - **Rejected or failed:** the id can't be reused; start a new send.
  - **Same id, different message:** refused.
- **Limits of the duplicate protection:**
  - Resend keeps idempotency keys for **24 hours**, so a retry after that could send twice.
  - Two *separate* attempts to the same person (two confirmations) are two emails by design.
  - This is **not** exactly-once delivery.
  - The login limiter (in memory) and the send rate limit (a count in SQLite, plus the single-process ordering) assume a single server process.
- **Rate limit.** 30 send attempts per admin per 10 minutes across all sessions (`SEND_LIMIT_PER_10_MIN`). Dry runs don't count.

## 7. Dry-run mode

With `EMAIL_DRY_RUN=true`, everything runs (validation, preview tokens, confirmation and the send log) except that **Resend is never called, not even the domain check** (tested, with and without a key set).
- The UI shows a *Dry-run mode* status and labels each result **"DRY RUN — nothing was sent"**.
- The send log records `dry_run`.
- A dry run is never reported as a real send.

**Defaults:**
- `.env.example` sets `EMAIL_DRY_RUN=true`.
- Without that variable, dry run is **off**. With no `RESEND_API_KEY`, sends then fail safely with 503, "Email is not configured… Missing: RESEND_API_KEY. Nothing was sent." There is no silent fake success.

## 8. Configuration

**Production environment variables:**

| Variable | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | Yes | `production` |
| `APP_ORIGIN` | Yes | `https://<your-host>`. Must be https and match the address in the browser exactly. The app refuses to start otherwise. |
| `DATA_DIR` | Yes | Path on a **persistent** volume, e.g. `/data` |
| `RESEND_API_KEY` | Yes, for real sends | Set as the host's **secret**, never in a file in the repo |
| `EMAIL_FROM` | Yes | `Tangy Sessions <hello@tangysessions.com>` (no default on purpose) |
| `EMAIL_DRY_RUN` | Yes | `false` for real sends (keep `true` until you've sent a deliberate test). Accepted: `true`/`1`/`yes`/`on` or `false`/`0`/`no`/`off`, any case. Any other value stops startup. Production refuses to start if it is missing; in development, missing means dry run. |
| `DB_BACKEND` | No | `sqlite` (default) or `postgres` |
| `DATABASE_URL` | With postgres | Runtime role (`mailer_runtime` member), pooled connection; host **secret** |
| `MIGRATION_DATABASE_URL` | Migrations / admin CLI only | Schema-owner connection; **not** set on the running app |
| `DATABASE_SSL`, `DATABASE_SSL_CA_PEM` / `DATABASE_SSL_CA` | No | `verify` (default) / `disable` (localhost only); optional CA as PEM contents **or** file (not both) |
| `PG_POOL_MAX`, `PG_CONNECT_TIMEOUT_MS`, `PG_QUERY_TIMEOUT_MS`, `PG_STATEMENT_TIMEOUT_MS`, `PG_IDLE_TX_TIMEOUT_MS` | No | 3 / 5000 / 15000 / 10000 / 15000 |
| `PG_STARTUP_PARAMS` | No | `all` (default) / `none` / list (see "Supabase compatibility settings") |
| `PREVIEW_TOKEN_SECRET` | Yes | At least 32 random characters, shared by every instance; set as a host **secret**. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `TRUST_PROXY` | Behind your host's proxy | `true` |
| `PORT` | No | Defaults to 8787 |
| `HOST` | No | Defaults to `0.0.0.0` in production, `127.0.0.1` in development |
| `EMAIL_REPLY_TO` | No | An address or `Name <address>`; an invalid value stops startup |
| `SEND_LIMIT_PER_10_MIN` | No | Whole number 1–1000, defaults to 30; any other value stops startup |
| `RESEND_TIMEOUT_MS` | No | Whole number 1000–25000 ms, defaults to 15000; any other value stops startup |
| `RESEND_RATE_LIMIT_PER_SECOND` | No | Campaign pacing: whole number 1–10 requests per second, defaults to 2 (Resend's default team limit); any other value stops startup |

### Setting up Resend later
1. **Domain.** In Resend → Domains, confirm `tangysessions.com` is **Verified**. You've said it is; this app hasn't confirmed it, because no key is configured here.
2. **Key.** Create an API key. A **full access** key lets the status strip confirm the domain (`GET /domains`). A **sending access** key also works, but the domain check then shows *unknown*, and Resend itself will reject an unverified sender.
3. **Locally:** put the key in `.env` (git-ignored, **never** `.env.example`). Set `EMAIL_FROM="Tangy Sessions <hello@tangysessions.com>"` and leave `EMAIL_DRY_RUN=true`. Start the app and check that the status strip shows *Dry-run mode* and the sender.
4. **First real email.** When you're ready, set `EMAIL_DRY_RUN=false`, restart, click **Re-check**, and send **one test email** to yourself from one session. Check it in Resend → Emails and in your inbox.
5. **Acceptance is not delivery.** "Accepted" means Resend returned a message id. Delivery, bounces and opens are shown only in Resend → Emails (search by message id). The app doesn't receive webhooks and never claims an email was delivered or read.

## 9. Running locally

```sh
cp .env.example .env               # then edit .env; never put keys in .env.example
npm run admin:create -- you@tangysessions.com
npm start                          # or: npm run dev (restarts on file changes)
open http://localhost:8787
```

`npm run dev` and `npm start` both open `DATA_DIR`, which defaults to `./data`, and migrate it if needed.

## 10. Deployment (not done; needs your approval)

**Requirements:** Node.js 24 (22.13 minimum), **one** long-running process, a **persistent disk** for `DATA_DIR`, HTTPS, and secret environment variables.

**Not suitable:** Vercel serverless functions and similar platforms. Their filesystem is temporary, so templates, accounts and history would be lost. No extra database service is needed.

**Suitable hosts:**
- **Fly.io.** An app plus a volume mounted at `/data`.
- **Render.** A Web Service plus a persistent Disk at `/data` (paid plan).
- **Railway.** A service plus a volume.
- **A small VPS.** Docker or systemd behind Caddy or nginx for TLS.

**Steps:**
1. Build from the `Dockerfile`. There's no npm install; it runs as the `node` user with `/data` as a volume. Pin the base image digest.
2. Set the production variables from §8 as host secrets/variables.
3. Create the first admin from a shell on the host. For example, on Fly: `fly ssh console -C "npm run admin:create -- you@tangysessions.com"`.
4. Add an access layer (Cloudflare Access, VPN, or an IP allowlist).
5. Keep `EMAIL_DRY_RUN=true` for the first deploy. Check sign-in, the four slots and the previews, then switch to `false` and send one test email.
6. Restarts and redeploys keep everything on the volume. The schema migration only ever moves forward and backs up before changing anything.

### Vercel (Phase 3: adapter built and tested locally, not deployed)

**Files**

| File | Purpose |
|---|---|
| `api/handler.js` | The single serverless function. |
| `src/vercel.js` | The adapter. It runs the **same** `createApp()` handler as `src/server.js`, so routes, JSON responses, body limits (1 MB / 8 KB), sessions, CSRF and origin checks, and security headers are unchanged. |
| `vercel.json` | Static output = `public/` only (served by Vercel's CDN), one rewrite `/api/:path*` → `/api/handler?route=:path*`, `maxDuration` 30 s, and the CDN security headers. The headers are generated from the app's own list; a test keeps them identical. |
| `.vercelignore` | Keeps `data/`, `*.db`, `.env*`, tests, docs, scripts and migrations out of uploads. |

**How the adapter works**
- **Path recovery.** It rebuilds the original `/api/...` path whether Vercel passes the original URL or the rewrite target, and refuses empty, malformed or `..` routes (404).
- **No static files.** The function never serves or reads them from disk; anything outside `/api` gets a 404.
- **Setup once per instance.** Config, the PostgreSQL pool and the app are initialised on the first request and reused.
- **Failure.** If setup fails (bad config or the database is down), the response is a generic **503** with no details, the error is logged safely, and the next request retries. **Nothing falls back to SQLite.**
- **PostgreSQL only.** The adapter refuses to start unless `DB_BACKEND=postgres`, even outside Vercel. It never opens or creates a SQLite file.

**Production rules** (enforced at startup, all tested)

| Where | Rule |
|---|---|
| Any `NODE_ENV=production` | `DB_BACKEND` must be set explicitly. The Dockerfile sets `DB_BACKEND=sqlite` for the self-hosted, persistent-disk option. |
| On Vercel (`VERCEL` set and `VERCEL_ENV` ≠ `development`, so production **and** preview deployments) | Production rules whatever `NODE_ENV` says. `DB_BACKEND=postgres` required; https `APP_ORIGIN` required; a valid `PREVIEW_TOKEN_SECRET` required; `TRUST_PROXY=true` required, otherwise every visitor would share Vercel's proxy address in the login limiter. Loopback origins are never allowed. |

**Environment variables to set in the Vercel project later** (placeholders only; never put real values in the repo)

| Variable | Value |
|---|---|
| `DB_BACKEND` | `postgres` |
| `DATABASE_URL` | `postgres://<runtime-role>:<password>@<pooler-host>:<port>/postgres`. A `mailer_runtime` member, never the owner. Secret. |
| `DATABASE_SSL` | `verify` (default). Only if verification fails, provide the provider CA as `DATABASE_SSL_CA_PEM` (contents). |
| `PG_STARTUP_PARAMS` | `none` if Supavisor rejects startup parameters (to be determined in staging) |
| `APP_ORIGIN` | `https://<custom-domain>` |
| `TRUST_PROXY` | `true` |
| `PREVIEW_TOKEN_SECRET` | `<32+ random characters>`. One value for all instances. Secret. |
| `RESEND_API_KEY` | `<resend-key>`. Secret. |
| `EMAIL_FROM` | `Tangy Sessions <noreply@tangysessions.com>` |
| `EMAIL_DRY_RUN` | `true` until a deliberate first test. Required: the function refuses to start without it. |
| Optional | `EMAIL_REPLY_TO`, `PG_POOL_MAX` (keep small, e.g. 2–3), `PG_*_TIMEOUT_MS`, `SEND_LIMIT_PER_10_MIN` |

**Never** set `MIGRATION_DATABASE_URL` in Vercel. `NODE_ENV` doesn't need to be set (Vercel deployments get production rules), and `DATA_DIR`, `PORT` and `HOST` are unused there.

**Must be verified on a real Vercel staging deployment** (local tests can't prove these):
1. Which `req.url` Vercel delivers for rewritten requests. The adapter accepts both forms, but this is unconfirmed.
2. That the request body stream reaches the app unread. The app never touches Vercel's `req.body` helper, which is assumed to parse lazily.
3. That `public/` is served as the static output and server files are not.
4. That the CDN applies the `vercel.json` headers to `/` and the assets.
5. That HSTS and the `Secure` cookie arrive over HTTPS.
6. That `X-Forwarded-For` holds the real client address on Vercel.
7. Node `24.x` runtime selection from `engines`.
8. The function duration limit for your plan (30 s configured).
9. TLS to the Supabase pooler (`DATABASE_SSL=verify`; CA needed?) and whether the pooler accepts the `statement_timeout` connection parameter (`PG_STARTUP_PARAMS=none` if not).
10. Pool behaviour across function instances, with no connection exhaustion at the pooler.
11. Cold-start latency.
12. Preview deployments: their URLs differ from `APP_ORIGIN`, so the origin check refuses changes there. Use a staging project with its own `APP_ORIGIN` and its own database.

### Backup
- **Online, consistent copy** (safe while the app runs):
  ```sh
  sqlite3 /data/mailer.db ".backup '/data/backups/mailer-$(date +%F).db'"
  ```
  or, without the sqlite3 CLI:
  ```sh
  node -e "new (require('node:sqlite').DatabaseSync)('/data/mailer.db').exec(\"vacuum into '/data/backups/mailer-'+Date.now()+'.db'\")"
  ```
- **Copy it off the host** (e.g. to encrypted object storage) on a schedule. It contains admin password hashes and recipient addresses, so treat it as sensitive.
- **Snapshots.** The host's volume snapshots (Fly, Render) are a good second layer.

### Restore
1. Stop the app.
2. Move the current `mailer.db`, `mailer.db-wal` and `mailer.db-shm` aside.
3. Copy the backup to `$DATA_DIR/mailer.db` and run `chmod 600` on it.
4. Start the app. A pre-v2 backup is migrated automatically, with its own new backup taken first.
5. Sign in and check the four slots and the send history.

### Rollback
Redeploy the previous build. **A v2 database is not readable by the single-template build.** To roll back that far, restore the `mailer-before-v2-*.db` backup (any templates or sends made after the upgrade are lost) or keep running v2.

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Status strip: "Dry-run mode" | `EMAIL_DRY_RUN=true`. Nothing is sent; set it to `false` when ready. |
| "Email is not configured… Missing: RESEND_API_KEY, EMAIL_FROM" | Set those on the server and restart. Nothing was sent. |
| "The sender … is not verified in Resend" | The domain check found `tangysessions.com` missing or not verified on that key's account. Check Resend → Domains, then *Re-check*. |
| "No email template has been configured yet for Session N…" | Configure and save that session first. |
| "Session N is turned off for sending" | Check *Available for sending* in its editor and save. |
| "Preview this exact email again before sending…" (`preview_required`) | The session, template or recipient changed since the preview, or 30 minutes passed. Preview again. |
| "…template changed (now version N)…" | Someone saved that session after your preview. Preview again. |
| *Rejected*, 403 | The sender domain isn't verified, or the key can't send from it. |
| *Rejected*, 401 | `RESEND_API_KEY` is wrong or revoked. |
| *Rejected*, 422 | Resend found the message invalid (the reason is shown). |
| *Rejected*, 429 | Resend's rate limit. Wait and send again. |
| *Outcome unknown* | Timeout, dropped connection or a Resend 5xx. **Check Resend → Emails first.** If it isn't there, *Retry this same send* is safe within 24 hours. |
| "Send limit reached" | The per-admin limit; wait or raise `SEND_LIMIT_PER_10_MIN`. |
| "Request refused: it did not come from this app" | `APP_ORIGIN` doesn't exactly match the browser URL (scheme, host and port). |
| Sign-in fails repeatedly | Accounts come only from `npm run admin:create`. After 5 failures, wait 15 minutes. |
| `npm run check` fails at `check:secrets` | A key-like value is in a file git would commit. Move it to `.env` or host secrets, and rotate the key. |

## 12. Tests

```sh
npm test         # node --test "test/*.test.js"
npm run check    # node --check on every source file, then npm run check:secrets
```

Resend is a stubbed `fetch` in every test. **No request leaves the machine and no email is sent.**

| File | Tests | Covers |
| --- | --- | --- |
| `test/policy.test.js` | 37 | HTML policy (scripts, event handlers, obfuscated and dangerous URLs, iframe, svg, form, base, meta refresh, CSS expression/escapes/http urls, comment tricks, placeholder misuse); escaping including `$&`; no re-expansion; post-render validation; test subject; CSS placement; recipient validation |
| `test/app.test.js` | 33 | Authentication on every route; login failures, lock-out and disabled accounts; no sign-up route; CSRF; four slots; invalid session ids; independent configuration and edits; no content copying; persistence of all four across a restart; unsafe templates rejected server-side; stale-save conflict; size limit; unconfigured and inactive sessions blocked (including a forged session id); preview shows only the selected session and never writes; stale previews (template edit, other session, other recipient, forged version, expiry); exact no-template message; sends use the saved template with one recipient and no cc/bcc; each session sends its own content with no leakage; browser can't supply HTML, subject, to/cc/bcc or lists; missing config; unverified domain; provider rejection; timeout ambiguous with no automatic retry and identical key and body on manual retry; duplicate handling; connection refused and 5xx; test sends (selected session, test address only, tokens not interchangeable); send history with session name at send time; rate limit across sessions; dry run with and without a key never calls Resend; key absent from `public/`, responses and logs; logs free of recipients, bodies and tokens; CSP and fully sandboxed iframe; no path traversal |
| `test/db.test.js` | 6 | New database = four unconfigured slots at v2; v1 → v2 migration (backup, legacy template to Session 1 only, history, accounts and login sessions preserved, old table kept, re-open is a no-op); v1 without a template; failed migration rolls back completely; database constraints reject invalid or duplicate slots; a save changes exactly one row |

**Results on 2026-10-09 (Node 24.12.0):**
- `npm test`: **76 tests, 76 passed, 0 failed.**
- `npm run check`: syntax checks pass. **`check:secrets` fails**, because `.env.example` line 22 contains a Resend-key-shaped value (see §13).
- Mutation checks: skipping the preview-token check made 3 tests fail, and forcing every send to Session 1 made 4 fail. Both changes were reverted.
- Manual dry-run smoke test against a migrated copy of the local database: sign in, four slots, unconfigured preview blocked, two sessions saved, each sent with its own subject, unconfigured send blocked, test send, history with session ids, template unchanged. Passed.
- **Not exercised:** the in-browser UI. The Chrome extension wasn't connected earlier. Load the page once before relying on it.

## 13. Open items and limitations

- **A Resend-key-shaped value is in `.env.example`, which git tracks.** Move it to `.env`, leave `RESEND_API_KEY=` empty in `.env.example`, and **rotate the key** in Resend. `npm run check:secrets` will keep failing until then.
- Domain verification has not been confirmed from this app (no key configured here).
- No two-factor sign-in. Use an access layer in front of the app.
- The login limiter is in memory per process: run a single instance until a shared store exists. Preview tokens already work across instances through `PREVIEW_TOKEN_SECRET`.
- Resend idempotency lasts 24 hours, so this is not exactly-once delivery.
- No delivery webhooks: delivery status is visible in Resend only.
- Not deployed, not pushed, not committed, and no real email sent.
