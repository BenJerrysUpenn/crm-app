// Unit tests for the timesheet rulebook (payroll spec §0 preconditions and
// §1, bj-finance #519).
//
//   npm test        (node --test — Node runs TypeScript directly)
//
// Every test name quotes the rule number it holds the code to: the spec's rule
// text IS the acceptance criterion, and several of these fixtures are the
// 2026-09-23 pay run's own data, under invented names (Casey's 2m 11s punch, Jamie's test punch, the
// three nights Pat closed, Example Nonprofit's crew of three).
//
// Instants carry an explicit -04:00 offset (Eastern Daylight Time in
// September), so every fixture says exactly which instant it means rather than
// relying on the machine the tests happen to run on.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CREW_PUNCH_REQUIRED_FROM,
  DEFAULT_TIP_PAYEE_NAME,
  RULING_CHOICES,
  buildPunchViews,
  caseDate,
  choicePays,
  eventCrew,
  lockingWindow,
  sameNameWords,
  verifyTimesheets,
  nyInputToIso,
  wallClockInput,
  type SubmittalRow,
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

const PAT = "11111111-1111-1111-1111-111111111111";
const CASEY = "22222222-2222-2222-2222-222222222222";
const DREW = "33333333-3333-3333-3333-333333333333";
const JAMIE = "44444444-4444-4444-4444-444444444444";

const PROFILES: ProfileRow[] = [
  { id: PAT, full_name: "Example, Pat", active: true, role: "manager", qbo_employee_id: "10" },
  { id: CASEY, full_name: "Bravo, Casey", active: true, role: "employee", qbo_employee_id: "11" },
  { id: DREW, full_name: "Sample, Drew", active: true, role: "manager", qbo_employee_id: "12" },
  { id: JAMIE, full_name: "Tester, Jamie", active: false, role: "employee", qbo_employee_id: null },
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
    // The §3.5/§3.7 default payee, by name words, as production matches it.
    defaultTipPayeeName: "Pat Example",
    ...over,
  });
}

function only(findings: Finding[], check: string): Finding[] {
  return findings.filter((f) => f.check === check);
}

// --- §0 preconditions -------------------------------------------------------

// 0.1 (pay window), 1.10 (cover punches), 1.13 (deleted rows) and 1.14 (name
// hygiene) are not findings any more (Alina, 2026-10-05: "useless, kill
// these"). The window is still computed (window.ts) and covers are still
// matched (buildPunchViews): only the cards are gone, and with them their
// share of the summary counts.

test("removed checks: 0.1, 1.10, 1.13 and 1.14 are never reported, and do not count", () => {
  // Short enough that the 2.4 solo-tail question (1.9) does not arise.
  const ownShift = shift({ employee_id: DREW, starts_at: at("2026-09-15", "11:00"), ends_at: at("2026-09-15", "14:00") });
  const result = run({
    shifts: [ownShift],
    punches: [
      // A blank shift_id joined to the person's own shift: once a 1.10 card.
      punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:02"), clock_out_at: at("2026-09-15", "14:05") }),
    ],
    // An email for a name: once a 1.14 card.
    profiles: [...PROFILES, { id: "x", full_name: "someone@example.com", active: true }],
  });
  for (const check of ["0.1", "1.10", "1.13", "1.14"]) {
    assert.deepEqual(only(result.findings, check), [], `${check} is not a finding`);
    assert.equal(result.groups.some((g) => g.check === check), false, `${check} has no group`);
  }
  assert.deepEqual(result.counts, { total: 0, autoResolved: 0, needsRuling: 0, ruled: 0, defaulted: 0, needsFix: 0 });
  assert.equal(result.ready, true);
});

test("removed checks: the pay window is not a finding, and an unfinished period is still not ready", () => {
  const result = run({ today: "2026-09-18" });
  assert.deepEqual(only(result.findings, "0.1"), []);
  assert.equal(result.counts.needsFix, 0);
  assert.equal(result.ready, false, "the period has not ended: nothing to fix, but not ready either");
  assert.equal(run({ today: "2026-09-21" }).ready, true);
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
  const scheduled = shift({ employee_id: DREW, starts_at: at("2026-09-15", "11:00"), ends_at: at("2026-09-15", "17:00") });
  const result = run({
    shifts: [scheduled],
    punches: [punch({ employee_id: DREW, shift_id: scheduled.id, clock_in_at: at("2026-09-15", "11:00") })],
  });
  const f = only(result.findings, "1.1")[0];
  assert.equal(f.status, "needs_fix");
  assert.equal(f.severity, "error");
  assert.match(f.summary, /Sample, Drew/);
  assert.equal(result.ready, false, "no ruling can stand in for a punch with no end");
  assert.deepEqual(only(result.findings, "1.4"), [], "with a shift it is 1.1's, not 1.4's");
});

test("1.4: an open punch with NO scheduled shift is a blocker with no default, fixed upstream (ruled 2026-09-27)", () => {
  const open = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00") });
  const result = run({ punches: [open] });
  const f = only(result.findings, "1.4")[0];
  assert.equal(f.key, `1.4:punch:${open.id}`);
  assert.equal(f.status, "needs_fix");
  assert.equal(f.severity, "error");
  assert.equal(f.options, undefined, "no picker");
  assert.equal(f.defaultChoice, undefined, "no default");
  assert.equal(f.evidence.open, true);
  assert.deepEqual(f.evidence.punch_ids, [open.id]);
  assert.match(f.summary, /Sample, Drew/);
  assert.match(f.summary, /no clock-out/);
  assert.match(f.summary, /no scheduled shift/);
  assert.match(f.resolution!, /Correct the punch on the Timesheets page/);
  // 1.1 still detects it, and hands it to 1.4 like 1.2 and 1.3 do: one
  // blocker per punch, not two.
  const detected = only(result.findings, "1.1")[0];
  assert.equal(detected.status, "auto_resolved");
  assert.match(detected.resolution!, new RegExp(`1\\.4:punch:${open.id}`));
  assert.equal(result.counts.needsFix, 1);
  assert.equal(result.ready, false);
});

test("1.1: an open punch outside the window is not this window's problem", () => {
  const result = run({ punches: [punch({ employee_id: DREW, clock_in_at: at("2026-09-21", "11:00") })] });
  assert.deepEqual(only(result.findings, "1.1"), []);
});

// --- §1.2 / §1.3 / §1.4 runaway punches ------------------------------------

test("1.2: a punch over 15h is reported, and handed to 1.4", () => {
  const result = run({
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "04:00") }),
    ],
  });
  const f = only(result.findings, "1.2")[0];
  assert.match(f.summary, /17h/);
  assert.match(f.resolution ?? "", /1\.4/);
});

test("1.3: a clock-out inside 5s of the same person's next clock-in is a missed clock-out", () => {
  const closed = punch({
    employee_id: CASEY,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-09", "17:00"),
  });
  const next = punch({
    employee_id: CASEY,
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
    employee_id: CASEY,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-09", "14:00"),
  });
  const second = punch({
    employee_id: CASEY,
    clock_in_at: at("2026-09-09", "14:30"),
    clock_out_at: at("2026-09-09", "18:00"),
  });
  assert.deepEqual(only(run({ punches: [first, second] }).findings, "1.3"), []);
});

test("1.4: a runaway WITH a scheduled shift is truncated to the scheduled end by rule", () => {
  const scheduled = shift({
    employee_id: DREW,
    starts_at: at("2026-09-09", "11:00"),
    ends_at: at("2026-09-09", "19:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: DREW,
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
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "06:00") }),
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
  const runaway = punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-10", "06:00") });
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
    employee_id: DREW,
    clock_in_at: at("2026-09-09", "11:00"),
    clock_out_at: at("2026-09-10", "06:00"),
  });
  const next = punch({
    employee_id: DREW,
    clock_in_at: `2026-09-10T06:00:02-04:00`,
    clock_out_at: at("2026-09-10", "08:00"),
  });
  const findings = only(run({ punches: [runaway, next] }).findings, "1.4");
  assert.equal(findings.length, 1);
  assert.match(findings[0].summary, /> 15h and closed by the next clock-in/);
});

// --- §1.5 short punch -------------------------------------------------------

test("1.5: a punch under 25% of its scheduled shift has no default and no picker — it is fixed upstream (ruling D)", () => {
  // Casey, 2026-09-18: 2m 11s against a 7h shift, because Pat closed for
  // her. This is the only check in §1 that can make a day LONGER.
  const scheduled = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
    position: "PENN Closer",
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CASEY,
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
    employee_id: CASEY,
    starts_at: at("2026-09-18", "14:00"),
    ends_at: at("2026-09-18", "22:00"),
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CASEY,
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
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-18", "15:00"), clock_out_at: at("2026-09-18", "15:20") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.5"), []);
});

test("1.5: a short unscheduled punch that a cover GUESS joins to somebody else's shift is not a short punch", () => {
  // 2026-09-23 live run: an off-site worker with no shifts punched 2.6h, and
  // the 1.10 ladder guessed it covered a colleague's unpunched 10.5h Catering
  // shift. She was never meant to fill it; her punch is paid as punched.
  const caseysShift = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-16", "08:00"),
    ends_at: at("2026-09-16", "18:30"),
    position: "Catering",
  });
  const drewsPunch = punch({
    employee_id: DREW,
    clock_in_at: at("2026-09-16", "09:23"),
    clock_out_at: at("2026-09-16", "12:00"),
  });
  const result = run({ shifts: [caseysShift], punches: [drewsPunch] });
  const [view] = buildPunchViews({ punches: [drewsPunch], shifts: [caseysShift], shiftTypes: SHIFT_TYPES, profiles: PROFILES });
  assert.equal(view.match, "cover", "still paid as a cover");
  assert.equal(view.coverFor, "Bravo, Casey");
  assert.deepEqual(only(result.findings, "1.5"), []);
});

test("1.5: the same short punch WITH an explicit shift_id on that shift is still a short punch", () => {
  const caseysShift = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-16", "08:00"),
    ends_at: at("2026-09-16", "18:30"),
    position: "Catering",
  });
  const drewsPunch = punch({
    employee_id: DREW,
    shift_id: caseysShift.id,
    clock_in_at: at("2026-09-16", "09:23"),
    clock_out_at: at("2026-09-16", "12:00"),
  });
  const result = run({ shifts: [caseysShift], punches: [drewsPunch] });
  const f = only(result.findings, "1.5");
  assert.equal(f.length, 1);
  assert.equal(f[0].status, "needs_fix");
});

test("1.5: a short punch on the person's OWN shift with no shift_id is still a short punch", () => {
  const drewsShift = shift({
    employee_id: DREW,
    starts_at: at("2026-09-16", "08:00"),
    ends_at: at("2026-09-16", "18:30"),
  });
  const drewsPunch = punch({
    employee_id: DREW,
    clock_in_at: at("2026-09-16", "09:23"),
    clock_out_at: at("2026-09-16", "10:00"), // 37m of a 10.5h shift
  });
  const result = run({ shifts: [drewsShift], punches: [drewsPunch] });
  const f = only(result.findings, "1.5");
  assert.equal(f.length, 1);
  assert.equal(f[0].status, "needs_fix");
  const [view] = buildPunchViews({ punches: [drewsPunch], shifts: [drewsShift], shiftTypes: SHIFT_TYPES, profiles: PROFILES });
  assert.equal(view.match, "person_date", "her own shift, not a cover");
});

// --- §1.6 test punch --------------------------------------------------------

test("1.6: under 5 minutes with nothing scheduled is 0 hours, and listed", () => {
  // Jamie, 2026-09-07: 10.9 seconds.
  const result = run({
    punches: [
      punch({
        employee_id: JAMIE,
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
    employee_id: JAMIE,
    starts_at: at("2026-09-07", "10:00"),
    ends_at: at("2026-09-07", "18:00"),
  });
  const result = run({
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: JAMIE,
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
    employee_id: DREW,
    clock_in_at: at("2026-09-15", "11:00"),
    clock_out_at: at("2026-09-15", "17:00"),
  });
  const b = punch({
    employee_id: DREW,
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
      punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "17:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "17:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.7"), []);
});

test("1.7: back-to-back punches that touch do not overlap", () => {
  const result = run({
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "15:00") }),
      punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "15:00"), clock_out_at: at("2026-09-15", "20:00") }),
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
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "17:00"), clock_out_at: at("2026-09-09", "22:00") }),
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
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "15:10"), clock_out_at: at("2026-09-09", "22:00") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.8").filter((f) => f.evidence.interval), []);
});

test("1.8: a Catering punch is off-site and covers nothing", () => {
  const catering = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [catering],
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({
        employee_id: CASEY,
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
    punches: [punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00") })],
  });
  const gaps = only(result.findings, "1.8").filter((f) => f.evidence.interval);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].evidence.interval, { from: "11:00", to: "22:00" });
});

test("1.8: a closed day has nothing to cover", () => {
  // Every day closed, one punch on a Wednesday: no gaps anywhere.
  const result = run({
    punches: [punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "12:00") })],
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
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "skip");
  assert.match(f.summary, /Bravo, Casey at 6:00 PM/);
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
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "22:05") }),
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
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.match(f.summary, /before 22:00, after 9h 30m alone/);
  assert.equal(f.evidence.hours, 9.5);
  assert.deepEqual(f.evidence.notes, ["2.4 qualifying: solo tail of 4h or more, out before 22:00"]);
});

test("1.9: a short solo tail out before 22:00 within 2h of close gets NO dropdown (ruling C)", () => {
  // Out before 22:00 and within 2h of close, but alone under 4h: not eligible.
  // Drew leaves at 20:00, Casey at 20:30: 30 minutes alone.
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "20:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
});

test("1.9: more than 2h before close is eligible however short the tail", () => {
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "19:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "19:30") }),
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
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "09:00"), clock_out_at: at("2026-09-09", "12:00") }),
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "16:00"), clock_out_at: at("2026-09-09", "20:30") }),
    ],
  });
  assert.equal(only(result.findings, "1.9")[0].evidence.hours, 4.5);
});

test("1.9: a day with no closing time is judged on 2.4 alone, as the payroll sheet judges it", () => {
  // ALL_CLOSED: no close to measure 1.9's gap against.
  const long = run({
    punches: [
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  assert.equal(only(long.findings, "1.9").length, 1);
  const short = run({
    punches: [
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
  });
  assert.deepEqual(only(short.findings, "1.9"), []);
});

test("1.9: the scheduled closer is the in-store shift ending last; the manager list is managers only", () => {
  const early = shift({ employee_id: DREW, starts_at: at("2026-09-09", "11:00"), ends_at: at("2026-09-09", "17:00") });
  const close = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-09", "16:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "PENN Closer",
  });
  const event = shift({
    employee_id: PAT,
    starts_at: at("2026-09-09", "18:00"),
    ends_at: at("2026-09-09", "23:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [early, close, event],
    punches: [
      punch({ employee_id: DREW, shift_id: early.id, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "17:00") }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.deepEqual(f.scheduledCloser, { id: CASEY, name: "Bravo, Casey" });
  assert.match(f.options![1].effect, /Bravo, Casey was scheduled to close/);
  assert.deepEqual(f.candidates!.map((c) => c.id), [PAT, DREW]);
  assert.deepEqual(f.evidence.shift_ids, [close.id]);
});

function earlyCloseNight(rulings: RulingRow[] = [], submittal: SubmittalRow | null = null) {
  return run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    rulings,
    submittal,
  });
}

test("1.9: a manager who changes the dropdown to pay themselves is flagged, not refused", () => {
  const result = earlyCloseNight([
    {
      check_id: "1.9",
      finding_key: "1.9:2026-09-09",
      choice: "unpunched_manager",
      payee_id: PAT,
      decided_by: PAT,
      decided_at: at("2026-09-21", "10:00"),
    },
  ]);
  const f = only(result.findings, "1.9")[0];
  assert.deepEqual(f.effective, {
    choice: "unpunched_manager",
    payee: { id: PAT, name: "Example, Pat" },
    source: "recorded",
  });
  assert.equal(f.flags!.length, 1);
  assert.match(result.flags[0].message, /Example, Pat set this night's dropdown to pay themselves/);
  assert.equal(result.ready, true);
});

test("1.9: another manager paying her is not a flag", () => {
  const result = earlyCloseNight([
    { check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "unpunched_manager", payee_id: PAT, decided_by: DREW },
  ]);
  assert.deepEqual(result.flags, []);
});

// --- one submittal per run ---------------------------------------------------

test("submittal: none recorded is not submitted", () => {
  assert.equal(earlyCloseNight().submittalState, "not_submitted");
});

test("submittal: once given it stands, and it is final", () => {
  const result = earlyCloseNight(
    [{ check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "skip", decided_by: DREW, decided_at: at("2026-09-21", "10:00") }],
    { submitted_by: DREW, submitted_at: at("2026-09-21", "12:00") },
  );
  assert.equal(result.submittalState, "submitted");
  assert.deepEqual(result.submittal, { submitted_by: DREW, submitted_at: at("2026-09-21", "12:00") });
});

test("submittal: there is no stale state — a later timestamp on a choice does not reopen the run", () => {
  // The database refuses such a change (migration 27); even if one got through,
  // the submittal is final and the app does not invite submitting again.
  const result = earlyCloseNight(
    [{ check_id: "1.9", finding_key: "1.9:2026-09-09", choice: "skip", decided_by: DREW, decided_at: at("2026-09-21", "13:00") }],
    { submitted_by: DREW, submitted_at: at("2026-09-21", "12:00") },
  );
  assert.equal(result.submittalState, "submitted");
});

test("submittal: every choice in the submitted run is locked", () => {
  const result = earlyCloseNight([], { submitted_by: DREW, submitted_at: at("2026-09-21", "12:00") });
  const cases = result.findings.filter((f) => f.status === "needs_ruling");
  assert.ok(cases.length > 0);
  for (const f of cases) assert.equal(f.lockedBy, WINDOW.end, f.key);
});

test("submittal: nothing is locked before the run is submitted", () => {
  for (const f of earlyCloseNight().findings.filter((x) => x.status === "needs_ruling")) assert.equal(f.lockedBy, null);
});

test("submittal: a night inside a neighbouring submitted run is locked by that run", () => {
  // The schedule asks about the window ending a week later than the submitted
  // one; the 09-09 night still belongs to the run ending 09-20.
  const result = run({
    ...WED_ONLY,
    punches: [
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    otherSubmittals: [
      { window_end: "2026-09-13", submitted_by: DREW, submitted_at: at("2026-09-14", "12:00") },
      { window_end: undefined, submitted_by: DREW, submitted_at: at("2026-09-14", "12:00") },
    ],
  });
  assert.equal(only(result.findings, "1.9")[0].lockedBy, "2026-09-13");
  assert.equal(result.submittalState, "not_submitted");
});

test("submittal: the 3.7 case is dated by its window's last day", () => {
  const f = { check: "3.7", evidence: {} } as unknown as Finding;
  assert.equal(caseDate(f, WINDOW), WINDOW.end);
  assert.equal(caseDate({ check: "3.5", evidence: {} } as unknown as Finding, WINDOW), null);
  assert.equal(caseDate({ check: "1.9", evidence: { date: "2026-09-09" } } as unknown as Finding, WINDOW), "2026-09-09");
});

test("submittal: a run's lock covers exactly its fourteen days", () => {
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
    employee_id: CASEY,
    starts_at: at("2026-09-09", "18:00"),
    ends_at: at("2026-09-09", "22:00"),
    position: "Catering",
    deal_id: 25188,
  });
  const result = run({
    ...WED_ONLY,
    shifts: [catering],
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
      punch({
        employee_id: CASEY,
        shift_id: catering.id,
        clock_in_at: at("2026-09-09", "18:00"),
        clock_out_at: at("2026-09-09", "22:00"),
      }),
    ],
  });
  const f = only(result.findings, "1.9")[0];
  assert.match(f.summary, /Sample, Drew at 6:00 PM/);
});

// --- §1.10 cover matching (no longer a finding) ---------------------------
//
// The ladder still decides which shift a blank-shift_id punch was worked
// against, because 1.4, 1.5, 1.6, 1.8 and 1.9 read it. It is just not shown.

function views(shifts: ShiftRow[], punches: PunchRow[]) {
  return buildPunchViews({ punches, shifts, shiftTypes: SHIFT_TYPES, profiles: PROFILES });
}

test("1.10: a blank shift_id joins to that person's own shift that day first", () => {
  const own = shift({
    employee_id: DREW,
    starts_at: at("2026-09-15", "11:00"),
    ends_at: at("2026-09-15", "19:00"),
    position: "PENN Opener",
  });
  const p = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:02"), clock_out_at: at("2026-09-15", "19:05") });
  const [v] = views([own], [p]);
  assert.equal(v.match, "person_date");
  assert.equal(v.shift?.id, own.id);
});

test("1.10: with no shift of their own, the punch joins an unworked shift that brackets it, and names the swap", () => {
  // Nine of nine blank punches in the 2026-09-23 window were covers, and
  // person+date found none of them.
  const caseysShift = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-15", "15:00"),
    ends_at: at("2026-09-15", "22:00"),
    position: "PENN Closer",
  });
  const p = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "15:05"), clock_out_at: at("2026-09-15", "22:10") });
  const [v] = views([caseysShift], [p]);
  assert.equal(v.match, "cover");
  assert.equal(v.coverFor, "Bravo, Casey");
  assert.equal(v.shift?.id, caseysShift.id);
});

test("1.10: a shift its own person punched is not available to be covered", () => {
  const caseysShift = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-15", "15:00"),
    ends_at: at("2026-09-15", "22:00"),
    position: "PENN Closer",
  });
  const caseys = punch({
    employee_id: CASEY,
    shift_id: caseysShift.id,
    clock_in_at: at("2026-09-15", "15:00"),
    clock_out_at: at("2026-09-15", "22:00"),
  });
  const drews = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "15:05"), clock_out_at: at("2026-09-15", "22:10") });
  const drew = views([caseysShift], [caseys, drews]).find((v) => v.row.id === drews.id)!;
  assert.equal(drew.match, "none");
  assert.equal(drew.shift, null);
});

test("1.10: a punch with no shift anywhere is left unscheduled, and is paid as punched", () => {
  const p = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00"), clock_out_at: at("2026-09-15", "14:00") });
  const [v] = views([], [p]);
  assert.equal(v.match, "none");
  const result = run({ punches: [p] });
  assert.equal(result.findings.length, 0, "a 3h punch with no shift needs nothing");
  assert.equal(result.ready, true);
});

// --- §1.11 / §1.12 catering -------------------------------------------------

test("1.11: a Catering shift with no deal is flagged, and does not block payroll", () => {
  // "flag at scheduling time, not payroll time" — shift 334, Pat 09-09.
  const orphan = shift({
    employee_id: PAT,
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
  // Example Nonprofit 2026-09-19: 1 of 3.
  const deal: DealRow = { id: 25390, event_date: "2026-09-19", staff_count: 3, company: "Example Nonprofit" };
  const crewShift = shift({
    employee_id: CASEY,
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
        employee_id: CASEY,
        shift_id: crewShift.id,
        clock_in_at: at("2026-09-19", "16:00"),
        clock_out_at: at("2026-09-19", "21:00"),
      }),
    ],
  });
  const f = only(result.findings, "1.12")[0];
  assert.match(f.summary, /Example Nonprofit/);
  assert.match(f.summary, /1 of 3 crew punched/);
  assert.equal(f.status, "auto_resolved");
});

test("1.12: a fully punched event says nothing", () => {
  const deal: DealRow = { id: 25390, event_date: "2026-09-19", staff_count: 1, company: "Example Nonprofit" };
  const crewShift = shift({
    employee_id: CASEY,
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
        employee_id: CASEY,
        shift_id: crewShift.id,
        clock_in_at: at("2026-09-19", "16:00"),
        clock_out_at: at("2026-09-19", "21:00"),
      }),
    ],
  });
  assert.deepEqual(only(result.findings, "1.12"), []);
});

test("1.12: crew punched counts punches, not the schedule; a manual overlapping punch counts (ruled 2026-09-27)", () => {
  const deal: DealRow = { id: 25390, event_date: "2026-09-19", staff_count: 2, company: "Example Nonprofit" };
  const caseyShift = shift({ employee_id: CASEY, starts_at: at("2026-09-19", "16:00"), ends_at: at("2026-09-19", "21:00"), position: "Catering", deal_id: deal.id });
  const drewShift = shift({ employee_id: DREW, starts_at: at("2026-09-19", "16:00"), ends_at: at("2026-09-19", "21:00"), position: "Catering", deal_id: deal.id });
  const result = run({
    deals: [deal],
    shifts: [caseyShift, drewShift],
    punches: [
      // Casey forgot to pick the shift and punched by hand, during it.
      punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-19", "16:05"), clock_out_at: at("2026-09-19", "21:00") }),
    ],
  });
  const found = only(result.findings, "1.12");
  assert.deepEqual(found.map((f) => f.key), ["1.12:deal:25390", `1.12:unpunched:deal:25390:${DREW}`]);
  assert.match(found[0].summary, /1 of 2 crew punched/);
  assert.match(found[1].summary, /Sample, Drew/);
  assert.match(found[1].summary, /Example Nonprofit/);
  assert.ok(found.every((f) => f.status === "auto_resolved"));
});

test("1.12: a cover punch with no shift_id is not crew for the event it happened to overlap", () => {
  // Jamie was scheduled and did not come; Casey punched by hand during his
  // hours. The cover ladder (1.10) pays her hours, but she did not punch FOR
  // the event, so she is not its crew.
  const deal: DealRow = { id: 25391, event_date: "2026-09-19", staff_count: 1, company: "Example College" };
  const jamieShift = shift({ employee_id: JAMIE, starts_at: at("2026-09-19", "16:00"), ends_at: at("2026-09-19", "21:00"), position: "Catering", deal_id: deal.id });
  const result = run({
    deals: [deal],
    shifts: [jamieShift],
    punches: [punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-19", "16:00"), clock_out_at: at("2026-09-19", "21:00") })],
  });
  const found = only(result.findings, "1.12");
  assert.match(found[0].summary, /0 of 1 crew punched/);
  assert.equal(found[1].key, `1.12:unpunched:deal:25391:${JAMIE}`);
});

// --- §1.15 changes to a submitted run ---------------------------------------
//
// Ruled 2026-09-27: writes to time_entries and shifts are NEVER blocked (the
// clock-in path must not fail, and Withers-time closes a forgotten clock-out
// at the next clock-in, which can edit a punch in a submitted period). The
// next period's verifier reports every such change instead.

const NEXT: PayWindow = (() => {
  const r = payWindowEnding("2026-10-04");
  if (!r.ok) throw new Error(r.error);
  return r.window;
})();

const SUBMITTED_0920 = { window_end: "2026-09-20", submitted_by: PAT, submitted_at: at("2026-09-21", "12:00") };

function audit(over: Partial<AuditRow> & Pick<AuditRow, "id" | "table_name" | "op" | "at">): AuditRow {
  return { row_id: null, actor_uid: null, actor_role: null, db_role: "authenticated", before_image: null, after_image: null, ...over };
}

test("1.15: the auto-close of a forgotten clock-out in a submitted run is reported to the next run", () => {
  const autoClose = audit({
    id: 70,
    table_name: "time_entries",
    row_id: 1290,
    op: "UPDATE",
    at: at("2026-09-22", "10:02"),
    actor_uid: CASEY,
    actor_role: "authenticated",
    before_image: { id: 1290, employee_id: CASEY, clock_in_at: at("2026-09-20", "17:00"), clock_out_at: null },
    after_image: { id: 1290, employee_id: CASEY, clock_in_at: at("2026-09-20", "17:00"), clock_out_at: at("2026-09-22", "10:02") },
  });
  const result = run({ window: NEXT, today: "2026-10-05", priorSubmittals: [SUBMITTED_0920], auditChanges: [autoClose] });
  const f = only(result.findings, "1.15")[0];
  assert.ok(f, "reported");
  assert.equal(f.key, "1.15:audit:70");
  assert.equal(f.status, "auto_resolved", "never blocks");
  assert.equal(f.severity, "warn");
  assert.match(f.summary, /punch 1290/);
  assert.match(f.summary, /Bravo, Casey/, "the person");
  assert.match(f.summary, /was changed \(clock_out_at\) by Bravo, Casey on Tue Sep 22/, "what changed, who changed it, when");
  assert.match(f.summary, /run ending 2026-09-20/);
  assert.deepEqual(f.evidence.punch_ids, [1290]);
  assert.equal(f.evidence.date, "2026-09-20");
  assert.equal(result.ready, true);
});

test("1.15: a shift added to, or deleted from, a submitted run is reported, naming who", () => {
  const added = audit({
    id: 71,
    table_name: "shifts",
    row_id: 400,
    op: "INSERT",
    at: at("2026-09-23", "09:00"),
    actor_role: "service_role",
    db_role: "service_role",
    after_image: { id: 400, employee_id: DREW, starts_at: at("2026-09-19", "12:00"), ends_at: at("2026-09-19", "18:00") },
  });
  const deleted = audit({
    id: 72,
    table_name: "time_entries",
    row_id: 1280,
    op: "DELETE",
    at: at("2026-09-24", "15:00"),
    actor_uid: PAT,
    actor_role: "authenticated",
    before_image: { id: 1280, employee_id: JAMIE, clock_in_at: at("2026-09-10", "10:00"), clock_out_at: at("2026-09-10", "16:00") },
  });
  const result = run({ window: NEXT, today: "2026-10-05", priorSubmittals: [SUBMITTED_0920], auditChanges: [added, deleted] });
  const [first, second] = only(result.findings, "1.15");
  assert.match(first.summary, /shift 400 for Sample, Drew/);
  assert.match(first.summary, /added by the service_role key/);
  assert.deepEqual(first.evidence.shift_ids, [400]);
  assert.match(second.summary, /punch 1280 for Tester, Jamie/);
  assert.match(second.summary, /deleted by Example, Pat/);
});

test("1.15: a change made before the run was submitted, or to a row outside it, is not reported", () => {
  const beforeSubmittal = audit({
    id: 73,
    table_name: "time_entries",
    row_id: 1291,
    op: "UPDATE",
    at: at("2026-09-21", "11:59"),
    actor_uid: PAT,
    before_image: { id: 1291, employee_id: CASEY, clock_in_at: at("2026-09-18", "11:00") },
    after_image: { id: 1291, employee_id: CASEY, clock_in_at: at("2026-09-18", "11:30") },
  });
  const thisPeriod = audit({
    id: 74,
    table_name: "time_entries",
    row_id: 1300,
    op: "INSERT",
    at: at("2026-09-22", "11:00"),
    actor_uid: CASEY,
    after_image: { id: 1300, employee_id: CASEY, clock_in_at: at("2026-09-22", "11:00") },
  });
  const result = run({
    window: NEXT,
    today: "2026-10-05",
    priorSubmittals: [SUBMITTED_0920],
    auditChanges: [beforeSubmittal, thisPeriod],
  });
  assert.deepEqual(only(result.findings, "1.15"), []);
});

test("1.15: a punch moved out of a submitted run is reported by the day it left", () => {
  const moved = audit({
    id: 75,
    table_name: "time_entries",
    row_id: 1292,
    op: "UPDATE",
    at: at("2026-09-25", "09:00"),
    actor_uid: DREW,
    before_image: { id: 1292, employee_id: CASEY, clock_in_at: at("2026-09-20", "11:00") },
    after_image: { id: 1292, employee_id: CASEY, clock_in_at: at("2026-09-21", "11:00") },
  });
  const f = only(run({ window: NEXT, today: "2026-10-05", priorSubmittals: [SUBMITTED_0920], auditChanges: [moved] }).findings, "1.15");
  assert.equal(f.length, 1);
  assert.equal(f[0].evidence.date, "2026-09-20");
});

test("1.15: with no submitted run before the window there is nothing to report", () => {
  const change = audit({
    id: 76,
    table_name: "time_entries",
    row_id: 1293,
    op: "DELETE",
    at: at("2026-09-25", "09:00"),
    before_image: { id: 1293, employee_id: CASEY, clock_in_at: at("2026-09-20", "11:00") },
  });
  assert.deepEqual(only(run({ window: NEXT, today: "2026-10-05", auditChanges: [change] }).findings, "1.15"), []);
});

test("1.15: a change already reported to the run before this one is not reported again", () => {
  // Runs ending 09-06 and 09-20 are both submitted. A change to the 09-06 run
  // made before the 09-20 run was submitted belonged to that run's report.
  const older = { window_end: "2026-09-06", submitted_by: PAT, submitted_at: at("2026-09-07", "12:00") };
  const early = audit({
    id: 77,
    table_name: "time_entries",
    row_id: 1100,
    op: "DELETE",
    at: at("2026-09-15", "09:00"),
    before_image: { id: 1100, employee_id: CASEY, clock_in_at: at("2026-09-01", "11:00") },
  });
  const late = audit({
    id: 78,
    table_name: "time_entries",
    row_id: 1101,
    op: "DELETE",
    at: at("2026-09-22", "09:00"),
    before_image: { id: 1101, employee_id: CASEY, clock_in_at: at("2026-09-01", "11:00") },
  });
  const result = run({
    window: NEXT,
    today: "2026-10-05",
    priorSubmittals: [older, SUBMITTED_0920],
    auditChanges: [early, late],
  });
  assert.deepEqual(only(result.findings, "1.15").map((f) => f.key), ["1.15:audit:78"]);
});

test("1.15: once this run is submitted, later changes belong to the run after it", () => {
  const change = audit({
    id: 79,
    table_name: "time_entries",
    row_id: 1294,
    op: "DELETE",
    at: at("2026-10-06", "09:00"),
    before_image: { id: 1294, employee_id: CASEY, clock_in_at: at("2026-09-20", "11:00") },
  });
  const result = run({
    window: NEXT,
    today: "2026-10-06",
    priorSubmittals: [SUBMITTED_0920],
    submittal: { window_end: "2026-10-04", submitted_by: PAT, submitted_at: at("2026-10-05", "12:00") },
    auditChanges: [change],
  });
  assert.deepEqual(only(result.findings, "1.15"), []);
});

// --- §3.5 crewless catering event -------------------------------------------

const CONSULTING: DealRow = { id: 25100, event_date: "2026-09-09", staff_count: 2, company: "Example Consulting", stage: "Booked Paid" };

test("3.4: an invoice tip with no deal, from any point in history, is a flag and never a block (ruling A)", () => {
  const result = run({
    unmatchedTips: [
      { id: 41, deal_id: null, payer: "Nobody Known", tip_cents: 2500, paid_date: "2025-11-03", event_date: null, status: "held", released_in_run: null },
      { id: 42, deal_id: null, payer: null, tip_cents: 1000, paid_date: "2026-09-03", event_date: null, status: "held", released_in_run: null, note: "no invoice title" },
      // Defensive: a row that does carry a deal is not unmatched.
      { id: 43, deal_id: 25188, payer: "Bo Sampleton", tip_cents: 10000, paid_date: "2026-09-02", event_date: "2026-09-19", status: "held", released_in_run: null },
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

test("3.5: a booked event with nobody on it gets a picker, default Pat, and the upstream warning", () => {
  const result = run({ windowDeals: [CONSULTING] });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.key, "3.5:deal:25100");
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "staff");
  // "Example, Pat" on file is the ruled default "Pat Example".
  assert.deepEqual(f.defaultPayee, { id: PAT, name: "Example, Pat" });
  assert.match(f.summary, /Add the event's Catering shift/);
  assert.deepEqual(f.candidates!.map((c) => c.id), [CASEY, PAT, DREW]);
  assert.equal(result.ready, true, "the default stands on its own");
});

// --- §3.5 crew = a punch (Alina, 2026-09-27) --------------------------------
//
// "if Pat doesn't clock in when she's also helping on that catering event,
// that's on her. It needs to require a punch." A person is on an event's crew
// only if they punched for it: a punch on the event's Catering shift by
// shift_id, or a manual punch (no shift_id) by the scheduled person on the same
// date that overlaps the shift. Scheduled without a punch is not crew.

/** Example Consulting's Catering shift, 2026-09-09 15:00-18:00, Casey scheduled. */
function consultingShift(over: Partial<ShiftRow> = {}): ShiftRow {
  return shift({
    employee_id: CASEY,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "18:00"),
    position: "Catering",
    deal_id: 25100,
    ...over,
  });
}

test("3.5: a punch on the event's Catering shift by shift_id makes a crew", () => {
  const s = consultingShift();
  const p = punch({ employee_id: CASEY, shift_id: s.id, clock_in_at: at("2026-09-09", "15:02"), clock_out_at: at("2026-09-09", "18:00") });
  const result = run({ windowDeals: [CONSULTING], shifts: [s], punches: [p] });
  assert.deepEqual(only(result.findings, "3.5"), []);
  assert.deepEqual(only(result.findings, "1.12").filter((f) => f.key.startsWith("1.12:unpunched")), []);
  const crew = eventCrew(CONSULTING, [s], [p]);
  assert.deepEqual([...crew.crew.keys()], [CASEY]);
  assert.deepEqual(crew.crew.get(CASEY), [p.id]);
});

test("3.5: a manual punch (no shift_id) by the scheduled person, same date, overlapping the shift, makes a crew", () => {
  const s = consultingShift();
  const manual = punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-09", "16:30"), clock_out_at: at("2026-09-09", "19:00") });
  assert.deepEqual(only(run({ windowDeals: [CONSULTING], shifts: [s], punches: [manual] }).findings, "3.5"), []);
});

test("3.5: an open manual punch that clocked in during the shift makes a crew", () => {
  const s = consultingShift();
  const open = punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-09", "15:10"), clock_out_at: null });
  assert.deepEqual([...eventCrew(CONSULTING, [s], [open]).crew.keys()], [CASEY]);
});

test("3.5: scheduled on the event with no punch is not crew: crewless, and the person is named (ruled 2026-09-27)", () => {
  // Pat is scheduled on the event and never clocks in.
  const s = consultingShift({ employee_id: PAT });
  const result = run({ windowDeals: [CONSULTING], shifts: [s] });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.key, "3.5:deal:25100");
  assert.equal(f.status, "needs_ruling");
  assert.equal(f.defaultChoice, "staff");
  assert.deepEqual(f.defaultPayee, { id: PAT, name: "Example, Pat" });
  assert.match(f.summary, /nobody punched/);
  assert.match(f.summary, /Example, Pat/);

  const unpunched = only(result.findings, "1.12").filter((x) => x.key.startsWith("1.12:unpunched"));
  assert.equal(unpunched.length, 1);
  assert.equal(unpunched[0].key, `1.12:unpunched:deal:25100:${PAT}`);
  assert.equal(unpunched[0].status, "auto_resolved", "never blocks");
  assert.match(unpunched[0].summary, /Example, Pat/);
  assert.match(unpunched[0].summary, /Example Consulting/);
  assert.equal(unpunched[0].evidence.employee_id, PAT);
  assert.equal(unpunched[0].evidence.deal_id, 25100);
  assert.deepEqual(unpunched[0].evidence.shift_ids, [s.id]);
  assert.equal(result.ready, true, "the default stands and the finding does not block");
});

test("3.5: a manual punch by the scheduled person that does not overlap the shift is not crew", () => {
  // Casey worked the counter that morning; the event was the afternoon.
  const s = consultingShift();
  const morning = punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-09", "09:00"), clock_out_at: at("2026-09-09", "15:00") });
  const result = run({ windowDeals: [CONSULTING], shifts: [s], punches: [morning] });
  assert.equal(only(result.findings, "3.5").length, 1);
  assert.equal(only(result.findings, "1.12").filter((f) => f.key === `1.12:unpunched:deal:25100:${CASEY}`).length, 1);
});

test("3.5: a manual punch on another date, or by somebody not scheduled, is not crew", () => {
  const s = consultingShift();
  const dayBefore = punch({ employee_id: CASEY, shift_id: null, clock_in_at: at("2026-09-08", "15:00"), clock_out_at: at("2026-09-08", "18:00") });
  const stranger = punch({ employee_id: DREW, shift_id: null, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") });
  assert.equal(eventCrew(CONSULTING, [s], [dayBefore, stranger]).crew.size, 0);
});

test("3.5: a punch with a shift_id for some other shift is not a manual punch", () => {
  const s = consultingShift();
  const counter = shift({ employee_id: CASEY, starts_at: at("2026-09-09", "14:00"), ends_at: at("2026-09-09", "17:00"), position: "PENN Opener" });
  const p = punch({ employee_id: CASEY, shift_id: counter.id, clock_in_at: at("2026-09-09", "14:00"), clock_out_at: at("2026-09-09", "17:00") });
  assert.equal(eventCrew(CONSULTING, [s, counter], [p]).crew.size, 0);
});

test("3.5: somebody who punched the event's shift by shift_id is crew; the scheduled person who did not is named", () => {
  const s = consultingShift({ employee_id: PAT });
  const cover = punch({ employee_id: CASEY, shift_id: s.id, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") });
  const result = run({ windowDeals: [CONSULTING], shifts: [s], punches: [cover] });
  assert.deepEqual(only(result.findings, "3.5"), []);
  assert.deepEqual(
    only(result.findings, "1.12").filter((f) => f.key.startsWith("1.12:unpunched")).map((f) => f.key),
    [`1.12:unpunched:deal:25100:${PAT}`],
  );
});

test("3.5: the event's shifts are the ones linked to the deal; failing that, Catering shifts on the event date", () => {
  // Linked, on a different day from the event: still the event's shift.
  const linked = consultingShift({ starts_at: at("2026-09-08", "15:00"), ends_at: at("2026-09-08", "18:00") });
  const linkedPunch = punch({ employee_id: CASEY, shift_id: linked.id, clock_in_at: at("2026-09-08", "15:00"), clock_out_at: at("2026-09-08", "18:00") });
  assert.deepEqual(only(run({ windowDeals: [CONSULTING], shifts: [linked], punches: [linkedPunch] }).findings, "3.5"), []);

  // No linked shift: a Catering shift on the event date stands in (as the
  // payroll sheet's tips.event_crew does), but only once somebody punches it.
  const sameDay = consultingShift({ deal_id: null });
  const sameDayPunch = punch({ employee_id: CASEY, shift_id: sameDay.id, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") });
  assert.deepEqual(only(run({ windowDeals: [CONSULTING], shifts: [sameDay], punches: [sameDayPunch] }).findings, "3.5"), []);
  assert.equal(only(run({ windowDeals: [CONSULTING], shifts: [sameDay] }).findings, "3.5").length, 1);

  // A linked shift exists: a same-day shift for something else is not this event's.
  const other = consultingShift({ employee_id: DREW, deal_id: null });
  const otherPunch = punch({ employee_id: DREW, shift_id: other.id, clock_in_at: at("2026-09-09", "15:00"), clock_out_at: at("2026-09-09", "18:00") });
  const crew = eventCrew(CONSULTING, [consultingShift(), other], [otherPunch]);
  assert.equal(crew.crew.size, 0);
  assert.deepEqual(crew.unpunched.map((u) => u.employeeId), [CASEY]);
});

test("3.5: an unassigned Catering shift is not a crew", () => {
  const open = shift({
    employee_id: null,
    starts_at: at("2026-09-09", "15:00"),
    ends_at: at("2026-09-09", "18:00"),
    position: "Catering",
    deal_id: 25100,
  });
  assert.equal(only(run({ windowDeals: [CONSULTING], shifts: [open] }).findings, "3.5").length, 1);
});

test("3.5: a lost deal, or one outside the window, is not asked about", () => {
  const lost = { ...CONSULTING, stage: "Closed Lost" };
  const later = { ...CONSULTING, event_date: "2026-10-05" };
  const unnamed = { ...CONSULTING, id: 25101, company: null, stage: null };
  assert.deepEqual(only(run({ windowDeals: [lost, later] }).findings, "3.5"), []);
  assert.match(only(run({ windowDeals: [unnamed] }).findings, "3.5")[0].summary, /deal 25101/);
});

test("3.5: a crewless tip paid to the person who submits the run is flagged, default or not", () => {
  const submittal = { submitted_by: PAT, submitted_at: at("2026-09-21", "12:00") };
  const byDefault = run({ windowDeals: [CONSULTING], submittal });
  assert.match(byDefault.flags[0].message, /Paid to Example, Pat, who submitted this run/);

  const picked = run({
    windowDeals: [CONSULTING],
    submittal,
    rulings: [{ check_id: "3.5", finding_key: "3.5:deal:25100", choice: "staff", payee_id: CASEY, decided_by: PAT }],
  });
  assert.deepEqual(picked.flags, []);
  assert.equal(only(picked.findings, "3.5")[0].effective?.payee?.id, CASEY);
});

test("3.5: with nobody on file matching the default, the case must be answered", () => {
  const result = run({ windowDeals: [CONSULTING], profiles: PROFILES.filter((p) => p.id !== PAT) });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.defaultPayee, null);
  assert.equal(result.ready, false);
});

test("3.5: with no name passed in, the default is the one production is configured with", () => {
  // Production never sets defaultTipPayeeName; every other test here does. The
  // profile is named by the constant, not a literal, so no real person is
  // written into this file.
  const configured = "55555555-5555-5555-5555-555555555555";
  const profiles: ProfileRow[] = [
    ...PROFILES,
    { id: configured, full_name: DEFAULT_TIP_PAYEE_NAME, active: true, role: "manager", qbo_employee_id: "13" },
  ];
  const f = only(run({ windowDeals: [CONSULTING], profiles, defaultTipPayeeName: undefined }).findings, "3.5")[0];
  assert.equal(f.defaultPayee?.id, configured);
});

// --- everyone punches (Alina, 2026-10-05) ---------------------------------
//
// The designated tip payee's last day was 2026-10-04 and "everyone should be
// punching". From the period starting CREW_PUNCH_REQUIRED_FROM, a catering
// event whose scheduled crew did not punch, or that has no crew, is a fix
// with no default, like 1.5: there is no crewless-tip payee and no "scheduled
// but not crew" warning any more. Periods before it keep the old rules, so the
// 09-21..10-04 run is paid exactly as it was.

const FIRST_NEW: PayWindow = (() => {
  const r = payWindowEnding("2026-10-18");
  if (!r.ok) throw new Error(r.error);
  return r.window;
})();

/** A booked event inside FIRST_NEW. */
const GALA: DealRow = { id: 25300, event_date: "2026-10-07", staff_count: 2, company: "Example Gala", stage: "Booked Paid" };

function galaShift(employeeId: string): ShiftRow {
  return shift({
    employee_id: employeeId,
    starts_at: at("2026-10-07", "15:00"),
    ends_at: at("2026-10-07", "18:00"),
    position: "Catering",
    deal_id: GALA.id,
  });
}

function runAfter(over: Partial<VerifyInput> = {}) {
  return run({ window: FIRST_NEW, today: "2026-10-19", windowDeals: [GALA], ...over });
}

test("everyone punches: the cutover is one date, and it is the period starting 2026-10-05", () => {
  assert.equal(CREW_PUNCH_REQUIRED_FROM, "2026-10-05");
  assert.equal(FIRST_NEW.start, CREW_PUNCH_REQUIRED_FROM);
});

test("everyone punches: an event with no crew on the schedule is a fix, with no default payee and no picker", () => {
  const result = runAfter();
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.key, "3.5:deal:25300");
  assert.equal(f.status, "needs_fix");
  assert.equal(f.severity, "error");
  assert.equal(f.defaultChoice, undefined);
  assert.equal(f.options, undefined);
  assert.equal(f.candidates, undefined);
  assert.equal(f.defaultPayee, undefined);
  assert.equal(f.effective, undefined);
  assert.match(f.summary, /Example Gala/);
  assert.match(f.resolution ?? "", /Catering shift/);
  assert.equal(result.counts.needsFix, 1);
  assert.equal(result.counts.needsRuling, 0);
  assert.equal(result.ready, false);
});

// Ruled 2026-10-05: from the cutover, 1.12 and 3.5 are ONE card per event,
// "crew didn't punch". Crew is a punch on the event's Catering shift; once the
// punch exists the tip splits by punches, so there is no payee to choose. The
// card lists each scheduled person with no punch, each with its add-punch form.

test("crew didn't punch: an event whose crew partly punched is one card, naming who did not, with their form", () => {
  const casey = galaShift(CASEY);
  const pat = galaShift(PAT);
  const caseyPunch = punch({ employee_id: CASEY, shift_id: casey.id, clock_in_at: at("2026-10-07", "15:00"), clock_out_at: at("2026-10-07", "18:00") });
  const result = runAfter({ shifts: [casey, pat], punches: [caseyPunch] });
  assert.deepEqual(only(result.findings, "1.12"), [], "no per-event count line and no per-person line: one card");
  const cards = only(result.findings, "3.5");
  assert.deepEqual(cards.map((f) => [f.key, f.status, f.severity]), [["3.5:deal:25300", "needs_fix", "error"]]);
  const f = cards[0];
  assert.equal(f.title, "Catering crew didn't punch");
  assert.match(f.summary, /Example Gala/);
  assert.match(f.summary, /1 of 2 crew punched/);
  assert.match(f.summary, /Example, Pat/);
  assert.doesNotMatch(f.summary, /Bravo, Casey/);
  assert.equal(f.defaultChoice, undefined);
  assert.equal(f.candidates, undefined);
  assert.equal(f.fix, undefined);
  assert.deepEqual(f.fixes, [
    {
      kind: "add",
      label: "Add Example, Pat's punch",
      date: "2026-10-07",
      employee_id: PAT,
      shift_id: pat.id,
      clock_in: "2026-10-07T15:00",
      clock_out: "2026-10-07T18:00",
      shifts: [
        { id: casey.id, label: "Bravo, Casey · Catering 3:00 PM–6:00 PM" },
        { id: pat.id, label: "Example, Pat · Catering 3:00 PM–6:00 PM" },
      ],
    },
  ]);
  assert.equal(result.counts.needsFix, 1);
  assert.equal(result.ready, false);
});

test("crew didn't punch: an event nobody on its schedule punched is one card with a form per person", () => {
  const casey = galaShift(CASEY);
  const pat = galaShift(PAT);
  const result = runAfter({ shifts: [casey, pat] });
  assert.deepEqual(only(result.findings, "1.12"), []);
  const cards = only(result.findings, "3.5");
  assert.equal(cards.length, 1);
  assert.match(cards[0].summary, /0 of 2 crew punched/);
  assert.deepEqual(cards[0].fixes!.map((x) => x.kind === "add" && [x.employee_id, x.shift_id]), [
    [CASEY, casey.id],
    [PAT, pat.id],
  ]);
  assert.equal(result.counts.needsFix, 1, "one card, counted once");
});

test("crew didn't punch: an event with no Catering shift has a form that creates the shift and the punch", () => {
  const f = only(runAfter().findings, "3.5")[0];
  assert.deepEqual(f.fixes, [{ kind: "event_shift", deal_id: 25300, date: "2026-10-07", event: "Example Gala" }]);
});

test("crew didn't punch: an unassigned Catering slot on the event prefills the new punch's times", () => {
  const slot = shift({
    employee_id: null,
    starts_at: at("2026-10-07", "14:00"),
    ends_at: at("2026-10-07", "18:30"),
    position: "Catering",
    deal_id: GALA.id,
  });
  const f = only(runAfter({ shifts: [slot] }).findings, "3.5")[0];
  assert.deepEqual(f.fixes, [
    {
      kind: "event_shift",
      deal_id: 25300,
      date: "2026-10-07",
      event: "Example Gala",
      clock_in: "2026-10-07T14:00",
      clock_out: "2026-10-07T18:30",
    },
  ]);
});

test("crew didn't punch: a crew smaller than staff_count, with nobody scheduled unpunched, is no card", () => {
  // staff_count 2, one person scheduled and punched. The crew is who punched;
  // there is nobody to add, so nothing to fix and no count line either.
  const casey = galaShift(CASEY);
  const result = runAfter({
    deals: [GALA],
    shifts: [casey],
    punches: [punch({ employee_id: CASEY, shift_id: casey.id, clock_in_at: at("2026-10-07", "15:00"), clock_out_at: at("2026-10-07", "18:00") })],
  });
  assert.deepEqual(only(result.findings, "1.12"), []);
  assert.deepEqual(only(result.findings, "3.5"), []);
  assert.equal(result.ready, true);
});

test("crew didn't punch: a deal the window's shifts point at is checked even when it is not a booked event", () => {
  const lunch: DealRow = { id: 25310, event_date: "2026-10-08", staff_count: 1, company: "Example Lunch", stage: "Sent Quote" };
  const s = shift({ employee_id: CASEY, starts_at: at("2026-10-08", "11:00"), ends_at: at("2026-10-08", "13:00"), position: "Catering", deal_id: lunch.id });
  const result = runAfter({ windowDeals: [], deals: [lunch], shifts: [s] });
  assert.deepEqual(only(result.findings, "3.5").map((f) => [f.key, f.status]), [["3.5:deal:25310", "needs_fix"]]);
});

test("crew didn't punch: the group carries the merged card's title and rule", () => {
  const g = runAfter().groups.find((x) => x.check === "3.5")!;
  assert.equal(g.title, "Catering crew didn't punch");
  assert.match(g.rule, /one card per event/i);
});

test("everyone punches: adding the missing punch clears the fix", () => {
  const pat = galaShift(PAT);
  const added = punch({ employee_id: PAT, shift_id: pat.id, clock_in_at: at("2026-10-07", "15:00"), clock_out_at: at("2026-10-07", "18:00") });
  const result = runAfter({ shifts: [pat, galaShift(CASEY)], punches: [added, punch({ employee_id: CASEY, clock_in_at: at("2026-10-07", "15:00"), clock_out_at: at("2026-10-07", "18:00") })] });
  assert.equal(result.counts.needsFix, 0);
  assert.equal(result.ready, true);
});

test("everyone punches: a recorded choice cannot answer the fix", () => {
  const result = runAfter({ rulings: [{ check_id: "3.5", finding_key: "3.5:deal:25300", choice: "staff", payee_id: PAT }] });
  const f = only(result.findings, "3.5")[0];
  assert.equal(f.status, "needs_fix");
  assert.equal(f.ruling, undefined);
  assert.equal(result.ready, false);
});

test("everyone punches: the 09-21..10-04 run keeps today's rules — crewless events default to the tip payee", () => {
  assert.ok(NEXT.start < CREW_PUNCH_REQUIRED_FROM);
  const event: DealRow = { id: 25200, event_date: "2026-09-30", staff_count: 1, company: "Example Lunch", stage: "Booked Paid" };
  const scheduled = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-30", "11:00"),
    ends_at: at("2026-09-30", "14:00"),
    position: "Catering",
    deal_id: event.id,
  });
  const result = run({ window: NEXT, today: "2026-10-05", windowDeals: [event, { ...event, id: 25201, event_date: "2026-10-01", company: "Example Brunch" }], shifts: [scheduled] });
  const crewless = only(result.findings, "3.5");
  assert.deepEqual(crewless.map((f) => [f.key, f.status]), [["3.5:deal:25200", "needs_ruling"], ["3.5:deal:25201", "needs_ruling"]]);
  for (const f of crewless) assert.deepEqual(f.effective?.payee, { id: PAT, name: "Example, Pat" });
  const unpunched = only(result.findings, "1.12").filter((f) => f.key.startsWith("1.12:unpunched"));
  assert.deepEqual(unpunched.map((f) => f.status), ["auto_resolved"]);
  assert.equal(result.ready, true);
});

// --- 1.9 retired from the cutover (Alina, 2026-10-05) ----------------------
//
// The store never closes before 10 PM and has no early half days (it closes
// instead), so a last in-store clock-out before 22:00 is always a gap before
// close: 1.8 reports it and its add-punch form fixes it. The $30 solo-close
// bonus is "alone 4h or more and out at or after 22:00", from punches only, on
// the payroll sheet. No dropdown and no manager pick.

/** Wednesday 2026-10-07 open 11:00-22:00; 10-14 closed, so one day is judged. */
const WED_AFTER = {
  storeHours: openOn(3),
  storeHoursExceptions: [{ date: "2026-10-14", label: "closed for this fixture", is_closed: true }],
};

test("1.9 retired: from 2026-10-05 a night closed 2h+ early is 1.8's gap with a punch to add, not a choice", () => {
  const result = runAfter({
    ...WED_AFTER,
    windowDeals: [],
    punches: [punch({ employee_id: CASEY, clock_in_at: at("2026-10-07", "11:00"), clock_out_at: at("2026-10-07", "18:00") })],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
  const gap = only(result.findings, "1.8")[0];
  assert.equal(gap.key, "1.8:2026-10-07:18:00-22:00");
  assert.equal(gap.fix?.kind, "add");
  assert.doesNotMatch(gap.resolution ?? "", /1\.9/);
  assert.equal(result.counts.needsRuling, 1, "only the 3.7 bake-shift case is a choice");
});

test("1.9 retired: from 2026-10-05 a 4h+ solo tail out before 22:00 gets no dropdown either", () => {
  const result = runAfter({
    ...WED_AFTER,
    windowDeals: [],
    punches: [punch({ employee_id: CASEY, clock_in_at: at("2026-10-07", "11:00"), clock_out_at: at("2026-10-07", "20:30") })],
  });
  assert.deepEqual(only(result.findings, "1.9"), []);
});

test("before the cutover nothing changes: 1.9, 1.12 and 3.5 are the 09-21..10-04 run's cards exactly", () => {
  // Pinned: the run before CREW_PUNCH_REQUIRED_FROM keeps the dropdown, the
  // per-event count line, the per-person warning and the crewless picker.
  const lunch: DealRow = { id: 25200, event_date: "2026-09-23", staff_count: 2, company: "Example Lunch", stage: "Booked Paid" };
  const brunch: DealRow = { id: 25201, event_date: "2026-09-24", staff_count: 1, company: "Example Brunch", stage: "Booked Paid" };
  const caseyShift = shift({ employee_id: CASEY, starts_at: at("2026-09-23", "11:00"), ends_at: at("2026-09-23", "14:00"), position: "Catering", deal_id: lunch.id });
  const drewShift = shift({ employee_id: DREW, starts_at: at("2026-09-23", "11:00"), ends_at: at("2026-09-23", "14:00"), position: "Catering", deal_id: lunch.id });
  const result = run({
    window: NEXT,
    today: "2026-10-05",
    storeHours: openOn(3),
    storeHoursExceptions: [{ date: "2026-09-30", label: "closed for this fixture", is_closed: true }],
    windowDeals: [lunch, brunch],
    deals: [lunch],
    shifts: [caseyShift, drewShift],
    punches: [
      punch({ employee_id: CASEY, shift_id: caseyShift.id, clock_in_at: at("2026-09-23", "11:00"), clock_out_at: at("2026-09-23", "14:00") }),
      punch({ employee_id: PAT, clock_in_at: at("2026-09-23", "11:00"), clock_out_at: at("2026-09-23", "18:00") }),
    ],
  });
  const cards = result.findings
    .filter((f) => ["1.9", "1.12", "3.5"].includes(f.check))
    .map((f) => [f.key, f.status, f.title]);
  assert.deepEqual(cards, [
    ["1.9:2026-09-23", "needs_ruling", "No closing punch"],
    ["1.12:deal:25200", "auto_resolved", "Catering event under-punched"],
    [`1.12:unpunched:deal:25200:${DREW}`, "auto_resolved", "Catering event under-punched"],
    ["3.5:deal:25201", "needs_ruling", "Crewless catering event"],
  ]);
  const crewless = only(result.findings, "3.5")[0];
  assert.deepEqual(crewless.effective?.payee, { id: PAT, name: "Example, Pat" });
  assert.equal(crewless.fixes, undefined);
  assert.equal(only(result.findings, "1.9")[0].defaultChoice, "skip");
  assert.match(only(result.findings, "1.8")[0].resolution ?? "", /1\.9/);
  assert.equal(result.groups.find((g) => g.check === "3.5")!.title, "Crewless catering event");
});

// --- §3.7 no bake shift ----------------------------------------------------

test("3.7: an open period with no Pastry Opener shift worked is a schedule anomaly with a picker", () => {
  const scheduledNotWorked = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-09", "06:00"),
    ends_at: at("2026-09-09", "10:00"),
    position: "Pastry Opener",
  });
  const result = run({ ...WED_ONLY, shifts: [scheduledNotWorked] });
  const f = only(result.findings, "3.7")[0];
  assert.equal(f.key, "3.7:olo:2026-09-20");
  assert.match(f.summary, /norm is at least 4/);
  assert.deepEqual(f.defaultPayee, { id: PAT, name: "Example, Pat" });
});

test("3.7: one bake shift worked is enough to split over", () => {
  const bake = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-09", "06:00"),
    ends_at: at("2026-09-09", "10:00"),
    position: "Pastry Opener",
  });
  const result = run({
    ...WED_ONLY,
    shifts: [bake],
    punches: [
      punch({ employee_id: CASEY, shift_id: bake.id, clock_in_at: at("2026-09-09", "06:00"), clock_out_at: at("2026-09-09", "10:00") }),
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
  assert.equal(sameNameWords("Pat Example", "Example, Pat"), true);
  assert.equal(sameNameWords("", ""), false);
  assert.equal(sameNameWords(null, "Pat"), false);
});

// --- the button -------------------------------------------------------------

test("§1: a short punch holds the button until the punch itself is corrected (ruling D)", () => {
  const scheduled = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
    position: "PENN Closer",
  });
  const short = punch({
    employee_id: CASEY,
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
      punch({ employee_id: CASEY, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
    ],
    rulings: [{ check_id: "1.9", finding_key: "1.9:2026-09-02", choice: "scheduled_closer", payee_id: CASEY }],
  });
  const f = only(after.findings, "1.9")[0];
  assert.equal(f.ruling, null);
  assert.equal(f.effective?.source, "default");
});

test("§1: a fix-class finding cannot be ruled away", () => {
  const open = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00") });
  const after = run({
    punches: [open],
    rulings: [{ check_id: "1.4", finding_key: `1.1:punch:${open.id}`, choice: "void" }],
  });
  assert.equal(after.ready, false);
});

test("§1: findings are grouped by check, in spec order, and only non-empty groups appear", () => {
  const result = run({
    punches: [punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00") })],
  });
  // An open punch with no shift: 1.1 detects it, 1.4 blocks it (ruled 2026-09-27).
  assert.deepEqual(result.groups.map((g) => g.check), ["1.1", "1.4"]);
  assert.equal(result.groups[0].rule, "clock_out IS NULL inside window");
});

test("§1: every option a finding offers is in the API's ruling vocabulary", () => {
  // The options are built per finding (their effect is per finding); the
  // vocabulary the route validates against is fixed. This is what stops the
  // two drifting apart.
  const scheduled = shift({
    employee_id: CASEY,
    starts_at: at("2026-09-18", "15:00"),
    ends_at: at("2026-09-18", "22:00"),
  });
  const result = run({
    ...WED_ONLY,
    shifts: [scheduled],
    punches: [
      punch({
        employee_id: CASEY,
        shift_id: scheduled.id,
        clock_in_at: at("2026-09-18", "15:00"),
        clock_out_at: `2026-09-18T15:02:11-04:00`,
      }),
      // A runaway with no shift, on a day the store is shut: 1.4, a fix.
      punch({ employee_id: DREW, clock_in_at: at("2026-09-14", "11:00"), clock_out_at: at("2026-09-15", "06:00") }),
      // An early finish on the one open day: 1.9's choice.
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "18:00") }),
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

// --- inline punch fixes (Alina, 2026-10-05) ---------------------------------
//
// A finding that needs a punch fixed carries what the page needs to fix it in
// place: the punch to edit, or the punch to add (who, when, which shift). The
// page writes through the Timesheets routes and runs Verify again; nothing
// here writes. Times are New York wall clock, as datetime-local values.

test("fix: an open punch with no shift (1.4) is fixed by editing that punch", () => {
  const open = punch({ employee_id: DREW, clock_in_at: at("2026-09-15", "11:00") });
  const f = only(run({ punches: [open] }).findings, "1.4")[0];
  assert.deepEqual(f.fix, {
    kind: "edit",
    punch: { id: open.id, employee_id: DREW, employee_name: "Sample, Drew", clock_in: "2026-09-15T11:00", clock_out: null },
  });
});

test("fix: an open punch with a shift (1.1) and a runaway with no shift (1.4) are edits too", () => {
  const scheduled = shift({ employee_id: CASEY, starts_at: at("2026-09-16", "11:00"), ends_at: at("2026-09-16", "17:00") });
  const open = punch({ employee_id: CASEY, shift_id: scheduled.id, clock_in_at: at("2026-09-16", "11:00") });
  const runaway = punch({ employee_id: DREW, clock_in_at: at("2026-09-14", "11:00"), clock_out_at: at("2026-09-15", "06:00") });
  const result = run({ shifts: [scheduled], punches: [open, runaway] });
  assert.equal(only(result.findings, "1.1")[0].fix?.kind, "edit");
  const r = only(result.findings, "1.4").find((x) => x.status === "needs_fix")!;
  assert.deepEqual(r.fix, {
    kind: "edit",
    punch: { id: runaway.id, employee_id: DREW, employee_name: "Sample, Drew", clock_in: "2026-09-14T11:00", clock_out: "2026-09-15T06:00" },
  });
});

test("fix: a short punch (1.5) is fixed by editing it; a truncation by rule needs no fix", () => {
  const scheduled = shift({ employee_id: CASEY, starts_at: at("2026-09-18", "15:00"), ends_at: at("2026-09-18", "22:00"), position: "PENN Closer" });
  const short = punch({ employee_id: CASEY, shift_id: scheduled.id, clock_in_at: at("2026-09-18", "15:00"), clock_out_at: "2026-09-18T15:02:11-04:00" });
  const long = shift({ employee_id: DREW, starts_at: at("2026-09-10", "08:00"), ends_at: at("2026-09-10", "16:00") });
  const runaway = punch({ employee_id: DREW, shift_id: long.id, clock_in_at: at("2026-09-10", "08:00"), clock_out_at: at("2026-09-11", "02:00") });
  const result = run({ shifts: [scheduled, long], punches: [short, runaway] });
  assert.deepEqual(only(result.findings, "1.5")[0].fix, {
    kind: "edit",
    punch: { id: short.id, employee_id: CASEY, employee_name: "Bravo, Casey", clock_in: "2026-09-18T15:00", clock_out: "2026-09-18T15:02" },
  });
  const truncated = only(result.findings, "1.4")[0];
  assert.equal(truncated.status, "auto_resolved");
  assert.equal(truncated.fix, undefined);
});

test("fix: a coverage gap (1.8) is fixed by adding a punch over it, with that day's shifts to pick from", () => {
  const closer = shift({ employee_id: CASEY, starts_at: at("2026-09-09", "15:00"), ends_at: at("2026-09-09", "22:00"), position: "PENN Closer" });
  const result = run({
    ...WED_ONLY,
    shifts: [closer],
    punches: [
      punch({ employee_id: DREW, clock_in_at: at("2026-09-09", "11:00"), clock_out_at: at("2026-09-09", "15:00") }),
      punch({ employee_id: CASEY, shift_id: closer.id, clock_in_at: at("2026-09-09", "17:00"), clock_out_at: at("2026-09-09", "22:00") }),
    ],
  });
  const gap = only(result.findings, "1.8").find((f) => f.evidence.interval)!;
  assert.deepEqual(gap.fix, {
    kind: "add",
    date: "2026-09-09",
    clock_in: "2026-09-09T15:00",
    clock_out: "2026-09-09T17:00",
    shifts: [{ id: closer.id, label: "Bravo, Casey · PENN Closer 3:00 PM–10:00 PM" }],
  });
});

test("fix: a wall-clock time at or past 24:00 rolls into the next day", () => {
  assert.equal(wallClockInput("2026-09-09", "17:30"), "2026-09-09T17:30");
  assert.equal(wallClockInput("2026-09-09", "24:00"), "2026-09-10T00:00");
  assert.equal(wallClockInput("2026-09-30", "25:15"), "2026-10-01T01:15");
});

test("fix: a New York wall-clock value is written as the right instant, in summer and winter", () => {
  assert.equal(nyInputToIso("2026-09-15T11:00"), "2026-09-15T15:00:00.000Z");
  assert.equal(nyInputToIso("2026-11-15T11:00"), "2026-11-15T16:00:00.000Z");
  assert.equal(nyInputToIso("2026-10-07T23:30"), "2026-10-08T03:30:00.000Z");
  assert.equal(nyInputToIso(""), null);
  assert.equal(nyInputToIso("2026-10-07"), null);
});

test("fix: before the cutover an unpunched catering crew member (1.12) still carries their add-punch form", () => {
  const event: DealRow = { id: 25200, event_date: "2026-09-30", staff_count: 1, company: "Example Lunch", stage: "Booked Paid" };
  const pat = shift({ employee_id: PAT, starts_at: at("2026-09-30", "15:00"), ends_at: at("2026-09-30", "18:00"), position: "Catering", deal_id: event.id });
  const result = run({ window: NEXT, today: "2026-10-05", windowDeals: [event], shifts: [pat] });
  const f = only(result.findings, "1.12").find((x) => x.key.startsWith("1.12:unpunched"))!;
  assert.equal(f.status, "auto_resolved");
  assert.deepEqual(f.fix, {
    kind: "add",
    date: "2026-09-30",
    employee_id: PAT,
    shift_id: pat.id,
    clock_in: "2026-09-30T15:00",
    clock_out: "2026-09-30T18:00",
    shifts: [{ id: pat.id, label: "Example, Pat · Catering 3:00 PM–6:00 PM" }],
  });
});

test("fix: a choice, a flag or a report carries no fix", () => {
  const result = run({ windowDeals: [CONSULTING] });
  assert.ok(result.findings.length > 0);
  for (const f of result.findings) assert.equal(f.fix, undefined, f.key);
});

test("fix: the result lists active staff for the add-a-punch picker", () => {
  assert.deepEqual(run().staff.map((p) => p.id), [CASEY, PAT, DREW]);
});
