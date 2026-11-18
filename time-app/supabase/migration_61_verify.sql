-- ============================================================================
-- Withers Time, verification for migration 61 (delivery kept on
-- sales_daily_in_store)
--
-- Run by hand against a database with migration 61 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. A clean run ends with "migration 61
-- verified". Every figure below is invented.
--
-- WHAT IS CHECKED
--   1. A day written without delivery keeps it null (not on file); it is then
--      set on the day.
--   2. Delivery is never negative; zero lands.
-- ============================================================================

begin;

do $$
declare
  refused boolean;
  d numeric;
begin
  insert into public.sales_daily_in_store (day, in_store, pickup, basis, source, built_by)
  values (date '2099-02-03', 100.00, null, 'booked', 'square', 'verify 61');
  select delivery into d from public.sales_daily_in_store where day = '2099-02-03';
  if d is not null then raise exception '1: a day written without delivery should keep it null'; end if;
  update public.sales_daily_in_store set delivery = 25.50 where day = '2099-02-03';
  select delivery into d from public.sales_daily_in_store where day = '2099-02-03';
  if d <> 25.50 then raise exception '1: delivery should be set on the day'; end if;

  refused := false;
  begin
    update public.sales_daily_in_store set delivery = -1 where day = '2099-02-03';
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: negative delivery should be refused'; end if;
  update public.sales_daily_in_store set delivery = 0 where day = '2099-02-03';

  raise notice 'migration 61 verified';
end
$$;

rollback;
