-- ============================================================================
-- Withers Time — rollback for migration 27 (payroll choices and submittal)
--
-- DATA LOST:
--   * every row in public.payroll_run_submittals: which pay runs were
--     submitted, by whom, when, and the snapshot of every case's choice at
--     that moment. This is the record that a run was final; after this script
--     nothing in the database says any run was submitted, so nothing stops a
--     submitted period from being submitted again.
--   * every row in public.payroll_rulings: every per-case choice a manager
--     changed from its default (1.9 solo-close nights, 3.5 crewless events,
--     3.7 Olo tips), with who decided and when.
-- Export both first if they may be wanted:
--
--     copy (select * from public.payroll_run_submittals order by window_end) to stdout with csv header;
--     copy (select * from public.payroll_rulings order by id) to stdout with csv header;
--
-- Punches, shifts, profiles and row_audit are not touched.
--
-- ORDER. Run this before migration_26_down.sql and migration_25_down.sql, in
-- the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

-- The submittal guard refuses every UPDATE and DELETE on a submitted run, and
-- a dropped table's rows are not deleted row by row, but disable it first
-- anyway: nothing below should ever meet it.
do $$
begin
  if to_regclass('public.payroll_run_submittals') is not null then
    alter table public.payroll_run_submittals disable trigger payroll_run_submittals_guard;
  end if;
end $$;

drop trigger if exists payroll_run_submittals_guard on public.payroll_run_submittals;
drop trigger if exists payroll_rulings_lock on public.payroll_rulings;

-- Policies, CHECK constraints and indexes go with their tables.
drop table if exists public.payroll_run_submittals;
drop table if exists public.payroll_rulings;

drop function if exists public.guard_payroll_run_submittal();
drop function if exists public.guard_payroll_ruling();
drop function if exists public.payroll_punch_blockers(date);
drop function if exists public.payroll_submitted_window_for(date);
drop function if exists public.payroll_case_date(text, text);

commit;
