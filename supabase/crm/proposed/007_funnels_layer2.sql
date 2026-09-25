-- ============================================================================
-- PROPOSED migration crm/007 — Funnels tab, LAYER 2 (bj-finance #422)
--
--   *** DO NOT RUN. This file is a PROPOSAL for a human (Alex) to approve. ***
--
-- It lives under supabase/crm/proposed/ ON PURPOSE: it is NOT part of the
-- applied crm/00x sequence. A migration that lands in supabase/crm/ is expected
-- to be run against the hosted Supabase project and is live for every viewer at
-- once; this one must not be, until:
--   (a) Alex approves it, AND
--   (b) the layer-2 design tickets it serves have ratified their vocabulary:
--       #392 Catering funnel design, #395 In-store campaign funnel design,
--       #396 Funnel data model, and #438 bucket/segment column names.
--
-- Layer 1 (the four supervision panels) needs NONE of this — it runs today on
-- pure reads, and derives the customer profile in TypeScript
-- (lib/funnels/profile.ts). This file is what turns the derivation into a
-- stored, human-overridable column and adds the management surfaces the body of
-- #422 specced (campaign board, advocate roster), plus the sweep_runs telemetry
-- table that closes the loop-status data gap the reframe named.
--
-- Four independent changes; approve/apply them separately if you prefer.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. deals.profile — the derived customer profile, made durable + overridable
-- ---------------------------------------------------------------------------
-- The backfill below MUST stay faithful to lib/funnels/profile.ts. If the two
-- ever disagree, the TypeScript file is the source of truth and this is stale.
-- `profile_source` records whether a human overrode the derivation, so a
-- re-backfill never clobbers a human decision.

ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS profile TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS profile_source TEXT
  CHECK (profile_source IN ('derived', 'human'));

-- Pure SQL mirror of deriveProfile(event_type, contact_email).
CREATE OR REPLACE FUNCTION public.funnels_derive_profile(p_event_type text, p_email text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  WITH n AS (
    SELECT regexp_replace(lower(coalesce(p_event_type, '')), '\s+', ' ', 'g') AS et,
           lower(coalesce(split_part(p_email, '@', 2), ''))                    AS domain
  )
  SELECT CASE
    WHEN n.domain = 'upenn.edu' OR n.domain LIKE '%.upenn.edu' THEN 'penn_account'
    WHEN n.et LIKE '%wedding%' OR n.et LIKE '%bridal%'
      OR n.et LIKE '%rehearsal%' OR n.et LIKE '%engagement%' THEN 'wedding'
    WHEN n.et LIKE '%mitzvah%' THEN 'mitzvah'
    WHEN (n.et LIKE '%corporate%' OR n.et LIKE '%employee%' OR n.et LIKE '%office%'
       OR n.et LIKE '%staff%' OR n.et LIKE '%company%' OR n.et LIKE '%team%'
       OR n.et LIKE '%work%' OR n.et LIKE '%conference%' OR n.et LIKE '%meeting%'
       OR n.et LIKE '%business%' OR n.et LIKE '%client%' OR n.et LIKE '%holiday party%')
      AND n.domain <> '' AND position('.' in n.domain) > 0
      AND n.domain NOT IN ('gmail.com','yahoo.com','ymail.com','hotmail.com',
        'outlook.com','live.com','msn.com','aol.com','icloud.com','me.com',
        'mac.com','comcast.net','verizon.net','att.net','sbcglobal.net',
        'protonmail.com','proton.me') THEN 'office_admin'
    WHEN n.et LIKE '%birthday%' OR n.et LIKE '%baby shower%'
      OR n.et LIKE '%gender reveal%' OR n.et LIKE '%family reunion%'
      THEN 'family_celebration'
    ELSE 'unclassified'
  END FROM n;
$$;

UPDATE public.deals
   SET profile = public.funnels_derive_profile(event_type, contact_email),
       profile_source = 'derived'
 WHERE profile IS NULL;

-- ---------------------------------------------------------------------------
-- 2. advocates — the referral / venue / planner roster (body of #422)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.advocates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  org         text,
  kind        text NOT NULL CHECK (kind IN
                ('event_planner','wedding_venue','referral_partner','venue_operator')),
  stage       text NOT NULL DEFAULT 'identified' CHECK (stage IN
                ('identified','contacted','activated','producing')),
  owner       text,
  notes       text,                       -- append-only, date-prefixed (see call desk convention)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.advocates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers full access to advocates" ON public.advocates;
CREATE POLICY "managers full access to advocates" ON public.advocates
  FOR ALL TO authenticated USING ((SELECT public.is_manager())) WITH CHECK ((SELECT public.is_manager()));
GRANT SELECT, INSERT, UPDATE ON public.advocates TO authenticated;
-- Seed (per #422 body): Margaret Leidy Starke (UCD), Joe Arancio (Shop Penn), Aramark.

-- ---------------------------------------------------------------------------
-- 3. store_campaigns — the campaign board (body of #422)
-- ---------------------------------------------------------------------------
-- Operating rule enforced by the CHECK: a campaign cannot be Live (or later)
-- without both counting_method and break_even filled.
CREATE TABLE IF NOT EXISTS public.store_campaigns (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            text NOT NULL,
  stream          text CHECK (stream IN ('in_store','catering','concessions')),
  stage           text NOT NULL DEFAULT 'Idea' CHECK (stage IN
                    ('Idea','Designed','Cleared','Live','Measured','Verdict')),
  counting_method text,
  cost            numeric,
  break_even      numeric,
  start_date      date,
  end_date        date,
  verdict         text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_campaigns_live_needs_measures CHECK (
    stage IN ('Idea','Designed','Cleared')
    OR (counting_method IS NOT NULL AND break_even IS NOT NULL)
  )
);
ALTER TABLE public.store_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers full access to store_campaigns" ON public.store_campaigns;
CREATE POLICY "managers full access to store_campaigns" ON public.store_campaigns
  FOR ALL TO authenticated USING ((SELECT public.is_manager())) WITH CHECK ((SELECT public.is_manager()));
GRANT SELECT, INSERT, UPDATE ON public.store_campaigns TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. sweep_runs — persist the sweep telemetry the loop-status panel wants
-- ---------------------------------------------------------------------------
-- Closes the gap named in the 2026-09-10 (2) reframe: today the envelope JSON
-- and monitor_state_v2.json live on the Mac, not Supabase, so loop-status can
-- only use DB side-effects. The catering sweep (Catering-Manager run_sweep.py)
-- would write one row per run here; the panel then shows the real last run,
-- duration, counts and errors instead of a proxy. Writing the row is a change
-- in Catering-Manager, not in this repo.
CREATE TABLE IF NOT EXISTS public.sweep_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  ok            boolean,
  actions       jsonb,      -- the envelope: what the run did
  error_message text
);
ALTER TABLE public.sweep_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "managers read sweep_runs" ON public.sweep_runs;
CREATE POLICY "managers read sweep_runs" ON public.sweep_runs
  FOR SELECT TO authenticated USING ((SELECT public.is_manager()));
GRANT SELECT ON public.sweep_runs TO authenticated;

COMMIT;
