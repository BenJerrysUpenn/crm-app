import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { isMissingTable } from "@/lib/storeHours";
import { loadVerify } from "@/lib/payroll/loadVerify";
import { approvalBlocker, approvalSnapshot } from "@/lib/payroll/choices";
import { payWindowEnding } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// See ../verify/route.ts: the approval is checked against a fresh read, never a
// cached one, or it could approve choices that have since changed.
export const fetchCache = "force-no-store";

const MAX_NOTE = 2000;

// POST /api/payroll/approve
// Body: { window_end, note? }
//
// The ONE human approval for a pay run (bj-finance #519, ruled 2026-09-22):
// "Nothing runs until a human hits one approve for the whole pay run (not per
// case). Any manager can change a choice and approve the run."
//
// The run is re-verified here, on the server, and refused unless every case is
// answered by a choice or its default and nothing needs fixing. The approval
// stores a snapshot of every case's effective choice at that moment, defaults
// included, so the record says what was approved even after a default changes
// in code. Approving again replaces the previous approval (one row per run).
// The payroll sheet (bj-finance modules/payroll_sheet.py) reads this row and
// will not produce a keyable sheet without it.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { window_end?: unknown; note?: unknown } | null;
  const resolved = payWindowEnding(typeof body?.window_end === "string" ? body.window_end : "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const supabase = createClient();
  const loaded = await loadVerify(supabase, resolved.window, dayKey(new Date().toISOString()));
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 400 });

  const blocker = approvalBlocker(loaded.result, loaded.result.migrations.approvals);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
  const { data, error } = await supabase
    .from("payroll_run_approvals")
    .upsert(
      {
        window_end: resolved.window.end,
        approved_by: me.id,
        approved_at: new Date().toISOString(),
        snapshot: approvalSnapshot(loaded.result.findings),
        note,
      },
      { onConflict: "window_end" },
    )
    .select()
    .single();

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Approvals need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ approval: data });
}
