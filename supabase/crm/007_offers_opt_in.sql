-- ============================================================================
-- Withers CRM — migration crm/007: "Yes, send me offers" opt-in
-- bj-finance #425 (owners' ruling 2026-09-27)
--
-- Run once in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/crm/007_offers_opt_in.sql
-- Idempotent: safe to re-run, including over the first version of this file
-- (applied 2026-09-27): CREATE OR REPLACE for the function, ADD COLUMN IF NOT
-- EXISTS for the one new column. Requires crm/003 (the partial unique index on
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
-- 3. outreach_offer_consents.lifted_suppression — when the yes lifted an
--    earlier suppression, what that suppression was (see below).
--
-- AN OPT-IN AFTER A SUPPRESSION IS AN OPT-IN (owners' ruling 2026-09-27)
-- -------------------------------------------------------------------------
-- "When we get an opt in after a suppress they've given up their opt out and
-- have opted in." So a suppressed address is NOT refused. In the same
-- transaction as the consent row, the function:
--   * removes the address's outreach_suppression row. A channel 'both' row
--     (a call-desk "do not call or email") is narrowed to channel 'phone'
--     with the email cleared instead of deleted: the person said yes to
--     EMAIL, and that is not a yes to phone calls;
--   * records what was lifted (id, reason, source, suppressed_at, channel,
--     whether a phone suppression was kept) in the consent row's
--     lifted_suppression and in the 'opted_in' event's detail, so the audit
--     trail shows the opt-out, the yes that overrode it, and when;
--   * resets a prospect whose status is 'suppressed' to 'sequenced' if it
--     has been mailed (last_outreach_at set: always true in practice, since
--     the only way to the button is a warm send) and to 'raw' if not. Either
--     way it does not re-enter the warm queue: 'sequenced' fails the view's
--     status = 'raw' test, and the view (Catering-Manager outreach/migrations/
--     009) excludes every explicit opt-in regardless of status.
-- Only status 'dead' (test and invalid rows) is still refused.
-- Catering-Manager's bounce_reader (and the Apollo pass that feeds it) will
-- not re-suppress the address on evidence dated before opt_in_at; a newer
-- opt-out still suppresses.
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
-- and warm_sender.py's still_sendable re-checks it per email. The same file
-- also excludes the Offer tier's other half, anyone who booked in the last 12
-- months (ever_booked AND last_event_date >= current_date - 12 months), which
-- is the definition the CRM's Email campaigns tab uses.
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
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  lifted_suppression jsonb
);

-- Added after the first version of this file was applied, so it is also an
-- ALTER: CREATE TABLE IF NOT EXISTS does not add a column to a table that
-- already exists.
ALTER TABLE public.outreach_offer_consents
  ADD COLUMN IF NOT EXISTS lifted_suppression jsonb;

COMMENT ON COLUMN public.outreach_offer_consents.lifted_suppression IS
  'NULL unless this yes overrode an earlier opt-out. Then the suppression it '
  'lifted: {id, reason, source, suppressed_at, channel, phone_kept} from '
  'outreach_suppression, and status_before when the prospect was marked '
  'suppressed (owners'' ruling 2026-09-27: an opt-in after a suppression is an '
  'opt-in).';

COMMENT ON TABLE public.outreach_offer_consents IS
  'Proof of opt-in to the monthly offers mail (bj-finance #425): one row per '
  'person per "Yes, send me offers" button press that changed their opt-in. '
  'email is the address as stored at the time (lowercased, trimmed); '
  'consent_text is the exact statement the page showed; page_version names '
  'the page; lifted_suppression is the opt-out this yes overrode, if any. '
  'Written only by public.outreach_offers_opt_in (crm/007).';

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
--   { "opted_in": true,  "already": false, "refused": null, "lifted": bool }
--       first yes, or a yes after an opt-out: consent row + opt-in on the
--       prospect + 'opted_in' event, together. "lifted" says whether an
--       earlier suppression was removed in the same transaction.
--   { "opted_in": false, "already": true,  "refused": null, ... }  repeat:
--       they had already said yes here and nothing has suppressed them since.
--       NOTHING is written.
--   { "opted_in": false, "already": false, "refused": "dead", ... }
--       the prospect's status is 'dead' (a test or invalid row). NOTHING is
--       written.
--   "email_present": false when the row has no address (the route cannot
--       reach this; the function is safe on its own terms anyway).
--   "opted_in_at": the prospect's opt_in_at after the call, so a repeat press
--       shows the date they first said yes.
--
-- Idempotency is decided under a row lock on the prospect (and on the
-- suppression row, if there is one), so two presses racing each other write
-- one consent row. A prospect already opted in on the 'booked' basis who
-- presses the button is UPGRADED to 'explicit_yes' and gets a consent row:
-- that is new consent. So is an explicit yes that an unsubscribe, bounce or
-- complaint came after: the new press lifts it and is recorded as a new yes.
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
  SELECT nullif(lower(btrim(p.email)), ''), p.status, p.opt_in_at,
         (p.marketing_opt_in AND p.opt_in_source IS NOT DISTINCT FROM 'explicit_yes'),
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

  -- Already said yes here, and nothing has opted them out since.
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
  'same transaction and records it (lifted_suppression). Refuses only a '
  '''dead'' prospect; writes nothing on a repeat. Returns {opted_in, already, '
  'refused, email_present, lifted, opted_in_at}.';

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
