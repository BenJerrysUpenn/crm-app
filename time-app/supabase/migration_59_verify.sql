-- ============================================================================
-- Withers Time, verification for migration 59 (catering work kept apart on
-- labor_daily_actuals)
--
-- Run by hand against a database with migration 59 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. A clean run ends with "migration 59
-- verified". Every figure below is invented.
--
-- WHAT IS CHECKED
--   1. A day written without the split keeps both columns null (not split
--      yet); the split is then set on it.
--   2. The split is both columns or neither; catering hours are not negative
--      and never more than the day's hours (equal lands); catering wages are
--      not negative.
-- ============================================================================

begin;

do $$
declare
  refused boolean;
  h numeric;
  w numeric;
begin
  insert into public.labor_daily_actuals (day, hours, wages, catering_premium, solo_close, period_start, period_end, source, built_by)
  values ('2099-01-05', 8, 120, 0, 0, '2099-01-05', '2099-01-18', 'punches', 'verify 59');
  select catering_hours, catering_wages into h, w from public.labor_daily_actuals where day = '2099-01-05';
  if h is not null or w is not null then
    raise exception '1: a day written without the split should keep both columns null';
  end if;
  update public.labor_daily_actuals set catering_hours = 3, catering_wages = 45 where day = '2099-01-05';

  update public.labor_daily_actuals set catering_hours = 8, catering_wages = 120 where day = '2099-01-05';

  begin
    update public.labor_daily_actuals set catering_hours = 2, catering_wages = null where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: catering hours without wages should be refused'; end if;

  begin
    update public.labor_daily_actuals set catering_hours = 8.01, catering_wages = 1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: more catering hours than the day''s hours should be refused'; end if;

  begin
    update public.labor_daily_actuals set catering_hours = -1, catering_wages = 1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: negative catering hours should be refused'; end if;

  begin
    update public.labor_daily_actuals set catering_hours = 1, catering_wages = -1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: negative catering wages should be refused'; end if;

  raise notice 'migration 59 verified';
end
$$;

rollback;
