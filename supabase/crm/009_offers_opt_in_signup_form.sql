-- ============================================================================
-- Withers CRM — migration crm/009: a signup_form opt-in is already explicit
-- bj-finance #425
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/009_offers_opt_in_signup_form.sql
-- Idempotent: CREATE OR REPLACE of one function, plus its comment and grants.
-- Requires crm/007 (the consent table this writes). No table, column, index
-- or policy changes.
--
-- ORDER MATTERS IF 007 IS EVER RE-RUN. 007 is written to be re-runnable and
-- CREATE OR REPLACEs this same function with its original body. Re-running
-- 007 after this file puts the old 'explicit_yes'-only test back; re-run this
-- file afterwards.
--
-- THE GAP THIS CLOSES
-- -------------------
-- crm/007's outreach_offers_opt_in decided "already opted in" with
--   p.marketing_opt_in AND p.opt_in_source IS NOT DISTINCT FROM 'explicit_yes'
-- Everywhere else an explicit opt-in is opt_in_source IN ('explicit_yes',
-- 'signup_form'): Catering-Manager outreach/migrations/009's warm-eligible
-- exclusion, and crm-app lib/emailCampaignsPrototype/model.ts
-- EXPLICIT_OPT_IN_SOURCES / isExplicitOptIn (the Email campaigns tiers). So a
-- signup_form person who pressed "Yes, send me offers" got a second consent
-- row and was rewritten to 'explicit_yes', losing the signup_form provenance
-- and their original opt_in_at. Harmless for tiering (both values are Offer),
-- but the function disagreed with every other reader.
--
-- WHAT CHANGES
-- ------------
-- One expression: v_explicit now uses the shared set AND requires a date.
-- Everything else in the body is crm/007's, line for line.
--
--   signup_form, DATED, not suppressed, status not 'suppressed'
--       -> { already: true }. NOTHING is written: opt_in_source stays
--          'signup_form', opt_in_at stays the form's date, no consent row, no
--          event. The confirmation page shows the form's date as "Agreed ...".
--
--   signup_form, UNDATED (opt_in_at IS NULL: an import, a form that recorded
--   no date), not suppressed
--       -> NOT already. opt_in_at is the agreement date the already branch
--          would return, and there is none to show, so this falls through to
--          the write path: a real consent row, opt_in_source -> 'explicit_yes'
--          and opt_in_at -> now(). The press itself becomes the dated proof,
--          rather than the page fabricating today's date (CODING_STANDARDS.md
--          :10, fail loudly: no silent default for missing data).
--
--   signup_form, then suppressed (unsubscribe, bounce, complaint, call-desk
--   do-not-email) or status 'suppressed', then presses yes
--       -> a real new yes, handled exactly as 007 handles any yes after an
--          opt-out: the suppression is lifted (a 'both' row narrowed to
--          'phone'), status reset, lifted_suppression recorded on the consent
--          row and the 'opted_in' event, { opted_in: true, lifted: true }.
--          opt_in_source BECOMES 'explicit_yes' and opt_in_at becomes now().
--          Decision: the opt-out ended the form consent, so the basis for
--          mailing them from here on is this button press, and its proof is
--          the consent row this writes (consent text, page version, IP, UA).
--          Keeping 'signup_form' would point at consent they had withdrawn.
--
--   Unchanged: 'booked' (implied) or no opt-in -> upgraded to 'explicit_yes'
--   with a consent row; 'explicit_yes' repeat -> already; 'dead' -> refused;
--   no address -> email_present false.
--
-- Grants, SECURITY INVOKER and search_path are as in crm/007: EXECUTE revoked
-- from PUBLIC, anon and authenticated, granted to service_role only.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- outreach_offers_opt_in(prospect_id, consent_text, page_version, ip, ua)
-- ---------------------------------------------------------------------------
-- Return shape unchanged from crm/007 (see that file for each outcome).
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
  v_email       text;
  v_status      text;
  v_opt_in_at   timestamptz;
  v_explicit    boolean;
  v_touched     boolean;
  v_supp        public.outreach_suppression%ROWTYPE;
  v_has_supp    boolean;
  v_phone_kept  boolean := false;
  v_new_status  text;
  v_lifted      jsonb;
  v_consent_id  bigint;
BEGIN
  -- Lock the row: the checks and the write below must see the same
  -- prospect, and a concurrent press must wait for this one.
  --
  -- "Explicit" is the same set everywhere (crm/009): 'explicit_yes' (this
  -- button) or 'signup_form' (they opted in on a form). coalesce, because
  -- opt_in_source may be NULL and NULL IN (...) is NULL, not false.
  --
  -- opt_in_at IS NOT NULL is part of being "already explicit": the already
  -- branch below returns opt_in_at as the agreement date the confirmation
  -- page shows, so a dateless opt-in has no proof to show. opt_in_at is
  -- nullable and nothing ties it to opt_in_source, so a signup_form row
  -- without a date (an import, a form that recorded none) is NOT treated as
  -- already; it falls through to the write path, which records a real consent
  -- row and sets opt_in_at = now(), a true date with stored proof.
  -- (explicit_yes rows are always written here with now(), so this only ever
  -- bites a dateless signup_form row.)
  SELECT nullif(lower(btrim(p.email)), ''), p.status, p.opt_in_at,
         (p.marketing_opt_in
          AND p.opt_in_at IS NOT NULL
          AND coalesce(p.opt_in_source IN ('explicit_yes', 'signup_form'), false)),
         p.last_outreach_at IS NOT NULL
    INTO v_email, v_status, v_opt_in_at, v_explicit, v_touched
    FROM public.outreach_prospects p
   WHERE p.id = p_prospect_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outreach_offers_opt_in: prospect % not found', p_prospect_id;
  END IF;

  IF v_email IS NULL THEN
    RETURN jsonb_build_object('opted_in', false, 'already', false,
                              'refused', NULL, 'email_present', false,
                              'lifted', false, 'opted_in_at', NULL);
  END IF;

  -- A test or invalid row. The only refusal left (owners' ruling
  -- 2026-09-27): a suppressed address is no longer refused, see below.
  IF v_status = 'dead' THEN
    RETURN jsonb_build_object('opted_in', false, 'already', false,
                              'refused', 'dead', 'email_present', true,
                              'lifted', false, 'opted_in_at', NULL);
  END IF;

  SELECT s.* INTO v_supp
    FROM public.outreach_suppression s
   WHERE s.email = v_email
     FOR UPDATE;
  v_has_supp := FOUND;

  -- Already an explicit opt-in (this button, or a dated signup form), and
  -- nothing has opted them out since. Nothing is written, so a signup_form
  -- person keeps opt_in_source = 'signup_form' and their original opt_in_at,
  -- which this returns as the agreement date. (A dateless opt-in never
  -- reaches here: v_explicit requires opt_in_at IS NOT NULL above.)
  IF v_explicit AND NOT v_has_supp AND v_status <> 'suppressed' THEN
    RETURN jsonb_build_object('opted_in', false, 'already', true,
                              'refused', NULL, 'email_present', true,
                              'lifted', false, 'opted_in_at', v_opt_in_at);
  END IF;

  -- The yes overrides the earlier opt-out: lift it, and keep what it was.
  IF v_has_supp THEN
    IF v_supp.channel = 'both' AND v_supp.phone IS NOT NULL THEN
      -- A call-desk "do not call or email". The yes is to email only, so the
      -- phone half stays.
      UPDATE public.outreach_suppression
         SET email = NULL, channel = 'phone'
       WHERE id = v_supp.id;
      v_phone_kept := true;
    ELSE
      DELETE FROM public.outreach_suppression WHERE id = v_supp.id;
    END IF;
  END IF;

  -- Out of 'suppressed', and never back into the warm queue: 'sequenced'
  -- fails outreach_warm_eligible's status test, and that view excludes every
  -- explicit opt-in anyway (Catering-Manager outreach/migrations/009).
  v_new_status := CASE
                    WHEN v_status <> 'suppressed' THEN v_status
                    WHEN v_touched THEN 'sequenced'
                    ELSE 'raw'
                  END;

  IF v_has_supp OR v_status = 'suppressed' THEN
    v_lifted := jsonb_strip_nulls(jsonb_build_object(
      'id',            CASE WHEN v_has_supp THEN v_supp.id END,
      'reason',        CASE WHEN v_has_supp THEN v_supp.reason END,
      'source',        CASE WHEN v_has_supp THEN v_supp.source END,
      'suppressed_at', CASE WHEN v_has_supp THEN v_supp.suppressed_at END,
      'channel',       CASE WHEN v_has_supp THEN v_supp.channel END,
      'phone_kept',    CASE WHEN v_has_supp THEN v_phone_kept END,
      'status_before', CASE WHEN v_status = 'suppressed' THEN v_status END,
      'status_after',  CASE WHEN v_status = 'suppressed' THEN v_new_status END));
  END IF;

  -- Every yes that reaches here is recorded as 'explicit_yes', including a
  -- signup_form person who opted out and then pressed the button: the opt-out
  -- ended the form consent, and the basis for mailing them now is this press,
  -- whose proof is the consent row below.
  UPDATE public.outreach_prospects
     SET marketing_opt_in = true,
         opt_in_source    = 'explicit_yes',
         opt_in_at        = now(),
         status           = v_new_status,
         updated_at       = now()
   WHERE id = p_prospect_id;

  INSERT INTO public.outreach_offer_consents
         (prospect_id, email, method, consent_text, page_version, ip,
          user_agent, lifted_suppression)
  VALUES (p_prospect_id, v_email, 'offers_button', p_consent_text,
          p_page_version, p_ip, p_user_agent, v_lifted)
  RETURNING id INTO v_consent_id;

  INSERT INTO public.outreach_events (prospect_id, event, occurred_at, detail)
  VALUES (p_prospect_id, 'opted_in', now(),
          jsonb_strip_nulls(jsonb_build_object(
                             'source', 'explicit_yes',
                             'via', 'offers_button',
                             'consent_id', v_consent_id,
                             'page_version', p_page_version,
                             'endpoint', 'crm-app /offers/[token]',
                             'lifted_suppression', v_lifted)));

  RETURN jsonb_build_object('opted_in', true, 'already', false,
                            'refused', NULL, 'email_present', true,
                            'lifted', v_lifted IS NOT NULL,
                            'opted_in_at', now());
END;
$$;

COMMENT ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text) IS
  '"Yes, send me offers" write (bj-finance #425), called by crm-app '
  '/offers/[token] after it has verified the token HMAC. Consent row + '
  'marketing_opt_in/opt_in_source=explicit_yes/opt_in_at + ''opted_in'' event '
  'in one transaction. A yes after an opt-out lifts the suppression in the '
  'same transaction and records it (lifted_suppression). An existing explicit '
  'opt-in (explicit_yes or signup_form, crm/009) with no opt-out since is a '
  'repeat and writes nothing. Refuses only a ''dead'' prospect. Returns '
  '{opted_in, already, refused, email_present, lifted, opted_in_at}.';

-- CREATE OR REPLACE keeps the existing ACL, so these are belt and braces:
-- they make the grants this file leaves behind true on their own, whatever
-- the function's history. Same as crm/007.
REVOKE EXECUTE ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.outreach_offers_opt_in(bigint, text, text, text, text) TO service_role;

COMMIT;
