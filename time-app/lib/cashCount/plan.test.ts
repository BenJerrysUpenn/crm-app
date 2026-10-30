// Who the cash count reminders mention, and when (lib/cashCount/plan.ts).
// The owner's rules, 2026-10-29: the opener after they clock in; the lead on
// shift just after closing; one follow-up 30 minutes later if nobody posted.
// Invented people and shifts; the shapes are production's (2026-09-30..10-29).
//
//   npm test        (node --test; Node runs TypeScript directly)

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadAppModule } from "../testing/fakeSupabase.ts";
import type * as Plan from "./plan.ts";

// plan.ts imports "@/lib/coverage"; the app's loader resolves the alias.
const plan = await loadAppModule<typeof Plan>("lib/cashCount/plan.ts");
const { dueReminders, findClosers, findOpener, followupStep, nyInstant } = plan;

const DATE = "2026-10-29"; // a Thursday, EDT
const at = (hhmm: string, date = DATE) => new Date(`${date}T${hhmm}:00-04:00`).toISOString();
const t = (hhmm: string) => Date.parse(at(hhmm));

const OPENER = "opener";
const CLOSER = "closer";
const OFFICE = "office";
const CATERER = "caterer";
const COVER = "cover";
const MANAGER = "manager";

const IN_STORE = new Map([
  ["PENN Opener", true],
  ["PENN Closer", true],
  ["Catering", false],
  ["Marketing", false],
]);

type Shift = Plan.PlanShift;
type Entry = Plan.PlanEntry;
let ids = 0;
const shift = (employee_id: string | null, from: string, to: string, position: string, deal_id: number | null = null): Shift => ({
  id: ++ids,
  employee_id,
  starts_at: at(from),
  ends_at: at(to),
  position,
  deal_id,
  published: true,
});
const punch = (employee_id: string, from: string, to: string | null, shift_id: number | null = null): Entry => ({
  id: ++ids,
  employee_id,
  shift_id,
  clock_in_at: at(from),
  clock_out_at: to ? at(to) : null,
});

// The store: 11:00 to 22:00.
const DAY = { date: DATE, openAt: t("11:00"), closeAt: t("22:00") };
const snap = (shifts: Shift[], entries: Entry[]): Plan.DaySnapshot => ({ day: DAY, shifts, entries, inStoreByName: IN_STORE });

test("New York wall clock to an instant, either side of the clocks going back", () => {
  assert.equal(new Date(nyInstant("2026-10-31", 11 * 60)).toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(new Date(nyInstant("2026-11-01", 14 * 60)).toISOString(), "2026-11-01T19:00:00.000Z");
  assert.equal(new Date(nyInstant("2026-11-01", 22 * 60)).toISOString(), "2026-11-02T03:00:00.000Z");
});

test("the opener is the first punch for the opening shift, not an earlier office or catering punch", () => {
  const opening = shift(OPENER, "10:00", "16:00", "PENN Opener");
  const event = shift(CATERER, "09:30", "13:00", "Catering", 77);
  const s = snap(
    [opening, event, shift(CLOSER, "16:00", "23:00", "PENN Closer")],
    [punch(OFFICE, "09:40", null), punch(CATERER, "09:45", null, event.id), punch(OPENER, "10:20", null, opening.id)],
  );
  assert.equal(findOpener(s, t("10:19")), null, "nobody on the opening shift has clocked in yet");
  assert.deepEqual(
    { who: findOpener(s, t("10:21"))?.profileId, how: findOpener(s, t("10:21"))?.how },
    { who: OPENER, how: "opening_shift" },
  );
});

test("the person on the opening shift counts when the fob leaves the punch unlinked", () => {
  const s = snap([shift(OPENER, "10:00", "16:00", "PENN Opener")], [punch(OPENER, "10:34", null)]);
  assert.equal(findOpener(s, t("10:35"))?.profileId, OPENER);
});

test("a later store shift is not the opening shift: the closer clocking in is not the opener", () => {
  const closing = shift(CLOSER, "16:00", "23:00", "PENN Closer");
  const s = snap([shift(OPENER, "10:00", "16:00", "PENN Opener"), closing], [punch(CLOSER, "15:55", null, closing.id)]);
  assert.equal(findOpener(s, t("16:00")), null);
});

test("someone covering the opener: a punch with no shift around opening, taken half an hour after opening", () => {
  const s = snap([shift(OPENER, "10:00", "16:00", "PENN Opener")], [punch(COVER, "10:26", null)]);
  assert.equal(findOpener(s, t("11:15")), null, "the scheduled opener may still turn up");
  assert.deepEqual(
    { who: findOpener(s, t("11:30"))?.profileId, how: findOpener(s, t("11:30"))?.how },
    { who: COVER, how: "unscheduled" },
  );
  // A punch after the half hour is not taken as a cover.
  const late = snap([shift(OPENER, "10:00", "16:00", "PENN Opener")], [punch(COVER, "11:52", null)]);
  assert.equal(findOpener(late, t("12:00")), null);
});

test("a punch for a catering shift with no deal is not a cover", () => {
  const s = snap([shift(CATERER, "10:00", "14:00", "Catering")], [punch(CATERER, "10:05", null)]);
  assert.equal(findOpener(s, t("11:30")), null);
});

test("the closer is the one person on the clock at closing; a catering punch still open is left out", () => {
  const closing = shift(CLOSER, "16:00", "23:00", "PENN Closer");
  const event = shift(CATERER, "17:00", "23:30", "Catering", 78);
  const s = snap(
    [closing, event],
    [punch(OPENER, "10:00", "16:05"), punch(CLOSER, "15:58", null, closing.id), punch(CATERER, "17:05", null, event.id)],
  );
  assert.deepEqual(findClosers(s), { profileIds: [CLOSER], how: "on_clock" });
});

test("two people on the clock at closing are both closers (owner to rule which one is the lead)", () => {
  const closing = shift(CLOSER, "16:00", "23:00", "PENN Closer");
  const s = snap([closing], [punch(MANAGER, "12:16", null), punch(CLOSER, "15:58", null, closing.id)]);
  assert.deepEqual(findClosers(s)?.profileIds, [MANAGER, CLOSER]);
});

test("nobody on the clock at closing: the person on the store shift running at closing", () => {
  const s = snap([shift(CLOSER, "16:00", "23:00", "PENN Closer"), shift(CATERER, "18:00", "23:00", "Catering")], []);
  assert.deepEqual(findClosers(s), { profileIds: [CLOSER], how: "scheduled" });
  assert.equal(findClosers(snap([], [])), null);
});

test("someone who clocked out before closing, or a punch left open since the morning before, is not a closer", () => {
  const s = snap([], [punch(OPENER, "16:00", "21:50"), { ...punch(OFFICE, "05:00", null), clock_in_at: at("05:00") }]);
  assert.equal(findClosers(s), null);
});

test("the opening reminder: once the opener has clocked in, and not two hours later (the cron was off)", () => {
  const opening = shift(OPENER, "10:00", "16:00", "PENN Opener");
  const s = snap([opening], [punch(OPENER, "10:20", null, opening.id)]);
  const none = new Set<Plan.ReminderKind>();
  assert.deepEqual(dueReminders(s, t("10:15"), none), []);
  assert.deepEqual(dueReminders(s, t("10:22"), none), [{ kind: "open", profileIds: [OPENER], why: "opening_shift" }]);
  assert.deepEqual(dueReminders(s, t("12:21"), none), [], "stale");
  assert.deepEqual(dueReminders(s, t("10:22"), new Set(["open"])), [], "already sent today");
});

test("a cover who clocked in early is reminded half an hour after opening, not dropped as stale", () => {
  // Clocked in at 9:10 with no shift; taken as the opener at 11:30, which is
  // more than two hours after the punch. The reminder is due from 11:30.
  const s = snap([shift(OPENER, "10:00", "16:00", "PENN Opener")], [punch(COVER, "09:10", null)]);
  const none = new Set<Plan.ReminderKind>();
  assert.deepEqual(dueReminders(s, t("11:25"), none), [], "the scheduled opener may still turn up");
  assert.deepEqual(dueReminders(s, t("11:30"), none), [{ kind: "open", profileIds: [COVER], why: "unscheduled" }]);
  assert.deepEqual(dueReminders(s, t("13:31"), none), [], "two hours after it was due, it is stale");
});

test("the closing reminder: from closing time to an hour and a half after", () => {
  const closing = shift(CLOSER, "16:00", "23:00", "PENN Closer");
  const s = snap([closing], [punch(CLOSER, "15:58", null, closing.id)]);
  const none = new Set<Plan.ReminderKind>();
  assert.deepEqual(dueReminders(s, t("21:59"), none), []);
  assert.deepEqual(dueReminders(s, t("22:03"), none), [{ kind: "close", profileIds: [CLOSER], why: "on_clock" }]);
  assert.deepEqual(dueReminders(s, t("23:31"), none), []);
  assert.deepEqual(dueReminders(s, t("22:03"), new Set(["close"])), []);
});

test("the follow-up waits 30 minutes, then checks, and is skipped past two hours", () => {
  const posted = t("10:22");
  assert.equal(followupStep(posted, posted + 29 * 60_000), "wait");
  assert.equal(followupStep(posted, posted + 30 * 60_000), "check");
  assert.equal(followupStep(posted, posted + 120 * 60_000), "check");
  assert.equal(followupStep(posted, posted + 121 * 60_000), "expired");
});
