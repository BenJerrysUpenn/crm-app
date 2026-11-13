-- ============================================================================
-- Withers Time, migration 57: metrics_snapshots takes kind 'sales_lanes'
-- Run once in the Supabase SQL editor, after migration_40.sql and after the
-- app that ships this file deploys green on main. Safe to re-run.
--
-- VERIFY. supabase/migration_57_verify.sql. ROLLBACK. supabase/migration_57_down.sql.
--
-- WHY (Alina, 2026-11-13). The cold outreach lane sent nothing for three
-- weeks and nobody saw it. bj-finance now builds the sales lane numbers once
-- a day (emails sent against each lane's daily target, opens, replies, deals,
-- bookings, new and repeat customers, spend, mailbox health, offers, alerts)
-- and publishes them here, where the email campaigns console reads the
-- newest row. Until now the kind check let only 'daily' and 'closed_month'
-- in, so the publisher's insert was refused.
--
-- WHAT THIS CHANGES
--   metrics_snapshots_kind_check: kind in ('daily', 'closed_month', 'sales_lanes').
--     kind 'sales_lanes'  period = the business day the numbers run through.
--                         payload carries "schema" like every other kind
--                         (the payload_object check is unchanged).
--   Nothing else: the same publisher-only writes (service role or the Mac's
--   own connection), manager-only reads, and every publish kept as published
--   by the guard trigger, apply to the new kind as they do to the others.
-- ============================================================================

begin;

alter table public.metrics_snapshots drop constraint if exists metrics_snapshots_kind_check;
alter table public.metrics_snapshots add constraint metrics_snapshots_kind_check
  check (kind in ('daily', 'closed_month', 'sales_lanes'));

commit;
