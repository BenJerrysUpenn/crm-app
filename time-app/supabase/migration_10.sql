-- ============================================================================
-- Withers Time — migration 10
-- Run once in the Supabase SQL editor, after migration_9.sql.
-- Per-user notification preferences (channels + which alerts to receive).
-- Empty object = receive everything (opt-out model).
-- ============================================================================
alter table public.profiles add column if not exists notif_prefs jsonb not null default '{}'::jsonb;
