-- ============================================================================
-- Withers Time, migration 46: hourly payroll actuals, one row per paycheck
-- Run once in the Supabase SQL editor, after migration_45.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_46_verify.sql. ROLLBACK. supabase/migration_46_down.sql.
--
-- WHY (bj-finance #721, lane #692 Labor targets). The Labor vs target card
-- (bj-finance #696) compares what hourly labor actually cost with the payroll
-- target, from the first Withers payroll on. Punches exist only from the time
-- app's start and the pay table's submittals later still, so the record of
-- every pay run is what QBO Payroll paid: its paystubs. bj-finance reads them
-- on the Mac (modules/labor_actuals.py) and writes this table.
--
-- SCHEMA ONLY. This repo is public: no pay rows, names or rates are written
-- here, and none may be.
--
-- WHAT THIS ADDS
--   labor_paycheck_actuals: one row per HOURLY paycheck, as paid.
--     pay_date, period_start, period_end   the pay run and the pay period it
--                       paid (biweekly, Monday to Sunday). Rows keep the
--                       period: splitting one into Sunday to Saturday weeks
--                       is the reader's job, by a rule bj-finance #721 asks
--                       the owner to rule on.
--     employee          the name printed on the paystub.
--     ytd_gross         the stub's year-to-date gross pay. It tells apart two
--                       paychecks for one person, period and pay date (an
--                       off-cycle run can pay twice).
--     profile_id        the Withers-time profile with that name, when exactly
--                       one has it; null otherwise. Readers leave out overhead
--                       people (profiles.is_overhead, migration 45) through it.
--     regular_hours, regular_pay       the Regular Pay line.
--     overtime_hours, overtime_pay     the Overtime Pay line.
--     catering_premium  the catering premium pay types, apart from wages.
--     solo_close        the solo-close bonus, apart from wages.
--     source            'paystub'.
--   Salaried paychecks, tips and reimbursements are not written. Employer
--   taxes and workers' comp are not in a paystub; readers apply the Targets
--   tab's rates (control_settings, migration 43). A pay period with no rows is
--   unknown, never zero.
--
-- WHO MAY WRITE. Nobody through PostgREST: the Mac writes over its own
-- database connection and rewrites a row when a rerun reads it differently.
-- Managers read (RLS with the (select public.is_manager()) wrapper), as they
-- read the pay table (migration 36). updated_at is the database's clock.
--
-- DEPLOY ORDER. Run this file; nothing in the time app reads the table yet
-- (bj-finance #696 will), so there is no app deploy to order against.
-- bj-finance's writer refuses with "apply crm-app migration 46 first" until
-- the table exists.
-- ============================================================================

begin;

create table if not exists public.labor_paycheck_actuals (
  pay_date          date          not null,
  period_start      date          not null,
  period_end        date          not null,
  employee          text          not null,
  ytd_gross         numeric(12,2) not null,
  profile_id        uuid          references public.profiles(id) on delete set null,
  regular_hours     numeric(8,2)  not null,
  regular_pay       numeric(12,2) not null,
  overtime_hours    numeric(8,2)  not null,
  overtime_pay      numeric(12,2) not null,
  catering_premium  numeric(12,2) not null,
  solo_close        numeric(12,2) not null,
  source            text          not null,
  -- The code and host that wrote it, e.g. "modules.labor_actuals@<sha> on <host>".
  built_by          text          not null,
  updated_at        timestamptz   not null default now(),
  primary key (pay_date, period_start, period_end, employee, ytd_gross)
);

alter table public.labor_paycheck_actuals drop constraint if exists labor_paycheck_actuals_period_check;
alter table public.labor_paycheck_actuals add constraint labor_paycheck_actuals_period_check
  check (period_start <= period_end);

alter table public.labor_paycheck_actuals drop constraint if exists labor_paycheck_actuals_source_check;
alter table public.labor_paycheck_actuals add constraint labor_paycheck_actuals_source_check
  check (source in ('paystub'));

alter table public.labor_paycheck_actuals drop constraint if exists labor_paycheck_actuals_hours_check;
alter table public.labor_paycheck_actuals add constraint labor_paycheck_actuals_hours_check
  check (regular_hours >= 0 and overtime_hours >= 0);

alter table public.labor_paycheck_actuals drop constraint if exists labor_paycheck_actuals_employee_check;
alter table public.labor_paycheck_actuals add constraint labor_paycheck_actuals_employee_check
  check (btrim(employee) <> '');

-- The card reads a month's pay periods.
create index if not exists labor_paycheck_actuals_period_idx
  on public.labor_paycheck_actuals (period_start, period_end);
create index if not exists labor_paycheck_actuals_profile_idx
  on public.labor_paycheck_actuals (profile_id);

-- ---- updated_at is the database's clock -------------------------------------------

create or replace function public.touch_labor_paycheck_actuals()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Trigger-only.
revoke execute on function public.touch_labor_paycheck_actuals() from public, anon, authenticated, service_role;

drop trigger if exists labor_paycheck_actuals_touch on public.labor_paycheck_actuals;
create trigger labor_paycheck_actuals_touch before insert or update on public.labor_paycheck_actuals
  for each row execute function public.touch_labor_paycheck_actuals();

-- ---- who reads ----------------------------------------------------------------------

alter table public.labor_paycheck_actuals enable row level security;

drop policy if exists labor_paycheck_actuals_manager_select on public.labor_paycheck_actuals;
create policy labor_paycheck_actuals_manager_select on public.labor_paycheck_actuals for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.labor_paycheck_actuals from anon, authenticated;
revoke all on public.labor_paycheck_actuals from anon;

commit;
