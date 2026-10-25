// Shape of GET /api/call-desk/options — the one runtime source of every
// enumeration the guided deal form renders. Shared by the route handler and
// components/callDesk/GenerateDealForm.tsx so the two cannot drift.

import { HOT_CHOCOLATE_FLOAT_PARTY } from "@/lib/menuOptions";

export type DealFormOption = {
  value: string;
  label: string;
  hint: string | null;
};

export type DealFormPackageOption = {
  name: string;
  price: number;
  flavors_included: number;
  includes_waffle_cones: boolean;
  includes_sauce: boolean;
  includes_whipped_cream: boolean;
  includes_cookies: boolean;
  includes_brownies: boolean;
  dry_toppings_count: number;
  sort_order: number;
};

export type DealFormExtraOption = {
  name: string;
  price: number;
  per_serving_or_flat: string; // "per_serving" | "flat"
  taxable: boolean;
  notes: string | null;
  sort_order: number;
};

export type DealFormFlavorOption = {
  name: string;
  category: "ice_cream" | "non_dairy" | "sorbet";
  gf: boolean;
  vegan: boolean;
  allergens: string[];
};

export type DealFormOptionsResponse = {
  event_types: DealFormOption[];
  customer_profiles: DealFormOption[];
  packages: DealFormPackageOption[];
  extras: DealFormExtraOption[];
  flavors: DealFormFlavorOption[];
  toppings: string[];
  minimum_order: number;
  max_flavors: number;
  flavors_included: number;
};

/** One-line summary of what a package includes, from the pricing row.
 *
 *  The Price Book row has no flag for the Hot Chocolate Float Party's
 *  marshmallows (Alina, 2026-10-19), so they are named here by package, to
 *  agree with the drawer's description (lib/menuOptions.ts PACKAGES). */
export function packageIncludes(p: DealFormPackageOption): string {
  const bits: string[] = [`${p.flavors_included} flavors`];
  if (p.dry_toppings_count > 0) bits.push(`${p.dry_toppings_count} toppings`);
  if (p.includes_waffle_cones) bits.push("waffle cones");
  if (p.includes_sauce) bits.push("sauce");
  if (p.includes_whipped_cream) bits.push("whipped cream");
  if (p.name === HOT_CHOCOLATE_FLOAT_PARTY) bits.push("marshmallows");
  if (p.includes_cookies) bits.push("cookies");
  if (p.includes_brownies) bits.push("brownies");
  return bits.join(" · ");
}

/** Message returned (503) when supabase/crm/001_call_desk.sql has not been run
 *  in the target project yet. The UI surfaces it verbatim. */
export const OPTIONS_MIGRATION_MISSING =
  "deal_form_options missing — apply supabase/crm/001_call_desk.sql";

/** Default quantity to insert when an extra is added.
 *
 *  lib/menuOptions.ts::defaultExtraQuantity is the CRM's existing rule and wins
 *  for every extra it knows (it encodes product sense the pricing table does
 *  not: Personalized Pints is a `flat` line item but you order one per guest,
 *  Extra Toppings is `per_serving` but is a single ask). For an extra that
 *  exists only in pricing_extras we fall back to the priced unit:
 *  per_serving → guest count, flat → 1. */
export function defaultQuantityForExtra(
  extra: DealFormExtraOption,
  guestCount: number | null,
  known: (label: string) => number | null,
): number {
  const fromMenu = known(extra.name);
  if (fromMenu != null) return Math.max(1, fromMenu);
  if (extra.per_serving_or_flat === "per_serving") {
    return guestCount && guestCount > 0 ? guestCount : 1;
  }
  return 1;
}
