-- ============================================================================
-- Withers Time, verification for migration 41 (permanent sales history)
--
-- Run by hand against a database with migration 41 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs a manager and an employee in
-- public.profiles. A clean run ends with "migration 41 verified". Every
-- figure below is invented.
--
-- WHAT IS CHECKED
--   1. The service role writes a day and a month, and rewrites them as a day
--      settles; updated_at is the database's clock, whatever the writer sent.
--   2. A day's basis is 'booked' or 'in_transit', its source 'square' or
--      'seller', and a seller day is booked. A month starts on the 1st and its
--      source is 'qbo' or 'seller'; one month holds one row per source.
--   3. A manager reads both tables; an employee does not; nobody signed in
--      writes; anon reads nothing.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  n        integer;
  t        timestamptz;
  refused  boolean;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. the service role writes, and rewrites as a day settles -------------------
  set local role service_role;
  insert into public.sales_daily_in_store (day, in_store, pickup, basis, source, built_by, updated_at)
  values (date '2018-06-14', 100.00, 10.00, 'in_transit', 'square', 'verify-41', timestamptz '2001-01-01')
  returning updated_at into t;
  if t < now() - interval '1 minute' then raise exception 'a day''s updated_at was taken from the writer'; end if;
  insert into public.sales_daily_in_store (day, in_store, pickup, basis, source, built_by)
  values (date '2017-06-14', 90.00, null, 'booked', 'seller', 'verify-41');
  insert into public.sales_daily_in_store (day, in_store, pickup, basis, source, built_by)
  values (date '2018-06-14', 120.00, 10.00, 'booked', 'square', 'verify-41')
  on conflict (day) do update
    set in_store = excluded.in_store, pickup = excluded.pickup, basis = excluded.basis,
        built_by = excluded.built_by, updated_at = timestamptz '2001-01-01';
  select count(*) into n from public.sales_daily_in_store
   where day = date '2018-06-14' and in_store = 120.00 and basis = 'booked'
     and updated_at > now() - interval '1 minute';
  if n <> 1 then raise exception 'a settled day was not rewritten on the database clock'; end if;

  insert into public.sales_monthly (month, source, in_store, built_by, updated_at)
  values (date '2018-05-01', 'qbo', 3000.00, 'verify-41', timestamptz '2001-01-01')
  returning updated_at into t;
  if t < now() - interval '1 minute' then raise exception 'a month''s updated_at was taken from the writer'; end if;
  insert into public.sales_monthly (month, source, in_store, built_by)
  values (date '2018-05-01', 'seller', 2900.00, 'verify-41');
  update public.sales_monthly set in_store = 3100.00, updated_at = timestamptz '2001-01-01'
   where month = date '2018-05-01' and source = 'qbo';
  select count(*) into n from public.sales_monthly
   where month = date '2018-05-01' and source = 'qbo' and in_store = 3100.00
     and updated_at > now() - interval '1 minute';
  if n <> 1 then raise exception 'a rewritten month did not take the database clock'; end if;

  -- ---- 2. shape ----------------------------------------------------------------------
  begin
    insert into public.sales_daily_in_store (day, in_store, basis, source, built_by)
    values (date '2018-06-15', 1, 'estimated', 'square', 'verify-41');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day basis other than booked/in_transit was accepted'; end if;
  begin
    insert into public.sales_daily_in_store (day, in_store, basis, source, built_by)
    values (date '2018-06-15', 1, 'booked', 'qbo', 'verify-41');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day source other than square/seller was accepted'; end if;
  begin
    insert into public.sales_daily_in_store (day, in_store, basis, source, built_by)
    values (date '2017-06-15', 1, 'in_transit', 'seller', 'verify-41');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a seller day that is not booked was accepted'; end if;
  begin
    insert into public.sales_daily_in_store (day, in_store, basis, source, built_by)
    values (date '2018-06-14', 1, 'booked', 'square', 'verify-41');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second row for one day was accepted'; end if;
  begin
    insert into public.sales_daily_in_store (day, basis, source, built_by)
    values (date '2018-06-16', 'booked', 'square', 'verify-41');
    refused := false;
  exception when not_null_violation then
    refused := true;
  end;
  if not refused then raise exception 'a day without in_store was accepted'; end if;
  begin
    insert into public.sales_monthly (month, source, in_store, built_by)
    values (date '2018-05-15', 'qbo', 1, 'verify-41');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a month not on the 1st was accepted'; end if;
  begin
    insert into public.sales_monthly (month, source, in_store, built_by)
    values (date '2018-04-01', 'square', 1, 'verify-41');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a month source other than qbo/seller was accepted'; end if;
  begin
    insert into public.sales_monthly (month, source, in_store, built_by)
    values (date '2018-05-01', 'qbo', 1, 'verify-41');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second qbo row for one month was accepted'; end if;
  reset role;

  -- ---- 3. who reads ----------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.sales_daily_in_store where built_by = 'verify-41';
  if n <> 2 then raise exception 'a manager reads % of 2 days', n; end if;
  select count(*) into n from public.sales_monthly where built_by = 'verify-41';
  if n <> 2 then raise exception 'a manager reads % of 2 months', n; end if;
  begin
    insert into public.sales_daily_in_store (day, in_store, basis, source, built_by)
    values (date '2018-06-17', 1, 'booked', 'square', 'x');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager wrote a day through the API'; end if;
  begin
    update public.sales_monthly set in_store = 1 where month = date '2018-05-01';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed a month through the API'; end if;
  begin
    delete from public.sales_daily_in_store where day = date '2018-06-14';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager removed a day through the API'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.sales_daily_in_store;
  if n <> 0 then raise exception 'an employee can read daily sales'; end if;
  select count(*) into n from public.sales_monthly;
  if n <> 0 then raise exception 'an employee can read monthly sales'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if has_table_privilege('anon', 'public.sales_daily_in_store', 'select') then
    raise exception 'anon can read daily sales';
  end if;
  if has_table_privilege('anon', 'public.sales_monthly', 'select') then
    raise exception 'anon can read monthly sales';
  end if;

  raise notice 'migration 41 verified';
end $$;

rollback;
