-- ============================================================================
-- Withers Time — migration 10
-- Extend shift_requests.type to include 'pickup' so employees must go through
-- a manager-approved request to claim an open shift. Prior state: type CHECK
-- only allowed 'drop'.
-- Per Alina 2026-08-27: "People shouldn't be able to pick up open shifts.
-- They can request for a manager to add them."
-- ============================================================================
alter table public.shift_requests
  drop constraint if exists shift_requests_type_check;

alter table public.shift_requests
  add constraint shift_requests_type_check
  check (type in ('drop','pickup'));
