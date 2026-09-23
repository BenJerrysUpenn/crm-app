import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isMissingTable } from "@/lib/storeHours";
import { RULING_CHOICES } from "@/lib/payroll/verify";
import { validateChoice, type PayeeProfile } from "@/lib/payroll/choices";
import { payWindowEnding } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// See the note in ../verify/route.ts: force-dynamic does not stop Next caching
// a route handler's own fetches, and a stale read of the rulings table would
// show a manager an answer they have just changed.
export const fetchCache = "force-no-store";

const MAX_NOTE = 2000;
/** Postgres: raise_exception, what migration 27's lock trigger raises. */
const RAISED_BY_TRIGGER = "P0001";

type Body = {
  window_end?: unknown;
  check_id?: unknown;
  finding_key?: unknown;
  choice?: unknown;
  payee_id?: unknown;
  note?: unknown;
};

type Parsed = { window_end: string; check_id: string; finding_key: string };

/**
 * Validate what every ruling call has in common: which window, which check,
 * which finding.
 *
 * The check must be one that takes a choice (§1.4, §1.5, §1.9, §3.5, §3.7).
 * Recording a "ruling" against an auto-resolved check would be a decision
 * nobody is entitled to make: those are decided by rule, and the rule is the
 * record.
 */
function parseTarget(source: { window_end?: unknown; check_id?: unknown; finding_key?: unknown }): Parsed | string {
  const windowEnd = typeof source.window_end === "string" ? source.window_end : "";
  const resolved = payWindowEnding(windowEnd);
  if (!resolved.ok) return resolved.error;

  const checkId = typeof source.check_id === "string" ? source.check_id : "";
  if (!(checkId in RULING_CHOICES))
    return `${checkId || "That check"} is decided by rule, not by a ruling.`;

  const findingKey = typeof source.finding_key === "string" ? source.finding_key.trim() : "";
  if (!findingKey) return "finding_key is required.";
  if (!findingKey.startsWith(`${checkId}:`))
    return `finding_key ${findingKey} does not belong to check ${checkId}.`;

  return { window_end: resolved.window.end, check_id: checkId, finding_key: findingKey };
}

// POST /api/payroll/rulings
// Body: { window_end, check_id, finding_key, choice, payee_id?, note? }
//
// Records one manager's choice for one case (bj-finance #519, ruled
// 2026-09-22). ANY manager may record or change a choice. Re-answering the same
// case replaces the previous answer rather than adding a second one: the
// unique index is (check_id, finding_key), so the table holds the choice that
// stands, and the schedule and the Finance tab write the same row.
//
// Once the run a case falls in is approved, its choice is LOCKED: approval is
// final and has started payroll. Migration 27's trigger refuses the write
// (and works out the case's date itself); this route turns that into a 409.
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as Body | null;
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  const target = parseTarget(body);
  if (typeof target === "string") return NextResponse.json({ error: target }, { status: 400 });

  // The choice is validated against the rulebook's own vocabulary, never
  // against anything the browser offered, and a paying choice against the
  // person it names.
  const choice = typeof body.choice === "string" ? body.choice.trim() : "";
  const payeeId = typeof body.payee_id === "string" && body.payee_id.trim() ? body.payee_id.trim() : null;

  const supabase = createClient();
  let payee: PayeeProfile = null;
  if (payeeId) {
    const { data } = await supabase.from("profiles").select("id, role, active").eq("id", payeeId).maybeSingle();
    payee = (data as PayeeProfile) ?? null;
  }
  const invalid = validateChoice(target.check_id, choice, payeeId, payee);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;

  const { data, error } = await supabase
    .from("payroll_rulings")
    .upsert(
      {
        ...target,
        choice,
        payee_id: payeeId,
        note,
        decided_by: me.id,
        decided_at: new Date().toISOString(),
      },
      { onConflict: "check_id,finding_key" },
    )
    .select()
    .single();

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Payroll rulings need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error?.code === RAISED_BY_TRIGGER) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ruling: data });
}

// DELETE /api/payroll/rulings?window_end=&check_id=&finding_key=
//
// Puts a case back to its default (or, for §1.4/§1.5, back in front of the
// person). Refused, like any change, once the case's run is approved. Deleting the row rather than writing an empty choice keeps "not
// changed" a single state — the default is the rule, and there is no second
// way to hold it.
export async function DELETE(request: Request) {
  const me = await getProfile();
  if (!me || me.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const params = new URL(request.url).searchParams;
  const target = parseTarget({
    window_end: params.get("window_end") ?? undefined,
    check_id: params.get("check_id") ?? undefined,
    finding_key: params.get("finding_key") ?? undefined,
  });
  if (typeof target === "string") return NextResponse.json({ error: target }, { status: 400 });

  const supabase = createClient();
  const { error } = await supabase
    .from("payroll_rulings")
    .delete()
    .eq("check_id", target.check_id)
    .eq("finding_key", target.finding_key);

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Payroll rulings need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error?.code === RAISED_BY_TRIGGER) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
