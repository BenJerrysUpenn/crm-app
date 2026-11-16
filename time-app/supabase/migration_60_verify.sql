-- ============================================================================
-- Withers Time, verification for migration 60 (marketing work kept apart on
-- labor_daily_actuals)
--
-- Run by hand against a database with migration 60 applied, or locally with
-- every other verify file: `npm run test:db`. Everything happens inside one
-- transaction that ends in ROLLBACK. A clean run ends with "migration 60
-- verified". Every figure below is invented.
--
-- WHAT IS CHECKED
--   1. A day written without the split keeps both columns null (not split
--      yet); the split is then set on it.
--   2. The split is both columns or neither; marketing hours and wages are
--      not negative; marketing and catering hours together are never more
--      than the day's hours (equal lands).
--   3. On a day whose catering is not split yet, marketing hours alone are
--      still never more than the day's hours.
-- ============================================================================

begin;

do $$
declare
  refused boolean;
  h numeric;
  w numeric;
begin
  insert into public.labor_daily_actuals (day, hours, wages, catering_premium, solo_close, period_start, period_end, source, built_by)
  values ('2099-01-05', 8, 120, 0, 0, '2099-01-05', '2099-01-18', 'punches', 'verify 60');
  select marketing_hours, marketing_wages into h, w from public.labor_daily_actuals where day = '2099-01-05';
  if h is not null or w is not null then
    raise exception '1: a day written without the split should keep both columns null';
  end if;
  update public.labor_daily_actuals set marketing_hours = 3, marketing_wages = 45 where day = '2099-01-05';

  update public.labor_daily_actuals
     set catering_hours = 3, catering_wages = 45, marketing_hours = 5, marketing_wages = 75
   where day = '2099-01-05';

  begin
    update public.labor_daily_actuals set marketing_hours = 2, marketing_wages = null where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: marketing hours without wages should be refused'; end if;

  begin
    update public.labor_daily_actuals set marketing_hours = null, marketing_wages = 45 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: marketing wages without hours should be refused'; end if;

  begin
    update public.labor_daily_actuals set marketing_hours = 5.01, marketing_wages = 1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: catering and marketing hours above the day''s hours should be refused'; end if;

  begin
    update public.labor_daily_actuals set marketing_hours = -1, marketing_wages = 1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: negative marketing hours should be refused'; end if;

  begin
    update public.labor_daily_actuals set marketing_hours = 1, marketing_wages = -1 where day = '2099-01-05';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '2: negative marketing wages should be refused'; end if;

  insert into public.labor_daily_actuals (day, hours, wages, catering_premium, solo_close, period_start, period_end, source, built_by)
  values ('2099-01-06', 8, 120, 0, 0, '2099-01-05', '2099-01-18', 'punches', 'verify 60');
  update public.labor_daily_actuals set marketing_hours = 8, marketing_wages = 120 where day = '2099-01-06';
  begin
    update public.labor_daily_actuals set marketing_hours = 8.01, marketing_wages = 120 where day = '2099-01-06';
    refused := false;
  exception when check_violation then refused := true;
  end;
  if not refused then raise exception '3: marketing hours above the day''s hours should be refused while catering is not split'; end if;

  raise notice 'migration 60 verified';
end
$$;

rollback;
