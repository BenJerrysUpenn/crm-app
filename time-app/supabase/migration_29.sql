-- ============================================================================
-- Withers Time — migration 29: shifts_deal_slot_uidx becomes a plain unique
-- index, so ON CONFLICT (deal_id, deal_slot) can find it
-- Run once in the Supabase SQL editor (or psql against the direct DSN), after
-- migration_18.sql. Safe to re-run.
--
-- VERIFY. supabase/migration_29_verify.sql. ROLLBACK. supabase/migration_29_down.sql.
--
-- THE BREAK (crm-app #35). Migration 18 made the one-shift-per-crew-slot rule a
-- PARTIAL unique index:
--
--   create unique index shifts_deal_slot_uidx
--     on public.shifts (deal_id, deal_slot) where deal_id is not null;
--
-- The web routes insert catering draft shifts through supabase-js
-- (supabaseShiftStore in lib/cateringShifts.ts):
--
--   upsert(rows, { onConflict: "deal_id,deal_slot", ignoreDuplicates: true })
--
-- which PostgREST sends as ON CONFLICT (deal_id, deal_slot) DO NOTHING, with no
-- WHERE. Postgres cannot infer a partial index without its predicate, so every
-- insert is refused: "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification". POST /api/deals/:id/booked-shifts answers 500 and
-- GET /api/cron/catering-shifts records every deal as failed. PostgREST has no
-- way to send the predicate, so the index has to change, not the call.
--
-- THE FIX. The same rule on a plain unique index. It allows and refuses exactly
-- the same rows: a unique index treats NULLs as distinct, so shifts with no
-- deal_id (every non-catering shift) never conflict with each other, just as
-- they were outside the partial index before. Live on 2026-09-27: 237 shifts,
-- 34 with a deal_id, none with a deal_id and no deal_slot, no duplicate
-- (deal_id, deal_slot) pair.
--
-- BOTH ON CONFLICT SHAPES WORK AFTERWARDS. The route's bare
-- ON CONFLICT (deal_id, deal_slot) now matches the plain index. The local CLI
-- (lib/cateringShiftsPg.ts) sends ON CONFLICT (deal_id, deal_slot)
-- WHERE deal_id IS NOT NULL, and a predicate there still infers a plain unique
-- index: "Any indexes that satisfy the predicate (which need not actually be
-- partial indexes) can be inferred" (PostgreSQL docs, INSERT, index_predicate).
-- migration_29_verify.sql EXPLAINs both shapes.
--
-- NEVER A WINDOW WITHOUT THE RULE. One transaction: the new index is built
-- under a temporary name BEFORE the old one is dropped, then renamed, so the
-- final name is still shifts_deal_slot_uidx and at no instant can a duplicate
-- slot slip in. CREATE UNIQUE INDEX (not CONCURRENTLY, which cannot run in a
-- transaction) holds a SHARE lock on shifts while it builds; on a 160 kB table
-- that is milliseconds, and clock-ins only read shifts.
--
-- RE-RUN. If shifts_deal_slot_uidx is already the plain index this does
-- nothing. If a previous run was interrupted and left the temporary index
-- behind, it is dropped and rebuilt.
--
-- REVERT (also supabase/migration_29_down.sql; same create-before-drop order):
--
--   begin;
--   drop index if exists public.shifts_deal_slot_uidx_partial;
--   create unique index shifts_deal_slot_uidx_partial
--     on public.shifts (deal_id, deal_slot) where deal_id is not null;
--   drop index public.shifts_deal_slot_uidx;
--   alter index public.shifts_deal_slot_uidx_partial rename to shifts_deal_slot_uidx;
--   commit;
--
-- Reverting breaks the web routes' inserts again (the CLI keeps working).
-- ============================================================================

begin;

do $$
declare
  current_def text;
begin
  select indexdef into current_def
    from pg_indexes
   where schemaname = 'public' and indexname = 'shifts_deal_slot_uidx';

  if current_def is null then
    raise exception 'public.shifts_deal_slot_uidx is missing. Apply migration_18.sql first.';
  end if;

  -- Already plain: this migration has run.
  if current_def not ilike '% where %' then
    raise notice 'migration 29: shifts_deal_slot_uidx is already a plain unique index; nothing to do';
    return;
  end if;

  -- 1. The new rule, under a temporary name, while the old one still holds.
  drop index if exists public.shifts_deal_slot_uidx_plain;
  create unique index shifts_deal_slot_uidx_plain
    on public.shifts (deal_id, deal_slot);

  -- 2. Only now drop the partial index.
  drop index public.shifts_deal_slot_uidx;

  -- 3. Keep the name every comment and doc already uses.
  alter index public.shifts_deal_slot_uidx_plain rename to shifts_deal_slot_uidx;
end $$;

comment on index public.shifts_deal_slot_uidx is
  'One shift per catering crew slot. Plain (not partial) so ON CONFLICT (deal_id, deal_slot) can infer it; NULL deal_ids never conflict. Migrations 18 and 29, crm-app #35.';

commit;
