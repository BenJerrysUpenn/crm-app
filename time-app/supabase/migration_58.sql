-- ============================================================================
-- Withers Time, migration 58: a Catering Event trip in the staff member's own
-- car is paid on the deal's stored round-trip miles; staff no longer type them
-- Run once in the Supabase SQL editor, after migration_57.sql and after the
-- app that ships this file deploys green on main. Safe to re-run.
--
-- VERIFY. supabase/migration_58_verify.sql. ROLLBACK. supabase/migration_58_down.sql.
--
-- APPLY ORDER. Deploy the time app FIRST, then run this file at once.
--   * New code, old database: a Catering Event trip is sent as mileage_mode
--     'deal', which migration 37's mileage check refuses, so staff cannot
--     submit one until this runs. Errands are unaffected.
--   * Old code, new database: a staff member's Catering Event trip is stored
--     as 'deal' with the deal's miles whatever the old form typed.
--
-- WHY (Alina, 2026-11-16, bj-finance #210). "Take the miles from the deal.
-- Staff stop typing miles. The app pays the round trip Catering-Manager
-- already saved for that event, under the existing pay cap." This replaces
-- ruling 48 (staff with their actual trip mileage are paid on it) for
-- Catering Events. Groceries / errands keep typed or destination miles.
-- The cap (rulings 47 and 50, deal_mileage_cap(), migrations 49, 50, 52) is
-- unchanged: the deal's miles x the lower of the IRS rate and the quote's
-- per-mile rate, 0c when the quote charged $0 mileage. A deal with no
-- round-trip miles yet waits for them (ruling 51): the time app queues a
-- miles-only recalculation and refuses Approve until they land.
--
-- WHAT THIS CHANGES
--   1. mileage_mode 'deal': a Catering Event trip whose miles are the deal's
--      deals.round_trip_miles, to one decimal. Only for reason_kind
--      'catering_event', and with no stops, store checkboxes or route legs.
--   2. travel_reimbursement_deal_miles(), a BEFORE INSERT OR UPDATE trigger:
--        * a staff member writing their own Catering Event trip (insert, or
--          an edit or resubmit while Submitted or Rejected) always writes
--          mileage_mode 'deal': a typed or destination mileage sent straight
--          to the API is not kept;
--        * every write to a 'deal' trip that was not yet Approved (insert,
--          edit, resubmit, an Adjustment while Submitted, Reject, and the
--          Approve itself) sets miles to the deal's round-trip miles now, 0
--          when the deal has none. So the miles an Approved trip is paid on
--          are the deal's at the moment it was approved, and Approved stays
--          locked (migration 37) as before. Sending one back reopens it.
--      Writes with no signed-in user (this SQL editor, the service role)
--      are not switched to 'deal', so nothing older is rewritten by it.
--   3. Every Submitted or Rejected Catering Event trip still on typed or
--      destination miles moves to 'deal' (step 2 fills its miles). An
--      Approver's Mileage Adjustment on it stays. Approved, Paid and Paid
--      outside payroll trips are not touched: they were decided on the miles
--      they carry. Production on 2026-11-16: none to move (all 6 Catering
--      Event trips on file are Paid).
--   4. The amounts check lets a 'deal' trip have no miles, tolls or parking
--      yet: it is waiting for the deal's miles (ruling 51), and the time app
--      refuses Approve while it is.
--   travel_reimbursements_payable (migration 49) is not redefined: it pays
--   r.miles, which for a 'deal' trip is the deal's miles as approved.
-- ============================================================================

begin;

-- The amounts check is dropped first and added back last (4), so step 3 can
-- move a trip whose deal has no miles yet.
alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_amounts_check;

-- ---------- 1. mileage_mode 'deal' ----------------------------------------------------------
alter table public.travel_reimbursements drop constraint if exists travel_reimbursements_mileage_check;
alter table public.travel_reimbursements add constraint travel_reimbursements_mileage_check
  check (mileage_mode in ('typed', 'destinations', 'deal')
     and miles >= 0 and miles <= 2000
     and (mileage_mode <> 'destinations'
          or (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) > 0
              and start_at_store is not null and end_at_store is not null
              -- Two points at least: with neither end at the store, two stops.
              and jsonb_array_length(stops) + start_at_store::int + end_at_store::int >= 2))
     and (mileage_mode <> 'deal'
          or (reason_kind = 'catering_event' and stops is null and route_legs is null
              and start_at_store is null and end_at_store is null)));

-- ---------- 2. the deal's miles, written by the database -------------------------------------
create or replace function public.travel_reimbursement_deal_miles()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_miles double precision;
begin
  if new.reason_kind <> 'catering_event' then
    return new;
  end if;
  -- Only a trip not yet Approved before this write: Approved is locked and
  -- Paid is final (migration 37's guard).
  if tg_op = 'UPDATE' and old.status not in ('submitted', 'rejected') then
    return new;
  end if;

  -- A staff member's own Catering Event trip is always the deal's round trip.
  if v_uid is not null and v_uid = new.profile_id then
    new.mileage_mode := 'deal';
  end if;

  if new.mileage_mode = 'deal' then
    select d.round_trip_miles::double precision into v_miles from public.deals d where d.id = new.deal_id;
    new.miles := case when v_miles > 0 then round(v_miles::numeric, 1) else 0 end;
    new.stops := null;
    new.start_at_store := null;
    new.end_at_store := null;
    new.route_legs := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.travel_reimbursement_deal_miles() from public, anon, authenticated, service_role;

-- Named to fire before guard_travel_reimbursement (BEFORE triggers run in name order),
-- so the guard sees the row as it will be stored.
drop trigger if exists deal_miles_travel_reimbursement on public.travel_reimbursements;
create trigger deal_miles_travel_reimbursement
  before insert or update on public.travel_reimbursements
  for each row execute function public.travel_reimbursement_deal_miles();

-- ---------- 3. unapproved Catering Event trips move to the deal's miles ----------------------
update public.travel_reimbursements
   set mileage_mode = 'deal'
 where reason_kind = 'catering_event'
   and status in ('submitted', 'rejected')
   and mileage_mode <> 'deal';

-- ---------- 4. a 'deal' trip may wait for its miles ------------------------------------------
alter table public.travel_reimbursements add constraint travel_reimbursements_amounts_check
  check (tolls_cents >= 0 and parking_cents >= 0
     and (mileage_cents_override is null or mileage_cents_override >= 0)
     and (miles > 0 or tolls_cents > 0 or parking_cents > 0 or coalesce(mileage_cents_override, 0) > 0
          or mileage_mode = 'deal'));

commit;
