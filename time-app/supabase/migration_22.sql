-- ============================================================================
-- Withers Time — migration 22: Marketing shift type
-- Run once in the Supabase SQL editor, after migration_21.sql. Safe to re-run.
--
-- Marketing covers marketing events and marketing work (tabling, samplings,
-- campus activations, content days). It is scheduled like any other shift so
-- the hours land in timesheets, but for payroll it is NOT in-store work: like
-- Catering, a Marketing shift never shares the in-store tip pool.
--
-- That classification lives in the payroll process, not in this app — the app
-- only needs the type to exist so managers can put it on the schedule and the
-- hours carry the label through to the timesheet.
--
-- The row already exists in production (added by hand on 2026-09-15); this
-- migration is how every other environment gets it. Guarded on the name, so
-- re-running it, or running it against prod, changes nothing.
--
-- No schema changes, no RLS changes.
-- ============================================================================

insert into public.shift_types (name, color, sort_order)
select 'Marketing', '#0ea5e9', 8
where not exists (
  select 1 from public.shift_types where name = 'Marketing'
);
