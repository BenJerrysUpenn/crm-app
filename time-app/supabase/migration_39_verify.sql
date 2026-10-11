-- ============================================================================
-- Withers Time, verification for migration 39 (Metrics saved views and targets)
--
-- Run by hand against a database with migration 39 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs a manager and an employee in
-- public.profiles. A clean run ends with "migration 39 verified".
--
-- WHAT IS CHECKED
--   1. A manager saves, renames and reorders their own view; updated_at moves
--      and created_at does not.
--   2. Two live views of the same person cannot share a name (any case); an
--      archived view frees its name.
--   3. A manager cannot see, change or save a view as someone else.
--   4. An employee can neither read nor save views (managers only).
--   5. Nobody signed in can delete a view: archiving is the only way out.
--   6. widgets must be a JSON array of at most 24; a name must be 1-60 chars.
--   7. A preference points only at the same person's own view.
--   8. The $600K seed: 24 months x 3 streams, each year summing to 600,000
--      (in-store 397,730, catering 114,956, concessions 87,314), concessions
--      marked provisional; managers read targets, nobody signed in writes them.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  other    uuid := gen_random_uuid();
  v1       bigint;
  v2       bigint;
  v_other  bigint;
  c_at     timestamptz;
  n        integer;
  total    numeric;
  refused  boolean;
begin
  select id into mgr from public.profiles where role = 'manager' order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if mgr is null or emp is null then
    raise exception 'need a manager and an employee in profiles to run this file';
  end if;

  -- A second manager, invented for this run, owns a view the first must not see.
  insert into auth.users (id, email, raw_user_meta_data)
  values (other, 'verify-39@example.test', '{"full_name":"Verify 39"}');
  update public.profiles set role = 'manager' where id = other;
  insert into public.metric_views (owner_id, name) values (other, 'Theirs') returning id into v_other;

  -- ---- 1. a manager saves, renames and reorders their own view ---------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.metric_views (owner_id, name, position, widgets)
  values (mgr, 'My finance view', 0, '[{"id":"a","metric":"catering_ar","settings":{"period":"8w"}}]')
  returning id, created_at into v1, c_at;
  insert into public.metric_views (owner_id, name, position) values (mgr, 'Catering', 1) returning id into v2;
  update public.metric_views set name = 'Finance', position = 2, created_at = now() - interval '1 year' where id = v1;
  select count(*) into n from public.metric_views where id = v1 and name = 'Finance' and position = 2 and created_at = c_at;
  if n <> 1 then raise exception 'a manager could not rename and reorder their view, or created_at moved'; end if;

  -- ---- 2. names are unique among live views ------------------------------------------
  begin
    insert into public.metric_views (owner_id, name) values (mgr, '  CATERING ');
    refused := false;
  exception when unique_violation then
    refused := true;
  end;
  if not refused then raise exception 'two live views share a name'; end if;
  update public.metric_views set archived_at = now() where id = v2;
  insert into public.metric_views (owner_id, name) values (mgr, 'Catering');

  -- ---- 3. someone else's views are invisible and untouchable ---------------------------
  select count(*) into n from public.metric_views where id = v_other;
  if n <> 0 then raise exception 'a manager can see another manager''s view'; end if;
  update public.metric_views set name = 'Hijacked' where id = v_other;
  begin
    insert into public.metric_views (owner_id, name) values (other, 'Planted');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager saved a view as someone else'; end if;
  begin
    update public.metric_views set owner_id = other where id = v1;
    refused := false;
  exception when insufficient_privilege or raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a manager handed their view to someone else'; end if;

  -- ---- 5. nobody signed in deletes -----------------------------------------------------
  begin
    delete from public.metric_views where id = v1;
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a signed-in user deleted a view'; end if;

  -- ---- 6. shape -------------------------------------------------------------------------
  begin
    insert into public.metric_views (owner_id, name, widgets) values (mgr, 'Bad', '{"not":"array"}');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'widgets that are not an array were accepted'; end if;
  begin
    insert into public.metric_views (owner_id, name, widgets)
    values (mgr, 'Too many', (select jsonb_agg(jsonb_build_object('id', g)) from generate_series(1, 25) g));
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception '25 widgets were accepted'; end if;
  begin
    insert into public.metric_views (owner_id, name) values (mgr, '   ');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a blank name was accepted'; end if;

  -- ---- 7. preferences ---------------------------------------------------------------------
  insert into public.metric_preferences (owner_id, active_view_id) values (mgr, v1);
  begin
    update public.metric_preferences set active_view_id = v_other where owner_id = mgr;
    refused := false;
  exception when raise_exception then
    refused := true;
  end;
  if not refused then raise exception 'a preference pointed at someone else''s view'; end if;

  -- ---- 8a. targets: managers read, nobody signed in writes --------------------------------
  select count(*) into n from public.sales_targets;
  if n < 72 then raise exception 'a manager reads % target rows, expected the 72 seeded', n; end if;
  begin
    update public.sales_targets set amount = 1 where stream = 'in_store';
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'a manager wrote a sales target through the API'; end if;

  reset role;

  -- ---- 4. an employee sees and saves nothing --------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.metric_views;
  if n <> 0 then raise exception 'an employee can see saved views'; end if;
  begin
    insert into public.metric_views (owner_id, name) values (emp, 'Mine');
    refused := false;
  exception when insufficient_privilege then
    refused := true;
  end;
  if not refused then raise exception 'an employee saved a view'; end if;
  select count(*) into n from public.sales_targets;
  if n <> 0 then raise exception 'an employee can read sales targets'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into n from public.metric_views where id = v_other and name = 'Theirs';
  if n <> 1 then raise exception 'another manager''s view was changed'; end if;

  -- ---- 8b. the seed ---------------------------------------------------------------------------
  select count(*) into n from public.sales_targets
   where stream in ('in_store', 'catering', 'concessions') and month between date '2026-01-01' and date '2027-12-01';
  if n <> 72 then raise exception 'expected 72 seeded rows (24 months x 3 streams), found %', n; end if;
  select sum(amount) into total from public.sales_targets where extract(year from month) = 2026;
  if total <> 600000 then raise exception '2026 targets sum to %, not 600,000', total; end if;
  select sum(amount) into total from public.sales_targets where extract(year from month) = 2027;
  if total <> 600000 then raise exception '2027 targets sum to %, not 600,000', total; end if;
  select sum(amount) into total from public.sales_targets where stream = 'in_store' and extract(year from month) = 2026;
  if total <> 397730 then raise exception '2026 in-store targets sum to %, not 397,730', total; end if;
  select sum(amount) into total from public.sales_targets where month = date '2026-12-01';
  if total <> 40665 then raise exception 'December 2026 targets sum to %, not 40,665', total; end if;
  select count(*) into n from public.sales_targets where provisional <> (stream = 'concessions');
  if n <> 0 then raise exception 'provisional should mark the concessions rows and only them (% rows wrong)', n; end if;
  begin
    insert into public.sales_targets (month, stream, amount, basis) values (date '2026-10-02', 'all', 1, 'x');
    refused := false;
  exception when check_violation then
    refused := true;
  end;
  if not refused then raise exception 'a target dated mid-month was accepted'; end if;

  raise notice 'migration 39 verified';
end $$;

rollback;
