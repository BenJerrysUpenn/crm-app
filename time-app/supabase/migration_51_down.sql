-- ============================================================================
-- Withers Time, rollback for migration 51 (cash count reminders in Slack).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Drops cash_count_reminders. What is lost: the record of which reminders and
-- follow-ups went out. Slack keeps the messages themselves. With the table
-- gone the bj-box job posts nothing and exits 1; the app needs no rollback.
-- Dropping it on a day a reminder already went out and then re-applying 51
-- the same day would let that day's reminder post again.
-- ============================================================================

begin;

drop table if exists public.cash_count_reminders;

commit;
