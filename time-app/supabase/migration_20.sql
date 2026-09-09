-- ============================================================================
-- Withers Time — migration 20: clock-out reminders
-- Run once in the Supabase SQL editor, after migration_19.sql.
--
-- If someone is still clocked in a while after their shift was due to end,
-- the app nudges them to clock out: a notification from the existing cron,
-- and an amber banner above the clock card next time they open the app.
--
-- The nudge is snoozeable and dismissable, so the three columns below track
-- where each open entry stands:
--   clockout_reminder_sent_at        the last time this person was notified
--                                    about this entry (null = never yet)
--   clockout_reminder_snoozed_until  suppress the reminder until this time;
--                                    once it passes they get notified once more
--   clockout_reminder_dismissed_at   they said "I know" — never remind again
--                                    for this entry
-- All three live on the entry, not the shift, so the Raspberry Pi fob clock's
-- rows behave exactly like ones punched in the web app.
-- ============================================================================

alter table public.app_settings
  add column if not exists clockout_reminder_after_min integer not null default 30;

alter table public.time_entries
  add column if not exists clockout_reminder_sent_at timestamptz,
  add column if not exists clockout_reminder_snoozed_until timestamptz,
  add column if not exists clockout_reminder_dismissed_at timestamptz;
