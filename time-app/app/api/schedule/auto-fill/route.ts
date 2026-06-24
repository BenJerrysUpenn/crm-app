import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { NextResponse } from "next/server";

const TZ = "America/New_York";
const OT_THRESHOLD_MIN = 40 * 60; // 40 hours in minutes

function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function nyDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}
// Minutes-of-day in Eastern for a timestamp.
function nyMinutes(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}
function timeToMin(t: string | null) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function minutes(s: { starts_at: string; ends_at: string }) {
  return (new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 60000;
}
function overlaps(a: { starts_at: string; ends_at: string }, b: { starts_at: string; ends_at: string }) {
  return new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at);
}

// POST { weekStart: "YYYY-MM-DD" } — assign available employees to open shifts.
export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const { weekStart } = await request.json();
  if (!weekStart) return NextResponse.json({ error: "weekStart required" }, { status: 400 });
  const weekEnd = addDays(weekStart, 7);
  const qStart = addDays(weekStart, -1) + "T00:00:00Z";
  const qEnd = addDays(weekStart, 8) + "T00:00:00Z";

  const supabase = createClient();

  // All shifts in the week window.
  const { data: allShifts } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at")
    .gte("starts_at", qStart)
    .lt("starts_at", qEnd);
  const weekShifts = (allShifts ?? []).filter((s) => {
    const d = nyDate(s.starts_at);
    return d >= weekStart && d < weekEnd;
  });
  const openShifts = weekShifts
    .filter((s) => !s.employee_id)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());
  if (openShifts.length === 0)
    return NextResponse.json({ ok: true, assigned: 0, left: 0 });

  // Active employees.
  const { data: emps } = await supabase
    .from("profiles")
    .select("id")
    .eq("active", true);
  const employeeIds = (emps ?? []).map((e) => e.id);

  // Approved availability (available windows) + approved time-off for the week.
  const { data: avail } = await supabase
    .from("availability")
    .select("employee_id, specific_date, start_time, end_time, is_available, status")
    .not("specific_date", "is", null)
    .gte("specific_date", weekStart)
    .lt("specific_date", weekEnd);
  const availableBlocks = new Map<string, { date: string; start: number; end: number }[]>();
  const timeOff = new Set<string>(); // `${emp}|${date}`
  for (const a of avail ?? []) {
    if (a.is_available && a.status === "approved" && a.start_time && a.end_time) {
      const arr = availableBlocks.get(a.employee_id) ?? [];
      arr.push({ date: a.specific_date as string, start: timeToMin(a.start_time)!, end: timeToMin(a.end_time)! });
      availableBlocks.set(a.employee_id, arr);
    }
    if (!a.is_available && a.status === "approved") {
      timeOff.add(`${a.employee_id}|${a.specific_date}`);
    }
  }

  // Running per-employee state from already-assigned shifts this week.
  const assignedMin = new Map<string, number>();
  const busy = new Map<string, { starts_at: string; ends_at: string }[]>();
  for (const id of employeeIds) {
    assignedMin.set(id, 0);
    busy.set(id, []);
  }
  for (const s of weekShifts) {
    if (s.employee_id && assignedMin.has(s.employee_id)) {
      assignedMin.set(s.employee_id, (assignedMin.get(s.employee_id) ?? 0) + minutes(s));
      busy.get(s.employee_id)!.push(s);
    }
  }

  let assigned = 0;
  for (const shift of openShifts) {
    const date = nyDate(shift.starts_at);
    const sStart = nyMinutes(shift.starts_at);
    const sEnd = nyMinutes(shift.ends_at);
    const dur = minutes(shift);

    const candidates = employeeIds.filter((id) => {
      if (timeOff.has(`${id}|${date}`)) return false;
      if ((assignedMin.get(id) ?? 0) + dur > OT_THRESHOLD_MIN) return false;
      // Must have an availability block on this date that covers the shift.
      const blocks = availableBlocks.get(id) ?? [];
      const covered = blocks.some((b) => b.date === date && b.start <= sStart && b.end >= sEnd);
      if (!covered) return false;
      // No overlap with an existing assignment.
      if ((busy.get(id) ?? []).some((b) => overlaps(b, shift))) return false;
      return true;
    });
    if (candidates.length === 0) continue;

    // Balance: fewest already-assigned minutes wins.
    candidates.sort((a, b) => (assignedMin.get(a) ?? 0) - (assignedMin.get(b) ?? 0));
    const pick = candidates[0];

    const { error } = await supabase
      .from("shifts")
      .update({ employee_id: pick, updated_at: new Date().toISOString() })
      .eq("id", shift.id)
      .is("employee_id", null);
    if (error) continue;

    assignedMin.set(pick, (assignedMin.get(pick) ?? 0) + dur);
    busy.get(pick)!.push(shift);
    assigned++;
  }

  return NextResponse.json({ ok: true, assigned, left: openShifts.length - assigned });
}
