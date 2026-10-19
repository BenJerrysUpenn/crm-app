// The Labor vs target card's week range (bj-finance #696): the weeks on
// offer, the default, a saved range cut to what is on offer, and what the
// picker saves. Dates only; no figures.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CUSTOM_RANGE, DEFAULT_WEEKS, FIRST_LABOR_WEEK, activeShortcut, monthChoiceFor, monthChoices, defaultLaborRange, monthShortcuts, isSunday, laborWeekStarts, monthWeeks, pickRange, rangeLabel, savedRange,
  shownRange, sundayOf, weekOptionLabel,
} from "./weekRange.ts";

test("weeks run Sunday to Saturday and are named by their Sunday", () => {
  assert.equal(sundayOf("2026-10-18"), "2026-10-18"); // a Sunday
  assert.equal(sundayOf("2026-10-24"), "2026-10-18"); // its Saturday
  assert.equal(isSunday("2026-05-03"), true);
  assert.equal(isSunday("2026-05-04"), false);
  assert.equal(isSunday("2026-02-30"), false);
  assert.equal(isSunday("May 3"), false);
  assert.deepEqual(monthWeeks("2030-10"), ["2030-10-06", "2030-10-13", "2030-10-20", "2030-10-27"]);
  assert.deepEqual(monthWeeks("2026-11"), ["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"]);
});

test("the weeks on offer run from the first week under Withers to the week holding today", () => {
  const starts = laborWeekStarts("2026-10-18");
  assert.equal(starts[0], FIRST_LABOR_WEEK);
  assert.equal(starts[0], "2026-05-03");
  assert.equal(starts.at(-1), "2026-10-18");
  assert.equal(starts.length, 25);
  assert.equal(laborWeekStarts("2026-10-17").at(-1), "2026-10-11");
  assert.deepEqual(laborWeekStarts("2026-04-01"), [FIRST_LABOR_WEEK]); // never empty
});

test("the default is the last 8 weeks ending with the most recent week that is over", () => {
  assert.equal(DEFAULT_WEEKS, 8);
  // Sunday Oct 18: the week of Oct 11 ended yesterday.
  assert.deepEqual(defaultLaborRange("2026-10-18"), { from: "2026-08-23", to: "2026-10-11" });
  // Saturday Oct 17: the week of Oct 11 is not over until tonight.
  assert.deepEqual(defaultLaborRange("2026-10-17"), { from: "2026-08-16", to: "2026-10-04" });
  // Early on, it starts no sooner than the first week.
  assert.deepEqual(defaultLaborRange("2026-05-20"), { from: "2026-05-03", to: "2026-05-10" });
  assert.deepEqual(defaultLaborRange("2026-05-05"), { from: "2026-05-03", to: "2026-05-03" });
});

test("a saved range is two Sundays in order; an old month reads as that month's weeks", () => {
  assert.deepEqual(savedRange("2026-05-03", "2026-10-04", undefined), { from: "2026-05-03", to: "2026-10-04" });
  assert.deepEqual(savedRange("2026-06-07", "2026-06-07", undefined), { from: "2026-06-07", to: "2026-06-07" });
  assert.equal(savedRange("2026-10-04", "2026-05-03", undefined), null);
  assert.equal(savedRange("2026-05-04", "2026-10-04", undefined), null);
  assert.deepEqual(savedRange(undefined, undefined, "2026-09"), { from: "2026-09-06", to: "2026-09-27" });
  assert.deepEqual(savedRange(undefined, undefined, "2026-08"), { from: "2026-08-02", to: "2026-08-30" });
  assert.equal(savedRange(undefined, undefined, "2026-9"), null);
  assert.equal(savedRange(undefined, undefined, undefined), null);
});

test("the range shown is the saved one cut to the weeks on offer, else the default", () => {
  const fallback = defaultLaborRange("2026-10-18");
  const offer = { weeks: laborWeekStarts("2026-10-18").map((start) => ({ start })), defaultRange: fallback };
  assert.deepEqual(shownRange({}, offer), fallback);
  assert.deepEqual(shownRange(undefined, offer), fallback);
  assert.deepEqual(shownRange({ from: "2026-05-03", to: "2026-10-04" }, offer), { from: "2026-05-03", to: "2026-10-04" });
  // An old month from before the first week is cut to start at it.
  assert.deepEqual(shownRange({ from: "2026-04-05", to: "2026-05-24" }, offer), { from: "2026-05-03", to: "2026-05-24" });
  // Past this week: cut to it.
  assert.deepEqual(shownRange({ from: "2026-10-04", to: "2026-11-29" }, offer), { from: "2026-10-04", to: "2026-10-18" });
  // Nothing of it on offer: the default.
  assert.deepEqual(shownRange({ from: "2025-11-02", to: "2025-11-30" }, offer), fallback);
  assert.deepEqual(shownRange({ from: "2026-05-04", to: "2026-06-01" }, offer), fallback);
  // No weeks on offer at all: the default, never the saved range uncut.
  assert.deepEqual(shownRange({ from: "2026-05-03", to: "2026-10-04" }, { weeks: [], defaultRange: fallback }), fallback);
});

test("the picker moves the other end when the two would cross, and saves the default as unset", () => {
  const fallback = { from: "2026-08-23", to: "2026-10-11" };
  const cur = { from: "2026-06-07", to: "2026-07-05" };
  assert.deepEqual(pickRange(cur, "from", "2026-05-03", fallback), { from: "2026-05-03", to: "2026-07-05" });
  assert.deepEqual(pickRange(cur, "from", "2026-08-02", fallback), { from: "2026-08-02", to: "2026-08-02" });
  assert.deepEqual(pickRange(cur, "to", "2026-05-17", fallback), { from: "2026-05-17", to: "2026-05-17" });
  assert.deepEqual(pickRange(cur, "to", "2026-10-04", fallback), { from: "2026-06-07", to: "2026-10-04" });
  assert.deepEqual(pickRange({ from: "2026-08-23", to: "2026-10-04" }, "to", "2026-10-11", fallback), { from: undefined, to: undefined });
});

test("weeks are labelled by their Sunday, with the year once the weeks on offer span two", () => {
  assert.equal(weekOptionLabel("2026-05-03", ["2026-05-03", "2026-10-18"]), "May 3");
  assert.equal(weekOptionLabel("2027-01-03", ["2026-05-03", "2027-01-03"]), "Jan 3, 2027");
  // No weeks on offer to span two years: no year.
  assert.equal(weekOptionLabel("2026-05-03", []), "May 3");
  assert.equal(rangeLabel({ from: "2026-05-03", to: "2026-10-04" }), "May 3 to Oct 4");
  assert.equal(rangeLabel({ from: "2026-08-23", to: "2026-08-23" }), "Aug 23");
});

/** The weeks on offer on `today` with their default, as the page loads them. */
const OFFER = (today: string) => ({ weeks: laborWeekStarts(today).map((start) => ({ start })), defaultRange: defaultLaborRange(today) });

test("a month shortcut for each month holding a week on offer, each its weeks by Sunday", () => {
  const offer = OFFER("2026-10-18");
  const months = monthShortcuts(offer);
  assert.deepEqual(months.map((m) => m.label), ["May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  assert.deepEqual(months[0], { month: "2026-05", label: "May", name: "May 2026", range: { from: "2026-05-03", to: "2026-05-31" } });
  assert.deepEqual(months[3].range, { from: "2026-08-02", to: "2026-08-30" });
  assert.deepEqual(months[5].range, { from: "2026-10-04", to: "2026-10-25" }); // the weeks to come show as they arrive
  // A month's last day on a Saturday: the next month starts with its own first Sunday.
  assert.equal(monthShortcuts(OFFER("2026-10-31")).at(-1)?.month, "2026-10");
  assert.equal(monthShortcuts(OFFER("2026-11-01")).at(-1)?.month, "2026-11");
  // Across a year end, the year is on each label.
  assert.deepEqual(monthShortcuts({ weeks: [{ start: "2026-12-27" }, { start: "2027-01-03" }], defaultRange: { from: "2026-12-27", to: "2026-12-27" } }).map((m) => m.label), ["Dec 2026", "Jan 2027"]);
});

test("a month shows as chosen while the range is its weeks, cut to those on offer", () => {
  const offer = OFFER("2026-10-18");
  const months = monthShortcuts(offer);
  assert.equal(activeShortcut({ from: "2026-08-02", to: "2026-08-30" }, months, offer), "2026-08");
  assert.equal(activeShortcut({ from: "2026-10-04", to: "2026-10-18" }, months, offer), "2026-10");
  assert.equal(activeShortcut({ from: "2026-08-02", to: "2026-08-23" }, months, offer), null);
  assert.equal(activeShortcut(offer.defaultRange, months, offer), null);
});

test("the month menu: Custom, then May 2026 to this month by full name, each setting that month's weeks", () => {
  const offer = OFFER("2026-10-18");
  const choices = monthChoices(offer);
  assert.deepEqual(choices.map((c) => c.label), ["Custom", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026", "Oct 2026"]);
  assert.deepEqual(choices[0], { value: CUSTOM_RANGE, label: "Custom", range: null });
  assert.deepEqual(choices[4], { value: "2026-08", label: "Aug 2026", range: { from: "2026-08-02", to: "2026-08-30" } });
});

test("the month menu shows the month while the range is one, else Custom", () => {
  const offer = OFFER("2026-10-18");
  assert.equal(monthChoiceFor({ from: "2026-08-02", to: "2026-08-30" }, offer), "2026-08");
  assert.equal(monthChoiceFor({ from: "2026-10-04", to: "2026-10-18" }, offer), "2026-10");
  assert.equal(monthChoiceFor({ from: "2026-08-02", to: "2026-08-23" }, offer), CUSTOM_RANGE);
  assert.equal(monthChoiceFor(offer.defaultRange, offer), CUSTOM_RANGE);
});
