import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { fmtTime } from "@/lib/format";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Grace period: how many minutes after a shift start before we flag it.
const GRACE_MIN = 10;
// Look-back window so we don't re-scan ancient shifts.
const WINDOW_MIN = 180;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured -> allow (dev)
  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  return header === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}

export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const now = Date.now();
  const lower = new Date(now - WINDOW_MIN * 60000).toISOString();
  const upper = new Date(now - GRACE_MIN * 60000).toISOString();

  // Published shifts that started between window and grace cutoff.
  const { data: shifts, error } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, profiles(full_name, phone)")
    .eq("published", true)
    .gte("starts_at", lower)
    .lte("starts_at", upper);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const flagged: number[] = [];
  for (const s of shifts ?? []) {
    // Did the employee clock in around this shift?
    const winStart = new Date(new Date(s.starts_at).getTime() - 30 * 60000).toISOString();
    const { data: entry } = await supabase
      .from("time_entries")
      .select("id")
      .eq("employee_id", s.employee_id)
      .gte("clock_in_at", winStart)
      .limit(1)
      .maybeSingle();
    if (entry) continue;

    // Already notified for this shift today?
    const { data: existing } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "missed_clockin")
      .eq("user_id", s.employee_id)
      .gte("created_at", new Date(now - WINDOW_MIN * 60000).toISOString())
      .ilike("body", `%#${s.id}%`)
      .limit(1)
      .maybeSingle();
    if (existing) continue;

    const prof = (s as any).profiles;
    const name = prof?.full_name ?? "Employee";
    const phone = prof?.phone ?? null;
    const email = await emailForUser(s.employee_id);

    // Notify the employee.
    await notify({
      userId: s.employee_id,
      type: "missed_clockin",
      title: "You're not clocked in",
      body: `Your ${fmtTime(s.starts_at)} shift started and you haven't clocked in. (shift #${s.id})`,
      phone,
      email,
    }).catch(() => {});

    // Notify all managers.
    const { data: managers } = await supabase
      .from("profiles")
      .select("id, phone")
      .eq("role", "manager")
      .eq("active", true);
    for (const m of managers ?? []) {
      const mEmail = await emailForUser(m.id);
      await notify({
        userId: m.id,
        type: "missed_clockin",
        title: "Missed clock-in",
        body: `${name} hasn't clocked in for the ${fmtTime(s.starts_at)} shift. (shift #${s.id})`,
        phone: m.phone ?? null,
        email: mEmail,
      }).catch(() => {});
    }
    flagged.push(s.id as number);
  }

  // ---- Pre-shift reminders: shifts starting in the next REMIND_MIN minutes ----
  const REMIND_MIN = 30;
  const reminded: number[] = [];
  const { data: soon } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, profiles(full_name, phone)")
    .eq("published", true)
    .not("employee_id", "is", null)
    .gte("starts_at", new Date(now).toISOString())
    .lte("starts_at", new Date(now + REMIND_MIN * 60000).toISOString());
  for (const s of soon ?? []) {
    // Skip if already reminded for this shift.
    const { data: already } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "shift_reminder")
      .eq("user_id", s.employee_id)
      .ilike("body", `%#${s.id}%`)
      .limit(1)
      .maybeSingle();
    if (already) continue;
    const prof = (s as any).profiles;
    const email = await emailForUser(s.employee_id as string);
    await notify({
      userId: s.employee_id as string,
      type: "shift_reminder",
      title: "Shift starting soon",
      body: `Your ${fmtTime(s.starts_at)} shift${s.position ? " (" + s.position + ")" : ""} starts soon. Don't forget to clock in. (shift #${s.id})`,
      phone: prof?.phone ?? null,
      email,
    }).catch(() => {});
    reminded.push(s.id as number);
  }

  // Housekeeping: delete notifications older than 30 days so the bell stays tidy.
  await supabase
    .from("notifications")
    .delete()
    .lt("created_at", new Date(now - 30 * 24 * 3600000).toISOString());

  return NextResponse.json({ checked: shifts?.length ?? 0, flagged, reminded });
}
