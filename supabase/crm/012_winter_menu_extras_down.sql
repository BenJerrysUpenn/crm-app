-- ============================================================================
-- Withers CRM — rollback for migration crm/012 (winter menu extras)
--
-- Refuses to run while any deal carries one of the three extras: deleting
-- the Price Book row under a live deal would make the quote engine treat it
-- as an unknown extra and bill it at $0. Take them off those deals first.
--
-- DATA LOST: the three Price Book rows, including any edit made to them in
-- the Price Book since crm/012 was applied.
--
-- Run in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/012_winter_menu_extras_down.sql
-- Safe to re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.deals
   WHERE extras LIKE '%Belgian Waffle%'
      OR extras LIKE '%Winter Dry Toppings%'
      OR extras LIKE '%Winter Pourable Toppings%';
  IF n > 0 THEN
    RAISE EXCEPTION '% deal(s) carry a winter menu extra; take it off before rolling back crm/012', n;
  END IF;
END $$;

DELETE FROM public.pricing_extras
 WHERE name IN ('Belgian Waffle', 'Winter Dry Toppings', 'Winter Pourable Toppings');

COMMIT;
