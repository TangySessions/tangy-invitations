-- ✅ READ-ONLY — run in the Supabase SQL editor (as postgres) AFTER applying
-- migration 0002_campaigns. Expected results are noted on each line.

select version, name from mailer.schema_migrations order by version;   -- 1 | 0001_init, 2 | 0002_campaigns
select table_name, string_agg(privilege_type, ', ' order by privilege_type) as privileges
  from information_schema.role_table_grants
 where grantee = 'mailer_runtime' and table_schema = 'mailer' and table_name in ('campaigns', 'campaign_recipients', 'suppressions')
 group by 1 order by 1;
--   campaign_recipients: INSERT, SELECT, UPDATE | campaigns: INSERT, SELECT, UPDATE | suppressions: INSERT, SELECT   (never DELETE)
select tablename, rowsecurity from pg_tables where schemaname = 'mailer' and tablename in ('campaigns', 'campaign_recipients', 'suppressions') order by 1;   -- all true
select tablename, policyname, roles from pg_policies where schemaname = 'mailer' and tablename in ('campaigns', 'campaign_recipients', 'suppressions') order by 1;   -- mailer_runtime_access → {mailer_runtime} for each
select event_object_table as table_name, trigger_name from information_schema.triggers
 where trigger_schema = 'mailer' group by 1, 2 order by 1, 2;
--   campaign_recipients: campaign_recipients_guard, campaign_recipients_insert_guard | campaigns: campaigns_complete_list, campaigns_guard
select column_name, data_type, column_default, is_nullable from information_schema.columns
 where table_schema = 'mailer' and table_name = 'campaign_recipients' and column_name = 'people';   -- people | smallint | 1 | NO
select pg_get_constraintdef(c.oid) as people_check from pg_constraint c
 where c.conrelid = 'mailer.campaign_recipients'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) like '%people%';   -- CHECK (((people >= 1) AND (people <= 50)))
select indexname from pg_indexes where schemaname = 'mailer' and indexname in ('campaigns_one_open_per_session', 'campaign_recipients_due_idx', 'campaign_recipients_pending_email_idx') order by 1;   -- 3 rows
select r as role, has_table_privilege(r, 'mailer.suppressions', 'select') as can_read_suppressions
  from unnest(array['anon', 'authenticated']) as r where exists (select 1 from pg_roles where rolname = r);   -- all false
select count(*) as campaigns, (select count(*) from mailer.suppressions) as suppressions from mailer.campaigns;   -- 0 | 0 right after applying
