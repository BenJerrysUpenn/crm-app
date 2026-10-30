-- ============================================================================
-- Withers Time, migration 51: cash count reminders in Slack #cash-count
-- Run once in the Supabase SQL editor, after migration_50.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_51_verify.sql. ROLLBACK. supabase/migration_51_down.sql.
--
-- APPLY ORDER. Either order is safe.
--   * New code, old database: the cron finds no cash_count_reminders table,
--     posts nothing and says so in its JSON ("not_migrated").
--   * Old code, new database: the table sits empty.
--
-- WHY (the owner, 2026-10-29). Staff post the opening and closing cash counts
-- in the public Slack channel #cash-count. The 5-minute cron reminds the
-- opener after they clock in and the closer just after closing, and reminds
-- them once more if nobody has posted 30 minutes later (lib/cashCount).
--
-- WHAT THIS ADDS. cash_count_reminders: one row per New York store day per
-- kind ('open' or 'close'). The unique (store_date, kind) is what makes it one
-- reminder a day each: the cron inserts the row BEFORE it posts, so a second
-- tick, or two ticks at once, find the row (or hit 23505) and post nothing.
-- The follow-up is claimed by an update guarded on followup_outcome being
-- null, so it is decided once:
--   'sending'     claimed, the Slack post is in flight
--   'sent'        the follow-up was posted
--   'not_needed'  someone posted in the channel or the reminder's thread
--   'expired'     the cron did not run between 30 and 120 minutes after the
--                 reminder (machine off), so it is too late to nudge
--   'failed'      the Slack call failed without saying whether it posted;
--                 never retried, so it cannot post twice
-- Rows older than 60 days are pruned by the cron.
--
-- WHO MAY TOUCH IT. The service role alone. RLS is on and there are no
-- policies; anon and authenticated also lose the table privileges.
-- ============================================================================

begin;

create table if not exists public.cash_count_reminders (
  id               bigint generated always as identity primary key,
  -- The New York day the store opened or closed on.
  store_date       date        not null,
  kind             text        not null,
  -- Who was mentioned (profiles.id) and their Slack user ids, same order.
  -- A Slack id is '' when the person could not be matched to a Slack user.
  profile_ids      uuid[]      not null,
  slack_user_ids   text[]      not null,
  channel_id       text        not null,
  -- Slack's ts for the reminder, once posted. Null while posting, or when
  -- Slack did not answer and it is unknown whether it posted.
  reminder_ts      text,
  -- 'ai' (written by Claude) or 'fallback' (the plain message).
  reminder_source  text,
  claimed_at       timestamptz not null default now(),
  posted_at        timestamptz,
  followup_outcome text,
  followup_ts      text,
  followup_source  text,
  followup_at      timestamptz,
  constraint cash_count_reminders_day_kind unique (store_date, kind)
);

alter table public.cash_count_reminders drop constraint if exists cash_count_reminders_kind_check;
alter table public.cash_count_reminders add constraint cash_count_reminders_kind_check
  check (kind in ('open', 'close'));
alter table public.cash_count_reminders drop constraint if exists cash_count_reminders_source_check;
alter table public.cash_count_reminders add constraint cash_count_reminders_source_check
  check ((reminder_source is null or reminder_source in ('ai', 'fallback'))
         and (followup_source is null or followup_source in ('ai', 'fallback')));
alter table public.cash_count_reminders drop constraint if exists cash_count_reminders_followup_check;
alter table public.cash_count_reminders add constraint cash_count_reminders_followup_check
  check (followup_outcome is null or followup_outcome in ('sending', 'sent', 'not_needed', 'expired', 'failed'));
alter table public.cash_count_reminders drop constraint if exists cash_count_reminders_people_check;
alter table public.cash_count_reminders add constraint cash_count_reminders_people_check
  check (cardinality(profile_ids) >= 1 and cardinality(profile_ids) = cardinality(slack_user_ids));

alter table public.cash_count_reminders enable row level security;
revoke all on public.cash_count_reminders from anon, authenticated;

commit;
