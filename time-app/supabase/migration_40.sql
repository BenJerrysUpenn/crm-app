-- ============================================================================
-- Withers Time, migration 40: the finance feed for the Metrics page
-- Run once in the Supabase SQL editor, after migration_39.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_40_verify.sql. ROLLBACK. supabase/migration_40_down.sql.
--
-- WHY (Alina, 2026-10-10, bj-finance #671 ruling M2). Cash, in-store sales,
-- wages and the closed-month P&L live in QBO and the Square exports on the
-- Mac. Vercel can reach neither. So, as with the pay table (migration 36), a
-- bj-finance job on the Mac builds the numbers and publishes them HERE as
-- JSON, and the Metrics page renders them. The page does the metric
-- arithmetic (LER paid and unpaid, pace, labour %); the feed carries inputs.
--
-- WHAT THIS ADDS
--   metrics_snapshots: one row per publish.
--     kind 'daily'         period = the business day the numbers run through
--                          (normally yesterday). Published after the daily
--                          bookkeeping pass. Carries cash, sales by day and
--                          stream, wages by week, the trailing COGS %, and the
--                          next 14 days of known cash in and out.
--     kind 'closed_month'  period = the first day of a closed month. Published
--                          after the month close. Carries revenue by stream,
--                          COGS, gross profit, wages, employer tax, pre-tax
--                          profit and the rolling twelve months.
--   payload is bj-finance modules/metrics_publish.py's JSON, verbatim; its
--   shape is versioned by payload->'schema' and documented (and parsed) in
--   time-app/lib/metrics/snapshot.ts. A payload the page cannot parse shows
--   as "feed format not recognised", never as zeros.
--
-- EVERY PUBLISH IS KEPT. Rows are never updated or deleted (a trigger refuses
-- both); the page reads the newest row per kind and period, and the daily
-- history is what the cash-on-hand chart draws.
--
-- WHO MAY WRITE. Nobody through PostgREST but the service role; the Mac
-- writes over its own database connection, as payroll_publish does.
-- Managers read (RLS with the (select public.is_manager()) wrapper).
-- ============================================================================

begin;

create table if not exists public.metrics_snapshots (
  id                 bigint generated always as identity primary key,
  kind               text        not null,
  period             date        not null,
  built_at           timestamptz not null default now(),
  -- The code and host that built it: "modules.metrics_publish@<sha> on <host>".
  built_by           text        not null,
  -- sha256 of the payload JSON: two publishes with the same value say the same.
  source_fingerprint text        not null,
  payload            jsonb       not null
);

alter table public.metrics_snapshots drop constraint if exists metrics_snapshots_kind_check;
alter table public.metrics_snapshots add constraint metrics_snapshots_kind_check
  check (kind in ('daily', 'closed_month'));

alter table public.metrics_snapshots drop constraint if exists metrics_snapshots_month_start;
alter table public.metrics_snapshots add constraint metrics_snapshots_month_start
  check (kind <> 'closed_month' or extract(day from period) = 1);

alter table public.metrics_snapshots drop constraint if exists metrics_snapshots_payload_object;
alter table public.metrics_snapshots add constraint metrics_snapshots_payload_object
  check (jsonb_typeof(payload) = 'object' and payload ? 'schema');

-- The page's reads: the newest publish per kind, and the newest per period.
create index if not exists metrics_snapshots_kind_period_idx
  on public.metrics_snapshots (kind, period desc, built_at desc);

alter table public.metrics_snapshots enable row level security;

drop policy if exists metrics_snapshots_manager_select on public.metrics_snapshots;
create policy metrics_snapshots_manager_select on public.metrics_snapshots for select to authenticated
  using ((select public.is_manager()));

revoke insert, update, delete, truncate on public.metrics_snapshots from anon, authenticated;
revoke all on public.metrics_snapshots from anon;

create or replace function public.guard_metrics_snapshot()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.built_at := now();
    return new;
  end if;
  raise exception 'Metrics snapshots are kept as published: snapshot % cannot be changed or removed.', old.id;
end
$$;

revoke execute on function public.guard_metrics_snapshot() from public, anon, authenticated;

drop trigger if exists metrics_snapshots_guard on public.metrics_snapshots;
create trigger metrics_snapshots_guard before insert or update or delete on public.metrics_snapshots
  for each row execute function public.guard_metrics_snapshot();

commit;
