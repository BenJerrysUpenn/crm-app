-- ============================================================================
-- Withers Time — rollback for migration 26 (QBO map, pay type, held tips)
--
-- DATA LOST:
--   * every row in public.held_tips: the catering tip ledger, which payment is
--     held, released (and in which run) or pre-window;
--   * profiles.qbo_employee_id for every person: the only join between this
--     app and QuickBooks Payroll, which has to be re-entered by hand;
--   * profiles.pay_type for every person (salaried or hourly).
-- Export them first if they may be wanted:
--
--     copy (select * from public.held_tips order by id) to stdout with csv header;
--     copy (select id, full_name, qbo_employee_id, pay_type from public.profiles) to stdout with csv header;
--
-- Also gone: the guard that stops an employee changing their own role,
-- qbo_employee_id or pay_type. profiles_update_self then lets an employee set
-- their own role to 'manager' again, as it did before migration 26.
--
-- ORDER. Roll back migration 27 first (migration_27_down.sql): the payroll
-- tables there sit on top of this. Run in the Supabase SQL editor. Safe to
-- re-run.
-- ============================================================================

begin;

-- held_tips: its trigger, then the table (its policy, CHECK and indexes go with it).
drop trigger if exists held_tips_touch on public.held_tips;
drop table if exists public.held_tips;
drop function if exists public.touch_held_tips_updated_at();

-- The profiles guard, under both names it has had.
drop trigger if exists profiles_payroll_columns_guard on public.profiles;
drop trigger if exists profiles_qbo_employee_id_guard on public.profiles;
drop function if exists public.guard_payroll_profile_columns();
drop function if exists public.guard_qbo_employee_id();

-- The two profile columns, with the index and CHECK that belong to them.
drop index if exists public.profiles_qbo_employee_id_key;
alter table public.profiles drop constraint if exists profiles_pay_type_ck;
alter table public.profiles drop column if exists pay_type;
alter table public.profiles drop column if exists qbo_employee_id;

commit;
