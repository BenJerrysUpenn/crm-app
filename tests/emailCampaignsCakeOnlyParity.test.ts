import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  CAKE_ONLY,
  CONSUMER_DOMAINS,
  cakeEvidenceByEmail,
  compute,
  everyoneOf,
  isCakeOnly,
  leadStatusOf,
  type DealRow,
  type ProspectRow,
} from "@/lib/emailCampaignsPrototype/model";

// Live parity: the page's Personal cake rule (isCakeOnly) against the HOLD
// (#286) clause of outreach_warm_eligible, Catering-Manager
// outreach/migrations/012_cake_hold_personal_only.sql, on the live database,
// including the consumer mailbox list (CONSUMER_DOMAINS against the view's
// ARRAY, read from pg_get_viewdef). Read-only (a READ ONLY transaction). Skipped unless
// EMAIL_CAMPAIGNS_PARITY_DSN is set, so CI and a plain `npm test` never touch
// the database:
//
//   EMAIL_CAMPAIGNS_PARITY_DSN="$DATABASE_URL" npx vitest run tests/emailCampaignsCakeOnlyParity.test.ts

const DSN = process.env.EMAIL_CAMPAIGNS_PARITY_DSN;

/** What the loader sets: notes LIKE 'Cake Order%', then leadStatusOf. */
const cakeLead = (notes: string | null) =>
  (notes ?? "").startsWith("Cake Order") && leadStatusOf(notes) === "Cake Order";

/** The consumer domains in the live view: the one ARRAY that lists gmail.com. */
async function liveConsumerDomains(sql: postgres.Sql): Promise<string[]> {
  const [{ def }] = await sql<{ def: string }[]>`SELECT pg_get_viewdef('outreach_warm_eligible'::regclass) AS def`;
  const arrays = [...def.matchAll(/ARRAY\[(.*?)\]/gs)].map((m) => m[1]).filter((a) => a.includes("'gmail.com'"));
  expect(arrays).toHaveLength(1);
  return [...arrays[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe.skipIf(!DSN)("Personal cake parity with the live outreach_warm_eligible hold", () => {
  it("uses exactly the view's consumer mailbox domains", async () => {
    const sql = postgres(DSN!, { max: 1, prepare: false });
    try {
      expect([...(await liveConsumerDomains(sql))].sort()).toEqual([...CONSUMER_DOMAINS].sort());
    } finally {
      await sql.end();
    }
  }, 60_000);

  it("holds exactly the people the view holds out, person by person", async () => {
    const sql = postgres(DSN!, { max: 1, prepare: false });
    try {
      const [rows, deals] = await sql.begin("read only", async (tx) => [
        // The 012 view's WHERE clause without its HOLD clause: everyone the
        // view would list if there were no hold, and whether it lists them.
        await tx<{ id: number; email: string; ever_booked: boolean; notes: string | null; in_view: boolean }[]>`
          SELECT p.id, p.email, p.ever_booked, p.notes, (v.id IS NOT NULL) AS in_view
            FROM outreach_prospects p
            LEFT JOIN outreach_suppression s ON s.email = lower(p.email)
            LEFT JOIN outreach_talked_recently tr ON tr.email = lower(p.email)
            LEFT JOIN outreach_blocked_providers bp ON bp.domain = lower(split_part(p.email, '@', 2))
            LEFT JOIN (SELECT DISTINCT id FROM outreach_warm_eligible) v ON v.id = p.id
           WHERE p.engine = 'warm'
             AND s.email IS NULL AND tr.email IS NULL AND bp.domain IS NULL
             AND NOT COALESCE(p.marketing_opt_in AND p.opt_in_source = ANY (ARRAY['explicit_yes', 'signup_form']), false)
             AND NOT COALESCE(p.ever_booked AND p.last_event_date >= current_date - interval '12 months', false)
             AND p.status = 'raw' AND p.last_outreach_at IS NULL
             AND COALESCE(p.verify_status, '') <> ALL (ARRAY['invalid', 'disposable'])
             AND p.email IS NOT NULL AND btrim(p.email) <> ''`,
        await tx<Pick<DealRow, "contact_email" | "event_type">[]>`SELECT contact_email, event_type FROM deals`,
      ]);
      const evidence = cakeEvidenceByEmail(deals);
      const mismatches = rows.filter(
        (r) => isCakeOnly({ email: r.email, ever_booked: r.ever_booked, cake_lead_status: cakeLead(r.notes) }, evidence) === r.in_view,
      );
      const held = rows.filter((r) => !r.in_view).length;
      console.log(`[parity] would-be-eligible ${rows.length}, view ${rows.length - held}, held ${held}, mismatches ${mismatches.length}`);
      expect(mismatches.map((r) => r.id)).toEqual([]);
      expect(held).toBeGreaterThan(0);
    } finally {
      await sql.end();
    }
  }, 120_000);

  it("puts the same people on the Warm Personal cake card as the SQL clause, suppressed excluded", async () => {
    const sql = postgres(DSN!, { max: 1, prepare: false });
    try {
      const consumer = await liveConsumerDomains(sql);
      const [prospects, cakeNotes, deals, sqlCount] = await sql.begin("read only", async (tx) => [
        await tx<ProspectRow[]>`
          SELECT id, name, company, email, status, engine, category, ever_booked, last_event_date::text,
                 marketing_opt_in, opt_in_source, last_outreach_at::text, verify_status
            FROM outreach_prospects`,
        await tx<{ id: number; notes: string | null }[]>`
          SELECT id, notes FROM outreach_prospects WHERE notes LIKE 'Cake Order%'`,
        await tx<DealRow[]>`
          SELECT contact_email, event_type, stage, event_date::text, created_at::text, last_outbound_at::text, source
            FROM deals`,
        // The HOLD clause itself, over Warm with the page's suppressed rule.
        await tx<{ n: number }[]>`
          SELECT count(*)::int AS n
            FROM outreach_prospects p
            LEFT JOIN outreach_suppression s ON s.email = lower(btrim(p.email))
            LEFT JOIN (SELECT lower(btrim(d.contact_email)) AS email,
                              bool_or(d.event_type = 'Cake Order') AS cake,
                              bool_or(btrim(COALESCE(d.event_type, '')) <> ALL (ARRAY['', 'Cake Order', '--Pick One--'])) AS catering
                         FROM deals d WHERE d.contact_email IS NOT NULL GROUP BY 1) dk
                   ON dk.email = lower(btrim(p.email))
           WHERE p.engine = 'warm'
             AND p.status NOT IN ('suppressed', 'dead') AND s.email IS NULL
             AND NOT COALESCE(p.marketing_opt_in AND p.opt_in_source = ANY (ARRAY['explicit_yes', 'signup_form']), false)
             AND NOT COALESCE(p.ever_booked AND p.last_event_date >= current_date - interval '12 months', false)
             AND NOT p.ever_booked
             AND (split_part(split_part(COALESCE(p.notes, ''), E'\n', 1), ';', 1) = 'Cake Order' OR COALESCE(dk.cake, false))
             AND NOT COALESCE(dk.catering, false)
             AND lower(split_part(btrim(p.email), '@', 2)) = ANY (${consumer}::text[])`,
      ]);
      const suppression = await sql<{ email: string }[]>`SELECT email FROM outreach_suppression WHERE email IS NOT NULL`;
      const lead = new Set(cakeNotes.filter((r) => cakeLead(r.notes)).map((r) => r.id));
      const payload = compute(
        {
          prospects: prospects.map((p) => ({ ...p, cake_lead_status: lead.has(p.id) })),
          deals,
          sent: [],
          suppressedEmails: suppression.map((s) => s.email),
          blockedDomains: [],
          mailboxes: [],
        },
        new Date(),
      );
      const warm = payload.tiers.find((t) => t.key === "warm")!;
      const card = warm.categories.find((c) => c.key === CAKE_ONLY.key)!;
      const offerCard = payload.tiers.find((t) => t.key === "offer")!.categories.find((c) => c.key === CAKE_ONLY.key)!;
      console.log(
        `[parity] Warm Personal cake ${card.total} (SQL ${sqlCount[0].n}); Offer Personal cake ${offerCard.total}; Warm total ${warm.total}; Warm Everyone ${everyoneOf(warm).total}`,
      );
      expect(card.total).toBe(sqlCount[0].n);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
