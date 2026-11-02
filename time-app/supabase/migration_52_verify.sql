-- ============================================================================
-- Withers Time, verification for migration 52 (a quote that charged $0
-- mileage caps at 0c even when it stores a per-mile rate)
--
-- Run by hand against a database with migration 52 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. It needs one employee in public.profiles;
-- it makes its own deals and quotes (ids from 990000201). A clean run ends
-- with "migration 52 verified".
--
-- WHAT IS CHECKED
--   1. deal_mileage_cap(): a mileage quote that charged $0 caps at 0c
--      ('no_rate_on_quote') although it stores mileage_rate 0.76, the shape
--      Catering-Manager #115 pins, whether or not the deal has miles, and a
--      re-quote to $0 decides; a $0 subtotal also beats a May 2026
--      transport_breakdown.rate_per_mile; a subtotal that is not a JSON number
--      is not read as $0; the Uber flat fee at $0, a stored rate on a quote
--      that charged mileage, the May 2026 stored rate with no subtotal, a
--      derived rate and no quote are as migration 50 left them.
--   2. Staff are told the 0c cap through event_mileage_caps().
--   3. travel_reimbursements_payable: a trip on a $0 quote that stores 0.76
--      pays 0c a mile and its tolls and parking in full (1650, the case
--      lib/reimbursements/money.test.ts checks for the app's copy); a trip on
--      a quote that charged 76c pays 76c.
--   4. Production, as of 2026-10-29 (read only): deals 25459, 25434, 25426,
--      25415 and 24892 answer what they answered under migration 50. A deal
--      that is not on file (a local database) is skipped. A re-quote since
--      2026-10-29 can change a deal's answer: read its latest quote before
--      reading a failure here as a bug.
-- ============================================================================

begin;

do $$
declare
  emp     uuid;
  d_walk  bigint := 990000201;  -- $0 mileage quote that stores 0.76, 0 miles: walkable
  d_zmi   bigint := 990000202;  -- $0 mileage quote that stores 0.76; the deal has miles
  d_requo bigint := 990000203;  -- charged 76c, then re-quoted at $0: the latest decides
  d_ztb   bigint := 990000204;  -- $0 subtotal beside a May 2026 transport_breakdown rate
  d_str   bigint := 990000205;  -- subtotal is the string "0": not read as $0
  d_uber0 bigint := 990000206;  -- the Uber flat fee, subtotal 0
  d_rate  bigint := 990000207;  -- charged mileage and stores 0.76
  d_mrate bigint := 990000208;  -- May 2026: transport_breakdown.rate_per_mile, no subtotal
  d_back  bigint := 990000209;  -- an older mileage quote, 72.5c derived
  d_none  bigint := 990000210;  -- no quote at all
  t_walk  bigint;
  t_rate  bigint;
  r       record;
  n       integer;
begin
  select id into emp from public.profiles where role = 'employee' order by created_at limit 1;
  if emp is null then raise exception 'need one employee in profiles to run this file'; end if;

  -- ---- 1. the cap per deal -----------------------------------------------------------------
  insert into public.deals (id, created_at, updated_at, round_trip_miles) values
    (d_walk, '2026-10-29', '2026-10-29', 0), (d_zmi, '2026-10-29', '2026-10-29', 12),
    (d_requo, '2026-10-29', '2026-10-29', 42), (d_ztb, '2026-10-29', '2026-10-29', 0),
    (d_str, '2026-10-29', '2026-10-29', 0), (d_uber0, '2026-10-29', '2026-10-29', 0),
    (d_rate, '2026-10-29', '2026-10-29', 42), (d_mrate, '2026-05-01', '2026-05-01', 70.4),
    (d_back, '2026-10-01', '2026-10-01', 42), (d_none, '2026-10-29', '2026-10-29', 30);
  insert into public.quote_versions (id, deal_id, version, invoice_number, docx_path, breakdown_json, created_at) values
    -- Catering-Manager #115, test_zero_mileage: what a $0 mileage quote stores today.
    (990000201, d_walk, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0, "mileage_rate": 0.76, "mileage_rate_date": "2026-11-14"}', '2026-10-29'),
    (990000202, d_zmi, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0, "mileage_rate": 0.76}', '2026-10-29'),
    -- 42 mi x 0.76 = 31.92
    (990000203, d_requo, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 31.92, "mileage_rate": 0.76}', '2026-10-28'),
    (990000204, d_requo, 2, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0.0, "mileage_rate": 0.76}', '2026-10-29'),
    (990000205, d_ztb, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 0, "transport_breakdown": {"rate_per_mile": 0.72}}', '2026-10-29'),
    (990000206, d_str, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": "0", "mileage_rate": 0.76}', '2026-10-29'),
    (990000207, d_uber0, 1, 'v', 'v', '{"transportation_mode": "uber", "transportation_subtotal": 0.0, "mileage_rate": 0.76}', '2026-10-29'),
    (990000208, d_rate, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 31.92, "mileage_rate": 0.76}', '2026-10-29'),
    (990000209, d_mrate, 1, 'v', 'v', '{"transport": 63.69, "transport_breakdown": {"mileage": 50.69, "tolls": 13.0, "miles_round_trip": 70.4, "rate_per_mile": 0.72}}', '2026-05-26'),
    -- 30.45 / 42 mi = 72.50c
    (990000210, d_back, 1, 'v', 'v', '{"transportation_mode": "mileage", "transportation_subtotal": 30.45}', '2026-10-01');

  for r in
    select * from (values
      (d_walk, 0::numeric, 'no_rate_on_quote'),
      (d_zmi, 0, 'no_rate_on_quote'),
      (d_requo, 0, 'no_rate_on_quote'),
      (d_ztb, 0, 'no_rate_on_quote'),
      (d_str, 76.00, 'quoted_rate'),
      (d_uber0, null, 'uber_flat_fee'),
      (d_rate, 76.00, 'quoted_rate'),
      (d_mrate, 72.00, 'quoted_rate'),
      (d_back, 72.50, 'quote_derived'),
      (d_none, null, 'no_quote'),
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

  -- ---- 2. staff are told the 0c cap --------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', emp::text, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.quote_versions where id between 990000201 and 990000210;
  if n <> 0 then raise exception 'staff read % quotes', n; end if;
  select * into r from public.event_mileage_caps(array[d_walk]);
  if r.cap_cents_per_mile is distinct from 0::numeric or r.basis <> 'no_rate_on_quote' then
    raise exception 'staff were told % / % for a $0 mileage quote that stores a rate', r.cap_cents_per_mile, r.basis;
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
    (emp, 'catering_event', d_rate, 'Mileage event', null, '2026-10-22', 'typed', 10.0) returning id into t_rate;
  update public.travel_reimbursements set status = 'approved' where id in (t_walk, t_rate);

  -- $0 mileage quote that stores 0.76: 3.2 mi x 0c = 0, the 450 tolls and 1200 parking in full.
  select * into r from public.travel_reimbursements_payable where id = t_walk;
  if r.cents_per_mile <> 0 or r.mileage_cents <> 0 or r.total_cents <> 1650 then
    raise exception '$0 mileage quote with a stored rate: rate % mileage % total %', r.cents_per_mile, r.mileage_cents, r.total_cents;
  end if;
  -- Charged 76c: 10.0 mi x 76c = 760.
  select * into r from public.travel_reimbursements_payable where id = t_rate;
  if r.cents_per_mile <> 76.00 or r.mileage_cents <> 760 then
    raise exception 'quote that charged 76c: rate % mileage %', r.cents_per_mile, r.mileage_cents;
  end if;

  -- ---- 4. production, as of 2026-10-29 -------------------------------------------------------
  for r in
    select * from (values
      (25459::bigint, 0::numeric, 'no_rate_on_quote'),  -- $0 mileage quote, no stored rate
      (25434, 72.50, 'quote_derived'),                  -- 30.45 over the deal's miles
      (25426, null, 'no_quote'),
      (25415, null, 'uber_flat_fee'),
      (24892, 72.00, 'quoted_rate')                     -- May 2026 transport_breakdown.rate_per_mile
    ) as e(deal, cap, basis)
  loop
    if not exists (select 1 from public.deals d where d.id = r.deal) then
      continue;
    end if;
    if (select c.cap_cents_per_mile from public.deal_mileage_cap(r.deal) c) is distinct from r.cap
       or (select c.basis from public.deal_mileage_cap(r.deal) c) is distinct from r.basis then
      raise exception 'production deal % is % / %, not % / %', r.deal,
        (select c.cap_cents_per_mile from public.deal_mileage_cap(r.deal) c),
        (select c.basis from public.deal_mileage_cap(r.deal) c), r.cap, r.basis;
    end if;
  end loop;

  raise notice 'migration 52 verified';
end $$;

rollback;
