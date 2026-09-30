-- ============================================================================
-- Withers Time, verification for migration 32 (profiles.archived_at)
--
-- Run by hand against a database with migration_32.sql applied. Everything
-- happens inside one transaction that ends in ROLLBACK, so no row changes.
-- It needs one manager and one other person in public.profiles. A clean run
-- ends with "migration 32 verified".
--
-- WHAT IS CHECKED
--   1. profiles.archived_at exists, is timestamptz, is nullable and has no
--      default (adding it archived nobody).
--   2. A manager, through RLS as the Team page PATCH does, can archive a
--      person (archived_at = now(), active = false) and unarchive them
--      (archived_at = null) and reads the change back.
-- ============================================================================

begin;

do $$
declare
  col  record;
  mgr  uuid;
  who  uuid;
  got  timestamptz;
begin
  -- 1. the column
  select data_type, is_nullable, column_default into col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name = 'archived_at';
  if not found then raise exception 'profiles.archived_at is missing'; end if;
  if col.data_type <> 'timestamp with time zone' then
    raise exception 'profiles.archived_at is %, expected timestamp with time zone', col.data_type;
  end if;
  if col.is_nullable <> 'YES' then raise exception 'profiles.archived_at must be nullable'; end if;
  if col.column_default is not null then
    raise exception 'profiles.archived_at has a default (%); adding it must archive nobody', col.column_default;
  end if;

  -- 2. a manager archives and unarchives someone through RLS
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into who from public.profiles where id <> mgr order by created_at limit 1;
  if mgr is null or who is null then
    raise exception 'need one manager and one other person in profiles to run this file';
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.profiles set archived_at = now(), active = false where id = who;
  select archived_at into got from public.profiles where id = who;
  if got is null then raise exception 'a manager could not archive someone through RLS'; end if;

  update public.profiles set archived_at = null where id = who;
  select archived_at into got from public.profiles where id = who;
  if got is not null then raise exception 'a manager could not unarchive someone through RLS'; end if;

  reset role;
  raise notice 'migration 32 verified';
end $$;

rollback;
