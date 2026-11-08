// Named discount lines in the deal drawer (bj-finance #900): Holiday Gift and
// Referral Credit, $100 each, stored on deals.named_discounts (Catering-Manager
// migration 028) and printed by name on the quote's discount line. The label
// the drawer previews mirrors Catering-Manager modules/quote.py
// discount_line_label; these cases include the ones its tests pin.
//
// The drawer is rendered to static markup (no DOM here), with the Supabase
// browser client stubbed as the system boundary, as dealDrawerWinterMenu does.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DealDetailDrawer from "@/components/DealDetailDrawer";
import {
  addNamedDiscount,
  discountLineLabel,
  namedDiscountLines,
  removeNamedDiscount,
} from "@/lib/namedDiscounts";
import type { Deal } from "@/lib/types";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

const GIFT = { name: "Holiday Gift" as const, amount: 100 };
const CREDIT = { name: "Referral Credit" as const, amount: 100 };

describe("namedDiscountLines", () => {
  it("reads the column as Supabase returns it, or as JSON text", () => {
    expect(namedDiscountLines([GIFT])).toEqual([GIFT]);
    expect(namedDiscountLines('[{"name":"Referral Credit","amount":100}]')).toEqual([CREDIT]);
  });

  it("is empty for no lines and drops what the quote job would refuse", () => {
    for (const empty of [null, undefined, "", "not json", "{}", []]) {
      expect(namedDiscountLines(empty)).toEqual([]);
    }
    expect(
      namedDiscountLines([
        { name: "Promo", amount: 5 },
        { name: "Holiday Gift", amount: 0 },
        { name: "Referral Credit", amount: -100 },
        { name: "Referral Credit" },
        "Holiday Gift",
        null,
        GIFT,
      ]),
    ).toEqual([GIFT]);
  });
});

describe("discountLineLabel", () => {
  it("is the old words with no named line", () => {
    expect(discountLineLabel([], false)).toBe("Discounts or Additional Fees");
    expect(discountLineLabel([], true)).toBe("Discounts or Additional Fees");
  });

  it("names the lines, counts repeats, and keeps the old words for a netted fee", () => {
    expect(discountLineLabel([GIFT], false)).toBe("Holiday Gift");
    expect(discountLineLabel([GIFT, CREDIT, CREDIT], false)).toBe(
      "Holiday Gift + Referral Credit x2",
    );
    expect(discountLineLabel([GIFT], true)).toBe(
      "Holiday Gift + Discounts or Additional Fees",
    );
  });

  it("names the lines in the order they were added, not alphabetically", () => {
    expect(discountLineLabel([CREDIT, GIFT], false)).toBe("Referral Credit + Holiday Gift");
    expect(discountLineLabel([CREDIT, GIFT, CREDIT], false)).toBe(
      "Referral Credit x2 + Holiday Gift",
    );
  });
});

describe("adding and removing a line", () => {
  it("adds $100 lines at the end and clears the column when the last goes", () => {
    const two = addNamedDiscount(addNamedDiscount([], "Holiday Gift"), "Referral Credit");
    expect(two).toEqual([GIFT, CREDIT]);
    expect(removeNamedDiscount(two, 0)).toEqual([CREDIT]);
    expect(removeNamedDiscount([CREDIT, GIFT, CREDIT], 2)).toEqual([CREDIT, GIFT]);
    expect(removeNamedDiscount([GIFT], 0)).toBeNull();
  });
});

function mkDeal(overrides: Partial<Deal> = {}): Deal {
  const base: Partial<Deal> = {
    id: 1,
    stage: "Open",
    company: "Synthetic Co",
    contact_first_name: "Test",
    contact_last_name: "Person",
    package_name: "Cup or Cone Party",
    extras: "[]",
    toppings: "[]",
    event_date: "2026-12-05",
    guest_count: 40,
    short_notice_surcharge: 0,
  };
  return { ...base, ...overrides } as Deal;
}

function drawer(deal: Deal): string {
  return renderToStaticMarkup(createElement(DealDetailDrawer, { deal, onClose: () => {} }));
}

describe("the deal drawer's named discounts", () => {
  it("offers both lines on a deal with none, and says the quote line is unchanged", () => {
    const html = drawer(mkDeal());
    expect(html).toContain("Named discounts");
    expect(html).toContain("+ Holiday Gift (−$100)");
    expect(html).toContain("+ Referral Credit (−$100)");
    expect(html).toContain("Quote line: Discounts or Additional Fees");
  });

  it("shows the stored lines and the label the quote will print", () => {
    const html = drawer(mkDeal({ named_discounts: [GIFT, CREDIT, CREDIT] }));
    expect(html).toContain("Holiday Gift −$100.00");
    expect(html.match(/Referral Credit −\$100\.00/g)).toHaveLength(2);
    expect(html).toContain("Quote line: Holiday Gift + Referral Credit x2");
  });

  it("keeps the old words in the label when the surcharge field is also set", () => {
    const html = drawer(mkDeal({ named_discounts: [GIFT], short_notice_surcharge: -90 }));
    expect(html).toContain("Quote line: Holiday Gift + Discounts or Additional Fees");
  });

  it("keeps the old words for a short-notice fee too, not only a discount", () => {
    const html = drawer(mkDeal({ named_discounts: [GIFT], short_notice_surcharge: 50 }));
    expect(html).toContain("Quote line: Holiday Gift + Discounts or Additional Fees");
  });
});
