// Unit tests for the store-hours coverage check.
//
//   npm test        (node --test lib/*.test.ts — Node runs TypeScript directly)
//
// Shift instants are written with an explicit UTC offset (-04:00 in EDT,
// -05:00 in EST) rather than a bare local string, so every test says exactly
// which instant it means. That matters on the two DST weekends below.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkWeekCoverage,
  describeGap,
  describeHoursNotSet,
  nyWallClock,
  resolveOpenWindow,
  shiftSegments,
  type ClosedDateRange,
  type CoverageShift,
  type StoreHoursException,
  type StoreHoursRow,
} from "./coverage.ts";

// --- fixtures ---------------------------------------------------------------

const WEEK = "2026-09-20"; // Sunday
const SUN = "2026-09-20";
const MON = "2026-09-21";
const TUE = "2026-09-22";
const WED = "2026-09-23";
const THU = "2026-09-24";
const FRI = "2026-09-25";
const SAT = "2026-09-26";

const SHIFT_TYPES = [
  { name: "PENN Opener", in_store: true },
  { name: "PENN Closer", in_store: true },
  { name: "Catering", in_store: false },
  { name: "Marketing", in_store: false },
  { name: "Staff Meeting", in_store: false },
];

/** Every weekday open 09:00–17:00. */
function everyDay(opens = "09:00:00", closes = "17:00:00"): StoreHoursRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, is_closed: false, opens, closes }));
}

/** An instant written in Eastern Daylight Time (summer). */
function edt(date: string, hhmm: string) {
  return `${date}T${hhmm}:00-04:00`;
}
/** An instant written in Eastern Standard Time (winter). */
function est(date: string, hhmm: string) {
  return `${date}T${hhmm}:00-05:00`;
}

type ShiftOpts = { employee_id?: string | null; position?: string | null };

/** A same-day EDT shift, assigned and in-store unless told otherwise. */
function shift(date: string, from: string, to: string, opts: ShiftOpts = {}): CoverageShift {
  return {
    starts_at: edt(date, from),
    ends_at: edt(date, to),
    employee_id: "employee_id" in opts ? opts.employee_id! : "emp-1",
    position: "position" in opts ? opts.position : "PENN Opener",
  };
}

function check(over: {
  weekStart?: string;
  storeHours?: StoreHoursRow[];
  exceptions?: StoreHoursException[];
  shifts?: CoverageShift[];
  closedRanges?: ClosedDateRange[];
}) {
  return checkWeekCoverage({
    weekStart: over.weekStart ?? WEEK,
    storeHours: over.storeHours ?? everyDay(),
    exceptions: over.exceptions ?? [],
    shiftTypes: SHIFT_TYPES,
    shifts: over.shifts ?? [],
    closedRanges: over.closedRanges ?? [],
  });
}

/** A whole week of 09:00–17:00 cover, so a test can spoil exactly one day. */
function fullWeekShifts(): CoverageShift[] {
  return [SUN, MON, TUE, WED, THU, FRI, SAT].map((d) => shift(d, "09:00", "17:00"));
}

function without(date: string, shifts: CoverageShift[]) {
  return shifts.filter((s) => !s.starts_at.startsWith(date));
}

// --- the happy path ---------------------------------------------------------

test("a fully covered week has no gaps", () => {
  const result = check({ shifts: fullWeekShifts() });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.hoursNotSet, []);
});

test("adjacent shifts merge: a handover at 13:00 is not a gap", () => {
  const result = check({
    shifts: [
      ...without(TUE, fullWeekShifts()),
      shift(TUE, "09:00", "13:00"),
      shift(TUE, "13:00", "17:00", { position: "PENN Closer" }),
    ],
  });
  assert.deepEqual(result.gaps, []);
});

test("overlapping shifts merge", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "14:00"), shift(TUE, "12:00", "17:00")],
  });
  assert.deepEqual(result.gaps, []);
});

test("cover beyond opening hours is not a gap and is not reported", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "07:00", "19:00")],
  });
  assert.deepEqual(result.gaps, []);
});

// --- the bug this feature exists for ---------------------------------------

test("a two-hour mid-day hole is reported", () => {
  const result = check({
    shifts: [
      ...without(TUE, fullWeekShifts()),
      shift(TUE, "09:00", "14:00"),
      shift(TUE, "16:00", "17:00", { position: "PENN Closer" }),
    ],
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "14:00", to: "16:00" }]);
  assert.equal(describeGap(result.gaps[0]), "Tue Sep 22: nobody in store 2:00 PM to 4:00 PM");
});

test("a late start leaves a gap at open", () => {
  const result = check({ shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "11:00", "17:00")] });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "11:00" }]);
});

test("an early finish leaves a gap at close", () => {
  const result = check({ shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "15:00")] });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "15:00", to: "17:00" }]);
});

test("a day with no shifts at all is one gap across the whole window", () => {
  const result = check({ shifts: without(TUE, fullWeekShifts()) });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

// --- which shifts actually cover -------------------------------------------

test("an unassigned open shift covers nothing", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "17:00", { employee_id: null })],
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

test("a Catering shift does not cover the store", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "17:00", { position: "Catering" })],
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

test("a Marketing shift does not cover the store", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "17:00", { position: "Marketing" })],
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

test("an off-floor shift alongside a real one only leaves the hole it does not fill", () => {
  const result = check({
    shifts: [
      ...without(TUE, fullWeekShifts()),
      shift(TUE, "09:00", "14:00"),
      shift(TUE, "14:00", "16:00", { position: "Staff Meeting" }),
      shift(TUE, "16:00", "17:00"),
    ],
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "14:00", to: "16:00" }]);
});

test("a shift with no position counts as in-store", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "17:00", { position: null })],
  });
  assert.deepEqual(result.gaps, []);
});

test("a shift with an unrecognised position counts as in-store", () => {
  const result = check({
    shifts: [...without(TUE, fullWeekShifts()), shift(TUE, "09:00", "17:00", { position: "Brand new type" })],
  });
  assert.deepEqual(result.gaps, []);
});

test("shifts outside the week are ignored", () => {
  const result = check({
    shifts: [...fullWeekShifts(), shift("2026-09-19", "09:00", "17:00"), shift("2026-09-27", "09:00", "17:00")],
  });
  assert.deepEqual(result.gaps, []);
});

// --- closed days and exceptions ---------------------------------------------

test("a closed weekday needs no cover", () => {
  const storeHours = everyDay().map((r) => (r.weekday === 1 ? { ...r, is_closed: true, opens: null, closes: null } : r));
  const result = check({ storeHours, shifts: without(MON, fullWeekShifts()) });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.hoursNotSet, []);
});

test("an exception closing one date leaves the rest of the week checked normally", () => {
  const exceptions: StoreHoursException[] = [
    { date: WED, label: "Deep clean", is_closed: true, opens: null, closes: null },
  ];
  const result = check({ exceptions, shifts: without(WED, without(THU, fullWeekShifts())) });
  // Wednesday is shut, so its missing cover is fine. Thursday still is not.
  assert.deepEqual(result.gaps, [{ date: THU, from: "09:00", to: "17:00" }]);
});

test("an exception with special hours replaces the weekday window", () => {
  const exceptions: StoreHoursException[] = [
    { date: WED, label: "Short day", is_closed: false, opens: "12:00:00", closes: "15:00:00" },
  ];
  const result = check({
    exceptions,
    shifts: [...without(WED, fullWeekShifts()), shift(WED, "12:00", "14:00")],
  });
  assert.deepEqual(result.gaps, [{ date: WED, from: "14:00", to: "15:00" }]);
});

test("special hours can be longer than the weekday window too", () => {
  const exceptions: StoreHoursException[] = [
    { date: WED, label: "Late night", is_closed: false, opens: "09:00:00", closes: "21:00:00" },
  ];
  const result = check({ exceptions, shifts: fullWeekShifts() });
  assert.deepEqual(result.gaps, [{ date: WED, from: "17:00", to: "21:00" }]);
});

test("a holiday with no exception row keeps its normal weekday hours", () => {
  // Thanksgiving 2026 is Thursday 26 November; the week starts Sunday the 22nd.
  const thanksgiving = "2026-11-26";
  const covered = { employee_id: "emp-1", position: "PENN Opener" };
  const result = checkWeekCoverage({
    weekStart: "2026-11-22",
    storeHours: everyDay(),
    exceptions: [],
    shiftTypes: SHIFT_TYPES,
    shifts: ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-28"].map((d) => ({
      starts_at: est(d, "09:00"),
      ends_at: est(d, "17:00"),
      ...covered,
    })),
  });
  // The store is open on the holiday because nobody said otherwise, so the
  // unstaffed Thursday is a gap.
  assert.deepEqual(result.gaps, [{ date: thanksgiving, from: "09:00", to: "17:00" }]);
});

test("resolveOpenWindow: exception beats the weekday pattern, and unset is not closed", () => {
  const storeHours = everyDay();
  assert.deepEqual(resolveOpenWindow(TUE, storeHours, []), {
    state: "open",
    opens: 540,
    closes: 1020,
    source: "weekday",
  });
  assert.deepEqual(
    resolveOpenWindow(TUE, storeHours, [{ date: TUE, label: "Snow", is_closed: true, opens: null, closes: null }]),
    { state: "closed", source: "exception", label: "Snow" },
  );
  assert.deepEqual(resolveOpenWindow(TUE, [], []), { state: "unset" });
  assert.deepEqual(resolveOpenWindow(TUE, [{ weekday: 2, is_closed: true, opens: null, closes: null }], []), {
    state: "closed",
    source: "weekday",
  });
});

// --- "Business closed" schedule annotations ---------------------------------

test("a business_closed annotation closes one date; the rest of the week is still checked", () => {
  const closedRanges: ClosedDateRange[] = [{ title: "Closed — deep clean", start_date: WED, end_date: WED }];
  const result = check({ closedRanges, shifts: without(WED, without(THU, fullWeekShifts())) });
  assert.deepEqual(result.gaps, [{ date: THU, from: "09:00", to: "17:00" }]);
  assert.deepEqual(result.hoursNotSet, []);
});

test("a multi-day annotation closes every date in its inclusive range", () => {
  const closedRanges: ClosedDateRange[] = [{ title: "Winter break", start_date: MON, end_date: THU }];
  // Nobody is scheduled Monday through Thursday, and Friday is missing too.
  const result = check({
    closedRanges,
    shifts: [shift(SUN, "09:00", "17:00"), shift(SAT, "09:00", "17:00")],
  });
  assert.deepEqual(result.gaps, [{ date: FRI, from: "09:00", to: "17:00" }]);
});

test("an annotation that starts before and ends after the week closes all of it", () => {
  const closedRanges: ClosedDateRange[] = [{ title: "Shut for renovation", start_date: "2026-09-01", end_date: "2026-10-31" }];
  assert.deepEqual(check({ closedRanges, shifts: [] }).gaps, []);
});

test("an annotation outside the week changes nothing", () => {
  const closedRanges: ClosedDateRange[] = [{ title: "Last month", start_date: "2026-08-01", end_date: "2026-08-31" }];
  const result = check({ closedRanges, shifts: without(TUE, fullWeekShifts()) });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

test("an annotated closure beats 'hours not set': the day is closed, not reported", () => {
  // No store_hours rows at all, so every day would otherwise be "not set".
  const closedRanges: ClosedDateRange[] = [{ title: "Closed", start_date: TUE, end_date: TUE }];
  const result = check({ storeHours: [], closedRanges, shifts: [] });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(
    result.hoursNotSet.map((d) => d.date),
    [SUN, MON, WED, THU, FRI, SAT],
  );
});

test("an annotated closure beats a special-hours exception on the same date", () => {
  // The exception says "open 12:00–15:00", the board says "Closed". Closed wins.
  const exceptions: StoreHoursException[] = [
    { date: WED, label: "Short day", is_closed: false, opens: "12:00:00", closes: "15:00:00" },
  ];
  const closedRanges: ClosedDateRange[] = [{ title: "Closed after all", start_date: WED, end_date: WED }];
  const result = check({ exceptions, closedRanges, shifts: without(WED, fullWeekShifts()) });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(resolveOpenWindow(WED, everyDay(), exceptions, closedRanges), {
    state: "closed",
    source: "annotation",
    label: "Closed after all",
  });
});

test("closedRanges is optional and defaults to none", () => {
  const result = checkWeekCoverage({
    weekStart: WEEK,
    storeHours: everyDay(),
    exceptions: [],
    shiftTypes: SHIFT_TYPES,
    shifts: without(TUE, fullWeekShifts()),
  });
  assert.deepEqual(result.gaps, [{ date: TUE, from: "09:00", to: "17:00" }]);
});

// --- hours not set ----------------------------------------------------------

test("days with no store_hours row are reported, not blocked", () => {
  // Only Sunday and Saturday have hours set.
  const storeHours = everyDay().filter((r) => r.weekday === 0 || r.weekday === 6);
  const result = check({ storeHours, shifts: [shift(SUN, "09:00", "17:00"), shift(SAT, "09:00", "17:00")] });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.hoursNotSet, [
    { date: MON, weekday: 1 },
    { date: TUE, weekday: 2 },
    { date: WED, weekday: 3 },
    { date: THU, weekday: 4 },
    { date: FRI, weekday: 5 },
  ]);
  assert.equal(describeHoursNotSet(result.hoursNotSet), "Mon, Tue, Wed, Thu, Fri");
});

test("a row that claims to be open with no times is 'not set', not a full-day gap", () => {
  const storeHours = everyDay().map((r) => (r.weekday === 2 ? { ...r, opens: null, closes: null } : r));
  const result = check({ storeHours, shifts: without(TUE, fullWeekShifts()) });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.hoursNotSet, [{ date: TUE, weekday: 2 }]);
});

// --- midnight ---------------------------------------------------------------

test("a shift that runs past midnight covers both dates", () => {
  const segments = shiftSegments({
    starts_at: edt(FRI, "20:00"),
    ends_at: edt(SAT, "02:00"),
    employee_id: "emp-1",
    position: "PENN Closer",
  });
  assert.deepEqual(segments, [
    { date: FRI, from: 1200, to: 1440 },
    { date: SAT, from: 0, to: 120 },
  ]);
});

test("a shift ending exactly at midnight does not touch the next day", () => {
  const segments = shiftSegments({
    starts_at: edt(FRI, "20:00"),
    ends_at: edt(SAT, "00:00"),
    employee_id: "emp-1",
    position: "PENN Closer",
  });
  assert.deepEqual(segments, [{ date: FRI, from: 1200, to: 1440 }]);
});

test("a late-night window is covered by one shift spanning midnight", () => {
  // Shut all week except Friday 20:00–24:00 and Saturday 00:00–02:00.
  const storeHours: StoreHoursRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    if (weekday === 5) return { weekday, is_closed: false, opens: "20:00:00", closes: "24:00:00" };
    if (weekday === 6) return { weekday, is_closed: false, opens: "00:00:00", closes: "02:00:00" };
    return { weekday, is_closed: true, opens: null, closes: null };
  });
  const overnight: CoverageShift = {
    starts_at: edt(FRI, "20:00"),
    ends_at: edt(SAT, "02:00"),
    employee_id: "emp-1",
    position: "PENN Closer",
  };
  assert.deepEqual(check({ storeHours, shifts: [overnight] }).gaps, []);

  const short: CoverageShift = { ...overnight, ends_at: edt(SAT, "01:00") };
  assert.deepEqual(check({ storeHours, shifts: [short] }).gaps, [{ date: SAT, from: "01:00", to: "02:00" }]);
});

// --- daylight saving --------------------------------------------------------

test("DST fall-back (2026-11-01): wall clock, not elapsed time, decides cover", () => {
  // 01:00–02:00 happens twice that morning. A shift from 00:30 EDT to 05:00 EST
  // is five and a half real hours but covers wall clock 00:30 to 05:00.
  assert.deepEqual(nyWallClock("2026-11-01T00:30:00-04:00"), { date: "2026-11-01", minutes: 30 });
  assert.deepEqual(nyWallClock("2026-11-01T05:00:00-05:00"), { date: "2026-11-01", minutes: 300 });

  const storeHours: StoreHoursRow[] = [{ weekday: 0, is_closed: false, opens: "01:00:00", closes: "06:00:00" }];
  const overnight: CoverageShift = {
    starts_at: "2026-11-01T00:30:00-04:00",
    ends_at: "2026-11-01T05:00:00-05:00",
    employee_id: "emp-1",
    position: "PENN Closer",
  };
  const result = checkWeekCoverage({
    weekStart: "2026-11-01",
    storeHours,
    exceptions: [],
    shiftTypes: SHIFT_TYPES,
    shifts: [overnight],
  });
  assert.deepEqual(result.gaps, [{ date: "2026-11-01", from: "05:00", to: "06:00" }]);

  const toClose: CoverageShift = { ...overnight, ends_at: "2026-11-01T06:00:00-05:00" };
  assert.deepEqual(
    checkWeekCoverage({
      weekStart: "2026-11-01",
      storeHours,
      exceptions: [],
      shiftTypes: SHIFT_TYPES,
      shifts: [toClose],
    }).gaps,
    [],
  );
});

test("DST spring-forward (2027-03-14): the missing hour is not a gap", () => {
  // 02:00–03:00 does not exist that morning. A shift from 01:00 EST to 06:00 EDT
  // is four real hours but covers wall clock 01:00 to 06:00.
  assert.deepEqual(nyWallClock("2027-03-14T01:00:00-05:00"), { date: "2027-03-14", minutes: 60 });
  assert.deepEqual(nyWallClock("2027-03-14T06:00:00-04:00"), { date: "2027-03-14", minutes: 360 });

  const storeHours: StoreHoursRow[] = [{ weekday: 0, is_closed: false, opens: "01:00:00", closes: "06:00:00" }];
  const full: CoverageShift = {
    starts_at: "2027-03-14T01:00:00-05:00",
    ends_at: "2027-03-14T06:00:00-04:00",
    employee_id: "emp-1",
    position: "PENN Opener",
  };
  assert.deepEqual(
    checkWeekCoverage({ weekStart: "2027-03-14", storeHours, exceptions: [], shiftTypes: SHIFT_TYPES, shifts: [full] })
      .gaps,
    [],
  );

  const short: CoverageShift = { ...full, ends_at: "2027-03-14T04:00:00-04:00" };
  assert.deepEqual(
    checkWeekCoverage({ weekStart: "2027-03-14", storeHours, exceptions: [], shiftTypes: SHIFT_TYPES, shifts: [short] })
      .gaps,
    [{ date: "2027-03-14", from: "04:00", to: "06:00" }],
  );
});

// --- plain words ------------------------------------------------------------

test("gaps read as plain English", () => {
  assert.equal(
    describeGap({ date: "2026-09-22", from: "14:00", to: "16:00" }),
    "Tue Sep 22: nobody in store 2:00 PM to 4:00 PM",
  );
  assert.equal(
    describeGap({ date: "2026-09-20", from: "09:00", to: "12:30" }),
    "Sun Sep 20: nobody in store 9:00 AM to 12:30 PM",
  );
  assert.equal(
    describeGap({ date: "2026-09-26", from: "00:00", to: "02:00" }),
    "Sat Sep 26: nobody in store 12:00 AM to 2:00 AM",
  );
});
