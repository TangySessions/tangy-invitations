# Supabase setup runbook: `tangy-invitation-manager`

This connects the Invitation Manager to its **own** Supabase project. It never touches Tangy World's database.

Every step is labelled:
- ✅ **READ-ONLY**: cannot change the database.
- ⚠ **CHANGES THE REMOTE DATABASE**: do it only after explicit approval.

Never paste passwords, keys or connection strings into chat. Values go only into the private, git-ignored files below.

Throughout, `EMAIL_DRY_RUN=true` stays on, and local SQLite (`data/mailer.db`) is not involved.

## 0. Values to collect from the Supabase dashboard (you, locally)

Dashboard labels may differ slightly between Supabase versions.

| What | Where | Goes into |
|---|---|---|
| Project ref (the short id in the project URL) | Project settings → General | Both URLs |
| Region | Project settings → General | Later: Vercel function region |
| Postgres version (should be 15 or newer) | Project settings → Infrastructure | Check only |
| Database password (`postgres`); reset it if unknown | Project settings → Database | `.env.migrate` only |
| **Session pooler** string: host `aws-<n>-<region>.pooler.supabase.com`, port **5432**, user `postgres.<PROJECT_REF>`, database `postgres` | **Connect** button (top bar) → Session pooler | `MIGRATION_DATABASE_URL` in `.env.migrate` |
| **Transaction pooler** string: same host, port **6543** | Connect → Transaction pooler | `DATABASE_URL` in `.env.supabase`, with user `mailer_app.<PROJECT_REF>` and **its** password |
| SSL: turn on "Enforce SSL"; download the CA certificate **only if step 2 fails TLS verification** | Project settings → Database → SSL configuration | Optional `DATABASE_SSL_CA` |
| Pool size for the Transaction pooler | Project settings → Database → Connection pooling | Keep `connection limit` and `PG_POOL_MAX × instances` below it |
| Data API exposed schemas must **not** include `mailer` | Project settings → Data API | Check only |

**Why two connections?**
- **Migrations** hold a session lock and run several transactions on one connection, so they need the **Session pooler** (port 6543 is refused).
- **The app** runs short transactions from many instances, so it uses the **Transaction pooler** as the restricted role `mailer_app`.
- The owner URL is never configured on the app or Vercel.

## 1. Private files (already created, placeholders only)

| File | Purpose | Status |
|---|---|---|
| `.env.migrate` | Owner, Session pooler | Mode 600, git-ignored (`.env.*`); replace each `<…>` locally |
| `.env.supabase` | Runtime role, Transaction pooler | Mode 600, git-ignored |

Until the `<…>` placeholders are replaced, every command below refuses to run ("not a valid postgres:// URL") without connecting. Check the permissions with `stat -f '%Sp %N' .env.migrate .env.supabase` (both should be `-rw-------`).

## 2. ✅ READ-ONLY: first connection check (owner)

```sh
node --env-file=.env.migrate scripts/db-check.js owner
```

**What it checks:**
- refuses port 6543;
- connects with TLS verification and reports the TLS protocol and certificate issuer;
- confirms the connection-time settings were accepted;
- reports the identity, server version and schema state (expected: "not migrated yet");
- checks the owner can create roles and schemas;
- runs a transaction (SET LOCAL timeouts, transaction-scoped advisory lock, parameterized query) that is **always rolled back**.

**If it fails:**

| Failure | Fix |
|---|---|
| Certificate error (e.g. `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`) | Download Supabase's CA, set `DATABASE_SSL_CA=/absolute/path` in `.env.migrate` (keep the file outside the repo), rerun. Never disable verification. |
| Error about an unsupported startup parameter | Set `PG_STARTUP_PARAMS=none` in `.env.migrate`, rerun. |
| `owner can create roles` = FAIL | Stop. Migration 0001 creates `mailer_runtime` and would fail cleanly. Ask before changing anything. |

## 3. ⚠ CHANGES THE REMOTE DATABASE: apply migration 0001

```sh
node --env-file=.env.migrate scripts/db-migrate.js
```

**It creates:**
- schema `mailer`;
- the NOLOGIN role `mailer_runtime`;
- the 5 tables with their constraints and indexes, plus `schema_migrations`;
- the 4 empty session slots;
- the revokes from `public`/`anon`/`authenticated`, the grants to `mailer_runtime`, and row-level security with one policy per table.

**Safety:** it runs in one transaction (all or nothing), is recorded with a checksum, and is safe to re-run (applies nothing the second time).

## 4. ✅ READ-ONLY: verify

```sh
node --env-file=.env.migrate scripts/db-check.js owner      # expect: schema_migrations version 1
```

Optionally, paste `docs/supabase/02_verify.sql` into the SQL editor. It's read-only, with the expected result on each line; the role checks pass only after step 6.

## 5. Runtime password (local, nothing leaves your machine)

1. Generate a password in your password manager: 32 or more characters from `A–Z a–z 0–9 . _ ~ -` (so it needs no URL encoding).
2. `node scripts/scram-verifier.js`: paste the password at the hidden prompt. It prints only a `SCRAM-SHA-256$…` hash. The hash is still sensitive, so don't share it.
3. Put the password into `DATABASE_URL` in `.env.supabase`.

## 6. ⚠ CHANGES THE REMOTE DATABASE: create the runtime login role

1. Open `docs/supabase/01_runtime_role.sql` in the SQL editor and replace `<SCRAM_VERIFIER>` (from step 5) and `<MAX_CONNECTIONS>` (e.g. 20, at most the pool size). Don't save the filled-in copy.
2. Run it.

**It creates:** `mailer_app` (LOGIN, INHERIT, no elevated attributes), as a member of `mailer_runtime`, with role-level `statement_timeout` 10 s, `idle_in_transaction_session_timeout` 15 s and `lock_timeout` 5 s.

Then re-run `02_verify.sql` (✅ read-only). The `mailer_app` lines should now match.

## 7. ✅ READ-ONLY: runtime connection check (Transaction pooler, restricted role)

```sh
node --env-file=.env.supabase scripts/db-check.js runtime
```

**What it checks:**
- **Custom-role login** through the pooler (`mailer_app.<PROJECT_REF>`) and the TLS certificate.
- **Pooler compatibility:** the connection-time settings, unnamed prepared statements, and transaction-scoped advisory locks plus `SET LOCAL` inside transactions.
- **Privileges:** membership of `mailer_runtime`, no elevated attributes, the exact table privileges from migration 0001 (anything extra fails), and the 4 slots visible through row-level security.

It writes nothing; its one transaction is rolled back. Use the same fixes as in step 2 (`DATABASE_SSL_CA`, `PG_STARTUP_PARAMS=none`) if needed.

## 8. ⚠ CHANGES THE REMOTE DATABASE: first admin account

```sh
node --env-file=.env.migrate --disable-warning=ExperimentalWarning scripts/admin.js create you@example.com
node --env-file=.env.migrate --disable-warning=ExperimentalWarning scripts/admin.js list      # ✅ read-only
```

## 9. ⚠ CHANGES THE REMOTE DATABASE (through the app): first local app test, dry run

```sh
node --env-file=.env --env-file=.env.supabase --disable-warning=ExperimentalWarning src/server.js
# → http://localhost:8796   (signing in writes login sessions and limiter rows; saving templates writes templates)
```

The later env file wins: `DB_BACKEND=postgres`, port 8796 and `EMAIL_DRY_RUN=true` come from `.env.supabase`. Nothing is emailed. Your normal `npm run dev` / `npm start` still use SQLite.

## Rollback considerations
- **Before step 3:** nothing to undo.
- **After step 3 or 6, before real data:** `docs/supabase/99_rollback.sql` (⛔ destructive; every statement is commented out) drops only schema `mailer` and the roles `mailer_app` and `mailer_runtime`. The migration is all-or-nothing, so a failed run leaves nothing half-applied.
- **Credentials:**
  - runtime password: `alter role mailer_app password '<new verifier>'`, then update `.env.supabase`;
  - owner password: reset it in the dashboard, then update `.env.migrate`.

  Rotate either if it is ever exposed.
- **The app is unaffected:** local SQLite and its backup are never touched. Running without `.env.supabase` returns to SQLite immediately.

## What local tests have and haven't proven

**Rehearsed locally** against a throwaway PostgreSQL 17: steps 2–7 with the real scripts and SQL files, a migration that applies once and then never again, the verifier hash accepted by PostgreSQL (and a wrong password refused), the role-level timeouts, and the runtime check passing with connection-time settings on and off while writing nothing.

**Not provable locally:** Supabase's TLS chain, Supavisor's handling of the connection-time settings, prepared statements and custom-role names, the `postgres` role's rights on Supabase, and pool limits. Steps 2 and 7 exist to check exactly these.
