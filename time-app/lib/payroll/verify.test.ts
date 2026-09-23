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
  caseDate,
  choicePays,
  lockingWindow,
  sameNameWords,
  verifyTimesheets,
  type ApprovalRow,
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
  { id: SOPHIA, full_name: "Malmgren, Sophia", active: true, role: "manager", qbo_employee_id: "10" },
  { id: CARLI, full_name: "Freeman, Carli", active: true, role: "employee", qbo_employee_id: "11" },
  { id: COLE, full_name: "McCullough, Cole", active: true, role: "manager", qbo_employee_id: "12" },
  { id: JOEY, full_name: "Barrett, Joey", active: false, role: "employee", qbo_employee_id: null },
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

test("1.4: a runaway with NO scheduled shift has no default and no picker — it is fixed upstream (ruling D)", () => {
  const result = run({
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "06:00") }),
    ],
  });
  const f = only(result.findings, "1.4")[0];
  assert.equal(f.status, "needs_fix");
  assert.equal(f.options, undefined, "no picker");
  assert.equal(f.defaultChoice, undefined, "no default");
  assert.match(f.resolution!, /Correct the punch on the Timesheets page/);
  assert.equal(result.counts.needsFix, 1);
  assert.equal(result.ready, false);
});

test("1.4: a recorded choice cannot answer a runaway — only correcting the punch clears it", () => {
  const runaway = punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "06:00") });
  const result = run({
    punches: [runaway],
    rulings: [{ check_id: "1.4", finding_key: `1.4:punch:${runaway.id}`, choice: "real_hours" }],
  });
  assert.equal(only(result.findings, "1.4")[0].ruling, undefined);
  assert.equal(result.ready, false);
  assert.equal("1.4" in RULING_CHOICES, false, "the API refuses a 1.4 choice");
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

test("1.5: a punch under 25% of its scheduled shift has no default and no picker — it is fixed upstream (ruling D)", () => {
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
  assert.equal(f.status, "needs_fix");
  assert.match(f.summary, /2m 11s against a 7h scheduled shift/);
  assert.equal(f.options, undefined, "no picker");
  assert.equal(f.defaultChoice, undefined, "two answers a shift's pay apart; no default");
  assert.match(f.resolution!, /Correct the punch on the Timesheets page/);
  assert.equal(result.ready, false);
  assert.equal("1.5" in RULING_CHOICES, false, "the API refuses a 1.5 choice");
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

test("1.9: the last in-store clock-out more than 2h before close is a choice, defaulting to skip", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "skip");
  assert.match(f.summary, /Freeman, Carli at 6:00 PM/);
  assert.match(f.summary, /4h before the 10:00 PM close/);
  assert.deepEqual(f.options!.map((o) => o.choice), ["skip", "scheduled_closer", "unpunched_manager"]);
  assert.match(f.options![0].effect, /No solo-close bonus/);
  assert.match(f.options![1].effect, /Nobody was scheduled to close/);
  // Ruled 2026-09-22: the default stands on its own, so nothing is owed here.
  assert.deepEqual(f.effective, { choice: "skip", payee: null, source: "default" });
  assert.equal(result.ready, true);
  // This night, and the period's missing bake shift (3.7), both stand on defaults.
  assert.equal(result.counts.defaulted, 2);
});

test("1.9: a close at or after 22:00 within 2h of close is a normal night", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "22:05") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
});

test("1.9: a 4h+ solo tail out before 22:00 is eligible within 2h of close (2.4 qualifying, ruling C)", () => {
  // Alone from 11:00 to 20:30: the rule cannot pay it (out before 22:00), so
  // the night gets the dropdown. The payroll sheet routes the same night.
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.match(f.summary, /before 22:00, after 9h 30m alone/);
  assert.equal(f.evidence.hours, 9.5);
  assert.deepEqual(f.evidence.notes, ["2.4 qualifying: solo tail of 4h or more, out before 22:00"]);
});

test("1.9: a short solo tail out before 22:00 within 2h of close gets NO dropdown (ruling C)", () => {
  // The trigger the previous rework added — any last clock-out before 22:00 —
  // is gone. Cole leaves at 20:00, Carli at 20:30: 30 minutes alone.
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "20:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
});

test("1.9: more than 2h before close is eligible however short the tail", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "19:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "19:30") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.match(f.summary, /2h 30m before the 10:00 PM close/);
  assert.deepEqual(f.evidence.notes, ["1.9: no closing punch"]);
});

test("1.9: a partner who left before the closer arrived does not shorten the tail", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "09:00"), clock_out_at: at("2026-09-09", "12:00") }),
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  assert.equal(only(result.findings, "1.9")[0].evidence.hours, 4.5);
});

test("1.9: a day with no closing time is judged on 2.4 alone, as the payroll sheet judges it", () => {
  // ALL_CLOSED: no close to measure 1.9's gap against.
  const long = run({
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  assert.equal(only(long.findings, "1.9").length, 1);
  const short = run({
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  assert.deepEqual(only(short.findings, "1.9"), []);
});

test("1.9: the scheduled closer is the in-store shift ending last; the manager list is managers only", () => {
  const early = shift({ employee_id: COLE, starts_at: at("2026-09-09", "11:00"), ends_at: at("2026-09-09", "17:00") });
  const close = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "16:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "PENN Closer",
  });
  const event = shift({
    employee_id: SOPHIA,
    starts_at: at("2026-09-09", "18:00"),
    ends_at: at("2026-09-09", "23:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [early, close, event],
    punches: [
      punch({ employee_id: COLE, shift_id: early.id, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "17:00") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.deepEqual(f.scheduledCloser, { id: CARLI, name: "Freeman, Carli" });
  assert.match(f.options![1].effect, /Freeman, Carli was scheduled to close/);
  assert.deepEqual(f.candidates!.map((c) => c.id), [SOPHIA, COLE]);
  assert.deepEqual(f.evidence.shift_ids, [close.id]);
});

function earlyCloseNight(rulings: RulingRow[] = [], approval: ApprovalRow | null = null) {
  return run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    rulings,
    approval,
  });
}

test("1.9: a manager who changes the dropdown to pay themselves is flagged, not refused", () => {
  const result = earlyCloseNight([
    {
      check_id: "1.9",
      finding_key: "1.9:2026-09-09",
      choice: "unpunched_manager",
      payee_id: SOPHIA,
      decided_by: SOPHIA,
      decided_at: at("2026-09-21", "10:00"),
    },
  ]);
  const f = only(result.findings, "1.9")[0];
  assert.deepEqual(f.effective, {
    choice: "unpunched_manager",
    payee: { id: SOPHIA, name: "Malmgren, Sophia" },
    source: "recorded",
  });
  assert.equal(f.flags!.length, 1);
  assert.match(result.flags[0].message, /Malmgren, Sophia set this night's dropdown to pay themselves/);
  assert.equal(result.ready, true);
});

test("1.9: another manager paying her is not a flag", () => {
  const result = earlyCloseNight([
    { check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "unpunched_manager", payee_id: SOPHIA, decided_by: COLE },
  ]);
  assert.deepEqual(result.flags, []);
});

// --- one approval per run ---------------------------------------------------

test("approval: none recorded is not approved", () => {
  assert.equal(earlyCloseNight().approvalState, "not_approved");
});

test("approval: once given it stands, and it is final", () => {
  const result = earlyCloseNight(
    [{ check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "skip", decided_by: COLE, decided_at: at("2026-09-21", "10:00") }],
    { approved_by: COLE, approved_at: at("2026-09-21", "12:00") },
  );
  assert.equal(result.approvalState, "approved");
  assert.deepEqual(result.approval, { approved_by: COLE, approved_at: at("2026-09-21", "12:00") });
});

test("approval: there is no stale state — a later timestamp on a choice does not reopen the run", () => {
  // The database refuses such a change (migration 27); even if one got through,
  // the approval is final and the app does not invite approving again.
  const result = earlyCloseNight(
    [{ check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "skip", decided_by: COLE, decided_at: at("2026-09-21", "13:00") }],
    { approved_by: COLE, approved_at: at("2026-09-21", "12:00") },
  );
  assert.equal(result.approvalState, "approved");
});

test("approval: every choice in the approved run is locked", () => {
  const result = earlyCloseNight([], { approved_by: COLE, approved_at: at("2026-09-21", "12:00") });
  const cases = result.findings.filter((f) => f.status === "needs_ruling");
  assert.ok(cases.length > 0);
  for (const f of cases) assert.equal(f.lockedBy, WINDOW.end, f.key);
});

test("approval: nothing is locked before the run is approved", () => {
  for (const f of earlyCloseNight().findings.filter((x) => x.status === "needs_ruling")) assert.equal(f.lockedBy, null);
});

test("approval: a night inside a neighbouring approved run is locked by that run", () => {
  // The schedule asks about the window ending a week later than the approved
  // one; the 09-09 night still belongs to the run ending 09-20.
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    otherApprovals: [
      { window_end: "2026-09-13", approved_by: COLE, approved_at: at("2026-09-14", "12:00") },
      { window_end: undefined, approved_by: COLE, approved_at: at("2026-09-14", "12:00") },
    ],
  });
  assert.equal(only(result.findings, "1.9")[0].lockedBy, "2026-09-13");
  assert.equal(result.approvalState, "not_approved");
});

test("approval: the 3.7 case is dated by its window's last day", () => {
  const f = { check: "3.7", evidence: {} } as unknown as Finding;
  assert.equal(caseDate(f, WINDOW), WINDOW.end);
  assert.equal(caseDate({ check: "3.5", evidence: {} } as unknown as Finding, WINDOW), null);
  assert.equal(caseDate({ check: "1.9", evidence: { date: "2026-09-09" } } as unknown as Finding, WINDOW), "2026-09-09");
});

test("approval: a run's lock covers exactly its fourteen days", () => {
  assert.equal(lockingWindow("2026-09-07", ["2026-09-20"]), "2026-09-20");
  assert.equal(lockingWindow("2026-09-20", ["2026-09-20"]), "2026-09-20");
  assert.equal(lockingWindow("2026-09-06", ["2026-09-20"]), null);
  assert.equal(lockingWindow("2026-09-21", ["2026-09-20"]), null);
  assert.equal(lockingWindow(null, ["2026-09-20"]), null);
  assert.equal(lockingWindow("2026-09-15", ["2026-09-27", "2026-09-20"]), "2026-09-20");
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

// --- §3.5 crewless catering event -------------------------------------------

const PWC: DealRow = { id: 25100, event_date: "2026-09-09", staff_count: 2, company: "PwC", stage: "Booked Paid" };

test("3.4: an invoice tip with no deal, from any point in history, is a flag and never a block (ruling A)", () => {
  const result = run({
    unmatchedTips: [
      { id: 41, deal_id: null, payer: "Nobody Known", tip_cents: 2500, paid_date: "2025-11-03", event_date: null, status: "held", released_in_run: null },
      { id: 42, deal_id: null, payer: null, tip_cents: 1000, paid_date: "2026-09-03", event_date: null, status: "held", released_in_run: null, note: "no invoice title" },
      // Defensive: a row that does carry a deal is not unmatched.
      { id: 43, deal_id: 25188, payer: "Bo Geraci", tip_cents: 10000, paid_date: "2026-09-02", event_date: "2026-09-19", status: "held", released_in_run: null },
    ],
  });
  const found = only(result.findings, "3.4");
  assert.deepEqual(found.map((f) => [f.key, f.status]), [
    ["3.4:held:41", "auto_resolved"],
    ["3.4:held:42", "auto_resolved"],
  ]);
  assert.match(found[0].summary, /\$25\.00 invoice tip from Nobody Known, paid 2025-11-03, joins to no deal/);
  assert.match(found[1].summary, /from an unnamed payer/);
  assert.deepEqual(found[1].evidence.notes, ["no invoice title"]);
  assert.deepEqual(result.flags.map((flag) => flag.key), ["3.4:held:41", "3.4:held:42"]);
  assert.equal(result.ready, true, "a flag never holds the button");
  assert.equal("3.4" in RULING_CHOICES, false);
});

test("3.4: a row with no id is keyed by its payment id, else its date and amount", () => {
  const result = run({
    unmatchedTips: [
      { deal_id: null, payer: "A", tip_cents: 500, paid_date: "2026-09-01", event_date: null, status: "held", released_in_run: null, source_payment_id: "sq_1" },
      { deal_id: null, payer: "B", tip_cents: 700, paid_date: "2026-09-02", event_date: null, status: "held", released_in_run: null },
    ],
  });
  assert.deepEqual(only(result.findings, "3.4").map((f) => f.key), ["3.4:held:sq_1", "3.4:held:2026-09-02:700"]);
});

test("3.5: a booked event with nobody on it gets a picker, default Sophia, and the upstream warning", () => {
  const result = run({ windowDeals: [PWC] });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.key, "3.5:deal:25100");
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "staff");
  // "Malmgren, Sophia" on file is the ruled default "Sophia Malmgren".
  assert.deepEqual(f.defaultPayee, { id: SOPHIA, name: "Malmgren, Sophia" });
  assert.match(f.summary, /Add the event's Catering shift/);
  assert.deepEqual(f.candidates!.map((c) => c.id), [CARLI, SOPHIA, COLE]);
  assert.equal(result.ready, true, "the default stands on its own");
});

test("3.5: a Catering shift linked to the deal, or on the event date, is a crew", () => {
  const linked = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-08", "15:00"),
    ends_at: at("2026-09-08", "18:00"),
    position: "Catering",
    deal_id: 25100,
  });
  const sameDay = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "18:00"),
    position: "Catering",
    deal_id: 99999,
  });
  assert.deepEqual(only(run({ windowDeals: [PWC], shifts: [linked] }).findings, "3.5"), []);
  assert.deepEqual(only(run({ windowDeals: [PWC], shifts: [sameDay] }).findings, "3.5"), []);
});

test("3.5: an unassigned Catering shift is not a crew", () => {
  const open = shift({
    employee_id: null,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "18:00"),
    position: "Catering",
    deal_id: 25100,
  });
  assert.equal(only(run({ windowDeals: [PWC], shifts: [open] }).findings, "3.5").length, 1);
});

test("3.5: a lost deal, or one outside the window, is not asked about", () => {
  const lost = { ...PWC, stage: "Closed Lost" };
  const later = { ...PWC, event_date: "2026-10-05" };
  const unnamed = { ...PWC, id: 25101, company: null, stage: null };
  assert.deepEqual(only(run({ windowDeals: [lost, later] }).findings, "3.5"), []);
  assert.match(only(run({ windowDeals: [unnamed] }).findings, "3.5")[0].summary, /deal 25101/);
});

test("3.5: a crewless tip paid to the person who approves the run is flagged, default or not", () => {
  const approval = { approved_by: SOPHIA, approved_at: at("2026-09-21", "12:00") };
  const byDefault = run({ windowDeals: [PWC], approval });
  assert.match(byDefault.flags[0].message, /Paid to Malmgren, Sophia, who approved this run/);

  const picked = run({
    windowDeals: [PWC],
    approval,
    rulings: [{ check_id: "3.5", finding_key: "3.5:deal:25100", choice: "staff", payee_id: CARLI, decided_by: SOPHIA }],
  });
  assert.deepEqual(picked.flags, []);
  assert.equal(only(picked.findings, "3.5")[0].effective?.payee?.id, CARLI);
});

test("3.5: with nobody on file matching the default, the case must be answered", () => {
  const result = run({ windowDeals: [PWC], profiles: PROFILES.filter((p) => p.id !== SOPHIA) });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.defaultPayee, null);
  assert.equal(result.ready, false);
});

// --- §3.7 no bake shift ----------------------------------------------------

test("3.7: an open period with no Pastry Opener shift worked is a schedule anomaly with a picker", () => {
  const scheduledNotWorked = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "06:00"),
    ends_at: at("2026-09-09", "10:00"),
    position: "Pastry Opener",
  });
  const result = run({ ...WED_ONLY, shifts: [scheduledNotWorked] });
  const f = only(result.findings, "3.7")[0];
  assert.equal(f.key, "3.7:olo:2026-09-20");
  assert.match(f.summary, /norm is at least 4/);
  assert.deepEqual(f.defaultPayee, { id: SOPHIA, name: "Malmgren, Sophia" });
});

test("3.7: one bake shift worked is enough to split over", () => {
  const bake = shift({
    employee_id: CARLI,
    starts_at: at("2026-09-09", "06:00"),
    ends_at: at("2026-09-09", "10:00"),
    position: "Pastry Opener",
  });
  const result = run({
    ...WED_ONLY,
    shifts: [bake],
    punches: [
      punch({ employee_id: CARLI, shift_id: bake.id, clock_in_at: at("2026-09-09", "06:00"), clock_out_at: at("2026-09-09", "10:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "3.7"), []);
});

test("3.7: a period the store never opened is not asked about", () => {
  assert.deepEqual(only(run().findings, "3.7"), []);
});

test("choices: the paying choices are exactly the ones that need a payee", () => {
  assert.equal(choicePays("1.9", "skip"), false);
  assert.equal(choicePays("1.9", "scheduled_closer"), true);
  assert.equal(choicePays("3.5", "staff"), true);
  assert.equal(choicePays("1.5", "scheduled"), false);
  assert.equal(sameNameWords("Sophia Malmgren", "Malmgren, Sophia"), true);
  assert.equal(sameNameWords("", ""), false);
  assert.equal(sameNameWords(null, "Sophia"), false);
});

// --- the button -------------------------------------------------------------

test("§1: a short punch holds the button until the punch itself is corrected (ruling D)", () => {
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

  const before = run({ shifts: [scheduled], punches: [short] });
  assert.equal(before.counts.needsFix, 1);
  assert.equal(before.counts.needsRuling, 0, "nothing to choose: the punch is the only thing wrong");
  assert.equal(before.ready, false);

  const corrected = { ...short, clock_out_at: at("2026-09-18", "22:00") };
  const after = run({ shifts: [scheduled], punches: [corrected] });
  assert.deepEqual(only(after.findings, "1.5"), []);
  assert.equal(after.counts.needsFix, 0);
  assert.equal(after.ready, true);
});

test("§1: a ruling recorded against a different finding does not answer this one", () => {
  const after = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CARLI, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    rulings: [{ check_id: "1.9", finding_key: "1.9:2026-09-02", choice: "scheduled_closer", payee_id: CARLI }],
  });
  const f = only(after.findings, "1.9")[0];
  assert.equal(f.ruling, null);
  assert.equal(f.effective?.source, "default");
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
      // A runaway with no shift, on a day the store is shut: 1.4, a fix.
      punch({ employee_id: COLE, clock_in_at: at("2026-09-14", "11:00"), clock_out_at: at("2026-09-15", "06:00") }),
      // An early finish on the one open day: 1.9's choice.
      punch({ employee_id: COLE, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  const ruling = result.findings.filter((f) => f.status === "needs_ruling");
  assert.ok(ruling.length >= 2, "the fixture should produce 1.9 and 3.7 choices");
  // Ruling D: 1.4 and 1.5 are fixes, never choices.
  assert.deepEqual(
    result.findings.filter((f) => f.check === "1.4" || f.check === "1.5").map((f) => f.status),
    ["needs_fix", "needs_fix"],
  );
  for (const f of ruling) {
    const allowed = RULING_CHOICES[f.check];
    assert.ok(allowed, `check ${f.check} produced a ruling with no vocabulary`);
    for (const option of f.options ?? []) {
      assert.ok(allowed.includes(option.choice), `${f.check} offered ${option.choice}, which the API would refuse`);
    }
    if (f.defaultChoice) assert.ok(allowed.includes(f.defaultChoice));
  }
});
