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
  describeStaffingNotSet,
  nyWallClock,
  CLOSE_DOWN_KEY,
  OPEN_UP_KEY,
  resolveOpenWindow,
  shiftSegments,
  staffedWindow,
  staffingMarginsOn,
  type ClosedDateRange,
  type CoverageShift,
  type StoreHoursException,
  type StaffingSettingRow,
  type StoreHoursRow,
} from "./coverage.ts";
import { SETTING_KEYS, inForce, type SettingRow } from "./controlBoard/settings.ts";

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
  staffing?: StaffingSettingRow[];
}) {
  return checkWeekCoverage({
    weekStart: over.weekStart ?? WEEK,
    storeHours: over.storeHours ?? everyDay(),
    exceptions: over.exceptions ?? [],
    shiftTypes: SHIFT_TYPES,
    shifts: over.shifts ?? [],
    closedRanges: over.closedRanges ?? [],
    staffing: over.staffing,
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

test("a shift spilling in from the night before covers the week's first morning", () => {
  // Saturday 22:00 through Sunday 10:00. The week starts on that Sunday, so the
  // shift is not publishable here but it is certainly standing in the store.
  const spillIn: CoverageShift = {
    starts_at: edt("2026-09-19", "22:00"),
    ends_at: edt(SUN, "10:00"),
    employee_id: "emp-1",
    position: "PENN Closer",
  };
  const result = check({
    shifts: [spillIn, shift(SUN, "10:00", "17:00"), ...without(SUN, fullWeekShifts())],
  });
  assert.deepEqual(result.gaps, []);

  // Without it, Sunday morning is a hole — which is the false gap the route
  // would report if it filtered the week by start date alone.
  const withoutSpillIn = check({ shifts: [shift(SUN, "10:00", "17:00"), ...without(SUN, fullWeekShifts())] });
  assert.deepEqual(withoutSpillIn.gaps, [{ date: SUN, from: "09:00", to: "10:00" }]);
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

test("DST fall-back: the repeated hour is ambiguous, and this pins the behaviour", () => {
  // 00:00 EDT to 01:30 EST is two and a half real hours, but wall clock cannot
  // distinguish the two passes through 01:00–02:00, so it reads as 00:00–01:30.
  // See the note on shiftSegments: the reported 01:30–02:00 gap is real in wall
  // clock terms, and the alternative reading is worse. Documented, not fixed.
  const storeHours: StoreHoursRow[] = [{ weekday: 0, is_closed: false, opens: "00:00:00", closes: "02:00:00" }];
  const ambiguous: CoverageShift = {
    starts_at: "2026-11-01T00:00:00-04:00",
    ends_at: "2026-11-01T01:30:00-05:00",
    employee_id: "emp-1",
    position: "PENN Closer",
  };
  assert.deepEqual(shiftSegments(ambiguous), [{ date: "2026-11-01", from: 0, to: 90 }]);
  assert.deepEqual(
    checkWeekCoverage({
      weekStart: "2026-11-01",
      storeHours,
      exceptions: [],
      shiftTypes: SHIFT_TYPES,
      shifts: [ambiguous],
    }).gaps,
    [{ date: "2026-11-01", from: "01:30", to: "02:00" }],
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

// --- Store-hours seasons (bj-finance #742) -------------------------------------
// A season is the weekday pattern again with an `effective_from` date: from
// that date the season's row for the weekday is the one in force. Rows with
// no date are the standing pattern (public.store_hours) and apply before the
// first season, so nothing changes for dates before it.

test("resolveOpenWindow: a season's row takes over its weekday from its effective date, never before", () => {
  const winter = everyDay("13:00:00", "21:00:00").map((r) => ({ ...r, effective_from: "2026-09-23" }));
  const hours = [...everyDay(), ...winter];
  assert.deepEqual(resolveOpenWindow(TUE, hours, []), { state: "open", opens: 540, closes: 1020, source: "weekday" }, "the day before: the standing pattern");
  assert.deepEqual(resolveOpenWindow("2026-09-23", hours, []), { state: "open", opens: 780, closes: 1260, source: "weekday" }, "from the date: the season");
  assert.deepEqual(resolveOpenWindow(TUE, everyDay(), []), resolveOpenWindow(TUE, hours, []), "before the first season, as if there were none");
});

test("resolveOpenWindow: the latest season on or before the date wins, and a later one ends it", () => {
  const season = (from: string, opens: string) => everyDay(opens, "21:00:00").map((r) => ({ ...r, effective_from: from }));
  const hours = [...season("2030-10-01", "13:00:00"), ...everyDay(), ...season("2031-04-01", "10:00:00"), ...season("2031-10-01", "13:00:00")];
  const opensAt = (d: string) => {
    const w = resolveOpenWindow(d, hours, []);
    return w.state === "open" ? w.opens : null;
  };
  assert.equal(opensAt("2030-09-30"), 540, "before any season");
  assert.equal(opensAt("2030-10-01"), 780, "winter");
  assert.equal(opensAt("2031-03-31"), 780, "still winter");
  assert.equal(opensAt("2031-04-01"), 600, "summer");
  assert.equal(opensAt("2031-10-01"), 780, "winter again");
});

test("resolveOpenWindow: a season closes a weekday; exceptions and closures still win over a season", () => {
  const hours = [...everyDay(), { weekday: 2, is_closed: true, opens: null, closes: null, effective_from: "2026-09-01" }];
  assert.deepEqual(resolveOpenWindow(TUE, hours, []), { state: "closed", source: "weekday" });
  const open = [...everyDay(), ...everyDay("13:00:00", "21:00:00").map((r) => ({ ...r, effective_from: "2026-09-01" }))];
  assert.deepEqual(
    resolveOpenWindow(TUE, open, [{ date: TUE, label: "Snow", is_closed: true, opens: null, closes: null }]),
    { state: "closed", source: "exception", label: "Snow" },
  );
});

// --- Staffed hours (bj-finance #742 follow-up, ruled 2026-10-19) ------------
// Open hours are when customers can buy. Staffed hours are the open hours
// widened by the open-up minutes before and the close-down minutes after,
// the values in force on the date (control_settings). Coverage is measured
// against staffed hours. The minutes below are invented.

let staffingId = 1;
const margin = (key: string, value: number, effective_from = "2026-01-01", recorded_at = `${effective_from}T00:00:00Z`): StaffingSettingRow => ({
  id: staffingId++, key, value, effective_from, recorded_at,
});
const openUp = (value: number, from?: string, at?: string) => margin(OPEN_UP_KEY, value, from, at);
const closeDown = (value: number, from?: string, at?: string) => margin(CLOSE_DOWN_KEY, value, from, at);
const OPEN_9_TO_5 = resolveOpenWindow(TUE, everyDay(), []);

test("the staffing keys are board settings owners can set", () => {
  assert.ok(SETTING_KEYS.includes(OPEN_UP_KEY) && SETTING_KEYS.includes(CLOSE_DOWN_KEY));
});

test("staffedWindow: the open window widened by open-up before and close-down after", () => {
  assert.deepEqual(staffedWindow(TUE, OPEN_9_TO_5, [openUp(20), closeDown(40)]), {
    state: "open", opens: 520, closes: 1060, open: { opens: 540, closes: 1020 }, source: "weekday", label: null, missing: [],
  });
});

test("staffedWindow: a closed day stays closed and an unset day stays unset, whatever the minutes", () => {
  const staffing = [openUp(20), closeDown(40)];
  const closed = resolveOpenWindow(TUE, everyDay(), [{ date: TUE, label: "Snow", is_closed: true, opens: null, closes: null }]);
  assert.deepEqual(staffedWindow(TUE, closed, staffing), { state: "closed", source: "exception", label: "Snow" });
  assert.deepEqual(staffedWindow(TUE, { state: "unset" }, staffing), { state: "unset" });
});

test("staffedWindow: special hours on an exception are widened too", () => {
  const short = resolveOpenWindow(TUE, everyDay(), [{ date: TUE, label: "Short day", is_closed: false, opens: "12:00", closes: "15:00" }]);
  const w = staffedWindow(TUE, short, [openUp(15), closeDown(15)]);
  assert.equal(w.state, "open");
  if (w.state !== "open") return;
  assert.deepEqual([w.opens, w.closes, w.source, w.label], [705, 915, "exception", "Short day"]);
});

test("staffedWindow: the values in force on the date are used, a later one taking over from its date", () => {
  const staffing = [openUp(10, "2026-09-01"), closeDown(10, "2026-09-01"), openUp(45, "2026-09-23"), closeDown(5, "2026-09-23")];
  const at = (d: string) => {
    const w = staffedWindow(d, resolveOpenWindow(d, everyDay(), []), staffing);
    return w.state === "open" ? [w.opens, w.closes] : null;
  };
  assert.deepEqual(at(TUE), [530, 1030], "the day before: the first values");
  assert.deepEqual(at(WED), [495, 1025], "from the date: the later values");
});

test("staffedWindow: a same-day correction wins by recorded time, then by id, as the board reads it", () => {
  const first = openUp(10, "2026-09-01", "2026-09-01T10:00:00Z");
  const later = openUp(25, "2026-09-01", "2026-09-01T11:00:00Z");
  const w = staffedWindow(TUE, OPEN_9_TO_5, [later, first, closeDown(0)]);
  assert.equal(w.state === "open" ? w.opens : null, 515);
  // The board's own inForce agrees on every key.
  const rows = [first, later].map((r) => ({ ...r, detail: {}, review_by: "2027-01-01", source: "invented", method: null, recorded_by: null }) as SettingRow);
  assert.equal(inForce(rows, TUE)?.value, staffingMarginsOn(TUE, [first, later]).openUp);
});

test("staffedWindow: missing values fall back to open hours and say which are missing", () => {
  assert.deepEqual(staffedWindow(TUE, OPEN_9_TO_5, []), {
    state: "open", opens: 540, closes: 1020, open: { opens: 540, closes: 1020 }, source: "weekday", label: null,
    missing: ["open-up minutes", "close-down minutes"],
  });
  const onlyOpen = staffedWindow(TUE, OPEN_9_TO_5, [openUp(45)]);
  assert.deepEqual(onlyOpen.state === "open" ? [onlyOpen.opens, onlyOpen.closes, onlyOpen.missing] : null, [495, 1020, ["close-down minutes"]]);
  // A value that starts after the date is not in force yet: missing on the date.
  const notYet = staffedWindow(TUE, OPEN_9_TO_5, [openUp(45, "2026-10-01"), closeDown(45, "2026-10-01")]);
  assert.deepEqual(notYet.state === "open" ? [notYet.opens, notYet.closes, notYet.missing.length] : null, [540, 1020, 2]);
  // Rows for other board keys are ignored.
  const other = staffedWindow(TUE, OPEN_9_TO_5, [margin("rule.solo_close", 45)]);
  assert.deepEqual(other.state === "open" ? other.missing.length : null, 2);
});

test("staffedWindow: zero minutes is a value, not a missing one; the window never runs past midnight", () => {
  const zero = staffedWindow(TUE, OPEN_9_TO_5, [openUp(0), closeDown(0)]);
  assert.deepEqual(zero.state === "open" ? [zero.opens, zero.closes, zero.missing] : null, [540, 1020, []]);
  const late = resolveOpenWindow(TUE, everyDay("00:10:00", "23:50:00"), []);
  const wide = staffedWindow(TUE, late, [openUp(45), closeDown(45)]);
  assert.deepEqual(wide.state === "open" ? [wide.opens, wide.closes] : null, [0, 1440]);
});

test("checkWeekCoverage: gaps are measured against staffed hours when the minutes are set", () => {
  // Covered 09:00 to 17:00 every day: the open hours, but not the 45 minutes either side.
  const result = check({ shifts: fullWeekShifts(), staffing: [openUp(45), closeDown(45)] });
  assert.equal(result.gaps.length, 14);
  assert.deepEqual(result.gaps.slice(0, 2), [
    { date: SUN, from: "08:15", to: "09:00" },
    { date: SUN, from: "17:00", to: "17:45" },
  ]);
  assert.deepEqual(result.staffingNotSet, []);
  const covered = check({ shifts: [SUN, MON, TUE, WED, THU, FRI, SAT].map((d) => shift(d, "08:15", "17:45")), staffing: [openUp(45), closeDown(45)] });
  assert.deepEqual(covered.gaps, []);
});

test("checkWeekCoverage: with no minutes set it checks open hours and names the days it did so", () => {
  const result = check({ shifts: fullWeekShifts() });
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.staffingNotSet, [SUN, MON, TUE, WED, THU, FRI, SAT]);
  // A closed day needs no cover, so it is not among them.
  const closed = check({ shifts: fullWeekShifts(), exceptions: [{ date: TUE, is_closed: true }] });
  assert.ok(!closed.staffingNotSet.includes(TUE));
});

test("the days checked against open hours read as plain dates", () => {
  assert.equal(describeStaffingNotSet([TUE, WED]), "Tue Sep 22, Wed Sep 23");
});
