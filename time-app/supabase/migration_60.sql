-- ============================================================================
-- Withers Time, migration 60: each day of hourly labor keeps its marketing work apart
-- Run once, after migration_59.sql. Safe to re-run. Additive only: the app
-- before it reads none of these columns, so it can go in before or after the
-- app that reads them deploys; apply it first, so the card never asks for a
-- column that is not there.
--
-- VERIFY. supabase/migration_60_verify.sql. ROLLBACK. supabase/migration_60_down.sql.
--
-- WHY (Alina, 2026-11-16). Marketing work is a separate marketing budget, so
-- it is taken out of the labor % the same way catering work is (migration
-- 59), at the hours actually worked. bj-finance places it on its day with the
-- rest of the day's hourly labor (modules/labor_days.py, MARKETING WORK):
-- When I Work lines whose Position is Marketing before the time app; after,
-- punches on a Marketing shift or on any shift of a marketing deal (event
-- type starting "Marketing", or stage Closed Marketing Event), and the part of
-- a punch with no shift that overlaps the same person's unpunched marketing
-- shift.
--
-- SCHEMA ONLY. This repo is public: no pay rows, names or rates are written
-- here, and none may be.
--
-- WHAT THIS ADDS to labor_daily_actuals (migration 46)
--   marketing_hours  of the day's hours, those worked on marketing. Never
--                    the same hours as catering_hours: the two together are
--                    never more than the day's hours.
--   marketing_wages  what those hours cost: each person's marketing hours at
--                    their own paid rate for the period (the period's
--                    average when no paycheck has their name).
--   Both null on a day not split yet: unknown, never zero. bj-finance
--   writes them with the day (publish, sweep) and sets them on the days
--   already published (`python -m modules.labor_actuals rebuild`).
--   Same writers and readers as the table: the Mac's own connection writes,
--   managers read.
-- ============================================================================

begin;

alter table public.labor_daily_actuals add column if not exists marketing_hours numeric(8,2);
alter table public.labor_daily_actuals add column if not exists marketing_wages numeric(12,2);

alter table public.labor_daily_actuals drop constraint if exists labor_daily_actuals_marketing_check;
alter table public.labor_daily_actuals add constraint labor_daily_actuals_marketing_check
  check (
    (marketing_hours is null) = (marketing_wages is null)
    and (
      marketing_hours is null
      or (marketing_hours >= 0 and marketing_wages >= 0 and marketing_hours + coalesce(catering_hours, 0) <= hours)
    )
  );

commit;
