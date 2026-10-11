-- ============================================================================
-- Withers Time, verification for migration 34 (staff cannot claim a catering
-- shift)
--
-- Run by hand against a database with migration 34 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one manager and one employee in
-- public.profiles. A clean run ends with "migration 34 verified".
--
-- WHAT IS CHECKED
--   1. An employee cannot set themselves on an open catering shift (deal_id
--      set) through their session, and the shift is left open.
--   2. An employee can still claim an ordinary open shift (no deal_id).
--   3. A manager can assign the catering shift, and take someone off it.
--   4. The service role (the catering shift writer, shift ack) can still
--      change a catering shift's person.
--   5. The guard is trigger-only and there is exactly one of it.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  s_cater  bigint;
  s_plain  bigint;
  refused  boolean;
  n        integer;
  r        text;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need one manager and one employee in profiles to run this file';
  end if;

  -- Fixtures, written as the table owner. deal_slot keeps the unique
  -- (deal_id, deal_slot) index happy.
  insert into public.shifts (employee_id, starts_at, ends_at, position, published, deal_id, deal_slot)
  values (null, now() + interval '1 day', now() + interval '1 day 5 hours', 'verify-34', true, 990034, 1)
  returning id into s_cater;
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (null, now() + interval '2 days', now() + interval '2 days 5 hours', 'verify-34', true)
  returning id into s_plain;

  -- ---- as the employee, through PostgREST ----------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. a catering shift cannot be claimed
  begin
    update public.shifts set employee_id = emp where id = s_cater;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee claimed a catering shift'; end if;

  -- 2. an ordinary open shift still can
  update public.shifts set employee_id = emp where id = s_plain;
  if not found then raise exception 'an employee could not claim an ordinary open shift'; end if;

  reset role;
  if (select employee_id from public.shifts where id = s_cater) is not null then
    raise exception 'a refused catering claim left a person on the shift';
  end if;

  -- ---- 3. as a manager (the schedule) --------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.shifts set employee_id = emp where id = s_cater;
  if not found then raise exception 'a manager could not assign a catering shift'; end if;
  update public.shifts set employee_id = null where id = s_cater;
  if not found then raise exception 'a manager could not take someone off a catering shift'; end if;

  reset role;

  -- ---- 4. the service role --------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;

  update public.shifts set employee_id = emp where id = s_cater;
  if not found then raise exception 'the service role could not assign a catering shift'; end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 5. shape --------------------------------------------------------------
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_catering_shift_claim()', 'execute') then
      raise exception '% can execute guard_catering_shift_claim(); it must be trigger-only', r;
    end if;
  end loop;

  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.shifts'::regclass
     and not tgisinternal
     and tgfoid = 'public.guard_catering_shift_claim()'::regprocedure;
  if n <> 1 then raise exception 'expected one catering assign guard on shifts, found %', n; end if;

  raise notice 'migration 34 verified';
end $$;

rollback;
