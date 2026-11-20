-- ============================================================================
-- Withers Time, migration 61: each day of sales history keeps its delivery sales
-- Run once, after migration_60.sql. Safe to re-run. Additive only: the app
-- before it reads no such column, so it can go in before or after the app
-- that reads it deploys; apply it first, so the cards never ask for a column
-- that is not there.
--
-- VERIFY. supabase/migration_61_verify.sql. ROLLBACK. supabase/migration_61_down.sql.
--
-- WHY (Alina, 2026-11-18). The scoopers make the delivery orders, so delivery
-- sales count in the labor sales: Labor vs target, the Schedule page's labor
-- line and sales per scooper-hour. The finance feed (migration 40) keeps only
-- a rolling window of days, so delivery needs the same permanent history the
-- in-store sales have (migration 41).
--
-- SCHEMA ONLY. This repo is public: no sales rows are written here, and none
-- may be.
--
-- WHAT THIS ADDS to sales_daily_in_store (migration 41)
--   delivery  the day's delivery-platform net sales (DoorDash, Uber Eats,
--             Grubhub) by payout date, as the feed counts delivery. Never in
--             in_store. Null when not on file: unknown, never zero (the
--             previous owner's books have no daily delivery). bj-finance
--             writes it with the day (modules/sales_history.py publish) and
--             fills the days already published (publish --since).
-- ============================================================================

begin;

alter table public.sales_daily_in_store add column if not exists delivery numeric(12,2);

alter table public.sales_daily_in_store drop constraint if exists sales_daily_in_store_delivery_check;
alter table public.sales_daily_in_store add constraint sales_daily_in_store_delivery_check
  check (delivery is null or delivery >= 0);

commit;
