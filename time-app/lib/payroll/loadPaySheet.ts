// Loads one period's pay table (public.payroll_sheets, migration 36) for the
// payroll page and the submit route. Server-only: it takes the request's
// Supabase client, so every read runs under the manager's own RLS. Read-only.
//
// Safe before migration 36: a missing table answers { available: false } and
// the page says so, rather than failing.

import type { createClient } from "@/lib/supabase/server";
import { isMissingTable } from "@/lib/storeHours";
import type { AuditRow } from "@/lib/payroll/verify";
import type { PayWindow } from "@/lib/payroll/window";
import {
  META_COLUMNS,
  inputsChangedAt,
  type PaySheetBuild,
  type PaySheetMeta,
  type PaySheetState,
  type RulingStamp,
} from "@/lib/payroll/paySheet";

type Supabase = ReturnType<typeof createClient>;

export const NEEDS_MIGRATION = "it needs migration 36 in Supabase.";

/** Rows per page when reading row_audit, PostgREST's default cap. */
const AUDIT_PAGE = 1000;
const AUDIT_MAX_PAGES = 20;

export async function loadPaySheet(supabase: Supabase, window: PayWindow): Promise<PaySheetState> {
  const [builtRes, latestRes, countRes] = await Promise.all([
    supabase
      .from("payroll_sheets")
      .select(`${META_COLUMNS}, sheet`)
      .eq("window_end", window.end)
      .eq("status", "built")
      .order("built_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1),
    supabase
      .from("payroll_sheets")
      .select(META_COLUMNS)
      .eq("window_end", window.end)
      .order("requested_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1),
    supabase.from("payroll_sheets").select("id", { count: "exact", head: true }).eq("window_end", window.end).eq("status", "built"),
  ]);
  for (const res of [builtRes, latestRes, countRes]) {
    if (isMissingTable(res.error)) return { available: false, reason: NEEDS_MIGRATION };
    if (res.error) return { available: false, reason: `it could not be read (${res.error.message}).` };
  }
  const built = ((builtRes.data ?? [])[0] ?? null) as PaySheetBuild | null;
  const latest = ((latestRes.data ?? [])[0] ?? null) as PaySheetMeta | null;
  const changedAt = built ? await changesSince(supabase, window, built.started_at) : null;
  return { available: true, built, latest, changedAt, builds: countRes.count ?? 0 };
}

/**
 * The latest write bearing on the period since `since` (the build's start),
 * or null. Only writes after the build can make it stale, so only those are
 * read. A read that fails reports the build as stale, never as fresh.
 */
async function changesSince(supabase: Supabase, window: PayWindow, since: string): Promise<string | null> {
  const audits: AuditRow[] = [];
  for (let page = 0; page < AUDIT_MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from("row_audit")
      .select("id, table_name, row_id, op, at, actor_uid, actor_role, db_role, before_image, after_image")
      .in("table_name", ["time_entries", "shifts", "payroll_rulings"])
      .gt("at", since)
      .order("id")
      .range(page * AUDIT_PAGE, (page + 1) * AUDIT_PAGE - 1);
    if (error) return new Date().toISOString();
    const rows = (data ?? []) as AuditRow[];
    audits.push(...rows);
    if (rows.length < AUDIT_PAGE) break;
  }
  const rulings = await supabase
    .from("payroll_rulings")
    .select("window_end, case_date, decided_at, created_at")
    .gt("decided_at", since);
  return inputsChangedAt(window, audits, rulings.error ? [] : ((rulings.data ?? []) as RulingStamp[]));
}
