import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isMissingInStoreColumn } from "@/lib/storeHours";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = await request.json();
  if (!body.name) return NextResponse.json({ error: "Name required" }, { status: 400 });
  const supabase = createClient();
  const row: Record<string, unknown> = {
    name: body.name,
    color: body.color ?? "#10b981",
    sort_order: body.sort_order ?? 99,
    default_start: body.default_start || null,
    default_end: body.default_end || null,
    // New types count toward store coverage unless told otherwise.
    in_store: body.in_store === undefined ? true : !!body.in_store,
  };

  let { data, error } = await supabase.from("shift_types").insert(row).select().single();
  // shift_types.in_store arrives in migration 24. Until it is applied, adding
  // a shift type must still work, so retry once without the column rather than
  // blocking the whole editor on a migration.
  if (error && isMissingInStoreColumn(error)) {
    delete row.in_store;
    ({ data, error } = await supabase.from("shift_types").insert(row).select().single());
    if (!error)
      return NextResponse.json({
        shiftType: data,
        warning: "Saved, but In-store was not recorded: run migration 24 in Supabase.",
      });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ shiftType: data });
}
