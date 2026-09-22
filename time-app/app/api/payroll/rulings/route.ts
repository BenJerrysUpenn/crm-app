import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { isMissingTable } from "@/lib/storeHours";
import { RULING_CHOICES } from "@/lib/payroll/verify";
import { payWindowEnding } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// See the note in ../verify/route.ts: force-dynamic does not stop Next caching
// a route handler's own fetches, and a stale read of the rulings table would
// show a manager an answer they have just changed.
export const fetchCache = "force-no-store";

const MAX_NOTE = 2000;

type Body = {
  window_end?: unknown;
  check_id?: unknown;
  finding_key?: unknown;
  choice?: unknown;
  note?: unknown;
};

type Parsed = { window_end: string; check_id: string; finding_key: string };

/**
 * Validate what every ruling call has in common: which window, which check,
 * which finding.
 *
 * The check must be one the spec makes a RULING (§1.4, §1.5, §1.9). Recording
 * a "ruling" against an auto-resolved check would be a decision nobody is
 * entitled to make: those are decided by rule, and the rule is the record.
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
// Body: { window_end, check_id, finding_key, choice, note? }
//
// Records one manager's answer to one ruling-class finding (bj-finance #519,
// payroll spec §1). Re-answering the same finding replaces the previous answer
// rather than adding a second one: the unique index is (window_end, check_id,
// finding_key), so the table holds the decision that stands.
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
  // against anything the browser offered.
  const choice = typeof body.choice === "string" ? body.choice.trim() : "";
  const allowed = RULING_CHOICES[target.check_id];
  if (!allowed.includes(choice))
    return NextResponse.json(
      { error: `${choice || "That choice"} is not one of the options for check ${target.check_id}.` },
      { status: 400 },
    );

  const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE) || null : null;

  const supabase = createClient();
  const { data, error } = await supabase
    .from("payroll_rulings")
    .upsert(
      {
        ...target,
        choice,
        note,
        decided_by: me.id,
        decided_at: new Date().toISOString(),
      },
      { onConflict: "window_end,check_id,finding_key" },
    )
    .select()
    .single();

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Payroll rulings need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ruling: data });
}

// DELETE /api/payroll/rulings?window_end=&check_id=&finding_key=
//
// Un-answers a finding, putting it back in front of the person. Deleting the
// row rather than writing an empty choice keeps "not answered yet" a single
// state — the button's rule reads it once, and there is no second way to be
// unanswered.
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
    .eq("window_end", target.window_end)
    .eq("check_id", target.check_id)
    .eq("finding_key", target.finding_key);

  if (isMissingTable(error))
    return NextResponse.json(
      { error: "Payroll rulings need migration 27. Run it in Supabase first." },
      { status: 503 },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
