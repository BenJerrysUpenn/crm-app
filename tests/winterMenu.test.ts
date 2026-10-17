// The winter catering menu in the deal drawer (bj-finance #717): the three
// new extras and the winter topping groups the drawer offers, the warnings
// it shows, and the Price Book rows migration crm/012 inserts.
//
// The warnings mirror Catering-Manager modules/winter_menu.py `warnings`,
// which the quote job runs; these tests pin the same four rules. The
// migration's rows are read from the SQL file by column name: a migration's
// SQL is itself the artefact here (CODING_STANDARDS.md:20) and cannot be
// run hermetically (:24).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DRAWER_TOPPING_OPTIONS,
  EXTRA_BY_LABEL,
  defaultExtraQuantity,
  normaliseExtraLabel,
  parseToppingsField,
  serializeMultiselect,
} from "@/lib/menuOptions";
import { positiveOrNull, winterMenuWarnings, type WinterDealView } from "@/lib/winterMenu";

const POURABLES = ["Hot Fudge", "Hot Caramel", "Cherry Compote"];
const OLGA_LINE = "Winter Menu: Hot Chocolate Float + Waffle Sundae (with pourable toppings)";

function deal(over: Partial<WinterDealView> = {}): WinterDealView {
  return {
    packageName: "Cup or Cone Party",
    extras: Array(40).fill("Belgian Waffle"),
    toppings: [],
    eventDate: "2026-12-05",
    customMenuLine: "Waffle Sundae",
    priceOverride: null,
    ...over,
  };
}

describe("the winter extras in the drawer", () => {
  it("prices each per guest and defaults its quantity to the guest count", () => {
    for (const [label, price] of [
      ["Belgian Waffle", 3],
      ["Winter Dry Toppings", 2],
      ["Winter Pourable Toppings", 2],
    ] as const) {
      expect(EXTRA_BY_LABEL.get(label)).toMatchObject({ price, unit: "per_guest" });
      expect(defaultExtraQuantity(label, 40)).toBe(40);
    }
  });

  it("offers the $0 sundae garnishes once each", () => {
    for (const label of ["Whipped Cream", "Chocolate Sauce"]) {
      expect(EXTRA_BY_LABEL.get(label)?.price).toBe(0);
      expect(defaultExtraQuantity(label, 40)).toBe(1);
    }
  });

  it("reads the winter names back from stored or typed text", () => {
    expect(normaliseExtraLabel("belgian waffles")).toBe("Belgian Waffle");
    expect(normaliseExtraLabel("Winter Dry Toppings")).toBe("Winter Dry Toppings");
    // The $0 strip-and-flag alias keeps its meaning.
    expect(normaliseExtraLabel("dry toppings")).toBe("Extra Toppings");
  });

  it("offers the summer toppings, then both winter groups, each name once", () => {
    // Spelled as Catering-Manager modules/pricing_data.py spells them; Walnuts
    // is in the summer list and the winter dry group, so it appears once.
    expect(DRAWER_TOPPING_OPTIONS).toEqual([
      "Rainbow Sprinkles",
      "Chocolate Sprinkles",
      "M&M's",
      "Reese's Pieces",
      "Oreo Crumbles",
      "Peanuts",
      "Walnuts",
      "Gummy Bears",
      "Crushed Candy Cane",
      "Gingersnap Cookies",
      "Marshmallow",
      "Pecans",
      "Biscoff Cookie Crumble",
      "Hot Fudge",
      "Hot Caramel",
      "Apple Pie Filling",
      "Cherry Compote",
      "Cookie Butter Drizzle",
      "Choco Hazelnut Drizzle",
    ]);
  });

  it("keeps the winter picks the drawer stores, by name, when it reads them back", () => {
    const picks = ["Walnuts", "Choco Hazelnut Drizzle", "Cookie Butter Drizzle", "Hot Fudge"];
    expect(parseToppingsField(serializeMultiselect(picks))).toEqual(picks);
  });
});

describe("winterMenuWarnings: the season", () => {
  const OUT_OF_SEASON = (d: string) =>
    `Belgian Waffle: winter menu (Nov 1 - Mar 31), but the event is on ${d}. It can still be quoted.`;

  it("is Nov 1 through Mar 31", () => {
    for (const d of ["2026-11-01", "2026-12-25", "2027-03-31"]) {
      expect(winterMenuWarnings(deal({ eventDate: d }))).toEqual([]);
    }
    for (const d of ["2027-04-01", "2026-07-04", "2026-10-31"]) {
      expect(winterMenuWarnings(deal({ eventDate: d }))).toEqual([OUT_OF_SEASON(d)]);
    }
  });

  it("gives no season verdict without a real date", () => {
    for (const d of [null, undefined, "", "TBD", "2026-02-30", "2026-06-31"]) {
      expect(winterMenuWarnings(deal({ eventDate: d }))).toEqual([]);
    }
  });
});

describe("winterMenuWarnings: the winter items it names", () => {
  it("names the package and each winter extra in menu order, once", () => {
    expect(
      winterMenuWarnings(
        deal({
          packageName: "Hot Chocolate Float Party",
          extras: ["Winter Pourable Toppings", "Winter Pourable Toppings", "Cookies", "Belgian Waffle"],
          toppings: POURABLES,
          customMenuLine: null,
        }),
      ),
    ).toEqual([
      "Hot Chocolate Float Party, Belgian Waffle, Winter Pourable Toppings: winter deals fill the custom menu line, or the quote prints the package name.",
    ]);
    expect(
      winterMenuWarnings(deal({ extras: ["Cookies"], eventDate: "2026-07-10", customMenuLine: null })),
    ).toEqual([]);
  });
});

describe("winterMenuWarnings", () => {
  it("says nothing about a complete winter deal in season", () => {
    expect(
      winterMenuWarnings(
        deal({
          extras: [...Array(40).fill("Belgian Waffle"), ...Array(40).fill("Winter Pourable Toppings")],
          toppings: POURABLES,
        }),
      ),
    ).toEqual([]);
  });

  it("warns out of season and without a menu line, and still lets it quote", () => {
    expect(winterMenuWarnings(deal({ eventDate: "2026-07-10", customMenuLine: " " }))).toEqual([
      "Belgian Waffle: winter menu (Nov 1 - Mar 31), but the event is on 2026-07-10. It can still be quoted.",
      "Belgian Waffle: winter deals fill the custom menu line, or the quote prints the package name.",
    ]);
  });

  it("says nothing about a summer deal with no winter item, in any month", () => {
    expect(
      winterMenuWarnings(
        deal({ extras: ["Cookies"], toppings: ["Peanuts"], eventDate: "2026-07-10", customMenuLine: null }),
      ),
    ).toEqual([]);
  });

  it("does not call an undated deal out of season", () => {
    expect(winterMenuWarnings(deal({ eventDate: null }))).toEqual([]);
  });

  it("wants three picks from a toppings group the deal bills", () => {
    expect(
      winterMenuWarnings(
        deal({ extras: ["Winter Dry Toppings"], toppings: ["Pecans", "Marshmallow", "Peanuts"] }),
      ),
    ).toEqual(["Winter Dry Toppings: 2 picked from the group; the customer picks 3."]);
    expect(
      winterMenuWarnings(
        deal({
          extras: ["Winter Pourable Toppings"],
          toppings: [...POURABLES, "Apple Pie Filling"],
        }),
      ),
    ).toEqual(["Winter Pourable Toppings: 4 picked from the group; the customer picks 3."]);
  });

  it("flags winter picks nothing bills, unless an override carries them", () => {
    expect(winterMenuWarnings(deal({ toppings: POURABLES }))).toEqual([
      "Hot Fudge, Hot Caramel, Cherry Compote picked but the Winter Pourable Toppings extra is not on the deal, so nothing bills them.",
    ]);
    expect(
      winterMenuWarnings(
        deal({
          packageName: "Hot Chocolate Float Party",
          extras: [],
          toppings: POURABLES,
          customMenuLine: OLGA_LINE,
          priceOverride: 21,
        }),
      ),
    ).toEqual([]);
  });

  it("does not read summer walnuts as a winter pick", () => {
    expect(
      winterMenuWarnings(
        deal({ packageName: "Sundae Party", extras: [], toppings: ["Walnuts", "Peanuts"] }),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Migration crm/012
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync(
  resolve(__dirname, "../supabase/crm/012_winter_menu_extras.sql"),
  "utf8",
);

type SqlValue = string | number | boolean | null;

/** Every row the migration's pricing_extras INSERT carries, keyed by column. */
function priceBookRows(sql: string): Record<string, SqlValue>[] {
  const m =
    /INSERT INTO public\.pricing_extras\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)\s*ON CONFLICT/.exec(sql);
  if (!m) throw new Error("no pricing_extras INSERT in the migration");
  const columns = m[1].split(",").map((c) => c.trim());
  const tuples = [...m[2].matchAll(/\(((?:'(?:[^']|'')*'|[^()'])*)\)/g)].map((t) => t[1]);
  return tuples.map((tuple) => {
    const values = [...tuple.matchAll(/'((?:[^']|'')*)'|([^,\s][^,]*)/g)].map((v): SqlValue => {
      if (v[1] !== undefined) return v[1].replace(/''/g, "'");
      const raw = v[2].trim();
      if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true";
      if (/^null$/i.test(raw)) return null;
      if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      throw new Error(`unparsed SQL value: ${raw}`);
    });
    if (values.length !== columns.length) {
      throw new Error(`${columns.length} columns but ${values.length} values`);
    }
    return Object.fromEntries(columns.map((c, i) => [c, values[i]]));
  });
}

describe("migration crm/012", () => {
  const rows = priceBookRows(MIGRATION);

  it("inserts the three extras at the drawer's prices, per guest and taxable", () => {
    expect(rows.map((r) => r.name)).toEqual([
      "Belgian Waffle",
      "Winter Dry Toppings",
      "Winter Pourable Toppings",
    ]);
    for (const row of rows) {
      const extra = EXTRA_BY_LABEL.get(String(row.name));
      expect(row.price).toBe(extra?.price);
      expect(row.per_serving_or_flat).toBe("per_serving");
      expect(row.taxable).toBe(true);
      expect(row.duplicate_with).toBeNull();
    }
  });

  it("lists them after every existing row and never overwrites one", () => {
    expect(rows.map((r) => r.sort_order)).toEqual([13, 14, 15]);
    expect(MIGRATION).toMatch(/ON CONFLICT \(name\) DO NOTHING;/);
  });
});

describe("positiveOrNull (the Price override field)", () => {
  it("stores a positive per-guest price", () => {
    expect(positiveOrNull("21.50")).toBe(21.5);
    expect(positiveOrNull(" 18 ")).toBe(18);
  });

  it.each(["", "   ", "0", "0.00", "-5", "abc"])(
    "clears the override for %j, never storing a free event",
    (typed) => {
      expect(positiveOrNull(typed)).toBeNull();
    },
  );
});
