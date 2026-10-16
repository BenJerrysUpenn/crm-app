// The winter catering menu in the deal drawer (bj-finance #717, Alina
// 2026-10-15). No new packages: a winter item is an existing package plus
// extras, and the quote prints the deal's custom menu line.
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
  TOPPING_NAMES,
  WINTER_DRY_TOPPINGS,
  WINTER_POURABLE_TOPPINGS,
  WINTER_TOPPING_PICKS,
} from "@/lib/menuOptions";

const HOT_CHOCOLATE_PACKAGE = "Hot Chocolate Float Party";

// Each winter extra, with the topping group the customer picks from.
const WINTER_EXTRAS: ReadonlyArray<{
  label: string;
  group: ReadonlyArray<string> | null;
}> = [
  { label: "Belgian Waffle", group: null },
  { label: "Winter Dry Toppings", group: WINTER_DRY_TOPPINGS },
  { label: "Winter Pourable Toppings", group: WINTER_POURABLE_TOPPINGS },
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
  const items = packageName === HOT_CHOCOLATE_PACKAGE ? [HOT_CHOCOLATE_PACKAGE] : [];
  for (const { label } of WINTER_EXTRAS) {
    if (extras.includes(label)) items.push(label);
  }
  return items;
}

export type WinterDealView = {
  packageName: string | null | undefined;
  extras: ReadonlyArray<string>;
  toppings: ReadonlyArray<string>;
  eventDate: string | null | undefined;
  customMenuLine: string | null | undefined;
  priceOverride: number | null | undefined;
};

/** What the drawer warns about a deal's winter items. Same four rules as
 *  modules/winter_menu.py `warnings`. */
export function winterMenuWarnings(deal: WinterDealView): string[] {
  const out: string[] = [];
  const items = winterItems(deal.packageName, deal.extras);
  if (items.length > 0) {
    const named = items.join(", ");
    if (inWinterSeason(deal.eventDate) === false) {
      out.push(
        `${named}: winter menu (Nov 1 - Mar 31), but the event is on ${deal.eventDate}. It can still be quoted.`,
      );
    }
    if (!(deal.customMenuLine ?? "").trim()) {
      out.push(
        `${named}: winter deals fill the custom menu line, or the quote prints the package name.`,
      );
    }
  }
  for (const { label, group } of WINTER_EXTRAS) {
    if (!group) continue;
    const picks = deal.toppings.filter((t) => group.includes(t));
    if (deal.extras.includes(label)) {
      if (picks.length !== WINTER_TOPPING_PICKS) {
        out.push(
          `${label}: ${picks.length} picked from the group; the customer picks ${WINTER_TOPPING_PICKS}.`,
        );
      }
      continue;
    }
    const winterOnly = picks.filter((t) => !TOPPING_NAMES.includes(t));
    if (winterOnly.length > 0 && deal.priceOverride == null) {
      out.push(
        `${winterOnly.join(", ")} picked but the ${label} extra is not on the deal, so nothing bills them.`,
      );
    }
  }
  return out;
}
