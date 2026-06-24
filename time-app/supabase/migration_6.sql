-- ============================================================================
-- Withers Time — migration 6
-- Run once in the Supabase SQL editor, after migration_5.sql.
-- Shift acknowledgement: employees confirm they've seen a published shift.
-- ============================================================================
alter table public.shifts add column if not exists acknowledged_at timestamptz;
