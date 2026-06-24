import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import TopBar from "@/components/TopBar";
import AttendanceView, { type Notice } from "@/components/AttendanceView";

export const dynamic = "force-dynamic";

export default async function AttendancePage() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "manager") redirect("/");
  const supabase = createClient();
  const GRACE_MIN = (await getSettings(supabase)).tardy_grace_min;

  const now = Date.now();
  const since = new Date(now - 7 * 24 * 3600000).toISOString();

  const { data: shifts } = await supabase
    .from("shifts")
    .select("id, employee_id, starts_at, ends_at, position, profiles(full_name)")
    .eq("published", true)
    .not("employee_id", "is", null)
    .gte("starts_at", since)
    .lte("starts_at", new Date(now).toISOString())
    .order("starts_at", { ascending: false });

  const shiftIds = (shifts ?? []).map((s) => s.id);
  const entriesByShift = new Map<number, { clock_in_at: string; clock_out_at: string | null }>();
  if (shiftIds.length) {
    const { data: entries } = await supabase
      .from("time_entries")
      .select("shift_id, clock_in_at, clock_out_at")
      .in("shift_id", shiftIds);
    for (const e of entries ?? []) {
      if (e.shift_id != null) entriesByShift.set(e.shift_id as number, e);
    }
  }

  const notices: Notice[] = [];
  for (const s of shifts ?? []) {
    const name = (s as any).profiles?.full_name ?? "Employee";
    const start = new Date(s.starts_at).getTime();
    const end = new Date(s.ends_at).getTime();
    const entry = entriesByShift.get(s.id as number);

    if (!entry) {
      if (end < now) {
        notices.push({ id: `${s.id}-noshow`, name, kind: "no_show", minutes: 0, atISO: s.starts_at, position: s.position });
      }
      continue;
    }
    const inMin = (new Date(entry.clock_in_at).getTime() - start) / 60000;
    if (inMin > GRACE_MIN) {
      notices.push({ id: `${s.id}-latein`, name, kind: "late_in", minutes: Math.round(inMin), atISO: entry.clock_in_at, position: s.position });
    }
    if (entry.clock_out_at) {
      const outDiff = (new Date(entry.clock_out_at).getTime() - end) / 60000;
      if (outDiff > GRACE_MIN) {
        notices.push({ id: `${s.id}-outlate`, name, kind: "out_late", minutes: Math.round(outDiff), atISO: entry.clock_out_at, position: s.position });
      } else if (-outDiff > GRACE_MIN) {
        notices.push({ id: `${s.id}-outearly`, name, kind: "out_early", minutes: Math.round(-outDiff), atISO: entry.clock_out_at, position: s.position });
      }
    }
  }
  notices.sort((a, b) => new Date(b.atISO).getTime() - new Date(a.atISO).getTime());

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar email={profile.full_name ?? ""} role={profile.role} name={profile.full_name ?? ""} />
      <main className="flex-1">
        <div className="mx-auto max-w-3xl px-4 py-6">
          <AttendanceView notices={notices} />
        </div>
      </main>
    </div>
  );
}
