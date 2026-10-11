-- ============================================================================
-- Withers Time, rollback for migration 40 (the Metrics finance feed).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every published metrics snapshot (cash, sales, wages and
-- closed-month history as the feed sent it). The feed can republish closed
-- months; daily cash history before today cannot be rebuilt from the page.
-- Stop bj-finance modules/metrics_publish.py first; with the table gone it
-- finds nothing to write to and exits quietly.
-- ============================================================================

begin;

drop table if exists public.metrics_snapshots;
drop function if exists public.guard_metrics_snapshot();

commit;
