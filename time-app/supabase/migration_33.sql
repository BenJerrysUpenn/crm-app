-- ============================================================================
-- Withers Time, migration 33: no more draft shifts
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- VERIFY. supabase/migration_33_verify.sql. ROLLBACK. supabase/migration_33_down.sql.
--
-- WHY. The schedule had a draft step: a shift was saved with published = false,
-- which RLS shows to managers only, and went live when a manager pressed
-- "Publish week". Managers filled in the week, saw it on their own screen and
-- took it as live, so staff never saw those shifts. The app no longer has a
-- publish step: every create, edit, copy-week and catering auto-shift writes
-- published = true (crm-app PR "Schedule: no drafts").
--
-- WHAT THIS DOES
--   1. Publishes every draft shift that has not finished yet. Those were meant
--      to be live. A draft that already ended is left alone: flipping it now
--      would put a shift nobody was told about into attendance and the missed
--      clock-in report as a no-show.
--   2. Defaults published to true, so a writer that leaves the column out can
--      never create a hidden shift again.
--
-- WHAT THIS DOES NOT DO. No rows are deleted. The column stays: the Pi
-- (withers-timeclock listener.py), clock-in, attendance, missed clock-ins,
-- availability locking, the clock-out reminder and the Catering-Manager
-- staffing report all read published = true, and every row they should see
-- now has it. RLS is unchanged: shifts_select, shifts_claim and
-- shifts_manager_all keep their published predicates, which every live row
-- now passes.
--
-- APPLY ORDER. After the code is live on main (Vercel `time` and `crm-app`),
-- so no old code path writes a new draft after the flip. Re-running is
-- harmless: it publishes any draft written since.
-- ============================================================================

begin;

update public.shifts
   set published = true,
       updated_at = now()
 where published = false
   and ends_at > now();

alter table public.shifts alter column published set default true;

commit;
