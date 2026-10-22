-- ============================================================================
-- Withers CRM — verification for migration crm/012 (winter menu extras)
--
-- Run by hand against a database with 012_winter_menu_extras.sql applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/012_winter_menu_extras_verify.sql
-- Read-only: one transaction that ends in ROLLBACK. A clean run ends with
-- "migration crm/012 verified".
--
-- WHAT IS CHECKED
--   1. Each of the three rows exists, per guest, taxable, duplicating no
--      package content, at Alina's price: Belgian Waffle $3.00, Winter Dry
--      Toppings $2.00, Winter Pourable Toppings $2.00.
--   2. The $0 "Dry Toppings" and "Extra Toppings" strip-and-flag rows are
--      still there at $0: the new names sit beside them, not over them.
-- ============================================================================

begin;

do $$
declare
  r record;
  want record;
begin
  for want in
    select * from (values
      ('Belgian Waffle', 3.00),
      ('Winter Dry Toppings', 2.00),
      ('Winter Pourable Toppings', 2.00)
    ) as w(name, price)
  loop
    select * into r from public.pricing_extras where name = want.name;
    if not found then raise exception 'pricing_extras has no % row', want.name; end if;
    if r.price <> want.price then
      raise exception '% price is %, expected %', want.name, r.price, want.price;
    end if;
    if r.per_serving_or_flat <> 'per_serving' then
      raise exception '% is %, expected per_serving', want.name, r.per_serving_or_flat;
    end if;
    if not r.taxable then raise exception '% must be taxable', want.name; end if;
    if r.duplicate_with is not null then
      raise exception '% must duplicate no package content, has %', want.name, r.duplicate_with;
    end if;
  end loop;

  for want in
    select * from (values ('Dry Toppings', 0.00), ('Extra Toppings', 0.00)) as w(name, price)
  loop
    select * into r from public.pricing_extras where name = want.name;
    if not found then raise exception 'pricing_extras lost its % row', want.name; end if;
    if r.price <> want.price then
      raise exception '% price is %, expected % (strip-and-flag alias)', want.name, r.price, want.price;
    end if;
  end loop;

  raise notice 'migration crm/012 verified';
end $$;

rollback;
