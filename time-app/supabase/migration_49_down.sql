-- ============================================================================
-- Withers Time, rollback for migration 49 (staff mileage for a Catering Event
-- capped at what its quote charged).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- PAY CHANGES: every unpaid Catering Event trip is priced at the IRS rate
-- again, uncapped, on the payable view payroll pays from (76c from
-- 2026-07-01 where the quote charged 72.5c). Nothing is lost: migration 49
-- stores no data. Roll the app back with it, or the pages keep showing the
-- capped amounts (the code reads event_mileage_caps() and, once it is gone,
-- prices at the IRS rate too).
-- ============================================================================

begin;

-- 3. the payable view as migration 42 made it.
create or replace view public.travel_reimbursements_payable as
select r.id,
       r.profile_id,
       p.qbo_employee_id,
       p.full_name,
       r.trip_date,
       r.miles,
       rate.cents_per_mile,
       coalesce(r.mileage_cents_override, round(r.miles * rate.cents_per_mile)::integer) as mileage_cents,
       r.tolls_cents,
       r.parking_cents,
       coalesce(r.mileage_cents_override, round(r.miles * rate.cents_per_mile)::integer)
         + r.tolls_cents + r.parking_cents as total_cents,
       r.decided_at as approved_at
  from public.travel_reimbursements r
  join public.profiles p on p.id = r.profile_id
  left join lateral (
    select m.cents_per_mile
      from public.mileage_rates m
     where m.starts_on <= r.trip_date
     order by m.starts_on desc
     limit 1
  ) rate on true
 where r.status = 'approved'
   and not (p.role in ('manager', 'owner') and p.active = false);

revoke all on public.travel_reimbursements_payable from public, anon, authenticated;

-- 1-2. the functions.
drop function if exists public.event_mileage_caps(bigint[]);
drop function if exists public.deal_mileage_cap(bigint);

commit;
