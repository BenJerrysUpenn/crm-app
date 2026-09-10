-- ============================================================================
-- Withers CRM — migration crm/002: Salesforce-era booking history on the desk
-- bj-finance #414 Call desk: party type is null for every Salesforce-era booking
--
-- Run once in the Supabase SQL editor (or: psql "$DATABASE_URL" -v ON_ERROR_STOP=1
-- -f supabase/crm/002_call_desk_history.sql). Idempotent: safe to re-run.
-- Requires crm/001 to have been applied first.
--
-- WHY
-- ---
-- 150 of the 152 "Booked before" prospects on the call desk showed no party
-- type, no event type and no last deal — while wearing the badge that says
-- they booked. The history was in `deals` the whole time.
--
-- The 9,450 deals migrated from Salesforce on 2026-05-16 all carry
-- archived = 1. `call_desk_queue` joins deals with archived = 0, which is the
-- right rule for the live pipeline (Catering-Manager's soft delete: "Never
-- delete a deal. Use archived = 1") and the wrong rule for history. The
-- ever_booked badge comes from sync_contacts_from_deals(), which reads those
-- same deals without the archived filter — hence badge on, columns empty.
--
-- WHAT THIS DOES
-- --------------
-- 1. Redefines `call_desk_queue` (full definition, copied from crm/001) so the
--    `last_deal` and `last_booked` CTEs also accept legacy rows —
--    legacy_sf_id IS NOT NULL — whatever their archived flag says. Every one
--    of the 152 gains an event type; 2 gain a party type. The column set is
--    unchanged, so lib/callDesk/types.ts needs no edit.
-- 2. Makes the `last_booked` money test null-safe: legacy rows carry NULL
--    payment_status, and `NULL <> 'None'` is NULL, not true, so the old test
--    quietly dropped them from that OR branch.
-- 3. Fixes one import artefact in a prospect's name (guarded, see below).
--
-- NOT fixed here: `deals.package_name` is empty on 9,447 of the 9,450 migrated
-- rows because the Salesforce translator dropped the Party Type Opportunity
-- field altogether. That is a data backfill out of Salesforce (bj-finance #414
-- leaf B, needs Alina), not a view change. Until it runs, most rows can only
-- show the booked event type — which is why the UI labels it as one.
--
-- NOT touched: `deals` itself (owned by Catering-Manager modules/db.py), the
-- grants, policies, RPCs, `deal_form_options` and the storage bucket from
-- crm/001, and Catering-Manager's archived semantics.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The queue, redefined: legacy Salesforce deals are booking history
-- ---------------------------------------------------------------------------
--
-- Everything below is crm/001's definition with two edits, both marked. Kept
-- whole rather than patched so this file alone says what the view is.

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
   -- archived = 0 is Catering-Manager's soft delete, but the 9,450 deals
   -- migrated from Salesforce on 2026-05-16 were ALL imported archived so they
   -- stay out of the live pipeline. They are also the entire booking history
   -- this desk exists to show, so legacy rows join in regardless (#414).
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
   -- archived = 0 is Catering-Manager's soft delete, but the 9,450 deals
   -- migrated from Salesforce on 2026-05-16 were ALL imported archived so they
   -- stay out of the live pipeline. They are also the entire booking history
   -- this desk exists to show, so legacy rows join in regardless (#414).
   WHERE (d.archived = 0 OR d.legacy_sf_id IS NOT NULL)
     AND d.contact_email IS NOT NULL AND btrim(d.contact_email) <> ''
     AND (d.stage IN ('Booked Unpaid', 'Booked Paid', 'Event Complete')
          OR coalesce(d.payment_status, 'None') <> 'None'
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
  'disposition / booked party type. Legacy Salesforce deals count as history '
  'even though they are archived (bj-finance #414). Defined by crm-app '
  'supabase/crm/002_call_desk_history.sql, superseding the definition in 001.';

GRANT SELECT ON public.call_desk_queue TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- 2. One import artefact: prospect #5's name carries a stray time prefix
-- ---------------------------------------------------------------------------
--
-- Stored as "10:00 AMDebra Young" — a column bled into the name during the
-- Salesforce import. Its own transaction, and guarded on the exact bad value,
-- so re-running this file after the fix (or after someone corrects the name by
-- hand) touches nothing.

BEGIN;

UPDATE public.outreach_prospects
   SET name = 'Debra Young',
       updated_at = now()
 WHERE id = 5
   AND name = '10:00 AMDebra Young';

COMMIT;
