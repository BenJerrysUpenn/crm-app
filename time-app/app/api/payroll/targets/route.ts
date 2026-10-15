import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isOwner } from "@/lib/roles";
import { parseSettingInput } from "@/lib/controlBoard/settings";
import { addDatedRow, DATED_TABLES } from "@/lib/controlBoard/save";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// POST /api/payroll/targets
// Body: { key, value, detail?, effective_from, review_by, source, method? }
//
// Adds a dated value for one control-board setting (bj-finance #693). A change
// is a new row, never an edit: the old value stays in the history, and the new
// one is in force from effective_from (migration 43). Owners only; every other
// manager sees the board read-only. The database refuses a non-owner too.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  if (!isOwner(me)) return NextResponse.json({ error: DATED_TABLES.control_settings.ownersOnly }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = parseSettingInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  return addDatedRow(createClient(), "control_settings", parsed.value);
}
