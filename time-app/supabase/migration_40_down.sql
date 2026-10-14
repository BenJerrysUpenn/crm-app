-- ============================================================================
-- Withers Time, rollback for migration 40 (the Metrics finance feed).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every published metrics snapshot (cash, sales, wages and
-- closed-month history as the feed sent it). The feed can republish closed
-- months; daily cash history before today cannot be rebuilt from the page.
-- Turn the publisher off first (BJ_METRICS_PUBLISH=0 for the bj-finance
-- runner): with the table gone it publishes nothing and says nothing, the
-- same as before migration 40 was applied, so the page would simply stop
-- updating.
-- ============================================================================

begin;

drop table if exists public.metrics_snapshots;
drop function if exists public.guard_metrics_snapshot();

commit;
