-- ============================================================================
-- Withers CRM — migration crm/011: personal-finance category corrections
--   pf_category_overrides (written by /money's change-category button)
-- bj-finance #223, Alina's rulings of 2026-10-10
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/011_pf_category_overrides.sql
-- then check it with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/011_pf_category_overrides_verify.sql
-- Undo: supabase/crm/011_pf_category_overrides_down.sql.
-- Idempotent: safe to re-run.
--
-- Numbered 011: open PR #48 claims 009 and crm/010 is short links.
--
-- WHAT THIS ADDS
-- --------------
-- One row per correction Alina makes on /money:
--   * scope 'transaction' — "just this one": txn_id is Monarch's transaction
--     Id (the feed's `id`), and only that transaction changes.
--   * scope 'merchant' — "every charge from this merchant" (the default):
--     merchant is the merchant name exactly as /money shows it (the feed's
--     `m`, the first 38 characters), matched case-insensitively. txn_id holds
--     the row the button was pressed on, for the record.
--   * category is one of Monarch's category names, byte for byte (one of them
--     ends in a space). The app checks it against the list the feed publishes
--     (meta.categories); the 08:00 bookkeeping pass ignores and reports any
--     name it cannot assign.
-- Rows are append-only. A later correction for the same transaction or
-- merchant wins; there is no update or delete path, so the table is also the
-- history of every correction. The 08:00 pass reads it, applies it, and folds
-- merchant corrections into the private repo's rules doc as rules.
--
-- WHO MAY DO WHAT
-- ---------------
-- The table holds household finance data, and the shared project's roles do
-- not say who is household: store staff hold `manager` too. So the database
-- admits NOBODY through the API roles, and the app decides who is household:
--   * anon and authenticated: no privileges, and RLS on with no policy, so
--     even a stray grant would show them nothing.
--   * service_role (crm-app server only, after lib/pf/access.ts has checked
--     the caller is an owner): SELECT and INSERT. No UPDATE or DELETE.
--   * postgres (the 08:00 pass's direct DSN, read only in practice) owns the
--     table and bypasses RLS.
-- One owner gate (profiles.role, time-app migration 42) therefore governs both
-- the pages and this table.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pf_category_overrides (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope      text        NOT NULL CHECK (scope IN ('transaction', 'merchant')),
  txn_id     text        CHECK (txn_id IS NULL OR btrim(txn_id) <> ''),
  merchant   text        NOT NULL CHECK (btrim(merchant) <> '' AND length(merchant) <= 200),
  category   text        NOT NULL CHECK (btrim(category) <> '' AND length(category) <= 100),
  created_by uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pf_category_overrides_txn_needs_id
    CHECK (scope <> 'transaction' OR txn_id IS NOT NULL)
);

COMMENT ON TABLE public.pf_category_overrides IS
  'Category corrections Alina makes on /money (crm/011, bj-finance #223). '
  'Append-only; newest per transaction or merchant wins. Written and read only '
  'by the crm-app server (service role) after the owner gate (lib/pf/access.ts); '
  'read by the 08:00 personal bookkeeping pass. anon/authenticated: nothing.';

CREATE INDEX IF NOT EXISTS pf_category_overrides_created_at_idx
  ON public.pf_category_overrides (created_at);

ALTER TABLE public.pf_category_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.pf_category_overrides FROM anon;
REVOKE ALL ON public.pf_category_overrides FROM authenticated;
REVOKE ALL ON public.pf_category_overrides FROM service_role;
GRANT SELECT, INSERT ON public.pf_category_overrides TO service_role;

COMMIT;
