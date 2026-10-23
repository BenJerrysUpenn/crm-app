-- ============================================================================
-- Withers Time, migration 41: permanent sales history for the labor targets
-- Run once in the Supabase SQL editor, after migration_40.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_41_verify.sql. ROLLBACK. supabase/migration_41_down.sql.
--
-- WHY (bj-finance #694, lane #692 Labor targets). The finance feed in
-- metrics_snapshots (migration 40) carries only a rolling window of daily
-- sales. The labor targets need history that does not roll off:
--   * a day's projected sales on the schedule page start from the in-store
--     sales of the same weekday 52 weeks earlier;
--   * the Labor vs target card shows each week's actual in-store sales;
--   * the trend factor is last full month's in-store sales over the same
--     month a year earlier.
-- So this adds two tables that keep every day and every month.
--
-- SCHEMA ONLY. This repo is public: no sales rows are written here, and none
-- may be. bj-finance publishes the rows from the Mac (its daily publisher, and
-- a one-time seed of the previous owner's books run by hand).
--
-- WHAT THIS ADDS
--   sales_daily_in_store: one row per business day.
--     in_store  in-store net sales that day, in dollars. Delivery and catering
--               are not in it (the CRM holds catering; delivery is separate in
--               the feed). Online pickup orders ARE in it, as the feed counts
--               them.
--     pickup    the online-pickup part of in_store, dated as the source dates
--               it; null when the source has no daily split for it.
--     basis     'booked' (final) or 'in_transit' (a card sale that day has not
--               reached a deposit yet, so the number may still change).
--     source    'square' (our own register exports) or 'seller' (the previous
--               owner's books).
--   sales_monthly: one row per month and source.
--     in_store  in-store net sales for the month, same split as above.
--     source    'qbo' (our own closed books) or 'seller' (the previous owner's
--               books). Both may exist for a month; readers prefer 'qbo'.
--   A day or month with no row is unknown, never zero.
--   Weeks are the reader's job (the feed keys Monday weeks, the Labor vs
--   target card Sunday weeks), so only days and months are stored.
--
-- WHO MAY WRITE. Nobody through PostgREST but the service role; the Mac
-- writes over its own database connection and updates rows as days settle.
-- Managers read (RLS with the (select public.is_manager()) wrapper).
-- updated_at is the database's clock.
-- ============================================================================

begin;

-- ---- daily in-store sales --------------------------------------------------------

create table if not exists public.sales_daily_in_store (
  day        date          primary key,
  in_store   numeric(12,2) not null,
  pickup     numeric(12,2),
  basis      text          not null,
  source     text          not null,
  -- The code and host that wrote it, e.g. "modules.sales_history@<sha> on <host>".
  built_by   text          not null,
  updated_at timestamptz   not null default now()
);

alter table public.sales_daily_in_store drop constraint if exists sales_daily_in_store_basis_check;
alter table public.sales_daily_in_store add constraint sales_daily_in_store_basis_check
  check (basis in ('booked', 'in_transit'));

alter table public.sales_daily_in_store drop constraint if exists sales_daily_in_store_source_check;
alter table public.sales_daily_in_store add constraint sales_daily_in_store_source_check
  check (source in ('square', 'seller'));

-- The previous owner's books are closed: their days are final.
alter table public.sales_daily_in_store drop constraint if exists sales_daily_in_store_seller_booked;
alter table public.sales_daily_in_store add constraint sales_daily_in_store_seller_booked
  check (source <> 'seller' or basis = 'booked');

-- ---- monthly sales by source -------------------------------------------------------

create table if not exists public.sales_monthly (
  month      date          not null,
  source     text          not null,
  in_store   numeric(12,2) not null,
  built_by   text          not null,
  updated_at timestamptz   not null default now(),
  primary key (month, source)
);

alter table public.sales_monthly drop constraint if exists sales_monthly_month_start;
alter table public.sales_monthly add constraint sales_monthly_month_start
  check (extract(day from month) = 1);

alter table public.sales_monthly drop constraint if exists sales_monthly_source_check;
alter table public.sales_monthly add constraint sales_monthly_source_check
  check (source in ('qbo', 'seller'));

-- ---- updated_at is the database's clock -------------------------------------------

create or replace function public.touch_sales_history()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Trigger-only.
revoke execute on function public.touch_sales_history() from public, anon, authenticated, service_role;

drop trigger if exists sales_daily_in_store_touch on public.sales_daily_in_store;
create trigger sales_daily_in_store_touch before insert or update on public.sales_daily_in_store
  for each row execute function public.touch_sales_history();

drop trigger if exists sales_monthly_touch on public.sales_monthly;
create trigger sales_monthly_touch before insert or update on public.sales_monthly
  for each row execute function public.touch_sales_history();

-- ---- who reads ----------------------------------------------------------------------

alter table public.sales_daily_in_store enable row level security;
alter table public.sales_monthly enable row level security;

drop policy if exists sales_daily_in_store_manager_select on public.sales_daily_in_store;
create policy sales_daily_in_store_manager_select on public.sales_daily_in_store for select to authenticated
  using ((select public.is_manager()));

drop policy if exists sales_monthly_manager_select on public.sales_monthly;
create policy sales_monthly_manager_select on public.sales_monthly for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.sales_daily_in_store from anon, authenticated;
revoke all on public.sales_daily_in_store from anon;
revoke insert, update, delete, truncate on public.sales_monthly from anon, authenticated;
revoke all on public.sales_monthly from anon;

commit;
