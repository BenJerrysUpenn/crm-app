-- ============================================================================
-- Withers Time, rollback for migration 58 (a Catering Event trip in the
-- staff member's own car is paid on the deal's stored round-trip miles).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- PAY CHANGES: none for a trip already Approved, Paid or Paid outside
-- payroll: it keeps the miles it carries, now labelled typed. A Submitted or
-- Rejected 'deal' trip keeps the deal's miles it was last written with,
-- labelled typed, and no longer follows the deal: miles that land on the deal
-- later do not reach it. Staff can type miles on a Catering Event again only
-- once the app is rolled back too; until then the app keeps sending 'deal',
-- which the restored check refuses.
--
-- The restored amounts check is NOT VALID: a 'deal' trip that was waiting
-- for its miles with no tolls or parking (0 of everything) stays as it is,
-- and only new writes are checked.
-- ============================================================================

begin;

drop trigger if exists deal_miles_travel_reimbursement on public.travel_reimbursements;
drop function if exists public.travel_reimbursement_deal_miles();

-- The amounts check first: a waiting 'deal' trip (0 of everything) could not
-- be relabelled under it. Restored, NOT VALID, at the end.
alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_amounts_check;

-- Approved rows are locked by migration 37's guard; the SQL editor (no
-- signed-in user) may relabel them only with the guard set aside.
alter table public.travel_reimbursements disable trigger guard_travel_reimbursement;
update public.travel_reimbursements set mileage_mode = 'typed' where mileage_mode = 'deal';
alter table public.travel_reimbursements enable trigger guard_travel_reimbursement;

alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_mileage_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_mileage_check
  check (mileage_mode in ('typed', 'destinations')
     and miles >= 0 and miles <= 2000
     and (mileage_mode <> 'destinations'
          or (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) > 0
              and start_at_store is not null and end_at_store is not null
              -- Two points at least: with neither end at the store, two stops.
              and jsonb_array_length(stops) + start_at_store::int + end_at_store::int >= 2)));

alter table public.travel_reimbursements add constraint travel_reimbursements_amounts_check
  check (tolls_cents >= 0 and parking_cents >= 0
     and (mileage_cents_override is null or mileage_cents_override >= 0)
     and (miles > 0 or tolls_cents > 0 or parking_cents > 0 or coalesce(mileage_cents_override, 0) > 0))
  not valid;

commit;
