-- ============================================================================
-- Withers Time, verification for migration 40 (the Metrics finance feed)
--
-- Run by hand against a database with migration 40 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs a manager and an employee in
-- public.profiles. A clean run ends with "migration 40 verified".
--
-- WHAT IS CHECKED
--   1. The service role publishes a daily and a closed-month snapshot;
--      built_at is the database's clock, whatever the publisher sent.
--   2. A published snapshot can be neither changed nor removed, by anyone.
--   3. kind is 'daily' or 'closed_month'; a closed month starts on the 1st;
--      the payload is an object carrying "schema".
--   4. A manager reads snapshots; an employee does not; nobody signed in
--      publishes.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  s_daily  bigint;
  s_month  bigint;
  n        integer;
  t        timestamptz;
  refused  boolean;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. the service role publishes ----------------------------------------------
  set local role service_role;
  insert into public.metrics_snapshots (kind, period, built_at, built_by, source_fingerprint, payload)
  values ('daily', date '2018-06-14', timestamptz '2001-01-01', 'verify-40', 'f1',
          '{"schema":1,"kind":"daily","as_of":"2018-06-14"}')
  returning id, built_at into s_daily, t;
  if t < now() - interval '1 minute' then raise exception 'built_at was taken from the publisher'; end if;
  insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
  values ('closed_month', date '2018-05-01', 'verify-40', 'f2', '{"schema":1,"kind":"closed_month","month":"2018-05"}')
  returning id into s_month;

  -- ---- 2. kept as published ----------------------------------------------------------
  begin
    update public.metrics_snapshots set payload = '{"schema":1}' where id = s_daily;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a published snapshot was changed'; end if;
  begin
    delete from public.metrics_snapshots where id = s_month;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a published snapshot was removed'; end if;
  reset role;
  -- The table's owner, the connection the Mac publishes over, is refused too.
  begin
    update public.metrics_snapshots set payload = '{"schema":1}' where id = s_daily;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'the table owner changed a published snapshot'; end if;
  begin
    delete from public.metrics_snapshots where id = s_month;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'the table owner removed a published snapshot'; end if;
  set local role service_role;

  -- ---- 3. shape ----------------------------------------------------------------------
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('weekly', date '2018-06-14', 'verify-40', 'f3', '{"schema":1}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a snapshot kind other than daily/closed_month was accepted'; end if;
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('closed_month', date '2018-05-15', 'verify-40', 'f4', '{"schema":1}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a closed month not on the 1st was accepted'; end if;
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('daily', date '2018-06-14', 'verify-40', 'f5', '{"as_of":"2018-06-14"}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a payload without "schema" was accepted'; end if;
  reset role;

  -- ---- 4. who reads ----------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.metrics_snapshots where id in (s_daily, s_month);
  if n <> 2 then raise exception 'a manager reads % of 2 snapshots', n; end if;
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('daily', date '2018-06-15', 'x', 'x', '{"schema":1}');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager published a snapshot through the API'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.metrics_snapshots;
  if n <> 0 then raise exception 'an employee can read metrics snapshots'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if has_table_privilege('anon', 'public.metrics_snapshots', 'select') then
    raise exception 'anon can read metrics snapshots';
  end if;

  raise notice 'migration 40 verified';
end $$;

rollback;
