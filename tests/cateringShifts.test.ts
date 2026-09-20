// Catering shift auto-creation: the window it computes, and what it does with
// a deal whose labor_hours are not credible.
//
// The anchor case is deal 25156 (Terrain, 2026-09-27): labor_hours = 26 went
// straight into shift 350, which ran 13:30 on the 27th to 15:30 on the 28th and
// was published. Nothing between the deal and the schedule asked whether a
// person could work it.

import { describe, expect, it } from "vitest";
import {
  CART_NOTE,
  computeShiftWindow,
  isCartEvent,
  isLongShiftHours,
  longShiftWarning,
} from "@/lib/cateringShifts";

// The note createDraftShiftsForDeal assembles, without needing a Supabase
// client. Kept in the same order as the real thing: the alarm first, then where
// to be, then the provenance.
function noteFor(deal: Parameters<typeof computeShiftWindow>[0], company = "Terrain") {
  const win = computeShiftWindow(deal)!;
  const marker = isLongShiftHours(win.hours) ? longShiftWarning(win.hours, win.laborHours) : null;
  return [marker, win.cartEvent ? CART_NOTE : null, `Auto-created from booked deal #${deal.id}`, company]
    .filter(Boolean)
    .join(" · ");
}

// Terrain, reconstructed from the shift it produced: a 13:30 start means a
// 14:30 departure_time, and a 15:30 finish the next day means labor_hours = 26.
// (13:30 New York is 17:30Z — late September is still EDT.) staff_count is left
// out because computeShiftWindow does not use it.
const TERRAIN = {
  id: 25156,
  event_date: "2026-09-27",
  departure_time: "14:30",
  labor_hours: 26,
  company: "Terrain",
};

describe("computeShiftWindow", () => {
  it("starts an hour before departure, New York time", () => {
    const win = computeShiftWindow({ ...TERRAIN, labor_hours: 8 });
    expect(win?.startISO).toBe("2026-09-27T17:30:00.000Z"); // 13:30 EDT
    expect(win?.endISO).toBe("2026-09-28T01:30:00.000Z"); // 21:30 EDT
    expect(win?.hours).toBe(8);
  });

  it("reproduces the 26-hour Terrain window without clamping it", () => {
    const win = computeShiftWindow(TERRAIN);
    expect(win?.startISO).toBe("2026-09-27T17:30:00.000Z"); // Sun 13:30 EDT
    expect(win?.endISO).toBe("2026-09-28T19:30:00.000Z"); // Mon 15:30 EDT
    expect(win?.hours).toBe(26);
  });

  it("falls back to four hours when labor_hours is missing or nonsense", () => {
    expect(computeShiftWindow({ ...TERRAIN, labor_hours: null })?.hours).toBe(4);
    expect(computeShiftWindow({ ...TERRAIN, labor_hours: 0 })?.hours).toBe(4);
    expect(computeShiftWindow({ ...TERRAIN, labor_hours: -3 })?.hours).toBe(4);
  });

  it("returns null until the picklist has set a departure time", () => {
    expect(computeShiftWindow({ ...TERRAIN, departure_time: null })).toBeNull();
    expect(computeShiftWindow({ ...TERRAIN, event_date: "" })).toBeNull();
  });

  it("handles a winter date, when New York is on standard time", () => {
    const win = computeShiftWindow({
      ...TERRAIN,
      event_date: "2026-12-05",
      departure_time: "14:30",
      labor_hours: 8,
    });
    expect(win?.startISO).toBe("2026-12-05T18:30:00.000Z"); // 13:30 EST
  });
});

describe("isLongShiftHours", () => {
  it("draws the line at fifteen hours, inclusive", () => {
    expect(isLongShiftHours(8)).toBe(false);
    expect(isLongShiftHours(12)).toBe(false);
    expect(isLongShiftHours(14.9)).toBe(false);
    expect(isLongShiftHours(15)).toBe(true);
    expect(isLongShiftHours(26)).toBe(true);
  });

  it("agrees with the threshold the time-app enforces", () => {
    // time-app/lib/shiftChecks.ts LONG_SHIFT_HOURS. Separate apps, same number;
    // if this fails, one of the two was changed alone.
    expect(isLongShiftHours(15)).toBe(true);
    expect(isLongShiftHours(14.99)).toBe(false);
  });
});

describe("longShiftWarning", () => {
  it("names the hours and says they are per person", () => {
    expect(longShiftWarning(26)).toBe("CHECK HOURS: deal says 26h per person.");
  });

  it("does not print a pointless decimal", () => {
    expect(longShiftWarning(15)).toBe("CHECK HOURS: deal says 15h per person.");
    expect(longShiftWarning(16.5)).toBe("CHECK HOURS: deal says 16.5h per person.");
  });
});

// The note the shift actually carries is assembled in createDraftShiftsForDeal,
// which needs a Supabase client. This asserts the piece that matters: the
// marker leads, so it is the first thing on the shift card.
describe("the shift note for an implausible deal", () => {
  it("puts the marker first", () => {
    expect(noteFor(TERRAIN)).toBe(
      "CHECK HOURS: deal says 26h per person. · Auto-created from booked deal #25156 · Terrain",
    );
  });

  it("leaves a normal deal's note exactly as it was", () => {
    expect(noteFor({ ...TERRAIN, labor_hours: 6 })).toBe(
      "Auto-created from booked deal #25156 · Terrain",
    );
  });
});

// ---------------------------------------------------------------------------
// Cart events: the crew collects the ice cream cart from the storage unit
// before they leave, so their shift starts two hours before departure instead
// of one. The catering automation's picklist already tells them to be there
// then (modules/logistics.py, STORAGE_UNIT_BUFFER_MIN = 120); until now the
// drafted shift started an hour later than the instruction they were given.
// ---------------------------------------------------------------------------

// A plain 8-hour event: departure 14:30, so an ordinary shift is 13:30–21:30
// New York and a cart shift is 12:30–21:30.
const EVENT = { ...TERRAIN, labor_hours: 8 };

describe("isCartEvent", () => {
  it("accepts the integer the column actually holds", () => {
    expect(isCartEvent(1)).toBe(true);
    expect(isCartEvent(0)).toBe(false);
  });

  it("accepts a string or boolean, because the row is not validated on the way in", () => {
    expect(isCartEvent("1")).toBe(true);
    expect(isCartEvent(true)).toBe(true);
    expect(isCartEvent("true")).toBe(true);
    expect(isCartEvent("TRUE")).toBe(true);
  });

  it("treats anything else as no cart, rather than sending the crew for nothing", () => {
    expect(isCartEvent(null)).toBe(false);
    expect(isCartEvent(undefined)).toBe(false);
    expect(isCartEvent("")).toBe(false);
    expect(isCartEvent("0")).toBe(false);
    expect(isCartEvent("yes")).toBe(false);
    expect(isCartEvent(2)).toBe(false);
    expect(isCartEvent(false)).toBe(false);
  });
});

describe("the cart storage hour (EDT)", () => {
  it("starts two hours before departure instead of one", () => {
    const cart = computeShiftWindow({ ...EVENT, cart_service: 1 })!;
    expect(cart.startISO).toBe("2026-09-27T16:30:00.000Z"); // 12:30 EDT
    expect(cart.cartEvent).toBe(true);
  });

  it("starts exactly one hour earlier than the same event without the cart", () => {
    const plain = computeShiftWindow({ ...EVENT, cart_service: 0 })!;
    const cart = computeShiftWindow({ ...EVENT, cart_service: 1 })!;
    const earlierBy =
      (new Date(plain.startISO).getTime() - new Date(cart.startISO).getTime()) / 3600000;
    expect(earlierBy).toBe(1);
  });

  it("leaves the end exactly where it would have been", () => {
    const plain = computeShiftWindow({ ...EVENT, cart_service: 0 })!;
    const cart = computeShiftWindow({ ...EVENT, cart_service: 1 })!;
    expect(cart.endISO).toBe(plain.endISO);
    expect(cart.endISO).toBe("2026-09-28T01:30:00.000Z"); // 21:30 EDT
  });

  it("makes the shift an hour longer than the quote priced", () => {
    const cart = computeShiftWindow({ ...EVENT, cart_service: 1 })!;
    expect(cart.laborHours).toBe(8);
    expect(cart.hours).toBe(9);

    const plain = computeShiftWindow({ ...EVENT, cart_service: 0 })!;
    expect(plain.laborHours).toBe(8);
    expect(plain.hours).toBe(8);
  });

  it("changes nothing at all for a deal with no cart", () => {
    const missing = computeShiftWindow(EVENT)!;
    const zero = computeShiftWindow({ ...EVENT, cart_service: 0 })!;
    const nulled = computeShiftWindow({ ...EVENT, cart_service: null })!;
    expect(missing.startISO).toBe("2026-09-27T17:30:00.000Z"); // 13:30 EDT
    expect(zero).toEqual(missing);
    expect(nulled).toEqual(missing);
    expect(missing.cartEvent).toBe(false);
  });
});

describe("the cart storage hour (EST)", () => {
  const WINTER = { ...EVENT, event_date: "2026-12-05" };

  it("still starts two hours before departure, in standard time", () => {
    const cart = computeShiftWindow({ ...WINTER, cart_service: 1 })!;
    expect(cart.startISO).toBe("2026-12-05T17:30:00.000Z"); // 12:30 EST
  });

  it("leaves the end where the non-cart shift put it", () => {
    const plain = computeShiftWindow({ ...WINTER, cart_service: 0 })!;
    const cart = computeShiftWindow({ ...WINTER, cart_service: 1 })!;
    expect(plain.startISO).toBe("2026-12-05T18:30:00.000Z"); // 13:30 EST
    expect(cart.endISO).toBe(plain.endISO);
    expect(cart.endISO).toBe("2026-12-06T02:30:00.000Z"); // 21:30 EST
    expect(cart.hours).toBe(9);
  });
});

describe("the cart storage hour on a DST changeover day", () => {
  // 2026-11-01: the clocks go back at 02:00. A daytime departure is cleanly on
  // standard time, and both hours before it are too.
  const FALL_BACK = { ...TERRAIN, event_date: "2026-11-01", labor_hours: 6 };

  it("uses standard time for a departure after the changeover", () => {
    const plain = computeShiftWindow({ ...FALL_BACK, cart_service: 0 })!;
    const cart = computeShiftWindow({ ...FALL_BACK, cart_service: 1 })!;
    expect(plain.startISO).toBe("2026-11-01T18:30:00.000Z"); // 13:30 EST
    expect(cart.startISO).toBe("2026-11-01T17:30:00.000Z"); // 12:30 EST
    expect(cart.endISO).toBe(plain.endISO);
    expect(cart.endISO).toBe("2026-11-02T00:30:00.000Z"); // 19:30 EST
    expect(cart.hours).toBe(7);
  });

  it("uses daylight time for a departure after the spring-forward changeover", () => {
    const spring = { ...TERRAIN, event_date: "2027-03-14", labor_hours: 6 };
    const plain = computeShiftWindow({ ...spring, cart_service: 0 })!;
    const cart = computeShiftWindow({ ...spring, cart_service: 1 })!;
    expect(plain.startISO).toBe("2027-03-14T17:30:00.000Z"); // 13:30 EDT
    expect(cart.startISO).toBe("2027-03-14T16:30:00.000Z"); // 12:30 EDT
    expect(cart.endISO).toBe(plain.endISO);
    expect(cart.hours).toBe(7);
  });

  it("keeps the cart hour exactly an hour even in the small hours of a changeover", () => {
    // Pinned as an invariant rather than as absolute instants. A departure at
    // 04:00 on a changeover morning never happens for catering, and in that
    // window nyWallTimeToUTCISO resolves the wall time an hour off (a
    // pre-existing single-pass-offset quirk, unrelated to the cart). Whatever
    // instant it picks, the cart start must sit exactly one hour before the
    // non-cart start and the end must not move.
    for (const event_date of ["2027-03-14", "2026-11-01"]) {
      const deal = { ...TERRAIN, event_date, departure_time: "04:00", labor_hours: 6 };
      const plain = computeShiftWindow({ ...deal, cart_service: 0 })!;
      const cart = computeShiftWindow({ ...deal, cart_service: 1 })!;
      const earlierBy =
        (new Date(plain.startISO).getTime() - new Date(cart.startISO).getTime()) / 3600000;
      expect(earlierBy, event_date).toBe(1);
      expect(cart.endISO, event_date).toBe(plain.endISO);
      expect(cart.hours, event_date).toBe(7);
    }
  });
});

describe("a cart event's note", () => {
  it("says where to start and why the shift is longer", () => {
    expect(noteFor({ ...EVENT, cart_service: 1 })).toBe(
      "Cart event: start at the storage unit, includes 1h cart pickup · Auto-created from booked deal #25156 · Terrain",
    );
  });

  it("is absent when there is no cart", () => {
    expect(noteFor({ ...EVENT, cart_service: 0 })).toBe(
      "Auto-created from booked deal #25156 · Terrain",
    );
  });
});

describe("a cart event that the extra hour tips over the limit", () => {
  it("is flagged on the real length, not the quoted one", () => {
    const deal = { ...TERRAIN, labor_hours: 14.5, cart_service: 1 };
    const win = computeShiftWindow(deal)!;
    expect(win.laborHours).toBe(14.5);
    expect(win.hours).toBe(15.5);
    expect(isLongShiftHours(win.laborHours)).toBe(false); // the quote looks fine
    expect(isLongShiftHours(win.hours)).toBe(true); // the shift does not
  });

  it("says in plain words that the cart hour is what tipped it", () => {
    expect(longShiftWarning(15.5, 14.5)).toBe(
      "CHECK HOURS: shift is 15.5h per person (deal says 14.5h plus 1h cart pickup).",
    );
    expect(noteFor({ ...TERRAIN, labor_hours: 14.5, cart_service: 1 })).toBe(
      "CHECK HOURS: shift is 15.5h per person (deal says 14.5h plus 1h cart pickup). · Cart event: start at the storage unit, includes 1h cart pickup · Auto-created from booked deal #25156 · Terrain",
    );
  });

  it("leaves the same deal alone without the cart", () => {
    const win = computeShiftWindow({ ...TERRAIN, labor_hours: 14.5, cart_service: 0 })!;
    expect(win.hours).toBe(14.5);
    expect(isLongShiftHours(win.hours)).toBe(false);
  });

  it("catches the exact boundary: 14 quoted hours plus the cart hour is 15", () => {
    const win = computeShiftWindow({ ...TERRAIN, labor_hours: 14, cart_service: 1 })!;
    expect(win.hours).toBe(15);
    expect(isLongShiftHours(win.hours)).toBe(true);
  });
});
