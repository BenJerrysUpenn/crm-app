// The winter catering menu in the deal drawer (bj-finance #717, Alina
// 2026-10-15). No new packages: a winter item is an
// existing package plus extras, and the quote prints the deal's custom menu
// line. Every winter item includes whipped cream and chocolate sauce (the $0
// extras on a Cup or Cone Party); a combo is a typed per-guest price.
//
//   Warmed Cookie and Brownie Sundaes  Cup or Cone Party + Cookies on half
//                                      the guests + Brownies on the other half
//   Waffle Sundae                      Cup or Cone Party + Belgian Waffle
//   Hot Chocolate Float                Hot Chocolate Float Party
//   Winter toppings                    Winter Dry / Winter Pourable Toppings,
//                                      3 picks per group
//
// The warnings here mirror Catering-Manager modules/winter_menu.py, which
// the quote job runs; the drawer shows them before anyone presses Generate.
// They never block a save or a quote.

import {
  BELGIAN_WAFFLE,
  HOT_CHOCOLATE_FLOAT_PARTY,
  TOPPING_NAMES,
  WINTER_DRY_TOPPINGS,
  WINTER_DRY_TOPPINGS_EXTRA,
  WINTER_POURABLE_TOPPINGS,
  WINTER_POURABLE_TOPPINGS_EXTRA,
  WINTER_TOPPING_PICKS,
  parseExtrasField,
  parseToppingsField,
} from "@/lib/menuOptions";
import type { Deal } from "@/lib/types";

// Each winter extra, with the topping group the customer picks from.
const WINTER_EXTRAS: ReadonlyArray<{
  label: string;
  group: ReadonlyArray<string> | null;
}> = [
  { label: BELGIAN_WAFFLE, group: null },
  { label: WINTER_DRY_TOPPINGS_EXTRA, group: WINTER_DRY_TOPPINGS },
  { label: WINTER_POURABLE_TOPPINGS_EXTRA, group: WINTER_POURABLE_TOPPINGS },
];

/** True for Nov 1 - Mar 31 (both ends included), null when `eventDate` is
 *  not a real 'YYYY-MM-DD' date. Checked in UTC, so no timezone can move
 *  the day. */
function inWinterSeason(eventDate: string | null | undefined): boolean | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((eventDate ?? "").trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return month >= 11 || month <= 3;
}

/** The winter items on a deal, in menu order, each named once. */
function winterItems(
  packageName: string | null | undefined,
  extras: ReadonlyArray<string>,
): string[] {
  const items = packageName === HOT_CHOCOLATE_FLOAT_PARTY ? [HOT_CHOCOLATE_FLOAT_PARTY] : [];
  for (const { label } of WINTER_EXTRAS) {
    if (extras.includes(label)) items.push(label);
  }
  return items;
}

/** The deal fields the warnings read, as the deals row stores them. */
export type WinterDealFields = Pick<
  Deal,
  "package_name" | "extras" | "toppings" | "event_date" | "custom_menu_line" | "price_override"
>;

/** What the drawer warns about a deal's winter items. Same four rules as
 *  modules/winter_menu.py `warnings`. */
export function winterMenuWarnings(deal: WinterDealFields): string[] {
  const out: string[] = [];
  const extras = parseExtrasField(deal.extras);
  const toppings = parseToppingsField(deal.toppings);
  const items = winterItems(deal.package_name, extras);
  if (items.length > 0) {
    const named = items.join(", ");
    if (inWinterSeason(deal.event_date) === false) {
      out.push(
        `${named}: winter menu (Nov 1 - Mar 31), but the event is on ${deal.event_date}. It can still be quoted.`,
      );
    }
    if (!(deal.custom_menu_line ?? "").trim()) {
      out.push(
        `${named}: winter deals fill the custom menu line, or the quote prints the package name.`,
      );
    }
  }
  for (const { label, group } of WINTER_EXTRAS) {
    if (!group) continue;
    const picks = toppings.filter((t) => group.includes(t));
    if (extras.includes(label)) {
      if (picks.length !== WINTER_TOPPING_PICKS) {
        out.push(
          `${label}: ${picks.length} picked from the group; the customer picks ${WINTER_TOPPING_PICKS}.`,
        );
      }
      continue;
    }
    const winterOnly = picks.filter((t) => !TOPPING_NAMES.includes(t));
    if (winterOnly.length > 0 && deal.price_override == null) {
      out.push(
        `${winterOnly.join(", ")} picked but the ${label} extra is not on the deal, so nothing bills them.`,
      );
    }
  }
  return out;
}

/** What the Price override field stores. It is a per-guest price, so only a
 *  positive number is one (deals_price_override_check, Catering-Manager
 *  migration 026: NULL or > 0). Blank, "0", negatives and non-numbers clear
 *  it back to the Price Book price, never a $0 event. */
export function positiveOrNull(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}
