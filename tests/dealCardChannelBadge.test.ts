// What the pipeline card shows for a deal's channel (bj-finance #715 [task]
// Catering deals record channel + ad platform): an ad lead's card carries the
// "Ad · <platform>" badge with the campaign and ad as hover text; a site-form
// deal, and a row from before Catering-Manager migration 024, carries none.
//
// Rendered with `dragging` so the card body renders without a DndContext.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DealCard from "@/components/DealCard";
import type { Deal } from "@/lib/types";

function mkDeal(overrides: Partial<Deal> = {}): Deal {
  const base: Partial<Deal> = {
    id: 1,
    stage: "New Inquiry",
    company: "Synthetic Co",
    contact_first_name: "Test",
    contact_last_name: "Person",
    event_date: null,
    guest_count: null,
    total_with_tax: null,
    payment_status: "Unpaid",
    last_outbound_at: null,
  };
  return { ...base, ...overrides } as Deal;
}

function card(deal: Deal): string {
  return renderToStaticMarkup(createElement(DealCard, { deal, dragging: true }));
}

/** The badge the card shows: its text and hover title, or null for no badge. */
function badge(deal: Deal): { text: string; title: string | null } | null {
  const m = card(deal).match(/<span([^>]*)>(Ad(?: · [^<]+)?)<\/span>/);
  if (!m) return null;
  const title = m[1].match(/title="([^"]*)"/);
  return { text: m[2], title: title ? title[1] : null };
}

describe("DealCard channel badge", () => {
  it("shows an ad lead's platform, with the campaign and ad on hover", () => {
    const shown = badge(
      mkDeal({
        source: "ad_form",
        ad_platform: "instagram",
        ad_campaign_name: "Winter catering",
        ad_name: "Float reel",
      }),
    );
    expect(shown).toEqual({
      text: "Ad · Instagram",
      title: "Campaign: Winter catering\nAd: Float reel",
    });
  });

  it("shows the badge without hover text when no campaign or ad is recorded", () => {
    expect(badge(mkDeal({ source: "ad_form", ad_platform: "facebook" }))).toEqual({
      text: "Ad · Facebook",
      title: null,
    });
  });

  it("adds exactly one badge to an ad lead's card and none to any other", () => {
    const spans = (deal: Deal) => card(deal).split("<span").length - 1;
    expect(spans(mkDeal({ source: "ad_form", ad_platform: "tiktok" }))).toBe(
      spans(mkDeal({ source: "form" })) + 1,
    );
  });

  it("leaves a site-form deal's card unchanged by stray ad fields", () => {
    expect(
      card(
        mkDeal({
          source: "form",
          ad_platform: "instagram",
          ad_campaign_name: "Winter catering",
          ad_name: "Float reel",
        }),
      ),
    ).toBe(card(mkDeal({ source: "form" })));
  });

  it("shows no badge on a site-form deal or a row from before migration 024", () => {
    for (const deal of [
      mkDeal({ source: "form", ad_platform: "instagram" }),
      mkDeal(),
    ]) {
      expect(badge(deal)).toBeNull();
    }
  });
});
