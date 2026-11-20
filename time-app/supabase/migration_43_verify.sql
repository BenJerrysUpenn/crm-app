-- ============================================================================
-- Withers Time, verification for migration 43 (the control board's dated
-- settings and salaries)
--
-- Run by hand against a database with migration 43 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs an owner, a manager and an
-- employee in public.profiles. A clean run ends with "migration 43 verified".
-- Every figure below is invented.
--
-- WHAT IS CHECKED
--   1. An owner adds a setting and a salary through the API. The row is
--      stamped with the owner and the database clock, whatever was sent.
--   2. A manager who is not an owner reads both tables and cannot add to
--      either. An employee reads nothing; anon cannot read at all.
--   3. Nobody signed in, an owner included, changes, removes or empties a
--      row: history is never rewritten through the API.
--   4. Shape: a key is dotted lower-case words; a value is a real number;
--      detail is a JSON object; a source is required; a salary is not negative.
--   5. The value in force on a day: the latest effective_from on or before it;
--      a same-day correction wins over the row it corrects; a future row is
--      not in force yet; one row per key or person. The same for salaries.
-- ============================================================================

begin;

do $$
declare
  own      uuid;
  mgr      uuid;
  emp      uuid;
  n        integer;
  v        numeric;
  who      uuid;
  t        timestamptz;
  refused  boolean;
begin
  select id into own from public.profiles where role = 'owner' order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if own is null or mgr is null or emp is null then
    raise exception 'need an owner, a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. an owner adds, and the database stamps who and when ---------------------
  perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.control_settings (key, value, detail, effective_from, review_by, source, method, recorded_by, recorded_at)
  values ('verify43.share', 0.5, '{}', date '2018-01-01', date '2019-01-01', 'verify-43', 'invented', mgr, timestamptz '2001-01-01')
  returning recorded_by, recorded_at into who, t;
  if who is distinct from own then raise exception 'a setting was not stamped with the owner who added it'; end if;
  if t < now() - interval '1 minute' then raise exception 'a setting''s recorded_at was taken from the request'; end if;
  insert into public.profile_salaries (profile_id, annual_salary, effective_from, review_by, source, recorded_by)
  values (emp, 1000.00, date '2018-01-01', date '2019-01-01', 'verify-43', mgr)
  returning recorded_by into who;
  if who is distinct from own then raise exception 'a salary was not stamped with the owner who added it'; end if;

  -- ---- 3. not even an owner rewrites history ----------------------------------------
  begin
    update public.control_settings set value = 0.1 where source = 'verify-43';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner changed a setting row through the API'; end if;
  begin
    delete from public.control_settings where source = 'verify-43';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner removed a setting row through the API'; end if;
  begin
    update public.profile_salaries set annual_salary = 1 where source = 'verify-43';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner changed a salary row through the API'; end if;
  begin
    delete from public.profile_salaries where source = 'verify-43';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner removed a salary row through the API'; end if;
  -- TRUNCATE skips row level security, so only the missing grant stops it.
  begin
    truncate public.control_settings;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner emptied the settings'; end if;
  begin
    truncate public.profile_salaries;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an owner emptied the salaries'; end if;
  reset role;

  -- ---- 2. a manager reads and cannot add; an employee reads nothing -----------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.control_settings where source = 'verify-43';
  if n <> 1 then raise exception 'a manager reads % of 1 setting', n; end if;
  select count(*) into n from public.profile_salaries where source = 'verify-43';
  if n <> 1 then raise exception 'a manager reads % of 1 salary', n; end if;
  begin
    insert into public.control_settings (key, value, effective_from, review_by, source)
    values ('verify43.share', 0.9, date '2018-02-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner added a setting'; end if;
  begin
    insert into public.profile_salaries (profile_id, annual_salary, effective_from, review_by, source)
    values (emp, 2000.00, date '2018-02-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner added a salary'; end if;
  begin
    update public.control_settings set value = 0.1 where source = 'verify-43';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed a setting row'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.control_settings;
  if n <> 0 then raise exception 'an employee can read the settings'; end if;
  select count(*) into n from public.profile_salaries;
  if n <> 0 then raise exception 'an employee can read salaries, their own included'; end if;
  select count(*) into n from public.control_settings_on(date '2018-06-01');
  if n <> 0 then raise exception 'an employee reads settings through control_settings_on'; end if;
  begin
    insert into public.control_settings (key, value, effective_from, review_by, source)
    values ('verify43.share', 0.9, date '2018-02-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee added a setting'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if has_table_privilege('anon', 'public.control_settings', 'select') then
    raise exception 'anon can read the settings';
  end if;
  if has_table_privilege('anon', 'public.profile_salaries', 'select') then
    raise exception 'anon can read salaries';
  end if;
  if has_function_privilege('anon', 'public.control_settings_on(date)', 'execute') then
    raise exception 'anon can call control_settings_on';
  end if;

  -- ---- 4. shape ------------------------------------------------------------------------
  set local role service_role;
  begin
    insert into public.control_settings (key, value, effective_from, review_by, source)
    values ('Payroll Pct', 1, date '2018-01-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a key that is not dotted lower-case words was accepted'; end if;
  begin
    insert into public.control_settings (key, value, effective_from, review_by, source)
    values ('verify43.share', 'NaN', date '2018-01-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'NaN was accepted as a value'; end if;
  begin
    insert into public.control_settings (key, value, detail, effective_from, review_by, source)
    values ('verify43.share', 1, '[1]', date '2018-01-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a detail that is not a JSON object was accepted'; end if;
  begin
    insert into public.control_settings (key, value, effective_from, review_by, source)
    values ('verify43.share', 1, date '2018-01-01', date '2019-01-01', '   ');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a setting with a blank source was accepted'; end if;
  begin
    insert into public.control_settings (key, value, effective_from, source)
    values ('verify43.share', 1, date '2018-01-01', 'verify-43');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a setting without a review-by date was accepted'; end if;
  begin
    insert into public.control_settings (key, value, review_by, source)
    values ('verify43.share', 1, date '2019-01-01', 'verify-43');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a setting without an as-of date was accepted'; end if;
  begin
    insert into public.profile_salaries (profile_id, annual_salary, effective_from, review_by, source)
    values (emp, -1, date '2018-01-01', date '2019-01-01', 'verify-43');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a negative salary was accepted'; end if;
  begin
    insert into public.profile_salaries (profile_id, annual_salary, effective_from, review_by, source)
    values (emp, 1, date '2018-01-01', date '2019-01-01', '');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a salary with a blank source was accepted'; end if;

  -- ---- 5. the value in force -----------------------------------------------------------
  -- verify43.share: 0.5 from 2018-01-01 (above), 0.6 from 2018-03-01, corrected
  -- the same day to 0.65, and 0.7 from 2018-09-01.
  insert into public.control_settings (key, value, effective_from, review_by, source)
  values ('verify43.share', 0.6, date '2018-03-01', date '2019-01-01', 'verify-43'),
         ('verify43.share', 0.7, date '2018-09-01', date '2019-01-01', 'verify-43');
  insert into public.control_settings (key, value, effective_from, review_by, source)
  values ('verify43.share', 0.65, date '2018-03-01', date '2019-01-01', 'verify-43 correction');
  insert into public.control_settings (key, value, effective_from, review_by, source)
  values ('verify43.other', 3, date '2018-05-01', date '2019-01-01', 'verify-43');
  reset role;

  select value into v from public.control_settings_on(date '2018-02-15') where key = 'verify43.share';
  if v is distinct from 0.5 then raise exception 'in force on 2018-02-15: % (expected 0.5)', v; end if;
  select value into v from public.control_settings_on(date '2018-03-01') where key = 'verify43.share';
  if v is distinct from 0.65 then raise exception 'a same-day correction did not win: % (expected 0.65)', v; end if;
  select value into v from public.control_settings_on(date '2018-08-31') where key = 'verify43.share';
  if v is distinct from 0.65 then raise exception 'in force on 2018-08-31: % (expected 0.65)', v; end if;
  select value into v from public.control_settings_on(date '2018-09-01') where key = 'verify43.share';
  if v is distinct from 0.7 then raise exception 'in force on 2018-09-01: % (expected 0.7)', v; end if;
  select count(*) into n from public.control_settings_on(date '2017-12-31') where key like 'verify43.%';
  if n <> 0 then raise exception 'a setting was in force before its as-of date'; end if;
  select count(*) into n from public.control_settings_on(date '2018-06-01') where key like 'verify43.%';
  if n <> 2 then raise exception 'control_settings_on gave % rows for 2 keys', n; end if;

  set local role service_role;
  insert into public.profile_salaries (profile_id, annual_salary, effective_from, review_by, source)
  values (emp, 1500.00, date '2018-07-01', date '2019-01-01', 'verify-43'),
         (mgr, 3000.00, date '2018-01-01', date '2019-01-01', 'verify-43');
  reset role;
  select annual_salary into v from public.profile_salaries_on(date '2018-06-30') where profile_id = emp;
  if v is distinct from 1000.00 then raise exception 'salary in force on 2018-06-30: % (expected 1000)', v; end if;
  select annual_salary into v from public.profile_salaries_on(date '2018-07-01') where profile_id = emp;
  if v is distinct from 1500.00 then raise exception 'salary in force on 2018-07-01: % (expected 1500)', v; end if;
  select count(*) into n from public.profile_salaries_on(date '2018-07-01') where source = 'verify-43';
  if n <> 2 then raise exception 'profile_salaries_on gave % rows for 2 people', n; end if;

  -- The manager reads the same answer through the function.
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select value into v from public.control_settings_on(date '2018-03-01') where key = 'verify43.share';
  if v is distinct from 0.65 then raise exception 'a manager reads % in force (expected 0.65)', v; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  raise notice 'migration 43 verified';
end $$;

rollback;
