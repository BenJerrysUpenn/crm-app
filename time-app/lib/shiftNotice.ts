// What an employee is told about a shift of theirs, and when. Every route that
// writes a shift says it through tellEmployeeAboutShift, so the message types,
// titles and the one-line shift summary are defined once.
//
// "New shift posted" (shift_published) when the shift is new to them, "Your
// shift was updated" (schedule_change) when one they already had was edited.
//
// ONE SUMMARY A DAY (Alina, 2026-10-08). Saving a shift puts it on the
// person's bell straight away (the in-app row, as before) and queues it in
// shift_notices (migration 38); it sends no email or text. At 8pm New York
// time the missed-clock-in cron, hit every few minutes from outside
// (ALEX-CRON-SETUP.md), calls sendShiftDigests: each person with queued
// shifts gets one email and one text listing them, as each shift stands
// then. Five saves of one shift are one line with the final times; a shift
// deleted or moved to someone else by then is left out. Everything waits for
// 8pm, an edit to a shift that starts within the hour included.
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

export type ShiftNotice = "posted" | "changed";

const MESSAGE: Record<ShiftNotice, { type: string; title: string }> = {
  posted: { type: "shift_published", title: "New shift posted" },
  changed: { type: "schedule_change", title: "Your shift was updated" },
};

const LINE_LABEL: Record<ShiftNotice, string> = { posted: "New", changed: "Changed" };

export const DIGEST_TITLE = "Your shift updates";

const TZ = "America/New_York";
const DIGEST_HOUR = 20;

type ShiftRow = { id: number; employee_id: string | null; starts_at: string; ends_at: string; position: string | null };

function summary(shift: Pick<ShiftRow, "starts_at" | "ends_at" | "position">): string {
  return `${fmtDate(shift.starts_at)} · ${fmtTime(shift.starts_at)}–${fmtTime(shift.ends_at)}${shift.position ? " · " + shift.position : ""}`;
}

export async function tellEmployeeAboutShift(
  notice: ShiftNotice,
  shift: { id: number; employee_id: string; starts_at: string; ends_at: string; position: string | null },
): Promise<void> {
  const { error } = await createAdminClient()
    .from("shift_notices")
    .insert({ shift_id: shift.id, employee_id: shift.employee_id, notice });
  if (error) console.error(`shift ${shift.id}: could not queue the ${notice} notice: ${error.message}`);
  // No email or phone: the bell alone now, by email and text at 8pm.
  await notify({
    userId: shift.employee_id,
    ...MESSAGE[notice],
    body: summary(shift),
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

type Claimed = { employee_id: string; shift_id: number; notice: ShiftNotice };

// One person's summary lines, from their claimed notices and the shifts as
// they stand now. A shift is "New" if any save made it new to them that day.
function digestLines(employeeId: string, notices: Claimed[], shifts: Map<number, ShiftRow>, prefs: NotifPrefs): string[] {
  const noticeOf = new Map<number, ShiftNotice>();
  for (const n of notices) {
    if (noticeOf.get(n.shift_id) !== "posted") noticeOf.set(n.shift_id, n.notice);
  }
  return [...noticeOf]
    .map(([shiftId, notice]) => ({ shift: shifts.get(shiftId), notice }))
    .filter(
      (x): x is { shift: ShiftRow; notice: ShiftNotice } =>
        !!x.shift &&
        x.shift.employee_id === employeeId &&
        wants(prefs, MESSAGE[x.notice].type),
    )
    .sort((a, b) => new Date(a.shift.starts_at).getTime() - new Date(b.shift.starts_at).getTime())
    .map((x) => `${LINE_LABEL[x.notice]}: ${summary(x.shift)}`);
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
  const claimed = (data ?? []) as Claimed[];
  if (!claimed.length) return { told: [], error: null };

  const employeeIds = [...new Set(claimed.map((c) => c.employee_id))];
  const shiftIds = [...new Set(claimed.map((c) => c.shift_id))];
  const [shiftsRead, peopleRead] = await Promise.all([
    supabase.from("shifts").select("id, employee_id, starts_at, ends_at, position").in("id", shiftIds),
    supabase.from("profiles").select("id, phone, notif_prefs").in("id", employeeIds),
  ]);
  if (shiftsRead.error || peopleRead.error) {
    // Today's summaries are claimed, so put the notices back for tomorrow's
    // rather than lose them.
    await supabase.from("shift_notices").insert(claimed.map(({ employee_id, shift_id, notice }) => ({ employee_id, shift_id, notice })));
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
