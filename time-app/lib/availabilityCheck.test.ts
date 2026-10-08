// Unit tests for the availability check.
//
//   npm test        (node --test lib/*.test.ts)
//
// Dates are autumn 2026 (EDT, UTC-4). 2026-09-29 and 2026-10-06 are Tuesdays.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  availabilityDateRange,
  checkShiftAvailability,
  describeForSave,
  describeMismatch,
  describeReason,
  describeShiftTime,
  findAvailabilityMismatches,
  groupMismatches,
  prefersShift,
  resolveDay,
  summariseDay,
  type AvailabilityRow,
  type ShiftForAvailability,
} from "./availabilityCheck.ts";
import { weekdayOf } from "./coverage.ts";

const SAM = "sam";
const ALEX = "alex";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const TUE_WEEKDAY = 2;

function edt(date: string, hhmm: string) {
  return `${date}T${hhmm}:00-04:00`;
}
function shift(date: string, from: string, to: string, extra: Partial<ShiftForAvailability> = {}): ShiftForAvailability {
  const endDate = to <= from ? addOne(date) : date;
  return { id: 1, employee_id: SAM, position: "PENN Closer", starts_at: edt(date, from), ends_at: edt(endDate, to), ...extra };
}
function addOne(date: string) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function dated(date: string, start: string | null, end: string | null, preference: AvailabilityRow["preference"] = "available", employee_id = SAM): AvailabilityRow {
  return { employee_id, weekday: null, specific_date: date, start_time: start && start + ":00", end_time: end && end + ":00", is_available: true, status: "approved", preference };
}
function weekly(weekday: number, start: string | null, end: string | null, preference: AvailabilityRow["preference"] = "available"): AvailabilityRow {
  return { employee_id: SAM, weekday, specific_date: null, start_time: start && start + ":00", end_time: end && end + ":00", is_available: true, status: "approved", preference };
}
function timeOff(date: string, status: "approved" | "pending" | "denied"): AvailabilityRow {
  return { employee_id: SAM, weekday: null, specific_date: date, start_time: null, end_time: null, is_available: false, status, preference: "available" };
}
function kinds(rows: AvailabilityRow[], s: ShiftForAvailability) {
  return checkShiftAvailability(s, rows)?.reasons ?? [];
}

test("fixture dates are the weekdays the tests say they are", () => {
  assert.equal(weekdayOf(TUE), TUE_WEEKDAY);
  assert.equal(weekdayOf("2026-10-06"), TUE_WEEKDAY);
});

// --- the four reasons -------------------------------------------------------

test("fully covered by an available block: no mismatch", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "12:00", "17:00"), [dated(TUE, "09:00", "22:00")]), null);
});

test("reason 1: approved time off", () => {
  assert.deepEqual(kinds([timeOff(TUE, "approved"), dated(TUE, "09:00", "22:00")], shift(TUE, "12:00", "17:00")), [
    { kind: "time_off", date: TUE, status: "approved" },
  ]);
});

test("reason 1: pending time off is flagged as pending; denied is ignored", () => {
  assert.deepEqual(kinds([timeOff(TUE, "pending"), dated(TUE, "09:00", "22:00")], shift(TUE, "12:00", "17:00")), [
    { kind: "time_off", date: TUE, status: "pending" },
  ]);
  assert.equal(checkShiftAvailability(shift(TUE, "12:00", "17:00"), [timeOff(TUE, "denied"), dated(TUE, "09:00", "22:00")]), null);
});

test("reason 2: any overlap with a can't-work block, and only the overlapping stretch", () => {
  const rows = [dated(TUE, "09:00", "22:00"), dated(TUE, "14:00", "16:00", "unavailable")];
  assert.deepEqual(kinds(rows, shift(TUE, "12:00", "17:00")), [
    { kind: "unavailable_overlap", date: TUE, from: "14:00", to: "16:00" },
  ]);
});

test("reason 3: hours outside their available/preferred blocks", () => {
  assert.deepEqual(kinds([dated(TUE, "12:00", "17:00", "preferred")], shift(TUE, "12:00", "22:00")), [
    { kind: "outside_available_hours", date: TUE, from: "17:00", to: "22:00" },
  ]);
});

test("reason 4: nothing on file is its own kind", () => {
  assert.deepEqual(kinds([], shift(TUE, "12:00", "17:00")), [{ kind: "no_availability", date: TUE }]);
});

test("reason 4: a day with only can't-work blocks, none touching the shift, is no_availability, not a conflict", () => {
  assert.deepEqual(kinds([dated(TUE, "08:00", "10:00", "unavailable")], shift(TUE, "12:00", "17:00")), [
    { kind: "no_availability", date: TUE },
  ]);
});

test("can't-work overlap plus nothing else on file reports both, without double counting", () => {
  assert.deepEqual(kinds([dated(TUE, "15:00", "18:00", "unavailable")], shift(TUE, "12:00", "17:00")), [
    { kind: "no_availability", date: TUE },
    { kind: "unavailable_overlap", date: TUE, from: "15:00", to: "17:00" },
  ]);
});

test("a stretch that is can't-work is not also reported as outside available hours", () => {
  const rows = [dated(TUE, "09:00", "12:00"), dated(TUE, "12:00", "14:00", "unavailable")];
  assert.deepEqual(kinds(rows, shift(TUE, "09:00", "14:00")), [
    { kind: "unavailable_overlap", date: TUE, from: "12:00", to: "14:00" },
  ]);
});

// --- partial coverage -------------------------------------------------------

test("two adjacent blocks together cover the shift", () => {
  const rows = [dated(TUE, "09:00", "13:00"), dated(TUE, "13:00", "17:00", "preferred")];
  assert.equal(checkShiftAvailability(shift(TUE, "10:00", "16:00"), rows), null);
});

test("two blocks with a hole between them: only the hole is reported", () => {
  const rows = [dated(TUE, "09:00", "12:00"), dated(TUE, "13:00", "17:00")];
  assert.deepEqual(kinds(rows, shift(TUE, "10:00", "16:00")), [
    { kind: "outside_available_hours", date: TUE, from: "12:00", to: "13:00" },
  ]);
});

test("an all-day block (no times) covers any shift that day", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "06:00", "23:00"), [dated(TUE, null, null, "preferred")]), null);
});

// --- midnight ---------------------------------------------------------------

test("shift across midnight is judged against each date it lands on", () => {
  const s = shift(TUE, "18:00", "02:00");
  assert.equal(s.ends_at, edt(WED, "02:00"));
  // Tue until midnight (written as end 00:00) + Wed early hours: covered.
  assert.equal(checkShiftAvailability(s, [dated(TUE, "17:00", "00:00"), dated(WED, "00:00", "03:00")]), null);
  // Nothing on Wednesday: only Wednesday's part is flagged.
  assert.deepEqual(kinds([dated(TUE, "17:00", "00:00")], s), [{ kind: "no_availability", date: WED }]);
});

test("an overnight availability block (end before start) carries into the next morning", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "18:00", "02:00"), [dated(TUE, "18:00", "03:00")]), null);
  // Stops at 01:00: Wednesday 01:00–02:00 is outside.
  assert.deepEqual(kinds([dated(TUE, "18:00", "01:00")], shift(TUE, "18:00", "02:00")), [
    { kind: "outside_available_hours", date: WED, from: "01:00", to: "02:00" },
  ]);
});

test("time off the next day catches the part of an overnight shift that lands on it", () => {
  assert.deepEqual(kinds([dated(TUE, "17:00", "00:00"), timeOff(WED, "approved")], shift(TUE, "18:00", "02:00")), [
    { kind: "time_off", date: WED, status: "approved" },
  ]);
});

test("a shift ending exactly at midnight touches only its own day", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "18:00", "00:00"), [dated(TUE, "17:00", "00:00")]), null);
});

// --- weekly vs date precedence ---------------------------------------------

test("weekly availability applies when nothing is dated", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "10:00", "14:00"), [weekly(TUE_WEEKDAY, "09:00", "17:00")]), null);
  // ...and only on its weekday.
  assert.deepEqual(kinds([weekly(TUE_WEEKDAY + 1, "09:00", "17:00")], shift(TUE, "10:00", "14:00")), [
    { kind: "no_availability", date: TUE },
  ]);
});

test("a dated can't-work beats weekly availability where they overlap", () => {
  const rows = [weekly(TUE_WEEKDAY, "09:00", "17:00"), dated(TUE, "12:00", "13:00", "unavailable")];
  assert.deepEqual(kinds(rows, shift(TUE, "10:00", "14:00")), [
    { kind: "unavailable_overlap", date: TUE, from: "12:00", to: "13:00" },
  ]);
  // The same weekly pattern on a different Tuesday is untouched.
  assert.equal(checkShiftAvailability(shift("2026-10-06", "10:00", "14:00"), rows), null);
});

test("a dated can-work beats a weekly can't-work where they overlap", () => {
  const rows = [weekly(TUE_WEEKDAY, null, null, "unavailable"), dated(TUE, "10:00", "14:00", "preferred")];
  assert.equal(checkShiftAvailability(shift(TUE, "10:00", "14:00"), rows), null);
  // Outside the dated block the weekly can't-work still stands.
  assert.deepEqual(kinds(rows, shift(TUE, "13:00", "15:00")), [
    { kind: "unavailable_overlap", date: TUE, from: "14:00", to: "15:00" },
  ]);
});

test("a dated entry does not erase weekly blocks it does not overlap", () => {
  const rows = [weekly(TUE_WEEKDAY, "12:00", "17:00", "preferred"), dated(TUE, "18:00", "20:00", "unavailable")];
  assert.equal(checkShiftAvailability(shift(TUE, "12:00", "17:00"), rows), null);
});

test("within one layer, can't-work beats can-work", () => {
  const rows = [dated(TUE, "09:00", "17:00"), dated(TUE, "12:00", "13:00", "unavailable")];
  assert.deepEqual(kinds(rows, shift(TUE, "11:00", "14:00")), [
    { kind: "unavailable_overlap", date: TUE, from: "12:00", to: "13:00" },
  ]);
});

test("someone who only uses the weekly toggle is never 'no availability' on their weekdays", () => {
  // The Availability calendar's "Repeats every Tue" writes weekday=2 and no
  // specific_date. Readers that only loaded dated rows saw nothing here.
  const rows = [weekly(TUE_WEEKDAY, "11:00", "22:00", "preferred")];
  for (const date of [TUE, "2026-10-06", "2026-10-13"]) {
    assert.equal(checkShiftAvailability(shift(date, "12:00", "20:00"), rows), null, date);
  }
});

test("a weekly overnight block carries into the next weekday", () => {
  const rows = [weekly(TUE_WEEKDAY, "18:00", "02:00")];
  assert.equal(checkShiftAvailability(shift(TUE, "20:00", "01:30"), rows), null);
});

test("a dated can-work next to a weekly can-work joins up for coverage and in words", () => {
  const rows = [weekly(TUE_WEEKDAY, "12:00", "17:00"), dated(TUE, "17:00", "21:00")];
  assert.equal(checkShiftAvailability(shift(TUE, "12:00", "21:00"), rows), null);
  assert.equal(summariseDay(resolveDay(SAM, TUE, rows)), "available 12:00 PM to 9:00 PM");
});

// --- scope ------------------------------------------------------------------

test("open shifts are never checked", () => {
  assert.equal(checkShiftAvailability(shift(TUE, "12:00", "17:00", { employee_id: null }), []), null);
});

test("catering shifts are checked like any other", () => {
  assert.deepEqual(kinds([], shift(TUE, "12:00", "17:00", { position: "Catering" })), [{ kind: "no_availability", date: TUE }]);
});

test("someone else's availability does not count", () => {
  assert.deepEqual(kinds([dated(TUE, "09:00", "22:00", "available", ALEX)], shift(TUE, "12:00", "17:00")), [
    { kind: "no_availability", date: TUE },
  ]);
});

test("denied rows are ignored", () => {
  const row = { ...dated(TUE, "09:00", "22:00"), status: "denied" };
  assert.deepEqual(kinds([row], shift(TUE, "12:00", "17:00")), [{ kind: "no_availability", date: TUE }]);
});

test("findAvailabilityMismatches keeps order and skips fine and open shifts", () => {
  const rows = [dated(TUE, "09:00", "17:00")];
  const out = findAvailabilityMismatches(
    [
      shift(TUE, "10:00", "12:00", { id: 1 }),
      shift(TUE, "16:00", "20:00", { id: 2 }),
      shift(TUE, "16:00", "20:00", { id: 3, employee_id: null }),
      shift(WED, "10:00", "12:00", { id: 4 }),
    ],
    rows,
  );
  assert.deepEqual(out.map((m) => m.shift_id), [2, 4]);
});

test("groupMismatches puts nothing-on-file shifts in their own group", () => {
  const rows = [dated(TUE, "09:00", "17:00")];
  const out = findAvailabilityMismatches([shift(TUE, "16:00", "20:00", { id: 2 }), shift(WED, "10:00", "12:00", { id: 4 })], rows);
  const { conflicts, noAvailability } = groupMismatches(out);
  assert.deepEqual(conflicts.map((m) => m.shift_id), [2]);
  assert.deepEqual(noAvailability.map((m) => m.shift_id), [4]);
});

test("prefersShift is true only when every minute is preferred", () => {
  assert.equal(prefersShift(shift(TUE, "12:00", "17:00"), [dated(TUE, "12:00", "17:00", "preferred")]), true);
  assert.equal(prefersShift(shift(TUE, "12:00", "18:00"), [dated(TUE, "12:00", "17:00", "preferred"), dated(TUE, "17:00", "18:00")]), false);
});

// --- words ------------------------------------------------------------------

test("resolveDay + summariseDay read in plain words", () => {
  const rows = [dated(TUE, "12:00", "17:00", "preferred"), dated(TUE, "18:00", "20:00", "unavailable")];
  assert.equal(summariseDay(resolveDay(SAM, TUE, rows)), "prefers 12:00 PM to 5:00 PM; can't work 6:00 PM to 8:00 PM");
  assert.equal(summariseDay(resolveDay(SAM, TUE, [])), "nothing on file");
  assert.equal(summariseDay(resolveDay(SAM, TUE, [timeOff(TUE, "approved")])), "time off (approved)");
  assert.equal(summariseDay(resolveDay(SAM, TUE, [timeOff(TUE, "pending")])), "time-off request pending");
  assert.equal(summariseDay(resolveDay(SAM, TUE, [timeOff(TUE, "denied")])), "nothing on file");
  assert.equal(summariseDay(resolveDay(SAM, TUE, [dated(TUE, null, null)])), "available all day");
});

test("each reason reads distinctly", () => {
  assert.equal(describeReason({ kind: "time_off", date: TUE, status: "approved" }), "has approved time off Tue Sep 29");
  assert.equal(describeReason({ kind: "time_off", date: TUE, status: "pending" }), "time-off request pending for Tue Sep 29 (decide it on the Team tab)");
  assert.equal(
    describeReason({ kind: "unavailable_overlap", date: TUE, from: "14:00", to: "16:00" }),
    "marked can't work 2:00 PM to 4:00 PM on Tue Sep 29",
  );
  assert.equal(
    describeReason({ kind: "outside_available_hours", date: TUE, from: "17:00", to: "22:00" }),
    "not available 5:00 PM to 10:00 PM on Tue Sep 29",
  );
  assert.equal(describeReason({ kind: "no_availability", date: TUE }), "no availability on file for Tue Sep 29");
});

test("describeShiftTime handles same-day and overnight shifts", () => {
  assert.equal(describeShiftTime(edt(TUE, "17:00"), edt(TUE, "22:00")), "Tue Sep 29, 5:00 PM to 10:00 PM");
  assert.equal(describeShiftTime(edt(TUE, "18:00"), edt(WED, "02:00")), "Tue Sep 29, 6:00 PM to Wed Sep 30, 2:00 AM");
});

test("describeMismatch is one line naming person, shift, reason and what is on file", () => {
  const m = checkShiftAvailability(shift(TUE, "12:00", "22:00", { position: "Catering" }), [dated(TUE, "12:00", "17:00", "preferred")])!;
  assert.equal(
    describeMismatch(m, "Sam Lee"),
    "Sam Lee, Catering Tue Sep 29, 12:00 PM to 10:00 PM: not available 5:00 PM to 10:00 PM on Tue Sep 29 (availability: prefers 12:00 PM to 5:00 PM)",
  );
  const none = checkShiftAvailability(shift(TUE, "12:00", "17:00", { position: null }), [])!;
  assert.equal(describeMismatch(none, "Sam Lee"), "Sam Lee, Tue Sep 29, 12:00 PM to 5:00 PM: no availability on file for Tue Sep 29");
});

test("reasons read in clock order, and time off needs no availability footnote", () => {
  const rows = [dated(TUE, "12:00", "17:00", "preferred"), dated(TUE, "18:00", "20:00", "unavailable")];
  const m = checkShiftAvailability(shift(TUE, "12:00", "21:00", { position: "PENN Closer" }), rows)!;
  assert.deepEqual(m.reasons.map((r) => ("from" in r ? r.from : r.kind)), ["17:00", "18:00", "20:00"]);
  assert.equal(
    describeMismatch(m, "Sam Lee"),
    "Sam Lee, PENN Closer Tue Sep 29, 12:00 PM to 9:00 PM: not available 5:00 PM to 6:00 PM on Tue Sep 29; " +
      "marked can't work 6:00 PM to 8:00 PM on Tue Sep 29; not available 8:00 PM to 9:00 PM on Tue Sep 29 " +
      "(availability: prefers 12:00 PM to 5:00 PM; can't work 6:00 PM to 8:00 PM)",
  );
  const off = checkShiftAvailability(shift(TUE, "11:00", "16:00", { position: null }), [timeOff(TUE, "approved")])!;
  assert.equal(describeMismatch(off, "Ana Diaz"), "Ana Diaz, Tue Sep 29, 11:00 AM to 4:00 PM: has approved time off Tue Sep 29");
});

test("describeForSave words no-availability differently from a conflict", () => {
  const none = describeForSave(checkShiftAvailability(shift(TUE, "12:00", "17:00"), [])!, "Sam Lee");
  assert.equal(none.title, "Sam Lee has no availability on file");
  assert.ok(none.lines.includes("Availability that day: nothing on file"));

  const conflict = describeForSave(
    checkShiftAvailability(shift(TUE, "12:00", "17:00"), [timeOff(TUE, "approved")])!,
    "Sam Lee",
  );
  assert.equal(conflict.title, "Sam Lee isn't available for all of this shift");
  assert.deepEqual(conflict.lines, [
    "Shift: Tue Sep 29, 12:00 PM to 5:00 PM",
    "Availability that day: time off (approved)",
    "• Has approved time off Tue Sep 29",
    "Save anyway?",
  ]);
});

test("availabilityDateRange spans the day before the first start to the last end date", () => {
  assert.deepEqual(
    availabilityDateRange([shift(TUE, "12:00", "17:00"), shift("2026-10-03", "20:00", "01:00")]),
    { from: "2026-09-28", to: "2026-10-04" },
  );
  assert.equal(availabilityDateRange([]), null);
});

// --- a weekly row applies from the day it was created ---------------------

const SUN_BEFORE = "2026-09-27";
const SUN_AFTER = "2026-10-04";

function weeklyCreated(weekday: number, start: string | null, end: string | null, preference: AvailabilityRow["preference"], created_at: string | null | undefined): AvailabilityRow {
  return { ...weekly(weekday, start, end, preference), created_at };
}

test("a weekly row does not reach back before the day it was created (James, Sunday can't-work)", () => {
  assert.equal(weekdayOf(SUN_BEFORE), 0);
  assert.equal(weekdayOf(SUN_AFTER), 0);
  // Created Monday 2026-09-28, mid-afternoon Eastern.
  const rows = [weeklyCreated(0, null, null, "unavailable", "2026-09-28T18:30:00+00:00")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, rows).blocks, []);
  assert.deepEqual(resolveDay(SAM, SUN_AFTER, rows).blocks, [{ from: 0, to: 1440, kind: "unavailable", source: "weekly" }]);
  // The shift he already worked on the 27th is "nothing on file", not a conflict.
  assert.deepEqual(kinds(rows, shift(SUN_BEFORE, "12:00", "17:00")), [{ kind: "no_availability", date: SUN_BEFORE }]);
  assert.deepEqual(kinds(rows, shift(SUN_AFTER, "12:00", "17:00")), [
    { kind: "unavailable_overlap", date: SUN_AFTER, from: "12:00", to: "17:00" },
  ]);
});

test("a weekly row applies on its own creation date", () => {
  const rows = [weeklyCreated(0, "09:00", "17:00", "available", "2026-09-27T13:00:00+00:00")];
  assert.equal(checkShiftAvailability(shift(SUN_BEFORE, "10:00", "15:00"), rows), null);
});

test("creation date is the New York date, not the UTC one", () => {
  // 11:30 PM Eastern on Saturday 09-26 is already Sunday 09-27 in UTC.
  const lateSat = [weeklyCreated(0, null, null, "unavailable", "2026-09-27T03:30:00Z")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, lateSat).blocks, [{ from: 0, to: 1440, kind: "unavailable", source: "weekly" }]);
  // 11:30 PM Eastern on Sunday 09-27 is Monday 09-28 in UTC: still counts that Sunday.
  const lateSun = [weeklyCreated(0, null, null, "unavailable", "2026-09-28T03:30:00Z")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, lateSun).blocks, [{ from: 0, to: 1440, kind: "unavailable", source: "weekly" }]);
  // 11:30 PM Eastern on Monday 09-28: not that Sunday.
  const lateMon = [weeklyCreated(0, null, null, "unavailable", "2026-09-29T03:30:00Z")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, lateMon).blocks, []);
});

test("an overnight weekly block is judged by the date it starts on", () => {
  // Every Saturday 8 PM to 2 AM, created Sunday 09-27: the spill into Sunday
  // 09-27 belongs to Saturday 09-26, before the row existed.
  const rows = [weeklyCreated(6, "20:00", "02:00", "unavailable", "2026-09-27T16:00:00Z")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, rows).blocks, []);
  assert.deepEqual(resolveDay(SAM, "2026-09-26", rows).blocks, []);
  assert.deepEqual(resolveDay(SAM, "2026-10-03", rows).blocks, [{ from: 1200, to: 1440, kind: "unavailable", source: "weekly" }]);
  assert.deepEqual(resolveDay(SAM, SUN_AFTER, rows).blocks, [{ from: 0, to: 120, kind: "unavailable", source: "weekly" }]);
  // Created on the Saturday itself: that night's spill into Sunday counts.
  const sameDay = [weeklyCreated(6, "20:00", "02:00", "unavailable", "2026-09-26T16:00:00Z")];
  assert.deepEqual(resolveDay(SAM, SUN_BEFORE, sameDay).blocks, [{ from: 0, to: 120, kind: "unavailable", source: "weekly" }]);
});

test("a weekly row with no (or unreadable) created_at applies to every date", () => {
  for (const created of [undefined, null, "", "not a date"]) {
    const rows = [weeklyCreated(0, null, null, "unavailable", created)];
    assert.deepEqual(resolveDay(SAM, "2020-01-05", rows).blocks, [{ from: 0, to: 1440, kind: "unavailable", source: "weekly" }], String(created));
  }
});

test("dated rows ignore created_at", () => {
  const row: AvailabilityRow = { ...dated(SUN_BEFORE, "09:00", "17:00"), created_at: "2026-10-01T12:00:00Z" };
  assert.equal(checkShiftAvailability(shift(SUN_BEFORE, "10:00", "15:00"), [row]), null);
});
