-- ============================================================================
-- Withers Time, rollback for migration 33 (no more draft shifts)
--
-- Restores the column default to false. It does NOT un-publish the shifts
-- migration 33 published: which rows were drafts is in public.row_audit
-- (the UPDATE rows migration 33 wrote, before_image ->> 'published' = 'false')
-- if anyone ever needs them, but hiding live shifts from staff again is the
-- bug migration 33 fixed.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

alter table public.shifts alter column published set default false;
