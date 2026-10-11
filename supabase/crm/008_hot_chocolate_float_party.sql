-- ============================================================================
-- Withers CRM — migration crm/008: Hot Chocolate Float Party package
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/008_hot_chocolate_float_party.sql
-- then check it with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/008_hot_chocolate_float_party_verify.sql
-- Undo: supabase/crm/008_hot_chocolate_float_party_down.sql.
-- Idempotent: safe to re-run. A re-run never overwrites the Price Book row,
-- so an edit made later in the Price Book survives it.
--
-- THE PRODUCT (Alina, 2026-10-02)
-- -------------------------------
-- "Hot Chocolate Float Party", $8.00 per guest: hot chocolate with one scoop
-- of the guest's choice of flavor on top, whipped cream and chocolate sauce.
-- Upgrades are cookies and brownies only, from the existing pricing_extras
-- rows. The name is matched byte for byte by Catering-Manager (email intake,
-- quote, picklist), so it must not be re-spelled here or there.
--
-- WHAT THIS DOES
-- --------------
-- 1. Widens deals_package_name_check to allow the new name. The other nine
--    names are the live definition as read on 2026-10-02, unchanged and in
--    the same order.
-- 2. Adds the package's Price Book row to pricing_packages, which the Price
--    Book page edits and the Python quote engine and the guided deal form
--    read.
--
-- OWNERSHIP NOTE
-- --------------
-- `deals` is Catering-Manager's table (modules/db.py, migrations/pg_schema.sql
-- line ~186 carries the same CHECK for its test harness). crm/006 left deals
-- schema changes to that repo. This file widens the constraint anyway because
-- the package is being added on both sides at once; if Catering-Manager ships
-- its own widening migration too, the two are interchangeable (same name,
-- same list) and applying both is harmless. Its pg_schema.sql and
-- tests/fixtures/price_book_seed.sql must carry the same values as this file.
--
-- PRICE BOOK ROW: WHERE EACH VALUE CAME FROM
-- ------------------------------------------
--   price                  8.00     Alina
--   includes_sauce         true     Alina (chocolate sauce)
--   includes_whipped_cream true     Alina
--   includes_cookies       false    Alina (cookies are an upgrade, not included)
--   includes_brownies      false    Alina (brownies are an upgrade, not included)
--   includes_waffle_cones  false    Alina (not mentioned; served in a cup)
--   dry_toppings_count     0        Alina (no dry toppings mentioned)
--   flavors_included       3        ASSUMPTION: copied from every other row.
--                                   Each guest picks one scoop from the
--                                   flavors brought; 3 is how many tubs.
--   service_style          sundae   ASSUMPTION: each serving is assembled
--                                   (pour, scoop, whip, sauce) like a sundae,
--                                   so staffing uses the slower sundae
--                                   throughput. 'cup_cone' would staff fewer.
--   sort_order             8        ASSUMPTION: after DIY Sundae Upgrade (7),
--                                   so it lists last.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. deals.package_name may hold the new package
-- ---------------------------------------------------------------------------
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_package_name_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_package_name_check
  CHECK (package_name IS NULL OR package_name IN (
    'Cup or Cone Party',
    'Single Scoop Cup and Cone Party',
    'Waffle Cone Party',
    'Sundae Party',
    'Super Sundae Party',
    'Deluxe Sundae Party',
    'Super Deluxe Sundae Party',
    'DIY Ice Cream Social',
    'DIY Sundae Upgrade',
    'Hot Chocolate Float Party'
  ));

-- ---------------------------------------------------------------------------
-- 2. The Price Book row
-- ---------------------------------------------------------------------------
INSERT INTO public.pricing_packages
  (name, price, flavors_included, includes_waffle_cones, includes_sauce,
   includes_whipped_cream, includes_cookies, includes_brownies,
   dry_toppings_count, service_style, sort_order)
VALUES
  ('Hot Chocolate Float Party', 8.00, 3, false, true,
   true, false, false,
   0, 'sundae', 8)
ON CONFLICT (name) DO NOTHING;

COMMIT;
