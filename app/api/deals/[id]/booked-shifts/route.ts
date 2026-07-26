import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDraftShiftsForDeal, DEAL_SHIFT_COLUMNS } from "@/lib/cateringShifts";

// POST /api/deals/:id/booked-shifts
//
// Called by the CRM UI right after a deal is moved into "Booked Unpaid".
// Creates one open draft shift per crew member in the time-app (manager-only,
// unpublished). Idempotent: safe to call repeatedly; it never double-creates
// and never edits shifts once made ("create once, never touch").
export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  // Require an authenticated CRM session.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const dealId = Number(params.id);
  if (!Number.isFinite(dealId))
    return NextResponse.json({ error: "Bad deal id" }, { status: 400 });

  // Read the deal with a privileged client (service role) so we can also write
  // to shifts, which the CRM user's RLS doesn't cover.
  const admin = createAdminClient();
  const { data: deal, error } = await admin
    .from("deals")
    .select(DEAL_SHIFT_COLUMNS)
    .eq("id", dealId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  // Only act on booked deals (unpaid or paid). Any other stage is a no-op.
  if (deal.stage !== "Booked Unpaid" && deal.stage !== "Booked Paid") {
    return NextResponse.json({ created: 0, skipped: true, reason: `stage is ${deal.stage}` });
  }

  try {
    const result = await createDraftShiftsForDeal(admin, deal);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create shifts" },
      { status: 500 },
    );
  }
}
