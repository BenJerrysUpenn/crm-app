-- ============================================================================
-- Withers Time — migration 9
-- Run once in the Supabase SQL editor, after migration_8.sql.
-- Ties multi-day time-off requests together so a range can be approved/deleted
-- as one unit (each day is still its own row for scheduling logic).
-- ============================================================================
alter table public.availability add column if not exists request_group uuid;
create index if not exists availability_group_idx on public.availability (request_group);
