-- ============================================================================
-- Withers Time, verification for migration 30 (staff punch writes, shift
-- claim)
--
-- Run by hand against a database with migration 30 applied, the same way as
-- migration_25_verify.sql (see its header), or locally with every other
-- verify file: `npm run test:db` (supabase/local/verify.sh builds a throwaway
-- Postgres, applies every migration in order, and runs them all). Everything
-- happens inside one
-- transaction that ends in ROLLBACK. It needs one manager, and one employee
-- who is not clocked in right now, in public.profiles. A clean run ends with
-- "migration 30 verified".
--
-- WHAT IS CHECKED
--   1. The service role, which is how the Pi fob clock, /api/clock and the
--      clock-out snooze route write, can still clock someone in and out and
--      set the reminder columns. That includes a person off the roster
--      (active = false): a fob tap is never refused.
--   2. An employee can still read their own punches.
--   3. An employee cannot insert a punch, or change or delete one of their own,
--      through their session (the /rest/v1 path from audit H1).
--   4. A manager can still insert, edit and delete anyone's punches (the
--      Timesheets page).
--   5. An employee can claim an open published shift for themselves, and the
--      claim is stamped with the database's own time.
--   6. A claim that also changes any other column (times, position, deal,
--      notes, published) is refused, as is a claim for somebody else
--      and a change to a shift that is already assigned.
--   7. A manager and the service role can still change any shift.
--   8. The guard is trigger-only, there is exactly one of it, and the two
--      time_entries policies use the (select public.is_manager()) wrapper.
-- ============================================================================

begin;

do $$
declare
  mgr       uuid;
  emp       uuid;
  e_id      bigint;
  m_id      bigint;
  s_open    bigint;
  s_open2   bigint;
  s_taken   bigint;
  refused   boolean;
  col       text;
  n         integer;
  r         text;
  stamp     timestamptz;
  old_in    timestamptz;
  old_start timestamptz;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select p.id into emp
    from public.profiles p
   where p.role = 'employee'
     and not exists (select 1 from public.time_entries t
                      where t.employee_id = p.id and t.status = 'open')
   order by p.created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need one manager, and one employee who is not clocked in, in profiles to run this file';
  end if;

  -- Fixtures, written as the table owner.
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (null, now() + interval '1 day', now() + interval '1 day 6 hours', 'verify-30', true)
  returning id into s_open;
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (null, now() + interval '2 days', now() + interval '2 days 6 hours', 'verify-30', true)
  returning id into s_open2;
  select starts_at into old_start from public.shifts where id = s_open2;
  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (mgr, now() + interval '3 days', now() + interval '3 days 6 hours', 'verify-30', true)
  returning id into s_taken;
  update public.shifts set updated_at = now() - interval '1 day' where id = s_open;

  -- ---- 1. the service role: Pi fob tap, /api/clock, snooze -----------------
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;

  insert into public.time_entries (employee_id, clock_in_at, status)
  values (emp, now() - interval '5 minutes', 'open')
  returning id into e_id;
  if e_id is null then raise exception 'the service role could not clock someone in'; end if;

  update public.time_entries
     set clockout_reminder_snoozed_until = now() + interval '30 minutes',
         clockout_reminder_dismissed_at = now()
   where id = e_id;
  if not found then raise exception 'the service role could not set the clock-out reminder columns'; end if;

  update public.time_entries
     set clock_out_at = now(), status = 'closed'
   where id = e_id and employee_id = emp and status = 'open';
  if not found then raise exception 'the service role could not clock someone out'; end if;

  reset role;
  update public.profiles set active = false where id = emp;
  set local role service_role;

  insert into public.time_entries (employee_id, clock_in_at, status)
  values (emp, now(), 'open')
  returning id into e_id;
  if e_id is null then raise exception 'a fob tap for someone off the roster was refused'; end if;

  reset role;
  update public.profiles set active = true where id = emp;
  select clock_in_at into old_in from public.time_entries where id = e_id;

  -- ---- as the employee, through PostgREST ----------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 2. reading your own punches still works
  select count(*) into n from public.time_entries where employee_id = emp;
  if n < 2 then raise exception 'an employee could not read their own punches (saw %)', n; end if;

  -- 3. no insert, update or delete of your own punches
  begin
    insert into public.time_entries (employee_id, clock_in_at, clock_out_at, status)
    values (emp, now() - interval '30 hours', now() - interval '22 hours', 'closed');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee inserted a punch for themselves'; end if;

  update public.time_entries set clock_in_at = clock_in_at - interval '3 hours' where id = e_id;
  if found then raise exception 'an employee moved their own clock-in'; end if;

  update public.time_entries set clock_out_at = now(), status = 'closed' where id = e_id;
  if found then raise exception 'an employee clocked themselves out around /api/clock'; end if;

  delete from public.time_entries where id = e_id;
  if found then raise exception 'an employee deleted their own punch'; end if;

  -- 5. a plain claim goes through, whatever updated_at was sent
  update public.shifts
     set employee_id = emp, updated_at = '2000-01-01'
   where id = s_open;
  if not found then raise exception 'an employee could not claim an open shift'; end if;

  -- 6. a claim that changes anything else is refused, column by column
  foreach col in array array['starts_at', 'ends_at', 'position', 'deal_id', 'notes', 'published'] loop
    begin
      execute case col
        when 'starts_at'   then 'update public.shifts set employee_id = $2, starts_at = starts_at - interval ''2 hours'' where id = $1'
        when 'ends_at'     then 'update public.shifts set employee_id = $2, ends_at = ends_at + interval ''4 hours'' where id = $1'
        when 'position'    then 'update public.shifts set employee_id = $2, position = ''verify-30-other'' where id = $1'
        when 'deal_id'     then 'update public.shifts set employee_id = $2, deal_id = 999999 where id = $1'
        when 'notes'       then 'update public.shifts set employee_id = $2, notes = ''mine now'' where id = $1'
        when 'published'   then 'update public.shifts set employee_id = $2, published = false where id = $1'
      end using s_open2, emp;
      refused := false;
    exception when insufficient_privilege then
      refused := true;
    end;
    if not refused then raise exception 'a claim also changed %', col; end if;
  end loop;

  begin
    update public.shifts set employee_id = mgr where id = s_open2;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee claimed a shift for somebody else'; end if;

  update public.shifts set starts_at = starts_at + interval '1 hour' where id = s_taken;
  if found then raise exception 'an employee changed a shift assigned to somebody else'; end if;

  update public.shifts set employee_id = null where id = s_open;
  if found then raise exception 'an employee un-assigned themselves from a claimed shift'; end if;

  reset role;

  select updated_at into stamp from public.shifts where id = s_open;
  if stamp < now() - interval '1 minute' then
    raise exception 'the claim kept the updated_at the caller sent (%)', stamp;
  end if;
  if (select starts_at from public.shifts where id = s_open2) is distinct from old_start
     or (select employee_id from public.shifts where id = s_open2) is not null then
    raise exception 'a refused claim left a change behind';
  end if;
  if (select clock_in_at from public.time_entries where id = e_id) is distinct from old_in
     or (select status from public.time_entries where id = e_id) <> 'open' then
    raise exception 'a refused punch edit left a change behind';
  end if;

  -- ---- 4 and 7. as a manager (Timesheets, the schedule) --------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.time_entries (employee_id, clock_in_at, clock_out_at, status, manual)
  values (emp, now() - interval '30 hours', now() - interval '22 hours', 'closed', true)
  returning id into m_id;
  if m_id is null then raise exception 'a manager could not add a manual punch'; end if;

  update public.time_entries set clock_in_at = clock_in_at - interval '10 minutes', manual = true where id = e_id;
  if not found then raise exception 'a manager could not edit a punch'; end if;

  delete from public.time_entries where id = m_id;
  if not found then raise exception 'a manager could not delete a punch'; end if;

  update public.shifts set ends_at = ends_at + interval '1 hour', position = 'verify-30-mgr' where id = s_open;
  if not found then raise exception 'a manager could not change a claimed shift'; end if;

  update public.shifts set employee_id = mgr, deal_id = 999999 where id = s_open2;
  if not found then raise exception 'a manager could not assign and re-point an open shift'; end if;

  reset role;

  -- ---- 7. the service role on shifts (shift ack, catering shift writer) ----
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;

  update public.shifts set acknowledged_at = now(), starts_at = starts_at + interval '1 hour' where id = s_taken;
  if not found then raise exception 'the service role could not change a shift'; end if;

  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 8. shape --------------------------------------------------------------
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r, 'public.guard_shift_claim()', 'execute') then
      raise exception '% can execute guard_shift_claim(); it must be trigger-only', r;
    end if;
  end loop;

  select count(*) into n
    from pg_trigger
   where tgrelid = 'public.shifts'::regclass
     and not tgisinternal
     and tgfoid = 'public.guard_shift_claim()'::regprocedure;
  if n <> 1 then raise exception 'expected one claim guard on shifts, found %', n; end if;

  select count(*) into n
    from pg_policies
   where schemaname = 'public' and tablename = 'time_entries'
     and policyname in ('time_insert', 'time_update')
     and with_check ilike '%select is_manager()%'
     and with_check not ilike '%auth.uid()%';
  if n <> 2 then raise exception 'time_insert/time_update are not manager-only with the (select ...) wrapper'; end if;

  raise notice 'migration 30 verified';
end $$;

rollback;
