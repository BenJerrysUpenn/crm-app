-- ============================================================================
-- Withers Time, rollback for migration 37 (Travel Reimbursements).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every Travel Reimbursement, Adjustment, Lyft ride report and
-- Mileage rate row. Export them first if any are real. Files in the
-- travel-reimbursements Storage bucket are NOT deleted, and the bucket is left
-- in place (Storage refuses to drop a bucket that holds files); only its
-- access policies are dropped, so nobody signed in can read or upload there.
-- ============================================================================

begin;

drop function if exists public.mark_travel_reimbursements_paid(bigint[], date);
drop view if exists public.travel_reimbursements_waiting;
drop view if exists public.travel_reimbursements_payable;
drop table if exists public.travel_reimbursement_adjustments;
drop table if exists public.lyft_ride_reports;
drop table if exists public.travel_reimbursements;
drop function if exists public.guard_travel_reimbursement_adjustment();
drop function if exists public.guard_travel_reimbursement();
drop table if exists public.mileage_rates;

commit;

begin;

drop policy if exists "staff upload their own travel reimbursement files" on storage.objects;
drop policy if exists "approvers upload adjustment evidence" on storage.objects;
drop policy if exists "read own travel reimbursement files or approver reads all" on storage.objects;

commit;
