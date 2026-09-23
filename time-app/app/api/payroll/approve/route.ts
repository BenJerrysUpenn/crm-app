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
/** Postgres: unique_violation (window_end is the primary key). */
const UNIQUE_VIOLATION = "23505";
/** Postgres: raise_exception, what migration 27's triggers raise. */
const RAISED_BY_TRIGGER = "P0001";

// POST /api/payroll/approve
// Body: { window_end, note? }
//
// The ONE human approval for a pay run (bj-finance #519, ruled 2026-09-22):
// "Nothing runs until a human hits one approve for the whole pay run (not per
// case). Any manager can change a choice and approve the run."
//
// APPROVAL IS FINAL (follow-up ruling, 2026-09-22). It starts the payroll
// script that stages the run in QBO, so it cannot be cancelled or undone:
//   * it is refused until the pay period has ended (today > window_end, New
//     York), and again by migration 27's trigger;
//   * it is given once — there is no re-approval, edit or delete, and no
//     "stale" state: a choice for an approved period is refused by the
//     database, so the approval can never fall out of date;
//   * it is written with status 'approved_pending_stage', the row the §6
//     staging script will consume.
//
// The run is re-verified here, on the server, and refused unless every case is
// answered by a choice or its default and nothing needs fixing. The approval
// stores a snapshot of every case's effective choice at that moment, defaults
// included, so the record says what was approved even after a default changes
// in code. The payroll sheet (bj-finance modules/payroll_sheet.py) reads this
// row and will not produce a keyable sheet without it.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { window_end?: unknown; note?: unknown } | null;
  const resolved = payWindowEnding(typeof body?.window_end === "string" ? body.window_end : "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const supabase = createClient();
  const today = dayKey(new Date().toISOString());
  const loaded = await loadVerify(supabase, resolved.window, today);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 400 });

  const blocker = approvalBlocker(loaded.result, loaded.result.migrations.approvals, today, loaded.result.otherApprovals);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
  // INSERT, never upsert: a second approval of the same run is a conflict,
  // not a replacement. approved_at and status are set by the database.
  const { data, error } = await supabase
    .from("payroll_run_approvals")
    .insert({
      window_end: resolved.window.end,
      approved_by: me.id,
      snapshot: approvalSnapshot(loaded.result.findings),
      note,
    })
    .select()
    .single();

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Approvals need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error?.code === UNIQUE_VIOLATION)
    return NextResponse.json({ error: "This pay run is already approved. Approval is final." }, { status: 409 });
  // Migration 27's trigger: the period has not ended, or it overlaps an
  // approved run. Its message says which.
  if (error?.code === RAISED_BY_TRIGGER) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // TODO(bj-finance #519, spec §6): the QBO staging script is not built. It
  // will consume payroll_run_approvals rows with status
  // 'approved_pending_stage' (this row). Nothing here starts it or touches QBO.
  return NextResponse.json({ approval: data });
}
