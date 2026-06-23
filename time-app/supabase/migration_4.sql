-- ============================================================================
-- Withers Time — migration 4
-- Run once in the Supabase SQL editor, after migration_3.sql.
-- Lets an employee claim an open (unassigned), published shift for themselves.
-- ============================================================================
drop policy if exists shifts_claim on public.shifts;
create policy shifts_claim on public.shifts for update to authenticated
  using (employee_id is null and published)
  with check (employee_id = auth.uid());
