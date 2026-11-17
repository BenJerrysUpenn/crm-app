-- ============================================================================
-- Withers Time, rollback for migration 53 (the QBO submit chain's outcome on
-- the submittal)
--
-- DATA LOST: qbo_outcome and qbo_outcome_at on every submittal, and every
-- status the chain wrote. Each row goes back to 'submitted_pending_stage', the
-- only status migration 27 allows, so afterwards nothing in the database says a
-- run was submitted in QBO or that its outcome is unknown. The Mac's record
-- (~/bj-finance-data/payroll/submit/run_<window end>.json) still says it, and it
-- is what stops a second Submit. Export first if the outcomes may be wanted:
--
--     copy (select window_end, status, qbo_outcome, qbo_outcome_at
--             from public.payroll_run_submittals order by window_end) to stdout with csv header;
-- ============================================================================

drop trigger if exists payroll_run_submittals_status_guard on public.payroll_run_submittals;
drop function if exists public.guard_payroll_run_submittal_status();

update public.payroll_run_submittals
   set status = 'submitted_pending_stage'
 where status <> 'submitted_pending_stage';

alter table public.payroll_run_submittals
  drop constraint if exists payroll_run_submittals_status_check;
alter table public.payroll_run_submittals
  add constraint payroll_run_submittals_status_check
  check (status in ('submitted_pending_stage'));

alter table public.payroll_run_submittals
  drop column if exists qbo_outcome,
  drop column if exists qbo_outcome_at;
