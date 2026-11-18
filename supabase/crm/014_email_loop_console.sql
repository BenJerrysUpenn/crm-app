-- ============================================================================
-- Withers CRM — migration crm/014: the Email campaigns console reads and
-- steers the weekly email loop
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/014_email_loop_console.sql
-- then check it with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/014_email_loop_console_verify.sql
-- Undo: supabase/crm/014_email_loop_console_down.sql (drops the policies and
-- functions only; no loop data is touched).
-- Idempotent: safe to re-run. Needs public.is_manager(), auth.jwt(), and the
-- Catering-Manager loop tables through outreach/migrations/022_loop_console.sql
-- (held drafts, outreach_loop_controls, the run's limits and occasions).
-- Apply AFTER the crm-app commit that reads these tables shows Vercel success
-- on main: until then the console says the loop tables are not readable yet.
--
-- WHY
-- ---
-- The weekly email loop (bj-finance #964) plans, judges and sends its own
-- emails from the Catering-Manager backend. Its tables have row security on
-- and no policy, so a signed-in manager could read none of it. Alina,
-- 2026-11-17, on the console prototype (bj-finance #811): "yes build, but you
-- can go all the way with it, rather than having read only". So managers read
-- the loop, and may do exactly five things to it.
--
-- WHO MAY DO WHAT
-- ---------------
-- Read: managers (and owners: is_manager() is true for both) SELECT every
-- loop table, as on the other outreach tables. Wrapped as
-- (select is_manager()) so it is evaluated once per statement, not per row.
-- anon gets nothing.
--
-- Write: no INSERT, UPDATE or DELETE policy. A manager changes the loop only
-- through these SECURITY DEFINER functions, each one UPDATE, each checking
-- is_manager() first and stamping the signed-in email:
--   outreach_loop_approve(approach)       an approach's emails may send
--                                         (approved_at/approved_by; once)
--   outreach_loop_hold(draft, reason)     one planned email will not send
--   outreach_loop_release(draft)          a held email goes back to planned
--   outreach_loop_pause(reason)           the daily sender sends nothing
--   outreach_loop_resume()                the daily sender sends again
-- None of them sends, writes copy, or changes a limit (limits stay in
-- sales/loop/limits.toml, changed only by a PR that quotes Alina).
-- ============================================================================

BEGIN;

-- --- read policies -----------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_loop_approaches', 'outreach_loop_sequences', 'outreach_loop_send_tags',
    'outreach_loop_drafts', 'outreach_loop_arms', 'outreach_loop_runs',
    'outreach_loop_controls', 'outreach_event_estimates', 'outreach_research_views'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'managers read ' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((select public.is_manager()))',
      'managers read ' || t, t);
  END LOOP;
END $$;

-- --- the five writes ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.outreach_loop_who()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who text := nullif(auth.jwt() ->> 'email', '');
BEGIN
  IF NOT coalesce(public.is_manager(), false) THEN
    RAISE EXCEPTION 'Only managers can change the email loop' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce(who, 'a manager');
END $$;

CREATE OR REPLACE FUNCTION public.outreach_loop_approve(p_approach text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who text := public.outreach_loop_who();
BEGIN
  UPDATE outreach_loop_approaches
     SET approved_at = now(), approved_by = who
   WHERE id = p_approach AND approved_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No approach % waiting for approval', p_approach USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.outreach_loop_hold(p_draft bigint, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who text := public.outreach_loop_who();
BEGIN
  UPDATE outreach_loop_drafts
     SET status = 'held', held_at = now(), held_by = who,
         held_reason = coalesce(nullif(btrim(p_reason), ''), 'Held from the console')
   WHERE id = p_draft AND status = 'planned';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Email % is not waiting to send', p_draft USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.outreach_loop_release(p_draft bigint)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who text := public.outreach_loop_who();
BEGIN
  UPDATE outreach_loop_drafts
     SET status = 'planned', held_at = NULL, held_by = NULL, held_reason = NULL
   WHERE id = p_draft AND status = 'held';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Email % is not held (released by %)', p_draft, who USING ERRCODE = 'P0002';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.outreach_loop_pause(p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who text := public.outreach_loop_who();
BEGIN
  UPDATE outreach_loop_controls
     SET paused_at = now(), paused_by = who,
         pause_reason = coalesce(nullif(btrim(p_reason), ''), 'Paused from the console'),
         updated_at = now()
   WHERE id AND paused_at IS NULL;
END $$;

CREATE OR REPLACE FUNCTION public.outreach_loop_resume()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.outreach_loop_who();
  UPDATE outreach_loop_controls
     SET paused_at = NULL, paused_by = NULL, pause_reason = NULL, updated_at = now()
   WHERE id AND paused_at IS NOT NULL;
END $$;

REVOKE ALL ON FUNCTION public.outreach_loop_who() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outreach_loop_approve(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outreach_loop_hold(bigint, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outreach_loop_release(bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outreach_loop_pause(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.outreach_loop_resume() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.outreach_loop_approve(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_loop_hold(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_loop_release(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_loop_pause(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_loop_resume() TO authenticated;

COMMIT;
