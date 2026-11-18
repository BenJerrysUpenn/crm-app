-- ============================================================================
-- Withers Time, rollback for migration 61 (delivery kept on
-- sales_daily_in_store). Run by hand. Safe to re-run.
--
-- DATA LOST: each day's delivery. bj-finance can write it again
-- (`python -m modules.sales_history publish --since <day>`) once 61 is back.
-- Deploy the time app without the delivery reads first: Labor vs target, the
-- labor line and the Labour card read the column.
-- ============================================================================

begin;

alter table public.sales_daily_in_store drop constraint if exists sales_daily_in_store_delivery_check;
alter table public.sales_daily_in_store drop column if exists delivery;

commit;
