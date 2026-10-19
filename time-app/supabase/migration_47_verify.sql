-- ============================================================================
-- Withers Time, verification for migration 47 (Labor Hours Planning inputs)
--
-- Run by hand against a database with migration 47 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs an owner, a manager and an
-- employee in public.profiles. A clean run ends with "migration 47
-- verified". Every name, date and figure below is invented.
--
-- WHAT IS CHECKED
--   1. store_hours_seasons: an owner sets a season's weekday, changes it on
--      its key and removes a season, stamped with the owner and the
--      database clock; an open day needs both times in order, a weekday is
--      0-6; a manager who is not an owner and an employee read it and
--      cannot add, change or remove it; anon reads nothing.
--   2. concession_events and crew_events: an owner adds a revision, stamped
--      with the owner and the database clock; a manager who is not an owner
--      reads and cannot add; an employee reads nothing; nobody signed in
--      changes, removes or empties them; dates in order, no negative sales
--      or hours, a key of lower-case words.
--   3. catering_hours_history: the service role writes and rewrites a day,
--      updated_at the database's clock; the source is 'when_i_work'; no
--      negative hours; a manager reads, an employee does not; nobody signed
--      in writes it; anon reads nothing.
--   4. The trigger functions are not callable through the API.
-- ============================================================================

begin;

do $$
declare
  own     uuid;
  mgr     uuid;
  emp     uuid;
  n       integer;
  t       timestamptz;
  who     uuid;
  refused boolean;
begin
  select id into own from public.profiles where role = 'owner' order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if own is null or mgr is null or emp is null then
    raise exception 'need an owner, a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. store_hours_seasons --------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.store_hours_seasons (effective_from, weekday, name, opens, closes, source, recorded_by, updated_at)
  values (date '2019-11-01', 2, 'Test winter', time '13:00', time '21:00', 'verify-47', emp, timestamptz '2001-01-01')
  returning recorded_by, updated_at into who, t;
  if who is distinct from own then raise exception 'a season was not stamped with the owner who set it'; end if;
  if t < now() - interval '1 minute' then raise exception 'a season''s updated_at was taken from the writer'; end if;
  insert into public.store_hours_seasons (effective_from, weekday, name, opens, closes, source)
  values (date '2019-11-01', 2, 'Test winter', time '15:00', time '21:00', 'verify-47')
  on conflict (effective_from, weekday) do update set opens = excluded.opens;
  select count(*) into n from public.store_hours_seasons where effective_from = date '2019-11-01' and opens = time '15:00';
  if n <> 1 then raise exception 'a season was not changed on its key'; end if;
  insert into public.store_hours_seasons (effective_from, weekday, name, is_closed, source)
  values (date '2019-11-01', 3, 'Test winter', true, 'verify-47');
  begin
    insert into public.store_hours_seasons (effective_from, weekday, name, opens, closes)
    values (date '2019-11-01', 4, 'Test winter', time '21:00', time '13:00');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a season closing before it opens was accepted'; end if;
  begin
    insert into public.store_hours_seasons (effective_from, weekday, name, opens)
    values (date '2019-11-01', 4, 'Test winter', time '13:00');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an open season day without a closing time was accepted'; end if;
  begin
    insert into public.store_hours_seasons (effective_from, weekday, name, is_closed)
    values (date '2019-11-01', 7, 'Test winter', true);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'weekday 7 was accepted'; end if;
  insert into public.store_hours_seasons (effective_from, weekday, name, is_closed, source)
  values (date '2019-12-01', 0, 'Test spare', true, 'verify-47');
  delete from public.store_hours_seasons where effective_from = date '2019-12-01';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'an owner removed % of 1 season days', n; end if;
  reset role;

  -- A manager who is not an owner reads the seasons; a change or removal
  -- touches nothing (row level security hides the rows from the write).
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.store_hours_seasons where effective_from = date '2019-11-01';
  if n <> 2 then raise exception 'a manager reads % of 2 season days', n; end if;
  update public.store_hours_seasons set opens = time '09:00' where effective_from = date '2019-11-01';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a manager who is not an owner changed % season days', n; end if;
  delete from public.store_hours_seasons where effective_from = date '2019-11-01';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a manager who is not an owner removed % season days', n; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.store_hours_seasons where effective_from = date '2019-11-01';
  if n <> 2 then raise exception 'an employee reads % of 2 season days', n; end if;
  reset role;
end $$;

rollback;

-- 1, continued: a manager's or an employee's new season is refused by row
-- level security.
begin;
do $$
declare
  mgr     uuid;
  emp     uuid;
  refused boolean;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.store_hours_seasons (effective_from, weekday, name, is_closed)
    values (date '2019-12-01', 1, 'Manager season', true);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner set a season'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.store_hours_seasons (effective_from, weekday, name, is_closed)
    values (date '2019-12-01', 1, 'Employee season', true);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'an employee set a season'; end if;
  reset role;
  if has_table_privilege('anon', 'public.store_hours_seasons', 'select') then
    raise exception 'anon can read seasons';
  end if;
end $$;
rollback;

begin;

do $$
declare
  own     uuid;
  mgr     uuid;
  emp     uuid;
  n       integer;
  t       timestamptz;
  who     uuid;
  refused boolean;
  tbl     text;
begin
  select id into own from public.profiles where role = 'owner' order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;

  -- ---- 2. concession_events and crew_events -------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, provisional,
                                        effective_from, review_by, source, recorded_by, recorded_at)
  values ('test-expo-2019', 'Test Expo', date '2019-01-10', date '2019-01-12', 300.00, true,
          date '2018-10-01', date '2018-12-01', 'verify-47', mgr, timestamptz '2001-01-01')
  returning recorded_by, recorded_at into who, t;
  if who is distinct from own then raise exception 'an event was not stamped with the owner who added it'; end if;
  if t < now() - interval '1 minute' then raise exception 'an event''s recorded_at was taken from the writer'; end if;
  -- A correction is a second revision of the same event.
  insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales,
                                        effective_from, review_by, source)
  values ('test-expo-2019', 'Test Expo', date '2019-01-11', date '2019-01-13', 320.00,
          date '2018-11-01', date '2018-12-01', 'verify-47');
  insert into public.crew_events (event_key, name, day, crew_hours, effective_from, review_by, source, recorded_by)
  values ('test-cone-day-2019', 'Test Cone Day', date '2019-04-09', 10, date '2018-10-01', date '2019-01-01', 'verify-47', mgr)
  returning recorded_by into who;
  if who is distinct from own then raise exception 'a crew event was not stamped with the owner who added it'; end if;

  begin
    insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, effective_from, review_by, source)
    values ('test-backwards', 'Backwards', date '2019-01-12', date '2019-01-10', 1, date '2018-10-01', date '2018-12-01', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an event ending before it starts was accepted'; end if;
  begin
    insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, effective_from, review_by, source)
    values ('test-negative', 'Negative', date '2019-01-10', date '2019-01-10', -1, date '2018-10-01', date '2018-12-01', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'negative expected sales were accepted'; end if;
  begin
    insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, effective_from, review_by, source)
    values ('Test Key', 'Bad key', date '2019-01-10', date '2019-01-10', 1, date '2018-10-01', date '2018-12-01', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an event key with capitals and spaces was accepted'; end if;
  begin
    insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, effective_from, review_by, source)
    values ('test-nosource', 'No source', date '2019-01-10', date '2019-01-10', 1, date '2018-10-01', date '2018-12-01', '  ');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an event without a source was accepted'; end if;
  begin
    insert into public.crew_events (event_key, name, day, crew_hours, effective_from, review_by, source)
    values ('test-negative', 'Negative', date '2019-04-09', -1, date '2018-10-01', date '2019-01-01', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'negative crew hours were accepted'; end if;
  begin
    insert into public.crew_events (event_key, name, day, crew_hours, effective_from, review_by, source)
    values ('test-review', 'Review first', date '2019-04-09', 1, date '2019-01-01', date '2018-10-01', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a review-by date before the as-of date was accepted'; end if;

  foreach tbl in array array['concession_events', 'crew_events'] loop
    begin
      execute format('update public.%I set name = %L where source = %L', tbl, 'x', 'verify-47');
      refused := false;
    exception when insufficient_privilege then refused := true;
    end;
    if not refused then raise exception 'an owner changed a row of % through the API', tbl; end if;
    begin
      execute format('delete from public.%I where source = %L', tbl, 'verify-47');
      refused := false;
    exception when insufficient_privilege then refused := true;
    end;
    if not refused then raise exception 'an owner removed a row of % through the API', tbl; end if;
    begin
      execute format('truncate public.%I', tbl);
      refused := false;
    exception when insufficient_privilege then refused := true;
    end;
    if not refused then raise exception 'an owner emptied %', tbl; end if;
  end loop;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.concession_events where source = 'verify-47';
  if n <> 2 then raise exception 'a manager reads % of 2 event revisions', n; end if;
  select count(*) into n from public.crew_events where source = 'verify-47';
  if n <> 1 then raise exception 'a manager reads % of 1 crew event', n; end if;
  begin
    insert into public.concession_events (event_key, name, start_date, end_date, expected_net_sales, effective_from, review_by, source)
    values ('test-manager', 'Manager', date '2019-01-10', date '2019-01-10', 1, date '2018-10-01', date '2018-12-01', 'verify-47');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner added an event'; end if;
  begin
    insert into public.crew_events (event_key, name, day, crew_hours, effective_from, review_by, source)
    values ('test-manager', 'Manager', date '2019-04-09', 1, date '2018-10-01', date '2019-01-01', 'verify-47');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner added a crew event'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.concession_events;
  if n <> 0 then raise exception 'an employee can read concession events'; end if;
  select count(*) into n from public.crew_events;
  if n <> 0 then raise exception 'an employee can read crew events'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.concession_events', 'select')
     or has_table_privilege('anon', 'public.crew_events', 'select') then
    raise exception 'anon can read events';
  end if;

  -- ---- 3. catering_hours_history ------------------------------------------------------
  set local role service_role;
  insert into public.catering_hours_history (day, hours, shifts, source, built_by, updated_at)
  values (date '2019-05-01', 7.50, 2, 'when_i_work', 'verify-47', timestamptz '2001-01-01')
  returning updated_at into t;
  if t < now() - interval '1 minute' then raise exception 'a history day''s updated_at was taken from the writer'; end if;
  insert into public.catering_hours_history (day, hours, shifts, excluded_hours, excluded_reason, source, built_by)
  values (date '2019-05-01', 0, 0, 7.50, 'invented show day', 'when_i_work', 'verify-47')
  on conflict (day) do update set hours = excluded.hours, shifts = excluded.shifts,
    excluded_hours = excluded.excluded_hours, excluded_reason = excluded.excluded_reason,
    updated_at = timestamptz '2001-01-01';
  select count(*) into n from public.catering_hours_history
   where day = date '2019-05-01' and hours = 0 and excluded_hours = 7.50 and updated_at > now() - interval '1 minute';
  if n <> 1 then raise exception 'a history day was not rewritten on its key with the database clock'; end if;
  begin
    insert into public.catering_hours_history (day, hours, shifts, source, built_by)
    values (date '2019-05-02', 1, 1, 'schedule', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a history source other than when_i_work was accepted'; end if;
  begin
    insert into public.catering_hours_history (day, hours, shifts, source, built_by)
    values (date '2019-05-02', -1, 1, 'when_i_work', 'verify-47');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'negative history hours were accepted'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.catering_hours_history where built_by = 'verify-47';
  if n <> 1 then raise exception 'a manager reads % of 1 history day', n; end if;
  begin
    insert into public.catering_hours_history (day, hours, shifts, source, built_by)
    values (date '2019-05-03', 1, 1, 'when_i_work', 'x');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager wrote a history day through the API'; end if;
  begin
    update public.catering_hours_history set hours = 1 where built_by = 'verify-47';
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager changed a history day through the API'; end if;
  begin
    truncate public.catering_hours_history;
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a manager emptied the history'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.catering_hours_history;
  if n <> 0 then raise exception 'an employee can read the catering history'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_table_privilege('anon', 'public.catering_hours_history', 'select') then
    raise exception 'anon can read the catering history';
  end if;

  -- ---- 4. trigger functions are trigger-only ---------------------------------------------
  if has_function_privilege('authenticated', 'public.stamp_store_hours_season()', 'execute')
     or has_function_privilege('anon', 'public.stamp_store_hours_season()', 'execute')
     or has_function_privilege('authenticated', 'public.touch_catering_hours_history()', 'execute')
     or has_function_privilege('service_role', 'public.touch_catering_hours_history()', 'execute') then
    raise exception 'a trigger function is callable through the API';
  end if;

  raise notice 'migration 47 verified';
end $$;

rollback;
