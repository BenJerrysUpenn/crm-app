// The bookkeeping pass history card (bj-finance #937, migration 56): the rows
// bj-finance modules/pass_history.py writes, read and shaped for the chart.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePassRun, passDays, runsInPeriod, sortRuns, whoRan, type PassRun } from "./passHistory.ts";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run_date: "2026-11-12",
  pass_code: "DAILY-02",
  run_label: "",
  attended: false,
  posted_count: 3,
  posted_dollars: "2017.80",
  queue_before: 13,
  queue_after: 10,
  cash: null,
  issues_filed: [846],
  note: "3 posted",
  source: "pass",
  ...over,
});

const run = (over: Record<string, unknown> = {}): PassRun => parsePassRun(row(over))!;

test("a row parses, numeric columns arriving as strings included; a row that is not a pass run is refused", () => {
  assert.deepEqual(run(), {
    runDate: "2026-11-12",
    passCode: "DAILY-02",
    runLabel: "",
    attended: false,
    postedCount: 3,
    postedDollars: 2017.8,
    queueBefore: 13,
    queueAfter: 10,
    cash: null,
    issuesFiled: [846],
    note: "3 posted",
    source: "pass",
  });
  assert.equal(run({ source: "backfill" }).source, "backfill");
  assert.equal(run({ posted_dollars: null }).postedDollars, null);
  assert.equal(run({ queue_after: "" }).queueAfter, null);
  assert.equal(run({ posted_dollars: "n/a" }).postedDollars, null);
  assert.deepEqual(run({ issues_filed: null }).issuesFiled, []);
  assert.equal(run({ note: null }).note, "");
  assert.equal(run({ run_label: null }).runLabel, "");
  assert.equal(parsePassRun(row({ run_date: "yesterday" })), null);
  assert.equal(parsePassRun(row({ run_date: 20261112 })), null);
  assert.equal(parsePassRun(row({ pass_code: null })), null);
  assert.equal(parsePassRun(row({ attended: "no" })), null);
});

test("runs sort oldest first, and on one day the plain run before a named sitting", () => {
  const sorted = sortRuns([
    run({ run_date: "2026-11-12", run_label: "evening" }),
    run({ run_date: "2026-11-12", pass_code: "WEEKLY-02" }),
    run({ run_date: "2026-11-11" }),
    run({ run_date: "2026-11-12" }),
    run({ run_date: "2026-11-13" }),
  ]);
  assert.deepEqual(
    sorted.map((r) => `${r.runDate} ${r.passCode} ${r.runLabel}`),
    ["2026-11-11 DAILY-02 ", "2026-11-12 DAILY-02 ", "2026-11-12 DAILY-02 evening", "2026-11-12 WEEKLY-02 ", "2026-11-13 DAILY-02 "],
  );
});

test("the chart's days: the bookkeeping pass only, sittings added up, the queue after the last one, a day not run left out", () => {
  const days = passDays(
    [
      run({ run_date: "2026-11-01", posted_dollars: 50 }),
      run({ run_date: "2026-11-10", posted_dollars: 10.1, queue_after: 7 }),
      run({ run_date: "2026-11-10", run_label: "evening", attended: true, posted_dollars: 20.2, queue_after: 4 }),
      run({ run_date: "2026-11-11", posted_dollars: null, queue_after: null }),
      run({ run_date: "2026-11-11", pass_code: "WEEKLY-02", posted_dollars: 999, queue_after: 1 }),
      run({ run_date: "2026-11-12", run_label: "evening", posted_dollars: 5, queue_after: null }),
      run({ run_date: "2026-11-12", posted_dollars: null, queue_after: 9 }),
    ],
    "2026-11-12",
    7,
  );
  assert.deepEqual(days, [
    { day: "2026-11-10", booked: 30.3, waiting: 4 },
    { day: "2026-11-11", booked: null, waiting: null },
    { day: "2026-11-12", booked: 5, waiting: 9 },
  ]);
});

test("a period's runs are every pass in the last N days through today, newest first", () => {
  const runs = [
    run({ run_date: "2026-10-13" }),
    run({ run_date: "2026-10-14" }),
    run({ run_date: "2026-11-09", pass_code: "WEEKLY-02" }),
    run({ run_date: "2026-11-12" }),
    run({ run_date: "2026-11-14" }),
  ];
  assert.deepEqual(
    runsInPeriod(runs, "2026-11-13", 30).map((r) => `${r.runDate} ${r.passCode}`),
    ["2026-11-12 DAILY-02", "2026-11-09 WEEKLY-02", "2026-10-14 DAILY-02"],
  );
});

test("who ran it, in plain words", () => {
  assert.equal(whoRan(run()), "scheduled");
  assert.equal(whoRan(run({ attended: true })), "with someone");
  assert.equal(whoRan(run({ attended: true, run_label: "evening" })), "with someone, evening");
});
