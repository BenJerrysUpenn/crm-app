-- ============================================================================
-- Withers Time — verification for migration 28 (employees cannot change their
-- own hourly_rate or active flag)
--
-- Run by hand against a database with migrations 26 and 28 applied, the same
-- way as migration_25_verify.sql (see its header). Everything happens inside
-- one transaction that ends in ROLLBACK. It needs one active manager and one
-- active employee in public.profiles. A clean run ends with
-- "migration 28 verified".
--
-- WHAT IS CHECKED
--   1. An employee can still edit their own name, phone and notification
--      preferences (AccountForm), and an update that repeats the guarded
--      columns unchanged still goes through.
--   2. An employee cannot change any of the five guarded columns on their own
--      row: role, qbo_employee_id, pay_type (migration 26) and hourly_rate,
--      active (this migration). Each is tried on its own.
--   3. A manager can change all five on somebody else's row.
--   4. The service role (auth.uid() is null: the invite upsert, offboarding)
--      can change all five.
--   5. The guard function is trigger-only: no API role can execute it, so it
--      is not on /rest/v1/rpc.
--   6. Exactly one guard trigger sits on public.profiles.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  refused  boolean;
  col      text;
  r        text;
  n        integer;
  old_rate numeric;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' and active order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need one active manager and one active employee in profiles to run this file';
  end if;
  select hourly_rate into old_rate from public.profiles where id = emp;

  -- ---- as the employee, through PostgREST ------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. ordinary self-edits still work
  update public.profiles
     set full_name = full_name, phone = '555-0128', notif_prefs = '{}'::jsonb
   where id = emp;
  if not found then raise exception 'an employee could not edit their own name and phone'; end if;

  -- A form that sends the whole row back unchanged is not a change.
  update public.profiles
     set hourly_rate = hourly_rate, active = active, role = role,
         pay_type = pay_type, qbo_employee_id = qbo_employee_id
   where id = emp;
  if not found then raise exception 'an unchanged guarded column was refused'; end if;

  -- 2. each guarded column, on its own
  foreach col in array array['role', 'qbo_employee_id', 'pay_type', 'hourly_rate', 'active'] loop
    begin
      execute case col
        when 'role'            then 'update public.profiles set role = ''manager'' where id = $1'
        when 'qbo_employee_id' then 'update public.profiles set qbo_employee_id = ''verify-28'' where id = $1'
        when 'pay_type'        then 'update public.profiles set pay_type = ''salaried'' where id = $1'
        when 'hourly_rate'     then 'update public.profiles set hourly_rate = coalesce(hourly_rate, 0) + 5 where id = $1'
        when 'active'          then 'update public.profiles set active = not active where id = $1'
      end using emp;
      refused := false;
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then raise exception 'an employee changed their own %', col; end if;
  end loop;

  reset role;
  if (select hourly_rate from public.profiles where id = emp) is distinct from old_rate
     or not (select active from public.profiles where id = emp) then
    raise exception 'a refused self-edit left a change behind';
  end if;

  -- ---- as a manager ----------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 3. a manager may change all five (the Team page)
  update public.profiles
     set role = 'manager', qbo_employee_id = 'verify-28', pay_type = 'hourly',
         hourly_rate = coalesce(hourly_rate, 0) + 1, active = false
   where id = emp;
  if not found then raise exception 'a manager could not change the guarded columns'; end if;
  update public.profiles
     set role = 'employee', qbo_employee_id = null, pay_type = null,
         hourly_rate = old_rate, active = true
   where id = emp;

  reset role;

  -- ---- as the service role (invite upsert, offboarding) ----------------------
  perform set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text, true);
  set local role service_role;

  -- 4. no auth.uid(): trusted server context
  update public.profiles
     set role = 'manager', qbo_employee_id = 'verify-28', pay_type = 'salaried',
         hourly_rate = 99, active = false
   where id = emp;
  if not found then raise exception 'the service role could not change the guarded columns'; end if;
  update public.profiles
     set role = 'employee', qbo_employee_id = null, pay_type = null,
         hourly_rate = old_rate, active = true
   where id = emp;
  if (select active from public.profiles where id = emp) is not true then
    raise exception 'the service role could not set active back';
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- 5. trigger-only function is off the API
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_payroll_profile_columns()', 'execute') then
      raise exception '% can execute guard_payroll_profile_columns(); it must be trigger-only', r;
    end if;
  end loop;

  -- 6. one guard, not two
  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and not tgisinternal
     and tgfoid = 'public.guard_payroll_profile_columns()'::regprocedure;
  if n <> 1 then raise exception 'expected one guard trigger on profiles, found %', n; end if;

  raise notice 'migration 28 verified';
end $$;

rollback;
