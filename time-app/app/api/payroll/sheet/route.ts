import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { financeAccess } from "@/lib/financeAccess";
import { isMissingTable } from "@/lib/storeHours";
import { NEEDS_MIGRATION, loadPaySheet } from "@/lib/payroll/loadPaySheet";
import { payWindowEnding } from "@/lib/payroll/window";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// See ../verify/route.ts: a cached read would show a build that has since been
// replaced, or a request as queued after it was built.
export const fetchCache = "force-no-store";

/** Postgres: unique_violation (one request in flight per period). */
const UNIQUE_VIOLATION = "23505";

/**
 * GET /api/payroll/sheet?window_end=YYYY-MM-DD
 *
 * The period's pay table (bj-finance #519, Alina 2026-10-05): the latest
 * built sheet from public.payroll_sheets (migration 36), the latest request's
 * state, and the latest change to a punch, shift or choice bearing on the
 * period. Manager-only, twice over: here, and RLS. Before migration 36 it
 * answers { available: false } rather than failing.
 */
export async function GET(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const resolved = payWindowEnding(new URL(request.url).searchParams.get("window_end") ?? "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  return NextResponse.json(await loadPaySheet(createClient(), resolved.window));
}

/**
 * POST /api/payroll/sheet   Body: { window_end }
 *
 * "Rebuild pay table". Records a request; it builds nothing. Vercel cannot
 * build the sheet (the tips need the Square and Olo exports on the Mac), so
 * the bj-finance runner daemon on the Mac picks the request up within a
 * minute, builds the sheet and writes it back. payroll_sheets is written by
 * the service role only (migration 36: managers read it, nobody signed in
 * writes it), so the manager is checked here and the row is inserted with the
 * service-role key, in the manager's name. A press while one is already
 * queued or building answers with that one.
 */
export async function POST(request: Request) {
  const me = await getProfile();
  if (!me || financeAccess(me) !== "allowed")
    return NextResponse.json({ error: "Managers only" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { window_end?: unknown } | null;
  const resolved = payWindowEnding(typeof body?.window_end === "string" ? body.window_end : "");
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  const { error } = await createAdminClient()
    .from("payroll_sheets")
    .insert({ window_end: resolved.window.end, requested_by: me.id });
  if (isMissingTable(error))
    return NextResponse.json({ error: `The pay table cannot be built yet: ${NEEDS_MIGRATION}` }, { status: 503 });
  if (error && error.code !== UNIQUE_VIOLATION) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json(await loadPaySheet(createClient(), resolved.window));
}
