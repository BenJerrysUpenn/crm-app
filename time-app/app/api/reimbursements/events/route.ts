import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { eventLabel, searchEvents } from "@/lib/reimbursements/events";
import { listCateringEvents } from "@/lib/reimbursements/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// GET /api/reimbursements/events?q=
// The Catering Event picker (bj-finance #210, rulings 16, 17): every booked
// Catering Event in the last 365 days up to today, newest first, searchable by
// venue, company or address. Staff cannot read public.deals, so it is read
// here with the service role and only the label's fields leave. `id` is the
// deal id, which the form sends back to record the Reason; it is never shown.
export async function GET(request: Request) {
  const me = await getProfile();
  if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const listed = await listCateringEvents(dayKey(new Date().toISOString()));
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 500 });
  return NextResponse.json({
    events: searchEvents(listed.events, q).map((e) => ({ id: e.id, date: e.date, address: e.address, label: eventLabel(e) })),
  });
}
