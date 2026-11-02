-- ============================================================================
-- Withers Time, verification for migration 50 (a Catering Event whose quote
-- charged no mileage reimburses no mileage)
--
-- Run by hand against a database with migration 50 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee in public.profiles;
-- it makes its own deals and quotes (ids from 990000101). A clean run ends
-- with "migration 50 verified".
--
-- WHAT IS CHECKED
--   1. deal_mileage_cap(): a quote that is not the Uber flat fee and charged
--      $0 mileage, or has no mileage line, caps at 0c ('no_rate_on_quote'),
--      whether or not the deal has miles, and the latest quote decides; a
--      quote that charged mileage on a deal with no round-trip miles caps at
--      0c ('no_miles_on_deal'); the May 2026 keys transport_mode 'uber' and
--      transport_breakdown.rate_per_mile are read; no quote, the Uber flat
--      fee, a stored rate and a derived rate are as migration 49 left them.
--   2. Staff are told a 0c cap through event_mileage_caps(); anon may not call
--      deal_mileage_cap().
--   3. travel_reimbursements_payable: a trip on a $0 mileage quote pays 0c a
--      mile but its tolls and parking in full; a trip with no quote still pays
--      the IRS rate; an Adjustment's mileage replaces the 0c amount; entering
--      the deal's round-trip miles reprices a 'no_miles_on_deal' trip at the
--      quote's rate. lib/reimbursements/money.test.ts checks the app's copy.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  d_walk  bigint := 990000101;  -- $0 mileage quote, 0 miles: walkable from the store
  d_zmi   bigint := 990000102;  -- $0 mileage quote; the deal has miles
  d_requo bigint := 990000103;  -- charged mileage, then re-quoted at $0: the latest decides
  d_noln  bigint := 990000104;  -- a quote with no mileage line at all
  d_nomi  bigint := 990000105;  -- charged mileage; the deal's miles are blank
  d_zero  bigint := 990000106;  -- charged mileage; the deal's miles are 0
  d_muber bigint := 990000107;  -- May 2026: transport_mode 'uber'
  d_mrate bigint := 990000108;  -- May 2026: transport_breakdown.rate_per_mile
  d_none  bigint := 990000109;  -- no quote at all
  d_back  bigint := 990000110;  -- an ordinary mileage quote, 72.5c derived
  d_rate  bigint := 990000111;  -- a stored mileage_rate
  d_uber  bigint := 990000112;  -- the Uber flat fee
  t_walk  bigint;
  t_none  bigint;
  t_adj   bigint;
  t_nomi  bigint;
  n       integer;
  r       record;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if emp is null then raise exception 'need one employee in profiles to run this file'; end if;

  -- ---- 1. the cap per deal -----------------------------------------------------------------
  insert into public.deals (id, created_at, updated_at, round_trip_miles) values
    (d_walk, '2026-10-01', '2026-10-01', 0), (d_zmi, '2026-10-01', '2026-10-01', 12),
    (d_requo, '2026-10-01', '2026-10-01', 52), (d_noln, '2026-10-01', '2026-10-01', 20),
    (d_nomi, '2026-10-01', '2026-10-01', null), (d_zero, '2026-10-01', '2026-10-01', 0),
    (d_muber, '2026-05-01', '2026-05-01', null), (d_mrate, '2026-05-01', '2026-05-01', 70.4),
    (d_none, '2026-10-01', '2026-10-01', 30), (d_back, '2026-10-01', '2026-10-01', 42),
    (d_rate, '2026-10-01', '2026-10-01', 42), (d_uber, '2026-10-01', '2026-10-01', 20);
  insert into public.quote_versions (id, deal_id, version, invoice_number, docx_path, breakdown_json, created_at) values
    (990000101, d_walk, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0}', '2026-10-21'),
    (990000102, d_zmi, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0}', '2026-10-01'),
    (990000103, d_requo, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 37.7}', '2026-09-29'),
    (990000104, d_requo, 2, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0}', '2026-09-30'),
    (990000105, d_noln, 1, 'v', 'v', '{"transport_mode": "mileage", "labor_transport_flat": 120}', '2026-05-25'),
    (990000106, d_nomi, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 14.5}', '2026-10-01'),
    (990000107, d_zero, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 14.5}', '2026-10-01'),
    (990000108, d_muber, 1, 'v', 'v', '{"transport_mode": "uber", "labor_transport_flat": 75.0}', '2026-05-25'),
    (990000109, d_mrate, 1, 'v', 'v', '{"transport": 63.69, "transport_breakdown": {"mileage": 50.69, "tolls": 13.0, "miles_round_trip": 70.4, "rate_per_mile": 0.72}}', '2026-05-26'),
    -- 30.45 / 42 mi = 72.50c
    (990000110, d_back, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 30.45}', '2026-10-01'),
    (990000111, d_rate, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 30.45, "mileage_rate": 0.715}', '2026-10-01'),
    (990000112, d_uber, 1, 'v', 'v', '{"transportation_mode": "uber", "transportation_subtotal": 50.0}', '2026-10-01');

  for r in
    select * from (values
      (d_walk, 0::numeric, 'no_rate_on_quote'),
      (d_zmi, 0, 'no_rate_on_quote'),
      (d_requo, 0, 'no_rate_on_quote'),
      (d_noln, 0, 'no_rate_on_quote'),
      (d_nomi, 0, 'no_miles_on_deal'),
      (d_zero, 0, 'no_miles_on_deal'),
      (d_muber, null, 'uber_flat_fee'),
      (d_mrate, 72.00, 'quoted_rate'),
      (d_none, null, 'no_quote'),
      (d_back, 72.50, 'quote_derived'),
      (d_rate, 71.50, 'quoted_rate'),
      (d_uber, null, 'uber_flat_fee'),
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

  -- ---- 2. staff are told a 0c cap --------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.quote_versions where id between 990000101 and 990000112;
  if n <> 0 then raise exception 'staff read % quotes', n; end if;
  select * into r from public.event_mileage_caps(array[d_walk]);
  if r.cap_cents_per_mile is distinct from 0::numeric or r.basis <> 'no_rate_on_quote' then
    raise exception 'staff were told % / % for a $0 mileage quote', r.cap_cents_per_mile, r.basis;
  end if;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  if has_function_privilege('anon', 'public.deal_mileage_cap(bigint)', 'execute') then
    raise exception 'anon can call deal_mileage_cap()';
  end if;

  -- ---- 3. the payable view -------------------------------------------------------------------
  -- Inserted Submitted and approved here with no JWT, as the SQL editor would.
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles, tolls_cents, parking_cents) values
    (emp, 'catering_event', d_walk, 'Walkable event', null, '2026-10-22', 'typed', 3.2, 450, 1200) returning id into t_walk;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_none, 'No quote', null, '2026-10-21', 'typed', 30.4) returning id into t_none;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_walk, 'Walkable event', null, '2026-10-23', 'typed', 10.0) returning id into t_adj;
  insert into public.travel_reimbursements (profile_id, reason_kind, deal_id, event_label, reason_note, trip_date, mileage_mode, miles) values
    (emp, 'catering_event', d_nomi, 'Miles missing', null, '2026-10-07', 'typed', 20.0) returning id into t_nomi;
  update public.travel_reimbursements set status = 'approved' where id in (t_walk, t_none, t_adj, t_nomi);
  update public.travel_reimbursements set mileage_cents_override = 500 where id = t_adj;

  -- $0 mileage quote: 3.2 mi x 0c = 0, the 450 tolls and 1200 parking in full.
  select * into r from public.travel_reimbursements_payable where id = t_walk;
  if r.cents_per_mile <> 0 or r.mileage_cents <> 0 or r.total_cents <> 1650 then
    raise exception '$0 mileage quote: rate % mileage % total %', r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;
  -- No quote: the IRS rate, 30.4 mi x 76c = 2310.4 -> 2310.
  select * into r from public.travel_reimbursements_payable where id = t_none;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 2310 then
    raise exception 'no-quote event: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;
  select * into r from public.travel_reimbursements_payable where id = t_adj;
  if r.mileage_cents <> 500 or r.total_cents <> 500 then
    raise exception 'an Adjustment''s mileage did not replace the 0c amount: %', r.mileage_cents;
  end if;
  -- Charged mileage, no miles on the deal: 0c until the miles are entered.
  select * into r from public.travel_reimbursements_payable where id = t_nomi;
  if r.cents_per_mile <> 0 or r.mileage_cents <> 0 then
    raise exception 'no miles on the deal: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;
  -- 14.50 / 20 mi = 72.5c; 20.0 mi x 72.5c = 1450.
  update public.deals set round_trip_miles = 20 where id = d_nomi;
  select * into r from public.travel_reimbursements_payable where id = t_nomi;
  if r.cents_per_mile <> 72.50 or r.mileage_cents <> 1450 then
    raise exception 'entering the deal''s miles did not reprice the trip: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;

  raise notice 'migration 50 verified';
end $$;

rollback;
