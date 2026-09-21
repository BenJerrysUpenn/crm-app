-- ============================================================================
-- Withers CRM — migration crm/005: manual deal intake
--
-- Staff need to add a deal when the customer did not use the catering form on
-- benjerry.com/upenn/catering: they rang, emailed, or asked at the counter.
-- The form lives at /deals/new and writes through POST /api/deals.
--
-- This migration adds ONE thing: the duplicate lookup that form runs before it
-- creates anything. Nothing else here touches the CRM's data.
--
-- WHAT THIS MIGRATION DOES NOT DO
-- -------------------------------
-- It does not alter `deals`. That table is owned by Catering-Manager's
-- modules/db.py and its schema changes live in that repo's migrations/, which
-- is where the test harness builds its throwaway schemas from. The two columns
-- manual intake needs there — the widened `source` CHECK ('walk_in', 'other')
-- and the new `sf_lead_state` — are
-- `Catering-Manager/migrations/023_manual_deal_sources_and_sf_lead_state.sql`.
--
-- ORDER: apply 023 FIRST, then this file. The other way round works too (this
-- file does not depend on those columns), but the form cannot create a deal
-- until 023 is in, and it will say so rather than fail obscurely.
--
-- Needs crm/003 (for public.normalize_phone). Idempotent; safe to re-run.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- deal_dedupe_candidates
-- ---------------------------------------------------------------------------
--
-- "Have we already got this person?" asked of both stores the CRM knows: the
-- deals themselves, and the outreach contact base they were synced into.
--
-- Why an RPC rather than two PostgREST queries. The phone match has to be
-- made on the NORMALISED key: `deals.contact_phone` holds whatever a human
-- typed — "(215) 665-5323", "215.665.5323", "+1 215 665 5323" — so a literal
-- comparison finds nothing, and PostgREST cannot call normalize_phone on the
-- column side of a filter. Doing it here also keeps one definition of
-- "the same person" instead of one per caller.
--
-- SECURITY INVOKER, deliberately: the manager RLS policies on `deals` and
-- `outreach_prospects` are the guard, exactly as they are for every other
-- read in this app. An employee who is not a manager gets an empty result,
-- not somebody else's customer list.
--
-- Archived deals are INCLUDED. The 9,450 rows migrated from Salesforce are
-- all archived=1, and "this office booked us three times under the previous
-- owner" is the single most useful thing this lookup can tell a caller.
--
-- A NULL or blank argument matches nothing rather than everything — the
-- `k.e IS NOT NULL` / `k.p IS NOT NULL` guards. Calling with neither returns
-- no rows.

DROP FUNCTION IF EXISTS public.deal_dedupe_candidates(text, text, integer);

CREATE FUNCTION public.deal_dedupe_candidates(
  p_email text,
  p_phone text,
  p_limit integer DEFAULT 10
)
RETURNS TABLE (
  kind           text,
  id             bigint,
  name           text,
  company        text,
  email          text,
  phone          text,
  stage          text,
  event_date     text,
  matched_email  boolean,
  matched_phone  boolean,
  sort_key       text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH k AS (
    SELECT nullif(lower(btrim(coalesce(p_email, ''))), '') AS e,
           public.normalize_phone(p_phone)                 AS p
  ),
  hits AS (
    SELECT 'deal'::text AS kind,
           d.id::bigint AS id,
           nullif(btrim(concat_ws(' ', d.contact_first_name, d.contact_last_name)), '') AS name,
           d.company,
           d.contact_email AS email,
           d.contact_phone AS phone,
           d.stage,
           d.event_date,
           (k.e IS NOT NULL
            AND lower(btrim(coalesce(d.contact_email, ''))) = k.e) AS matched_email,
           (k.p IS NOT NULL
            AND public.normalize_phone(d.contact_phone) = k.p)     AS matched_phone,
           coalesce(d.updated_at, d.created_at, '')                AS sort_key
      FROM public.deals d
      CROSS JOIN k
     WHERE (k.e IS NOT NULL
            AND lower(btrim(coalesce(d.contact_email, ''))) = k.e)
        OR (k.p IS NOT NULL
            AND public.normalize_phone(d.contact_phone) = k.p)

    UNION ALL

    SELECT 'prospect'::text,
           p.id::bigint,
           p.name,
           p.company,
           p.email,
           p.phone,
           NULL::text,
           NULL::text,
           (k.e IS NOT NULL
            AND lower(btrim(coalesce(p.email, ''))) = k.e),
           (k.p IS NOT NULL
            AND public.normalize_phone(p.phone) = k.p),
           coalesce(p.updated_at::text, '')
      FROM public.outreach_prospects p
      CROSS JOIN k
     WHERE (k.e IS NOT NULL AND lower(btrim(coalesce(p.email, ''))) = k.e)
        OR (k.p IS NOT NULL AND public.normalize_phone(p.phone) = k.p)
  )
  SELECT *
    FROM hits
   -- Both keys matching is the strongest signal, so it sorts first; after
   -- that, most recently touched.
   ORDER BY (matched_email AND matched_phone) DESC, sort_key DESC
   LIMIT greatest(coalesce(p_limit, 10), 1);
$$;

COMMENT ON FUNCTION public.deal_dedupe_candidates(text, text, integer) IS
  'Existing deals and outreach prospects matching an email or a normalised '
  'phone. Advisory duplicate warning for the manual "New deal" form; never a '
  'block, because repeat customers are normal.';

GRANT EXECUTE ON FUNCTION public.deal_dedupe_candidates(text, text, integer)
  TO authenticated;

-- The email leg is the one that runs on every keystroke-settled lookup and it
-- was a sequential scan of 9.7k deals. The phone leg cannot use an index on
-- `deals` without a functional index, which is what the second one is.
CREATE INDEX IF NOT EXISTS idx_deals_contact_email_lower
  ON public.deals (lower(btrim(contact_email)))
  WHERE contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deals_contact_phone_digits
  ON public.deals (public.normalize_phone(contact_phone))
  WHERE contact_phone IS NOT NULL;

COMMIT;
