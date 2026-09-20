import type { SupabaseClient } from "@supabase/supabase-js";

// Auto-creates open "draft" shifts in the time-app when a catering deal is
// booked. A draft shift is simply published=false + employee_id=null, which the
// time-app's RLS makes visible to managers only. We create one shift per crew
// member (staff_count), each running for the deal's labor_hours, starting ~1
// hour before the crew's departure_time.
//
// Cart events are the exception: the crew has to collect the ice cream cart
// from the storage unit first, so their shift starts two hours before departure
// instead of one. See CART_STORAGE_PICKUP_MIN.
//
// Idempotent: every shift is stamped with deal_id, and we skip creation if any
// shift already exists for that deal. That makes the endpoint safe to call on
// any transition into Booked Unpaid without ever double-creating.

const CATERING_POSITION = "Catering";
const PRE_DEPARTURE_MIN = 60; // start this many minutes before departure
const DEFAULT_STAFF = 1;
const DEFAULT_LABOR_HOURS = 4;

// A cart event's crew does not start at the shop: they go to the storage unit
// to collect and pack the ice cream cart, then leave at departure_time. That is
// two hours before departure, not one.
//
// This mirrors STORAGE_UNIT_BUFFER_MIN in the catering automation's
// modules/logistics.py (a separate Python repo), which computes
// storage_pickup_time = departure_time - 120 min and prints it on the picklist.
// It never writes that time back to `deals`, so this app has to derive it the
// same way. The two numbers must change together — if they drift, the picklist
// tells the crew to be at the storage unit at a time their shift has not
// started.
//
// The extra hour is ADDED, not shifted: the end of the shift stays exactly
// where labor_hours puts it, so a cart shift is one hour longer than the quote
// priced. That is deliberate — the hour is real work that the quote's
// labor_hours has no component for.
const CART_STORAGE_PICKUP_MIN = 120;

// At or above this many hours a shift is not credible and must be looked at by
// a person. Deal 25156 (Terrain, 2026-09-27) had labor_hours = 26, which became
// shift 350 running 13:30 on the 27th to 15:30 on the 28th, and it was
// published: no layer between the deal and the schedule ever asked whether a
// human could work it.
//
// We still create the shifts — the crew must not lose their slot over a bad
// number, and guessing a "sensible" length would quietly hide the error. We
// just refuse to do it silently.
//
// The time-app repeats this number in time-app/lib/shiftChecks.ts. The two are
// separate Next apps (the root tsconfig excludes time-app/), so they cannot
// share a module. Change both together.
const LONG_SHIFT_HOURS = 15;

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
  // 1 when the event includes the ice cream cart. Written as an integer 0/1 by
  // the deal form and kept in sync with the "Ice Cream Cart" extra, but typed
  // loosely here because it reaches us straight off a row.
  cart_service?: number | string | boolean | null;
  company?: string | null;
  venue_name?: string | null;
  venue_address?: string | null;
};

/**
 * Does this deal include the ice cream cart?
 *
 * `cart_service` is an integer 0/1 column, but it arrives unvalidated from a
 * database row and a `"1"` string or a `true` would be just as meaningful.
 * Anything else — 0, null, undefined, "" — means no cart. The bias is towards
 * not claiming a cart that isn't there: a false positive would send the crew to
 * the storage unit for nothing.
 */
export function isCartEvent(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "1" || v === "true";
  }
  return false;
}

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
//
// A cart event starts earlier (at the storage unit) and ends in the same place
// it otherwise would, so its shift is one hour longer than labor_hours.
//
// `hours` is the real length of the shift, not what the quote priced — it is
// what the long-shift check judges and what a person reads on the card.
// `laborHours` is what the deal asked for, so a caller can tell the two apart.
// Nothing here clamps either.
export function computeShiftWindow(deal: DealTimes): {
  startISO: string;
  endISO: string;
  hours: number;
  laborHours: number;
  cartEvent: boolean;
} | null {
  const date = (deal.event_date ?? "").trim();
  const departure = (deal.departure_time ?? "").trim();
  if (!date || !departure) return null;

  const baseISO = nyWallTimeToUTCISO(date, departure);
  if (!baseISO) return null;

  const laborHours =
    typeof deal.labor_hours === "number" && deal.labor_hours > 0
      ? deal.labor_hours
      : DEFAULT_LABOR_HOURS;

  const departureMs = new Date(baseISO).getTime();
  const cartEvent = isCartEvent(deal.cart_service);

  // The end never moves: it is anchored to the ordinary start plus the hours
  // the quote priced. The cart only pulls the start earlier.
  const endMs = departureMs - PRE_DEPARTURE_MIN * 60000 + laborHours * 60 * 60000;
  const leadMin = cartEvent ? CART_STORAGE_PICKUP_MIN : PRE_DEPARTURE_MIN;
  const startMs = departureMs - leadMin * 60000;

  return {
    startISO: new Date(startMs).toISOString(),
    endISO: new Date(endMs).toISOString(),
    hours: (endMs - startMs) / 3600000,
    laborHours,
    cartEvent,
  };
}

// True when the deal is asking for a shift no one could work.
export function isLongShiftHours(hours: number): boolean {
  return hours >= LONG_SHIFT_HOURS;
}

function showHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}

// The marker that goes at the front of the shift notes, and into the API
// response, when the shift's hours are not credible. Deliberately shouty and
// deliberately first in the notes, so it is the first thing a manager reads on
// the shift card.
//
// `shiftHours` is the real length; `laborHours` is what the deal priced. On a
// cart event they differ by the storage-unit hour, and the message has to say
// so — sending someone to check a deal for "15.5h" when the deal plainly says
// 14.5 wastes the trip.
export function longShiftWarning(shiftHours: number, laborHours: number = shiftHours): string {
  if (Math.abs(shiftHours - laborHours) < 0.001) {
    return `CHECK HOURS: deal says ${showHours(shiftHours)}h per person.`;
  }
  const added = showHours(shiftHours - laborHours);
  return `CHECK HOURS: shift is ${showHours(shiftHours)}h per person (deal says ${showHours(laborHours)}h plus ${added}h cart pickup).`;
}

// Goes on every cart event's shift note so the crew knows where to be, and the
// manager knows why the shift starts earlier than the quote's hours imply.
export const CART_NOTE = "Cart event: start at the storage unit, includes 1h cart pickup";

export type CreateResult =
  | { created: number; skipped?: false; warning?: string }
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
  // labor_hours is PER STAFF MEMBER: every crew member gets their own shift of
  // that length. A plausible number is a working day; 26 is not one, and the
  // shape of the error (roughly a day's work times a small crew) is what a
  // total-hours figure would look like if it were written into a per-person
  // field. We do not assume that — we flag it and let a person decide.
  //
  // The check judges win.hours, the real length of the shift — a cart event's
  // storage-unit hour is worked whether or not the quote priced it.
  const longShift = isLongShiftHours(win.hours);
  const marker = longShift ? longShiftWarning(win.hours, win.laborHours) : null;
  const noteBits = [
    marker,
    win.cartEvent ? CART_NOTE : null,
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
  return {
    created: data?.length ?? 0,
    ...(marker ? { warning: `Deal #${deal.id}: ${marker}` } : {}),
  };
}

// Columns we need off a deal to build its shifts. Shared by the instant trigger
// and the reconcile sweep so they stay in lockstep.
export const DEAL_SHIFT_COLUMNS =
  "id, stage, event_date, departure_time, event_start_time, event_end_time, labor_hours, staff_count, cart_service, company, venue_name, venue_address";

// Sweep every booked deal that now has a departure_time (i.e. its picklist has
// been generated) and create any missing draft shifts. Idempotent and safe to
// run on a schedule; it's how a deal gets its shifts when the picklist is
// generated AFTER booking (the moment the stage-change trigger can't catch).
export async function reconcileBookedDeals(
  admin: SupabaseClient,
): Promise<{ scanned: number; created: number; deals: number; warnings: string[] }> {
  const { data: deals, error } = await admin
    .from("deals")
    .select(DEAL_SHIFT_COLUMNS)
    .in("stage", BOOKED_STAGES)
    .not("departure_time", "is", null);
  if (error) throw new Error(error.message);

  let created = 0;
  let touched = 0;
  // Deals whose hours are not credible. Carried out to the cron response so the
  // sweep cannot create an impossible shift without leaving a trace.
  const warnings: string[] = [];
  for (const deal of (deals ?? []) as DealTimes[]) {
    const r = await createDraftShiftsForDeal(admin, deal).catch(() => null);
    if (r && !("skipped" in r && r.skipped) && r.created > 0) {
      created += r.created;
      touched += 1;
      if (r.warning) warnings.push(r.warning);
    }
  }
  return { scanned: deals?.length ?? 0, created, deals: touched, warnings };
}
