-- ============================================================================
-- Withers Time, migration 50: a Catering Event whose quote charged no mileage
-- reimburses no mileage
-- Run once in the Supabase SQL editor, after migration_49.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_50_verify.sql. ROLLBACK. supabase/migration_50_down.sql.
--
-- APPLY ORDER. Deploy the time app FIRST, then run this file before the next
-- pay run is built.
--   * New code, old database: migration 49 answers no 0c cap, so every trip
--     is priced as it is today; the new wording never shows.
--   * Old code, new database: the amounts are right (0c is a cap like any
--     other), but a trip capped at 0c reads "0¢/mi (the event's quoted rate)"
--     on the Reimbursements pages and the form gives no reason for $0.
--
-- WHY (the owner, 2026-10-29). Staff are never reimbursed more than the
-- quote charged the customer. A quote that is not the Uber flat fee and
-- charged $0 mileage charged nothing (an event walkable from the store is
-- quoted $0 on purpose), so its trips pay 0c a mile. Migration 49 read the
-- same $0 as "no rate on the quote" and paid the IRS rate. A deal with no
-- quote at all is unchanged: the IRS rate ('no_quote').
--
-- WHAT THIS CHANGES. deal_mileage_cap(deal id) only; event_mileage_caps()
-- and travel_reimbursements_payable call it and are not redefined. The
-- latest quote (quote_versions, highest version) decides, in this order:
--   'no_quote'         no quote, or its breakdown is not a JSON object: no
--                      cap, the IRS rate. Unchanged.
--   'uber_flat_fee'    transportation_mode 'uber' or 'parking'; NEW: or, when
--                      transportation_mode is absent, the May 2026 key
--                      transport_mode 'uber' or 'parking'. No cap.
--   'quoted_rate'      breakdown_json.mileage_rate, dollars a mile, x 100.
--                      NEW: or the May 2026 transport_breakdown.rate_per_mile.
--   'quote_derived'    transportation_subtotal > 0 over deals.round_trip_miles
--                      > 0, to the nearest half cent. Unchanged.
--   'no_miles_on_deal' NEW: transportation_subtotal > 0, but the deal has no
--                      round-trip miles (0 or blank) to divide it by: 0c. The
--                      quote did charge mileage, so this is missing data, not a
--                      $0 charge. 0c is the rule because the IRS rate (76c)
--                      would pay more a mile than every mileage quote on file
--                      charged (72c or 72.5c), and the owner's rule is never
--                      more than charged. 0c is put right before payroll: an
--                      unpaid trip is priced when it is read (ruling 33), so
--                      once a manager enters the deal's round-trip miles it
--                      pays the quote's rate ('quote_derived'), and an
--                      Approver can still make an Adjustment. Staff and the
--                      Approver see why it is $0.
--   'no_rate_on_quote' any other quote: transportation_subtotal is 0, missing
--                      or not a number, and no rate is stored. CHANGED: 0c
--                      (migration 49: no cap, the IRS rate).
--   'none'             no deal: no cap. Unchanged.
-- The two May 2026 keys are read so that those quotes keep what they charged:
-- without them the one Uber quote of that shape and the one 72c-a-mile
-- quote of that shape would have become 0c.
--
-- Every reimbursement not yet Paid is priced when it is read (ruling 33), so
-- this reprices the unpaid ones; no reimbursement or rate row is written.
-- Production on 2026-10-29: no reimbursement, paid or not, is on a deal
-- whose cap this changes.
-- ============================================================================

begin;

create or replace function public.deal_mileage_cap(
  p_deal_id bigint,
  out cap_cents_per_mile numeric,
  out basis text
)
language plpgsql
stable
security definer set search_path = public
as $$
declare
  v_b        jsonb;
  v_mode     text;
  v_subtotal numeric;
  v_miles    numeric;
begin
  cap_cents_per_mile := null;
  basis := 'none';
  if p_deal_id is null then
    return;
  end if;

  begin
    select q.breakdown_json::jsonb
      into v_b
      from public.quote_versions q
     where q.deal_id = p_deal_id
     order by q.version desc, q.id desc
     limit 1;
  exception when invalid_text_representation then
    v_b := null;
  end;

  if v_b is null or jsonb_typeof(v_b) <> 'object' then
    basis := 'no_quote';
    return;
  end if;

  -- transport_mode: the May 2026 name for transportation_mode.
  v_mode := coalesce(v_b ->> 'transportation_mode', v_b ->> 'transport_mode');
  if v_mode in ('uber', 'parking') then
    basis := 'uber_flat_fee';
    return;
  end if;
  if jsonb_typeof(v_b -> 'mileage_rate') = 'number' and (v_b ->> 'mileage_rate')::numeric > 0 then
    cap_cents_per_mile := round((v_b ->> 'mileage_rate')::numeric * 100, 2);
    basis := 'quoted_rate';
    return;
  end if;
  -- transport_breakdown.rate_per_mile: where a May 2026 quote stored it.
  if jsonb_typeof(v_b -> 'transport_breakdown' -> 'rate_per_mile') = 'number'
     and (v_b -> 'transport_breakdown' ->> 'rate_per_mile')::numeric > 0 then
    cap_cents_per_mile := round((v_b -> 'transport_breakdown' ->> 'rate_per_mile')::numeric * 100, 2);
    basis := 'quoted_rate';
    return;
  end if;
  if jsonb_typeof(v_b -> 'transportation_subtotal') = 'number' then
    v_subtotal := (v_b ->> 'transportation_subtotal')::numeric;
    if v_subtotal > 0 then
      select d.round_trip_miles::numeric into v_miles from public.deals d where d.id = p_deal_id;
      if v_miles > 0 then
        cap_cents_per_mile := round(round(v_subtotal * 100 / v_miles * 2) / 2, 2);
        basis := 'quote_derived';
      else
        cap_cents_per_mile := 0;
        basis := 'no_miles_on_deal';
      end if;
      return;
    end if;
  end if;

  -- The quote charged no mileage (the owner, 2026-10-29).
  cap_cents_per_mile := 0;
  basis := 'no_rate_on_quote';
end;
$$;

revoke execute on function public.deal_mileage_cap(bigint) from public, anon;
grant execute on function public.deal_mileage_cap(bigint) to authenticated, service_role;

commit;
