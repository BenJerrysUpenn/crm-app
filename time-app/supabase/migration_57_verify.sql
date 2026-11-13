-- ============================================================================
-- Withers Time, verification for migration 57 (metrics_snapshots kind 'sales_lanes')
--
-- Run by hand against a database with migration 57 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs a manager and an employee in
-- public.profiles. A clean run ends with "migration 57 verified".
--
-- WHAT IS CHECKED
--   1. The service role publishes a 'sales_lanes' snapshot; 'daily' and
--      'closed_month' still go in; a kind outside the three is refused.
--   2. A 'sales_lanes' payload without "schema" is refused.
--   3. A published 'sales_lanes' snapshot can be neither changed nor removed.
--   4. A manager reads it; an employee does not; a manager cannot publish one.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  s_lanes  bigint;
  n        integer;
  refused  boolean;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. the kinds ------------------------------------------------------------------
  set local role service_role;
  insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
  values ('sales_lanes', date '2018-06-14', 'verify-57', 'f1',
          '{"schema":1,"as_of":"2018-06-15T10:00:00Z","period":"2018-06-14","since":"2018-01-01","lanes":[]}')
  returning id into s_lanes;
  insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
  values ('daily', date '2018-06-14', 'verify-57', 'f2', '{"schema":1}');
  insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
  values ('closed_month', date '2018-05-01', 'verify-57', 'f3', '{"schema":1}');
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('sales_lane', date '2018-06-14', 'verify-57', 'f4', '{"schema":1}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a snapshot kind outside daily/closed_month/sales_lanes was accepted'; end if;

  -- ---- 2. the payload still carries "schema" -----------------------------------------
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('sales_lanes', date '2018-06-14', 'verify-57', 'f5', '{"lanes":[]}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a sales_lanes payload without "schema" was accepted'; end if;

  -- ---- 3. kept as published ------------------------------------------------------------
  begin
    update public.metrics_snapshots set payload = '{"schema":1}' where id = s_lanes;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a published sales_lanes snapshot was changed'; end if;
  begin
    delete from public.metrics_snapshots where id = s_lanes;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a published sales_lanes snapshot was removed'; end if;
  reset role;

  -- ---- 4. who reads -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.metrics_snapshots where id = s_lanes;
  if n <> 1 then raise exception 'a manager reads % of 1 sales_lanes snapshot', n; end if;
  begin
    insert into public.metrics_snapshots (kind, period, built_by, source_fingerprint, payload)
    values ('sales_lanes', date '2018-06-15', 'x', 'x', '{"schema":1}');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager published a sales_lanes snapshot through the API'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.metrics_snapshots where kind = 'sales_lanes';
  if n <> 0 then raise exception 'an employee can read sales_lanes snapshots'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  raise notice 'migration 57 verified';
end $$;

rollback;
