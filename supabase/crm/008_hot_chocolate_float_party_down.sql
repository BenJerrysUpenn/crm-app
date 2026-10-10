-- ============================================================================
-- Withers CRM — rollback for migration crm/008 (Hot Chocolate Float Party)
--
-- Refuses to run while any deal holds the package: narrowing the CHECK would
-- fail on those rows anyway, and deleting the Price Book row under a live
-- deal would leave the quote engine unable to price it. Move those deals to
-- another package first.
--
-- DATA LOST: the package's Price Book row, including any edit made to it in
-- the Price Book since crm/008 was applied.
--
-- Run in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/008_hot_chocolate_float_party_down.sql
-- Safe to re-run.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.deals
   WHERE package_name = 'Hot Chocolate Float Party';
  IF n > 0 THEN
    RAISE EXCEPTION '% deal(s) use Hot Chocolate Float Party; move them to another package before rolling back crm/008', n;
  END IF;
END $$;

DELETE FROM public.pricing_packages WHERE name = 'Hot Chocolate Float Party';

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
    'DIY Sundae Upgrade'
  ));

COMMIT;
