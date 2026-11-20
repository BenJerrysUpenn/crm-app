-- ============================================================================
-- Withers CRM — rollback for migration crm/013 (shared sequence storage)
--
-- DATA LOST: every saved sequence, lane signature/footer and conflict copy.
-- The page falls back to the seeds in lib/emailCampaignsPrototype/sequences.ts.
-- Browsers that uploaded their old localStorage copies still hold them (the
-- page never deletes those keys), but anything written only to the shared
-- copy is gone. Export first if any of it matters:
--   COPY (SELECT * FROM public.email_campaign_sequences) TO STDOUT WITH CSV HEADER;
--
-- Deploy the crm-app commit that no longer reads these tables first, or the
-- page says edits cannot be saved.
--
-- Run in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/013_email_campaign_sequences_down.sql
-- Safe to re-run.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS public.email_campaign_sequence_conflicts;
DROP TABLE IF EXISTS public.email_campaign_lane_blocks;
DROP TABLE IF EXISTS public.email_campaign_sequences;

COMMIT;
