import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { dayKey } from "@/lib/format";
import { loadVerify } from "@/lib/payroll/loadVerify";
import { currentPayWindow, payWindowEnding, type PayWindow } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// force-dynamic alone does not stop Next caching the fetches this route makes.
// Next 14 patches global fetch and caches any GET a route handler issues unless
// it says otherwise (see lib/supabase/admin.ts, and PR #12 where a cached
// "has this person clocked in?" answer was served back for a whole day). The
// URL this route asks Supabase is identical every time Verify is pressed, so
// without this a second press would answer with the first press's timesheets.
export const fetchCache = "force-no-store";

/**
 * GET /api/payroll/verify?window_end=YYYY-MM-DD
 *
 * The §1 timesheet checks for one pay window (bj-finance #519), with every
 * per-case choice attached and the run's approval state. Manager-only: these
 * findings name people, hours and money. The Finance tab and the schedule's
 * solo-close dropdowns both read it.
 *
 * `window_end` must be a Sunday (§0.1). Omitted, it defaults to the period that
 * has most recently finished — never to a period QBO suggests, whose dates are
 * misaligned with the ones this business runs.
 *
 * Read-only. Choices are recorded through /api/payroll/rulings, the approval
 * through /api/payroll/approve, each by the person who made it.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || profile.role !== "manager")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });

  const today = dayKey(new Date().toISOString());
  const param = new URL(request.url).searchParams.get("window_end");

  let window: PayWindow;
  if (param) {
    const resolved = payWindowEnding(param);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    window = resolved.window;
  } else {
    window = currentPayWindow(today);
  }

  const loaded = await loadVerify(createClient(), window, today);
  if (!loaded.ok) return NextResponse.json({ error: loaded.error }, { status: 400 });
  return NextResponse.json(loaded.result);
}
