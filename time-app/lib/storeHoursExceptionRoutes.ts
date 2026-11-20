// Closing a date or giving it special hours (store_hours_exceptions,
// migration 24), and dropping that again. Two pairs of routes answer with
// these: the Team page's /api/store-hours/exceptions and the Targets tab's
// /api/payroll/targets/closed-days (bj-finance #742; the finance site serves
// only /api/payroll). Managers only, both here and in the table's policies.

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isISODate } from "@/lib/holidays";
import { isMissingTable, parseSpan } from "@/lib/storeHours";
import type { StoreHoursException } from "@/lib/types";
import { isManager } from "@/lib/roles";

const NEEDS_MIGRATION_24 = "Store hours tables are missing. Run migration 24 in Supabase first.";

// Body: { date: "YYYY-MM-DD", label?: string, is_closed?: boolean,
//         opens?: "HH:MM", closes?: "HH:MM" }
// is_closed defaults to true — the common case is closing a single day.
// Upserts, so re-posting the same date edits that date rather than failing.
// Affects only this date; the weekly pattern is untouched.
// -> { exception: StoreHoursException }
export async function postException(request: Request): Promise<NextResponse> {
  const profile = await getProfile();
  if (!profile || !isManager(profile))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  const b = body as Record<string, unknown>;

  if (!isISODate(b.date))
    return NextResponse.json({ error: "Pick a real date, like 2026-11-26." }, { status: 400 });
  const date = b.date;

  const rawLabel = typeof b.label === "string" ? b.label.trim() : "";
  if (rawLabel.length > 120)
    return NextResponse.json({ error: "Label is too long (120 characters max)." }, { status: 400 });

  // A bare { date } means "close this day".
  const span = parseSpan({ ...b, is_closed: b.is_closed ?? true }, date);
  if (!span.ok) return NextResponse.json({ error: span.error }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase
    .from("store_hours_exceptions")
    .upsert(
      {
        date,
        label: rawLabel || null,
        is_closed: span.value.is_closed,
        opens: span.value.opens,
        closes: span.value.closes,
      },
      { onConflict: "date" },
    )
    .select()
    .single();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION_24 }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ exception: data as StoreHoursException });
}

// Drops the override so the date goes back to its normal weekday hours.
// Deleting a date that has no exception is a no-op, not an error. -> { ok }
export async function deleteException(date: string): Promise<NextResponse> {
  const profile = await getProfile();
  if (!profile || !isManager(profile))
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  if (!isISODate(date))
    return NextResponse.json({ error: "Pick a real date, like 2026-11-26." }, { status: 400 });

  const supabase = createClient();
  const { error } = await supabase.from("store_hours_exceptions").delete().eq("date", date);
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION_24 }, { status: 503 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
