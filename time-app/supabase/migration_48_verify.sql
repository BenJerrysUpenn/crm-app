-- ============================================================================
-- Withers Time, verification for migration 48 (removed shifts in the
-- summary, the schedulers' availability email, weekly availability end dates)
--
-- Run by hand against a database with migration 48 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs two employees in
-- public.profiles. A clean run ends with "migration 48 verified". Every date
-- below is invented.
--
-- Counts are of the rows this file makes where it can be, so real queued
-- notices on a live database are back, untouched, after the ROLLBACK. (The
-- availability claim takes the whole queue, so on a live database it is
-- checked only on a day long past, and the queue is restored by ROLLBACK.)
--
-- WHAT IS CHECKED
--   1. A removed notice needs the former shift and its times, and no live
--      shift reference; a posted or changed notice still needs the shift.
--   2. The service role's claim returns a removed notice with its day and
--      times, and the queue id; deleting the shift afterwards would not have
--      dropped it.
--   3. An availability notice names a date or a weekday 0-6, exactly one.
--   4. The availability claim takes every queued notice once per day: a
--      second claim the same day returns nothing, what is queued after waits
--      for the next day's. Rows over 60 days older than the day are pruned.
--   5. No signed-in user reads or writes the new tables; only the service
--      role executes claim_availability_digest and claim_shift_digests.
--   6. availability.repeat_until is accepted on a weekly row and refused on
--      a dated one.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  other   uuid;
  v_day   date := date '2017-03-15';
  s1      bigint;
  n       integer;
  refused boolean;
  r       text;
  got     record;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into other from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if emp is null or other is null then
    raise exception 'need two employees in profiles to run this file';
  end if;

  insert into public.shifts (employee_id, starts_at, ends_at, position, published)
  values (other, (v_day + 3 + time '12:00') at time zone 'America/New_York',
                 (v_day + 3 + time '17:00') at time zone 'America/New_York', 'Test Opener', true)
  returning id into s1;

  -- ---- 1. what a removed notice must carry -----------------------------------------
  begin
    insert into public.shift_notices (shift_id, employee_id, notice) values (s1, emp, 'removed');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a removed notice without its former shift and times was accepted'; end if;
  begin
    insert into public.shift_notices (shift_id, employee_id, notice) values (null, emp, 'changed');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a changed notice without a shift was accepted'; end if;

  -- ---- 2. the claim returns a removed notice with its day ------------------------------
  insert into public.shift_notices (shift_id, employee_id, notice, former_shift_id, starts_at, ends_at, position)
  values (null, emp, 'removed', s1, (v_day + 3 + time '12:00') at time zone 'America/New_York',
          (v_day + 3 + time '17:00') at time zone 'America/New_York', 'Test Opener');
  delete from public.shifts where id = s1;
  select count(*) into n from public.shift_notices where former_shift_id = s1;
  if n <> 1 then raise exception 'deleting the shift dropped its removed notice'; end if;

  set local role service_role;
  select c.id, c.notice, c.shift_id, c.former_shift_id, c.starts_at, c."position" into got
    from public.claim_shift_digests(v_day) c where c.former_shift_id = s1;
  reset role;
  if got.notice is distinct from 'removed' or got.shift_id is not null or got.id is null
     or got.starts_at is distinct from (v_day + 3 + time '12:00') at time zone 'America/New_York'
     or got."position" is distinct from 'Test Opener' then
    raise exception 'the claim did not return the removed notice as written';
  end if;

  -- ---- 3. what an availability notice may say --------------------------------------
  begin
    insert into public.availability_notices (employee_id) values (emp);
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'an availability notice with neither a date nor a weekday was accepted'; end if;
  begin
    insert into public.availability_notices (employee_id, changed_date, changed_weekday) values (emp, v_day, 1);
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'an availability notice with both a date and a weekday was accepted'; end if;
  begin
    insert into public.availability_notices (employee_id, changed_weekday) values (emp, 7);
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'an availability notice for weekday 7 was accepted'; end if;

  -- ---- 4. the availability claim, once a day ----------------------------------------
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

  insert into public.availability_notices (employee_id, changed_weekday) values (emp, 4);
  select count(*) into n from public.claim_availability_digest(v_day);
  if n <> 0 then raise exception 'a second availability claim the same day returned % notices', n; end if;
  select count(*) into n from public.availability_notices where employee_id = emp and changed_weekday = 4;
  if n <> 1 then raise exception 'an availability notice queued after the day''s email did not wait'; end if;
  select count(*) into n from public.claim_availability_digest(v_day + 1) c where c.employee_id = emp and c.changed_weekday = 4;
  if n <> 1 then raise exception 'the next day''s availability claim did not return the waiting notice'; end if;

  insert into public.availability_digests (digest_day) values (v_day - 61), (v_day - 60);
  perform public.claim_availability_digest(v_day + 2);
  if exists (select 1 from public.availability_digests where digest_day = v_day - 61) then
    raise exception 'an availability email row more than 60 days old was not pruned';
  end if;

  -- ---- 5. who may touch it -----------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.availability_notices;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user can read availability_notices'; end if;
  begin
    insert into public.availability_notices (employee_id, changed_weekday) values (emp, 1);
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user can insert into availability_notices'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.claim_availability_digest(date)', 'execute')
       or has_function_privilege(r, 'public.claim_shift_digests(date)', 'execute') then
      raise exception '% can execute a summary claim function', r;
    end if;
    if has_table_privilege(r, 'public.availability_notices', 'select')
       or has_table_privilege(r, 'public.availability_notices', 'insert')
       or has_table_privilege(r, 'public.availability_digests', 'select')
       or has_table_privilege(r, 'public.availability_digests', 'insert') then
      raise exception '% holds privileges on the availability email tables', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.claim_availability_digest(date)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_shift_digests(date)', 'execute') then
    raise exception 'service_role cannot execute the summary claim functions';
  end if;

  -- ---- 6. repeat_until belongs to weekly rows -----------------------------------------
  insert into public.availability (employee_id, weekday, start_time, end_time, is_available, repeat_until)
  values (emp, 1, time '09:00', time '17:00', true, v_day + 90);
  begin
    insert into public.availability (employee_id, specific_date, is_available, repeat_until)
    values (emp, v_day, true, v_day + 90);
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a dated availability row with a repeat-until date was accepted'; end if;

  raise notice 'migration 48 verified';
end $$;

rollback;
