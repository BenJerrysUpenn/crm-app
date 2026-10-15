import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isOwner } from "@/lib/roles";
import { isMissingTable } from "@/lib/storeHours";
import { parseSettingInput } from "@/lib/controlBoard/settings";
import { NEEDS_MIGRATION } from "@/lib/controlBoard/load";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const OWNERS_ONLY = "Only an owner can change the control board.";
/** Postgres: insufficient_privilege, what Row Level Security answers. */
const REFUSED_BY_DATABASE = "42501";

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
  if (!isOwner(me)) return NextResponse.json({ error: OWNERS_ONLY }, { status: 403 });

  const body = await request.json().catch(() => null);
  const parsed = parseSettingInput(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = createClient();
  const { data, error } = await supabase.from("control_settings").insert(parsed.value).select().single();
  if (isMissingTable(error)) return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 503 });
  if (error?.code === REFUSED_BY_DATABASE) return NextResponse.json({ error: OWNERS_ONLY }, { status: 403 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ setting: data });
}
