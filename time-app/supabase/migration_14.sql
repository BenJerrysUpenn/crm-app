-- ============================================================================
-- Withers Time — migration 14
-- Run once in the Supabase SQL editor, after migration_13.sql.
-- Availability preference levels (available / preferred / unavailable).
-- ============================================================================
alter table public.availability
  add column if not exists preference text not null default 'available'
  check (preference in ('available','preferred','unavailable'));
