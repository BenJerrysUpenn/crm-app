import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EmailCampaignsPrototype from "@/components/emailCampaignsPrototype/EmailCampaignsPrototype";
import {
  CAKE_ONLY,
  categorySteps,
  compute,
  everyoneOf,
  leadStatusOf,
  statesAt,
  volumeAt,
  type DealRow,
  type ProspectRow,
  type TierPayload,
} from "@/lib/emailCampaignsPrototype/model";
import { SEED_SEQUENCES, stepKeys } from "@/lib/emailCampaignsPrototype/sequences";

// Cake only (bj-finance #286, owner's ruling 2026-10-10): "cake only needs a
// card category in the warm and offer funnels. then all 3680 can hold there in
// that queue." The membership rule is the HOLD clause of Catering-Manager
// outreach/migrations/011_cake_hold_and_catering_first.sql; the live parity
// check is tests/emailCampaignsCakeOnlyParity.test.ts. Synthetic rows only.

const NOW = new Date("2026-10-10T12:00:00Z");

let nextId = 1;
function prospect(over: Partial<ProspectRow> = {}): ProspectRow {
  const id = nextId++;
  return {
    id,
    name: `Person ${id}`,
    company: null,
    email: `p${id}@example.com`,
    status: "raw",
    engine: "warm",
    category: null,
    ever_booked: false,
    last_event_date: null,
    marketing_opt_in: false,
    opt_in_source: null,
    last_outreach_at: null,
    verify_status: null,
    ...over,
  };
}

function deal(email: string | null, event_type: string | null, over: Partial<DealRow> = {}): DealRow {
  return {
    contact_email: email,
    event_type,
    stage: "New Enquiry",
    event_date: "2025-06-01",
    created_at: "2025-04-01T12:00:00Z",
    last_outbound_at: null,
    source: "migrated",
    ...over,
  };
}

function run(prospects: ProspectRow[], deals: DealRow[] = [], suppressedEmails: string[] = []) {
  const payload = compute({ prospects, deals, sent: [], suppressedEmails, blockedDomains: [], mailboxes: [] }, NOW);
  return Object.fromEntries(payload.tiers.map((t) => [t.key, t])) as Record<"cold" | "warm" | "offer", TierPayload>;
}

/** The category key a single warm/offer prospect lands in. */
function catOf(p: ProspectRow, deals: DealRow[] = []): string | undefined {
  const t = run([p], deals);
  for (const tier of [t.warm, t.offer]) {
    const c = tier.categories.find((c) => c.total === 1);
    if (c) return c.key;
  }
  return undefined;
}

// The page's own seed steps: Warm Everyone has one email.
const seedSteps = (key: string) => (SEED_SEQUENCES[key]?.steps ?? []).map(stepKeys);
const stepsFor = (tier: "warm" | "offer") => (catKey: string) =>
  categorySteps(catKey, seedSteps(`${tier}:${catKey}`), seedSteps(`${tier}:everyone`));

describe("Cake only membership: the 011 HOLD clause", () => {
  it("reads the Salesforce lead status as the first ';' field of the first line of notes", () => {
    expect(leadStatusOf("Cake Order; Website")).toBe("Cake Order");
    expect(leadStatusOf("Cake Order")).toBe("Cake Order");
    expect(leadStatusOf("Cake Order\nsecond line; x")).toBe("Cake Order");
    expect(leadStatusOf("Open; Cake Order")).toBe("Open");
    expect(leadStatusOf(" Cake Order; Website")).toBe(" Cake Order"); // no trim, as in SQL
    expect(leadStatusOf(null)).toBe("");
  });

  it("holds a Salesforce Cake Order lead with no deal", () => {
    expect(catOf(prospect({ cake_lead_status: true }))).toBe(CAKE_ONLY.key);
  });

  it("holds a CRM 'Open' lead whose only deals are Cake Order", () => {
    const p = prospect();
    expect(catOf(p, [deal(p.email, "Cake Order"), deal(p.email, "Cake Order")])).toBe(CAKE_ONLY.key);
  });

  it("matches deals on lower(btrim(email))", () => {
    const p = prospect({ email: "Mixed.Case@Example.com" });
    expect(catOf(p, [deal("  mixed.case@example.com ", "Cake Order")])).toBe(CAKE_ONLY.key);
  });

  it("keeps a cake lead who also has a catering deal in catering", () => {
    const p = prospect({ cake_lead_status: true });
    const deals = [deal(p.email, "Cake Order"), deal(p.email, "Birthday Party", { event_date: "2025-08-01" })];
    expect(catOf(p, deals)).toBe("family");
  });

  it("counts a blank or '--Pick One--' event type neither way", () => {
    const a = prospect({ cake_lead_status: true });
    expect(catOf(a, [deal(a.email, "--Pick One--"), deal(a.email, "  ")])).toBe(CAKE_ONLY.key);
    const b = prospect();
    expect(catOf(b, [deal(b.email, null), deal(b.email, "--Pick One--")])).not.toBe(CAKE_ONLY.key);
  });

  it("needs the event type to be exactly 'Cake Order' for cake evidence, as in SQL", () => {
    const p = prospect();
    // ' Cake Order ' trims to 'Cake Order' (not catering) but is not '=' 'Cake Order' (not cake).
    expect(catOf(p, [deal(p.email, " Cake Order ")])).not.toBe(CAKE_ONLY.key);
  });

  it("never holds anyone who has booked", () => {
    const p = prospect({ cake_lead_status: true, ever_booked: true, last_event_date: "2024-05-01" });
    expect(catOf(p, [deal(p.email, "Cake Order", { stage: "Event Complete" })])).toBe("past_booker");
  });

  it("puts an explicitly opted-in cake-only person in Offer's Cake only card", () => {
    const p = prospect({ cake_lead_status: true, marketing_opt_in: true, opt_in_source: "explicit_yes" });
    const t = run([p]);
    expect(t.offer.categories.find((c) => c.key === CAKE_ONLY.key)?.total).toBe(1);
    expect(t.warm.total).toBe(0);
  });

  it("leaves suppressed cake-only people out of the card, like every other number", () => {
    const a = prospect({ cake_lead_status: true });
    const b = prospect({ cake_lead_status: true, status: "suppressed" });
    const c = prospect({ cake_lead_status: true });
    const t = run([a, b, c], [], [c.email!]);
    expect(t.warm.categories.find((x) => x.key === CAKE_ONLY.key)?.total).toBe(1);
  });
});

describe("Cake only cards: one card each on Warm and Offer, held", () => {
  const cakeA = prospect({ cake_lead_status: true });
  const cakeB = prospect();
  const corp = prospect();
  const lead = prospect();
  const deals = [deal(cakeB.email, "Cake Order"), deal(corp.email, "Employee Appreciation")];
  const t = run([cakeA, cakeB, corp, lead], deals);

  it("shows the card on Warm and on Offer, even when empty, listed last", () => {
    expect(t.warm.categories.at(-1)?.key).toBe(CAKE_ONLY.key);
    expect(t.offer.categories.map((c) => c.key)).toEqual([CAKE_ONLY.key]);
    expect(t.offer.categories[0].total).toBe(0);
    expect(t.offer.categories[0].hold).toBe(true);
  });

  it("puts each cake-only person in that card and in no other category", () => {
    const counts = Object.fromEntries(t.warm.categories.map((c) => [c.key, c.total]));
    expect(counts).toEqual({ [CAKE_ONLY.key]: 2, corporate: 1, no_deal: 1 });
    expect(t.warm.total).toBe(4);
    expect(t.warm.check.ok).toBe(true);
  });

  it("has no sequence: it does not fall back to the tier's Everyone sequence", () => {
    expect(seedSteps("warm:everyone").length).toBeGreaterThan(0);
    expect(stepsFor("warm")(CAKE_ONLY.key)).toEqual([]);
    expect(stepsFor("warm")("corporate")).toEqual(seedSteps("warm:everyone"));
    // A sequence of its own, if one is ever written, is used as is.
    expect(categorySteps(CAKE_ONLY.key, [["cake_1"]], [["warm"]])).toEqual([["cake_1"]]);
    const card = t.warm.categories.find((c) => c.key === CAKE_ONLY.key)!;
    const st = statesAt(card, "monthly", stepsFor("warm"));
    expect(st).toMatchObject({ upNext: 0, emailed: 0, held: 2, unaccounted: 0 });
    expect(st.heldBy.noSequence).toBe(2);
  });

  it("is left out of the Everyone card, Needed and capacity", () => {
    const e = everyoneOf(t.warm);
    expect(e.total).toBe(2);
    expect(e.groups.every((g) => g.cat !== CAKE_ONLY.key)).toBe(true);
    const st = statesAt(e, "monthly", stepsFor("warm"));
    expect(st).toMatchObject({ upNext: 2, held: 0, withStepsLeft: 2, unaccounted: 0 });
    expect(volumeAt(t.warm, "monthly", st.withStepsLeft).people).toBe(2);
  });

  it("renders the card's hold with the page's held reasons, and Everyone without it", () => {
    const html = renderToStaticMarkup(
      createElement(EmailCampaignsPrototype, {
        payload: compute(
          { prospects: [cakeA, cakeB, corp, lead], deals, sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] },
          NOW,
        ),
      }),
    );
    expect(html).toContain(">Cake only<");
    // Warm's Everyone counts the 2 who are sent to, not the 2 held cake-only.
    expect(html).toMatch(/Everyone <span[^>]*>· 2 people<\/span>/);
    expect(html).toContain("no sequence yet");
  });
});
