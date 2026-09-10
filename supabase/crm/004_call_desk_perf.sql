-- ============================================================================
-- Withers CRM — migration crm/004: call desk query performance
-- bj-finance #409 follow-up: "Could not load the queue. canceling statement
-- due to statement timeout" (authenticated role has statement_timeout = 8s).
--
-- Root cause (EXPLAIN ANALYZE as the authenticated manager role, 2026-09-10):
-- every RLS policy on deals / outreach_prospects / outreach_events /
-- outreach_suppression is `USING (is_manager())`. is_manager() is a STABLE
-- SECURITY DEFINER SQL function, so the planner cannot inline it and calls it
-- once PER ROW of every sequential scan the call_desk_queue view performs
-- (20k prospects + 21k events + 9.7k deals). 0.9 s as postgres, 4.8 s as the
-- manager, over 8 s under load. Wrapping the call as a scalar subquery,
-- `(select is_manager())`, makes it an InitPlan evaluated once per statement.
-- Same rule, same security, ~50x fewer calls. Plus three indexes the view's
-- joins were missing.
--
-- Idempotent: safe to re-run. Does not change who can see what.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "managers full access to deals" ON public.deals;
CREATE POLICY "managers full access to deals"
  ON public.deals FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

DROP POLICY IF EXISTS "managers full access to outreach_prospects" ON public.outreach_prospects;
CREATE POLICY "managers full access to outreach_prospects"
  ON public.outreach_prospects FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

DROP POLICY IF EXISTS "managers full access to outreach_events" ON public.outreach_events;
CREATE POLICY "managers full access to outreach_events"
  ON public.outreach_events FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

DROP POLICY IF EXISTS "managers full access to outreach_suppression" ON public.outreach_suppression;
CREATE POLICY "managers full access to outreach_suppression"
  ON public.outreach_suppression FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

DROP POLICY IF EXISTS "managers write deal_form_options" ON public.deal_form_options;
CREATE POLICY "managers write deal_form_options"
  ON public.deal_form_options FOR ALL TO authenticated
  USING ((select public.is_manager())) WITH CHECK ((select public.is_manager()));

-- The view joins deals to prospects on lower(btrim(contact_email)).
CREATE INDEX IF NOT EXISTS deals_contact_email_norm_idx
  ON public.deals (lower(btrim(contact_email)))
  WHERE contact_email IS NOT NULL;

-- The queue is only sequenced / called_lost prospects with a phone.
CREATE INDEX IF NOT EXISTS outreach_prospects_call_desk_idx
  ON public.outreach_prospects (status, last_outreach_at DESC)
  WHERE phone IS NOT NULL;

-- last_reply / last_inquiry look only at these two events.
CREATE INDEX IF NOT EXISTS outreach_events_reply_idx
  ON public.outreach_events (prospect_id, occurred_at DESC)
  WHERE event IN ('replied', 'interested');

COMMIT;
