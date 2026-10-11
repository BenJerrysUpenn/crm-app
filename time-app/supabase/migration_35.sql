-- ============================================================================
-- Withers Time, migration 35: a cover punch is never a short punch (1.5)
-- Run once in the Supabase SQL editor, after migration_34.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_35_verify.sql. ROLLBACK. supabase/migration_35_down.sql.
--
-- WHY. The first live run (2026-09-21..10-04) was blocked by four 1.5 "short
-- punch" refusals on unscheduled punches the 1.10 ladder had guessed were
-- covers of somebody else's shift (a 0.73h punch measured against a 6h opener
-- the person was never meant to work). Alina, 2026-10-05: "these are all
-- fine, neither of these people are expected to do those shifts." PR #61
-- changed lib/payroll/verify.ts so 1.5 only measures a punch against its own
-- shift_id or the person's own shift that day. This file makes the database's
-- copy of the refusal (payroll_punch_blockers, migration 27, called by
-- guard_payroll_run_submittal) say the same, or the submittal is still refused.
--
-- WHAT THIS DOES. Redefines payroll_punch_blockers(date). Two changes:
--   a. The 1.5 branch uses the explicit or own shift's length
--      (own_scheduled_hours), never a cover's. 1.4 and 1.1 still use the full
--      ladder, covers included, as before. A cover punch stays paid as punched.
--   b. runaway is coalesced to false. In 27 a person's latest punch has no
--      next punch, so the 1.3 test was NULL, runaway was NULL, and that punch
--      was never tested for 1.5 or a closed 1.4 at all. verify.ts already
--      treats it as not a runaway; this matches it.
--
-- NO TABLE, COLUMN, POLICY OR ROW IS CHANGED. Grants are re-revoked as in 27.
-- ============================================================================

begin;

create or replace function public.payroll_punch_blockers(p_window_end date)
returns table (check_id text, punch_id bigint, employee_id uuid, work_date date)
language sql
stable
security definer set search_path = public
as $$
  with p as (
    select t.id, t.employee_id, t.shift_id, t.clock_in_at, t.clock_out_at,
           coalesce(t.clock_out_at, t.clock_in_at) as punch_end,
           (t.clock_in_at at time zone 'America/New_York')::date as d,
           extract(epoch from (t.clock_out_at - t.clock_in_at)) / 3600.0 as hours
      from public.time_entries t
     where (t.clock_in_at at time zone 'America/New_York')::date
           between p_window_end - 13 and p_window_end
  ),
  classified as (
    select p.*,
           coalesce(p.hours > 15
            or abs(extract(epoch from (nx.clock_in_at - p.clock_out_at))) <= 5, false) as runaway,
           coalesce(ex.id, own.id, cov.id) as matched_shift,
           coalesce(ex.len, own.len, cov.len) as scheduled_hours,
           coalesce(ex.len, own.len) as own_scheduled_hours
      from p
      left join lateral (
        select n.clock_in_at
          from public.time_entries n
         where n.employee_id = p.employee_id
           and (n.clock_in_at, n.id) > (p.clock_in_at, p.id)
         order by n.clock_in_at, n.id
         limit 1
      ) nx on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where s.id = p.shift_id
      ) ex on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where s.employee_id = p.employee_id
           and (s.starts_at at time zone 'America/New_York')::date = p.d
           and least(s.ends_at, p.punch_end) >= greatest(s.starts_at, p.clock_in_at)
         order by least(s.ends_at, p.punch_end) - greatest(s.starts_at, p.clock_in_at) desc,
                  s.starts_at, s.id
         limit 1
      ) own on true
      left join lateral (
        select s.id, extract(epoch from (s.ends_at - s.starts_at)) / 3600.0 as len
          from public.shifts s
         where p.clock_out_at is not null
           and s.employee_id is not null
           and s.employee_id <> p.employee_id
           and (s.starts_at at time zone 'America/New_York')::date = p.d
           and not exists (
             select 1 from public.time_entries o
              where o.employee_id = s.employee_id
                and (o.clock_in_at at time zone 'America/New_York')::date = p.d)
           and p.clock_in_at >= s.starts_at - interval '30 minutes'
           and p.clock_out_at <= s.ends_at + interval '30 minutes'
           and least(s.ends_at, p.clock_out_at) >= greatest(s.starts_at, p.clock_in_at)
         order by least(s.ends_at, p.clock_out_at) - greatest(s.starts_at, p.clock_in_at) desc,
                  s.starts_at, s.id
         limit 1
      ) cov on true
  )
  select '1.4'::text, c.id, c.employee_id, c.d
    from classified c
   where c.clock_out_at is not null and c.runaway and c.matched_shift is null
  union all
  select '1.4'::text, c.id, c.employee_id, c.d
    from classified c
   where c.clock_out_at is null and c.matched_shift is null
  union all
  select '1.1'::text, c.id, c.employee_id, c.d
    from classified c
   where c.clock_out_at is null and c.matched_shift is not null
  union all
  select '1.5'::text, c.id, c.employee_id, c.d
    from classified c
   where c.clock_out_at is not null
     and not c.runaway
     and c.own_scheduled_hours > 0
     and c.hours < 0.25 * c.own_scheduled_hours
   order by 4, 2;
$$;

revoke execute on function public.payroll_punch_blockers(date) from public, anon, authenticated, service_role;

commit;
