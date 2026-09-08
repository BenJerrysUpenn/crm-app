import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";
import type { ClockinReminder } from "@/lib/types";

// POST { ids: number[] } — records this employee's acknowledgment of each
// reminder, snapshotting the exact wording they agreed to. Permanent.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { ids?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0)
    return NextResponse.json({ error: "No reminders to acknowledge." }, { status: 400 });
  if (!ids.every((n) => typeof n === "number" && Number.isInteger(n)))
    return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const { data: reminders, error: loadErr } = await supabase
    .from("clockin_reminders")
    .select("*")
    .in("id", ids as number[])
    .eq("active", true);
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 400 });
  if (!reminders || reminders.length === 0)
    return NextResponse.json({ error: "Nothing to acknowledge." }, { status: 400 });

  const userAgent = (request.headers.get("user-agent") ?? "").slice(0, 500);
  const rows = (reminders as ClockinReminder[]).map((r) => ({
    reminder_id: r.id,
    employee_id: user.id,
    title_snapshot: r.title,
    body_snapshot: r.body,
    user_agent: userAgent || null,
  }));

  // A double-tap must be harmless: the first ack stands, the second is a
  // no-op rather than an error (and never overwrites the original time).
  const { error } = await supabase
    .from("clockin_reminder_acks")
    .upsert(rows, { onConflict: "reminder_id,employee_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ acknowledged: rows.map((r) => r.reminder_id) });
}
