-- ============================================================================
-- Withers Time, rollback for migration 32 (profiles.archived_at)
--
-- DATA LOST: who is archived and when. Nobody is un-archived from the
-- schedule by this: Archive also set active = false, and that stays.
-- After this runs the Team page shows everyone in the table again and answers
-- Archive/Unarchive with "needs migration 32".
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

alter table public.profiles drop column if exists archived_at;
