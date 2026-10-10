-- ============================================================================
-- Withers Time, verification for migration 33 (no more draft shifts)
--
-- Run by hand against a database with migration_33.sql applied. Everything
-- happens inside one transaction that ends in ROLLBACK, so no row changes.
-- A clean run ends with "migration 33 verified".
--
-- WHAT IS CHECKED
--   1. shifts.published defaults to true.
--   2. No shift that has not finished yet is still a draft.
--   3. A shift inserted without naming published comes out published.
-- ============================================================================

begin;

do $$
declare
  dflt text;
  n    int;
  sid  bigint;
  pub  boolean;
begin
  -- 1. the default
  select column_default into dflt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'shifts' and column_name = 'published';
  if dflt is distinct from 'true' then
    raise exception 'shifts.published default is %, expected true', dflt;
  end if;

  -- 2. no unfinished drafts
  select count(*) into n from public.shifts where published = false and ends_at > now();
  if n <> 0 then
    raise exception '% unfinished shift(s) are still drafts', n;
  end if;

  -- 3. an insert that leaves the column out is live
  insert into public.shifts (employee_id, starts_at, ends_at, position)
  values (null, now() + interval '1 day', now() + interval '1 day 6 hours', 'verify-33')
  returning id, published into sid, pub;
  if pub is not true then
    raise exception 'a shift inserted without published came out published = %', pub;
  end if;

  raise notice 'migration 33 verified';
end;
$$;

rollback;
