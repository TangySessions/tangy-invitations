-- ✅ READ-ONLY — run in the Supabase SQL editor (as postgres) BEFORE applying
-- migration 0002_campaigns. Expected results are noted on each line; stop if
-- any line differs. Also run `node --env-file=.env.migrate scripts/db-migrate.js --plan`
-- (read-only) to see exactly which files would be applied.

select current_setting('server_version_num')::int >= 130000 as pg13_or_newer;   -- true (gen_random_uuid() is built in)
select coalesce(max(version), 0) as schema_version from mailer.schema_migrations;   -- 1
select version, name, checksum from mailer.schema_migrations order by version;   -- 1 | 0001_init | 82bf7d0f0439d52500d86b33662039ab76881e6176550d9dfdca66ae94fdfd1d
select to_regclass('mailer.campaigns') is null as no_campaigns,
       to_regclass('mailer.campaign_recipients') is null as no_recipients,
       to_regclass('mailer.suppressions') is null as no_suppressions;   -- true | true | true
select exists (select 1 from pg_roles where rolname = 'mailer_runtime') as runtime_role_exists;   -- true
select has_schema_privilege(current_user, 'mailer', 'create') as can_create_in_mailer;   -- true
select count(*) as functions_with_0002_names from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'mailer' and p.proname in ('campaigns_guard', 'campaigns_complete_list', 'campaign_recipients_guard', 'campaign_recipients_insert_guard');   -- 0
