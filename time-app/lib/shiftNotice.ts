// What an employee is told about a shift of theirs: "New shift posted" when
// the shift is new to them, "Your shift was updated" when one they already
// had was edited. Every route that writes a shift says it through here, so
// the message types, titles and the one-line shift summary are defined once.
//
// The send is best-effort: a notification that cannot go out never fails the
// write that has already been made.
import { notify, emailForUser } from "@/lib/notify";
import { fmtDate, fmtTime } from "@/lib/format";

export type ShiftNotice = "posted" | "changed";

const MESSAGE: Record<ShiftNotice, { type: string; title: string }> = {
  posted: { type: "shift_published", title: "New shift posted" },
  changed: { type: "schedule_change", title: "Your shift was updated" },
};

export async function tellEmployeeAboutShift(
  notice: ShiftNotice,
  shift: { employee_id: string; starts_at: string; ends_at: string; position: string | null },
  phone: string | null,
): Promise<void> {
  const email = await emailForUser(shift.employee_id);
  await notify({
    userId: shift.employee_id,
    ...MESSAGE[notice],
    body: `${fmtDate(shift.starts_at)} · ${fmtTime(shift.starts_at)}–${fmtTime(shift.ends_at)}${shift.position ? " · " + shift.position : ""}`,
    phone,
    email,
  }).catch(() => {});
}
