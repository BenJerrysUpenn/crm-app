import {
  addDays,
  checkWeekCoverage,
  formatClock,
  formatDayLabel,
  parseTime,
  shiftsTouchingWeek,
  weekdayOf,
  type ClosedDateRange,
  type CoverageShift,
  type ShiftTypeCoverage,
  type StoreHoursException,
  type StoreHoursRow,
} from "../time-app/lib/coverage";
import { BOOKED_STAGES } from "@/lib/cateringShifts";

// The schedule coverage reminder (bj-finance #709): every Thursday and Friday
// at noon, list every open store hour and every booked catering event in the
// next two Sun–Sat weeks that nobody is scheduled for. This file is the pure
// part: rows in, email lines out. lib/coverageReminderCli.ts runs it;
// lib/coverageReminderPg.ts reads the rows.
//
// Store hours are judged by time-app/lib/coverage.ts, the same function the
// "Check week" button runs, so the reminder and the button cannot disagree.
// It is imported by relative path: the root tsconfig excludes time-app from
// its own file list, but a file reached through an import is still compiled,
// and coverage.ts imports nothing.

export type ReminderWindow = {
  weekStarts: [string, string];
  start: string; // the first Sunday, YYYY-MM-DD
  end: string; // the last Saturday, inclusive
};

/**
 * The next two full Sun–Sat weeks after `runDate` (a New York YYYY-MM-DD).
 * Thursday and Friday land on the same two weeks.
 */
export function reminderWindow(runDate: string): ReminderWindow {
  const first = addDays(runDate, 7 - weekdayOf(runDate));
  return { weekStarts: [first, addDays(first, 7)], start: first, end: addDays(first, 13) };
}

/** A shifts row as the reminder reads it. Only published rows cover. */
export type ReminderShift = CoverageShift & { published: boolean };

/**
 * The catering stages that mean an event is happening, matching
 * Catering-Manager staffing/event_staffing.py ALERT_STAGES: the booked stages
 * plus Closed Marketing Event. That one is not a mistake: marketing events
 * (wedding shows, tabling) are booked as deals and sit at that stage while
 * they still need staff.
 */
export const ALERT_STAGES = [...BOOKED_STAGES, "Closed Marketing Event"];

/** A deals row as the reminder reads it. Times are the deal's "HH:MM" text. */
export type ReminderDeal = {
  id: number;
  stage: string;
  archived: number;
  event_date: string | null;
  event_start_time: string | null;
  event_end_time: string | null;
};

/** A shift that belongs to a catering deal (shifts.deal_id). */
export type ReminderDealShift = { deal_id: number; employee_id: string | null; published: boolean };

/** Everything one run reads. Nothing is carried between runs. */
export type ReminderSnapshot = {
  storeHours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  closedRanges: ClosedDateRange[];
  shiftTypes: ShiftTypeCoverage[];
  /** Shifts around the window, for the store check. */
  shifts: ReminderShift[];
  /** Deals whose event_date falls in the window, any stage. */
  deals: ReminderDeal[];
  /** Every shift on those deals. */
  dealShifts: ReminderDealShift[];
};

/** "2:00–6:00 PM", or "11:00 AM–2:00 PM" when the halves of the day differ. */
function formatRange(from: string, to: string): string {
  const a = formatClock(from);
  const b = formatClock(to);
  const [aTime, aSuffix] = a.split(" ");
  return aSuffix === b.split(" ")[1] ? `${aTime}–${b}` : `${a}–${b}`;
}

type Line = { date: string; minute: number; text: string };

/**
 * Booked events in the window that nobody is on. Covered = at least one
 * published shift on the deal has a person; a deal with no shifts at all (no
 * picklist yet, so the reconciler has made none) is a gap.
 */
function cateringLines(snapshot: ReminderSnapshot, window: ReminderWindow): Line[] {
  const covered = new Set(
    snapshot.dealShifts.filter((s) => s.published && s.employee_id).map((s) => s.deal_id),
  );
  const lines: Line[] = [];
  for (const deal of snapshot.deals) {
    const date = deal.event_date;
    if (!date || date < window.start || date > window.end) continue;
    if (!ALERT_STAGES.includes(deal.stage) || deal.archived !== 0 || covered.has(deal.id)) continue;
    const starts = parseTime(deal.event_start_time);
    const ends = parseTime(deal.event_end_time);
    const day = formatDayLabel(date);
    let text: string;
    if (starts === null) text = `${day} (catering, time not set)`;
    else if (ends === null) text = `${day}, ${formatClock(deal.event_start_time!)} (catering)`;
    else text = `${day}, ${formatRange(deal.event_start_time!, deal.event_end_time!)} (catering)`;
    // An event with no time sorts to the end of its day.
    lines.push({ date, minute: starts ?? 1440, text });
  }
  return lines;
}

/** The email's lines, one per gap, in date and time order. Empty = nothing to send. */
export function buildReminder(snapshot: ReminderSnapshot, runDate: string): string[] {
  const window = reminderWindow(runDate);
  const published = snapshot.shifts.filter((s) => s.published);
  const lines: Line[] = cateringLines(snapshot, window);
  for (const weekStart of window.weekStarts) {
    const { gaps } = checkWeekCoverage({
      weekStart,
      storeHours: snapshot.storeHours,
      exceptions: snapshot.exceptions,
      shiftTypes: snapshot.shiftTypes,
      shifts: shiftsTouchingWeek(published, weekStart),
      closedRanges: snapshot.closedRanges,
    });
    for (const gap of gaps) {
      lines.push({
        date: gap.date,
        minute: parseTime(gap.from)!,
        text: `${formatDayLabel(gap.date)}, ${formatRange(gap.from, gap.to)}`,
      });
    }
  }
  // Stable sort, catering first: on a tie the event line comes before the store line.
  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.minute - b.minute));
  return lines.map((l) => l.text);
}

export function reminderEmail(lines: string[]): { subject: string; body: string } | null {
  return lines.length === 0 ? null : { subject: "Schedule gaps", body: lines.join("\n") + "\n" };
}

/** One person as the recipient lookup reads them: profiles joined to auth.users. */
export type RecipientRow = {
  email: string | null;
  role: string;
  active: boolean;
  archived_at: string | null;
  banned_until: string | null;
};

/**
 * Who gets the reminder: every owner, plus every manager who is on the
 * schedule (active), leaving out anyone archived or banned. Owners are
 * active = false by design, so the active test applies to managers only.
 * notif_prefs is ignored. Addresses come from the database, never from code.
 */
export function selectRecipients(rows: RecipientRow[]): string[] {
  const emails = rows
    .filter((r) => r.role === "owner" || (r.role === "manager" && r.active))
    .filter((r) => r.archived_at === null && r.banned_until === null)
    .map((r) => r.email?.trim() ?? "")
    .filter((e) => e !== "");
  return [...new Set(emails)].sort();
}
