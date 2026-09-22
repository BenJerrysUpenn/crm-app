-- ============================================================================
-- Withers Time — migration 26: the QBO employee map and the held-tip ledger
-- Run once in the Supabase SQL editor, after migration_25.sql. Safe to re-run.
--
-- Two pieces of payroll bookkeeping the 2026-09-23 run did in prose and got
-- wrong (bj-finance #519, payroll spec §2.5 and §3.6, build order 9.2).
--
--   1. profiles.qbo_employee_id — the roster join to QuickBooks Payroll.
--   2. held_tips                — the ledger of catering tips paid but not yet
--                                 released into a pay run.
--
-- WHY NOT JOIN ON NAMES (§2.5). The run matched Withers-time people to QBO
-- people by name and it does not work: "piper" in one system is Kieran Flint in
-- the other, and QBO itself returns different display names from different
-- endpoints, so even a careful string match has nothing stable to match on. The
-- id is the Intuit.ems.iop local employee id. One column, set once per person,
-- and the name is never load-bearing again.
--
-- WHY A TABLE AND NOT PROSE (§3.6). Catering tips arrive on Square invoices
-- weeks before the event they belong to, so every run holds some and releases
-- others. The 2026-09-23 run tracked that in a written note, and the note
-- carried a phantom $100 — the Geraci payment and the Burlington payment were
-- the same money against deal 25188, counted twice. A table with a status per
-- payment makes the tie-out arithmetic rather than reading:
--
--     released + held + pre_window == the all-history invoice-tip total
--
-- MONEY IS INTEGER CENTS. numeric would be exact too, but cents remove the
-- question entirely and match how the tip split is computed (largest-remainder
-- to the cent, §3.3). Nothing here is ever a float.
-- ============================================================================

-- ---------- profiles.qbo_employee_id ----------------------------------------
alter table public.profiles
  add column if not exists qbo_employee_id text;

comment on column public.profiles.qbo_employee_id is
  'QuickBooks Payroll employee id (Intuit.ems.iop local id). The ONLY join between this app and QBO: names differ between the two systems and between QBO endpoints (payroll spec 2.5).';

-- Unique where set. A partial index rather than a plain unique constraint
-- because most rows are null and nulls must not collide with each other — and
-- because two people pointing at one QBO employee means somebody gets paid
-- twice and somebody not at all, which is exactly the failure the id exists to
-- prevent. Blank strings are normalised to null by the API (lib/qboEmployee.ts)
-- so '' can never sit in the index pretending to be a value.
create unique index if not exists profiles_qbo_employee_id_key
  on public.profiles (qbo_employee_id)
  where qbo_employee_id is not null;

-- Only a manager may set or change the mapping.
--
-- This needs its own guard because of the policy stack it lands in:
-- profiles_update_self lets any signed-in person update their OWN row, and it
-- does not restrict which columns. Without this trigger an employee could point
-- their profile at somebody else's QBO employee id and redirect a paycheque.
--
-- auth.uid() is null for the service-role client and in the SQL editor; those
-- are trusted server contexts (the invite flow upserts profiles that way) and
-- are left alone. The check is on a CHANGE, so an update that leaves the column
-- as it was — which is every ordinary profile edit — never trips it.
create or replace function public.guard_qbo_employee_id()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.qbo_employee_id is distinct from old.qbo_employee_id
     and auth.uid() is not null
     and not (select public.is_manager()) then
    raise exception 'Only a manager may change qbo_employee_id'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_qbo_employee_id_guard on public.profiles;
create trigger profiles_qbo_employee_id_guard
  before update on public.profiles
  for each row execute function public.guard_qbo_employee_id();

-- ---------- held_tips --------------------------------------------------------
-- One row per catering tip payment, not per deal: a deal can be paid in two
-- instalments and each carries its own tip on its own date.
--
-- The three statuses are what the ledger is for:
--   pre_window — paid before the first run this ledger covers. Carried so the
--                all-history tie-out balances; never released, never paid again.
--   held       — paid, but its event has not happened yet (or its crew is not
--                yet provable, §3.5). Sits here until a run releases it.
--   released   — paid out in the run named by released_in_run.
--
-- released_in_run is the RUN's pay date (period end + 3, a Wednesday, §0.1),
-- which is how every other artefact of a pay run is identified. Null unless the
-- row is released, and required when it is — enforced below, because a released
-- row with no run is precisely the shape the phantom $100 had.
create table if not exists public.held_tips (
  id               bigint generated always as identity primary key,
  -- The catering deal. bigint, matching shifts.deal_id: the deals table lives
  -- in the same Postgres but belongs to the CRM app, so like shifts.deal_id
  -- this is a marker, not a foreign key (see migration_17).
  deal_id          bigint,
  -- Who paid, as it appears on the Square invoice. Evidence for the human
  -- reading the ledger, never a join key: §3.4 is explicit that matching on
  -- Square's customer name is how the wrong deal gets credited.
  payer            text,
  tip_cents        integer     not null check (tip_cents >= 0),
  -- When the money arrived (Square), and when the work happened (the deal).
  -- The gap between them is the whole reason this table exists.
  paid_date        date        not null,
  event_date       date,
  status           text        not null check (status in ('held','released','pre_window')),
  released_in_run  date,
  -- The Square payment this row is, when it is known. Unique where set, so
  -- re-importing an invoice export cannot enter the same money twice.
  source_payment_id text,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.held_tips drop constraint if exists held_tips_release_ck;
alter table public.held_tips add constraint held_tips_release_ck
  check ((status = 'released') = (released_in_run is not null));

create unique index if not exists held_tips_source_payment_key
  on public.held_tips (source_payment_id)
  where source_payment_id is not null;

-- The second guard against a double entry, for rows with no Square payment id
-- to key on: the same deal, payer, date and amount is the shape the phantom
-- $100 had (Geraci and Burlington were one payment against deal 25188).
-- Entered twice on purpose? Give one of them a source_payment_id, or a
-- distinguishing note is not enough — this index means the ledger would rather
-- refuse than quietly double-count money.
create unique index if not exists held_tips_natural_key
  on public.held_tips (deal_id, payer, paid_date, tip_cents)
  where source_payment_id is null and deal_id is not null;

create index if not exists held_tips_status_idx on public.held_tips (status, event_date);
create index if not exists held_tips_run_idx    on public.held_tips (released_in_run);

create or replace function public.touch_held_tips_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists held_tips_touch on public.held_tips;
create trigger held_tips_touch
  before update on public.held_tips
  for each row execute function public.touch_held_tips_updated_at();

-- Manager-only, read and write. Tips are pay: an employee must not be able to
-- read the whole ledger, and certainly not move a row into a run.
alter table public.held_tips enable row level security;

drop policy if exists held_tips_manager_all on public.held_tips;
create policy held_tips_manager_all on public.held_tips for all to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
