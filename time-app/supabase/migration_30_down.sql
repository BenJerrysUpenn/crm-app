-- ============================================================================
-- Withers Time, rollback for migration 30 (staff punch writes, shift claim)
--
-- Puts time_insert and time_update back to their migration.sql bodies, so an
-- employee can again insert and update their OWN time entries through RLS,
-- and removes the shift-claim guard, so a claim can again change any column
-- of the shift it claims. Both holes (audit H1 and M2) reopen.
--
-- The new app code keeps working after this rollback: it writes punches with
-- the service role, which never depended on these policies. There is no need
-- to roll the code back with it.
--
-- DATA LOST: none. Only policies, one trigger and one function change.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================================

begin;

drop policy if exists time_insert on public.time_entries;
create policy time_insert on public.time_entries for insert to authenticated
  with check (employee_id = auth.uid() or public.is_manager());

drop policy if exists time_update on public.time_entries;
create policy time_update on public.time_entries for update to authenticated
  using (employee_id = auth.uid() or public.is_manager())
  with check (employee_id = auth.uid() or public.is_manager());

drop trigger if exists shifts_claim_guard on public.shifts;
drop function if exists public.guard_shift_claim();

commit;
