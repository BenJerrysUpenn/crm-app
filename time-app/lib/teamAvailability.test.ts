// Unit tests for the Team availability grid.
//
//   npm test        (node --test lib/*.test.ts)
//
// Week of Sun 2026-09-27 … Sat 2026-10-03. Weekdays: 0 = Sunday.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { AvailabilityRow } from "./availabilityCheck.ts";
import { buildTeamGrid, cellFor, cellTitle, shortSpan, summaryLine, type Cell, type RosterPerson } from "./teamAvailability.ts";
import { resolveDay } from "./availabilityCheck.ts";

const WEEK = "2026-09-27";
const SUN = "2026-09-27";
const TUE = "2026-09-29";
const WED = "2026-09-30";
const SAT_BEFORE = "2026-09-26";

function row(employee_id: string, extra: Partial<AvailabilityRow>): AvailabilityRow {
  return {
    employee_id,
    weekday: null,
    specific_date: null,
    start_time: null,
    end_time: null,
    is_available: true,
    status: null,
    preference: "available",
    ...extra,
  };
}

const roster: RosterPerson[] = [
  { id: "a", full_name: "Amy" },
  { id: "b", full_name: "Ben" },
  { id: "c", full_name: null },
];

function cellOf(grid: ReturnType<typeof buildTeamGrid>, id: string, date: string): Cell {
  const r = grid.rows.find((x) => x.id === id)!;
  return r.cells.find((c) => c.date === date)!;
}

test("shortSpan: same half drops the first suffix, mixed halves keep both", () => {
  assert.equal(shortSpan(18 * 60, 20 * 60), "6–8p");
  assert.equal(shortSpan(12 * 60, 17 * 60), "12–5p");
  assert.equal(shortSpan(9 * 60, 17 * 60), "9a–5p");
  assert.equal(shortSpan(17 * 60 + 30, 22 * 60), "5:30–10p");
  assert.equal(shortSpan(0, 2 * 60), "12–2a");
  assert.equal(shortSpan(18 * 60, 1440), "6p–12a");
  assert.equal(shortSpan(9 * 60, 1440), "9a–12a");
  assert.equal(shortSpan(0, 1440), "all day");
});

test("every roster person gets a row, in roster order, even with nothing entered", () => {
  const grid = buildTeamGrid(roster, WEEK, []);
  assert.deepEqual(grid.rows.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(grid.dates.length, 7);
  assert.equal(grid.dates[0], SUN);
  for (const r of grid.rows) {
    assert.equal(r.submitted, false);
    assert.ok(r.cells.every((c) => c.state === "none"));
  }
  assert.equal(
    grid.rows[2].name,
    "No name set (c)",
    "a nameless person shows the neutral label (disambiguated by id), never a raw id (bj-finance #468)",
  );
  assert.equal(summaryLine(grid), "0 of 3 submitted availability this week");
});

test("an email sitting in a roster name is never shown in the grid (bj-finance #468)", () => {
  const grid = buildTeamGrid(
    [{ id: "d0e1f2a3-0000-4000-8000-000000000004", full_name: "staff2@example.com" }],
    WEEK,
    [],
  );
  assert.equal(grid.rows[0].name, "No name set (d0e1f2a3)");
});

test("people off the roster are left out", () => {
  const grid = buildTeamGrid(roster, WEEK, [row("zed", { weekday: 2 })]);
  assert.equal(grid.rows.length, 3);
  assert.equal(grid.submittedCount, 0);
});

test("weekly rows fill every matching weekday and count as submitted", () => {
  const rows = [row("a", { weekday: 2, start_time: "12:00", end_time: "17:00", preference: "preferred" })];
  const grid = buildTeamGrid(roster, WEEK, rows);
  assert.deepEqual(cellOf(grid, "a", TUE), {
    date: TUE,
    state: "blocks",
    lines: [{ kind: "preferred", text: "Prefers 12–5p", weekly: true }],
  });
  assert.equal(cellOf(grid, "a", WED).state, "none");
  assert.equal(grid.rows[0].submitted, true);
  assert.equal(grid.submittedCount, 1);
});

test("a dated can't-work block sits alongside the weekly pattern, in clock order", () => {
  const rows = [
    row("a", { weekday: 2, start_time: "12:00", end_time: "17:00", preference: "preferred" }),
    row("a", { specific_date: TUE, start_time: "18:00", end_time: "20:00", preference: "unavailable" }),
  ];
  const cell = cellOf(buildTeamGrid(roster, WEEK, rows), "a", TUE);
  assert.equal(cell.state, "blocks");
  assert.deepEqual(
    cell.state === "blocks" ? cell.lines : [],
    [
      { kind: "preferred", text: "Prefers 12–5p", weekly: true },
      { kind: "unavailable", text: "Can't 6–8p", weekly: false },
    ],
  );
});

test("available all day reads 'Avail all day'", () => {
  const cell = cellOf(buildTeamGrid(roster, WEEK, [row("b", { specific_date: WED })]), "b", WED);
  assert.deepEqual(cell, { date: WED, state: "blocks", lines: [{ kind: "available", text: "Avail all day", weekly: false }] });
});

test("can't work the whole day is its own state", () => {
  const rows = [
    row("a", { weekday: 3, preference: "unavailable" }),
    row("b", { specific_date: WED, preference: "unavailable" }),
  ];
  const grid = buildTeamGrid(roster, WEEK, rows);
  assert.deepEqual(cellOf(grid, "a", WED), { date: WED, state: "unavailable", weekly: true });
  assert.deepEqual(cellOf(grid, "b", WED), { date: WED, state: "unavailable", weekly: false });
});

test("a dated all-day can't-work beats a weekly available block", () => {
  const rows = [
    row("a", { weekday: 3, start_time: "09:00", end_time: "17:00" }),
    row("a", { specific_date: WED, preference: "unavailable" }),
  ];
  assert.equal(cellOf(buildTeamGrid(roster, WEEK, rows), "a", WED).state, "unavailable");
});

test("time off: approved and pending show, denied is ignored", () => {
  const rows = [
    row("a", { specific_date: TUE, is_available: false, status: "approved", preference: null }),
    row("b", { specific_date: TUE, is_available: false, status: "pending", preference: null }),
    row("c", { specific_date: TUE, is_available: false, status: "denied", preference: null }),
  ];
  const grid = buildTeamGrid(roster, WEEK, rows);
  assert.deepEqual(cellOf(grid, "a", TUE), { date: TUE, state: "time_off", status: "approved" });
  assert.deepEqual(cellOf(grid, "b", TUE), { date: TUE, state: "time_off", status: "pending" });
  assert.equal(cellOf(grid, "c", TUE).state, "none");
  assert.equal(grid.submittedCount, 2);
  assert.equal(grid.pendingTimeOffCount, 1);
  assert.equal(summaryLine(grid), "2 of 3 submitted availability this week · 1 time-off pending");
});

test("time off beats the weekly pattern for that day", () => {
  const rows = [
    row("a", { weekday: 2, start_time: "12:00", end_time: "17:00" }),
    row("a", { specific_date: TUE, is_available: false, status: "pending", preference: null }),
  ];
  assert.deepEqual(cellOf(buildTeamGrid(roster, WEEK, rows), "a", TUE), { date: TUE, state: "time_off", status: "pending" });
});

test("pending time off on several days counts the person once", () => {
  const rows = [
    row("a", { specific_date: TUE, is_available: false, status: "pending" }),
    row("a", { specific_date: WED, is_available: false, status: "pending" }),
  ];
  assert.equal(buildTeamGrid(roster, WEEK, rows).pendingTimeOffCount, 1);
});

test("an overnight block from the Saturday before reaches Sunday", () => {
  const rows = [row("a", { specific_date: SAT_BEFORE, start_time: "20:00", end_time: "02:00" })];
  const grid = buildTeamGrid(roster, WEEK, rows);
  assert.deepEqual(cellOf(grid, "a", SUN), {
    date: SUN,
    state: "blocks",
    lines: [{ kind: "available", text: "Avail 12–2a", weekly: false }],
  });
  assert.equal(grid.rows[0].submitted, true);
});

test("touching blocks of the same kind from weekly and dated rows read as one line", () => {
  const rows = [
    row("a", { weekday: 2, start_time: "12:00", end_time: "17:00" }),
    row("a", { specific_date: TUE, start_time: "17:00", end_time: "20:00" }),
  ];
  const cell = cellFor(resolveDay("a", TUE, rows));
  assert.deepEqual(cell, { date: TUE, state: "blocks", lines: [{ kind: "available", text: "Avail 12–8p", weekly: false }] });
});

test("cellTitle spells each state out", () => {
  assert.equal(cellTitle({ date: TUE, state: "none" }), "No availability on file");
  assert.equal(cellTitle({ date: TUE, state: "time_off", status: "pending" }), "Time off requested, not yet decided");
  assert.equal(cellTitle({ date: TUE, state: "unavailable", weekly: true }), "Can't work all day (every week)");
  assert.equal(
    cellTitle({ date: TUE, state: "blocks", lines: [{ kind: "preferred", text: "Prefers 12–5p", weekly: true }] }),
    "Prefers 12–5p (every week)",
  );
});
