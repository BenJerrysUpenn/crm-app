-- ============================================================================
-- Withers Time, rollback for migration 60 (marketing work kept apart on
-- labor_daily_actuals). Run by hand. Safe to re-run.
--
-- DATA LOST: each day's marketing_hours and marketing_wages. bj-finance can
-- set them again (`python -m modules.labor_actuals rebuild`) once 60 is back.
-- Deploy the time app without the marketing split first: the Labor vs target
-- card reads both columns, and bj-finance's day writer refuses to write
-- until they exist.
-- ============================================================================

begin;

alter table public.labor_daily_actuals drop constraint if exists labor_daily_actuals_marketing_check;
alter table public.labor_daily_actuals drop column if exists marketing_wages;
alter table public.labor_daily_actuals drop column if exists marketing_hours;

commit;
