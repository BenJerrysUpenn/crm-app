import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { NextResponse } from "next/server";
import type { TimeEntry } from "@/lib/types";

// POST { action: "snooze" | "dismiss" }
// Snooze pushes the nudge out by the configured reminder interval; dismiss
// silences it for good on this entry. Both only make sense while the entry is
// still open — once you've clocked out there is nothing to remind you about.
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const { action } = body;
  if (action !== "snooze" && action !== "dismiss")
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const { data: entry } = await supabase
    .from("time_entries")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  if (!entry) return NextResponse.json({ error: "Entry not found" }, { status: 404 });
  if ((entry as TimeEntry).status !== "open")
    return NextResponse.json({ error: "That entry is already closed." }, { status: 409 });

  // Your own entry, or anyone's if you're a manager.
  const profile = await getProfile();
  if ((entry as TimeEntry).employee_id !== user.id && profile?.role !== "manager")
    return NextResponse.json({ error: "Not your time entry" }, { status: 403 });

  const now = Date.now();
  let patch: Record<string, unknown>;
  if (action === "snooze") {
    const settings = await getSettings(supabase);
    patch = {
      clockout_reminder_snoozed_until: new Date(
        now + settings.clockout_reminder_after_min * 60000,
      ).toISOString(),
    };
  } else {
    patch = { clockout_reminder_dismissed_at: new Date(now).toISOString() };
  }

  const { data, error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ entry: data as TimeEntry });
}
