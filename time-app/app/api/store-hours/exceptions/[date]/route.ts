import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isISODate } from "@/lib/holidays";
import { isMissingTable } from "@/lib/storeHours";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// DELETE /api/store-hours/exceptions/2026-11-26
// Drops the override so the date goes back to its normal weekday hours.
// Deleting a date that has no exception is a no-op, not an error. -> { ok }
export async function DELETE(_request: Request, { params }: { params: { date: string } }) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  if (!isISODate(params.date))
    return NextResponse.json({ error: "Pick a real date, like 2026-11-26." }, { status: 400 });

  const supabase = createClient();
  const { error } = await supabase
    .from("store_hours_exceptions")
    .delete()
    .eq("date", params.date);
  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Store hours tables are missing. Run migration 24 in Supabase first." },
      { status: 503 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
