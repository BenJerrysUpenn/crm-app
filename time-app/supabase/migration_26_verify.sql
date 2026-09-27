-- ============================================================================
-- Withers Time — verification for migration 26 (QBO map, pay type, held tips)
--
-- Run by hand against a database with migration_26.sql applied, the same way
-- as migration_25_verify.sql (see its header). Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one active manager and one
-- employee in public.profiles. A clean run ends with "migration 26 verified".
--
-- WHAT IS CHECKED
--   1. An employee cannot make themselves a manager (profiles_update_self
--      allows any column; the guard trigger refuses a change to role).
--   2. An employee cannot change their own qbo_employee_id or pay_type.
--   3. An employee can still edit their own name and phone (AccountForm).
--   4. A manager can change another person's role and payroll columns.
--   5. The service role (auth.uid() is null) can set role, as the invite
--      upsert and the offboarding step (role back to employee) both do.
--   6. No API role can execute the trigger functions through /rest/v1/rpc.
-- ============================================================================

begin;

do $$
declare
  mgr     uuid;
  emp     uuid;
  refused boolean;
  r       text;
  f       text;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need one active manager and one employee in profiles to run this file';
  end if;

  -- ---- as the employee, through PostgREST ------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. self-promotion
  begin
    update public.profiles set role = 'manager' where id = emp;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee made themselves a manager'; end if;

  -- 2. payroll columns
  begin
    update public.profiles set qbo_employee_id = 'verify-26' where id = emp;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee changed their own qbo_employee_id'; end if;

  begin
    update public.profiles set pay_type = 'salaried' where id = emp;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee changed their own pay_type'; end if;

  -- 3. ordinary self-edits still work
  update public.profiles set phone = '555-0126', full_name = full_name where id = emp;
  if not found then raise exception 'an employee could not edit their own phone'; end if;

  reset role;

  -- ---- as a manager ----------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 4. a manager may change role and the payroll columns
  update public.profiles set role = 'manager', pay_type = 'hourly', qbo_employee_id = 'verify-26'
   where id = emp;
  if not found then raise exception 'a manager could not change another person''s role'; end if;
  update public.profiles set role = 'employee' where id = emp;

  reset role;

  -- ---- as the service role (invite upsert, offboarding) ----------------------
  perform set_config('request.jwt.claims',
    json_build_object('role', 'service_role')::text, true);
  set local role service_role;

  -- 5. no auth.uid(): trusted server context
  update public.profiles set role = 'manager' where id = emp;
  update public.profiles set role = 'employee' where id = emp;
  if (select role from public.profiles where id = emp) <> 'employee' then
    raise exception 'the service role could not set role back to employee';
  end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- 6. trigger-only functions are off the API
  foreach f in array array[
    'public.guard_payroll_profile_columns()',
    'public.touch_held_tips_updated_at()'
  ] loop
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(r, f, 'execute') then
        raise exception '% can execute %; it must be trigger-only', r, f;
      end if;
    end loop;
  end loop;

  raise notice 'migration 26 verified';
end $$;

rollback;
