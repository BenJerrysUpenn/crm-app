import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import EmailCampaignsPrototype from "@/components/emailCampaignsPrototype/EmailCampaignsPrototype";
import { compute, type ProspectRow, type SentRow } from "@/lib/emailCampaignsPrototype/model";
import { WARM_TEMPLATE_KEY } from "@/lib/emailCampaignsPrototype/sequences";

// The "Reach everyone" verdict when a tier has nobody left to send to
// (bj-finance #670): a tier with people but no sequence says so, instead of
// claiming everyone has finished. Rendered as the page renders it, with the
// seed sequences (Cold and Warm have one email, Offer has none).
// Synthetic prospects only.

const NOW = new Date("2026-09-28T12:00:00Z");
const NO_SEQUENCE = "Nothing to send: no sequence yet.";
const NO_STEP_LEFT = "Nothing to send: nobody has a step left.";

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

function page(prospects: ProspectRow[], sent: SentRow[] = []): string {
  const payload = compute(
    { prospects, deals: [], sent, suppressedEmails: [], blockedDomains: [], mailboxes: [] },
    NOW,
  );
  return renderToStaticMarkup(createElement(EmailCampaignsPrototype, { payload }));
}

const count = (html: string, text: string) => html.split(text).length - 1;

describe("Email campaigns volume verdict: why nothing is sent", () => {
  it("says 'no sequence yet' for an Offer tier with people and no sequence", () => {
    const html = page([prospect({ ever_booked: true, last_event_date: "2026-05-02" })]);
    expect(count(html, NO_SEQUENCE)).toBe(1);
    // Cold and Warm are empty: nobody there has a step left.
    expect(count(html, NO_STEP_LEFT)).toBe(2);
  });

  it("says 'nobody has a step left' when everyone in Warm already had its one email", () => {
    const p = prospect({ last_outreach_at: "2026-09-01T12:00:00Z" });
    const html = page([p], [{ prospect_id: p.id, template: WARM_TEMPLATE_KEY }]);
    expect(count(html, NO_SEQUENCE)).toBe(0);
    expect(count(html, NO_STEP_LEFT)).toBe(3);
  });
});
