import { describe, expect, it } from "vitest";
import { compute, type ProspectRow, type RawData } from "@/lib/emailCampaignsPrototype/model";

// What the Email campaigns page is handed once the mock rows are gone
// (bj-finance #670): no always-0 "Seasonal menu list" category on Warm, and
// Apollo as the Cold tier's only source. Synthetic prospects only.

const NOW = new Date("2026-09-28T12:00:00Z");

let nextId = 1;
function prospect(over: Partial<ProspectRow>): ProspectRow {
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

function tiers(prospects: ProspectRow[]) {
  const payload = compute(
    { prospects, deals: [], sent: [], suppressedEmails: [], blockedDomains: [], mailboxes: [] } satisfies RawData,
    NOW,
  );
  return Object.fromEntries(payload.tiers.map((t) => [t.key, t]));
}

describe("Email campaigns payload: only real categories and sources", () => {
  it("lists only the Warm categories people are in, with no empty Seasonal menu list", () => {
    const t = tiers([prospect({ ever_booked: true, last_event_date: "2025-03-14" })]);
    expect(t.warm.categories.map((c) => c.key)).toEqual(["past_booker"]);
    expect(t.warm.categories.every((c) => c.total > 0)).toBe(true);
  });

  it("shows Apollo as the Cold tier's only source, counting everyone in the tier", () => {
    const t = tiers([
      prospect({ engine: "cold", category: "corporate" }),
      prospect({ engine: "cold", category: "university" }),
      prospect({ engine: "warm" }),
    ]);
    expect(t.cold.sources).toEqual([{ label: "Apollo", n: 2, tag: "derived" }]);
    expect(t.warm.sources).toBeUndefined();
    expect(t.offer.sources).toBeUndefined();
  });
});
