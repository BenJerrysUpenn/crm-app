import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { dayKey } from "@/lib/format";
import { isMissingTable } from "@/lib/storeHours";
import { loadVerify } from "@/lib/payroll/loadVerify";
import { submittalBlocker, submittalSnapshot } from "@/lib/payroll/choices";
import { payWindowEnding } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// See ../verify/route.ts: the submittal is checked against a fresh read, never a
// cached one, or it could submit choices that have since changed.
export const fetchCache = "force-no-store";

const MAX_NOTE = 2000;
/** Postgres: unique_violation (window_end is the primary key). */
const UNIQUE_VIOLATION = "23505";
/** Postgres: raise_exception, what migration 27's triggers raise. */
const RAISED_BY_TRIGGER = "P0001";

// POST /api/payroll/submit
// Body: { window_end, note? }
//
// The ONE human submittal for a pay run (bj-finance #519, ruled 2026-09-22):
// "Nothing runs until a human hits one submit for the whole pay run (not per
// case). Any manager can change a choice and submit the run."
//
// SUBMITTAL IS FINAL (follow-up ruling, 2026-09-22). It sends money and cannot
// be cancelled or undone. The §6 staging script is not built, so today it
// submits and locks the run, and the pay run is keyed in QBO by hand:
//   * it is refused until the pay period has ended (today > window_end, New
//     York), and again by migration 27's trigger;
//   * it is given once — there is no re-submittal, edit or delete, and no
//     "stale" state: a choice for a submitted period is refused by the
//     database, so the submittal can never fall out of date;
//   * it is written with status 'submitted_pending_stage', the row the §6
//     staging script will consume.
//
// The run is re-verified here, on the server, and refused unless every case is
// answered by a choice or its default and nothing needs fixing. The submittal
// stores a snapshot of every case's effective choice at that moment, defaults
// included, so the record says what was submitted even after a default changes
// in code. The payroll sheet (bj-finance modules/payroll_sheet.py) reads this
// row and will not produce a keyable sheet without it.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as { window_end?: unknown; note?: unknown } | null;
  const resolved = payWindowEnding(typeof body?.window_end === "string" ? body.window_end : "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const supabase = createClient();
  const today = dayKey(new Date().toISOString());
  const loaded = await loadVerify(supabase, resolved.window, today);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 400 });

  const blocker = submittalBlocker(loaded.result, loaded.result.migrations.submittals, today, loaded.result.otherSubmittals);
  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;
  // INSERT, never upsert: a second submittal of the same run is a conflict,
  // not a replacement. submitted_at and status are set by the database.
  const { data, error } = await supabase
    .from("payroll_run_submittals")
    .insert({
      window_end: resolved.window.end,
      submitted_by: me.id,
      snapshot: submittalSnapshot(loaded.result.findings),
      note,
    })
    .select()
    .single();

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Submittals need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error?.code === UNIQUE_VIOLATION)
    return NextResponse.json({ error: "This pay run is already submitted. Submittal is final." }, { status: 409 });
  // Migration 27's trigger: the period has not ended, or it overlaps an
  // submitted run. Its message says which.
  if (error?.code === RAISED_BY_TRIGGER) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // TODO(bj-finance #519, spec §6): the QBO staging script is not built. It
  // will consume payroll_run_submittals rows with status
  // 'submitted_pending_stage' (this row). Nothing here starts it or touches QBO.
  return NextResponse.json({ submittal: data });
}
