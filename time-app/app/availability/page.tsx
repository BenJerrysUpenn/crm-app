import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import TopBar from "@/components/TopBar";
import AvailabilityCalendar from "@/components/AvailabilityCalendar";
import ManagerAvailability from "@/components/ManagerAvailability";
import { loadAvailabilityRows } from "@/lib/availabilityRows";
import { loadRoster } from "@/lib/teamRoster";
import { dropPastTimeOff, todayInNewYork } from "@/lib/timeOff";
import type { Availability, Profile } from "@/lib/types";

export const dynamic = "force-dynamic";

type TimeOffRow = Availability & { profiles: Pick<Profile, "id" | "full_name"> };

const TZ = "America/New_York";
function addDays(d: string, n: number) {
  const x = new Date(d + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
function sundayOf(dateStr?: string): string {
  const base = dateStr ? new Date(dateStr + "T00:00:00Z") : new Date();
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

// Manager-only tab bar: switch between their own availability and the team view.
function Tabs({ active }: { active: "mine" | "team" }) {
  const base =
    "text-sm px-3 py-1.5 rounded-md font-medium transition-colors";
  const on = "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900";
  const off =
    "border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800";
  return (
    <div className="flex gap-2 mb-5">
      <Link href="/availability?view=mine" className={`${base} ${active === "mine" ? on : off}`}>
        My availability
      </Link>
      <Link href="/availability?view=team" className={`${base} ${active === "team" ? on : off}`}>
        Team
      </Link>
    </div>
  );
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: { week?: string; month?: string; view?: string };
}) {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  const supabase = createClient();
  const isManager = profile.role === "manager";
  // Managers default to the team view; employees only ever see their own.
  const view: "mine" | "team" = isManager
    ? searchParams.view === "mine"
      ? "mine"
      : "team"
    : "mine";

  // ---- Manager: weekly team availability + approvals ----
  if (isManager && view === "team") {
    const weekStart = sundayOf(searchParams.week);
    // The grid lists everyone on the roster (the Schedule page's list), and
    // reads availability through the shared loader: dated rows from the day
    // before the week (an overnight block from that Saturday reaches Sunday)
    // plus every weekly "Repeats every …" row.
    const [roster, availability] = await Promise.all([
      loadRoster(supabase),
      loadAvailabilityRows(supabase, { from: addDays(weekStart, -1), to: addDays(weekStart, 6) }),
    ]);
    // Time-off requests that are not over yet (lib/timeOff.ts). The database
    // keeps only days from today on (New York), plus undated rows; then, for a
    // request already under way, its earlier days are read back so the card
    // still shows the whole range. Past requests stay in the table.
    const today = todayInNewYork(new Date());
    const { data: current } = await supabase
      .from("availability")
      .select("*, profiles(id, full_name)")
      .eq("is_available", false)
      .or(`specific_date.is.null,specific_date.gte.${today}`)
      .order("specific_date", { ascending: true });
    const underway = Array.from(
      new Set((current ?? []).map((r) => r.request_group as string | null).filter((g): g is string => !!g)),
    );
    const { data: earlier } = underway.length
      ? await supabase
          .from("availability")
          .select("*, profiles(id, full_name)")
          .eq("is_available", false)
          .in("request_group", underway)
          .lt("specific_date", today)
          .order("specific_date", { ascending: true })
      : { data: [] };
    const timeOff = dropPastTimeOff(
      [...((earlier as TimeOffRow[]) ?? []), ...((current as TimeOffRow[]) ?? [])],
      today,
    );
    return (
      <div className="min-h-screen flex flex-col">
        <TopBar role={profile.role} name={profile.full_name} />
        <main className="flex-1">
          {/* Full page width so all seven days fit side by side. */}
          <div className="mx-auto px-4 sm:px-6 py-6">
            <Tabs active="team" />
            <ManagerAvailability
              weekStart={weekStart}
              roster={roster.ok ? roster.people : null}
              availability={availability.ok ? availability.rows : null}
              timeOff={timeOff}
            />
          </div>
        </main>
      </div>
    );
  }

  // ---- Personal month calendar (employees, and managers' "My availability") ----
  const today = new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  const monthKey = searchParams.month ?? today.slice(0, 7); // YYYY-MM
  const monthStart = monthKey + "-01";
  const gridStart = sundayOf(monthStart);
  const gridEnd = addDays(gridStart, 42);

  const { data: specific } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("specific_date", "is", null)
    .gte("specific_date", gridStart)
    .lt("specific_date", gridEnd);

  const { data: recurring } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", true)
    .not("weekday", "is", null);

  const { data: timeOff } = await supabase
    .from("availability")
    .select("*")
    .eq("employee_id", profile.id)
    .eq("is_available", false)
    .order("specific_date", { ascending: true });

  // IMPORTANT: use the admin client so we see EVERY published shift, not just
  // this user's (row-level security would otherwise hide other people's
  // shifts and the day wouldn't lock).
  const admin = createAdminClient();
  const { data: pub } = await admin
    .from("shifts")
    .select("starts_at")
    .eq("published", true)
    .gte("starts_at", gridStart + "T00:00:00Z")
    .lt("starts_at", gridEnd + "T00:00:00Z");
  const lockedDays = Array.from(
    new Set((pub ?? []).map((s) => new Date(s.starts_at as string).toLocaleDateString("en-CA", { timeZone: TZ }))),
  );

  // The latest published shift date anywhere; everything on/before it is locked.
  const { data: lastPub } = await admin
    .from("shifts")
    .select("starts_at")
    .eq("published", true)
    .order("starts_at", { ascending: false })
    .limit(1);
  const postedThrough = lastPub?.[0]
    ? new Date(lastPub[0].starts_at as string).toLocaleDateString("en-CA", { timeZone: TZ })
    : null;

  return (
    <div className="min-h-screen flex flex-col">
      <TopBar role={profile.role} name={profile.full_name} />
      <main className="flex-1">
        <div className="mx-auto max-w-5xl px-4 py-6">
          {isManager && <Tabs active="mine" />}
          <AvailabilityCalendar
            monthKey={monthKey}
            gridStart={gridStart}
            specific={(specific as Availability[]) ?? []}
            recurring={(recurring as Availability[]) ?? []}
            timeOff={(timeOff as Availability[]) ?? []}
            lockedDays={lockedDays}
            postedThrough={postedThrough}
            today={today}
            navView={isManager ? "mine" : undefined}
          />
        </div>
      </main>
    </div>
  );
}
