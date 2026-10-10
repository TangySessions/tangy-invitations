-- ✅ READ-ONLY — safe to run at any time in the Supabase SQL editor (as postgres).
-- Expected results are noted on each line.

select version, name, applied_at from mailer.schema_migrations order by version;   -- 1 | 0001_init
select id, slot, configured, active, version from mailer.session_templates order by slot;   -- 4 rows
select rolname, rolcanlogin, rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconnlimit
  from pg_roles where rolname in ('mailer_runtime', 'mailer_app') order by 1;     -- runtime: no login; app: login, inherit, no elevated attributes
select pg_has_role('mailer_app', 'mailer_runtime', 'usage') as app_inherits_runtime;  -- true
select rolname, rolconfig from pg_roles where rolname = 'mailer_app';            -- statement_timeout=10s, idle…=15s, lock_timeout=5s
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where grantee = 'mailer_runtime' and table_schema = 'mailer'
 group by 1 order by 1;
--   admins: SELECT | login_attempts: DELETE, INSERT, SELECT, UPDATE | login_sessions: DELETE, INSERT, SELECT, UPDATE
--   schema_migrations: SELECT | send_log: INSERT, SELECT, UPDATE | session_templates: SELECT, UPDATE
select tablename, rowsecurity from pg_tables where schemaname = 'mailer' order by 1;   -- true for the 5 app tables
select tablename, policyname, roles from pg_policies where schemaname = 'mailer' order by 1;   -- mailer_runtime_access → {mailer_runtime}
select r as role, has_schema_privilege(r, 'mailer', 'usage') as can_use_schema
  from unnest(array['anon', 'authenticated', 'service_role', 'authenticator']) as r
 where exists (select 1 from pg_roles where rolname = r);   -- all false (Supabase API roles)
select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner from pg_namespace n where nspname = 'mailer';   -- owner postgres
