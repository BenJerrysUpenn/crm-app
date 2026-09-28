-- ============================================================================
-- Withers CRM — migration crm/007: "Yes, send me offers" opt-in
-- bj-finance #425 (owners' ruling 2026-09-27)
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/007_offers_opt_in.sql
-- Idempotent: safe to re-run. Requires crm/003 (the partial unique index on
-- outreach_suppression.email this reads, and the prospect status vocabulary).
--
-- WHAT THIS ADDS
-- --------------
-- 1. outreach_offer_consents — the PROOF of each opt-in: who (prospect_id and
--    the address as it was at the time), how (method 'offers_button'), what
--    they agreed to (the exact consent wording the page showed, and the page
--    version), and the request's IP and user agent, with the time. Append-only
--    in practice: managers may read it, nobody but the service role may write
--    it, and there is no update or delete policy at all.
-- 2. public.outreach_offers_opt_in(...) — the one write, called by crm-app
--    app/offers/[token]/route.ts after it has verified the token.
--
-- WHAT THIS DOES NOT ADD, because it is already there
-- ---------------------------------------------------
--   * The flag on the prospect. outreach_prospects.marketing_opt_in (boolean,
--     NOT NULL DEFAULT false), opt_in_source and opt_in_at were added by
--     bj-finance outreach/migrations/005_consent_flags.sql (#280/#287), and
--     opt_in_source's CHECK already permits 'explicit_yes' — the value this
--     writes. (Live 2026-09-27: 349 rows are marketing_opt_in, all of them
--     opt_in_source = 'booked', the implied basis seeded for past bookers.)
--   * The event. 'opted_in' is already in outreach_events_event_check
--     (005_consent_flags, carried forward by crm/001, crm/003 and
--     Catering-Manager outreach/migrations/008). No vocabulary is widened.
--
-- THE WARM QUEUE
-- --------------
-- A person who says yes here is in the Offer tier and must stop getting the
-- warm intro. That is Catering-Manager's view, so it is Catering-Manager's
-- migration: outreach/migrations/009_offers_opt_in.sql excludes
-- opt_in_source IN ('explicit_yes','signup_form') from outreach_warm_eligible,
-- and warm_sender.py's still_sendable re-checks it per email.
--
-- WHY INVOKER + service_role, NOT SECURITY DEFINER
-- -----------------------------------------------
-- Same as crm/005's outreach_one_click_unsubscribe, which it mirrors. The
-- route calls it through the service-role client, which already bypasses RLS,
-- so DEFINER would add privilege and nothing else. EXECUTE is revoked from
-- PUBLIC, anon and authenticated and granted to service_role only: the
-- function trusts its caller to have verified the token, so nobody else may
-- reach it.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The consent record
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.outreach_offer_consents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prospect_id   bigint      NOT NULL REFERENCES public.outreach_prospects (id),
  email         text        NOT NULL,
  method        text        NOT NULL CHECK (method = 'offers_button'),
  consent_text  text        NOT NULL CHECK (btrim(consent_text) <> ''),
  page_version  text        NOT NULL CHECK (btrim(page_version) <> ''),
  ip            text,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outreach_offer_consents IS
  'Proof of opt-in to the monthly offers mail (bj-finance #425): one row per '
  'person per "Yes, send me offers" button press that changed their opt-in. '
  'email is the address as stored at the time (lowercased, trimmed); '
  'consent_text is the exact statement the page showed; page_version names '
  'the page. Written only by public.outreach_offers_opt_in (crm/007).';

CREATE INDEX IF NOT EXISTS outreach_offer_consents_prospect_idx
  ON public.outreach_offer_consents (prospect_id);

ALTER TABLE public.outreach_offer_consents ENABLE ROW LEVEL SECURITY;

-- Managers read. Wrapped as (select is_manager()) so it is evaluated once per
-- statement rather than once per row (the crm-app RLS rule).
DROP POLICY IF EXISTS "managers read outreach_offer_consents"
  ON public.outreach_offer_consents;
CREATE POLICY "managers read outreach_offer_consents"
  ON public.outreach_offer_consents
  FOR SELECT
  TO authenticated
  USING ((select public.is_manager()));

-- No INSERT/UPDATE/DELETE policy exists, so RLS already refuses every write
-- from anon and authenticated. The grants say it too, so the refusal does not
-- depend on nobody ever adding a permissive policy by mistake.
REVOKE ALL ON public.outreach_offer_consents FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.outreach_offer_consents FROM authenticated;
GRANT SELECT ON public.outreach_offer_consents TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. outreach_offers_opt_in(prospect_id, consent_text, page_version, ip, ua)
-- ---------------------------------------------------------------------------
--
-- Returns jsonb:
--   { "opted_in": true,  "already": false, "refused": null, ... }  first yes:
--       consent row + opt-in on the prospect + 'opted_in' event, together.
--   { "opted_in": false, "already": true,  "refused": null, ... }  repeat:
--       they had already said yes here. NOTHING is written.
--   { "opted_in": false, "already": false, "refused": "suppressed", ... }
--       the address is on outreach_suppression, or the prospect's status is
--       'suppressed' / 'dead'. NOTHING is written: a button on a page does
--       not undo an unsubscribe, a bounce, a complaint or a do-not-contact.
--   "email_present": false when the row has no address (the route cannot
--       reach this; the function is safe on its own terms anyway).
--   "opted_in_at": the prospect's opt_in_at after the call, so a repeat press
--       shows the date they first said yes.
--
-- Idempotency is decided by the UPDATE's own row count under a row lock, not
-- by a prior SELECT, so two presses racing each other write one consent row.
-- A prospect already opted in on the 'booked' basis who presses the button is
-- UPGRADED to 'explicit_yes' and gets a consent row: that is new consent.
CREATE OR REPLACE FUNCTION public.outreach_offers_opt_in(
  p_prospect_id  bigint,
  p_consent_text text,
  p_page_version text,
  p_ip           text DEFAULT NULL,
  p_user_agent   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_email      text;
  v_status     text;
  v_opt_in_at  timestamptz;
  v_updated    int;
  v_consent_id bigint;
BEGIN
  -- Lock the row: the suppression check and the write below must see the
  -- same prospect, and a concurrent press must wait for this one.
  SELECT nullif(lower(btrim(p.email)), ''), p.status, p.opt_in_at
    INTO v_email, v_status, v_opt_in_at
    FROM public.outreach_prospects p
   WHERE p.id = p_prospect_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outreach_offers_opt_in: prospect % not found', p_prospect_id;
  END IF;

  IF v_email IS NULL THEN
    RETURN jsonb_build_object('opted_in', false, 'already', false,
                              'refused', NULL, 'email_present', false,
                              'opted_in_at', NULL);
  END IF;

  IF v_status IN ('suppressed', 'dead')
     OR EXISTS (SELECT 1 FROM public.outreach_suppression s WHERE s.email = v_email)
  THEN
    RETURN jsonb_build_object('opted_in', false, 'already', false,
                              'refused', 'suppressed', 'email_present', true,
                              'opted_in_at', NULL);
  END IF;

  UPDATE public.outreach_prospects
     SET marketing_opt_in = true,
         opt_in_source    = 'explicit_yes',
         opt_in_at        = now(),
         updated_at       = now()
   WHERE id = p_prospect_id
     AND NOT (marketing_opt_in AND opt_in_source IS NOT DISTINCT FROM 'explicit_yes');

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    RETURN jsonb_build_object('opted_in', false, 'already', true,
                              'refused', NULL, 'email_present', true,
                              'opted_in_at', v_opt_in_at);
  END IF;

  INSERT INTO public.outreach_offer_consents
         (prospect_id, email, method, consent_text, page_version, ip, user_agent)
  VALUES (p_prospect_id, v_email, 'offers_button', p_consent_text,
          p_page_version, p_ip, p_user_agent)
  RETURNING id INTO v_consent_id;

  INSERT INTO public.outreach_events (prospect_id, event, occurred_at, detail)
  VALUES (p_prospect_id, 'opted_in', now(),
          jsonb_build_object('source', 'explicit_yes',
                             'via', 'offers_button',
                             'consent_id', v_consent_id,
                             'page_version', p_page_version,
                             'endpoint', 'crm-app /offers/[token]'));

  RETURN jsonb_build_object('opted_in', true, 'already', false,
                            'refused', NULL, 'email_present', true,
                            'opted_in_at', now());
END;
$$;

COMMENT ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text) IS
  '"Yes, send me offers" write (bj-finance #425), called by crm-app '
  '/offers/[token] after it has verified the token HMAC. Consent row + '
  'marketing_opt_in/opt_in_source=explicit_yes/opt_in_at + ''opted_in'' event '
  'in one transaction. Refuses a suppressed address; writes nothing on a '
  'repeat. Returns {opted_in, already, refused, email_present, opted_in_at}.';

-- FROM anon, authenticated as well as PUBLIC. Supabase's default privileges
-- grant EXECUTE on every new public function to anon and authenticated by
-- name, so revoking from PUBLIC alone leaves both in place — which is what
-- happened to crm/005's function (live proacl 2026-09-27 still lists anon and
-- authenticated). Harmless there only because it is INVOKER and RLS stops
-- them; stated properly here.
REVOKE EXECUTE ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text) TO service_role;

COMMIT;
