-- ============================================================================
-- Withers Time, verification for migration 55 (the schedulers' availability
-- email claim's WHERE clause — bj-finance #834).
--
-- Run by hand against a database with migration 55 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs two employees in
-- public.profiles. A clean run ends with "migration 55 verified". Every date
-- below is invented, so real queued notices on a live database are back,
-- untouched, after the ROLLBACK (the claim takes the whole queue, so on a live
-- database it is exercised only on a day long past, restored by the ROLLBACK).
--
-- WHAT IS CHECKED
--   1. THE GUARD (#834). The fixed claim_availability_digest's DELETE carries
--      an explicit WHERE and no longer has the bare "using fresh" that
--      migration 48 shipped. That WHERE is exactly what the service-role
--      safe-update guard (pg-safeupdate) demands — a DELETE with no WHERE is
--      what raised "DELETE requires a WHERE clause" on every cron run. The
--      guard extension is not present in this throwaway Postgres, so the
--      property is asserted against the function the catalog actually holds.
--   2. BEHAVIOUR UNCHANGED. The first claim of a day takes every queued notice
--      once and records the day; a second claim the same day returns nothing;
--      a notice queued after that day's email waits for the next day's; rows
--      over 60 days older than the day are pruned. (The WHERE deletes exactly
--      what the old USING cross-join did, so the once-a-day contract holds.)
--   3. GRANTS UNCHANGED. Only the service role may execute the claim.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  other   uuid;
  v_day   date := date '2017-03-15';
  n       integer;
  def     text;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into other from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if emp is null or other is null then
    raise exception 'need two employees in profiles to run this file';
  end if;

  -- ---- 1. the guard: the DELETE is WHERE-qualified, the migration-48 shape is gone ----
  def := pg_get_functiondef('public.claim_availability_digest(date)'::regprocedure);
  if position('where exists (select 1 from fresh)' in lower(def)) = 0 then
    raise exception 'claim_availability_digest has no "where exists (select 1 from fresh)" — the #834 WHERE is missing';
  end if;
  if position('using fresh' in lower(def)) <> 0 then
    raise exception 'claim_availability_digest still has the unqualified "using fresh" delete that raised #834';
  end if;

  -- ---- 2. the first claim takes the whole queue once a day ---------------------------
  insert into public.availability_notices (employee_id, changed_date) values (emp, v_day + 5);
  insert into public.availability_notices (employee_id, changed_weekday) values (other, 2);

  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day) c
   where (c.employee_id = emp and c.changed_date = v_day + 5) or (c.employee_id = other and c.changed_weekday = 2);
  reset role;
  if n <> 2 then raise exception 'the first availability claim returned % of 2 notices', n; end if;
  select count(*) into n from public.availability_notices;
  if n <> 0 then raise exception 'claimed availability notices are still queued'; end if;
  if not exists (select 1 from public.availability_digests where digest_day = v_day) then
    raise exception 'the availability claim did not record the day';
  end if;

  -- a second claim the same day takes nothing; a change queued after waits for tomorrow
  insert into public.availability_notices (employee_id, changed_weekday) values (emp, 4);
  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day);
  reset role;
  if n <> 0 then raise exception 'a second availability claim the same day returned % notices', n; end if;
  select count(*) into n from public.availability_notices where employee_id = emp and changed_weekday = 4;
  if n <> 1 then raise exception 'an availability notice queued after the day''s email did not wait'; end if;
  set local role service_role;
  select count(*) into n from public.claim_availability_digest(v_day + 1) c where c.employee_id = emp and c.changed_weekday = 4;
  reset role;
  if n <> 1 then raise exception 'the next day''s availability claim did not return the waiting notice'; end if;

  -- rows more than 60 days older than the day are pruned as the claim goes
  insert into public.availability_digests (digest_day) values (v_day - 61), (v_day - 60);
  set local role service_role;
  perform public.claim_availability_digest(v_day + 2);
  reset role;
  if exists (select 1 from public.availability_digests where digest_day = v_day - 61) then
    raise exception 'an availability email row more than 60 days old was not pruned';
  end if;

  -- ---- 3. only the service role may execute the claim --------------------------------
  if has_function_privilege('anon', 'public.claim_availability_digest(date)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_availability_digest(date)', 'execute') then
    raise exception 'a signed-in or anon role can execute claim_availability_digest';
  end if;
  if not has_function_privilege('service_role', 'public.claim_availability_digest(date)', 'execute') then
    raise exception 'service_role cannot execute claim_availability_digest';
  end if;

  raise notice 'migration 55 verified';
end $$;

rollback;
