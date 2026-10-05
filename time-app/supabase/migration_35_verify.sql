-- ============================================================================
-- Withers Time, verification for migration 35 (a cover punch is never a short
-- punch)
--
-- Run by hand against a database with migration 35 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs two employees in
-- public.profiles. A clean run ends with "migration 35 verified".
--
-- WHAT IS CHECKED
--   1. A short punch with no shift_id, inside somebody else's unpunched shift
--      (a 1.10 cover), is not a 1.5 blocker.
--   2. The same punch with that shift as its shift_id is a 1.5 blocker.
--   3. A short punch inside the person's own shift that day, no shift_id, is
--      still a 1.5 blocker.
--   4. The function is still not executable by any API role.
-- ============================================================================

begin;

do $$
declare
  emp      uuid;
  other    uuid;
  v_end    date := date '2026-09-20' - 14 * 201;  -- on the cycle, in 2018
  v_day    date;
  v_punch  bigint;
  v_shift  bigint;
  v_own    bigint;
  n        integer;
  r        text;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into other from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if emp is null or other is null then
    raise exception 'need two employees in profiles to run this file';
  end if;
  v_day := v_end - 3;

  -- Somebody else's 6h opener, which they did not punch for.
  insert into public.shifts (employee_id, starts_at, ends_at, position)
  values (other, (v_day + time '11:00') at time zone 'America/New_York',
                 (v_day + time '17:00') at time zone 'America/New_York', 'PENN Opener')
  returning id into v_shift;

  -- A 44-minute punch inside it, no shift_id: the 1.10 ladder calls it a cover.
  insert into public.time_entries (employee_id, clock_in_at, clock_out_at, status)
  values (emp, (v_day + time '12:16') at time zone 'America/New_York',
               (v_day + time '13:00') at time zone 'America/New_York', 'closed')
  returning id into v_punch;

  -- ---- 1. a cover is not a short punch -----------------------------------------
  select count(*) into n from public.payroll_punch_blockers(v_end) b
   where b.check_id = '1.5' and b.punch_id = v_punch;
  if n <> 0 then raise exception 'a short cover punch is still a 1.5 blocker'; end if;

  -- ---- 2. an explicit shift_id still is ----------------------------------------
  update public.time_entries set shift_id = v_shift where id = v_punch;
  select count(*) into n from public.payroll_punch_blockers(v_end) b
   where b.check_id = '1.5' and b.punch_id = v_punch;
  if n <> 1 then raise exception 'a short punch on its own shift_id is not a 1.5 blocker'; end if;

  -- ---- 3. the person's own shift that day still is -----------------------------
  update public.time_entries set shift_id = null where id = v_punch;
  insert into public.shifts (employee_id, starts_at, ends_at, position)
  values (emp, (v_day + time '11:00') at time zone 'America/New_York',
               (v_day + time '17:00') at time zone 'America/New_York', 'PENN Opener')
  returning id into v_own;
  select count(*) into n from public.payroll_punch_blockers(v_end) b
   where b.check_id = '1.5' and b.punch_id = v_punch;
  if n <> 1 then raise exception 'a short punch inside the person''s own shift is not a 1.5 blocker'; end if;

  -- ---- 4. still not callable from the API --------------------------------------
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.payroll_punch_blockers(date)', 'execute') then
      raise exception '% can execute payroll_punch_blockers(date)', r;
    end if;
  end loop;

  raise notice 'migration 35 verified';
end $$;

rollback;
