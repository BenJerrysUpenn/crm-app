-- ============================================================================
-- Withers Time, rollback for migration 46 (hourly payroll actuals).
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- DATA LOST: every stored paycheck row. bj-finance republishes them from the
-- saved QBO paystub PDFs (`python -m modules.labor_actuals publish FILE...`);
-- nothing else holds them. With the table gone that command refuses ("apply
-- crm-app migration 46 first") and writes nothing.
-- ============================================================================

begin;

drop table if exists public.labor_paycheck_actuals;
drop function if exists public.touch_labor_paycheck_actuals();

commit;
