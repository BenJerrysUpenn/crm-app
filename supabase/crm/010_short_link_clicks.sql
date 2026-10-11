-- ============================================================================
-- Withers CRM — migration crm/010: short links on benjerryphilly.com
--   short_link_codes  (per-deal codes, written by Catering-Manager)
--   short_link_clicks (click log, written by the crm-app middleware)
-- Alina, 2026-10-10
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/010_short_link_clicks.sql
-- Idempotent: safe to re-run. Needs public.deals (Catering-Manager) and
-- public.is_manager(). Undo:
--   DROP TABLE IF EXISTS public.short_link_clicks;
--   DROP TABLE IF EXISTS public.short_link_codes;
--
-- Numbered 010 because open crm-app PR #48 already claims 009.
-- Catering-Manager PR #14 (below-min decline email) writes short_link_codes,
-- so this file must be applied before that PR ships.
--
-- WHAT THIS ADDS
-- --------------
-- short_link_codes: one code per catering deal. Catering-Manager mints it when
-- it drafts the below-minimum decline email and prints the links as
-- benjerryphilly.com/cake/<code> and benjerryphilly.com/uber-eats/<code>.
-- A code is 6 characters from abcdefghjkmnpqrstuvwxyz23456789 (no i, l, o, 0
-- or 1), stored lowercase; the CHECK below enforces it. deal_id is unique, so
-- a deal has at most one code, used on every slug. Deleting a deal deletes
-- its code.
--
-- short_link_clicks: one row per request for a short link (lib/shortLinks.ts
-- holds the slug -> destination table). A row says which link, which code
-- (if any), which deal that code belongs to, when, and what fetched it. No IP
-- address is stored.
--   * code is the path after the slug, lowercased: null for a bare /cake.
--     It is recorded even when malformed or unknown.
--   * deal_id is set only when code is a well-formed code found in
--     short_link_codes. It has no foreign key on purpose: a click must never
--     be lost because a deal was deleted between lookup and insert.
--
-- is_probable_bot is true for HEAD requests, a missing user agent, and user
-- agents of link scanners and unfurlers (Microsoft Safe Links, Google,
-- Barracuda, Mimecast, ...). Those rows are kept so the flag can be audited;
-- counts leave them out.
--
-- WHO MAY DO WHAT
-- ---------------
-- short_link_codes
--   * Catering-Manager inserts and reads it over a direct psycopg connection.
--     Its DSN (DATABASE_URL, the Supabase pooler) logs in as the `postgres`
--     role (read back 2026-10-10: current_user = postgres, rolbypassrls = t,
--     and postgres owns public.deals). It owns this table too when the file
--     runs from the SQL editor or with that DSN. The explicit grant below
--     says so either way.
--   * The crm-app middleware reads it with the service role (lookup only).
--   * Managers read. anon and authenticated never write.
-- short_link_clicks
--   * Written only by the crm-app middleware through the service role, which
--     bypasses RLS. Managers read. Nobody else reads or writes, and there is
--     no update or delete path at all.
--
-- QUERIES (bots excluded)
-- -----------------------
-- Clicks per link per week:
--   SELECT slug, date_trunc('week', clicked_at AT TIME ZONE 'America/New_York') AS week,
--          count(*) AS clicks,
--          count(*) FILTER (WHERE deal_id IS NOT NULL) AS clicks_with_deal
--     FROM public.short_link_clicks
--    WHERE NOT is_probable_bot
--    GROUP BY 1, 2
--    ORDER BY 2 DESC, 1;
--
-- Clicks per deal per link:
--   SELECT c.deal_id,
--          concat_ws(' ', d.contact_first_name, d.contact_last_name) AS contact,
--          d.company,
--          c.slug,
--          count(*)          AS clicks,
--          min(c.clicked_at) AS first_click,
--          max(c.clicked_at) AS last_click
--     FROM public.short_link_clicks c
--     LEFT JOIN public.deals d ON d.id = c.deal_id
--    WHERE NOT c.is_probable_bot
--      AND c.deal_id IS NOT NULL
--    GROUP BY c.deal_id, d.contact_first_name, d.contact_last_name, d.company, c.slug
--    ORDER BY last_click DESC;
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- short_link_codes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.short_link_codes (
  code       text        PRIMARY KEY CHECK (code ~ '^[a-hj-km-np-z2-9]{6}$'),
  deal_id    bigint      NOT NULL UNIQUE REFERENCES public.deals (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.short_link_codes IS
  'One short-link code per catering deal (crm/010), printed as '
  'benjerryphilly.com/<slug>/<code>. 6 chars from abcdefghjkmnpqrstuvwxyz23456789, '
  'lowercase. Written by Catering-Manager (postgres role); read by the crm-app '
  'middleware (service role) and managers.';

ALTER TABLE public.short_link_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "managers read short_link_codes" ON public.short_link_codes;
CREATE POLICY "managers read short_link_codes"
  ON public.short_link_codes
  FOR SELECT
  TO authenticated
  USING ((select public.is_manager()));

REVOKE ALL ON public.short_link_codes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.short_link_codes FROM authenticated;
GRANT SELECT ON public.short_link_codes TO authenticated;
GRANT SELECT ON public.short_link_codes TO service_role;
-- Catering-Manager's writer. A no-op when postgres owns the table, which it
-- does when this file runs as postgres; stated so it holds either way.
GRANT SELECT, INSERT ON public.short_link_codes TO postgres;

-- ---------------------------------------------------------------------------
-- short_link_clicks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.short_link_clicks (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            text        NOT NULL CHECK (btrim(slug) <> ''),
  clicked_at      timestamptz NOT NULL DEFAULT now(),
  user_agent      text,
  referer         text,
  is_probable_bot boolean     NOT NULL DEFAULT false,
  code            text,
  deal_id         bigint
);

-- In case an earlier draft of this file (without the code columns) was run.
ALTER TABLE public.short_link_clicks
  ADD COLUMN IF NOT EXISTS code    text,
  ADD COLUMN IF NOT EXISTS deal_id bigint;

COMMENT ON TABLE public.short_link_clicks IS
  'One row per request for a benjerryphilly.com short link (crm/010). slug is '
  'the link (lib/shortLinks.ts); code is the path after the slug (null when '
  'bare); deal_id is the deal that code belongs to (null when bare, malformed '
  'or unknown). is_probable_bot flags HEAD requests and link scanners so counts '
  'can exclude them. No IP is stored. Written only by the crm-app middleware '
  'with the service role; managers read.';

CREATE INDEX IF NOT EXISTS short_link_clicks_slug_clicked_at_idx
  ON public.short_link_clicks (slug, clicked_at);

CREATE INDEX IF NOT EXISTS short_link_clicks_deal_id_idx
  ON public.short_link_clicks (deal_id)
  WHERE deal_id IS NOT NULL;

ALTER TABLE public.short_link_clicks ENABLE ROW LEVEL SECURITY;

-- Managers read. Wrapped as (select is_manager()) so it is evaluated once per
-- statement rather than once per row (the crm-app RLS rule).
DROP POLICY IF EXISTS "managers read short_link_clicks" ON public.short_link_clicks;
CREATE POLICY "managers read short_link_clicks"
  ON public.short_link_clicks
  FOR SELECT
  TO authenticated
  USING ((select public.is_manager()));

-- No INSERT/UPDATE/DELETE policy exists, so RLS already refuses every write
-- from anon and authenticated. The grants say it too.
REVOKE ALL ON public.short_link_clicks FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.short_link_clicks FROM authenticated;
GRANT SELECT ON public.short_link_clicks TO authenticated;
GRANT SELECT, INSERT ON public.short_link_clicks TO service_role;

COMMIT;
