import type { SupabaseClient } from "@supabase/supabase-js";

// Auto-creates open shifts in the time-app when a catering deal is booked. An
// open shift is employee_id=null; it is written live (published=true), like
// every shift: the time-app has no drafts, so staff see it on the schedule.
// They cannot claim or request it: the deal_id stamped below marks it as one a
// manager assigns (time-app lib/managerAssigns.ts). We create one shift per crew
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
// a person. Deal 25156 (2026-09-27) had labor_hours = 26, which became
// shift 350 running 13:30 on the 27th to 15:30 on the 28th, and it was
// published: no layer between the deal and the schedule ever asked whether a
// human could work it.
//
// We still create the shifts — the crew must not lose their slot over a bad
// number, and guessing a "sensible" length would quietly hide the error. We
// just refuse to do it silently. There is no publish step to stop it any more
// (the time-app has no drafts), so the shift goes live carrying the marker in
// its note, and the warning goes back to the route, cron or CLI that made it.
//
// The time-app repeats this number in time-app/lib/shiftChecks.ts. The two are
// separate Next apps (the root tsconfig excludes time-app/), so they cannot
// share a module. Change both together.
const LONG_SHIFT_HOURS = 15;

// The stages at which a booked event should have crew shifts.
export const BOOKED_STAGES = ["Booked Unpaid", "Booked Paid"];

export type DealTimes = {
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

// One catering shift, as it is written to the time-app's `shifts` table.
export type ShiftRow = {
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string;
  notes: string;
  published: boolean;
  deal_id: number;
  deal_slot: number;
};

// The three things the shift logic needs from the database, and nothing else.
// This is the seam between the rules (this file) and a database client: the
// web routes pass a supabase-js adapter (supabaseShiftStore below), and the
// local reconcile CLI passes a direct Postgres adapter
// (lib/cateringShiftsPg.ts). Every decision about WHICH shifts to create, and
// what they say, stays here, so both callers create exactly the same shifts.
export interface ShiftStore {
  // Booked deals (BOOKED_STAGES) whose departure_time is set, with
  // DEAL_SHIFT_COLUMNS. Throws if the read fails.
  bookedDealsWithDeparture(): Promise<DealTimes[]>;
  // Does any shift already carry this deal_id?
  dealHasShifts(dealId: number): Promise<boolean>;
  // Insert the rows, skipping any (deal_id, deal_slot) that already exists.
  // Returns how many rows were actually inserted. Throws on failure.
  insertShiftsIgnoringDuplicates(rows: ShiftRow[]): Promise<number>;
  // Optional. Prove the rows WOULD insert (the statement plans against the
  // real table and index) without inserting them. A dry run calls it when the
  // store has one; throws if the insert would be refused.
  rehearseInsert?(rows: ShiftRow[]): Promise<void>;
}

// The supabase-js adapter, used by the web routes with the service-role
// client. Behaviour is exactly what those routes have always had, including
// that a failed "already exists?" read is treated as "no shifts yet" and left
// for the unique index to catch.
export function supabaseShiftStore(admin: SupabaseClient): ShiftStore {
  return {
    async bookedDealsWithDeparture() {
      const { data, error } = await admin
        .from("deals")
        .select(DEAL_SHIFT_COLUMNS)
        .in("stage", BOOKED_STAGES)
        .not("departure_time", "is", null);
      if (error) throw new Error(error.message);
      return (data ?? []) as DealTimes[];
    },
    async dealHasShifts(dealId) {
      const { data: existing } = await admin
        .from("shifts")
        .select("id")
        .eq("deal_id", dealId)
        .limit(1);
      return !!existing && existing.length > 0;
    },
    // PostgREST sends this as ON CONFLICT (deal_id, deal_slot) DO NOTHING and
    // has no way to add a WHERE, so it needs a PLAIN unique index on exactly
    // those columns: shifts_deal_slot_uidx as migration 29 left it
    // (time-app/supabase/migration_29.sql). Against migration 18's partial
    // index every insert is refused (crm-app #35).
    async insertShiftsIgnoringDuplicates(rows) {
      const { error, data } = await admin
        .from("shifts")
        .upsert(rows, { onConflict: "deal_id,deal_slot", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(error.message);
      return data?.length ?? 0;
    },
  };
}

// Build the shift rows a deal should get, or say why it gets none yet.
// Pure: no database. Shared by every store so the rows cannot drift.
export function planCateringShifts(
  deal: DealTimes,
): { rows: ShiftRow[]; warning?: string } | { skipped: true; reason: string } {
  const win = computeShiftWindow(deal);
  if (!win) {
    return { skipped: true, reason: "no departure_time yet (picklist not generated)" };
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
  // has a unique index on (deal_id, deal_slot), and the store inserts ignoring
  // conflicts — so even if two calls race past the "already exists?" guard,
  // the second inserts nothing instead of duplicating. Multi-crew events are
  // fine because their slots differ.
  const rows: ShiftRow[] = Array.from({ length: crew }).map((_, i) => ({
    employee_id: null,
    starts_at: win.startISO,
    ends_at: win.endISO,
    position: CATERING_POSITION,
    notes,
    published: true,
    deal_id: deal.id,
    deal_slot: i + 1,
  }));

  return { rows, ...(marker ? { warning: `Deal #${deal.id}: ${marker}` } : {}) };
}

// Create the shifts for a booked deal through any store. Idempotent by
// deal_id.
export async function createCateringShifts(
  store: ShiftStore,
  deal: DealTimes,
): Promise<CreateResult> {
  // Already handled? Never touch again.
  if (await store.dealHasShifts(deal.id)) {
    return { created: 0, skipped: true, reason: "shifts already exist for this deal" };
  }

  const plan = planCateringShifts(deal);
  if ("skipped" in plan) return { created: 0, skipped: true, reason: plan.reason };

  const created = await store.insertShiftsIgnoringDuplicates(plan.rows);
  return { created, ...(plan.warning ? { warning: plan.warning } : {}) };
}

// Create the shifts for a booked deal. Idempotent by deal_id. The
// supabase-js entry point the booked-shifts route calls.
export async function createCateringShiftsForDeal(
  admin: SupabaseClient,
  deal: DealTimes,
): Promise<CreateResult> {
  return createCateringShifts(supabaseShiftStore(admin), deal);
}

// Columns we need off a deal to build its shifts. Shared by the instant trigger
// and the reconcile sweep so they stay in lockstep.
export const DEAL_SHIFT_COLUMNS =
  "id, stage, event_date, departure_time, event_start_time, event_end_time, labor_hours, staff_count, cart_service, company, venue_name, venue_address";

// Everything a reconcile sweep did. `created` counts shifts; `createdFor`
// names each deal that got shifts and how many; `failed` names each deal whose
// shifts could not be created, and why.
export type ReconcileReport = {
  scanned: number;
  created: number;
  deals: number;
  warnings: string[];
  createdFor: { dealId: number; shifts: number }[];
  failed: { dealId: number; message: string }[];
};

// Sweep every booked deal that now has a departure_time (i.e. its picklist has
// been generated) and create any missing shifts. Idempotent and safe to
// run on a schedule; it's how a deal gets its shifts when the picklist is
// generated AFTER booking (the moment the stage-change trigger can't catch).
//
// One deal failing never stops the sweep: its error is recorded in `failed`
// and the next deal is tried.
export async function reconcileShifts(store: ShiftStore): Promise<ReconcileReport> {
  const deals = await store.bookedDealsWithDeparture();

  let created = 0;
  // Deals whose hours are not credible. Carried out to the caller so the sweep
  // cannot create an impossible shift without leaving a trace.
  const warnings: string[] = [];
  const createdFor: ReconcileReport["createdFor"] = [];
  const failed: ReconcileReport["failed"] = [];
  for (const deal of deals) {
    let r: CreateResult;
    try {
      r = await createCateringShifts(store, deal);
    } catch (e) {
      failed.push({ dealId: deal.id, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!("skipped" in r && r.skipped) && r.created > 0) {
      created += r.created;
      createdFor.push({ dealId: deal.id, shifts: r.created });
      if (r.warning) warnings.push(r.warning);
    }
  }
  return { scanned: deals.length, created, deals: createdFor.length, warnings, createdFor, failed };
}

// The sweep the cron route runs, through the supabase-js client. Returns the
// same four fields the route has always returned.
export async function reconcileBookedDeals(
  admin: SupabaseClient,
): Promise<{ scanned: number; created: number; deals: number; warnings: string[] }> {
  const { scanned, created, deals, warnings } = await reconcileShifts(supabaseShiftStore(admin));
  return { scanned, created, deals, warnings };
}
