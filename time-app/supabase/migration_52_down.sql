-- ============================================================================
-- Withers Time, rollback for migration 52 (a quote that charged $0 mileage
-- caps at 0c even when it stores a per-mile rate).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Puts back migration 50's deal_mileage_cap() exactly; the view and
-- event_mileage_caps() call it and are not touched.
--
-- PAY CHANGES: every unpaid Catering Event trip whose latest quote charged $0
-- mileage but stores a per-mile rate (mileage_rate, or the May 2026
-- transport_breakdown.rate_per_mile) is capped at that rate again
-- ('quoted_rate', 76c for a quote that stored the November 2026 IRS rate)
-- instead of 0c. Every other trip is priced the same either way. Nothing is
-- lost: migration 52 stores no data. The app needs no rollback: it reads
-- whatever caps the database answers.
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
