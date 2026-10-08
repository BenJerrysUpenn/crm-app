-- ============================================================================
-- Withers Time, verification for migration 37 (Travel Reimbursements)
--
-- Run by hand against a database with migration 37 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one active manager and two
-- employees in public.profiles; it makes its own owners and a second manager. A clean run ends with
-- "migration 37 verified".
--
-- WHAT IS CHECKED
--   1. The IRS Mileage rates are there; anyone signed in reads them; nobody
--      signed in writes them.
--   2. Staff submit their own, Submitted, with a valid Reason; not for someone
--      else, not already Approved, not errands without a note.
--   3. Staff read their own; an Approver reads all.
--   4. Staff edit and resubmit their own while Submitted or Rejected; never
--      decide one, not even their own; never touch an Approved one.
--   5. An Approver approves, rejects (with a reason) and sends back. A manager
--      who is not an owner cannot decide their own, and neither can another
--      such manager (decide, send back or adjust); an owner can (ruling 28).
--   6. Paid outside payroll: only an owner's, only by an owner.
--   7. Adjustments: by an Approver, on Submitted or Approved only; never on
--      a non-owner manager's own; staff read theirs, cannot write one.
--   8. travel_reimbursements_payable: Approved, unpaid, owners excluded, at the
--      trip date's rate half-up, an Adjustment's mileage replacing it.
--   9. mark_travel_reimbursements_paid: all or nothing, idempotent for the
--      same pay date; Paid is final (no update, no delete).
--  10. Lyft ride reports: staff file their own; read their own only.
--  11. Storage: staff upload to and read their own folder only; Approvers read
--      all and alone upload under adjustments/.
--  12. No API role reads the payroll views or calls the functions.
-- ============================================================================

begin;

do $$
declare
  mgr      uuid;
  emp      uuid;
  emp2     uuid;
  own      uuid := gen_random_uuid();
  own2     uuid := gen_random_uuid();
  mgr2     uuid := gen_random_uuid();
  v_id     bigint;
  v_id2    bigint;
  v_own    bigint;
  v_mgr    bigint;
  n        integer;
  refused  boolean;
  r        record;
begin
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  select id into emp2 from public.profiles where role = 'employee' and id <> emp order by created_at limit 1;
  if mgr is null or emp is null or emp2 is null then
    raise exception 'need one active manager and two employees in profiles to run this file';
  end if;
  insert into auth.users (id, email, raw_user_meta_data) values
    (own, 'owner-37@example.test', '{"full_name":"Owner One"}'),
    (own2, 'owner2-37@example.test', '{"full_name":"Owner Two"}'),
    (mgr2, 'manager2-37@example.test', '{"full_name":"Manager Two"}');
  update public.profiles set role = 'manager', active = false where id in (own, own2);
  update public.profiles set role = 'manager', active = true where id = mgr2;

  -- ---- 1. Mileage rates --------------------------------------------------------------
  if (select cents_per_mile from public.mileage_rates where starts_on = '2026-01-01') <> 72.50
     or (select cents_per_mile from public.mileage_rates where starts_on = '2026-07-01') <> 76.00 then
    raise exception 'the 2026 IRS rates are not 72.5c from Jan 1 and 76c from Jul 1';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.mileage_rates;
  if n < 3 then raise exception 'staff cannot read the Mileage rates'; end if;
  begin
    insert into public.mileage_rates values ('2027-01-01', 80, 'x');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'staff inserted a Mileage rate'; end if;

  -- ---- 2. submit ------------------------------------------------------------------------
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles, tolls_cents, parking_cents)
  values (emp, 'catering_event', 9001, 'Sat Oct 3, 2026, Acme', '2026-06-30', 'typed', 10.0, 450, 1200)
  returning id into v_id;
  insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles, stops, start_at_store, end_at_store)
  values (emp, 'errands', 'Restaurant Depot', '2026-07-01', 'destinations', 0.2, '["Restaurant Depot"]', false, true)
  returning id into v_id2;

  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
    values (emp2, 'errands', 'x', '2026-07-01', 'typed', 1);
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'staff submitted a reimbursement for someone else'; end if;

  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles, status)
    values (emp, 'errands', 'x', '2026-07-01', 'typed', 1, 'approved');
    refused := false;
  exception when insufficient_privilege or raise_exception then refused := true;
  end;
  if not refused then raise exception 'staff submitted an already Approved reimbursement'; end if;

  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, trip_date, mileage_mode, miles)
    values (emp, 'errands', '2026-07-01', 'typed', 1);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an errands reimbursement without a note was accepted'; end if;

  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
    values (emp, 'errands', 'x', '2026-07-01', 'typed', 0);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a reimbursement with nothing to pay was accepted'; end if;

  -- Destinations: two points at least. Neither end at the store needs two stops (ruling 45).
  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles, stops, start_at_store, end_at_store)
    values (emp, 'errands', 'x', '2026-07-01', 'destinations', 1, '["Restaurant Depot"]', false, false);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a one-point destinations trip was accepted'; end if;
  reset role;

  -- ---- 3. who reads -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp2::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.travel_reimbursements where id in (v_id, v_id2);
  reset role;
  if n <> 0 then raise exception 'staff read someone else''s reimbursements'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.travel_reimbursements where id in (v_id, v_id2);
  if n <> 2 then raise exception 'an Approver cannot read every reimbursement'; end if;
  -- A manager's own, for 5.
  insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
  values (mgr, 'errands', 'bank run', '2026-07-02', 'typed', 3) returning id into v_mgr;
  reset role;

  -- ---- 4. staff change their own ----------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.travel_reimbursements set miles = 11.0 where id = v_id;
  if (select miles from public.travel_reimbursements where id = v_id) <> 11.0 then
    raise exception 'staff could not edit their own Submitted reimbursement';
  end if;
  begin
    update public.travel_reimbursements set status = 'approved' where id = v_id;
    refused := false;
  exception when insufficient_privilege or raise_exception then refused := true;
  end;
  if not refused then raise exception 'staff approved their own reimbursement'; end if;
  begin
    update public.travel_reimbursements set mileage_cents_override = 1 where id = v_id;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'staff adjusted their own mileage amount'; end if;
  reset role;

  -- ---- 5. decide ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set status = 'rejected' where id = v_id2;
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a rejection without a reason was accepted'; end if;
  update public.travel_reimbursements set status = 'rejected', rejection_reason = 'Which store?' where id = v_id2;
  update public.travel_reimbursements set status = 'approved', decided_by = mgr where id = v_id;
  begin
    update public.travel_reimbursements set status = 'approved' where id = v_mgr;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner approved their own'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.travel_reimbursements set miles = 99 where id = v_id;  -- Approved: RLS hides it
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'staff edited an Approved reimbursement'; end if;
  delete from public.travel_reimbursements where id = v_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'staff deleted an Approved reimbursement'; end if;
  -- Rejected: edit and resubmit.
  update public.travel_reimbursements set status = 'submitted', reason_note = 'Restaurant Depot, cones' where id = v_id2;
  if (select status from public.travel_reimbursements where id = v_id2) <> 'submitted' then
    raise exception 'staff could not resubmit a Rejected reimbursement';
  end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set miles = 99 where id = v_id;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'an Approved reimbursement''s miles changed without sending it back'; end if;
  update public.travel_reimbursements set status = 'submitted' where id = v_id;   -- send back
  update public.travel_reimbursements set status = 'approved' where id = v_id;
  update public.travel_reimbursements set status = 'approved' where id = v_id2;
  reset role;

  -- Another manager who is not an owner cannot decide or adjust the manager's (ruling 28).
  perform set_config('request.jwt.claims', json_build_object('sub', mgr2::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set status = 'approved' where id = v_mgr;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager approved another manager''s reimbursement'; end if;
  begin
    update public.travel_reimbursements set status = 'rejected', rejection_reason = 'no' where id = v_mgr;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager rejected another manager''s reimbursement'; end if;
  begin
    insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
    values (v_mgr, 'mileage', 228, 200, 'x', 'adjustments/2/x.png', mgr2);
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager adjusted another manager''s reimbursement'; end if;
  reset role;

  -- An owner decides the manager's, and an owner's own.
  perform set_config('request.jwt.claims', json_build_object('sub', own::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.travel_reimbursements set status = 'approved' where id = v_mgr;
  if (select status from public.travel_reimbursements where id = v_mgr) <> 'approved' then
    raise exception 'an owner could not approve a manager''s reimbursement';
  end if;
  insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
  values (own, 'errands', 'supplies', '2026-07-03', 'typed', 5) returning id into v_own;
  update public.travel_reimbursements set status = 'approved' where id = v_own;
  if (select status from public.travel_reimbursements where id = v_own) <> 'approved' then
    raise exception 'an owner could not approve their own';
  end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr2::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set status = 'submitted' where id = v_mgr;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager sent back another manager''s Approved reimbursement'; end if;
  reset role;

  -- ---- 6. Paid outside payroll --------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set status = 'paid_outside_payroll', paid_on = '2026-07-10' where id = v_own;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner marked Paid outside payroll'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', own2::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update public.travel_reimbursements set status = 'paid_outside_payroll', paid_on = '2026-07-10' where id = v_mgr;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a staff reimbursement was marked Paid outside payroll'; end if;

  -- ---- 7. Adjustments --------------------------------------------------------------------------
  insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
  values (v_id, 'mileage', 760, 700, 'Agreed on Slack', 'adjustments/1/slack.png', own2);
  update public.travel_reimbursements set mileage_cents_override = 700 where id = v_id;
  begin
    insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
    values (v_id, 'tolls', 450, 400, '   ', 'adjustments/1/x.png', own2);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an Adjustment without a note was accepted'; end if;
  begin
    insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
    values (v_id, 'tolls', 450, 400, 'x', 'elsewhere/x.png', own2);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'Adjustment evidence outside adjustments/ was accepted'; end if;
  update public.travel_reimbursements set status = 'paid_outside_payroll', paid_on = '2026-07-10' where id = v_own;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
    values (v_mgr, 'mileage', 228, 200, 'x', 'adjustments/2/x.png', mgr);
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a manager who is not an owner adjusted their own'; end if;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.travel_reimbursement_adjustments where reimbursement_id = v_id;
  if n <> 1 then raise exception 'staff cannot read the Adjustment to their own reimbursement'; end if;
  begin
    insert into public.travel_reimbursement_adjustments (reimbursement_id, field, old_cents, new_cents, note, evidence_path, adjusted_by)
    values (v_id, 'tolls', 450, 9999, 'x', 'adjustments/1/x.png', emp);
    refused := false;
  exception when insufficient_privilege or raise_exception then refused := true;
  end;
  if not refused then raise exception 'staff made an Adjustment'; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 8. the payable view ---------------------------------------------------------------------
  -- v_id: trip 2026-06-30, 11.0 mi (72.5c = 797.5 -> 798, but adjusted to 700), tolls 450, parking 1200.
  select * into r from public.travel_reimbursements_payable where id = v_id;
  if r.mileage_cents <> 700 or r.total_cents <> 2350 or r.cents_per_mile <> 72.50 then
    raise exception 'payable v_id: mileage % total % rate %', r.mileage_cents, r.total_cents, r.cents_per_mile;
  end if;
  -- v_id2: trip 2026-07-01, 0.2 mi x 76c = 15.2 -> 15.
  select * into r from public.travel_reimbursements_payable where id = v_id2;
  if r.mileage_cents <> 15 or r.total_cents <> 15 or r.cents_per_mile <> 76.00 then
    raise exception 'payable v_id2: mileage % total % rate %', r.mileage_cents, r.total_cents, r.cents_per_mile;
  end if;
  -- Half a cent rounds up: 0.2 mi at 72.5c = 14.5c -> 15.
  update public.travel_reimbursements set status = 'submitted' where id = v_id2;
  update public.travel_reimbursements set trip_date = '2026-06-30' where id = v_id2;
  update public.travel_reimbursements set status = 'approved' where id = v_id2;
  if (select mileage_cents from public.travel_reimbursements_payable where id = v_id2) <> 15 then
    raise exception '0.2 mi at 72.5c did not round half-up to 15c';
  end if;
  if exists (select 1 from public.travel_reimbursements_payable where profile_id in (own, own2)) then
    raise exception 'an owner''s reimbursement is on the payable view';
  end if;
  if not exists (select 1 from public.travel_reimbursements_payable where id = v_mgr) then
    raise exception 'a manager on payroll is missing from the payable view';
  end if;
  if (select qbo_employee_id from public.travel_reimbursements_payable where id = v_id)
     is distinct from (select qbo_employee_id from public.profiles where id = emp) then
    raise exception 'the payable view does not carry qbo_employee_id';
  end if;

  -- ---- 9. mark Paid ------------------------------------------------------------------------------
  insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
  values (emp2, 'errands', 'still waiting', '2026-07-04', 'typed', 2) returning id into n;
  if not exists (select 1 from public.travel_reimbursements_waiting where id = n) then
    raise exception 'a Submitted reimbursement is not on the waiting view';
  end if;
  begin
    perform public.mark_travel_reimbursements_paid(array[v_id, n::bigint], '2026-07-15');
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a Submitted reimbursement was marked Paid'; end if;
  if (select status from public.travel_reimbursements where id = v_id) <> 'approved' then
    raise exception 'a refused mark-Paid still marked some';
  end if;
  begin
    perform public.mark_travel_reimbursements_paid(array[v_own], '2026-07-15');
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'an owner''s reimbursement was marked Paid through payroll'; end if;
  if public.mark_travel_reimbursements_paid(array[v_id, v_id2], '2026-07-15') <> 2 then
    raise exception 'mark-Paid did not mark two';
  end if;
  if public.mark_travel_reimbursements_paid(array[v_id, v_id2], '2026-07-15') <> 0 then
    raise exception 'a retry of mark-Paid was not harmless';
  end if;
  if (select paid_on from public.travel_reimbursements where id = v_id) <> '2026-07-15' then
    raise exception 'mark-Paid did not record the pay date';
  end if;
  if exists (select 1 from public.travel_reimbursements_payable where id in (v_id, v_id2)) then
    raise exception 'a Paid reimbursement is still payable';
  end if;
  begin
    update public.travel_reimbursements set tolls_cents = 0 where id = v_id;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a Paid reimbursement changed'; end if;
  begin
    delete from public.travel_reimbursements where id = v_id;
    refused := false;
  exception when raise_exception then refused := true;
  end;
  if not refused then raise exception 'a Paid reimbursement was deleted'; end if;

  -- ---- 10. Lyft ride reports ------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.lyft_ride_reports (profile_id, reason_kind, deal_id, event_label, trip_date, screenshot_paths)
  values (emp, 'catering_event', 9001, 'Sat Oct 3, 2026, Acme', '2026-10-03', array[emp::text || '/lyft/1.png']);
  begin
    insert into public.lyft_ride_reports (profile_id, reason_kind, reason_note, trip_date, screenshot_paths)
    values (emp, 'errands', 'x', '2026-10-03', '{}');
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'a Lyft ride report without a screenshot was filed'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', emp2::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.lyft_ride_reports;
  reset role;
  if n <> 0 then raise exception 'staff read someone else''s Lyft ride report'; end if;

  -- ---- 11. Storage ---------------------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name) values ('travel-reimbursements', emp::text || '/receipts/a.jpg');
  begin
    insert into storage.objects (bucket_id, name) values ('travel-reimbursements', emp2::text || '/receipts/b.jpg');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'staff uploaded into someone else''s folder'; end if;
  begin
    insert into storage.objects (bucket_id, name) values ('travel-reimbursements', 'adjustments/1/c.png');
    refused := false;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'staff uploaded Adjustment evidence'; end if;
  reset role;
  insert into storage.objects (bucket_id, name) values
    ('travel-reimbursements', emp2::text || '/receipts/b.jpg'),
    ('travel-reimbursements', 'adjustments/1/c.png');
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'travel-reimbursements';
  reset role;
  if n <> 1 then raise exception 'staff see % reimbursement files, not just their own one', n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from storage.objects where bucket_id = 'travel-reimbursements';
  insert into storage.objects (bucket_id, name) values ('travel-reimbursements', 'adjustments/2/d.png');
  reset role;
  if n <> 3 then raise exception 'an Approver sees % reimbursement files, not all 3', n; end if;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 12. nothing on the API ----------------------------------------------------------------------
  foreach r.full_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(r.full_name, 'public.mark_travel_reimbursements_paid(bigint[], date)', 'execute')
       or has_function_privilege(r.full_name, 'public.guard_travel_reimbursement()', 'execute')
       or has_function_privilege(r.full_name, 'public.guard_travel_reimbursement_adjustment()', 'execute') then
      raise exception '% can execute a migration 37 function', r.full_name;
    end if;
  end loop;
  foreach r.full_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(r.full_name, 'public.travel_reimbursements_payable', 'select')
       or has_table_privilege(r.full_name, 'public.travel_reimbursements_waiting', 'select') then
      raise exception '% can read the payroll views', r.full_name;
    end if;
  end loop;

  raise notice 'migration 37 verified';
end $$;

rollback;
