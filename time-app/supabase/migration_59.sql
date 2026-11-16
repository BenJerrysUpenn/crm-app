-- ============================================================================
-- Withers Time, migration 59: each day of hourly labor keeps its catering work apart
-- Run once in the Supabase SQL editor, after migration_46.sql and after the
-- app that ships this file deploys green on main. Safe to re-run.
--
-- VERIFY. supabase/migration_59_verify.sql. ROLLBACK. supabase/migration_59_down.sql.
--
-- WHY (Alina, 2026-11-16). "Catering shouldn't be affecting the labor percent
-- because catering revenue covers that as a separate bill." The Labor vs
-- target card took the crew hours each booked deal BILLED off the actual
-- (labor_hours x staff_count), which is a quote's estimate, runs far off what
-- was worked, and turned a week n/a whenever a deal had no billed hours. What
-- comes off now is the catering work the clocks recorded, placed on its day
-- with the rest of the day's hourly labor by bj-finance
-- (modules/labor_days.py, CATERING WORK, KEPT APART): When I Work lines whose
-- Position is Catering before the time app, punches on Catering shifts after.
--
-- SCHEMA ONLY. This repo is public: no pay rows, names or rates are written
-- here, and none may be.
--
-- WHAT THIS ADDS to labor_daily_actuals (migration 46)
--   catering_hours  of the day's hours, those worked on catering (part of
--                   hours, never more).
--   catering_wages  what those hours cost: each person's catering hours at
--                   their own paid rate for the period (the period's average
--                   when no paycheck has their name). The catering premium
--                   stays in catering_premium and is all catering.
--   Both null on a day not split yet: unknown, never zero. bj-finance
--   writes them with the day (publish, sweep) and sets them on the days
--   already published (`python -m modules.labor_actuals rebuild`).
--   Same writers and readers as the table: the Mac's own connection writes,
--   managers read.
-- ============================================================================

begin;

alter table public.labor_daily_actuals add column if not exists catering_hours numeric(8,2);
alter table public.labor_daily_actuals add column if not exists catering_wages numeric(12,2);

alter table public.labor_daily_actuals drop constraint if exists labor_daily_actuals_catering_check;
alter table public.labor_daily_actuals add constraint labor_daily_actuals_catering_check
  check (
    (catering_hours is null) = (catering_wages is null)
    and (catering_hours is null or (catering_hours >= 0 and catering_hours <= hours and catering_wages >= 0))
  );

commit;
