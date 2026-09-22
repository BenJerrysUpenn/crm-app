-- ============================================================================
-- Withers Time — migration 25: audit trail for time_entries and shifts
-- Run once in the Supabase SQL editor, after migration_24.sql. Safe to re-run.
--
-- Why: the 2026-09-23 pay run could not account for its own inputs. Time entry
-- ids 1270–1274 and at least three shifts had vanished from inside the pay
-- window, including Joey's 09-10 punch, and there was no record anywhere of who
-- removed them or what they said. Payroll spec (bj-finance #519, item 1.13 and
-- build order 9.1): "no audit table exists ... Precondition for trusting
-- anything above." Every other timesheet check is only as good as the promise
-- that the rows it reads are the rows that were there.
--
-- What this adds:
--   1. row_audit                  — one append-only row per write, with the
--                                   before-image on UPDATE and DELETE and the
--                                   after-image on INSERT and UPDATE.
--   2. audit_row_change()         — the trigger function, SECURITY DEFINER.
--   3. Triggers on time_entries and shifts, AFTER each row change.
--
-- WHO. Three different actors write these tables and only one of them has an
-- auth.uid(): a signed-in manager or employee through PostgREST. The clock-out
-- reminder cron and the catering shift writer come in on the service-role key
-- (auth.uid() is null, db role service_role), and a person in the Supabase SQL
-- editor arrives as postgres with no JWT at all. Recording only auth.uid()
-- would leave exactly the deletions this table exists for looking anonymous, so
-- every row carries all three: the uid when there is one, the JWT role claim,
-- and the database role. The 09-10 deletion would have been attributable by the
-- db role alone.
--
-- APPEND-ONLY. There is no insert, update or delete policy on row_audit — only
-- a manager SELECT policy. Nothing reaching the database through PostgREST can
-- write to it, not even a manager, and not even with the service-role key going
-- through RLS. The rows arrive solely through the SECURITY DEFINER trigger,
-- which runs as the table's owner and is not subject to RLS. Deliberately no
-- "managers may correct the log" escape hatch: an audit row a manager can edit
-- proves nothing about a manager.
--
-- COST. Two triggers on the two busiest tables in the app. A clock-in writes
-- one extra row of jsonb; a shift edit writes one. The tables see a few hundred
-- writes a week, so the storage is trivial and the latency is a single local
-- insert. row_to_json on a time_entries row is ~20 short scalar columns.
--
-- RETENTION. None. Nothing prunes this table, on purpose: the value is in the
-- old rows. Revisit if it ever gets large, which at this write rate is years.
--
-- VERIFY. supabase/migration_25_verify.sql asserts the trigger behaviour
-- against a database that has this migration applied (see its header).
-- ============================================================================

-- ---------- row_audit --------------------------------------------------------
-- table_name is stored rather than a regclass so the log survives a table being
-- renamed or dropped: the whole point is to still be readable when the thing it
-- describes is gone.
--
-- row_id is bigint because both audited tables have bigint identity keys. A
-- future table keyed by uuid needs its own column rather than a text cast that
-- would silently sort wrong.
create table if not exists public.row_audit (
  id           bigint generated always as identity primary key,
  table_name   text        not null,
  row_id       bigint,
  op           text        not null check (op in ('INSERT','UPDATE','DELETE')),
  at           timestamptz not null default now(),
  -- The signed-in user, when the write came through PostgREST with a JWT.
  actor_uid    uuid,
  -- The JWT's role claim: 'authenticated', 'anon', 'service_role', or null in
  -- the SQL editor. Distinct from db_role below, which is the Postgres role the
  -- statement actually ran as, and the two disagree often enough to matter.
  actor_role   text,
  db_role      text        not null,
  -- The row as it was before this statement (UPDATE, DELETE), and as it is
  -- after (INSERT, UPDATE). A DELETE has no after-image and an INSERT no
  -- before-image; both are null there rather than an empty object, so "no such
  -- image" and "an empty row" stay different things.
  before_image jsonb,
  after_image  jsonb
);

-- The two reads this table is for: "what happened to row X" and "what happened
-- during the pay window". Both are cheap with these.
create index if not exists row_audit_row_idx on public.row_audit (table_name, row_id, at desc);
create index if not exists row_audit_at_idx  on public.row_audit (at desc);

alter table public.row_audit enable row level security;

-- Managers read; nobody writes. The (select public.is_manager()) wrapper is
-- mandatory in this project: a bare is_manager() is re-evaluated per row and
-- has caused statement timeouts (crm/004).
drop policy if exists row_audit_manager_select on public.row_audit;
create policy row_audit_manager_select on public.row_audit for select to authenticated
  using ((select public.is_manager()));

-- ---------- the trigger function --------------------------------------------
-- SECURITY DEFINER so it can write a table the caller cannot, with an explicit
-- search_path so the objects it names cannot be shadowed by a caller-set path.
--
-- Reading the JWT: current_setting(..., true) returns null instead of raising
-- when the setting is absent, which is the normal case in the SQL editor. The
-- claims are parsed defensively — a malformed claims string must never take out
-- the write being audited.
--
-- The function never raises. An audit insert that fails would roll back the
-- clock-in that triggered it, and a person standing at the counter unable to
-- clock in is a worse failure than a missing audit row. Nothing here can fail
-- in practice (a local insert into a table with no constraints beyond the op
-- check), but "in practice" is not a guarantee and this runs on every punch.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  claims   jsonb;
  uid      uuid;
  jwt_role text;
begin
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    uid := nullif(claims ->> 'sub', '')::uuid;
    jwt_role := nullif(claims ->> 'role', '');
  exception when others then
    -- Unparseable claims: log the write anyway, with no attribution.
    claims := null;
    uid := null;
    jwt_role := null;
  end;

  begin
    insert into public.row_audit (
      table_name, row_id, op, actor_uid, actor_role, db_role, before_image, after_image
    )
    values (
      tg_table_name,
      case when tg_op = 'DELETE' then (to_jsonb(old) ->> 'id')::bigint
           else (to_jsonb(new) ->> 'id')::bigint end,
      tg_op,
      uid,
      jwt_role,
      current_user,
      case when tg_op in ('UPDATE','DELETE') then row_to_json(old)::jsonb end,
      case when tg_op in ('INSERT','UPDATE') then row_to_json(new)::jsonb end
    );
  exception when others then
    null; -- never break the write being audited
  end;

  -- AFTER triggers ignore the return value; return the row anyway so the
  -- function is also correct if it is ever attached BEFORE.
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------- the triggers -----------------------------------------------------
-- AFTER, so only writes that actually committed their row change are logged,
-- and FOR EACH ROW, so a bulk delete records every row it took rather than one
-- line saying "a delete happened". Dropped first so the file is re-runnable.
drop trigger if exists time_entries_audit on public.time_entries;
create trigger time_entries_audit
  after insert or update or delete on public.time_entries
  for each row execute function public.audit_row_change();

drop trigger if exists shifts_audit on public.shifts;
create trigger shifts_audit
  after insert or update or delete on public.shifts
  for each row execute function public.audit_row_change();

-- Note on cascades: profiles.id is referenced by both tables with ON DELETE
-- CASCADE, so removing a person takes their punches and shifts with them. Those
-- cascaded deletes fire this trigger too — the row-level log is exactly what
-- makes that recoverable.
