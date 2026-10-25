import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isOwner } from "@/lib/roles";
import { isDay } from "@/lib/controlBoard/settings";
import { parseSeasonInput } from "@/lib/controlBoard/planningInputs";
import { removeSeason, saveSeason, SEASONS_OWNERS_ONLY } from "@/lib/controlBoard/save";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/payroll/targets/seasons
// Body: { name, effective_from, opens, closes, closed_weekdays: number[], review_by, source, method? }
// DELETE /api/payroll/targets/seasons?from=YYYY-MM-DD
//
// A store-hours season from the Targets tab (bj-finance #742, migration 47):
// the store's hours from its first day until the next season starts. Saved
// as one row per weekday; saving a season with the same first day again
// replaces it. Owners only; managers see the seasons read-only. The database
// refuses a non-owner too.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!isOwner(me)) return NextResponse.json({ error: SEASONS_OWNERS_ONLY }, { status: 403 });
  const parsed = parseSeasonInput(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  return saveSeason(createClient(), parsed.value);
}

export async function DELETE(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!isOwner(me)) return NextResponse.json({ error: SEASONS_OWNERS_ONLY }, { status: 403 });
  const from = new URL(request.url).searchParams.get("from");
  if (!isDay(from)) return NextResponse.json({ error: "Which season? Give its start date (YYYY-MM-DD)." }, { status: 400 });
  return removeSeason(createClient(), from);
}
