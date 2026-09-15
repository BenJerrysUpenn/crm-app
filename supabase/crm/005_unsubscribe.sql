-- ============================================================================
-- Withers CRM — migration crm/005: one-click unsubscribe
-- bj-finance #440 (RFC 8058 List-Unsubscribe-Post for the warm lane)
--
-- Run once in the Supabase SQL editor (or: psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- -f supabase/crm/005_unsubscribe.sql). Idempotent: safe to re-run.
-- Requires crm/003 (the partial unique index this function's ON CONFLICT
-- names, and the `channel` column it fills).
--
-- WHAT THIS ADDS
-- --------------
-- One function. No new tables, no new columns, no new policies, and — this is
-- the point — no widening of any vocabulary:
--
--   * `outreach_events.event = 'unsubscribed'` is already permitted. It was
--     added by Catering-Manager outreach/migrations/005_bounce_reader.sql
--     (bj-finance #407) and both crm/001 and crm/003 carry it forward in their
--     re-statements of outreach_events_event_check. Nothing here touches that
--     constraint.
--   * `outreach_prospects.status = 'suppressed'` is already permitted by
--     outreach_prospects_status_check (crm/003), and is already what
--     call_desk_do_not_call writes.
--   * `outreach_suppression.reason = 'unsubscribe'` and
--     `channel = 'email'` are already permitted and are what
--     outreach/bounce_reader.py writes on every opt-out today.
--
-- WHY A FUNCTION AND NOT THREE CLIENT WRITES
-- ------------------------------------------
-- Two reasons, and either alone would be enough.
--
-- 1. Atomicity. The suppression row and the event row have to land together or
--    not at all. bounce_reader.py learned this the expensive way (#407): an
--    event insert that fails inside the same transaction rolls the suppression
--    back with it, and the person who asked to be left alone stays on the send
--    list. Here the ordering is the other way round but the requirement is the
--    same — one transaction.
--
-- 2. `ON CONFLICT (email) WHERE email IS NOT NULL`. outreach_suppression_email_uniq
--    is a PARTIAL unique index (crm/003), so the conflict target must repeat
--    the predicate or Postgres raises "there is no unique or exclusion
--    constraint matching the ON CONFLICT specification" on every single row.
--    That exact error made bounce_reader.py a silent no-op from the day it
--    shipped. supabase-js cannot express a predicated conflict target at all,
--    which settles it: the write belongs in SQL.
--
-- The insert's own row count — not a prior SELECT — is what decides whether
-- the event row is written. A second press of the same button therefore
-- writes nothing, and the event log cannot accumulate one row per press.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- outreach_one_click_unsubscribe(prospect_id, source, via, user_agent)
-- ---------------------------------------------------------------------------
--
-- Called by app/api/unsubscribe/[token]/route.ts through the service-role
-- client, AFTER that handler has verified the token's HMAC against the
-- address stored on the prospect. This function does not and cannot check the
-- token: it trusts its caller, which is why EXECUTE is granted to service_role
-- only and not to authenticated or anon.
--
-- Returns jsonb: { "suppressed": bool, "email_present": bool }.
--   suppressed=true   -> a suppression row, an 'unsubscribed' event and the
--                        status change all landed, in one transaction.
--   suppressed=false  -> that address was already on outreach_suppression.
--                        Nothing was written. This is the normal answer to a
--                        repeat press and is not an error.
--
-- `p_source` is the dated provenance string the outreach tables use
-- everywhere: 'one-click-YYYY-MM-DD' for an RFC 8058 post from a mail
-- provider, 'link-YYYY-MM-DD' when a human pressed the button on the page.
-- `p_via` ('rfc8058' | 'link') says the same thing on the event's detail JSON.
CREATE OR REPLACE FUNCTION public.outreach_one_click_unsubscribe(
  p_prospect_id bigint,
  p_source      text,
  p_via         text DEFAULT 'rfc8058',
  p_user_agent  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_email    text;
  v_inserted int;
BEGIN
  SELECT nullif(lower(btrim(p.email)), '')
    INTO v_email
    FROM public.outreach_prospects p
   WHERE p.id = p_prospect_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outreach_one_click_unsubscribe: prospect % not found', p_prospect_id;
  END IF;

  -- No address on the row means nothing was ever mailed to it, so there is
  -- nothing to suppress. The caller cannot reach this (it verifies the MAC
  -- over that same address first), but the function is stated to be safe on
  -- its own terms.
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('suppressed', false, 'email_present', false);
  END IF;

  -- The predicate is repeated because the index is partial. See the header.
  INSERT INTO public.outreach_suppression (email, channel, reason, source)
  VALUES (v_email, 'email', 'unsubscribe', p_source)
  ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    -- Already suppressed. Deliberately does NOT re-stamp the status or write
    -- a second event: the request is honoured, and honouring it again is a
    -- no-op, not a new fact.
    RETURN jsonb_build_object('suppressed', false, 'email_present', true);
  END IF;

  UPDATE public.outreach_prospects
     SET status     = 'suppressed',
         updated_at = now()
   WHERE id = p_prospect_id;

  INSERT INTO public.outreach_events (prospect_id, event, occurred_at, detail)
  VALUES (p_prospect_id, 'unsubscribed', now(),
          jsonb_build_object('via', p_via,
                             'source', p_source,
                             'user_agent', p_user_agent,
                             'endpoint', 'crm-app /api/unsubscribe/[token]'));

  RETURN jsonb_build_object('suppressed', true, 'email_present', true);
END;
$$;

COMMENT ON FUNCTION public.outreach_one_click_unsubscribe(bigint, text, text, text) IS
  'One-click unsubscribe write (bj-finance #440), called by crm-app '
  '/api/unsubscribe/[token] after it has verified the token HMAC. Suppression '
  'row + ''unsubscribed'' event + status=''suppressed'' in one transaction, '
  'and only when the suppression row actually landed. Returns '
  '{suppressed, email_present}.';

-- The route handler runs as the service role (no user session exists — the
-- recipient is not a CRM user). Nobody else has any business calling this, so
-- PUBLIC's default EXECUTE is revoked rather than left in place.
REVOKE EXECUTE ON FUNCTION public.outreach_one_click_unsubscribe(bigint, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.outreach_one_click_unsubscribe(bigint, text, text, text) TO service_role;

COMMIT;
