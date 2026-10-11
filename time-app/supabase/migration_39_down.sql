-- ============================================================================
-- Withers Time, rollback for migration 39 (Metrics saved views and sales targets).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every manager's saved Metrics views and which one they had open,
-- and the sales targets (including any rows added after the seed). Export
-- them first if they matter:
--   copy (select * from public.metric_views) to stdout with csv header;
--   copy (select * from public.sales_targets) to stdout with csv header;
-- The page keeps working without these tables: views fall back to the
-- browser and targets to the bundled seed.
-- ============================================================================

begin;

drop table if exists public.metric_preferences;
drop function if exists public.guard_metric_preference();
drop table if exists public.metric_views;
drop function if exists public.touch_metric_view();
drop table if exists public.sales_targets;

commit;
