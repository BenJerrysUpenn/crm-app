-- ============================================================================
-- Withers CRM — migration crm/010: short-link click log (benjerryphilly.com)
-- Alina, 2026-10-10
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/010_short_link_clicks.sql
-- Idempotent: safe to re-run. Undo:
--   DROP TABLE IF EXISTS public.short_link_clicks;
--
-- Numbered 010 because open crm-app PR #48 already claims 009.
--
-- WHAT THIS ADDS
-- --------------
-- short_link_clicks: one row per request for a short link such as
-- benjerryphilly.com/cake (lib/shortLinks.ts holds the slug -> destination
-- table). The links are bare by design, so a row says which link, when, and
-- what fetched it; never who. No IP address is stored.
--
-- is_probable_bot is true for HEAD requests, a missing user agent, and user
-- agents of link scanners and unfurlers (Microsoft Safe Links, Google,
-- Barracuda, Mimecast, ...). Those rows are kept so the flag can be audited;
-- counts leave them out.
--
-- WHO MAY DO WHAT
-- ---------------
-- Written only by crm-app's middleware through the service-role client, which
-- bypasses RLS. Managers read. Nobody else reads or writes, and there is no
-- update or delete path at all.
--
-- Clicks per link per week, bots excluded:
--   SELECT slug, date_trunc('week', clicked_at AT TIME ZONE 'America/New_York') AS week,
--          count(*) AS clicks
--     FROM public.short_link_clicks
--    WHERE NOT is_probable_bot
--    GROUP BY 1, 2
--    ORDER BY 2 DESC, 1;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.short_link_clicks (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            text        NOT NULL CHECK (btrim(slug) <> ''),
  clicked_at      timestamptz NOT NULL DEFAULT now(),
  user_agent      text,
  referer         text,
  is_probable_bot boolean     NOT NULL DEFAULT false
);

COMMENT ON TABLE public.short_link_clicks IS
  'One row per request for a benjerryphilly.com short link (crm/010). slug is '
  'the link (lib/shortLinks.ts); is_probable_bot flags HEAD requests and link '
  'scanners so counts can exclude them. No IP is stored. Written only by the '
  'crm-app middleware with the service role; managers read.';

CREATE INDEX IF NOT EXISTS short_link_clicks_slug_clicked_at_idx
  ON public.short_link_clicks (slug, clicked_at);

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
