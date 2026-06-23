-- ============================================================================
-- Withers Time — migration 2
-- Run once in the Supabase SQL editor, after migration.sql.
-- Adds: open (unassigned) shifts, and approval status on availability/time-off.
-- ============================================================================

-- Shifts can exist without an assigned employee (open shifts).
alter table public.shifts alter column employee_id drop not null;

-- Approval status for availability rows. Painted availability is auto 'approved';
-- time-off requests start 'pending' and a manager approves/denies.
alter table public.availability
  add column if not exists status text not null default 'approved'
  check (status in ('pending','approved','denied'));
