-- ============================================================================
-- Withers Time, verification for migration 58 (a Catering Event trip in the
-- staff member's own car is paid on the deal's stored round-trip miles)
--
-- Run by hand against a database with migration 58 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee and one manager on
-- the roster in public.profiles; it makes its own deals and quotes (ids from
-- 990000301). A clean run ends with "migration 58 verified".
--
-- WHAT IS CHECKED
--   1. A staff member's own Catering Event trip is stored as 'deal' with the
--      deal's round-trip miles to one decimal, whatever miles, stops or mode
--      they send; an edit cannot change them either.
--   2. A deal with no round-trip miles: the trip is accepted with 0 miles and
--      nothing else (it waits for the miles); once the deal has miles, the
--      Approve writes them, and the payable view pays them at the IRS rate
--      (no quote): 12.25 mi -> 12.3 x 76c = 935.
--   3. A deal whose quote charged 72.5c a mile: 6.43 mi -> 6.4 x 72.5c = 464,
--      not the IRS 76c; after approval a change to the deal's miles does not
--      change what the Approved trip pays.
--   4. A quote that charged $0 mileage: 0c a mile, tolls and parking in full.
--   5. 'deal' is refused on Groceries / errands; errands keep typed miles.
--   6. Step 3 of the migration: a Submitted Catering Event trip on typed miles
--      (as written before it) moves to the deal's miles and keeps an
--      Approver's Mileage Adjustment; an Approved one does not move.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  mgr     uuid;
  d_rate  bigint := 990000301;  -- quote charged 72.5c a mile; 6.43 round-trip miles
  d_none  bigint := 990000302;  -- no quote; no round-trip miles yet
  d_zero  bigint := 990000303;  -- quote charged $0 mileage; 8 round-trip miles
  t_rate  bigint;
  t_dest  bigint;
  t_none  bigint;
  t_zero  bigint;
  t_err   bigint;
  t_old   bigint;
  t_appr  bigint;
  refused boolean;
  r       record;
begin
  select id into emp from public.profiles where role = 'employee' and active order by created_at limit 1;
  select id into mgr from public.profiles where role = 'manager' and active order by created_at limit 1;
  if emp is null or mgr is null then raise exception 'need one employee and one manager on the roster to run this file'; end if;

  insert into public.deals (id, created_at, updated_at, round_trip_miles) values
    (d_rate, '2026-10-22', '2026-10-22', 6.43), (d_none, '2026-10-22', '2026-10-22', null),
    (d_zero, '2026-10-22', '2026-10-22', 8);
  insert into public.quote_versions (id, deal_id, version, invoice_number, docx_path, breakdown_json, created_at) values
    (990000301, d_rate, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 4.66, "mileage_rate": 0.725}', '2026-10-20'),
    (990000303, d_zero, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0, "mileage_rate": 0.76}', '2026-10-20');

  -- ---- 1. staff: the deal's miles, whatever they send -----------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles)
  values (emp, 'catering_event', d_rate, 'Mileage event', '2026-10-22', 'typed', 99.0) returning id into t_rate;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles, stops, start_at_store, end_at_store, route_legs)
  values (emp, 'catering_event', d_rate, 'Mileage event', '2026-10-22', 'destinations', 40.0, '["Somewhere far"]', true, true, '[]')
  returning id into t_dest;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles)
  values (emp, 'catering_event', d_none, 'No miles yet', '2026-10-22', 'deal', 0) returning id into t_none;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles, tolls_cents, parking_cents)
  values (emp, 'catering_event', d_zero, 'Walkable event', '2026-10-22', 'deal', 0, 450, 1200) returning id into t_zero;
  insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
  values (emp, 'errands', 'Restaurant Depot', '2026-10-22', 'typed', 10.0) returning id into t_err;

  for r in select id, mileage_mode, miles, stops, start_at_store, route_legs from public.travel_reimbursements where id in (t_rate, t_dest) loop
    if r.mileage_mode <> 'deal' or r.miles <> 6.4 or r.stops is not null or r.start_at_store is not null or r.route_legs is not null then
      raise exception 'staff trip % stored as % % mi (stops %), not the deal''s 6.4 mi', r.id, r.mileage_mode, r.miles, r.stops;
    end if;
  end loop;
  select mileage_mode, miles into r from public.travel_reimbursements where id = t_none;
  if r.mileage_mode <> 'deal' or r.miles <> 0 then raise exception 'no-miles deal stored as % % mi', r.mileage_mode, r.miles; end if;
  select mileage_mode, miles into r from public.travel_reimbursements where id = t_err;
  if r.mileage_mode <> 'typed' or r.miles <> 10.0 then raise exception 'errands stored as % % mi, not typed 10', r.mileage_mode, r.miles; end if;

  -- An edit keeps the deal's miles too.
  update public.travel_reimbursements set mileage_mode = 'typed', miles = 50.0 where id = t_rate;
  select mileage_mode, miles into r from public.travel_reimbursements where id = t_rate;
  if r.mileage_mode <> 'deal' or r.miles <> 6.4 then raise exception 'a staff edit stored % % mi', r.mileage_mode, r.miles; end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);

  -- ---- 5. 'deal' is for Catering Events only --------------------------------------------------
  begin
    insert into public.travel_reimbursements (profile_id, reason_kind, reason_note, trip_date, mileage_mode, miles)
    values (emp, 'errands', 'Depot', '2026-10-22', 'deal', 5.0);
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception 'an errands trip was stored with mileage_mode deal'; end if;

  -- ---- 2. no miles yet, then they land, then the Approve writes them --------------------------
  update public.deals set round_trip_miles = 12.25 where id = d_none;
  select miles into r from public.travel_reimbursements where id = t_none;
  if r.miles <> 0 then raise exception 'the trip changed before any write: % mi', r.miles; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', mgr::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.travel_reimbursements set status = 'approved', decided_by = mgr, decided_at = now() where id in (t_none, t_rate, t_zero);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select * into r from public.travel_reimbursements_payable where id = t_none;
  if r.miles <> 12.3 or r.cents_per_mile <> 76.00 or r.mileage_cents <> 935 then
    raise exception 'no quote, miles landed: % mi x % = %, not 12.3 x 76 = 935', r.miles, r.cents_per_mile, r.mileage_cents;
  end if;

  -- ---- 3. the quote's 72.5c, and Approved keeps its miles -------------------------------------
  select * into r from public.travel_reimbursements_payable where id = t_rate;
  if r.miles <> 6.4 or r.cents_per_mile <> 72.50 or r.mileage_cents <> 464 then
    raise exception 'quote at 72.5c: % mi x % = %, not 6.4 x 72.5 = 464', r.miles, r.cents_per_mile, r.mileage_cents;
  end if;
  update public.deals set round_trip_miles = 30 where id = d_rate;
  select * into r from public.travel_reimbursements_payable where id = t_rate;
  if r.miles <> 6.4 or r.mileage_cents <> 464 then raise exception 'an Approved trip followed the deal to % mi', r.miles; end if;

  -- ---- 4. a $0 mileage quote --------------------------------------------------------------------
  select * into r from public.travel_reimbursements_payable where id = t_zero;
  if r.miles <> 8.0 or r.cents_per_mile <> 0 or r.mileage_cents <> 0 or r.total_cents <> 1650 then
    raise exception '$0 mileage quote: % mi x % = %, total %; not 8 x 0 = 0, total 1650', r.miles, r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;

  -- ---- 6. trips written before this migration ---------------------------------------------------
  -- Written as the SQL editor would (no signed-in user), so they stay typed, as old rows are.
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles)
  values (emp, 'catering_event', d_zero, 'Typed before', '2026-10-22', 'typed', 15.0) returning id into t_old;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, trip_date, mileage_mode, miles)
  values (emp, 'catering_event', d_zero, 'Approved before', '2026-10-22', 'typed', 15.0) returning id into t_appr;
  update public.travel_reimbursements set status = 'approved' where id = t_appr;
  -- An Approver's Mileage Adjustment of $10.00 on the typed miles.
  update public.travel_reimbursements set mileage_cents_override = 1000 where id = t_old;
  if (select mileage_mode from public.travel_reimbursements where id = t_old) <> 'typed' then
    raise exception 'a write with no signed-in user was switched to deal';
  end if;
  -- Step 3 of migration 58, as it runs there.
  update public.travel_reimbursements
     set mileage_mode = 'deal'
   where reason_kind = 'catering_event'
     and status in ('submitted', 'rejected')
     and mileage_mode <> 'deal';
  select mileage_mode, miles, mileage_cents_override into r from public.travel_reimbursements where id = t_old;
  if r.mileage_mode <> 'deal' or r.miles <> 8.0 then raise exception 'a Submitted typed trip moved to % % mi, not the deal''s 8', r.mileage_mode, r.miles; end if;
  if r.mileage_cents_override is distinct from 1000 then
    raise exception 'the move dropped the Mileage Adjustment: % c, not 1000', r.mileage_cents_override;
  end if;
  select mileage_mode, miles into r from public.travel_reimbursements where id = t_appr;
  if r.mileage_mode <> 'typed' or r.miles <> 15.0 then raise exception 'an Approved typed trip moved to % % mi', r.mileage_mode, r.miles; end if;

  raise notice 'migration 58 verified';
end $$;

rollback;
