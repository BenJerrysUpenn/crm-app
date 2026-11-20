-- ============================================================================
-- Withers CRM — migration crm/012: the winter menu's three Price Book extras
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/012_winter_menu_extras.sql
-- then check it with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/012_winter_menu_extras_verify.sql
-- Undo: supabase/crm/012_winter_menu_extras_down.sql.
-- Idempotent: safe to re-run. A re-run never overwrites a row, so an edit
-- made later in the Price Book survives it.
--
-- Numbered 012 because open crm-app PR #78 already claims 011.
--
-- THE PRODUCT (Alina, 2026-10-15 grilling, bj-finance #717)
-- ---------------------------------------------------------
-- The winter menu (Nov 1 - Mar 31) adds NO package. Each winter item is an
-- existing package plus extras, and the deal's custom menu line is what the
-- quote prints (Catering-Manager migration 026 adds that column and the
-- stored per-guest price override):
--
--   Warmed Cookie and Brownie Sundaes  Cup or Cone Party + Cookies on half
--                                      the guests + Brownies on the other half
--   Waffle Sundae                      Cup or Cone Party + Belgian Waffle
--   Hot Chocolate Float                Hot Chocolate Float Party (crm/008)
--   Winter toppings                    Winter Dry Toppings / Winter Pourable
--                                      Toppings; the customer picks 3 per
--                                      group, stored in the deal's toppings
--
-- This file adds the three extras that did not exist. The names are matched
-- byte for byte by Catering-Manager (pricing_data, the quote, the picklist,
-- the Salesforce lines) and by lib/menuOptions.ts here. They must not
-- collide with the $0 "Dry Toppings" / "Extra Toppings" strip-and-flag rows.
--
-- PRICE BOOK ROWS: WHERE EACH VALUE CAME FROM
-- -------------------------------------------
--   Belgian Waffle            $3.00 per_serving   Alina
--   Winter Dry Toppings       $2.00 per_serving   Alina
--   Winter Pourable Toppings  $2.00 per_serving   Alina
--   taxable           true    menu items + extras are taxed (Alina,
--                             2026-10-05); every food extra row says true
--   duplicate_with    NULL    no package includes any of the three
--   sort_order        13-15   after Umbrella Rental (12), so they list last
-- ============================================================================

BEGIN;

INSERT INTO public.pricing_extras
  (name, price, per_serving_or_flat, taxable, duplicate_with, notes, sort_order)
VALUES
  ('Belgian Waffle', 3.00, 'per_serving', true, NULL,
   'Winter menu (Nov 1 - Mar 31). $3/guest. The Waffle Sundae is Cup or Cone Party + this.', 13),
  ('Winter Dry Toppings', 2.00, 'per_serving', true, NULL,
   'Winter menu (Nov 1 - Mar 31). $2/guest. The customer picks 3 of the winter dry toppings.', 14),
  ('Winter Pourable Toppings', 2.00, 'per_serving', true, NULL,
   'Winter menu (Nov 1 - Mar 31). $2/guest. The customer picks 3 of the winter pourable toppings.', 15)
ON CONFLICT (name) DO NOTHING;

COMMIT;
