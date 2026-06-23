-- ============================================================================
-- Withers Time — migration 3
-- Run once in the Supabase SQL editor, after migration_2.sql.
-- Lets employees see published OPEN (unassigned) shifts, not just their own.
-- ============================================================================
drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using (
    (((employee_id = auth.uid()) or (employee_id is null)) and published)
    or public.is_manager()
  );
