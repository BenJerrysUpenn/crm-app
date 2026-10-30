-- ============================================================================
-- Withers Time, migration 52: a quote that charged $0 mileage caps at 0c even
-- when it stores a per-mile rate
-- Run once in the Supabase SQL editor, after migration_51.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_52_verify.sql. ROLLBACK. supabase/migration_52_down.sql.
--
-- APPLY ORDER. Either order is safe. The app reads whatever cap and basis the
-- database answers, and this migration adds no basis: a trip that moves from
-- 'quoted_rate' to 'no_rate_on_quote' shows the $0 wording migration 50 added.
--
-- WHY (ruling 50, bj-finance #210, the owner 2026-10-29). A quote that is not
-- the Uber flat fee and charged $0 mileage charged the customer nothing, so
-- its trips pay 0c a mile. Migration 50 looked for a stored mileage_rate
-- BEFORE it looked at the amount charged. Since Catering-Manager #112 every
-- quote stores mileage_rate, the IRS rate for the event date (0.76 for a
-- November 2026 event), including a mileage quote that charged $0 because the
-- venue is walkable (0 round-trip miles). Catering-Manager #115 pins that
-- shape: transportation_mode 'mileage', mileage_rate 0.76,
-- transportation_subtotal 0.0. Migration 50 answered 76c 'quoted_rate' for it
-- instead of the ruled 0c 'no_rate_on_quote'.
--
-- WHAT THIS CHANGES. deal_mileage_cap(deal id) only, the order of its checks;
-- event_mileage_caps() and travel_reimbursements_payable call it and are not
-- redefined. The latest quote (quote_versions, highest version) decides, in
-- this order:
--   'no_quote'         no quote, or its breakdown is not a JSON object: no
--                      cap, the IRS rate. Unchanged.
--   'uber_flat_fee'    transportation_mode 'uber' or 'parking', or, when it is
--                      absent, the May 2026 transport_mode. No cap. Unchanged.
--   'no_rate_on_quote' NEW HERE: transportation_subtotal is a JSON number and
--                      is 0: 0c, whatever rate the quote stores. Only when the
--                      key is present and a number, so the May 2026 quotes,
--                      which have no transportation_subtotal, are read as
--                      before.
--   'quoted_rate'      breakdown_json.mileage_rate, or the May 2026
--                      transport_breakdown.rate_per_mile, dollars a mile,
--                      x 100. Unchanged.
--   'quote_derived'    transportation_subtotal > 0 over deals.round_trip_miles
--                      > 0, to the nearest half cent. Unchanged.
--   'no_miles_on_deal' transportation_subtotal > 0, but the deal has no
--                      round-trip miles: 0c. Unchanged.
--   'no_rate_on_quote' any other quote: no mileage line, or a subtotal that is
--                      not a number, and no rate stored: 0c. Unchanged.
--   'none'             no deal: no cap. Unchanged.
--
-- Every reimbursement not yet Paid is priced when it is read (ruling 33), so
-- this reprices the unpaid ones; no reimbursement or rate row is written.
-- Production on 2026-10-29: no latest quote stores mileage_rate yet, so no
-- deal's cap changes. The two $0 mileage quotes (deals 25459, 25376) are
-- older quotes with no stored rate and are 0c either way.
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
  -- The quote charged $0 mileage: 0c, before any stored rate is read (ruling
  -- 50; since Catering-Manager #112 a $0 quote stores the IRS rate too).
  if jsonb_typeof(v_b -> 'transportation_subtotal') = 'number'
     and (v_b ->> 'transportation_subtotal')::numeric = 0 then
    cap_cents_per_mile := 0;
    basis := 'no_rate_on_quote';
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
