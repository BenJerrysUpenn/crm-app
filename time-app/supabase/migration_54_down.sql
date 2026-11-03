-- ============================================================================
-- Withers Time, rollback for migration 54 (cake order packing reminders).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Drops cake_order_reminders. What is lost: the record of which orders were
-- posted and followed up. Slack keeps the messages themselves. With the table
-- gone the bj-box job posts nothing and exits 1; the app needs no rollback.
-- Dropping it and then re-applying 54 while an order's email is still within
-- the job's two-day mailbox window would let that order post again.
-- ============================================================================

begin;

drop table if exists public.cake_order_reminders;

commit;
