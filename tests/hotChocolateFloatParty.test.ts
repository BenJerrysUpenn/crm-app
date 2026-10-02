// Hot Chocolate Float Party (crm/008): the package name the deal drawer
// offers, the CHECK constraint the migration writes, and the "missing
// toppings" badge.
//
// The drawer's list (lib/menuOptions.ts PACKAGES) is hardcoded, while the
// database refuses any package_name its CHECK does not list. The migration's
// list is read from the SQL file itself so the two cannot drift silently: a
// name in the drawer that the CHECK refuses would only show up as a failed
// save in front of a customer.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAMES, packageDescription } from "@/lib/menuOptions";
import { missingRequiredFields } from "@/lib/required";
import type { Deal } from "@/lib/types";

const HOT_CHOC = "Hot Chocolate Float Party";

const MIGRATION = readFileSync(
  resolve(__dirname, "../supabase/crm/008_hot_chocolate_float_party.sql"),
  "utf8",
);

/** The names inside deals_package_name_check's IN (...) list. */
function checkListedPackages(sql: string): string[] {
  const m = /ADD CONSTRAINT deals_package_name_check[\s\S]*?IN \(([\s\S]*?)\)\);/.exec(
    sql,
  );
  if (!m) throw new Error("no deals_package_name_check in the migration");
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

// The live definition on 2026-10-02, before crm/008.
const LIVE_BEFORE_008 = [
  "Cup or Cone Party",
  "Single Scoop Cup and Cone Party",
  "Waffle Cone Party",
  "Sundae Party",
  "Super Sundae Party",
  "Deluxe Sundae Party",
  "Super Deluxe Sundae Party",
  "DIY Ice Cream Social",
  "DIY Sundae Upgrade",
];

describe("package name", () => {
  it("is offered in the deal drawer, spelled exactly", () => {
    expect(PACKAGE_NAMES).toContain(HOT_CHOC);
  });

  it("describes what the guest gets", () => {
    const d = packageDescription(HOT_CHOC);
    expect(d).toMatch(/hot chocolate/i);
    expect(d).toMatch(/whipped cream/i);
    expect(d).toMatch(/chocolate sauce/i);
  });
});

describe("crm/008 deals_package_name_check", () => {
  const listed = checkListedPackages(MIGRATION);

  it("adds the package and keeps every package the live CHECK allowed", () => {
    expect(listed).toEqual([...LIVE_BEFORE_008, HOT_CHOC]);
  });

  it("allows every package the deal drawer offers", () => {
    for (const name of PACKAGE_NAMES) expect(listed).toContain(name);
  });

  it("prices the package at $8.00 a guest in the Price Book", () => {
    expect(MIGRATION).toMatch(
      /\('Hot Chocolate Float Party', 8\.00, 3, false, true,\s+true, false, false,\s+0, 'sundae', 8\)/,
    );
    // A re-run must not overwrite a later Price Book edit.
    expect(MIGRATION).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
  });
});

describe("missing-toppings badge", () => {
  function bookedDeal(pkg: string): Deal {
    return {
      stage: "Booked Unpaid",
      contact_first_name: "Jordan",
      contact_email: "jordan@example.org",
      event_date: "2026-12-04",
      event_start_time: "14:00",
      event_end_time: "16:00",
      venue_address: "3730 Walnut St, Philadelphia, PA",
      guest_count: 60,
      package_name: pkg,
      round_trip_miles: 4,
      mileage_charge_eligible: 1,
      subtotal_pretax: 480,
      total_with_tax: 518.4,
      signed_contract_total: 518.4,
      flavors: '["Vanilla","Chocolate"]',
      toppings: "[]",
    } as unknown as Deal;
  }

  const missing = (pkg: string) =>
    missingRequiredFields(bookedDeal(pkg)).map((m) => m.field);

  // Whipped cream and chocolate sauce only: no dry toppings to pick.
  it("does not ask a Hot Chocolate Float Party for toppings", () => {
    expect(missing(HOT_CHOC)).toEqual([]);
  });

  it("still asks a sundae package for toppings", () => {
    expect(missing("Sundae Party")).toEqual(["toppings"]);
  });
});
