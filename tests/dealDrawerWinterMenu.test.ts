// What the deal drawer shows for a winter deal (bj-finance #717): the
// winter-menu warnings under the menu fields, before anyone presses Generate,
// and the deal's custom menu line and per-guest price override as stored.
//
// Rendered to static markup (no DOM in this test environment), so effects
// and handlers do not run. The Supabase browser client is the system
// boundary and is stubbed; nothing in a first render calls it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DealDetailDrawer from "@/components/DealDetailDrawer";
import type { Deal } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

function mkDeal(overrides: Partial<Deal> = {}): Deal {
  const base: Partial<Deal> = {
    id: 1,
    stage: "New Inquiry",
    company: "Synthetic Co",
    contact_first_name: "Test",
    contact_last_name: "Person",
    package_name: "Cup or Cone Party",
    extras: '["Belgian Waffle"]',
    toppings: "[]",
    event_date: "2026-12-05",
    guest_count: 40,
    custom_menu_line: "Waffle Sundae",
    price_override: null,
  };
  return { ...base, ...overrides } as Deal;
}

function drawer(deal: Deal): string {
  return renderToStaticMarkup(createElement(DealDetailDrawer, { deal, onClose: () => {} }));
}

describe("the deal drawer on a winter deal", () => {
  it("warns about a waffle sundae booked for July with no menu line", () => {
    const html = drawer(mkDeal({ event_date: "2026-07-10", custom_menu_line: null }));
    expect(html).toContain(
      "<li>Belgian Waffle: winter menu (Nov 1 - Mar 31), but the event is on 2026-07-10. It can still be quoted.</li>",
    );
    expect(html).toContain(
      "<li>Belgian Waffle: winter deals fill the custom menu line, or the quote prints the package name.</li>",
    );
  });

  it("shows no winter warning for a complete winter deal in season", () => {
    const html = drawer(mkDeal());
    expect(html).not.toContain("winter menu (Nov 1 - Mar 31)");
    expect(html).not.toContain("winter deals fill the custom menu line");
  });

  it("warns about winter toppings nothing bills, until a price override carries them", () => {
    const toppings = '["Hot Fudge","Hot Caramel","Cherry Compote"]';
    const unbilled =
      "<li>Hot Fudge, Hot Caramel, Cherry Compote picked but the Winter Pourable Toppings extra is not on the deal, so nothing bills them.</li>";
    expect(drawer(mkDeal({ toppings }))).toContain(unbilled);
    expect(drawer(mkDeal({ toppings, price_override: 21 }))).not.toContain(unbilled);
  });

  it("shows the stored custom menu line and price override", () => {
    const html = drawer(
      mkDeal({ custom_menu_line: "Winter Menu: Waffle Sundae", price_override: 21.5 }),
    );
    expect(html).toContain('value="Winter Menu: Waffle Sundae"');
    expect(html).toContain('value="21.5"');
  });
});
