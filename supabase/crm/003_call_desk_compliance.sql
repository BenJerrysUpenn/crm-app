-- ============================================================================
-- Withers CRM — migration crm/003: lawful-dial gate for the call desk
-- bj-finance #420 (windows, phone DNC, hours, script, scrub slot, policy)
-- bj-finance #421 ("Not now / lost" outcome that keeps the email list)
--
-- Run once in the Supabase SQL editor (or: psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- -f supabase/crm/003_call_desk_compliance.sql). Idempotent: safe to re-run.
-- Requires crm/001 and crm/002 to have been applied first.
--
-- LEGAL BASIS (research: bj-finance docs/call-desk-consent-and-calling-rules.md,
-- branch research/call-desk-consent; not legal advice)
-- ---------------------------------------------------------------------------
-- Nobody on this list ever consented to a phone call: the corporate enquiry
-- form's only checkbox says "email and online advertising" and names Ben &
-- Jerry's, not us. A live human dialling by hand sits outside the consent half
-- of the TCPA (47 U.S.C. §227(b) after Facebook v. Duguid), so what governs
-- this desk is the do-not-call regime, where the permission that matters is an
-- established business relationship the law grants automatically: 18 months
-- from a purchase and 3 months from an enquiry federally
-- (47 C.F.R. §64.1200(f)(5)), 540/90 days under the FTC's rule
-- (16 C.F.R. §310.4(b)(1)(iii)(B)(ii)), and only 12 months in Pennsylvania
-- (73 P.S. §2245). We take the shortest clock in every case — 12 months from
-- the last paid booking, 90 days from the last inbound reply — and, critically,
-- **our own outbound emails create no window at all**: an EBR runs from what
-- the customer did, never from what we sent them. 47 C.F.R. §64.1200(d)
-- separately requires a written policy, training and an internal do-not-call
-- list that outlives any relationship, which is why `outreach_suppression`
-- gains a phone key here and why entries are permanent (built to Delaware's
-- 10-year standard, 6 Del. C. §2506A). Calling hours are set to PA Act 47 of
-- 2026's 9 a.m.–7 p.m., Monday to Saturday, no legal holidays, ahead of its
-- 2026-10-18 effective date so habits do not have to change later; the hours
-- gate itself lives in TypeScript (lib/callDesk/compliance.ts), not here.
--
-- WHAT THIS DOES
-- --------------
-- 1. outreach_suppression can hold a phone number: + phone, + channel
--    (email|phone|both), a surrogate id primary key so a phone-only row is
--    storable, and partial unique indexes on each key.
-- 2. outreach_prospects gains the registry-scrub slot: dnc_status
--    (unknown|clear|national|pa_list|internal) + dnc_checked_at, and the
--    status vocabulary gains 'called_lost' (#421).
-- 3. outreach_events vocabulary gains 'lost' (#421).
-- 4. call_desk_queue is redefined (full definition copied from crm/002, edited)
--    with the relationship window, the normalised phone, the phone-suppression
--    flag and the scrub columns. Phone-suppressed rows never appear.
-- 5. RPCs: call_desk_do_not_call gains the phone write; call_desk_mark_lost and
--    call_desk_reopen are new (#421); call_desk_dnc_import bulk-stamps a
--    registry scrub.
--
-- NOT touched: `deals` (owned by Catering-Manager modules/db.py), the warm
-- sender's views (outreach_warm_eligible / outreach_recontact_queue), the
-- storage bucket and deal_form_options from crm/001.
--
-- WHY 'called_lost' IS SAFE FOR EMAIL (#421)
-- ------------------------------------------
-- outreach_warm_eligible admits `p.status not in ('suppressed','dead')` and
-- outreach_recontact_queue admits `p.status <> 'suppressed'`
-- (outreach/migrations/003_single_touch_and_exclusion.sql). 'called_lost' is
-- neither, so a prospect marked lost on the phone stays exactly as eligible for
-- marketing email as they were the minute before. Nothing here writes
-- outreach_suppression and nothing here touches marketing_opt_in.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Phone normalisation — one definition, used by the index, the view and
--    the RPCs. Mirrors normalizePhone() in lib/callDesk/compliance.ts.
--    Digits only; a leading US country code is dropped so (215) 555-0134,
--    215-555-0134 and +1 215 555 0134 are one number.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.normalize_phone(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
           WHEN s.d IS NULL OR s.d = ''                       THEN NULL
           WHEN length(s.d) = 11 AND left(s.d, 1) = '1'       THEN right(s.d, 10)
           ELSE s.d
         END
    FROM (SELECT regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') AS d) s;
$$;

COMMENT ON FUNCTION public.normalize_phone(text) IS
  'Digits-only phone key for the internal do-not-call list (bj-finance #420). '
  'Drops a leading 1 on 11-digit US numbers. IMMUTABLE so it can index.';

GRANT EXECUTE ON FUNCTION public.normalize_phone(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 1. outreach_suppression can hold a phone number
-- ---------------------------------------------------------------------------
--
-- The table was `email text primary key` (outreach/outreach_store.sql), which
-- makes a phone-only entry unstorable — and a phone-only entry is exactly what
-- 47 C.F.R. §64.1200(d)(3) requires when someone says "stop calling" and we
-- have no address for them. So: a surrogate id becomes the primary key, email
-- becomes nullable with its own partial unique index, and phone joins it.
--
-- Written as three guarded steps so a re-run is a no-op: the PK swap only fires
-- while the PK is still (email), and every index/column add is IF NOT EXISTS.

ALTER TABLE public.outreach_suppression
  ADD COLUMN IF NOT EXISTS phone text;

ALTER TABLE public.outreach_suppression
  ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';

-- Re-created rather than added-if-missing so the vocabulary is stated once.
ALTER TABLE public.outreach_suppression
  DROP CONSTRAINT IF EXISTS outreach_suppression_channel_check;
ALTER TABLE public.outreach_suppression
  ADD CONSTRAINT outreach_suppression_channel_check
  CHECK (channel IN ('email', 'phone', 'both'));

-- Drop the (email) primary key, but ONLY if that is still what it is: after a
-- first run the PK is (id) and this block must do nothing.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.conrelid = 'public.outreach_suppression'::regclass
     AND c.contype = 'p'
     AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
            FROM unnest(c.conkey) k
            JOIN pg_attribute a
              ON a.attrelid = c.conrelid AND a.attnum = k) = ARRAY['email'];
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.outreach_suppression DROP CONSTRAINT %I', v_conname);
  END IF;
END
$$;

-- Surrogate key. bigserial in ADD COLUMN creates the sequence and the default;
-- IF NOT EXISTS makes the second run a no-op.
ALTER TABLE public.outreach_suppression
  ADD COLUMN IF NOT EXISTS id bigserial;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.outreach_suppression'::regclass AND contype = 'p'
  ) THEN
    EXECUTE 'ALTER TABLE public.outreach_suppression '
            'ADD CONSTRAINT outreach_suppression_pkey PRIMARY KEY (id)';
  END IF;
END
$$;

-- A phone-only row has no email. (No-op when email is already nullable.)
ALTER TABLE public.outreach_suppression ALTER COLUMN email DROP NOT NULL;

-- Both keys stay unique, each ignoring the rows that don't carry it. Partial,
-- so ON CONFLICT against them must repeat the WHERE clause (the RPCs below
-- check-then-insert instead, because one statement cannot name two targets).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_suppression_email_uniq
  ON public.outreach_suppression (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS outreach_suppression_phone_uniq
  ON public.outreach_suppression (phone) WHERE phone IS NOT NULL;

COMMENT ON COLUMN public.outreach_suppression.phone IS
  'Digits-only phone (public.normalize_phone), the internal do-not-call key '
  '(47 C.F.R. §64.1200(d)(3)). Entries are permanent — built to the 10-year '
  'Delaware standard and never expired by any job.';
COMMENT ON COLUMN public.outreach_suppression.channel IS
  'What this row suppresses: email, phone, or both. A do-not-call taken on a '
  'call writes both when we hold an address for them.';

-- The RPCs run SECURITY INVOKER, so the caller needs the new sequence.
DO $$
DECLARE
  v_seq text := pg_get_serial_sequence('public.outreach_suppression', 'id');
BEGIN
  IF v_seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO authenticated', v_seq);
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. outreach_prospects: the registry-scrub slot, and the 'called_lost' status
-- ---------------------------------------------------------------------------

ALTER TABLE public.outreach_prospects
  ADD COLUMN IF NOT EXISTS dnc_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.outreach_prospects
  ADD COLUMN IF NOT EXISTS dnc_checked_at timestamptz;

ALTER TABLE public.outreach_prospects
  DROP CONSTRAINT IF EXISTS outreach_prospects_dnc_status_check;
ALTER TABLE public.outreach_prospects
  ADD CONSTRAINT outreach_prospects_dnc_status_check
  CHECK (dnc_status IN ('unknown', 'clear', 'national', 'pa_list', 'internal'));

COMMENT ON COLUMN public.outreach_prospects.dnc_status IS
  'Registry scrub result (bj-finance #420). unknown = never scrubbed; clear = '
  'the last import did not list this number; national / pa_list = listed on '
  'that registry, never dial; internal = they told us to stop. Only "clear" '
  'with a dnc_checked_at inside 31 days unblocks an out-of-window row.';
COMMENT ON COLUMN public.outreach_prospects.dnc_checked_at IS
  'When the scrub that produced dnc_status ran. The FTC expects a re-scrub at '
  'least every 31 days (16 C.F.R. §310.4(b)(3)(iv)), so the desk treats an '
  'older "clear" as stale and re-blocks the row.';

-- Status vocabulary + 'called_lost' (#421). Re-created whole, the way crm/001
-- re-created the events check, so this file alone says what is allowed.
DO $$
DECLARE
  v_conname text;
BEGIN
  SELECT c.conname INTO v_conname
    FROM pg_constraint c
   WHERE c.conrelid = 'public.outreach_prospects'::regclass
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%status%'
     AND pg_get_constraintdef(c.oid) ILIKE '%sequenced%'
   LIMIT 1;
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.outreach_prospects DROP CONSTRAINT %I', v_conname);
  END IF;
END
$$;

ALTER TABLE public.outreach_prospects
  ADD CONSTRAINT outreach_prospects_status_check
  CHECK (status = ANY (ARRAY[
    'raw', 'enriched', 'queued', 'sequenced', 'replied', 'handed_off',
    'suppressed', 'dead',
    'called_lost'
  ]));

COMMENT ON CONSTRAINT outreach_prospects_status_check ON public.outreach_prospects IS
  'Prospect status vocabulary. "called_lost" added by crm-app '
  'supabase/crm/003_call_desk_compliance.sql (bj-finance #421): no sale on the '
  'phone this time. It drops the row out of the call desk''s default view and '
  'is deliberately NOT "suppressed" or "dead", so outreach_warm_eligible and '
  'outreach_recontact_queue keep admitting them — they stay on the email list.';

-- ---------------------------------------------------------------------------
-- 3. outreach_events vocabulary: + 'lost'
-- ---------------------------------------------------------------------------
--
-- 'suppressed' would be a lie (nothing is suppressed) and 'handed_off' means
-- the opposite of what happened, so the outcome gets its own event.

ALTER TABLE public.outreach_events DROP CONSTRAINT IF EXISTS outreach_events_event_check;
ALTER TABLE public.outreach_events
  ADD CONSTRAINT outreach_events_event_check
  CHECK (event = ANY (ARRAY[
    'added', 'enriched', 'sequenced', 'delivered', 'bounced', 'unsubscribed',
    'replied', 'interested', 'handed_off', 'deal_created', 'booked',
    'suppressed', 'opted_in', 'called',
    'lost'
  ]));

COMMENT ON CONSTRAINT outreach_events_event_check ON public.outreach_events IS
  'Permitted event vocabulary. "called" added by crm/001 (bj-finance #409); '
  '"lost" added by crm/003 (bj-finance #421) — a call ended with no sale this '
  'time, detail JSON carries by, via, call_event_id, deal_id. The call row '
  'itself keeps disposition = "lost" in its own detail.';

-- ---------------------------------------------------------------------------
-- 4. The queue, redefined: only numbers that may lawfully be dialled
-- ---------------------------------------------------------------------------
--
-- crm/002's definition with four additions, all marked:
--   * last_paid / last_inquiry -> ebr_basis, ebr_expires_on, ebr_active
--   * phone_digits + phone_suppressed (and phone-suppressed rows are excluded)
--   * dnc_status + dnc_checked_at carried through from the prospect
--   * status 'called_lost' is admitted so the desk can offer a "Lost" segment
--     and a Reopen button; the client hides those rows by default.
--
-- The window arithmetic, in one place:
--   purchase_expires_on = last paid booking's EVENT DATE + 12 months   (PA)
--   inquiry_expires_on  = last inbound reply/interest    + 90 days     (PA)
--   ebr_expires_on      = the later of the two (GREATEST ignores NULLs)
--   ebr_basis           = which of the two produced it
--   ebr_active          = ebr_expires_on >= today, Eastern
-- Our own outbound email is deliberately absent: last_outreach_at creates no
-- window. "Today" is Eastern, not UTC, so the desk does not expire a row five
-- hours early in the evening.

DROP VIEW IF EXISTS public.call_desk_queue;
CREATE VIEW public.call_desk_queue
WITH (security_invoker = true) AS
WITH last_call AS (
  SELECT DISTINCT ON (e.prospect_id)
         e.prospect_id,
         e.id           AS last_call_event_id,
         e.occurred_at  AS last_call_at,
         e.detail->>'disposition' AS last_disposition,
         e.detail->>'by'          AS last_call_by
    FROM public.outreach_events e
   WHERE e.event = 'called'
   ORDER BY e.prospect_id, e.occurred_at DESC, e.id DESC
),
call_counts AS (
  SELECT prospect_id, count(*) AS calls_count
    FROM public.outreach_events
   WHERE event = 'called'
   GROUP BY prospect_id
),
last_reply AS (
  SELECT prospect_id, max(occurred_at) AS last_reply_at
    FROM public.outreach_events
   WHERE event IN ('replied', 'interested')
   GROUP BY prospect_id
),
last_deal AS (
  SELECT DISTINCT ON (lower(btrim(d.contact_email)))
         lower(btrim(d.contact_email)) AS email,
         d.id          AS last_deal_id,
         d.stage       AS last_deal_stage,
         d.event_type  AS last_event_type,
         d.event_date  AS last_deal_event_date
    FROM public.deals d
   WHERE (d.archived = 0 OR d.legacy_sf_id IS NOT NULL)
     AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
   ORDER BY lower(btrim(d.contact_email)), d.event_date DESC NULLS LAST, d.id DESC
),
last_booked AS (
  SELECT DISTINCT ON (lower(btrim(d.contact_email)))
         lower(btrim(d.contact_email)) AS email,
         d.package_name AS booked_package_name,
         d.event_type   AS booked_event_type,
         d.guest_count  AS booked_guest_count
    FROM public.deals d
   WHERE (d.archived = 0 OR d.legacy_sf_id IS NOT NULL)
     AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
     AND (d.stage IN ('Booked Unpaid', 'Booked Paid', 'Event Complete')
          OR coalesce(d.payment_status, 'None') <> 'None'
          OR coalesce(d.amount_paid, 0) > 0)
   ORDER BY lower(btrim(d.contact_email)), d.event_date DESC NULLS LAST, d.id DESC
),
-- NEW (#420): the purchase leg of the relationship window. The clock runs from
-- the EVENT date of the last booking that money touched — the date the customer
-- last actually did business with us. deals.event_date is TEXT and sometimes
-- carries a time after the date, so it is cut to 10 characters and only parsed
-- when it really looks like a date; a malformed row contributes nothing rather
-- than raising. Legacy Salesforce rows count, exactly as in last_booked.
last_paid AS (
  SELECT lower(btrim(d.contact_email)) AS email,
         max(left(d.event_date, 10)::date) AS last_paid_event_date
    FROM public.deals d
   WHERE (d.archived = 0 OR d.legacy_sf_id IS NOT NULL)
     AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
     AND d.event_date IS NOT NULL
     AND left(d.event_date, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     AND (d.stage IN ('Booked Unpaid', 'Booked Paid', 'Event Complete')
          OR coalesce(d.amount_paid, 0) > 0)
   GROUP BY lower(btrim(d.contact_email))
),
base AS (
  SELECT p.id                 AS prospect_id,
         p.name,
         p.company,
         p.title,
         p.phone,
         p.email,
         p.city,
         p.category,
         p.status,
         p.last_outreach_at,
         p.ever_booked,
         p.deal_count,
         p.lifetime_value,
         p.last_event_date,
         p.notes,
         -- last contact of any kind, and what kind it was
         CASE
           WHEN lc.last_call_at IS NOT NULL
                AND lc.last_call_at >= coalesce(p.last_outreach_at, '-infinity'::timestamptz)
                AND lc.last_call_at >= coalesce(lr.last_reply_at,   '-infinity'::timestamptz)
             THEN 'call'
           WHEN lr.last_reply_at IS NOT NULL
                AND lr.last_reply_at >= coalesce(p.last_outreach_at, '-infinity'::timestamptz)
             THEN 'reply'
           WHEN p.last_outreach_at IS NOT NULL THEN 'email'
           ELSE NULL
         END                  AS last_contact_type,
         greatest(p.last_outreach_at, lc.last_call_at, lr.last_reply_at) AS last_contact_at,
         lc.last_call_event_id,
         lc.last_call_at,
         lc.last_disposition,
         lc.last_call_by,
         -- a call was logged but never dispositioned: the UI must resolve it
         CASE WHEN lc.last_call_event_id IS NOT NULL AND lc.last_disposition IS NULL
              THEN lc.last_call_event_id END AS pending_disposition_event_id,
         coalesce(cc.calls_count, 0) AS calls_count,
         ld.last_deal_id,
         ld.last_deal_stage,
         ld.last_event_type,
         ld.last_deal_event_date,
         lb.booked_package_name AS party_type_booked,
         lb.booked_event_type,
         lb.booked_guest_count,
         -- NEW (#420): the two legs of the relationship window, raw
         lp.last_paid_event_date,
         lr.last_reply_at AS last_inquiry_at,
         -- NEW (#420): the do-not-call keys
         public.normalize_phone(p.phone) AS phone_digits,
         (sp.phone IS NOT NULL)          AS phone_suppressed,
         p.dnc_status,
         p.dnc_checked_at
    FROM public.outreach_prospects p
    LEFT JOIN public.outreach_suppression s
           ON s.email = lower(btrim(p.email))
    -- NEW (#420): the internal do-not-call list, by phone
    LEFT JOIN public.outreach_suppression sp
           ON sp.phone = public.normalize_phone(p.phone)
    LEFT JOIN last_call   lc ON lc.prospect_id = p.id
    LEFT JOIN call_counts cc ON cc.prospect_id = p.id
    LEFT JOIN last_reply  lr ON lr.prospect_id = p.id
    LEFT JOIN last_deal   ld ON ld.email = lower(btrim(p.email))
    LEFT JOIN last_booked lb ON lb.email = lower(btrim(p.email))
    LEFT JOIN last_paid   lp ON lp.email = lower(btrim(p.email))
   -- CHANGED (#421): 'called_lost' rides along so the desk can show a "Lost"
   -- segment and a Reopen button. The client hides them by default.
   WHERE p.status IN ('sequenced', 'called_lost')
     AND s.email IS NULL
     -- NEW (#420): a number on our internal do-not-call list is never offered,
     -- to anyone, ever. This is the one exclusion with no toggle behind it.
     AND sp.phone IS NULL
     AND p.phone IS NOT NULL AND btrim(p.phone) <> ''
),
windows AS (
  SELECT b.*,
         (b.last_paid_event_date + interval '12 months')::date       AS purchase_expires_on,
         ((b.last_inquiry_at AT TIME ZONE 'America/New_York')::date
            + 90)                                                    AS inquiry_expires_on
    FROM base b
)
SELECT w.*,
       CASE
         WHEN w.purchase_expires_on IS NULL AND w.inquiry_expires_on IS NULL THEN NULL
         WHEN w.inquiry_expires_on  IS NULL THEN 'purchase'
         WHEN w.purchase_expires_on IS NULL THEN 'inquiry'
         WHEN w.purchase_expires_on >= w.inquiry_expires_on THEN 'purchase'
         ELSE 'inquiry'
       END AS ebr_basis,
       greatest(w.purchase_expires_on, w.inquiry_expires_on) AS ebr_expires_on,
       coalesce(
         greatest(w.purchase_expires_on, w.inquiry_expires_on)
           >= (now() AT TIME ZONE 'America/New_York')::date,
         false
       ) AS ebr_active
  FROM windows w
 ORDER BY w.last_outreach_at DESC NULLS LAST, w.prospect_id;

COMMENT ON VIEW public.call_desk_queue IS
  'Call desk queue (bj-finance #409/#414/#420/#421): warm-outreach prospects '
  'with a phone that is not on the internal do-not-call list, carrying the '
  'established-business-relationship window (12 months from the last paid '
  'booking, 90 days from the last inbound reply — our own emails create no '
  'window), the registry-scrub slot, and prospects marked lost on the phone. '
  'Defined by crm-app supabase/crm/003_call_desk_compliance.sql, superseding '
  'the definitions in 001 and 002.';

GRANT SELECT ON public.call_desk_queue TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Write helpers (RPC), all SECURITY INVOKER like crm/001's
-- ---------------------------------------------------------------------------

-- 5a. Do-not-call, now with a phone key.
--
-- Replaces the crm/001 body. Same three writes as before — suppression,
-- status, event — plus: the suppression row now carries the phone (channel
-- 'both' when we hold an address, 'phone' when we do not), and the prospect is
-- stamped dnc_status = 'internal' so the desk can say why it is blocked even
-- if the suppression row is ever reached by a different path.
--
-- Check-then-write rather than ON CONFLICT: the email and phone unique indexes
-- are both partial, and one INSERT cannot name two conflict targets.
CREATE OR REPLACE FUNCTION public.call_desk_do_not_call(p_prospect_id bigint, p_call_event_id bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_phone text;
  v_by    text;
  v_have_email_row boolean;
  v_phone_taken    boolean;
BEGIN
  v_by := coalesce(auth.jwt() ->> 'email', 'unknown');

  SELECT nullif(lower(btrim(p.email)), ''), public.normalize_phone(p.phone)
    INTO v_email, v_phone
    FROM public.outreach_prospects p
   WHERE p.id = p_prospect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_desk_do_not_call: prospect % not found', p_prospect_id;
  END IF;

  v_phone_taken := v_phone IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.outreach_suppression WHERE phone = v_phone);

  IF v_email IS NOT NULL THEN
    v_have_email_row := EXISTS (
      SELECT 1 FROM public.outreach_suppression WHERE email = v_email);

    IF v_have_email_row THEN
      -- Widen the existing email entry to cover the phone, unless some other
      -- row already owns that number (the partial unique index would refuse).
      UPDATE public.outreach_suppression
         SET phone   = CASE WHEN v_phone_taken THEN phone ELSE coalesce(phone, v_phone) END,
             channel = CASE WHEN v_phone IS NOT NULL THEN 'both' ELSE channel END
       WHERE email = v_email;
    ELSE
      INSERT INTO public.outreach_suppression (email, phone, channel, reason, source)
      VALUES (v_email,
              CASE WHEN v_phone_taken THEN NULL ELSE v_phone END,
              CASE WHEN v_phone IS NOT NULL AND NOT v_phone_taken THEN 'both' ELSE 'email' END,
              'manual', 'call_desk:' || v_by);
    END IF;
  ELSIF v_phone IS NOT NULL AND NOT v_phone_taken THEN
    -- No address for them: a phone-only entry, which is the whole reason this
    -- table grew a surrogate key.
    INSERT INTO public.outreach_suppression (email, phone, channel, reason, source)
    VALUES (NULL, v_phone, 'phone', 'manual', 'call_desk:' || v_by);
  END IF;

  UPDATE public.outreach_prospects
     SET status = 'suppressed',
         dnc_status = 'internal',
         dnc_checked_at = now(),
         updated_at = now()
   WHERE id = p_prospect_id;

  INSERT INTO public.outreach_events (prospect_id, event, detail)
  VALUES (p_prospect_id, 'suppressed',
          jsonb_build_object('by', v_by, 'via', 'call_desk',
                             'disposition', 'do_not_call',
                             'call_event_id', p_call_event_id,
                             'phone', v_phone,
                             'channel', CASE WHEN v_phone IS NULL THEN 'email' ELSE 'both' END,
                             'reason', 'manual'));
END;
$$;

-- 5b. "Not now / lost (keep emailing)" (#421).
--
-- Four writes in one transaction: the prospect leaves the call queue, the call
-- row records the outcome, the notes carry a dated line, and a 'lost' event
-- goes on the audit log. Nothing touches outreach_suppression and nothing
-- touches marketing_opt_in — that is the entire point of the outcome.
CREATE OR REPLACE FUNCTION public.call_desk_mark_lost(
  p_prospect_id bigint,
  p_call_event_id bigint DEFAULT NULL,
  p_deal_id bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_by   text;
  v_line text;
BEGIN
  v_by := coalesce(auth.jwt() ->> 'email', 'unknown');

  UPDATE public.outreach_prospects
     SET status = 'called_lost', updated_at = now()
   WHERE id = p_prospect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_desk_mark_lost: prospect % not found', p_prospect_id;
  END IF;

  -- The call's own outcome. Merged, so duration / note / recording survive.
  IF p_call_event_id IS NOT NULL THEN
    UPDATE public.outreach_events
       SET detail = coalesce(detail, '{}'::jsonb)
                    || jsonb_build_object('disposition', 'lost',
                                          'dispositioned_at', to_char(now() AT TIME ZONE 'UTC',
                                                                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     WHERE id = p_call_event_id AND event = 'called';
  END IF;

  v_line := '[' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')
            || ' ET] (' || v_by || ') Not now / lost — off the call queue, '
            || 'still on the email list.';
  UPDATE public.outreach_prospects
     SET notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v_line
                      ELSE notes || E'\n' || v_line END,
         updated_at = now()
   WHERE id = p_prospect_id;

  INSERT INTO public.outreach_events (prospect_id, event, detail)
  VALUES (p_prospect_id, 'lost',
          jsonb_build_object('by', v_by, 'via', 'call_desk',
                             'call_event_id', p_call_event_id,
                             'deal_id', p_deal_id));
END;
$$;

-- 5c. Undo the above: back into the call queue, nothing else disturbed.
CREATE OR REPLACE FUNCTION public.call_desk_reopen(p_prospect_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_by   text;
  v_line text;
  v_status text;
BEGIN
  v_by := coalesce(auth.jwt() ->> 'email', 'unknown');

  SELECT status INTO v_status FROM public.outreach_prospects WHERE id = p_prospect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_desk_reopen: prospect % not found', p_prospect_id;
  END IF;
  -- Only a lost row reopens. A suppressed one must never be revived this way:
  -- a do-not-call request outlives every relationship and every UI mistake.
  IF v_status <> 'called_lost' THEN
    RAISE EXCEPTION 'call_desk_reopen: prospect % is "%", not "called_lost"',
      p_prospect_id, v_status;
  END IF;

  v_line := '[' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')
            || ' ET] (' || v_by || ') Reopened for calling.';
  UPDATE public.outreach_prospects
     SET status = 'sequenced',
         notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v_line
                      ELSE notes || E'\n' || v_line END,
         updated_at = now()
   WHERE id = p_prospect_id;
END;
$$;

-- 5d. Registry scrub import (#420).
--
-- Stamps dnc_status / dnc_checked_at across the base from a list of numbers.
-- Matching numbers are marked with the registry they came from and are then
-- permanently un-dialable through the desk. Non-matching numbers are marked
-- 'clear' ONLY when p_mark_clear is true, and even then only from 'unknown' or
-- a previous 'clear': a partial file must never un-flag a number that a
-- registry or the customer already put beyond reach.
CREATE OR REPLACE FUNCTION public.call_desk_dnc_import(
  p_phones text[],
  p_source text,
  p_mark_clear boolean DEFAULT false
)
RETURNS TABLE (numbers integer, matched integer, cleared integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_digits text[];
  v_matched integer := 0;
  v_cleared integer := 0;
BEGIN
  IF p_source NOT IN ('national', 'pa_list') THEN
    RAISE EXCEPTION 'call_desk_dnc_import: source must be national or pa_list, got %', p_source;
  END IF;

  SELECT coalesce(array_agg(DISTINCT d), ARRAY[]::text[])
    INTO v_digits
    FROM (SELECT public.normalize_phone(x) AS d FROM unnest(coalesce(p_phones, ARRAY[]::text[])) x) s
   WHERE d IS NOT NULL AND length(d) >= 10;

  IF array_length(v_digits, 1) IS NULL THEN
    RAISE EXCEPTION 'call_desk_dnc_import: no usable 10-digit numbers in the file';
  END IF;

  UPDATE public.outreach_prospects p
     SET dnc_status = p_source, dnc_checked_at = now(), updated_at = now()
   WHERE p.phone IS NOT NULL
     AND public.normalize_phone(p.phone) = ANY (v_digits);
  GET DIAGNOSTICS v_matched = ROW_COUNT;

  IF p_mark_clear THEN
    UPDATE public.outreach_prospects p
       SET dnc_status = 'clear', dnc_checked_at = now(), updated_at = now()
     WHERE p.phone IS NOT NULL
       AND p.dnc_status IN ('unknown', 'clear')
       AND NOT (public.normalize_phone(p.phone) = ANY (v_digits));
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT array_length(v_digits, 1), v_matched, v_cleared;
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_desk_do_not_call(bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.call_desk_mark_lost(bigint, bigint, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.call_desk_reopen(bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.call_desk_dnc_import(text[], text, boolean) TO authenticated;

COMMIT;
