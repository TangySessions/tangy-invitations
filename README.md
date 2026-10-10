# Tangy Sessions — Invitation Sender

An internal tool with **four independent session slots** (Session 1–4). Each slot has its own name, subject, HTML document (inline styles or a `<style>` block) and optional plain text. Recipient lists (CSV) can be reviewed, confirmed as campaigns and sent one recipient at a time, in dry run until real sending is approved (see `docs/CUSTOM_EMAIL_SENDER.md` → Campaigns). You configure each session once. After that, you pick a session, enter one recipient's name and email address, preview, confirm and send that session's saved template through Resend.

It is standalone: Node.js 24 and built-in SQLite by default. An optional PostgreSQL store (`DB_BACKEND=postgres`) uses one dependency, `pg`. Run `npm install` once.

```sh
cp .env.example .env          # keep EMAIL_DRY_RUN=true until you're ready
# add a random PREVIEW_TOKEN_SECRET to .env:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm run admin:create -- you@tangysessions.com   # prompts for a password
npm start                     # http://localhost:8787
npm test                      # Resend is stubbed, nothing is sent
npm run check                 # syntax check + secret scan
npm run pg:test:up && npm run test:pg && npm run pg:test:down   # optional: PostgreSQL tests (Docker)
```

Vercel: `api/handler.js` + `vercel.json` (PostgreSQL only; not deployed yet). See the Vercel section of the guide.

Connecting a Supabase database: follow [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md) (read-only checks first; database-changing steps are marked).

The full guide is in [docs/CUSTOM_EMAIL_SENDER.md](docs/CUSTOM_EMAIL_SENDER.md). It covers the session model, configuration, security, Resend setup, deployment, backup/restore and troubleshooting.
