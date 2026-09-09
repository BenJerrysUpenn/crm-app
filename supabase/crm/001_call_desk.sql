-- ============================================================================
-- Withers CRM — migration crm/001: call desk ("Recently Contacted" tab)
-- bj-finance #409 Call desk: 'Recently Contacted' tab in the CRM
--
-- Run once in the Supabase SQL editor (or: psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- -f supabase/crm/001_call_desk.sql). Idempotent: safe to re-run.
--
-- WHAT THIS DOES
-- --------------
-- 1. Lets signed-in CRM managers reach the outreach tables. Today
--    outreach_prospects / outreach_events / outreach_suppression have RLS on
--    with NO policies and NO grants to `authenticated`, so the CRM (which runs
--    as the signed-in user, RLS-enforced) cannot read them at all. Same gate as
--    `deals`: is_manager().
-- 2. Adds 'called' to the outreach_events vocabulary (the call log lives there,
--    next to added/sequenced/replied/handed_off, per the ticket's data contract).
-- 3. The queue: view `call_desk_queue` — prospects the warm engine mailed
--    (status='sequenced'), not suppressed, with a phone number, newest mail
--    first, joined to their last call, last disposition and last booked deal.
-- 4. Two atomic write helpers the CRM calls by RPC:
--      call_desk_append_note(prospect_id, text)  -- append-only, date-prefixed
--      call_desk_do_not_call(prospect_id, event_id) -- suppression row +
--          status='suppressed' + 'suppressed' event, one transaction, the same
--          shape outreach/bounce_reader.py writes for opt-outs.
-- 5. `deal_form_options`: the ONE place the guided "Generate deal" form reads
--    its non-priced enumerations from (event types, customer profiles). Packages
--    and extras keep coming from pricing_packages / pricing_extras (already the
--    single source for the Price Book and for the Python quote engine).
-- 6. Storage bucket `call-recordings` (private) + manager-only object policies.
--    Recordings are keyed <prospect_id>/<event_id>-<timestamp>.<ext>; the
--    consent-confirmed flag is stored on the 'called' event's detail JSON.
--
-- NOT touched: `deals` (owned by Catering-Manager modules/db.py) and the
-- warm sender's views (outreach_warm_eligible etc.).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Access: CRM managers may read/write the outreach tables
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.outreach_prospects   TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.outreach_events      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.outreach_suppression TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.outreach_events_id_seq TO authenticated;

DROP POLICY IF EXISTS "managers full access to outreach_prospects" ON public.outreach_prospects;
CREATE POLICY "managers full access to outreach_prospects"
  ON public.outreach_prospects FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());

DROP POLICY IF EXISTS "managers full access to outreach_events" ON public.outreach_events;
CREATE POLICY "managers full access to outreach_events"
  ON public.outreach_events FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());

DROP POLICY IF EXISTS "managers full access to outreach_suppression" ON public.outreach_suppression;
CREATE POLICY "managers full access to outreach_suppression"
  ON public.outreach_suppression FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());

-- pricing_extras is read by the deal form (packages already have auth_all).
DROP POLICY IF EXISTS "authenticated read pricing_extras" ON public.pricing_extras;
CREATE POLICY "authenticated read pricing_extras"
  ON public.pricing_extras FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "authenticated read pricing_scalars" ON public.pricing_scalars;
CREATE POLICY "authenticated read pricing_scalars"
  ON public.pricing_scalars FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.pricing_extras, public.pricing_scalars TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Event vocabulary: + 'called'
-- ---------------------------------------------------------------------------

ALTER TABLE public.outreach_events DROP CONSTRAINT IF EXISTS outreach_events_event_check;
ALTER TABLE public.outreach_events
  ADD CONSTRAINT outreach_events_event_check
  CHECK (event = ANY (ARRAY[
    'added', 'enriched', 'sequenced', 'delivered', 'bounced', 'unsubscribed',
    'replied', 'interested', 'handed_off', 'deal_created', 'booked',
    'suppressed', 'opted_in',
    'called'
  ]));

COMMENT ON CONSTRAINT outreach_events_event_check ON public.outreach_events IS
  'Permitted event vocabulary. "called" added by crm-app supabase/crm/001_call_desk.sql '
  '(bj-finance #409): one row per phone call from the call desk; detail JSON carries '
  'by, disposition (no_answer|voicemail|spoke|interested|do_not_call), duration_seconds, '
  'note, recording_path, consent_confirmed.';

-- Queue and "pending disposition" lookups both walk a prospect's call rows.
CREATE INDEX IF NOT EXISTS outreach_events_prospect_event_time_idx
  ON public.outreach_events (prospect_id, event, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. The queue
-- ---------------------------------------------------------------------------
--
-- One row per callable prospect. "Party type previously booked" is the
-- package_name of their most recent deal that reached a booked stage (that is
-- what the Salesforce/Conga world called Party Type); the event_type of their
-- most recent deal of any stage rides along as context. Deals join by email,
-- the same join sync_contacts_from_deals() and the attribution rule use.
--
-- Two things that join has to get right and are easy to get wrong:
--   * archived = 0. `archived` is Catering-Manager's soft delete ("Never
--     delete a deal. Use archived = 1", SKILL.md) and every read path in
--     modules/db.py filters it. Without it a merged duplicate outranks the
--     surviving row and the desk shows a party type from a dead deal.
--   * lower(btrim(...)) on BOTH sides. The deals side was always trimmed;
--     the prospect side must be too, or a prospect row whose email carries
--     stray whitespace misses its suppression row and a person who
--     unsubscribed comes back into the call queue.
--
-- security_invoker: the view runs as the signed-in user, so the manager
-- policies above are what actually gate it (PG15+; Supabase is PG17).

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
   WHERE d.archived = 0
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
   WHERE d.archived = 0
     AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
     AND (d.stage IN ('Booked Unpaid', 'Booked Paid', 'Event Complete')
          OR d.payment_status <> 'None'
          OR coalesce(d.amount_paid, 0) > 0)
   ORDER BY lower(btrim(d.contact_email)), d.event_date DESC NULLS LAST, d.id DESC
)
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
       lb.booked_guest_count
  FROM public.outreach_prospects p
  LEFT JOIN public.outreach_suppression s ON s.email = lower(btrim(p.email))
  LEFT JOIN last_call   lc ON lc.prospect_id = p.id
  LEFT JOIN call_counts cc ON cc.prospect_id = p.id
  LEFT JOIN last_reply  lr ON lr.prospect_id = p.id
  LEFT JOIN last_deal   ld ON ld.email = lower(btrim(p.email))
  LEFT JOIN last_booked lb ON lb.email = lower(btrim(p.email))
 WHERE p.status = 'sequenced'
   AND s.email IS NULL
   AND p.phone IS NOT NULL AND btrim(p.phone) <> ''
 ORDER BY p.last_outreach_at DESC NULLS LAST, p.id;

COMMENT ON VIEW public.call_desk_queue IS
  'Call desk queue (bj-finance #409): warm-outreach prospects recently mailed, '
  'not suppressed, with a phone; newest mail first; joined to last call / '
  'disposition / booked party type. Defined by crm-app supabase/crm/001_call_desk.sql.';

GRANT SELECT ON public.call_desk_queue TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Atomic write helpers (RPC)
-- ---------------------------------------------------------------------------

-- Append-only, date-prefixed prospect note. Mirrors the deals.notes convention
-- ("[YYYY-MM-DD] ..." prefix, never overwritten) and the CRM's call-log line
-- ("[YYYY-MM-DD HH24:MI ET] ...").
CREATE OR REPLACE FUNCTION public.call_desk_append_note(p_prospect_id bigint, p_text text)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_line  text;
  v_notes text;
  v_by    text;
BEGIN
  IF p_text IS NULL OR btrim(p_text) = '' THEN
    RAISE EXCEPTION 'call_desk_append_note: empty note';
  END IF;
  v_by := coalesce(auth.jwt() ->> 'email', 'unknown');
  v_line := '[' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')
            || ' ET] (' || v_by || ') ' || btrim(p_text);
  UPDATE public.outreach_prospects
     SET notes = CASE WHEN notes IS NULL OR btrim(notes) = '' THEN v_line
                      ELSE notes || E'\n' || v_line END,
         updated_at = now()
   WHERE id = p_prospect_id
   RETURNING notes INTO v_notes;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_desk_append_note: prospect % not found', p_prospect_id;
  END IF;
  RETURN v_notes;
END;
$$;

-- Do-not-call from the call desk. Same three writes as an email opt-out in
-- outreach/bounce_reader.py, in one transaction: the suppression row (which
-- the warm sender re-checks before every send), status='suppressed' (which
-- also drops the row from call_desk_queue), and a 'suppressed' event that
-- says why. Prospects with no email still get status + event.
CREATE OR REPLACE FUNCTION public.call_desk_do_not_call(p_prospect_id bigint, p_call_event_id bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_email text;
  v_by    text;
BEGIN
  v_by := coalesce(auth.jwt() ->> 'email', 'unknown');
  SELECT lower(btrim(email)) INTO v_email FROM public.outreach_prospects WHERE id = p_prospect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'call_desk_do_not_call: prospect % not found', p_prospect_id;
  END IF;

  IF v_email IS NOT NULL AND v_email <> '' THEN
    INSERT INTO public.outreach_suppression (email, reason, source)
    VALUES (v_email, 'manual', 'call_desk:' || v_by)
    ON CONFLICT (email) DO NOTHING;
  END IF;

  UPDATE public.outreach_prospects
     SET status = 'suppressed', updated_at = now()
   WHERE id = p_prospect_id;

  INSERT INTO public.outreach_events (prospect_id, event, detail)
  VALUES (p_prospect_id, 'suppressed',
          jsonb_build_object('by', v_by, 'via', 'call_desk',
                             'disposition', 'do_not_call',
                             'call_event_id', p_call_event_id,
                             'reason', 'manual'));
END;
$$;

GRANT EXECUTE ON FUNCTION public.call_desk_append_note(bigint, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.call_desk_do_not_call(bigint, bigint) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. deal_form_options — the single home for the form's non-priced enums
-- ---------------------------------------------------------------------------
--
-- event_type: deals.event_type is free text in the schema and the Python
-- engine never constrains it; this list is curated from the values the B&J
-- web form and the last four months of enquiries actually produced, so the
-- caller picks from what the pipeline already understands (triage's early-
-- arrival / high-profile heuristics key off words like Birthday, Graduation,
-- Corporate, Wedding).
--
-- customer_profile: the five profiles ruled on bj-finance #392 (2026-09-06).
-- There is no deals column for it yet (#396 Funnel data model owns that), so
-- the form shows it for reference and records the pick in the deal's notes.

CREATE TABLE IF NOT EXISTS public.deal_form_options (
  field       text    NOT NULL,
  value       text    NOT NULL,
  label       text    NOT NULL,
  hint        text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (field, value)
);

COMMENT ON TABLE public.deal_form_options IS
  'Enumerations for the CRM guided deal form (bj-finance #409). One row per '
  'option; `field` names the form field. Priced options (packages, extras) '
  'are NOT here -- they live in pricing_packages / pricing_extras.';

ALTER TABLE public.deal_form_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated read deal_form_options" ON public.deal_form_options;
CREATE POLICY "authenticated read deal_form_options"
  ON public.deal_form_options FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "managers write deal_form_options" ON public.deal_form_options;
CREATE POLICY "managers write deal_form_options"
  ON public.deal_form_options FOR ALL TO authenticated
  USING (public.is_manager()) WITH CHECK (public.is_manager());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deal_form_options TO authenticated;

INSERT INTO public.deal_form_options (field, value, label, hint, sort_order) VALUES
  ('event_type', 'Birthday Party',          'Birthday Party',          NULL, 10),
  ('event_type', 'Corporate Celebration',   'Corporate Celebration',   NULL, 20),
  ('event_type', 'Employee Appreciation',   'Employee Appreciation',   NULL, 30),
  ('event_type', 'Ice Cream Social',        'Ice Cream Social',        NULL, 40),
  ('event_type', 'Wedding',                 'Wedding',                 NULL, 50),
  ('event_type', 'Graduation Party',        'Graduation Party',        NULL, 60),
  ('event_type', 'Baby Shower',             'Baby Shower',             NULL, 70),
  ('event_type', 'Bridal Shower',           'Bridal Shower',           NULL, 80),
  ('event_type', 'Bar or Bat Mitzvah',      'Bar or Bat Mitzvah',      NULL, 90),
  ('event_type', 'Engagement Party',        'Engagement Party',        NULL, 100),
  ('event_type', 'Rehearsal Dinner',        'Rehearsal Dinner',        NULL, 110),
  ('event_type', 'Fundraiser',              'Fundraiser',              NULL, 120),
  ('event_type', 'Festival',                'Festival',                NULL, 130),
  ('event_type', 'Block Party',             'Block Party',             NULL, 140),
  ('event_type', 'Family Reunion',          'Family Reunion',          NULL, 150),
  ('event_type', 'Holiday Party',           'Holiday Party',           NULL, 160),
  ('event_type', 'Meeting',                 'Meeting',                 NULL, 170),
  ('event_type', 'School Event',            'School Event',            NULL, 180),
  ('event_type', 'Student Orientation',     'Student Orientation',     NULL, 190),
  ('event_type', 'Resident Event',          'Resident Event',          'apartment / tenant appreciation', 200),
  ('event_type', 'Marketing Event',         'Marketing Event',         'our own promo / tabling', 210),
  ('event_type', 'Other',                   'Other',                   'describe in event name', 900),
  ('customer_profile', 'event_planner',   'Event planner / venue partner', 'recurring recommender (B2B2C)', 10),
  ('customer_profile', 'office_admin',    'Office admin',                  'single corporate party, annual repeat', 20),
  ('customer_profile', 'mitzvah_planner', 'Bar/bat mitzvah planner',       'consumer one-off, word of mouth', 30),
  ('customer_profile', 'wedding',         'Wedding (couple)',              'consumer one-off; venues are partners', 40),
  ('customer_profile', 'penn_account',    'Penn account',                  'Greek chapters, clubs, College Houses, departments', 50),
  ('customer_profile', 'other',           'Other / unsure',                NULL, 90)
ON CONFLICT (field, value) DO UPDATE
  SET label = EXCLUDED.label, hint = EXCLUDED.hint, sort_order = EXCLUDED.sort_order;

COMMIT;

-- ---------------------------------------------------------------------------
-- 6. Storage: private bucket for consent-confirmed call recordings
-- ---------------------------------------------------------------------------
-- Separate transaction: storage.* is Supabase-managed and worth isolating from
-- the schema changes above if the SQL editor's role lacks a grant here.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('call-recordings', 'call-recordings', false, 209715200)  -- 200 MB
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "managers upload call recordings" ON storage.objects;
CREATE POLICY "managers upload call recordings"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'call-recordings' AND public.is_manager());

DROP POLICY IF EXISTS "managers read call recordings" ON storage.objects;
CREATE POLICY "managers read call recordings"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'call-recordings' AND public.is_manager());

DROP POLICY IF EXISTS "managers update call recordings" ON storage.objects;
CREATE POLICY "managers update call recordings"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'call-recordings' AND public.is_manager())
  WITH CHECK (bucket_id = 'call-recordings' AND public.is_manager());

COMMIT;
