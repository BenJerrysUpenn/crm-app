-- ============================================================================
-- Withers Time, verification for migration 56 (the bookkeeping pass history)
--
-- Run by hand against a database with migration 56 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs an owner, a manager and an
-- employee in public.profiles. A clean run ends with "migration 56 verified".
--
-- WHAT IS CHECKED
--   1. The table's owner (the connection the passes write over) writes a
--      run; created_at and updated_at are the database's clock.
--   2. A re-run of the same pass on the same day updates its row, never adds
--      a second, keeps created_at and stamps updated_at, whatever the writer
--      sends; a second sitting with its own run_label is its own row.
--   3. pass_code has the DAILY-02 shape; counts are never negative; source
--      is 'pass' or 'backfill'.
--   4. A manager and an owner read runs; an employee does not; nobody signed
--      in writes; anon cannot read.
-- ============================================================================

begin;

do $$
declare
  own      uuid;
  mgr      uuid;
  emp      uuid;
  r1       bigint;
  r2       bigint;
  n        integer;
  t        timestamptz;
  u        timestamptz;
  c0       timestamptz;
  refused  boolean;
begin
  select id into own from public.profiles where role = 'owner' order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if own is null or mgr is null or emp is null then
    raise exception 'need an owner, a manager and an employee in profiles to run this file';
  end if;

  -- ---- 1. the passes write ------------------------------------------------------------
  insert into public.bookkeeping_pass_runs
    (run_date, pass_code, attended, posted_count, posted_dollars, queue_before, queue_after,
     issues_filed, note, written_by, created_at, updated_at)
  values (date '2018-06-14', 'DAILY-02', false, 3, 1803.96, 13, 10, '{901,902}', 'verify 56',
          'verify-56', timestamptz '2001-01-01', timestamptz '2001-01-01')
  returning id, created_at, updated_at into r1, t, u;
  if t < now() - interval '1 minute' then raise exception 'created_at was taken from the writer'; end if;
  if u < now() - interval '1 minute' then raise exception 'updated_at was taken from the writer'; end if;
  c0 := t;
  -- now() does not move inside one transaction, so backdate the row's stamps
  -- (trigger off) for the re-run below to show it keeps one and moves one.
  alter table public.bookkeeping_pass_runs disable trigger bookkeeping_pass_runs_touch;
  update public.bookkeeping_pass_runs
     set created_at = timestamptz '2001-01-01', updated_at = timestamptz '2001-01-01' where id = r1;
  alter table public.bookkeeping_pass_runs enable trigger bookkeeping_pass_runs_touch;
  c0 := timestamptz '2001-01-01';

  -- ---- 2. one row per run ---------------------------------------------------------------
  insert into public.bookkeeping_pass_runs
    (run_date, pass_code, attended, posted_count, posted_dollars, queue_before, queue_after, note, written_by)
  values (date '2018-06-14', 'DAILY-02', false, 4, 2000.00, 13, 9, 're-run', 'verify-56')
  on conflict (run_date, pass_code, run_label) do update
    set posted_count = excluded.posted_count, posted_dollars = excluded.posted_dollars,
        queue_after = excluded.queue_after, note = excluded.note,
        created_at = timestamptz '2002-02-02', updated_at = timestamptz '2002-02-02'
  returning id into r2;
  if r2 <> r1 then raise exception 'a re-run added a second row'; end if;
  select count(*) into n from public.bookkeeping_pass_runs where run_date = date '2018-06-14' and pass_code = 'DAILY-02';
  if n <> 1 then raise exception 'a re-run left % rows for one pass and day', n; end if;
  select created_at into t from public.bookkeeping_pass_runs where id = r1;
  if t <> c0 then raise exception 'a re-run moved created_at'; end if;
  select updated_at into u from public.bookkeeping_pass_runs where id = r1;
  if u < now() - interval '1 minute' then raise exception 'a re-run did not stamp updated_at'; end if;
  select count(*) into n from public.bookkeeping_pass_runs where id = r1 and posted_count = 4 and queue_after = 9;
  if n <> 1 then raise exception 'a re-run did not update its row'; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, written_by)
    values (date '2018-06-14', 'DAILY-02', true, 'verify-56');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'a second plain row for the same pass and day was accepted'; end if;
  insert into public.bookkeeping_pass_runs (run_date, pass_code, run_label, attended, written_by)
  values (date '2018-06-14', 'DAILY-02', 'evening', true, 'verify-56');
  insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, written_by)
  values (date '2018-06-14', 'WEEKLY-02', false, 'verify-56');

  -- ---- 3. shape -------------------------------------------------------------------------
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, written_by)
    values (date '2018-06-15', 'daily pass', false, 'verify-56');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a pass code not shaped like DAILY-02 was accepted'; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, queue_after, written_by)
    values (date '2018-06-15', 'DAILY-02', false, -1, 'verify-56');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a negative queue after was accepted'; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, queue_before, written_by)
    values (date '2018-06-15', 'DAILY-02', false, -1, 'verify-56');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a negative queue before was accepted'; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, posted_count, written_by)
    values (date '2018-06-15', 'DAILY-02', false, -1, 'verify-56');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a negative posted count was accepted'; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, source, written_by)
    values (date '2018-06-15', 'DAILY-02', false, 'chat', 'verify-56');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a source other than pass/backfill was accepted'; end if;

  -- ---- 4. who reads -----------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.bookkeeping_pass_runs where run_date = date '2018-06-14';
  if n <> 3 then raise exception 'a manager reads % of 3 runs', n; end if;
  begin
    insert into public.bookkeeping_pass_runs (run_date, pass_code, attended, written_by)
    values (date '2018-06-16', 'DAILY-02', false, 'x');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager wrote a run through the API'; end if;
  begin
    update public.bookkeeping_pass_runs set note = 'x' where id = r1;
    get diagnostics n = row_count;
    refused := n = 0;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager changed a run through the API'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', own, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.bookkeeping_pass_runs where run_date = date '2018-06-14';
  if n <> 3 then raise exception 'an owner reads % of 3 runs', n; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.bookkeeping_pass_runs;
  if n <> 0 then raise exception 'an employee can read pass runs'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if has_table_privilege('anon', 'public.bookkeeping_pass_runs', 'select') then
    raise exception 'anon can read pass runs';
  end if;

  raise notice 'migration 56 verified';
end $$;

rollback;
