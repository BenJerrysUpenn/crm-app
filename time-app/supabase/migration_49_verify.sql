-- ============================================================================
-- Withers Time, verification for migration 49 (staff mileage for a Catering
-- Event capped at what its quote charged)
--
-- Run by hand against a database with migration 49 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee in public.profiles;
-- it makes its own deals and quotes (ids from 990000001). A clean run ends
-- with "migration 49 verified".
--
-- WHAT IS CHECKED
--   1. The IRS rates are as migration 37 left them.
--   2. deal_mileage_cap(): the latest quote decides; the Uber flat fee (and
--      its older name 'parking') has no cap; a stored mileage_rate wins over
--      the one derived from subtotal / miles, which is to the half cent; no
--      quote, or a breakdown that is not JSON, has no cap (the owner,
--      2026-10-29); no deal has no cap. A quote with no per-mile charge (a $0
--      or missing transportation subtotal, or no miles on the deal) is left
--      to migration_50_verify.sql: migration 50 redefined it as 0c, and these
--      checks pass with or without migration 50.
--   3. Staff read no quote, yet event_mileage_caps() answers them; anon may
--      call neither function.
--   4. travel_reimbursements_payable: a Catering Event trip at the lower of
--      the IRS rate and its cap; errands, the Uber flat fee and no quote at
--      the IRS rate; an Adjustment's mileage still
--      replacing it. These are the cases
--      lib/reimbursements/money.test.ts checks for the app's copy.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  d_uber  bigint := 990000001;  -- Uber flat fee on the latest quote, mileage before
  d_back  bigint := 990000002;  -- Uber flat fee first, mileage on the latest quote
  d_park  bigint := 990000003;  -- the May 2026 name for the same flat fee
  d_none  bigint := 990000004;  -- no quote at all
  d_bad   bigint := 990000005;  -- latest breakdown is not JSON
  d_rate  bigint := 990000006;  -- the quote stores its mileage_rate
  d_high  bigint := 990000008;  -- the quote charged more than the IRS rate
  t_uber  bigint;
  t_back  bigint;
  t_err   bigint;
  t_june  bigint;
  t_oct   bigint;
  t_high  bigint;
  t_adj   bigint;
  n       integer;
  r       record;
  who     text;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if emp is null then raise exception 'need one employee in profiles to run this file'; end if;

  -- ---- 1. the IRS rates are unchanged ------------------------------------------------------
  if (select cents_per_mile from public.mileage_rates where starts_on = '2026-07-01') <> 76.00
     or (select cents_per_mile from public.mileage_rates where starts_on = '2026-01-01') <> 72.50 then
    raise exception 'the IRS rates are not 72.5c from 2026-01-01 and 76c from 2026-07-01';
  end if;

  -- ---- 2. the cap per deal -----------------------------------------------------------------
  insert into public.deals (id, created_at, updated_at, round_trip_miles) values
    (d_uber, '2026-10-01', '2026-10-01', 20), (d_back, '2026-10-01', '2026-10-01', 42),
    (d_park, '2026-10-01', '2026-10-01', 6), (d_none, '2026-10-01', '2026-10-01', 30),
    (d_bad, '2026-10-01', '2026-10-01', 10), (d_rate, '2026-10-01', '2026-10-01', 42),
    (d_high, '2026-10-01', '2026-10-01', 10);
  insert into public.quote_versions (id, deal_id, version, invoice_number, docx_path, breakdown_json, created_at) values
    (990000001, d_uber, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 14.5}', '2026-10-01'),
    (990000002, d_uber, 2, 'v', 'v', '{"transportation_mode": "uber", "transportation_subtotal": 50.0}', '2026-10-02'),
    (990000003, d_back, 1, 'v', 'v', '{"transportation_mode": "uber", "transportation_subtotal": 50.0}', '2026-10-01'),
    -- 30.45 / 42 mi = 72.50c
    (990000004, d_back, 2, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 30.45}', '2026-10-02'),
    (990000005, d_park, 1, 'v', 'v', '{"transportation_mode": "parking", "transportation_subtotal": 50.0}', '2026-05-22'),
    (990000006, d_bad, 1, 'v', 'v', '{"transportation_mode": "uber"}', '2026-10-01'),
    (990000007, d_bad, 2, 'v', 'v', 'not json', '2026-10-02'),
    -- A stored rate (dollars a mile) wins over 30.45 / 42.
    (990000008, d_rate, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 30.45, "mileage_rate": 0.715}', '2026-10-01'),
    -- 9.03 / 10 mi = 90.3c, to the half cent 90.5c: above the IRS rate.
    (990000010, d_high, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 9.03}', '2026-10-01');

  for r in
    select * from (values
      (d_uber, null::numeric, 'uber_flat_fee'),
      (d_back, 72.50, 'quote_derived'),
      (d_park, null, 'uber_flat_fee'),
      (d_none, null, 'no_quote'),
      (d_bad, null, 'no_quote'),
      (d_rate, 71.50, 'quoted_rate'),
      (d_high, 90.50, 'quote_derived'),
      (null::bigint, null, 'none')
    ) as e(deal, cap, basis)
  loop
    if (select c.cap_cents_per_mile from public.deal_mileage_cap(r.deal) c) is distinct from r.cap
       or (select c.basis from public.deal_mileage_cap(r.deal) c) is distinct from r.basis then
      raise exception 'deal_mileage_cap(%) is % / %, not % / %', r.deal,
        (select c.cap_cents_per_mile from public.deal_mileage_cap(r.deal) c),
        (select c.basis from public.deal_mileage_cap(r.deal) c), r.cap, r.basis;
    end if;
  end loop;
  select count(*) into n from public.event_mileage_caps(array[d_uber, d_back, null, d_back]);
  if n <> 2 then raise exception 'event_mileage_caps answered % rows for two deals', n; end if;

  -- ---- 3. staff ask, and read no quote -------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.quote_versions where id between 990000001 and 990000014;
  if n <> 0 then raise exception 'staff read % quotes', n; end if;
  if (select c.cap_cents_per_mile from public.event_mileage_caps(array[d_back]) c) <> 72.50 then
    raise exception 'staff were not told the cap of a Catering Event';
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_function_privilege('anon', 'public.deal_mileage_cap(bigint)', 'execute')
     or has_function_privilege('anon', 'public.event_mileage_caps(bigint[])', 'execute') then
    raise exception 'anon can call a migration 49 function';
  end if;

  -- ---- 4. the payable view -------------------------------------------------------------------
  -- Inserted Submitted and approved here with no JWT, as the SQL editor would.
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_uber, 'Uber event', null, '2026-10-07', 'typed', 10.0) returning id into t_uber;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles, tolls_cents) values
    (emp, 'catering_event', d_back, 'Mileage event', null, '2026-10-07', 'typed', 46.3, 450) returning id into t_back;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'errands', null, null, 'Depot', '2026-10-07', 'typed', 10.0) returning id into t_err;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_none, 'No quote', null, '2026-06-30', 'typed', 10.0) returning id into t_june;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_none, 'No quote', null, '2026-10-21', 'typed', 30.4) returning id into t_oct;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_high, 'Dear mileage', null, '2026-10-07', 'typed', 10.0) returning id into t_high;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_back, 'Mileage event', null, '2026-10-08', 'typed', 10.0) returning id into t_adj;
  update public.travel_reimbursements set status = 'approved' where id in (t_uber, t_back, t_err, t_june, t_oct, t_high, t_adj);
  update public.travel_reimbursements set mileage_cents_override = 500 where id = t_adj;

  -- Uber flat fee: IRS 76c. 10.0 mi = 760.
  select * into r from public.travel_reimbursements_payable where id = t_uber;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 760 or r.total_cents <> 760 then
    raise exception 'Uber flat fee event: rate % mileage % total %', r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;
  -- Quote charged 72.5c: 46.3 mi x 72.5c = 3356.75 -> 3357, plus 450 tolls.
  select * into r from public.travel_reimbursements_payable where id = t_back;
  if r.cents_per_mile <> 72.50 or r.mileage_cents <> 3357 or r.total_cents <> 3807 then
    raise exception 'mileage event: rate % mileage % total %', r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;
  select * into r from public.travel_reimbursements_payable where id = t_err;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 760 then
    raise exception 'errands: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;
  -- No quote: the IRS rate for the trip date, June 72.5c and October 76c
  -- (30.4 mi x 76c = 2310.4 -> 2310), never the price list's rate.
  select * into r from public.travel_reimbursements_payable where id = t_june;
  if r.cents_per_mile <> 72.50 or r.mileage_cents <> 725 then
    raise exception 'no-quote event, June: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;
  select * into r from public.travel_reimbursements_payable where id = t_oct;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 2310 or r.total_cents <> 2310 then
    raise exception 'no-quote event, October: rate % mileage % total %', r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;
  -- A quote above the IRS rate pays the IRS rate.
  select * into r from public.travel_reimbursements_payable where id = t_high;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 760 then
    raise exception 'quote above IRS: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;
  select * into r from public.travel_reimbursements_payable where id = t_adj;
  if r.mileage_cents <> 500 or r.total_cents <> 500 then
    raise exception 'an Adjustment''s mileage did not replace the capped amount: %', r.mileage_cents;
  end if;
  foreach who in array array['anon', 'authenticated'] loop
    if has_table_privilege(who, 'public.travel_reimbursements_payable', 'select') then
      raise exception '% can read the payable view', who;
    end if;
  end loop;

  raise notice 'migration 49 verified';
end $$;

rollback;
