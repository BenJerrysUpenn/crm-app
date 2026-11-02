-- ============================================================================
-- Withers Time, rollback for migration 50 (a Catering Event whose quote
-- charged no mileage reimburses no mileage).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Puts back migration 49's deal_mileage_cap() exactly; the view and
-- event_mileage_caps() call it and are not touched.
--
-- PAY CHANGES: every unpaid Catering Event trip whose quote charged no
-- mileage ('no_rate_on_quote') or whose deal has no round-trip miles
-- ('no_miles_on_deal') is priced at the IRS rate again, uncapped. A May 2026
-- quote that names the Uber flat fee as transport_mode is the IRS rate either
-- way; one that stored its rate in transport_breakdown goes from that rate to
-- the IRS rate. Nothing is lost: migration 50 stores no data. The app needs
-- no rollback: it reads whatever caps the database answers.
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

revoke execute on function public.deal_mileage_cap(bigint) from public, anon;
grant execute on function public.deal_mileage_cap(bigint) to authenticated, service_role;

commit;
