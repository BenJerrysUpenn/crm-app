-- ============================================================================
-- Withers Time, rollback for migration 34 (staff cannot claim a catering
-- shift)
--
-- Removes the trigger and its function. A signed-in employee can then again
-- set themselves on an open catering shift through /rest/v1/shifts; the time
-- app's own routes still refuse it (lib/managerAssigns.ts).
--
-- DATA LOST: none. Only one trigger and one function are dropped.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

drop trigger if exists shifts_catering_assign_guard on public.shifts;
drop function if exists public.guard_catering_shift_claim();

commit;
