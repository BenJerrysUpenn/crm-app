-- ============================================================================
-- Withers Time, rollback for migration 38 (one shift summary a day).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: shifts saved since the last 8pm summary that are still queued
-- (their people will not get that summary), and the record of which summaries
-- were sent. Roll the app back first: with this table gone, a shift save
-- still writes the bell row but its queue insert fails (logged, not fatal).
-- ============================================================================

begin;

drop function if exists public.claim_shift_digests(date);
drop table if exists public.shift_digests;
drop table if exists public.shift_notices;

commit;
