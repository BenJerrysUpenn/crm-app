-- ============================================================================
-- Withers CRM — verification for migration crm/013 (shared sequence storage)
--
-- Run by hand against a database with 013_email_campaign_sequences.sql applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/013_email_campaign_sequences_verify.sql
-- Read-only: one transaction that ends in ROLLBACK. A clean run ends with
-- "migration crm/013 verified".
--
-- WHAT IS CHECKED
--   1. The three tables exist with row level security enabled.
--   2. The policies exist: full access on sequences and lane blocks, and
--      select / insert / update (no delete) on conflicts.
--   3. anon holds no privilege on any of them; authenticated cannot delete
--      a conflict.
--   4. The same browser copy is stored once per key (the unique index), and
--      a different copy is stored beside it.
-- ============================================================================

begin;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['email_campaign_sequences', 'email_campaign_lane_blocks',
                           'email_campaign_sequence_conflicts']
  loop
    if to_regclass('public.' || t) is null then raise exception 'public.% is missing', t; end if;
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'public.% does not have row level security enabled', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT')
       or has_table_privilege('anon', 'public.' || t, 'INSERT')
       or has_table_privilege('anon', 'public.' || t, 'UPDATE')
       or has_table_privilege('anon', 'public.' || t, 'DELETE') then
      raise exception 'anon holds a privilege on public.%', t;
    end if;
  end loop;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'email_campaign_sequences' and cmd = 'ALL';
  if n <> 1 then raise exception 'email_campaign_sequences: expected 1 FOR ALL policy, found %', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'email_campaign_lane_blocks' and cmd = 'ALL';
  if n <> 1 then raise exception 'email_campaign_lane_blocks: expected 1 FOR ALL policy, found %', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'email_campaign_sequence_conflicts'
     and cmd in ('SELECT', 'INSERT', 'UPDATE');
  if n <> 3 then raise exception 'email_campaign_sequence_conflicts: expected 3 policies, found %', n; end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'email_campaign_sequence_conflicts'
     and cmd in ('DELETE', 'ALL');
  if n <> 0 then raise exception 'email_campaign_sequence_conflicts must have no delete policy'; end if;

  if has_table_privilege('authenticated', 'public.email_campaign_sequence_conflicts', 'DELETE') then
    raise exception 'authenticated may delete a conflict';
  end if;

  -- The unique index: the same copy twice is refused, a different copy is not.
  insert into public.email_campaign_sequence_conflicts (kind, key, doc)
    values ('sequence', 'warm:verify_013', '{"name": "a", "steps": []}');
  begin
    insert into public.email_campaign_sequence_conflicts (kind, key, doc)
      values ('sequence', 'warm:verify_013', '{"steps": [], "name": "a"}');
    raise exception 'the same conflict copy was stored twice';
  exception when unique_violation then
    null;
  end;
  insert into public.email_campaign_sequence_conflicts (kind, key, doc)
    values ('sequence', 'warm:verify_013', '{"name": "b", "steps": []}');

  raise notice 'migration crm/013 verified';
end $$;

rollback;
