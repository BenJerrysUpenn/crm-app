import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/callDesk/compliance";

export const dynamic = "force-dynamic";

// POST /api/call-desk/dnc/import
//
// Load a registry scrub (bj-finance #420). Body:
//   { csv: string, source: 'national' | 'pa_list', mark_clear?: boolean }
//
// `csv` is whatever the registry hands over — one number per line, or a CSV
// with the number in any column. Everything that is not a digit is thrown
// away and each field is normalised to ten digits, so a file of
// "2155550134", "(215) 555-0134" and "+1-215-555-0134" all land on one key.
//
// Matching prospects are stamped with the registry they appeared on and can
// never be dialled from the desk again. Non-matching prospects are stamped
// 'clear' ONLY when mark_clear is true — and the RPC still refuses to clear a
// number that a registry or the customer has already put beyond reach, so a
// partial file can never un-flag anyone. That asymmetry is deliberate: the
// cost of a wrong "clear" is a violation, the cost of a wrong "unknown" is a
// call we didn't make.
//
// Manager-only, like every other page and route here: middleware.ts bounces
// any profile whose role is not 'manager' before the handler runs, and the
// RPC is SECURITY INVOKER on top of the manager RLS policies.

const MAX_BYTES = 8_000_000;
const SOURCES = ["national", "pa_list"] as const;
type Source = (typeof SOURCES)[number];

// Not exported: Next type-checks route files and rejects any export that is
// not a handler or a route segment option.
/** Every 10-digit number in a blob of CSV or newline-separated text. */
function parsePhoneList(csv: string): string[] {
  const seen = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    for (const field of line.split(/[,;\t|]/)) {
      const digits = normalizePhone(field);
      // A header row, a date column or an area-code count all fail this.
      if (digits && digits.length === 10) seen.add(digits);
    }
  }
  return Array.from(seen);
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let raw: Record<string, unknown>;
  try {
    raw = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  const csv = typeof raw.csv === "string" ? raw.csv : "";
  if (!csv.trim())
    return NextResponse.json({ error: "Paste the list first." }, { status: 400 });
  if (csv.length > MAX_BYTES)
    return NextResponse.json(
      { error: "That file is too big to paste — split it." },
      { status: 413 },
    );

  const source = raw.source as Source;
  if (!SOURCES.includes(source))
    return NextResponse.json(
      { error: "source must be 'national' or 'pa_list'" },
      { status: 400 },
    );

  const markClear = raw.mark_clear === true;

  const phones = parsePhoneList(csv);
  if (!phones.length)
    return NextResponse.json(
      { error: "No 10-digit phone numbers found in that text." },
      { status: 400 },
    );

  const { data, error } = await supabase.rpc("call_desk_dnc_import", {
    p_phones: phones,
    p_source: source,
    p_mark_clear: markClear,
  });
  if (error)
    return NextResponse.json({ error: error.message }, { status: 500 });

  // The RPC RETURNS TABLE, so PostgREST hands back an array of one row.
  const result = (Array.isArray(data) ? data[0] : data) as
    | { numbers: number; matched: number; cleared: number }
    | null
    | undefined;

  return NextResponse.json({
    ok: true,
    source,
    mark_clear: markClear,
    numbers: result?.numbers ?? phones.length,
    matched: result?.matched ?? 0,
    cleared: result?.cleared ?? 0,
  });
}
