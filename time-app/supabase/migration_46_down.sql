-- ============================================================================
-- Withers Time, rollback for migration 46 (hourly payroll actuals).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every stored paycheck and day row. bj-finance republishes them
-- from the saved QBO paystub PDFs and the When I Work exports kept on the Mac
-- (`python -m modules.labor_actuals publish FILE... --wiw XLSX...`). With the
-- tables gone that command refuses ("apply crm-app migration 46 first") and
-- writes nothing.
-- ============================================================================

begin;

drop table if exists public.labor_daily_actuals;
drop table if exists public.labor_paycheck_actuals;
drop function if exists public.touch_labor_paycheck_actuals();

commit;
