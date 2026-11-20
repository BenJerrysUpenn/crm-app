-- ============================================================================
-- Withers Time, verification for migration 45 (profiles.is_overhead)
--
-- Run by hand against a database with migration 45 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK, so no row changes. It needs an owner, a
-- manager and an employee in public.profiles. A clean run ends with
-- "migration 45 verified".
--
-- WHAT IS CHECKED
--   1. profiles.is_overhead exists, is boolean, NOT NULL, default false.
--   2. An employee cannot mark their own row overhead; their ordinary
--      self-edits, and an update that repeats is_overhead unchanged, still go
--      through.
--   3. A manager marks someone overhead and back through RLS (as a Team page
--      PATCH would) and reads the change back.
--   4. A manager who is not an owner cannot change an owner's is_overhead; an
--      owner can.
--   5. The service role (auth.uid() is null) can change it.
--   6. The guard function is still trigger-only, and still one trigger.
-- ============================================================================

begin;

do $$
declare
  col      record;
  own      uuid;
  mgr      uuid;
  emp      uuid;
  refused  boolean;
  got      boolean;
  r        text;
  n        integer;
begin
  -- 1. the column
  select data_type, is_nullable, column_default into col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_overhead';
  if not found then raise exception 'profiles.is_overhead is missing'; end if;
  if col.data_type <> 'boolean' then raise exception 'profiles.is_overhead is %, expected boolean', col.data_type; end if;
  if col.is_nullable <> 'NO' then raise exception 'profiles.is_overhead must be NOT NULL'; end if;
  if col.column_default is distinct from 'false' then
    raise exception 'profiles.is_overhead default is %, expected false', col.column_default;
  end if;

  select id into own from public.profiles where role = 'owner' order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if own is null or mgr is null or emp is null then
    raise exception 'need an owner, a manager and an employee in profiles to run this file';
  end if;
  update public.profiles set is_overhead = false where id in (own, emp);

  -- ---- 2. as the employee ------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.profiles set full_name = full_name, phone = '555-0145', is_overhead = is_overhead where id = emp;
  if not found then raise exception 'an employee could not edit their own row'; end if;

  begin
    update public.profiles set is_overhead = true where id = emp;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee marked their own row overhead'; end if;
  reset role;

  -- ---- 3. a manager, through RLS -----------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  update public.profiles set is_overhead = true where id = emp;
  select is_overhead into got from public.profiles where id = emp;
  if got is not true then raise exception 'a manager could not mark someone overhead'; end if;
  update public.profiles set is_overhead = false where id = emp;
  select is_overhead into got from public.profiles where id = emp;
  if got is not false then raise exception 'a manager could not clear someone''s overhead flag'; end if;

  -- 4. not an owner's row
  begin
    update public.profiles set is_overhead = true where id = own;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed an owner''s overhead flag'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', own::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.profiles set is_overhead = true where id = own;
  select is_overhead into got from public.profiles where id = own;
  if got is not true then raise exception 'an owner could not mark their own row overhead'; end if;
  reset role;

  -- ---- 5. the service role -----------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  update public.profiles set is_overhead = true where id = emp;
  if not found then raise exception 'the service role could not mark someone overhead'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 6. the guard ------------------------------------------------------------
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_payroll_profile_columns()', 'execute') then
      raise exception '% can execute guard_payroll_profile_columns(); it must be trigger-only', r;
    end if;
  end loop;
  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and not tgisinternal
     and tgfoid = 'public.guard_payroll_profile_columns()'::regprocedure;
  if n <> 1 then raise exception 'expected one guard trigger on profiles, found %', n; end if;

  raise notice 'migration 45 verified';
end $$;

rollback;
