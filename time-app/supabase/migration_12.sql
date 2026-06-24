-- ============================================================================
-- Withers Time — migration 12
-- Run once in the Supabase SQL editor, after migration_11.sql.
-- Manager manual time-entry overrides: a "manual" flag + delete permission.
-- ============================================================================
alter table public.time_entries add column if not exists manual boolean not null default false;

-- Managers can delete time entries (employees cannot).
drop policy if exists time_delete on public.time_entries;
create policy time_delete on public.time_entries for delete to authenticated
  using (public.is_manager());
