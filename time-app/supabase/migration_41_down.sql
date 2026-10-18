-- ============================================================================
-- Withers Time, rollback for migration 41 (permanent sales history).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every stored day and month of sales history. Our own days and
-- closed months can be republished by bj-finance from the Mac's files; the
-- previous owner's days come back only by running the bj-finance seed again
-- with the source file. Turn the publisher off first
-- (BJ_SALES_HISTORY_PUBLISH=0 for the bj-finance runner): with the tables
-- gone it publishes nothing and says nothing, as before migration 41.
-- ============================================================================

begin;

drop table if exists public.sales_daily_in_store;
drop table if exists public.sales_monthly;
drop function if exists public.touch_sales_history();

commit;
