-- ============================================================================
-- Withers Time, migration 53: the QBO submit chain records what it did on the
-- pay run's submittal
-- Run once in the Supabase SQL editor, after migration_52.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_53_verify.sql. ROLLBACK. supabase/migration_53_down.sql.
--
-- WHY (the owner, 2026-11-02, bj-finance #213): "I need to press the submit
-- button and have it submit payroll through QBO and email the paystubs to the
-- printer and save the paystubs to the drive." bj-finance
-- modules/qbo_payroll_submit.py does that on the Mac, from the row the payroll
-- page's Submit writes. Migration 27 let that row hold one status,
-- 'submitted_pending_stage', and left this door for the staging script's own
-- migration: "Its own migration widens payroll_run_submittals_status_check with
-- the states it moves a row through, and guard_payroll_run_submittal() already
-- lets `status` alone change."
--
-- WHAT THIS CHANGES. payroll_run_submittals only:
--   * status may also be
--       'qbo_previewed'        staged, Preview matched, waiting on a person to
--                              press Submit in QBO (the chain's switch is off);
--       'qbo_submitted'        QBO's Paycheck list shows the run;
--       'qbo_outcome_unknown'  Submit was pressed and QBO did not confirm it:
--                              a person checks QBO before anything else;
--       'qbo_stopped'          the chain stopped before Submit; nothing sent;
--       'qbo_paystubs_sent'    paystubs saved to the Drive and sent to print.
--   * two new columns, qbo_outcome (what happened, in words) and
--     qbo_outcome_at (when the chain wrote it). Neither names a person or pay.
--   * one more trigger: once a row reads 'qbo_submitted' it may only stay or
--     move to 'qbo_paystubs_sent', 'qbo_paystubs_sent' never moves, and no
--     qbo_ status goes back to 'submitted_pending_stage'. The Mac's own record is
--     the never-submit-twice authority; this keeps the database from ever
--     saying a paid run is waiting to be paid.
-- guard_payroll_run_submittal() is not redefined: everything that says what
-- was submitted, by whom and when stays frozen, and the new columns are not
-- among those it freezes. Managers still have no UPDATE policy; the chain
-- writes with the Mac's DSN.
--
-- APPLY ORDER. Either order with the bj-finance PR. Until this is applied the
-- chain writes nothing to the row and says so; once applied, it writes.
-- ============================================================================

alter table public.payroll_run_submittals
  add column if not exists qbo_outcome text,
  add column if not exists qbo_outcome_at timestamptz;

alter table public.payroll_run_submittals
  drop constraint if exists payroll_run_submittals_status_check;
alter table public.payroll_run_submittals
  add constraint payroll_run_submittals_status_check
  check (status in ('submitted_pending_stage', 'qbo_previewed', 'qbo_submitted',
                    'qbo_outcome_unknown', 'qbo_stopped', 'qbo_paystubs_sent'));

create or replace function public.guard_payroll_run_submittal_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status = 'qbo_paystubs_sent'
     or (old.status = 'qbo_submitted' and new.status <> 'qbo_paystubs_sent')
     or (old.status like 'qbo\_%' and new.status = 'submitted_pending_stage') then
    raise exception 'The pay run ending % reads %; it cannot move to %.',
      old.window_end, old.status, new.status;
  end if;
  return new;
end;
$$;

drop trigger if exists payroll_run_submittals_status_guard on public.payroll_run_submittals;
create trigger payroll_run_submittals_status_guard
  before update of status on public.payroll_run_submittals
  for each row execute function public.guard_payroll_run_submittal_status();

revoke execute on function public.guard_payroll_run_submittal_status()
  from public, anon, authenticated, service_role;
