-- Verify crm/014: every loop table has its manager read policy, and the five
-- write functions exist, are SECURITY DEFINER, and are callable by
-- authenticated but not anon. Read only; raises on the first gap.
BEGIN READ ONLY;
DO $$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'outreach_loop_approaches', 'outreach_loop_sequences', 'outreach_loop_send_tags',
    'outreach_loop_drafts', 'outreach_loop_arms', 'outreach_loop_runs',
    'outreach_loop_controls', 'outreach_event_estimates', 'outreach_research_views'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'managers read ' || t AND cmd = 'SELECT') THEN
      RAISE EXCEPTION 'missing read policy on %', t;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'outreach_loop_approve(text)', 'outreach_loop_hold(bigint,text)', 'outreach_loop_release(bigint)',
    'outreach_loop_pause(text)', 'outreach_loop_resume()'
  ] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.' || f)) THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', f;
    END IF;
    IF NOT has_function_privilege('authenticated', 'public.' || f, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot run %', f;
    END IF;
    IF has_function_privilege('anon', 'public.' || f, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can run %', f;
    END IF;
  END LOOP;
  RAISE NOTICE 'crm/014 verified';
END $$;
ROLLBACK;
