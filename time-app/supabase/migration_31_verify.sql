-- ============================================================================
-- Withers Time, verification for migration 31 (the owner role)
--
-- Run by hand against a database with migration 31 applied, the same way as
-- migration_25_verify.sql (see its header), or locally with every other
-- verify file: `npm run test:db`. Everything happens inside one transaction
-- that ends in ROLLBACK. It needs the two owners, one manager and one
-- employee in public.profiles. A clean run ends with "migration 31 verified".
--
-- WHAT IS CHECKED
--   1. Exactly the two owner logins hold the owner role.
--   2. is_manager() is true for an owner and a manager, false for an
--      employee; is_owner() is true only for an owner. An owner off the
--      roster (active = false) still passes both.
--   3. An owner passes manager policies: reads every profile, reads the
--      audit log, adds a punch, edits a shift.
--   4. A manager cannot make anyone an owner (update or insert), cannot
--      demote an owner, cannot edit or delete an owner's row.
--   5. A manager can still edit and promote employees, as before.
--   6. An owner can grant and remove the owner role and edit another owner.
--   7. An owner can still edit their own name and phone (the Account page).
--   8. An employee cannot make themselves an owner.
--   9. The service role (invite upsert, offboarding) is not blocked.
--  10. The role CHECK allows exactly owner, manager and employee; the guard
--      is trigger-only and there is one of it.
-- ============================================================================

begin;

do $$
declare
  own1     uuid;
  own2     uuid;
  mgr      uuid;
  emp      uuid;
  spare    uuid := '00000000-0000-0000-0000-00000000f031';
  refused  boolean;
  n        integer;
  r        text;
  b        boolean;
  s_id     bigint;
begin
  select p.id into own1 from public.profiles p join auth.users u on u.id = p.id
   where lower(u.email) = 'alina@withers-ventures.com';
  select p.id into own2 from public.profiles p join auth.users u on u.id = p.id
   where lower(u.email) = 'alex@withers-ventures.com';
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if own1 is null or own2 is null or mgr is null or emp is null then
    raise exception 'need both owners, a manager and an employee in profiles to run this file';
  end if;

  -- 1. the owners, and only them
  select count(*) into n from public.profiles where role = 'owner';
  if n <> 2 then raise exception 'expected 2 owners, found %', n; end if;
  if (select role from public.profiles where id = own1) <> 'owner'
     or (select role from public.profiles where id = own2) <> 'owner' then
    raise exception 'an owner login does not hold the owner role';
  end if;

  -- Mirror production: the owners are off the roster.
  update public.profiles set active = false where id in (own1, own2);

  -- ---- as an owner -----------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', own1::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 2
  if not public.is_manager() then raise exception 'an owner off the roster is not is_manager()'; end if;
  if not public.is_owner() then raise exception 'an owner is not is_owner()'; end if;

  -- 3. manager policies let the owner in
  select count(*) into n from public.profiles;
  if n < 4 then raise exception 'an owner could not read every profile (saw %)', n; end if;
  perform 1 from public.row_audit limit 1;  -- manager-only SELECT; must not raise
  insert into public.time_entries (employee_id, clock_in_at, clock_out_at, status, manual)
  values (emp, now() - interval '30 hours', now() - interval '22 hours', 'closed', true);
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (emp, now() + interval '1 day', now() + interval '1 day 4 hours', 'verify-31', true)
  returning id into s_id;
  update public.shifts set ends_at = ends_at + interval '1 hour' where id = s_id;
  if not found then raise exception 'an owner could not edit a shift'; end if;

  -- 6. an owner may grant and remove the owner role, and edit another owner
  update public.profiles set role = 'owner' where id = mgr;
  if not found then raise exception 'an owner could not make a manager an owner'; end if;
  update public.profiles set role = 'manager' where id = mgr;
  update public.profiles set phone = '555-0131' where id = own2;
  if not found then raise exception 'an owner could not edit the other owner'; end if;

  -- 7. the Account page
  update public.profiles set full_name = full_name, phone = '555-0132' where id = own1;
  if not found then raise exception 'an owner could not edit their own name and phone'; end if;

  reset role;

  -- ---- as a manager ----------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if not public.is_manager() then raise exception 'a manager is not is_manager()'; end if;
  if public.is_owner() then raise exception 'a manager is is_owner()'; end if;

  -- 4. every way a manager could touch the owner role, each on its own
  foreach r in array array['promote employee', 'promote self', 'demote owner',
                           'edit owner phone', 'take owner off nothing', 'delete owner'] loop
    begin
      case r
        when 'promote employee' then update public.profiles set role = 'owner' where id = emp;
        when 'promote self'     then update public.profiles set role = 'owner' where id = mgr;
        when 'demote owner'     then update public.profiles set role = 'manager' where id = own1;
        when 'edit owner phone' then update public.profiles set phone = '555-0199' where id = own2;
        when 'take owner off nothing' then update public.profiles set active = true where id = own1;
        when 'delete owner'     then delete from public.profiles where id = own2;
      end case;
      refused := false;
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then raise exception 'a manager was allowed to: %', r; end if;
  end loop;

  -- 5. ordinary manager edits still work
  update public.profiles set role = 'manager' where id = emp;
  if not found then raise exception 'a manager could not promote an employee to manager'; end if;
  update public.profiles set role = 'employee', phone = '555-0133' where id = emp;
  if not found then raise exception 'a manager could not edit an employee'; end if;

  reset role;

  -- 4 (insert). A new login with no profile yet; a manager may create its
  -- profile, but not as an owner.
  insert into auth.users (id, email) values (spare, 'verify-31@example.test');
  delete from public.profiles where id = spare;

  set local role authenticated;
  begin
    insert into public.profiles (id, full_name, role) values (spare, 'Verify Spare', 'owner');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager created an owner profile'; end if;
  insert into public.profiles (id, full_name, role) values (spare, 'Verify Spare', 'employee');

  reset role;

  if (select role from public.profiles where id = own1) <> 'owner'
     or (select role from public.profiles where id = own2) <> 'owner'
     or (select role from public.profiles where id = emp) <> 'employee'
     or (select role from public.profiles where id = mgr) <> 'manager'
     or (select phone from public.profiles where id = own2) is distinct from '555-0131' then
    raise exception 'a refused edit left a change behind';
  end if;

  -- ---- 8. as an employee -----------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if public.is_manager() or public.is_owner() then
    raise exception 'an employee passes is_manager() or is_owner()';
  end if;
  begin
    update public.profiles set role = 'owner' where id = emp;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee made themselves an owner'; end if;

  reset role;

  -- ---- 9. the service role ---------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  update public.profiles set role = 'owner' where id = emp;
  if not found then raise exception 'the service role could not set a role'; end if;
  update public.profiles set role = 'employee' where id = emp;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 10. shape -------------------------------------------------------------
  begin
    update public.profiles set role = 'admin' where id = emp;
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'the role CHECK accepted ''admin'''; end if;

  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_owner_profiles()', 'execute') then
      raise exception '% can execute guard_owner_profiles(); it must be trigger-only', r;
    end if;
  end loop;

  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.profiles'::regclass
     and not tgisinternal
     and tgfoid = 'public.guard_owner_profiles()'::regprocedure;
  if n <> 1 then raise exception 'expected one owner guard on profiles, found %', n; end if;

  raise notice 'migration 31 verified';
end $$;

rollback;
