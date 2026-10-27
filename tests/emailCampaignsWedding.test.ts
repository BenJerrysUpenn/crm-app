import { describe, expect, it } from "vitest";
import { compute, type DealRow, type ProspectRow, type RawData } from "@/lib/emailCampaignsPrototype/model";

// Wedding leads (owners' rulings 2026-10-27). Three rules:
// 1. Archived people (archived_at set) leave the tab before anything is
//    counted, like suppressed people, and no archived count is shown.
// 2. In Warm and Offer, a prospect whose own category is 'wedding' is in the
//    Weddings & showers card even with no deal.
// 3. A wedding contact whose event date (the prospect's event_date, else the
//    category-setting deal's) is before today is treated as archived, as the
//    sender does. Synthetic rows only.

const NOW = new Date("2026-10-27T15:00:00Z");
const YESTERDAY = "2026-10-26";
const TODAY = "2026-10-27";
const NEXT_JUNE = "2027-06-12";

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
    event_date: null,
    archived_at: null,
    ...over,
  };
}

// An expo couple: own category wedding, signup_form opt-in, so Offer.
const couple = (over: Partial<ProspectRow> = {}) =>
  prospect({
    category: "wedding",
    marketing_opt_in: true,
    opt_in_source: "signup_form",
    event_date: NEXT_JUNE,
    ...over,
  });

function deal(email: string | null, event_type: string, over: Partial<DealRow> = {}): DealRow {
  return {
    contact_email: email,
    event_type,
    stage: "New Enquiry",
    event_date: NEXT_JUNE,
    created_at: "2026-01-10T12:00:00Z",
    last_outbound_at: null,
    source: "form",
    ...over,
  };
}

function run(prospects: ProspectRow[], deals: DealRow[] = []) {
  const payload = compute(
    { prospects, deals, sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] } satisfies RawData,
    NOW,
  );
  const tiers = Object.fromEntries(payload.tiers.map((t) => [t.key, t]));
  const cat = (tier: string, key: string) => tiers[tier].categories.find((c) => c.key === key);
  return { payload, tiers, cat };
}

describe("Email campaigns: archived people are left out of every number", () => {
  it("drops an archived prospect before counting, in every tier, and the check still passes", () => {
    const { payload, tiers } = run([
      prospect({ engine: "cold", category: "law_admin", archived_at: "2026-10-27T09:00:00Z" }),
      prospect({ archived_at: "2026-10-27T09:00:00Z" }),
      couple({ archived_at: "2026-10-27T09:00:00Z" }),
      prospect(),
    ]);
    expect(tiers.cold.total).toBe(0);
    expect(tiers.warm.total).toBe(1);
    expect(tiers.offer.total).toBe(0);
    for (const t of payload.tiers) {
      expect(t.categories.reduce((s, c) => s + c.total, 0)).toBe(t.total);
      expect(t.check).toEqual({ suppressed: 0, unaccounted: 0, ok: true });
    }
    expect(payload.flows.suppressed).toBe(0);
  });

  it("shows no archived count anywhere in the payload", () => {
    const { payload } = run([couple({ archived_at: "2026-10-27T09:00:00Z" }), couple({ event_date: YESTERDAY })]);
    expect(JSON.stringify(payload)).not.toMatch(/archiv/i);
  });

  it("still counts an archived person who is also suppressed as suppressed, as today", () => {
    const { tiers } = run([prospect({ status: "suppressed", archived_at: "2026-10-27T09:00:00Z" })]);
    expect(tiers.warm.check).toEqual({ suppressed: 1, unaccounted: 0, ok: true });
  });
});

describe("Email campaigns: a prospect's own wedding category puts them in Weddings & showers", () => {
  it("puts an expo couple with no deal in Offer's Weddings & showers card", () => {
    const { tiers, cat } = run([couple()]);
    expect(tiers.offer.total).toBe(1);
    expect(cat("offer", "wedding")).toMatchObject({ label: "Weddings & showers", total: 1 });
    expect(cat("offer", "unknown_event")).toBeUndefined();
  });

  it("puts a Warm wedding prospect with no deal in the wedding card, not 'no deal on file'", () => {
    const { cat } = run([prospect({ category: "wedding" })]);
    expect(cat("warm", "wedding")?.total).toBe(1);
    expect(cat("warm", "no_deal")).toBeUndefined();
  });

  it("wins over a deal of another event type", () => {
    const p = couple();
    const { cat } = run([p], [deal(p.email, "Corporate event")]);
    expect(cat("offer", "wedding")?.total).toBe(1);
    expect(cat("offer", "corporate")).toBeUndefined();
  });

  it("keeps the Warm and Offer flows as they were", () => {
    const booker = prospect({ category: "wedding", ever_booked: true, last_event_date: "2024-05-01" });
    const enquirer = prospect({ category: "wedding" });
    const { payload, cat } = run([booker, enquirer], [deal(enquirer.email, "Wedding")]);
    expect(cat("warm", "wedding")?.total).toBe(2);
    expect(payload.flows.offerToWarm).toBe(1);
    expect(payload.flows.dealToWarm).toBe(1);
  });

  it("leaves deal-derived categories as today when the prospect's category is not wedding", () => {
    const a = prospect();
    const b = prospect({ marketing_opt_in: true, opt_in_source: "explicit_yes" });
    const c = prospect();
    const { cat } = run([a, b, c], [deal(a.email, "Wedding reception"), deal(b.email, "Employee appreciation")]);
    expect(cat("warm", "wedding")).toMatchObject({ label: "Enquired: Weddings & showers", total: 1 });
    expect(cat("offer", "corporate")?.total).toBe(1);
    expect(cat("warm", "no_deal")?.total).toBe(1);
  });
});

describe("Email campaigns: a wedding contact whose date has passed is treated as archived", () => {
  it("drops a couple whose own event_date is before today, and the check still passes", () => {
    const { tiers } = run([couple({ event_date: YESTERDAY }), couple()]);
    expect(tiers.offer.total).toBe(1);
    expect(tiers.offer.check).toEqual({ suppressed: 0, unaccounted: 0, ok: true });
  });

  it("keeps a couple whose wedding is today, or has no date at all", () => {
    const { tiers } = run([couple({ event_date: TODAY }), couple({ event_date: null })]);
    expect(tiers.offer.total).toBe(2);
  });

  it("falls back to the category-setting deal's date when the prospect has none", () => {
    const past = prospect();
    const future = prospect();
    const own = couple({ event_date: null });
    const { tiers, cat } = run(
      [past, future, own],
      [
        deal(past.email, "Wedding", { event_date: "2026-09-05" }),
        deal(future.email, "Bridal shower"),
        deal(own.email, "Wedding", { event_date: "2026-08-01" }),
      ],
    );
    expect(cat("warm", "wedding")?.total).toBe(1);
    expect(tiers.warm.check.ok).toBe(true);
    expect(tiers.offer.total).toBe(0);
    expect(tiers.offer.check.ok).toBe(true);
  });

  it("prefers the prospect's own event_date over the deal's", () => {
    const p = couple({ event_date: NEXT_JUNE });
    const { tiers } = run([p], [deal(p.email, "Wedding", { event_date: "2026-08-01" })]);
    expect(tiers.offer.total).toBe(1);
  });

  it("does not apply to other categories", () => {
    const p = prospect({ event_date: YESTERDAY });
    const q = prospect();
    const { cat } = run([p, q], [deal(q.email, "Employee appreciation", { event_date: "2026-01-15" })]);
    expect(cat("warm", "no_deal")?.total).toBe(1);
    expect(cat("warm", "corporate")?.total).toBe(1);
  });
});
