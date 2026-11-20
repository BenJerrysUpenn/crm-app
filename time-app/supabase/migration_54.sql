-- ============================================================================
-- Withers Time, migration 54: cake order packing reminders in Slack
-- #cake-orders-and-ideas
-- Run once in the Supabase SQL editor, after migration_53.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_54_verify.sql. ROLLBACK. supabase/migration_54_down.sql.
--
-- APPLY ORDER. Either order is safe.
--   * New code, old database: the bj-box job finds no cake_order_reminders
--     table, posts nothing and exits 1 saying so.
--   * Old code, new database: the table sits empty.
--
-- WHY (the owner, 2026-11-03, crm-app #142). Cake orders come in through Olo
-- and pop up on the store tablet; staff write the cake on the wall and are
-- meant to pack it, and the packing gets missed. Olo sends a copy of every
-- order by email. A 5-minute job on bj-box reads that email, @mentions everyone
-- on a store punch in #cake-orders-and-ideas to pack the cake, and replies
-- once in the post's thread if it is not marked packed 60 minutes later
-- (lib/cakeOrders, scripts/cake-order-reminders.ts at the crm-app root).
--
-- WHAT THIS ADDS. cake_order_reminders: one row per Olo order. The unique
-- order_key is what makes it one post per order: the job inserts the row
-- BEFORE it posts, so a second tick, or two ticks at once, find the row (or
-- hit 23505) and post nothing. An order held because nobody is clocked in has
-- no row yet; the email is still in the mailbox and the next tick looks again.
-- The follow-up is claimed by an update guarded on followup_outcome being
-- null, so it is decided once:
--   'sending'     claimed, the Slack reply is in flight
--   'sent'        the thread reply was posted
--   'not_needed'  the order was marked packed (packed_how says how)
--   'expired'     the job did not run between 60 and 180 minutes after the
--                 post (machine off), so it is too late to nudge
--   'failed'      the Slack call failed without saying whether it posted;
--                 never retried, so it cannot post twice
-- Rows older than 60 days are pruned by the job.
--
-- No customer details are stored: the post itself in Slack carries them.
--
-- WHO MAY TOUCH IT. The job's direct Postgres connection (the bootstrap
-- DSN) and the service role. RLS is on and there are no policies; anon and
-- authenticated also lose the table privileges.
-- ============================================================================

begin;

create table if not exists public.cake_order_reminders (
  id               bigint generated always as identity primary key,
  -- The order's own id from the Olo email (lib/cakeOrders/oloEmail.ts).
  order_key        text        not null,
  -- The email's Message-ID header, to find the email again.
  message_id       text        not null,
  -- When the mailbox received the email (IMAP INTERNALDATE).
  received_at      timestamptz not null,
  -- The pickup time, when the email gives one as an instant.
  pickup_at        timestamptz,
  -- Who was mentioned (profiles.id) and their Slack user ids, same order.
  -- A Slack id is '' when the person could not be matched to a Slack user.
  profile_ids      uuid[]      not null,
  slack_user_ids   text[]      not null,
  channel_id       text        not null,
  -- Slack's ts for the post, once posted. Null while posting, or when Slack
  -- did not answer and it is unknown whether it posted.
  post_ts          text,
  -- 'ai' (written by Claude) or 'fallback' (the plain message).
  post_source      text,
  claimed_at       timestamptz not null default now(),
  posted_at        timestamptz,
  followup_outcome text,
  -- How it was marked packed: 'reaction' on the post, 'reply' in its thread,
  -- or 'channel_message' from someone the post mentioned.
  packed_how       text,
  followup_ts      text,
  followup_source  text,
  followup_at      timestamptz,
  constraint cake_order_reminders_order_key unique (order_key)
);

alter table public.cake_order_reminders drop constraint if exists cake_order_reminders_source_check;
alter table public.cake_order_reminders add constraint cake_order_reminders_source_check
  check ((post_source is null or post_source in ('ai', 'fallback'))
         and (followup_source is null or followup_source in ('ai', 'fallback')));
alter table public.cake_order_reminders drop constraint if exists cake_order_reminders_followup_check;
alter table public.cake_order_reminders add constraint cake_order_reminders_followup_check
  check (followup_outcome is null or followup_outcome in ('sending', 'sent', 'not_needed', 'expired', 'failed'));
alter table public.cake_order_reminders drop constraint if exists cake_order_reminders_packed_check;
alter table public.cake_order_reminders add constraint cake_order_reminders_packed_check
  check (packed_how is null or (packed_how in ('reaction', 'reply', 'channel_message') and followup_outcome = 'not_needed'));
alter table public.cake_order_reminders drop constraint if exists cake_order_reminders_people_check;
alter table public.cake_order_reminders add constraint cake_order_reminders_people_check
  check (cardinality(profile_ids) >= 1 and cardinality(profile_ids) = cardinality(slack_user_ids));

alter table public.cake_order_reminders enable row level security;
revoke all on public.cake_order_reminders from anon, authenticated;

commit;
