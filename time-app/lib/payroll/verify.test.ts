// Unit tests for the timesheet rulebook (payroll spec §0 preconditions and
// §1.1 – §1.14, bj-finance #519).
//
//   npm test        (node --test — Node runs TypeScript directly)
//
// Every test name quotes the rule number it holds the code to: the spec's rule
// text IS the acceptance criterion, and several of these fixtures are the
// 2026-09-23 pay run's own data (Carli's 2m 11s punch, Joey's test punch, the
// three nights Sophia closed, NAKASEC's crew of three).
//
// Instants carry an explicit -04:00 offset (Eastern Daylight Time in
// September), so every fixture says exactly which instant it means rather than
// relying on the machine the tests happen to run on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RULING_CHOICES,
  verifyTimesheets,
  type AuditRow,
  type DealRow,
  type Finding,
  type ProfileRow,
  type PunchRow,
  type RulingRow,
  type ShiftRow,
  type ShiftTypeRow,
  type VerifyInput,
} from "./verify.ts";
import { payWindowEnding, type PayWindow } from "./window.ts";
import type { StoreHoursException, StoreHoursRow } from "../coverage.ts";

// --- the world --------------------------------------------------------------

const WINDOW: PayWindow = (() => {
  const r = payWindowEnding("2026-09-20");
  if (!r.ok) throw new Error(r.error);
  return r.window;
})();

const SOPHIA = "11111111-1111-1111-1111-111111111111";
const CARLI = "22222222-2222-2222-2222-222222222222";
const COLE = "33333333-3333-3333-3333-333333333333";
const JOEY = "44444444-4444-4444-4444-444444444444";

const PROFILES: ProfileRow[] = [
  { id: SOPHIA, full_name: "Malmgren, Sophia", active: true, qbo_employee_id: "10" },
  { id: CARLI, full_name: "Freeman, Carli", active: true, qbo_employee_id: "11" },
  { id: COLE, full_name: "McCullough, Cole", active: true, qbo_employee_id: "12" },
  { id: JOEY, full_name: "Barrett, Joey", active: false, qbo_employee_id: null },
];

const SHIFT_TYPES: ShiftTypeRow[] = [
  { name: "PENN Opener", in_store: true },
  { name: "PENN Closer", in_store: true },
  { name: "Catering", in_store: false },
  { name: "Marketing", in_store: false },
];

/** An instant in Eastern Daylight Time, which is what September is. */
function at(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00-04:00`;
}

/**
 * Store hours with exactly one weekday open, the rest closed.
 *
 * Every other check's fixture wants the coverage checks silent, and "closed"
 * is the only way to say that without hiding the difference between closed and
 * not-set — which 1.8 reports on purpose.
 */
function openOn(weekday: number, opens = "11:00:00", closes = "22:00:00"): StoreHoursRow[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) =>
    d === weekday
      ? { weekday: d, is_closed: false, opens, closes }
      : { weekday: d, is_closed: true, opens: null, closes: null },
  );
}

/** Every day closed: the coverage checks have nothing to judge. */
const ALL_CLOSED: StoreHoursRow[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  is_closed: true,
  opens: null,
  closes: null,
}));

let nextPunchId = 1000;
function punch(over: Partial<PunchRow> & Pick<PunchRow, "employee_id" | "clock_in_at">): PunchRow {
  return { id: nextPunchId++, shift_id: null, clock_out_at: null, ...over };
}

let nextShiftId = 300;
function shift(over: Partial<ShiftRow> & Pick<ShiftRow, "employee_id" | "starts_at" | "ends_at">): ShiftRow {
  return { id: nextShiftId++, position: "PENN Opener", deal_id: null, ...over };
}

function run(over: Partial<VerifyInput> = {}) {
  return verifyTimesheets({
    window: WINDOW,
    today: "2026-09-21",
    punches: [],
    shifts: [],
    shiftTypes: SHIFT_TYPES,
    profiles: PROFILES,
    storeHours: ALL_CLOSED,
    // An empty list means "the log is there and nothing was deleted"; null
    // means there is no log at all, which 1.13 treats very differently.
    auditDeletes: [],
    ...over,
  });
}

function only(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

// --- §0 preconditions -------------------------------------------------------

test("0.1: the window is reported, computed here and not read from QBO", () => {
  const f = only(run().findings, "0.1")[0];
  assert.equal(f.status, "auto_resolved");
  assert.match(f.summary, /2026-09-07 → 2026-09-20/);
  assert.match(f.summary, /pay date 2026-09-23/);
});

test("0.1: a window that has not finished yet blocks the button", () => {
  const result = run({ today: "2026-09-18" });
  const f = only(result.findings, "0.1")[0];
  assert.equal(f.status, "needs_fix");
  assert.equal(result.ready, false);
});

test("0.6: store hours edited inside the window are warned about", () => {
  const result = run({ storeHoursUpdatedAt: at("2026-09-20", "16:30") });
  const f = only(result.findings, "0.6")[0];
  assert.equal(f.severity, "warn");
  assert.match(f.resolution ?? "", /1\.8/);
  // A warning, not a blocker: the coverage report is still worth reading.
  assert.equal(f.status, "auto_resolved");
  assert.equal(result.ready, true);
});

test("0.6: store hours edited before the window are not mentioned", () => {
  assert.deepEqual(only(run({ storeHoursUpdatedAt: at("2026-08-30", "09:00") }).findings, "0.6"), []);
});

// --- §1.1 open punch --------------------------------------------------------

test("1.1: a punch with clock_out IS NULL inside the window blocks the button", () => {
  const result = run({ punches: [punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00") })] });
  const f = only(result.findings, "1.1")[0];
  assert.equal(f.status, "needs_fix");
  assert.equal(f.severity, "error");
  assert.match(f.summary, /McCullough, Cole/);
  assert.equal(result.ready, false, "no ruling can stand in for a punch with no end");
});

test("1.1: an open punch outside the window is not this window's problem", () => {
  const result = run({ punches: [punch({ employee_id: COLE, clock_in_at: at("2026-09-21", "11:00") })] });
  assert.deepEqual(only(result.findings, "1.1"), []);
});

// --- §1.2 / §1.3 / §1.4 runaway punches ------------------------------------

test("1.2: a punch over 15h is reported, and handed to 1.4", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "04:00") }),
    ],
  });
  const f = only(result.findings, "1.2")[0];
  assert.match(f.summary, /17h/);
  assert.match(f.resolution ?? "", /1\.4/);
});

test("1.3: a clock-out inside 5s of the same person's next clock-in is a missed clock-out", () => {
  const closed = punch({
    employee_id: CARLI,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-09", "17:00"),
  });
  const next = punch({
    employee_id: CARLI,
    clock_in_at: `2026-09-09T17:00:03-04:00`,
    clock_out_at: at("2026-09-09", "19:00"),
  });
  const result = run({ punches: [closed, next] });
  const f = only(result.findings, "1.3")[0];
  assert.equal(f.evidence.punch_ids?.[0], closed.id);
  assert.match(f.summary, /missed clock-out/);
});

test("1.3: a gap of more than 5s is a person taking a break, not the app auto-closing", () => {
  const first = punch({
    employee_id: CARLI,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-09", "14:00"),
  });
  const second = punch({
    employee_id: CARLI,
    clock_in_at: at("2026-09-09", "14:30"),
    clock_out_at: at("2026-09-09", "18:00"),
  });
  assert.deepEqual(only(run({ punches: [first, second] }).findings, "1.3"), []);
});

test("1.4: a runaway WITH a scheduled shift is truncated to the scheduled end by rule", () => {
  const scheduled = shift({
    employee_id: COLE,
    starts_at: at("2026-09-09", "11:00"),
    ends_at: at("2026-09-09", "19:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: COLE,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-09", "11:00"),
        clock_out_at: at("2026-09-10", "06:00"),
      }),
    ],
  });
  const f = only(result.findings, "1.4")[0];
  assert.equal(f.status, "auto_resolved");
  assert.match(f.resolution ?? "", /8h instead of 19h/);
  assert.equal(f.evidence.hours, 8);
  assert.equal(result.ready, true, "a rule decided it; nothing to ask");
});

test("1.4: a runaway with NO scheduled shift is a ruling — real hours or void", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "06:00") }),
    ],
  });
  const f = only(result.findings, "1.4")[0];
  assert.equal(f.status, "needs_ruling");
  assert.deepEqual(f.options?.map((o) => o.choice), ["real_hours", "void"]);
  assert.match(f.options![0].effect, /19h/);
  assert.equal(f.defaultChoice, undefined, "the spec gives no default here");
  assert.equal(result.ready, false);
});

test("1.4: one punch flagged by both 1.2 and 1.3 gets one ruling, naming both reasons", () => {
  const runaway = punch({
    employee_id: COLE,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-10", "06:00"),
  });
  const next = punch({
    employee_id: COLE,
    clock_in_at: `2026-09-10T06:00:02-04:00`,
    clock_out_at: at("2026-09-10", "08:00"),
  });
  const findings = only(run({ punches: [runaway, next] }).findings, "1.4");
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /> 15h and closed by the next clock-in/);
});

// --- §1.5 short punch -------------------------------------------------------

test("1.5: a punch under 25% of its scheduled shift is a ruling — as punched or scheduled", () => {
  // Carli, 2026-09-18: 2m 11s against a 7h shift, because Sophia closed for
  // her. This is the only check in §1 that can make a day LONGER.
  const scheduled = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-18", "15:00"),
        clock_out_at: `2026-09-18T15:02:11-04:00`,
      }),
    ],
  });
  const f = only(result.findings, "1.5")[0];
  assert.equal(f.status, "needs_ruling");
  assert.match(f.summary, /2m 11s against a 7h scheduled shift/);
  assert.deepEqual(f.options?.map((o) => o.choice), ["as_punched", "scheduled"]);
  assert.match(f.options![1].effect, /Pay 7h/);
  assert.equal(f.defaultChoice, undefined, "two answers a shift's pay apart; the run decides");
});

test("1.5: a punch at exactly 25% of the shift is not short", () => {
  const scheduled = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-18", "14:00"),
    ends_at: at("2026-09-18", "22:00"),
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-18", "14:00"),
        clock_out_at: at("2026-09-18", "16:00"), // 2h of 8h
      }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.5"), []);
});

test("1.5: a short punch with NOTHING scheduled is not a short punch — there is no basis to extend to", () => {
  const result = run({
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-18", "15:00"), clock_out_at: at("2026-09-18", "15:20") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.5"), []);
});

// --- §1.6 test punch --------------------------------------------------------

test("1.6: under 5 minutes with nothing scheduled is 0 hours, and listed", () => {
  // Joey, 2026-09-07: 10.9 seconds.
  const result = run({
    punches: [
      punch({
        employee_id: JOEY,
        clock_in_at: at("2026-09-07", "10:00"),
        clock_out_at: `2026-09-07T10:00:11-04:00`,
      }),
    ],
  });
  const f = only(result.findings, "1.6")[0];
  assert.equal(f.status, "auto_resolved");
  assert.equal(f.evidence.hours, 0);
  assert.match(f.resolution ?? "", /0 hours/);
  assert.equal(result.ready, true);
});

test("1.6: a short punch ON a scheduled shift is 1.5's ruling, never silently zeroed", () => {
  const scheduled = shift({
    employee_id: JOEY,
    starts_at: at("2026-09-07", "10:00"),
    ends_at: at("2026-09-07", "18:00"),
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: JOEY,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-07", "10:00"),
        clock_out_at: `2026-09-07T10:00:11-04:00`,
      }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.6"), []);
  assert.equal(only(result.findings, "1.5").length, 1);
});

// --- §1.7 overlaps ----------------------------------------------------------

test("1.7: the same person on two overlapping punches blocks the button", () => {
  const a = punch({
    employee_id: COLE,
    clock_in_at: at("2026-09-15", "11:00"),
    clock_out_at: at("2026-09-15", "17:00"),
  });
  const b = punch({
    employee_id: COLE,
    clock_in_at: at("2026-09-15", "16:00"),
    clock_out_at: at("2026-09-15", "20:00"),
  });
  const result = run({ punches: [a, b] });
  const f = only(result.findings, "1.7")[0];
  assert.equal(f.status, "needs_fix");
  assert.deepEqual(f.evidence.punch_ids, [a.id, b.id]);
  assert.equal(f.evidence.minutes, 60);
  assert.equal(result.ready, false);
});

test("1.7: two different people at the same time is just a shift with two people on it", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "17:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "17:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.7"), []);
});

test("1.7: back-to-back punches that touch do not overlap", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "15:00") }),
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "15:00"), clock_out_at: at("2026-09-15", "20:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.7"), []);
});

// --- §1.8 mid-day coverage gap ---------------------------------------------

// Wednesday 2026-09-09 is open 11:00–22:00; 2026-09-16 (the window's other
// Wednesday) is closed by exception, so each test judges exactly one day.
const WED_ONLY: { storeHours: StoreHoursRow[]; storeHoursExceptions: StoreHoursException[] } = {
  storeHours: openOn(3),
  storeHoursExceptions: [{ date: "2026-09-16", label: "closed for this fixture", is_closed: true }],
};

test("1.8: a stretch of opening hours with no in-store punch running is reported", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "17:00"), clock_out_at: at("2026-09-09", "22:00") }),
    ],
  });
  const gaps = only(result.findings, "1.8").filter((f) => f.evidence.interval);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].evidence.interval, { from: "15:00", to: "17:00" });
  assert.equal(gaps[0].evidence.minutes, 120);
  // Reported, not blocking: 1.9 is what asks about the end of the evening.
  assert.equal(gaps[0].status, "auto_resolved");
});

test("1.8: a gap shorter than 15 minutes is not reported", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "15:10"), clock_out_at: at("2026-09-09", "22:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.8").filter((f) => f.evidence.interval), []);
});

test("1.8: a Catering punch is off-site and covers nothing", () => {
  const catering = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [catering],
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({
        employee_id: CARLI,
        shift_id: catering.id,
        clock_in_at: at("2026-09-09", "15:00"),
        clock_out_at: at("2026-09-09", "22:00"),
      }),
    ],
  });
  const gaps = only(result.findings, "1.8").filter((f) => f.evidence.interval);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].evidence.interval, { from: "15:00", to: "22:00" });
});

test("1.8: an open punch covers nothing — it cannot say when its cover stopped", () => {
  const result = run({
    ...WED_ONLY,
    punches: [punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00") })],
  });
  const gaps = only(result.findings, "1.8").filter((f) => f.evidence.interval);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].evidence.interval, { from: "11:00", to: "22:00" });
});

test("1.8: a closed day has nothing to cover", () => {
  // Every day closed, one punch on a Wednesday: no gaps anywhere.
  const result = run({
    punches: [punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "12:00") })],
  });
  assert.deepEqual(only(result.findings, "1.8").filter((f) => f.evidence.interval), []);
});

test("1.8: a day whose hours nobody has set is reported, never judged", () => {
  // Hours not set is deliberately different from closed: we cannot judge
  // coverage, so we say so rather than passing the day silently.
  const result = run({ storeHours: [] });
  const notSet = only(result.findings, "1.8");
  assert.equal(notSet.length, 1);
  assert.match(notSet[0].summary, /14 days in this window have no store hours set/);
  assert.equal(notSet[0].status, "auto_resolved");
});

// --- §1.9 no closing punch --------------------------------------------------

test("1.9: the last in-store clock-out more than 2h before close is a ruling, defaulting to salaried cover", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "salaried_cover");
  assert.match(f.summary, /Freeman, Carli at 6:00 PM/);
  assert.match(f.summary, /4h before the 10:00 PM close/);
  // Sophia, 2026-09-21: "if it's missing a punch it would be me closing".
  assert.match(f.options![0].effect, /No solo-close bonus/);
  assert.match(f.options![1].effect, /Freeman, Carli/);
  assert.equal(result.ready, false);
});

test("1.9: a clock-out within 2h of close is a normal night", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
});

test("1.9: a day nobody punched at all is 1.8's whole-day gap, not a closing question", () => {
  // There is no "last person out" for the early-close option to pay.
  const result = run({ ...WED_ONLY });
  assert.deepEqual(only(result.findings, "1.9"), []);
  assert.equal(only(result.findings, "1.8").filter((f) => f.evidence.interval).length, 1);
});

test("1.9: a Catering punch is off-site and cannot be the night's closer", () => {
  const catering = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "18:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [catering],
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
      punch({
        employee_id: CARLI,
        shift_id: catering.id,
        clock_in_at: at("2026-09-09", "18:00"),
        clock_out_at: at("2026-09-09", "22:00"),
      }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.match(f.summary, /McCullough, Cole at 6:00 PM/);
});

// --- §1.10 cover punches ----------------------------------------------------

test("1.10: a blank shift_id joins to that person's own shift that day first", () => {
  const own = shift({
    employee_id: COLE,
    starts_at: at("2026-09-15", "11:00"),
    ends_at: at("2026-09-15", "19:00"),
    position: "PENN Opener",
  });
  const result = run({
    shifts: [own],
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:02"), clock_out_at: at("2026-09-15", "19:05") }),
    ],
  });
  const f = only(result.findings, "1.10")[0];
  assert.match(f.resolution ?? "", new RegExp(`own shift ${own.id}`));
  assert.deepEqual(f.evidence.shift_ids, [own.id]);
});

test("1.10: with no shift of their own, the punch joins an unworked shift that brackets it, and names the swap", () => {
  // Nine of nine blank punches in the 2026-09-23 window were covers, and
  // person+date found none of them.
  const carlisShift = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-15", "15:00"),
    ends_at: at("2026-09-15", "22:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [carlisShift],
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "15:05"), clock_out_at: at("2026-09-15", "22:10") }),
    ],
  });
  const f = only(result.findings, "1.10")[0];
  assert.match(f.resolution ?? "", /Covered Freeman, Carli's shift/);
  assert.deepEqual(f.evidence.shift_ids, [carlisShift.id]);
});

test("1.10: a shift its own person punched is not available to be covered", () => {
  const carlisShift = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-15", "15:00"),
    ends_at: at("2026-09-15", "22:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [carlisShift],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: carlisShift.id,
        clock_in_at: at("2026-09-15", "15:00"),
        clock_out_at: at("2026-09-15", "22:00"),
      }),
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "15:05"), clock_out_at: at("2026-09-15", "22:10") }),
    ],
  });
  const cole = only(result.findings, "1.10")[0];
  assert.match(cole.summary, /no shift was found for it/);
});

test("1.10: a punch with no shift anywhere says so, and is paid as punched", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "17:00") }),
    ],
  });
  const f = only(result.findings, "1.10")[0];
  assert.equal(f.severity, "warn");
  assert.match(f.resolution ?? "", /paid as punched/);
  assert.equal(f.status, "auto_resolved");
});

// --- §1.11 / §1.12 catering -------------------------------------------------

test("1.11: a Catering shift with no deal is flagged, and does not block payroll", () => {
  // "flag at scheduling time, not payroll time" — shift 334, Sophia 09-09.
  const orphan = shift({
    employee_id: SOPHIA,
    starts_at: at("2026-09-09", "12:00"),
    ends_at: at("2026-09-09", "16:00"),
    position: "Catering",
    deal_id: null,
  });
  const result = run({ shifts: [orphan] });
  const f = only(result.findings, "1.11")[0];
  assert.equal(f.status, "auto_resolved");
  assert.match(f.resolution ?? "", /scheduling time, not payroll time/);
  assert.equal(result.ready, true);
});

test("1.12: a catering event with fewer crew punched than staff_count is reported", () => {
  // NAKASEC 2026-09-19: 1 of 3.
  const deal: DealRow = { id: 25390, event_date: "2026-09-19", staff_count: 3, company: "NAKASEC" };
  const crewShift = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-19", "16:00"),
    ends_at: at("2026-09-19", "21:00"),
    position: "Catering",
    deal_id: deal.id,
  });
  const result = run({
    deals: [deal],
    shifts: [crewShift],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: crewShift.id,
        clock_in_at: at("2026-09-19", "16:00"),
        clock_out_at: at("2026-09-19", "21:00"),
      }),
    ],
  });
  const f = only(result.findings, "1.12")[0];
  assert.match(f.summary, /NAKASEC/);
  assert.match(f.summary, /1 of 3 crew punched/);
  assert.equal(f.status, "auto_resolved");
});

test("1.12: a fully punched event says nothing", () => {
  const deal: DealRow = { id: 25390, event_date: "2026-09-19", staff_count: 1, company: "NAKASEC" };
  const crewShift = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-19", "16:00"),
    ends_at: at("2026-09-19", "21:00"),
    position: "Catering",
    deal_id: deal.id,
  });
  const result = run({
    deals: [deal],
    shifts: [crewShift],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: crewShift.id,
        clock_in_at: at("2026-09-19", "16:00"),
        clock_out_at: at("2026-09-19", "21:00"),
      }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.12"), []);
});

// --- §1.13 deleted rows -----------------------------------------------------

test("1.13: no audit table blocks the button — 'nothing deleted' and 'we cannot see' are not the same answer", () => {
  const result = run({ auditDeletes: null });
  const f = only(result.findings, "1.13")[0];
  assert.equal(f.status, "needs_fix");
  assert.match(f.summary, /no audit table/);
  assert.equal(result.ready, false);
});

test("1.13: a punch deleted from inside the window is reported with who took it", () => {
  // Joey's 2026-09-10 punch, the one that vanished.
  const deletion: AuditRow = {
    id: 9,
    table_name: "time_entries",
    row_id: 1271,
    op: "DELETE",
    at: at("2026-09-21", "09:12"),
    actor_uid: SOPHIA,
    actor_role: "authenticated",
    db_role: "authenticated",
    before_image: {
      id: 1271,
      employee_id: JOEY,
      clock_in_at: at("2026-09-10", "10:00"),
      clock_out_at: at("2026-09-10", "16:00"),
    },
  };
  const result = run({ auditDeletes: [deletion] });
  const f = only(result.findings, "1.13")[0];
  assert.match(f.summary, /punch 1271 for Barrett, Joey/);
  assert.match(f.summary, /deleted by Malmgren, Sophia/);
  assert.deepEqual(f.evidence.punch_ids, [1271]);
  assert.equal(f.status, "auto_resolved", "evidence, not a blocker: the manager decides what to do");
});

test("1.13: a deletion by the service-role key still names an actor", () => {
  const deletion: AuditRow = {
    id: 10,
    table_name: "shifts",
    row_id: 350,
    op: "DELETE",
    at: at("2026-09-21", "03:00"),
    actor_uid: null,
    actor_role: "service_role",
    db_role: "service_role",
    before_image: { id: 350, employee_id: CARLI, starts_at: at("2026-09-12", "13:30"), ends_at: at("2026-09-12", "18:00") },
  };
  const f = only(run({ auditDeletes: [deletion] }).findings, "1.13")[0];
  assert.match(f.summary, /the service_role key/);
  assert.deepEqual(f.evidence.shift_ids, [350]);
});

test("1.13: a deletion of a row dated outside the window is not this window's business", () => {
  const deletion: AuditRow = {
    id: 11,
    table_name: "time_entries",
    row_id: 900,
    op: "DELETE",
    at: at("2026-09-21", "09:00"),
    actor_uid: SOPHIA,
    actor_role: "authenticated",
    db_role: "authenticated",
    before_image: { id: 900, employee_id: JOEY, clock_in_at: at("2026-08-10", "10:00") },
  };
  assert.deepEqual(only(run({ auditDeletes: [deletion] }).findings, "1.13"), []);
});

// --- §1.14 name hygiene -----------------------------------------------------

test("1.14: a full_name containing '@' is the invite-flow bug, reported and not blocking", () => {
  const result = run({
    profiles: [...PROFILES, { id: "x", full_name: "someone@benjerryphilly.com", active: true }],
  });
  const f = only(result.findings, "1.14")[0];
  assert.match(f.resolution ?? "", /qbo_employee_id, never a name/);
  assert.equal(f.status, "auto_resolved");
  assert.equal(result.ready, true);
});

// --- the button -------------------------------------------------------------

test("§1: the button is green only when every finding is auto-resolved or ruled", () => {
  const scheduled = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
    position: "PENN Closer",
  });
  const short = punch({
    employee_id: CARLI,
    shift_id: scheduled.id,
    clock_in_at: at("2026-09-18", "15:00"),
    clock_out_at: `2026-09-18T15:02:11-04:00`,
  });
  const input = { shifts: [scheduled], punches: [short] };

  const before = run(input);
  assert.equal(before.counts.needsRuling, 1);
  assert.equal(before.counts.ruled, 0);
  assert.equal(before.ready, false);

  const ruling: RulingRow = {
    check_id: "1.5",
    finding_key: `1.5:punch:${short.id}`,
    choice: "as_punched",
    decided_by: SOPHIA,
    decided_at: at("2026-09-21", "11:00"),
  };
  const after = run({ ...input, rulings: [ruling] });
  assert.equal(after.counts.ruled, 1);
  assert.equal(after.ready, true);
  assert.equal(only(after.findings, "1.5")[0].ruling?.choice, "as_punched");
});

test("§1: a ruling recorded against a different finding does not answer this one", () => {
  const scheduled = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
  });
  const short = punch({
    employee_id: CARLI,
    shift_id: scheduled.id,
    clock_in_at: at("2026-09-18", "15:00"),
    clock_out_at: `2026-09-18T15:02:11-04:00`,
  });
  const after = run({
    shifts: [scheduled],
    punches: [short],
    rulings: [{ check_id: "1.5", finding_key: "1.5:punch:999999", choice: "scheduled" }],
  });
  assert.equal(after.ready, false);
  assert.equal(only(after.findings, "1.5")[0].ruling, null);
});

test("§1: a fix-class finding cannot be ruled away", () => {
  const open = punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00") });
  const after = run({
    punches: [open],
    rulings: [{ check_id: "1.4", finding_key: `1.1:punch:${open.id}`, choice: "void" }],
  });
  assert.equal(after.ready, false);
});

test("§1: findings are grouped by check, in spec order, and only non-empty groups appear", () => {
  const result = run({
    punches: [punch({ employee_id: COLE, clock_in_at: at("2026-09-15", "11:00") })],
  });
  assert.deepEqual(result.groups.map((g) => g.check), ["0.1", "1.1", "1.10"]);
  assert.equal(result.groups[1].rule, "clock_out IS NULL inside window");
});

test("§1: every option a finding offers is in the API's ruling vocabulary", () => {
  // The options are built per finding (their effect is per finding); the
  // vocabulary the route validates against is fixed. This is what stops the
  // two drifting apart.
  const scheduled = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
  });
  const result = run({
    ...WED_ONLY,
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CARLI,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-18", "15:00"),
        clock_out_at: `2026-09-18T15:02:11-04:00`,
      }),
      // A runaway with no shift, on a day the store is shut: 1.4's ruling.
      punch({ employee_id: COLE, clock_in_at: at("2026-09-14", "11:00"), clock_out_at: at("2026-09-15", "06:00") }),
      // An early finish on the one open day: 1.9's ruling.
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  const ruling = result.findings.filter((f) => f.status === "needs_ruling");
  assert.ok(ruling.length >= 3, "the fixture should produce 1.4, 1.5 and 1.9 rulings");
  for (const f of ruling) {
    const allowed = RULING_CHOICES[f.check];
    assert.ok(allowed, `check ${f.check} produced a ruling with no vocabulary`);
    for (const option of f.options ?? []) {
      assert.ok(allowed.includes(option.choice), `${f.check} offered ${option.choice}, which the API would refuse`);
    }
    if (f.defaultChoice) assert.ok(allowed.includes(f.defaultChoice));
  }
});
