-- ============================================================================
-- Withers CRM — verification for migration crm/011 (pf_category_overrides)
--
-- Run against a database with 011_pf_category_overrides.sql applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/011_pf_category_overrides_verify.sql
-- Everything runs in one transaction that ends in ROLLBACK, so no row
-- changes. A clean run ends with "migration crm/011 verified".
--
-- WHAT IS CHECKED
--   1. RLS is on and the table has no policy at all.
--   2. anon and authenticated hold no privilege on it; service_role holds
--      SELECT and INSERT and nothing else.
--   3. The CHECKs: a transaction-scope row needs txn_id, scope is one of
--      two words, blank merchant and category are refused.
--   4. A good row of each scope inserts, with id and created_at defaulted.
-- ============================================================================

begin;

do $$
declare
  n int;
  privs text;
  outcome text;
begin
  -- 1. RLS on, no policies
  select count(*) into n from pg_class
   where oid = 'public.pf_category_overrides'::regclass and relrowsecurity;
  if n <> 1 then raise exception 'RLS is not enabled'; end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'pf_category_overrides';
  if n <> 0 then raise exception 'expected no policies, found %', n; end if;

  -- 2. privileges
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'pf_category_overrides'
     and grantee in ('anon', 'authenticated');
  if n <> 0 then raise exception 'anon/authenticated hold % privileges', n; end if;
  select string_agg(privilege_type, ',' order by privilege_type) into privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'pf_category_overrides'
     and grantee = 'service_role';
  if privs is distinct from 'INSERT,SELECT' then
    raise exception 'service_role holds %, expected INSERT,SELECT', privs;
  end if;

  -- 3. CHECKs refuse bad rows
  begin
    insert into public.pf_category_overrides (scope, merchant, category, created_by)
    values ('transaction', 'Probe', 'Groceries', gen_random_uuid());
    outcome := 'accepted';
  exception when check_violation then outcome := 'refused';
  end;
  if outcome <> 'refused' then raise exception 'transaction scope without txn_id was accepted'; end if;

  begin
    insert into public.pf_category_overrides (scope, merchant, category, created_by)
    values ('everything', 'Probe', 'Groceries', gen_random_uuid());
    outcome := 'accepted';
  exception when check_violation then outcome := 'refused';
  end;
  if outcome <> 'refused' then raise exception 'unknown scope was accepted'; end if;

  begin
    insert into public.pf_category_overrides (scope, merchant, category, created_by)
    values ('merchant', '  ', 'Groceries', gen_random_uuid());
    outcome := 'accepted';
  exception when check_violation then outcome := 'refused';
  end;
  if outcome <> 'refused' then raise exception 'blank merchant was accepted'; end if;

  begin
    insert into public.pf_category_overrides (scope, merchant, category, created_by)
    values ('merchant', 'Probe', '', gen_random_uuid());
    outcome := 'accepted';
  exception when check_violation then outcome := 'refused';
  end;
  if outcome <> 'refused' then raise exception 'blank category was accepted'; end if;

  -- 4. good rows insert
  insert into public.pf_category_overrides (scope, txn_id, merchant, category, created_by)
  values ('transaction', 'probe-1', 'Probe', 'Household Employees ', gen_random_uuid()),
         ('merchant', 'probe-2', 'Probe', 'Groceries', gen_random_uuid());
  select count(*) into n from public.pf_category_overrides
   where merchant = 'Probe' and id is not null and created_at is not null;
  if n <> 2 then raise exception 'good rows did not insert'; end if;

  raise notice 'migration crm/011 verified';
end $$;

rollback;
