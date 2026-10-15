-- ============================================================================
-- Withers Time, verification for migration 38 (one shift summary a day)
--
-- Run by hand against a database with migration 38 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs two employees in
-- public.profiles. A clean run ends with "migration 38 verified".
--
-- Counts are of the rows this file makes, so real queued notices on a live
-- database do not disturb it (and are back, untouched, after the ROLLBACK).
--
-- WHAT IS CHECKED
--   1. A notice is 'posted' or 'changed', nothing else.
--   2. The service role claims a day: every person with queued notices gets
--      a summary row for that day, and their notices come back and leave the
--      queue.
--   3. A second claim the same day returns nothing for someone already
--      summarised; what they had queued since waits, and the next day's claim
--      returns it.
--   4. Deleting a shift drops its queued notices.
--   5. Summary rows more than 60 days older than the day claimed are pruned.
--   6. No signed-in user reads or writes either table; only the service role
--      executes claim_shift_digests.
-- ============================================================================

begin;

do $$
declare
  emp      uuid;
  other    uuid;
  v_day    date := date '2018-06-15';
  s1       bigint;
  s2       bigint;
  s3       bigint;
  n        integer;
  refused  boolean;
  r        text;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into other from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if emp is null or other is null then
    raise exception 'need two employees in profiles to run this file';
  end if;

  insert into public.shifts (employee_id, starts_at, ends_at, published)
  values (emp, (v_day + 3 + time '12:00') at time zone 'America/New_York',
               (v_day + 3 + time '17:00') at time zone 'America/New_York', true)
  returning id into s1;
  insert into public.shifts (employee_id, starts_at, ends_at, published)
  values (emp, (v_day + 4 + time '12:00') at time zone 'America/New_York',
               (v_day + 4 + time '17:00') at time zone 'America/New_York', true)
  returning id into s2;
  insert into public.shifts (employee_id, starts_at, ends_at, published)
  values (other, (v_day + 3 + time '17:00') at time zone 'America/New_York',
                 (v_day + 3 + time '22:00') at time zone 'America/New_York', true)
  returning id into s3;

  -- ---- 1. what a notice may say ---------------------------------------------------
  begin
    insert into public.shift_notices (shift_id, employee_id, notice) values (s1, emp, 'cancelled');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a notice other than posted/changed was accepted'; end if;

  -- ---- 2. the service role claims a day ----------------------------------------------
  insert into public.shift_notices (shift_id, employee_id, notice) values
    (s1, emp, 'posted'), (s1, emp, 'changed'), (s3, other, 'posted');

  set local role service_role;
  select count(*) into n from public.claim_shift_digests(v_day) c where c.shift_id in (s1, s2, s3);
  reset role;
  if n <> 3 then raise exception 'the first claim returned % of 3 notices', n; end if;
  select count(*) into n from public.shift_notices where shift_id in (s1, s2, s3);
  if n <> 0 then raise exception 'claimed notices are still queued'; end if;
  select count(*) into n from public.shift_digests where digest_day = v_day and employee_id in (emp, other);
  if n <> 2 then raise exception 'the claim recorded % of 2 summaries', n; end if;

  -- ---- 3. once a day ---------------------------------------------------------------
  insert into public.shift_notices (shift_id, employee_id, notice) values (s2, emp, 'changed');
  select count(*) into n from public.claim_shift_digests(v_day) c where c.shift_id in (s1, s2, s3);
  if n <> 0 then raise exception 'a second claim the same day returned % notices', n; end if;
  select count(*) into n from public.shift_notices where shift_id = s2;
  if n <> 1 then raise exception 'a notice queued after the day''s summary did not wait'; end if;
  select count(*) into n from public.claim_shift_digests(v_day + 1) c where c.shift_id = s2 and c.employee_id = emp;
  if n <> 1 then raise exception 'the next day''s claim did not return the waiting notice'; end if;

  -- ---- 4. a deleted shift drops its notices -----------------------------------------
  insert into public.shift_notices (shift_id, employee_id, notice) values (s1, emp, 'changed');
  delete from public.shifts where id = s1;
  select count(*) into n from public.shift_notices where shift_id = s1;
  if n <> 0 then raise exception 'a deleted shift''s notice is still queued'; end if;

  -- ---- 5. old summary rows are pruned ------------------------------------------------
  insert into public.shift_digests (employee_id, digest_day) values (emp, v_day - 61), (emp, v_day - 60);
  perform public.claim_shift_digests(v_day);
  if exists (select 1 from public.shift_digests where employee_id = emp and digest_day = v_day - 61) then
    raise exception 'a summary row 61 days old was not pruned';
  end if;
  if not exists (select 1 from public.shift_digests where employee_id = emp and digest_day = v_day - 60) then
    raise exception 'a summary row 60 days old was pruned';
  end if;

  -- ---- 6. who may touch it -----------------------------------------------------------
  insert into public.shift_notices (shift_id, employee_id, notice) values (s2, emp, 'changed');
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.shift_notices;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user can read shift_notices'; end if;
  begin
    insert into public.shift_notices (shift_id, employee_id, notice) values (s2, emp, 'posted');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user can insert into shift_notices'; end if;
  begin
    select count(*) into n from public.shift_digests;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user can read shift_digests'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.claim_shift_digests(date)', 'execute') then
      raise exception '% can execute claim_shift_digests(date)', r;
    end if;
    if has_table_privilege(r, 'public.shift_notices', 'select')
       or has_table_privilege(r, 'public.shift_notices', 'insert')
       or has_table_privilege(r, 'public.shift_digests', 'select')
       or has_table_privilege(r, 'public.shift_digests', 'insert') then
      raise exception '% holds privileges on the shift summary tables', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.claim_shift_digests(date)', 'execute') then
    raise exception 'service_role cannot execute claim_shift_digests(date)';
  end if;

  raise notice 'migration 38 verified';
end $$;

rollback;
