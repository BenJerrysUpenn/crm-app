// Who the cash count reminders in Slack #cash-count go to, and when. Pure: the
// cron (lib/cashCount/run.ts) loads one store day from the database and asks
// these functions; nothing here reads a clock, the database or Slack.
//
// The owner's rules (2026-10-29):
//   * OPEN. After the person opening the store clocks in, @mention them to
//     post the opening counts.
//   * CLOSE. Just after closing, @mention the one person closing to post the
//     closing counts.
//   * FOLLOW-UP. If nobody has posted 30 minutes after a reminder, @mention
//     them once more. Managers are not alerted; they can see the channel.
//
// "Store shift" is the time app's own word for it: a published shift with no
// catering deal (deal_id) whose shift type is in-store (shift_types.in_store,
// set on the Team page; a blank or unknown type counts as in-store, as the
// coverage check reads it). Catering, Marketing and Staff Meeting are not.
//
// THE OPENER. Production 2026-09-30..10-29: the first clock-in of the day is
// often not the opener (an office punch at 8am, a catering punch), so it is
// the first clock-in that is FOR the opening shift. An opening shift is a
// store shift that is running when the store opens (starts at or before the
// opening time, ends after it). A punch is for it when it is linked to it, or
// when the person on it clocks in without a link (the fob does that). If by
// half an hour after opening nobody on an opening shift has clocked in, the
// first punch between two hours before opening and half an hour after it
// with no shift at all is taken: someone covering the opener (it happened
// three times in those 30 days).
//
// THE CLOSER. There is no lead role: profiles.role is owner/manager/employee
// and shift positions are free text. ONE person is mentioned at close (the
// owner's ruling, 2026-10-29). Everyone on the clock at closing on a store
// punch (not a catering or other non-store shift) is a candidate:
//   * exactly one: them;
//   * several: the one whose punch is for a closing shift (a store shift
//     running at closing), by its link or, unlinked, the clock's own link
//     rule (shiftForEntry); if several are, or none is, the one who clocked
//     in most recently;
//   * nobody (a missed punch): the scheduled closer, the person on the store
//     shift running at closing (the latest-starting one if there are two).
// The follow-up goes to the same person.
//
// THE OPENER needs no such rule: the baker on Pastry Opener, an in-store type
// running at opening, opens the store (the owner's ruling, 2026-10-29).
//
// STORE HOURS come from the time app (store_hours, store_hours_seasons,
// store_hours_exceptions and "Business closed" annotations), through
// lib/coverage.ts resolveOpenWindow. A closed or unset day gets no reminders.

import { nyWallClock, type OpenWindow } from "../coverage";

export const MIN = 60_000;
/** The follow-up is due this long after a reminder. */
export const FOLLOWUP_AFTER_MIN = 30;
/** Later than this after a reminder, the follow-up is skipped: the machine running the cron was off. */
export const FOLLOWUP_STALE_MIN = 120;
/** Punches this long before opening can be the opener's. */
export const OPENER_LEAD_MIN = 120;
/** How long after opening to wait before taking a punch with no shift as the opener's. */
export const OPENER_UNSCHEDULED_AFTER_MIN = 30;
/** An opening reminder is not sent more than this long after the punch it answers (the cron was off). */
export const OPEN_REMINDER_STALE_MIN = 120;
/** The closing reminder is sent from closing time until this long after it. */
export const CLOSE_REMINDER_WINDOW_MIN = 90;
/** An unlinked punch belongs to the person's own shift that starts within this of it (the clock's link rule). */
const LINK_WINDOW_MIN = 4 * 60;
/** A punch still open at closing that began longer ago than this is a forgotten clock-out, not a closer. */
export const MAX_PUNCH_MIN = 16 * 60;

export type PlanShift = {
  id: number;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  deal_id: number | null;
  published: boolean;
};

export type PlanEntry = {
  id: number;
  employee_id: string;
  shift_id: number | null;
  clock_in_at: string;
  clock_out_at: string | null;
};

export type StoreDay = {
  /** New York date, YYYY-MM-DD. */
  date: string;
  /** Instants (ms) the store opens and closes that day. */
  openAt: number;
  closeAt: number;
};

/** One store day's punches and shifts, as the cron loads them. */
export type DaySnapshot = {
  day: StoreDay;
  shifts: PlanShift[];
  entries: PlanEntry[];
  /** shift_types.in_store by name. */
  inStoreByName: Map<string, boolean>;
};

// ---- time ------------------------------------------------------------------

/** The instant (ms) New York wall clock reads `minutes` past midnight on `date`. */
export function nyInstant(date: string, minutes: number): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MIN;
  // New York is UTC-4 or UTC-5; correct a first guess by the offset it lands on.
  let guess = wall + 5 * 60 * MIN;
  for (let i = 0; i < 2; i++) {
    const seen = nyWallClock(new Date(guess).toISOString());
    const [sy, sm, sd] = seen.date.split("-").map(Number);
    const seenWall = Date.UTC(sy, sm - 1, sd) + seen.minutes * MIN;
    guess += wall - seenWall;
  }
  return guess;
}

/** The store day for a resolved open window, or null when the store is closed or its hours are unset. */
export function storeDay(date: string, window: OpenWindow): StoreDay | null {
  if (window.state !== "open") return null;
  return { date, openAt: nyInstant(date, window.opens), closeAt: nyInstant(date, window.closes) };
}

// ---- shifts ----------------------------------------------------------------

const ms = (iso: string) => new Date(iso).getTime();

export function isStoreShift(shift: PlanShift, inStoreByName: Map<string, boolean>): boolean {
  if (!shift.published || shift.deal_id != null) return false;
  const position = shift.position?.trim();
  if (!position) return true;
  return inStoreByName.get(position) !== false;
}

/** The shift a punch is for: its link, else the person's own shift starting within four hours of it. */
export function shiftForEntry(entry: PlanEntry, shifts: PlanShift[]): PlanShift | null {
  if (entry.shift_id != null) return shifts.find((s) => s.id === entry.shift_id) ?? null;
  const at = ms(entry.clock_in_at);
  let best: PlanShift | null = null;
  for (const s of shifts) {
    if (s.employee_id !== entry.employee_id || !s.published) continue;
    const gap = Math.abs(ms(s.starts_at) - at);
    if (gap > LINK_WINDOW_MIN * MIN) continue;
    if (!best || gap < Math.abs(ms(best.starts_at) - at)) best = s;
  }
  return best;
}

function isOpeningShift(s: PlanShift, snap: DaySnapshot): boolean {
  return (
    s.employee_id != null &&
    isStoreShift(s, snap.inStoreByName) &&
    ms(s.starts_at) <= snap.day.openAt &&
    ms(s.ends_at) > snap.day.openAt
  );
}

// ---- the opener ------------------------------------------------------------

export type Opener = {
  profileId: string;
  /** The punch the reminder answers. */
  entryId: number;
  clockInAt: number;
  how: "opening_shift" | "unscheduled";
};

/** The person opening the store, if anyone has clocked in for it yet, as of `now`. */
export function findOpener(snap: DaySnapshot, now: number): Opener | null {
  const { openAt, closeAt } = snap.day;
  const from = openAt - OPENER_LEAD_MIN * MIN;
  const punches = snap.entries
    .filter((e) => {
      const at = ms(e.clock_in_at);
      return at >= from && at < closeAt && at <= now;
    })
    .sort((a, b) => ms(a.clock_in_at) - ms(b.clock_in_at));

  const openingShifts = snap.shifts.filter((s) => isOpeningShift(s, snap));
  for (const e of punches) {
    const linked = e.shift_id != null ? snap.shifts.find((s) => s.id === e.shift_id) : null;
    const forOpening = linked
      ? openingShifts.includes(linked)
      : openingShifts.some((s) => s.employee_id === e.employee_id);
    if (forOpening) return { profileId: e.employee_id, entryId: e.id, clockInAt: ms(e.clock_in_at), how: "opening_shift" };
  }

  // Nobody on an opening shift yet: half an hour after opening, someone
  // with no shift at all who clocked in around opening is covering it.
  const cutoff = openAt + OPENER_UNSCHEDULED_AFTER_MIN * MIN;
  if (now < cutoff) return null;
  for (const e of punches) {
    if (ms(e.clock_in_at) > cutoff) break;
    if (shiftForEntry(e, snap.shifts)) continue;
    return { profileId: e.employee_id, entryId: e.id, clockInAt: ms(e.clock_in_at), how: "unscheduled" };
  }
  return null;
}

/** When the opening reminder for this opener is due: at once for an opening-shift punch, at the cutoff for a cover. */
export function openReminderDueAt(snap: DaySnapshot, opener: Opener): number {
  return opener.how === "opening_shift"
    ? opener.clockInAt
    : Math.max(opener.clockInAt, snap.day.openAt + OPENER_UNSCHEDULED_AFTER_MIN * MIN);
}

// ---- the closer ------------------------------------------------------------

export type Closer = { profileId: string; how: "on_clock" | "closing_shift" | "latest_punch" | "scheduled" };

function isClosingShift(s: PlanShift, snap: DaySnapshot): boolean {
  const { closeAt } = snap.day;
  return s.employee_id != null && isStoreShift(s, snap.inStoreByName) && ms(s.starts_at) < closeAt && ms(s.ends_at) >= closeAt;
}

/** The one person closing: see THE CLOSER above. Null when nobody is on the clock or on a closing shift. */
export function findCloser(snap: DaySnapshot): Closer | null {
  const { closeAt } = snap.day;
  // Store punches open at closing, latest clock-in first.
  const onClock: { entry: PlanEntry; shift: PlanShift | null }[] = [];
  for (const e of [...snap.entries].sort((a, b) => ms(b.clock_in_at) - ms(a.clock_in_at))) {
    const inAt = ms(e.clock_in_at);
    if (inAt > closeAt || inAt < closeAt - MAX_PUNCH_MIN * MIN) continue;
    if (e.clock_out_at && ms(e.clock_out_at) < closeAt) continue;
    const shift = shiftForEntry(e, snap.shifts);
    if (shift && !isStoreShift(shift, snap.inStoreByName)) continue;
    onClock.push({ entry: e, shift });
  }
  const people = new Set(onClock.map((p) => p.entry.employee_id));
  if (people.size === 1) return { profileId: onClock[0].entry.employee_id, how: "on_clock" };
  if (people.size > 1) {
    const closing = onClock.find((p) => p.shift && isClosingShift(p.shift, snap));
    if (closing) return { profileId: closing.entry.employee_id, how: "closing_shift" };
    return { profileId: onClock[0].entry.employee_id, how: "latest_punch" };
  }

  const scheduled = snap.shifts
    .filter((s) => isClosingShift(s, snap))
    .sort((a, b) => ms(b.starts_at) - ms(a.starts_at) || a.id - b.id)[0];
  return scheduled?.employee_id ? { profileId: scheduled.employee_id, how: "scheduled" } : null;
}

// ---- what is due -----------------------------------------------------------

export type ReminderKind = "open" | "close";

export type DueReminder = { kind: ReminderKind; profileIds: string[]; why: string };

/** The opening and closing reminders due at `now` that have not gone out (`sent` holds the kinds already recorded today). */
export function dueReminders(snap: DaySnapshot, now: number, sent: Set<ReminderKind>): DueReminder[] {
  const due: DueReminder[] = [];
  if (!sent.has("open")) {
    const opener = findOpener(snap, now);
    if (opener) {
      const at = openReminderDueAt(snap, opener);
      if (now >= at && now - at <= OPEN_REMINDER_STALE_MIN * MIN && now < snap.day.closeAt) {
        due.push({ kind: "open", profileIds: [opener.profileId], why: opener.how });
      }
    }
  }
  if (!sent.has("close")) {
    const { closeAt } = snap.day;
    if (now >= closeAt && now - closeAt <= CLOSE_REMINDER_WINDOW_MIN * MIN) {
      const closer = findCloser(snap);
      if (closer) due.push({ kind: "close", profileIds: [closer.profileId], why: closer.how });
    }
  }
  return due;
}

export type FollowupStep = "wait" | "check" | "expired";

/** What to do about a reminder's follow-up at `now`. "check" means: look for a post, and nudge if there is none. */
export function followupStep(postedAt: number, now: number): FollowupStep {
  const age = now - postedAt;
  if (age < FOLLOWUP_AFTER_MIN * MIN) return "wait";
  if (age > FOLLOWUP_STALE_MIN * MIN) return "expired";
  return "check";
}
