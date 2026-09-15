import { createAdminClient } from "@/lib/supabase/admin";
import { notify, emailForUser } from "@/lib/notify";
import { getSettings } from "@/lib/settings";
import { fmtTime } from "@/lib/format";
import { clockoutReminderDue, shiftEndForEntry } from "@/lib/clockoutReminder";
import type { TimeEntry } from "@/lib/types";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches this route makes
// (see lib/supabase/admin.ts); this does. Both are here on purpose.
export const fetchCache = "force-no-store";

// Look-back window so we don't re-scan ancient shifts.
const WINDOW_MIN = 180;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured -> allow (dev)
  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  return header === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}

// Did this person clock in for this shift? Answers "unknown" when the lookup
// itself failed, so a bad read can never be mistaken for a missed clock-in.
// An entry counts if it is linked to the shift (how /api/clock and the fob
// clock record it, including someone who clocked in well before the start) or
// if it began near enough to the start to be the same shift.
async function clockedInFor(
  supabase: ReturnType<typeof createAdminClient>,
  shiftId: number,
  employeeId: string,
  startMs: number,
): Promise<"yes" | "no" | "unknown"> {
  const linked = await supabase
    .from("time_entries")
    .select("id")
    .eq("shift_id", shiftId)
    .limit(1);
  if (linked.error) return "unknown";
  if (linked.data?.length) return "yes";

  const winStart = new Date(startMs - 30 * 60000).toISOString();
  const near = await supabase
    .from("time_entries")
    .select("id")
    .eq("employee_id", employeeId)
    .gte("clock_in_at", winStart)
    .limit(1);
  if (near.error) return "unknown";
  return near.data?.length ? "yes" : "no";
}

// Has a notification of `type` already gone to this user for this shift recently?
async function alreadySent(
  supabase: ReturnType<typeof createAdminClient>,
  type: string,
  userId: string,
  shiftId: number,
  sinceISO: string,
) {
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("type", type)
    .eq("user_id", userId)
    .gte("created_at", sinceISO)
    .ilike("body", `%#${shiftId}%`)
    .limit(1)
    .maybeSingle();
  return !!data;
}

export async function GET(request: Request) {
  if (!authorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const settings = await getSettings(supabase);
  const now = Date.now();
  const sinceISO = new Date(now - WINDOW_MIN * 60000).toISOString();

  // Published, assigned shifts that started within the look-back window and are
  // at least the (shorter) employee grace old.
  const lower = sinceISO;
  const upper = new Date(now - settings.employee_clockin_grace_min * 60000).toISOString();
  const { data: shifts, error } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, profiles(full_name, phone)")
    .eq("published", true)
    .not("employee_id", "is", null)
    .gte("starts_at", lower)
    .lte("starts_at", upper);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const flaggedEmp: number[] = [];
  const flaggedMgr: number[] = [];
  // Shifts we couldn't check because a read failed. Nobody is alerted for
  // these; they show up in the cron log so a broken read is visible.
  const unreadable: number[] = [];

  // Managers (loaded once).
  const { data: managers } = await supabase
    .from("profiles")
    .select("id, phone")
    .eq("role", "manager");

  for (const s of shifts ?? []) {
    const startMs = new Date(s.starts_at).getTime();
    const minsLate = (now - startMs) / 60000;

    const clockedIn = await clockedInFor(
      supabase,
      s.id as number,
      s.employee_id as string,
      startMs,
    );
    if (clockedIn !== "no") {
      if (clockedIn === "unknown") unreadable.push(s.id as number);
      continue;
    }

    const prof = (s as any).profiles;
    const name = prof?.full_name ?? "Employee";

    // Employee nudge once the employee grace has passed.
    if (
      minsLate >= settings.employee_clockin_grace_min &&
      !(await alreadySent(supabase, "missed_clockin", s.employee_id as string, s.id as number, sinceISO))
    ) {
      const email = await emailForUser(s.employee_id as string);
      await notify({
        userId: s.employee_id as string,
        type: "missed_clockin",
        title: "You're not clocked in",
        body: `Your ${fmtTime(s.starts_at)} shift started and you haven't clocked in. (shift #${s.id})`,
        phone: prof?.phone ?? null,
        email,
      }).catch(() => {});
      flaggedEmp.push(s.id as number);
    }

    // Manager escalation once the (longer) manager grace has passed.
    if (minsLate >= settings.manager_clockin_grace_min) {
      let told = false;
      for (const m of managers ?? []) {
        if (await alreadySent(supabase, "missed_clockin", m.id, s.id as number, sinceISO)) continue;
        const mEmail = await emailForUser(m.id);
        await notify({
          userId: m.id,
          type: "missed_clockin",
          title: "Missed clock-in",
          body: `${name} hasn't clocked in for the ${fmtTime(s.starts_at)} shift. (shift #${s.id})`,
          phone: m.phone ?? null,
          email: mEmail,
        }).catch(() => {});
        told = true;
      }
      if (told) flaggedMgr.push(s.id as number);
    }
  }

  // ---- Pre-shift reminders: shifts starting within the reminder lead time ----
  const reminded: number[] = [];
  const { data: soon } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, profiles(full_name, phone)")
    .eq("published", true)
    .not("employee_id", "is", null)
    .gte("starts_at", new Date(now).toISOString())
    .lte("starts_at", new Date(now + settings.shift_reminder_lead_min * 60000).toISOString());
  for (const s of soon ?? []) {
    if (await alreadySent(supabase, "shift_reminder", s.employee_id as string, s.id as number, sinceISO)) continue;
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

  // ---- Clock-out reminders: still on the clock well after the shift ended ----
  // Once when they first go overdue, and once more each time a snooze expires.
  // A dismissed entry is never nudged again.
  const clockoutReminded: number[] = [];
  const { data: openEntries } = await supabase
    .from("time_entries")
    .select("*, profiles(full_name, phone)")
    .eq("status", "open")
    .gte("clock_in_at", new Date(now - 24 * 3600000).toISOString());
  for (const raw of openEntries ?? []) {
    const entry = raw as unknown as TimeEntry;
    const shiftEndsAt = await shiftEndForEntry(supabase, entry);
    const { due } = clockoutReminderDue({
      entry,
      shiftEndsAt,
      afterMin: settings.clockout_reminder_after_min,
      now,
    });
    if (!due) continue;

    const sentAt = entry.clockout_reminder_sent_at;
    const snoozedUntil = entry.clockout_reminder_snoozed_until;
    const firstTime = !sentAt;
    const afterSnooze =
      !!snoozedUntil && !!sentAt && new Date(sentAt).getTime() < new Date(snoozedUntil).getTime();
    if (!firstTime && !afterSnooze) continue;

    const prof = (raw as any).profiles;
    const email = await emailForUser(entry.employee_id);
    await notify({
      userId: entry.employee_id,
      type: "clockout_reminder",
      title: "Still clocked in?",
      body: `Your shift ended at ${fmtTime(shiftEndsAt)} and you're still clocked in. If you've left, open Withers Time and clock out. (entry #${entry.id})`,
      phone: prof?.phone ?? null,
      email,
    }).catch(() => {});
    await supabase
      .from("time_entries")
      .update({ clockout_reminder_sent_at: new Date(now).toISOString() })
      .eq("id", entry.id);
    clockoutReminded.push(entry.id);
  }

  // Housekeeping: delete notifications older than 30 days so the bell stays tidy.
  await supabase
    .from("notifications")
    .delete()
    .lt("created_at", new Date(now - 30 * 24 * 3600000).toISOString());

  return NextResponse.json({
    checked: shifts?.length ?? 0,
    unreadable,
    flaggedEmployee: flaggedEmp,
    flaggedManager: flaggedMgr,
    reminded,
    clockoutReminded,
  });
}
