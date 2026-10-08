import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { isMissingTable } from "@/lib/storeHours";
import { parseLyftRideReport } from "@/lib/reimbursements/submission";
import { NEEDS_MIGRATION, emailLyftRideReport, resolveReason, type LyftRow } from "@/lib/reimbursements/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/reimbursements/lyft
// Body: { reason, trip_date, screenshot_paths }
//
// A Lyft ride report (bj-finance #210, rulings 7, 23): the ride went on the
// company card, so nothing is paid back. It is Filed on upload, never in the
// approval queue, and its screenshots are emailed to receipts@ now, where the
// receipt processor matches them to the card charge.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const today = dayKey(new Date().toISOString());
  const parsed = parseLyftRideReport(await request.json().catch(() => null), { profileId: me.id, today });
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const reason = await resolveReason(parsed.value, today);
  if (!reason.ok) return NextResponse.json({ error: reason.error }, { status: 400 });

  const { data, error } = await createClient()
    .from("lyft_ride_reports")
    .insert({ profile_id: me.id, ...reason.cols, trip_date: parsed.value.trip_date, screenshot_paths: parsed.value.screenshot_paths })
    .select()
    .single();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const emailed = await emailLyftRideReport(data as LyftRow, me.full_name ?? "A staff member");
  return NextResponse.json({ report: data, emailed });
}
