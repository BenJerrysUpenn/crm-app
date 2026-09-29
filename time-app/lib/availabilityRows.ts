// Loading availability rows for lib/availabilityCheck.ts. Server-only: it takes
// a Supabase client, so it lives apart from the pure module.
//
// Two reads, never one: dated rows for the dates in question, and every weekly
// row. Weekly rows are how most people set their availability (the "Repeats
// every …" toggle on the Availability calendar writes weekday, not
// specific_date), so a reader that only asks for dated rows sees them as
// having no availability at all.

import type { AvailabilityRow } from "@/lib/availabilityCheck";

const COLUMNS = "employee_id, weekday, specific_date, start_time, end_time, is_available, status, preference";

// Just the slice of the Supabase client this file uses, so both the cookie
// client and the admin client fit.
type Client = { from: (table: string) => any };

/**
 * Availability for `employeeIds` (all employees when omitted) over the
 * inclusive date range, plus their weekly rows. `ok: false` means the read
 * failed; callers must not treat that as "nobody has any availability".
 */
export async function loadAvailabilityRows(
  supabase: Client,
  range: { from: string; to: string },
  employeeIds?: string[],
): Promise<{ ok: true; rows: AvailabilityRow[] } | { ok: false }> {
  if (employeeIds && employeeIds.length === 0) return { ok: true, rows: [] };
  try {
    let dated = supabase
      .from("availability")
      .select(COLUMNS)
      .not("specific_date", "is", null)
      .gte("specific_date", range.from)
      .lte("specific_date", range.to);
    let weekly = supabase.from("availability").select(COLUMNS).not("weekday", "is", null);
    if (employeeIds) {
      dated = dated.in("employee_id", employeeIds);
      weekly = weekly.in("employee_id", employeeIds);
    }
    const [d, w] = await Promise.all([dated, weekly]);
    if (d.error || w.error) return { ok: false };
    return { ok: true, rows: [...((d.data ?? []) as AvailabilityRow[]), ...((w.data ?? []) as AvailabilityRow[])] };
  } catch {
    return { ok: false };
  }
}
