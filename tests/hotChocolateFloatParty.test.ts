// Hot Chocolate Float Party (crm/008): the package name the deal drawer
// offers, the CHECK constraint the migration writes, and the "missing
// toppings" badge.
//
// The drawer's list (lib/menuOptions.ts PACKAGES) is hardcoded, while the
// database refuses any package_name its CHECK does not list. The migration's
// list is read from the SQL file itself so the two cannot drift silently: a
// name in the drawer that the CHECK refuses would only show up as a failed
// save in front of a customer. The Price Book row is read from the same
// file by column name, so each assertion is about one value Alina set and
// holds whatever the INSERT's column order or line breaks. A migration's
// SQL is itself the artefact here (CODING_STANDARDS.md:20): it cannot be
// run hermetically (:24).

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

type SqlValue = string | number | boolean | null;

/** The pricing_packages row the migration inserts for `name`, keyed by
 *  column name, so the assertions hold whatever the column order or
 *  formatting of the INSERT. */
function priceBookRow(sql: string, name: string): Record<string, SqlValue> {
  const m =
    /INSERT INTO public\.pricing_packages\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/.exec(
      sql,
    );
  if (!m) throw new Error("no pricing_packages INSERT in the migration");
  const columns = m[1].split(",").map((c) => c.trim());
  const values: SqlValue[] = m[2].split(",").map((raw) => {
    const v = raw.trim();
    if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
    if (/^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
    if (/^null$/i.test(v)) return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    throw new Error(`unparsed SQL value: ${v}`);
  });
  if (values.length !== columns.length) {
    throw new Error(`${columns.length} columns but ${values.length} values`);
  }
  const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
  if (row.name !== name) throw new Error(`the INSERT is for ${String(row.name)}, not ${name}`);
  return row;
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

});

describe("crm/008 Price Book row", () => {
  const row = priceBookRow(MIGRATION, HOT_CHOC);

  it("prices the package at $8.00 a guest", () => {
    expect(row.price).toBe(8);
  });

  it("includes chocolate sauce and whipped cream and no dry toppings", () => {
    expect(row.includes_sauce).toBe(true);
    expect(row.includes_whipped_cream).toBe(true);
    expect(row.dry_toppings_count).toBe(0);
    expect(row.includes_waffle_cones).toBe(false);
  });

  it("sells cookies and brownies as upgrades, not inclusions", () => {
    expect(row.includes_cookies).toBe(false);
    expect(row.includes_brownies).toBe(false);
  });

  it("brings 3 flavors, staffs at sundae throughput and lists last", () => {
    expect(row.flavors_included).toBe(3);
    expect(row.service_style).toBe("sundae");
    expect(row.sort_order).toBe(8);
  });

  it("never overwrites a later Price Book edit on a re-run", () => {
    expect(MIGRATION).toMatch(
      /INSERT INTO public\.pricing_packages[\s\S]*?\)\s*ON CONFLICT \(name\) DO NOTHING;/,
    );
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
