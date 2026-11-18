-- Undo crm/014: drop the console's read policies and write functions. No loop
-- data is touched; the loop keeps running from the Catering-Manager backend,
-- and the console says the loop tables are not readable.
BEGIN;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_loop_approaches', 'outreach_loop_sequences', 'outreach_loop_send_tags',
    'outreach_loop_drafts', 'outreach_loop_arms', 'outreach_loop_runs',
    'outreach_loop_controls', 'outreach_event_estimates', 'outreach_research_views'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'managers read ' || t, t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.outreach_loop_approve(text);
DROP FUNCTION IF EXISTS public.outreach_loop_hold(bigint, text);
DROP FUNCTION IF EXISTS public.outreach_loop_release(bigint);
DROP FUNCTION IF EXISTS public.outreach_loop_pause(text);
DROP FUNCTION IF EXISTS public.outreach_loop_resume();
DROP FUNCTION IF EXISTS public.outreach_loop_who();
COMMIT;
