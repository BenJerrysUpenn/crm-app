-- ============================================================================
-- Withers CRM — migration crm/013: shared storage for the Email campaigns
-- sequence editor
--   email_campaign_sequences          one sequence per tier x category
--   email_campaign_lane_blocks        one signature + footer per tier (lane)
--   email_campaign_sequence_conflicts browser copies kept aside on import
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/013_email_campaign_sequences.sql
-- then check it with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/013_email_campaign_sequences_verify.sql
-- Undo: supabase/crm/013_email_campaign_sequences_down.sql (it drops every
-- saved sequence; read its header first).
-- Idempotent: safe to re-run. Needs public.is_manager() and auth.users.
-- Apply BEFORE deploying the crm-app commit that reads these tables: until
-- then /email-campaigns shows the seeded copy and says edits cannot be saved.
--
-- WHY
-- ---
-- The sequence editor on /email-campaigns saved every edit to the browser's
-- localStorage only (keys email-campaigns-proto:sequence:v1:<tier>:<category>
-- and email-campaigns-proto:lane:v1:<tier>). Work written on one computer was
-- invisible to everyone else and lost with the browser's site data. These
-- tables hold the shared copy instead. Nothing here changes what Apollo or
-- warm_sender sends: neither reads these tables.
--
-- WHAT THIS ADDS
-- --------------
-- email_campaign_sequences: key is "<tier>:<category key>" (e.g.
-- "warm:corporate"), the same key the page uses. name and steps are the
-- editor's SequenceDoc (lib/emailCampaignsPrototype/sequences.ts); steps is a
-- JSON array of {id, waitDays, subject, body, sentAs?}. No row means the
-- page shows the seed in sequences.ts (or "+ Add sequence" when there is
-- none). "Reset to original" deletes the row.
--
-- email_campaign_lane_blocks: one row per tier (cold, warm, offer) holding
-- the lane's editable signature and footer. No row means the seed
-- (SEED_LANE_BLOCKS). Reset deletes the row.
--
-- email_campaign_sequence_conflicts: when the page uploads a browser's old
-- localStorage copy and the shared row already holds DIFFERENT content, the
-- shared row is kept and the browser copy is stored here, with a snapshot of
-- the shared copy it lost to, so nothing is lost. kind is 'sequence' or
-- 'lane'; doc is the browser copy (a SequenceDoc or {signature, footer}).
-- The same browser copy is stored once (unique on kind, key, md5 of doc).
-- resolved_at is null until an owner has dealt with it; the page shows a
-- notice for every unresolved row. Nothing in the app deletes a conflict.
--
-- updated_by / created_by are the signed-in user (auth.users.id); a deleted
-- login leaves null.
--
-- WHO MAY DO WHAT
-- ---------------
-- Managers (and owners: is_manager() is true for both) read and write the
-- sequences and lane blocks, and read, insert and resolve conflicts, through
-- the crm-app route handlers app/api/email-campaigns/sequences/** running as
-- the signed-in user. There is no DELETE on conflicts for anyone but the
-- table owner (the SQL editor). anon gets nothing. Wrapped as
-- (select is_manager()) so it is evaluated once per statement, not per row.
--
-- QUERIES
-- -------
-- Unresolved conflicts, newest first:
--   SELECT id, kind, key, created_at, doc, shared_doc
--     FROM public.email_campaign_sequence_conflicts
--    WHERE resolved_at IS NULL
--    ORDER BY created_at DESC;
-- Keep the browser copy instead of the shared one (sequence conflict <id>):
--   BEGIN;
--   UPDATE public.email_campaign_sequences s
--      SET name = c.doc->>'name', steps = c.doc->'steps', updated_at = now()
--     FROM public.email_campaign_sequence_conflicts c
--    WHERE c.id = <id> AND c.kind = 'sequence' AND s.key = c.key;
--   UPDATE public.email_campaign_sequence_conflicts SET resolved_at = now() WHERE id = <id>;
--   COMMIT;
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- email_campaign_sequences
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_campaign_sequences (
  key        text        PRIMARY KEY
                         CHECK (key ~ '^(cold|warm|offer):.+$' AND length(key) <= 200),
  name       text        NOT NULL DEFAULT '',
  steps      jsonb       NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(steps) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.email_campaign_sequences IS
  'Shared copy of the /email-campaigns sequence editor (crm/013). key = '
  '<tier>:<category key>; steps = [{id, waitDays, subject, body, sentAs?}]. '
  'No row = the seed in lib/emailCampaignsPrototype/sequences.ts. Not read by '
  'Apollo or warm_sender. Managers read and write.';

ALTER TABLE public.email_campaign_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers full access to email_campaign_sequences" ON public.email_campaign_sequences;
CREATE POLICY "managers full access to email_campaign_sequences"
  ON public.email_campaign_sequences FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

REVOKE ALL ON public.email_campaign_sequences FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.email_campaign_sequences FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_campaign_sequences TO authenticated;

-- ---------------------------------------------------------------------------
-- email_campaign_lane_blocks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_campaign_lane_blocks (
  tier       text        PRIMARY KEY CHECK (tier IN ('cold', 'warm', 'offer')),
  signature  text        NOT NULL DEFAULT '',
  footer     text        NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid        DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL
);

COMMENT ON TABLE public.email_campaign_lane_blocks IS
  'Shared signature and footer per /email-campaigns lane (crm/013). No row = '
  'SEED_LANE_BLOCKS in lib/emailCampaignsPrototype/sequences.ts. Not read by '
  'Apollo or warm_sender. Managers read and write.';

ALTER TABLE public.email_campaign_lane_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers full access to email_campaign_lane_blocks" ON public.email_campaign_lane_blocks;
CREATE POLICY "managers full access to email_campaign_lane_blocks"
  ON public.email_campaign_lane_blocks FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

REVOKE ALL ON public.email_campaign_lane_blocks FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.email_campaign_lane_blocks FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.email_campaign_lane_blocks TO authenticated;

-- ---------------------------------------------------------------------------
-- email_campaign_sequence_conflicts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.email_campaign_sequence_conflicts (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text        NOT NULL CHECK (kind IN ('sequence', 'lane')),
  key         text        NOT NULL CHECK (btrim(key) <> '' AND length(key) <= 200),
  doc         jsonb       NOT NULL CHECK (jsonb_typeof(doc) = 'object'),
  shared_doc  jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE SET NULL,
  resolved_at timestamptz
);

COMMENT ON TABLE public.email_campaign_sequence_conflicts IS
  'Browser copies of /email-campaigns sequences (kind sequence) or lane blocks '
  '(kind lane) that differed from the shared row when uploaded (crm/013). The '
  'shared row was kept; doc is the browser copy, shared_doc the shared copy at '
  'the time. resolved_at null = shown on the page. Managers read, insert and '
  'resolve; nobody deletes from the app.';

-- One row per distinct browser copy: re-running the upload is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS email_campaign_sequence_conflicts_doc_uidx
  ON public.email_campaign_sequence_conflicts (kind, key, md5(doc::text));

CREATE INDEX IF NOT EXISTS email_campaign_sequence_conflicts_open_idx
  ON public.email_campaign_sequence_conflicts (kind, key)
  WHERE resolved_at IS NULL;

ALTER TABLE public.email_campaign_sequence_conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read email_campaign_sequence_conflicts" ON public.email_campaign_sequence_conflicts;
CREATE POLICY "managers read email_campaign_sequence_conflicts"
  ON public.email_campaign_sequence_conflicts FOR SELECT TO authenticated
  USING ((select public.is_manager()));

DROP POLICY IF EXISTS "managers insert email_campaign_sequence_conflicts" ON public.email_campaign_sequence_conflicts;
CREATE POLICY "managers insert email_campaign_sequence_conflicts"
  ON public.email_campaign_sequence_conflicts FOR INSERT TO authenticated
  WITH CHECK ((select public.is_manager()));

DROP POLICY IF EXISTS "managers resolve email_campaign_sequence_conflicts" ON public.email_campaign_sequence_conflicts;
CREATE POLICY "managers resolve email_campaign_sequence_conflicts"
  ON public.email_campaign_sequence_conflicts FOR UPDATE TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

-- No DELETE policy, so RLS refuses every delete from anon and authenticated.
-- The grants say it too.
REVOKE ALL ON public.email_campaign_sequence_conflicts FROM anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.email_campaign_sequence_conflicts FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.email_campaign_sequence_conflicts TO authenticated;

COMMIT;
