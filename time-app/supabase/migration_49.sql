-- ============================================================================
-- Withers Time, migration 49: staff mileage for a Catering Event is never
-- more per mile than the event's quote charged the customer
-- Run once in the Supabase SQL editor, after migration_48.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_49_verify.sql. ROLLBACK. supabase/migration_49_down.sql.
--
-- APPLY ORDER. Deploy the time app FIRST, then run this file before the next
-- pay run is built.
--   * New code, old database: the app finds no event_mileage_caps() and
--     prices every trip at the IRS rate, exactly as today.
--   * Old code, new database: the payable view (what payroll pays) is right,
--     but the Reimbursements pages show the uncapped IRS amount until the
--     code deploys.
--
-- WHY (bj-finance #210, the owner 2026-10-29). Staff are reimbursed at the
-- IRS rate for the trip date (public.mileage_rates, unchanged), but for a
-- Catering Event never more per mile than the event's quote charged the
-- customer:
--   * a quote that charged mileage: the lower of the IRS rate and the quote's
--     per-mile rate;
--   * a quote that charged the $50 Uber flat fee: the IRS rate;
--   * no quote (the owner, 2026-10-29), or a quote with no mileage charge to
--     read a rate from: the IRS rate;
--   * Groceries / errands: the IRS rate.
--
-- WHAT THIS ADDS
--   1. deal_mileage_cap(deal id) -> (cap_cents_per_mile, basis): the most a
--      staff mile on that deal's Catering Event may pay, in cents, and where
--      that came from. Read from the deal's latest quote (quote_versions,
--      highest version), in this order:
--        'no_quote'       the deal has no quote (a picklist-only event, say),
--                         or its latest breakdown is not JSON: no cap, the
--                         IRS rate (the owner, 2026-10-29).
--        'uber_flat_fee'  transportation_mode 'uber' (or 'parking', the name
--                         Catering-Manager gave the same $50 flat in May
--                         2026): no cap.
--        'quoted_rate'    breakdown_json.mileage_rate, dollars a mile, when
--                         Catering-Manager stores it (from late 2026): x 100.
--        'quote_derived'  older quotes store only transportation_subtotal:
--                         subtotal / deals.round_trip_miles, to the nearest
--                         half cent. Catering-Manager bills round_trip_miles
--                         x MILEAGE_RATE rounded to the cent, so the half
--                         cent absorbs that rounding; every mileage quote on
--                         file comes out at 72.0 or 72.5. It reads the
--                         deal's miles today, not as quoted: a deal whose
--                         miles changed after its last quote derives wrong.
--        'no_rate_on_quote'  a quote that is not the Uber flat fee but
--                         states no per-mile price: no mileage_rate, and a
--                         transportation_subtotal that is missing or 0, or
--                         no miles on the deal to divide by. No cap, the
--                         IRS rate, as with no quote. Catering-Manager bills
--                         round_trip_miles x MILEAGE_RATE, so a $0 mileage
--                         line means the quote was priced with 0 miles (the
--                         miles were never looked up, or were zeroed): 0 /
--                         0, not a rate of 0c. Capping it at 0c would pay
--                         staff nothing for a real drive.
--        'none'           no deal: no cap.
--      The catering price list (pricing_scalars) is not read: a deal with no
--      quote is paid the IRS rate, not what a quote would charge today.
--      SECURITY DEFINER: staff cannot read deals or quote_versions; it
--      answers only the cap and its basis.
--   2. event_mileage_caps(deal ids): the same for many deals, for the app
--      (lib/reimbursements/server.ts), as the signed-in person.
--   3. travel_reimbursements_payable pays a Catering Event trip at the lower
--      of the IRS rate and its deal's cap, every other trip at the IRS rate.
--      Same columns as migration 42; cents_per_mile is the rate it used.
--      lib/reimbursements/money.ts is the app's copy; migration_49_verify.sql
--      checks the cases they share.
--
-- Every reimbursement not yet Paid is priced when it is read (ruling 33), so
-- this reprices the unpaid ones; no reimbursement or rate row is written.
-- ============================================================================

begin;

-- ---------- 1. the cap for one deal ------------------------------------------------
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

  v_mode := v_b ->> 'transportation_mode';
  if v_mode in ('uber', 'parking') then
    basis := 'uber_flat_fee';
    return;
  end if;
  if jsonb_typeof(v_b -> 'mileage_rate') = 'number' and (v_b ->> 'mileage_rate')::numeric > 0 then
    cap_cents_per_mile := round((v_b ->> 'mileage_rate')::numeric * 100, 2);
    basis := 'quoted_rate';
    return;
  end if;
  if jsonb_typeof(v_b -> 'transportation_subtotal') = 'number' then
    v_subtotal := (v_b ->> 'transportation_subtotal')::numeric;
    select d.round_trip_miles::numeric into v_miles from public.deals d where d.id = p_deal_id;
    if v_subtotal > 0 and v_miles > 0 then
      cap_cents_per_mile := round(round(v_subtotal * 100 / v_miles * 2) / 2, 2);
      basis := 'quote_derived';
      return;
    end if;
  end if;

  basis := 'no_rate_on_quote';
end;
$$;

-- ---------- 2. for the app ----------------------------------------------------------
create or replace function public.event_mileage_caps(p_deal_ids bigint[])
returns table (deal_id bigint, cap_cents_per_mile numeric, basis text)
language sql
stable
security invoker set search_path = public
as $$
  select x.id, c.cap_cents_per_mile, c.basis
    from (select distinct u.id from unnest(coalesce(p_deal_ids, '{}'::bigint[])) as u(id) where u.id is not null) x
    cross join lateral public.deal_mileage_cap(x.id) c;
$$;

revoke execute on function public.deal_mileage_cap(bigint) from public, anon;
revoke execute on function public.event_mileage_caps(bigint[]) from public, anon;
grant execute on function public.deal_mileage_cap(bigint) to authenticated, service_role;
grant execute on function public.event_mileage_caps(bigint[]) to authenticated, service_role;

-- ---------- 3. the payable view -------------------------------------------------------
-- Migration 42's view with the rate chosen per trip. Mileage is miles x that
-- rate, half-up to the cent, unless an Adjustment replaced it; null when no
-- IRS rate covers the trip date.
create or replace view public.travel_reimbursements_payable as
select r.id,
       r.profile_id,
       p.qbo_employee_id,
       p.full_name,
       r.trip_date,
       r.miles,
       pay.cents_per_mile,
       coalesce(r.mileage_cents_override, round(r.miles * pay.cents_per_mile)::integer) as mileage_cents,
       r.tolls_cents,
       r.parking_cents,
       coalesce(r.mileage_cents_override, round(r.miles * pay.cents_per_mile)::integer)
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
  ) irs on true
  left join lateral (
    select c.cap_cents_per_mile
      from public.deal_mileage_cap(r.deal_id) c
     where r.reason_kind = 'catering_event'
  ) cap on true
  cross join lateral (
    select (case
              when cap.cap_cents_per_mile is not null and irs.cents_per_mile is not null
              then least(irs.cents_per_mile, cap.cap_cents_per_mile)
              else irs.cents_per_mile
            end)::numeric(6, 2) as cents_per_mile
  ) pay
 where r.status = 'approved'
   and not (p.role in ('manager', 'owner') and p.active = false);

revoke all on public.travel_reimbursements_payable from public, anon, authenticated;

commit;
