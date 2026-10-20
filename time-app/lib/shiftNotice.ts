// What an employee is told about a shift of theirs, and when. Every route that
// writes a shift says it through tellEmployeeAboutShift (or, when a shift is
// taken away from someone, tellEmployeeShiftRemoved), so the message types,
// titles and the one-line shift summary are defined once.
//
// "New shift posted" (shift_published) when the shift is new to them, "Your
// shift was updated" (schedule_change) when one they already had was edited,
// "Your shift was removed" (schedule_change too) when a manager deletes it or
// moves it to someone else (bj-finance #754).
//
// ONE SUMMARY A DAY (Alina, 2026-10-08). Saving a shift puts it on the
// person's bell straight away (the in-app row, as before) and queues it in
// shift_notices (migration 38); it sends no email or text. At 8pm New York
// time the missed-clock-in cron, hit every few minutes from outside
// (ALEX-CRON-SETUP.md), calls sendShiftDigests: each person with queued
// shifts gets one email and one text listing them, as each shift stands
// then. Five saves of one shift are one line with the final times.
// Everything waits for 8pm, an edit to a shift that starts within the hour
// included.
//
// EVERY LINE LEADS WITH THE DAY ("Tue, Oct 13 · Changed · 1:00 PM–6:00 PM"),
// so the summary says which day was updated (bj-finance #754).
//
// REMOVED (migration 48). A shift deleted, or moved to someone else, since the
// person's last summary is a "Removed" line with the day and times they had.
// The removed notice keeps those itself (the shift may be gone). Two cases say
// nothing new: a shift new to them since their last summary and taken away
// again (they were never emailed about it; the bell has both), and a shift
// moved away and back again, which reads as changed. A drop the person asked
// for is not a removal: its approval tells them itself (api/shift-requests).
//
// notif_prefs are read at 8pm and applied as notify() applies them: a line is
// left out when its type (shift_published / schedule_change) is switched off,
// and the summary goes only by the channels (email / sms) left on.
//
// Best-effort, as before: a notice that cannot be queued never fails the
// write that has already been made.
import { createAdminClient } from "@/lib/supabase/admin";
import { emailForUser, notify, sendOnChannels, wants, type NotifPrefs } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";

export type ShiftNotice = "posted" | "changed" | "removed";

const MESSAGE: Record<ShiftNotice, { type: string; title: string }> = {
  posted: { type: "shift_published", title: "New shift posted" },
  changed: { type: "schedule_change", title: "Your shift was updated" },
  removed: { type: "schedule_change", title: "Your shift was removed" },
};

const LINE_LABEL: Record<ShiftNotice, string> = { posted: "New", changed: "Changed", removed: "Removed" };

export const DIGEST_TITLE = "Your shift updates";

const TZ = "America/New_York";
const DIGEST_HOUR = 20;

type ShiftRow = { id: number; employee_id: string | null; starts_at: string; ends_at: string; position: string | null };
type ShiftTimes = Pick<ShiftRow, "starts_at" | "ends_at" | "position">;

function times(shift: ShiftTimes): string {
  return `${fmtTime(shift.starts_at)}–${fmtTime(shift.ends_at)}${shift.position ? " · " + shift.position : ""}`;
}

function summary(shift: ShiftTimes): string {
  return `${fmtDate(shift.starts_at)} · ${times(shift)}`;
}

/** One summary line: the day first, then what happened, then the times. */
function digestLine(notice: ShiftNotice, shift: ShiftTimes): string {
  return `${fmtDate(shift.starts_at)} · ${LINE_LABEL[notice]} · ${times(shift)}`;
}

export async function tellEmployeeAboutShift(
  notice: Exclude<ShiftNotice, "removed">,
  shift: { id: number; employee_id: string; starts_at: string; ends_at: string; position: string | null },
): Promise<void> {
  const { error } = await createAdminClient()
    .from("shift_notices")
    .insert({ shift_id: shift.id, employee_id: shift.employee_id, notice });
  if (error) console.error(`shift ${shift.id}: could not queue the ${notice} notice: ${error.message}`);
  await notify({
    userId: shift.employee_id,
    ...MESSAGE[notice],
    body: summary(shift),
    inAppOnly: true,
  }).catch(() => {});
}

// Is this shift new to this person since their last summary (a "posted"
// notice for it is still queued)? Ask BEFORE deleting a shift: the delete
// takes its queued notices with it (ON DELETE CASCADE, migration 38).
export async function shiftNewToThem(employeeId: string, shiftId: number): Promise<boolean> {
  const pending = await createAdminClient()
    .from("shift_notices")
    .select("id")
    .eq("shift_id", shiftId)
    .eq("employee_id", employeeId)
    .eq("notice", "posted")
    .limit(1);
  return !pending.error && (pending.data ?? []).length > 0;
}

// A shift `employeeId` had was deleted, or moved to someone else. `shift` is
// how they had it: its id and its times before the change. Queued for their
// 8pm summary, unless the shift was new to them since their last summary
// (newToThem; asked here when not given): then they were never emailed about
// it, and the summary says nothing. The bell hears it either way.
export async function tellEmployeeShiftRemoved(
  employeeId: string,
  shift: { id: number; starts_at: string; ends_at: string; position: string | null },
  newToThem?: boolean,
): Promise<void> {
  const supabase = createAdminClient();
  if (!(newToThem ?? (await shiftNewToThem(employeeId, shift.id)))) {
    const { error } = await supabase.from("shift_notices").insert({
      shift_id: null,
      employee_id: employeeId,
      notice: "removed",
      former_shift_id: shift.id,
      starts_at: shift.starts_at,
      ends_at: shift.ends_at,
      position: shift.position,
    });
    if (error) console.error(`shift ${shift.id}: could not queue the removed notice: ${error.message}`);
  }
  await notify({
    userId: employeeId,
    ...MESSAGE.removed,
    body: summary(shift),
    inAppOnly: true,
  }).catch(() => {});
}

// The New York day whose 8pm summary is due at this instant: that day from
// 20:00 until midnight, otherwise null. Intl applies the clock changes, so 8pm
// is 00:00 UTC in summer and 01:00 UTC in winter.
export function digestDayAt(nowMs: number): string | null {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(nowMs))
      .map((p) => [p.type, p.value]),
  );
  if (Number(parts.hour) < DIGEST_HOUR) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// A notice as claim_shift_digests returns it. Before migration 48 only
// employee_id, shift_id and notice come back (and no removed notice exists).
type Claimed = {
  id?: number | null;
  employee_id: string;
  shift_id: number | null;
  notice: ShiftNotice;
  former_shift_id?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  position?: string | null;
};

const shiftKey = (n: Claimed): number | null => n.shift_id ?? n.former_shift_id ?? null;

// One person's summary lines, from their claimed notices (oldest first) and
// the shifts as they stand now.
//   * Theirs now: "New" if any save made it new to them since their last
//     summary, else "Changed". A shift moved away and back again is changed:
//     its first notice is the removal.
//   * Not theirs now: "Removed", with the day and times they had, when a
//     removed notice says it was taken away. (A shift new to them since the
//     last summary and taken away again has none.)
function digestLines(employeeId: string, notices: Claimed[], shifts: Map<number, ShiftRow>, prefs: NotifPrefs): string[] {
  const byShift = new Map<number, Claimed[]>();
  for (const n of notices) {
    const key = shiftKey(n);
    if (key === null) continue;
    byShift.set(key, [...(byShift.get(key) ?? []), n]);
  }
  const lines: { at: number; text: string }[] = [];
  for (const [shiftId, ns] of byShift) {
    const shift = shifts.get(shiftId);
    if (shift && shift.employee_id === employeeId) {
      const notice: ShiftNotice = ns[0].notice !== "removed" && ns.some((n) => n.notice === "posted") ? "posted" : "changed";
      if (!wants(prefs, MESSAGE[notice].type)) continue;
      lines.push({ at: new Date(shift.starts_at).getTime(), text: digestLine(notice, shift) });
      continue;
    }
    const removed = [...ns].reverse().find((n) => n.notice === "removed" && n.starts_at && n.ends_at);
    if (!removed || !wants(prefs, MESSAGE.removed.type)) continue;
    const had: ShiftTimes = { starts_at: removed.starts_at!, ends_at: removed.ends_at!, position: removed.position ?? null };
    lines.push({ at: new Date(had.starts_at).getTime(), text: digestLine("removed", had) });
  }
  return lines.sort((a, b) => a.at - b.at).map((l) => l.text);
}

// Sends the day's summaries if it is 8pm or later in New York. Safe on every
// cron tick: claim_shift_digests (migration 38) hands each person's queued
// notices to exactly one caller once per day, so repeated or overlapping
// ticks send each summary once. Returns who was sent one.
export async function sendShiftDigests(now: number = Date.now()): Promise<{ told: string[]; error: string | null }> {
  const day = digestDayAt(now);
  if (!day) return { told: [], error: null };

  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("claim_shift_digests", { p_day: day });
  if (error) return { told: [], error: error.message };
  // Oldest first (the queue id, migration 48), so "a shift's first notice"
  // means what it says. Before migration 48 there is no id: as returned.
  const claimed = ((data ?? []) as Claimed[])
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.id ?? a.i) - (b.c.id ?? b.i))
    .map((x) => x.c);
  if (!claimed.length) return { told: [], error: null };

  const employeeIds = [...new Set(claimed.map((c) => c.employee_id))];
  const shiftIds = [...new Set(claimed.map(shiftKey).filter((k): k is number => k !== null))];
  const [shiftsRead, peopleRead] = await Promise.all([
    supabase.from("shifts").select("id, employee_id, starts_at, ends_at, position").in("id", shiftIds),
    supabase.from("profiles").select("id, phone, notif_prefs").in("id", employeeIds),
  ]);
  if (shiftsRead.error || peopleRead.error) {
    // Today's summaries are claimed, so put the notices back for tomorrow's
    // rather than lose them.
    await supabase.from("shift_notices").insert(
      claimed.map(({ employee_id, shift_id, notice, former_shift_id, starts_at, ends_at, position }) =>
        notice === "removed"
          ? { employee_id, shift_id: null, notice, former_shift_id, starts_at, ends_at, position }
          : { employee_id, shift_id, notice },
      ),
    );
    return { told: [], error: (shiftsRead.error ?? peopleRead.error)!.message };
  }

  const shifts = new Map(((shiftsRead.data ?? []) as ShiftRow[]).map((s) => [s.id, s]));
  const people = new Map(
    ((peopleRead.data ?? []) as { id: string; phone: string | null; notif_prefs: NotifPrefs | null }[]).map((p) => [p.id, p]),
  );

  const told: string[] = [];
  for (const employeeId of employeeIds) {
    const person = people.get(employeeId);
    const prefs = person?.notif_prefs ?? {};
    const lines = digestLines(employeeId, claimed.filter((c) => c.employee_id === employeeId), shifts, prefs);
    if (!lines.length) continue;
    const email = await emailForUser(employeeId);
    await sendOnChannels({ prefs, title: DIGEST_TITLE, body: lines.join("\n"), email, phone: person?.phone ?? null }).catch(() => {});
    told.push(employeeId);
  }
  return { told, error: null };
}
