import type { SupabaseClient } from "@supabase/supabase-js";

// Auto-creates open "draft" shifts in the time-app when a catering deal is
// booked. A draft shift is simply published=false + employee_id=null, which the
// time-app's RLS makes visible to managers only. We create one shift per crew
// member (staff_count), each running for the deal's labor_hours, starting ~1
// hour before the crew's departure_time.
//
// Idempotent: every shift is stamped with deal_id, and we skip creation if any
// shift already exists for that deal. That makes the endpoint safe to call on
// any transition into Booked Unpaid without ever double-creating.

const CATERING_POSITION = "Catering";
const PRE_DEPARTURE_MIN = 60; // start this many minutes before departure
const DEFAULT_STAFF = 1;
const DEFAULT_LABOR_HOURS = 4;

// The stages at which a booked event should have crew shifts.
const BOOKED_STAGES = ["Booked Unpaid", "Booked Paid"];

type DealTimes = {
  id: number;
  stage?: string | null;
  event_date?: string | null; // "YYYY-MM-DD"
  departure_time?: string | null; // "HH:MM" (24h, America/New_York)
  event_start_time?: string | null; // "HH:MM"
  event_end_time?: string | null; // "HH:MM"
  labor_hours?: number | null;
  staff_count?: number | null;
  company?: string | null;
  venue_name?: string | null;
  venue_address?: string | null;
};

// Minutes that America/New_York is offset from UTC at the given instant
// (handles EST/EDT automatically). Returns a negative number (e.g. -240 in
// summer, -300 in winter).
function nyOffsetMinutes(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p = dtf.formatToParts(at).reduce<Record<string, string>>((a, x) => {
    a[x.type] = x.value;
    return a;
  }, {});
  // `24` shows up at midnight in some runtimes; normalise to 0.
  const hour = p.hour === "24" ? "0" : p.hour;
  const asUTC = Date.UTC(
    +p.year,
    +p.month - 1,
    +p.day,
    +hour,
    +p.minute,
    +p.second,
  );
  return (asUTC - at.getTime()) / 60000;
}

// Interpret a NY wall-clock date+time ("YYYY-MM-DD", "HH:MM") as a real instant
// and return its UTC ISO string. Two-step: guess the instant as if the wall
// time were UTC, look up NY's offset at that guess, then correct.
function nyWallTimeToUTCISO(dateStr: string, timeStr: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = /^(\d{1,2}):(\d{2})/.exec(timeStr.trim());
  if (!dm || !tm) return null;
  const [, y, mo, d] = dm;
  const [, hh, mm] = tm;
  const guess = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
  const offset = nyOffsetMinutes(new Date(guess));
  return new Date(guess - offset * 60000).toISOString();
}

// Work out the shift's UTC start/end from the deal. Requires departure_time,
// which the catering automation only sets once a picklist has been generated —
// that's our guarantee the timing is real. No departure_time => no shift yet
// (returns null; the caller skips and a later reconcile picks it up once the
// picklist runs).
export function computeShiftWindow(
  deal: DealTimes,
): { startISO: string; endISO: string } | null {
  const date = (deal.event_date ?? "").trim();
  const departure = (deal.departure_time ?? "").trim();
  if (!date || !departure) return null;

  const baseISO = nyWallTimeToUTCISO(date, departure);
  if (!baseISO) return null;

  const laborHours =
    typeof deal.labor_hours === "number" && deal.labor_hours > 0
      ? deal.labor_hours
      : DEFAULT_LABOR_HOURS;

  const start = new Date(new Date(baseISO).getTime() - PRE_DEPARTURE_MIN * 60000);
  const end = new Date(start.getTime() + laborHours * 60 * 60000);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

export type CreateResult =
  | { created: number; skipped?: false }
  | { created: 0; skipped: true; reason: string };

// Create the draft shifts for a booked deal. Idempotent by deal_id.
export async function createDraftShiftsForDeal(
  admin: SupabaseClient,
  deal: DealTimes,
): Promise<CreateResult> {
  // Already handled? Never touch again.
  const { data: existing } = await admin
    .from("shifts")
    .select("id")
    .eq("deal_id", deal.id)
    .limit(1);
  if (existing && existing.length > 0) {
    return { created: 0, skipped: true, reason: "shifts already exist for this deal" };
  }

  const win = computeShiftWindow(deal);
  if (!win) {
    return {
      created: 0,
      skipped: true,
      reason: "no departure_time yet (picklist not generated)",
    };
  }

  const crew =
    typeof deal.staff_count === "number" && deal.staff_count > 0
      ? Math.floor(deal.staff_count)
      : DEFAULT_STAFF;

  const where = deal.venue_name || deal.company || "Catering event";
  const noteBits = [
    `Auto-created from booked deal #${deal.id}`,
    where,
    deal.venue_address || null,
  ].filter(Boolean);
  const notes = noteBits.join(" · ");

  // One row per crew member, each with a stable per-deal slot (1..crew). The DB
  // has a unique index on (deal_id, deal_slot), and we upsert ignoring
  // conflicts — so even if two calls race past the guard above, the second
  // inserts nothing instead of duplicating. Multi-crew events are fine because
  // their slots differ.
  const rows = Array.from({ length: crew }).map((_, i) => ({
    employee_id: null as string | null,
    starts_at: win.startISO,
    ends_at: win.endISO,
    position: CATERING_POSITION,
    notes,
    published: false,
    deal_id: deal.id,
    deal_slot: i + 1,
  }));

  const { error, data } = await admin
    .from("shifts")
    .upsert(rows, { onConflict: "deal_id,deal_slot", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return { created: data?.length ?? 0 };
}

// Columns we need off a deal to build its shifts. Shared by the instant trigger
// and the reconcile sweep so they stay in lockstep.
export const DEAL_SHIFT_COLUMNS =
  "id, stage, event_date, departure_time, event_start_time, event_end_time, labor_hours, staff_count, company, venue_name, venue_address";

// Sweep every booked deal that now has a departure_time (i.e. its picklist has
// been generated) and create any missing draft shifts. Idempotent and safe to
// run on a schedule; it's how a deal gets its shifts when the picklist is
// generated AFTER booking (the moment the stage-change trigger can't catch).
export async function reconcileBookedDeals(
  admin: SupabaseClient,
): Promise<{ scanned: number; created: number; deals: number }> {
  const { data: deals, error } = await admin
    .from("deals")
    .select(DEAL_SHIFT_COLUMNS)
    .in("stage", BOOKED_STAGES)
    .not("departure_time", "is", null);
  if (error) throw new Error(error.message);

  let created = 0;
  let touched = 0;
  for (const deal of (deals ?? []) as DealTimes[]) {
    const r = await createDraftShiftsForDeal(admin, deal).catch(() => null);
    if (r && !("skipped" in r && r.skipped) && r.created > 0) {
      created += r.created;
      touched += 1;
    }
  }
  return { scanned: deals?.length ?? 0, created, deals: touched };
}
