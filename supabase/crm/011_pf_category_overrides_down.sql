-- ============================================================================
-- Withers CRM — rollback for migration crm/011 (pf_category_overrides)
--
-- DATA LOST: every category correction made on /money that the 08:00
-- personal bookkeeping pass has not yet folded into the rules doc. Folded
-- merchant corrections survive as rules in the private repo; "just this one"
-- corrections survive in the pass's category ledger once it has run.
--
-- Run in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/011_pf_category_overrides_down.sql
-- Safe to re-run.
-- ============================================================================

BEGIN;
DROP TABLE IF EXISTS public.pf_category_overrides;
COMMIT;
