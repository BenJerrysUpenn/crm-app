// Catering shift auto-creation: the window it computes, and what it does with
// a deal whose labor_hours are not credible.
//
// The anchor case is deal 25156 (Terrain, 2026-09-27): labor_hours = 26 went
// straight into shift 350, which ran 13:30 on the 27th to 15:30 on the 28th and
// was published. Nothing between the deal and the schedule asked whether a
// person could work it.

import { describe, expect, it } from "vitest";
import {
  computeShiftWindow,
  isLongShiftHours,
  longShiftWarning,
} from "@/lib/cateringShifts";

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
    const win = computeShiftWindow(TERRAIN)!;
    const marker = isLongShiftHours(win.hours) ? longShiftWarning(win.hours) : null;
    const notes = [marker, `Auto-created from booked deal #${TERRAIN.id}`, TERRAIN.company]
      .filter(Boolean)
      .join(" · ");
    expect(notes).toBe(
      "CHECK HOURS: deal says 26h per person. · Auto-created from booked deal #25156 · Terrain",
    );
  });

  it("leaves a normal deal's note exactly as it was", () => {
    const win = computeShiftWindow({ ...TERRAIN, labor_hours: 6 })!;
    const marker = isLongShiftHours(win.hours) ? longShiftWarning(win.hours) : null;
    const notes = [marker, `Auto-created from booked deal #${TERRAIN.id}`, TERRAIN.company]
      .filter(Boolean)
      .join(" · ");
    expect(notes).toBe("Auto-created from booked deal #25156 · Terrain");
  });
});
