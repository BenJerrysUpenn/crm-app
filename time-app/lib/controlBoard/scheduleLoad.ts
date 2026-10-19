// Server-side reads for the Schedule page's labor line (bj-finance #695).
// Reads as the signed-in manager. The control board's own loader
// (loadBoard) supplies the settings, salaries and the trend's sales; this
// adds last year's days, this week's booked catering deals with the crew
// hours billed on each (deals.labor_hours x staff_count) and the rates of
// anyone on the week's shifts who is no longer active.
//
// A read that fails is reported and what it fed shows as missing, never zero.

import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOKED_STAGES, billedCrewHours, eventDay, isBooked, type DealRow } from "@/lib/metrics/catering";
import { loadBoard } from "./load";
import { trendFactor } from "./math";
import { addDays, scheduleLabor, type CateringBooking, type LaborPerson, type LaborShift, type ScheduleLabor } from "./schedule";

export type ScheduleLaborLoad = { ready: true; labor: ScheduleLabor; problems: string[] } | { ready: false; reason: string };

type ProfileLike = {
  id: string;
  full_name: string | null;
  hourly_rate: number | string | null;
  pay_type?: "hourly" | "salaried" | null;
  active: boolean;
  is_overhead?: boolean;
};
type ShiftTypeLike = { name: string; in_store?: boolean | null };

export const DEAL_COLUMNS = "id, stage, payment_status, event_date, created_at, subtotal_pretax, total_with_tax, amount_paid, company, source, archived, labor_hours, staff_count";

export type BookingDeal = DealRow & { labor_hours: number | string | null; staff_count: number | string | null };

/** A profiles row as the labor math reads it. */
export const PROFILE_COLUMNS = "id, full_name, hourly_rate, pay_type, active, is_overhead";

export function laborPerson(p: ProfileLike): LaborPerson {
  return {
    id: p.id,
    name: p.full_name ?? "Unnamed",
    hourly_rate: p.hourly_rate == null ? null : Number(p.hourly_rate),
    pay_type: p.pay_type ?? null,
    active: p.active,
    overhead: p.is_overhead === true,
  };
}

export async function loadScheduleLabor(
  supabase: SupabaseClient,
  week: { weekStart: string; today: string; shifts: LaborShift[]; employees: ProfileLike[]; shiftTypes: ShiftTypeLike[] },
): Promise<ScheduleLaborLoad> {
  const { weekStart, today } = week;
  const dates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = dates[6];
  // The trend is the last full month before the week (or before today, for a week still ahead).
  const trendDay = weekStart < today ? weekStart : today;
  const board = await loadBoard(supabase, trendDay);
  if (!board.ready) return { ready: false, reason: board.reason };
  const problems = [...board.problems];

  // Everyone active, plus anyone on this week's shifts who is not (their shift still costs).
  const people = new Map<string, LaborPerson>(week.employees.map((e) => [e.id, laborPerson(e)]));
  const absent = [...new Set(week.shifts.map((s) => s.employee_id).filter((id): id is string => !!id && !people.has(id)))];

  const [absentRes, lastYearRes, bookings] = await Promise.all([
    absent.length
      ? supabase.from("profiles").select(PROFILE_COLUMNS).in("id", absent)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("sales_daily_in_store").select("day, in_store").gte("day", addDays(weekStart, -364)).lte("day", addDays(weekEnd, -364)),
    loadCateringBookings(supabase, weekStart, weekEnd, today),
  ]);

  if (absentRes.error) problems.push(`Staff on this week's shifts could not be read: ${absentRes.error.message}`);
  for (const p of (absentRes.data as ProfileLike[] | null) ?? []) people.set(p.id, laborPerson(p));

  const inStoreByDay = new Map<string, number>();
  if (lastYearRes.error) problems.push(`Last year's daily sales could not be read: ${lastYearRes.error.message}`);
  for (const r of (lastYearRes.data as { day: string; in_store: number | string }[] | null) ?? []) inStoreByDay.set(r.day, Number(r.in_store));

  problems.push(...bookings.problems);
  const catering = bookings.catering;

  const labor = scheduleLabor({
    dates,
    shifts: week.shifts,
    people,
    inStoreByName: new Map(week.shiftTypes.map((t) => [t.name, t.in_store !== false])),
    settings: board.settings,
    salaries: board.salaries,
    salaried: board.salaried,
    trend: trendFactor(trendDay, board.monthly, board.daily),
    inStoreByDay,
    catering,
  });
  return { ready: true, labor, problems };
}

const PAGE = 1000; // PostgREST's row cap per request
const ID_CHUNK = 200; // deal ids per stage-history read, to keep the URL short

/**
 * The booked catering deals with an event day from `from` to `to` (New York),
 * each with the crew hours billed on it (deals.labor_hours x staff_count). A
 * deal counts when there is evidence it is booked (isBooked, with its stage
 * history). The Schedule page's labor line and the Labor vs target metric
 * (bj-finance #696) both read them here. A read that fails returns null and
 * says why, so the offset shows as missing, never as no catering.
 */
export async function loadCateringBookings(
  supabase: SupabaseClient,
  from: string,
  to: string,
  today: string,
): Promise<{ catering: CateringBooking[] | null; problems: string[] }> {
  const fail = (message: string) => ({ catering: null, problems: [`Catering bookings could not be read: ${message}`] });
  const deals: BookingDeal[] = [];
  for (let page = 0; ; page++) {
    const res = await supabase
      .from("deals")
      .select(DEAL_COLUMNS)
      .gte("event_date", from)
      .lte("event_date", `${to}T23:59:59`)
      .order("id")
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (res.error) return fail(res.error.message);
    const rows = (res.data as BookingDeal[] | null) ?? [];
    deals.push(...rows);
    if (rows.length < PAGE) break;
  }
  const bookedBefore = new Set<number>();
  for (let k = 0; k < deals.length; k += ID_CHUNK) {
    const ev = await supabase
      .from("deal_events")
      .select("deal_id, new_value")
      .eq("field", "stage")
      .in("new_value", BOOKED_STAGES)
      .in("deal_id", deals.slice(k, k + ID_CHUNK).map((d) => d.id));
    if (ev.error) return fail(ev.error.message);
    for (const e of (ev.data as { deal_id: number }[] | null) ?? []) bookedBefore.add(e.deal_id);
  }
  return { catering: bookingsFrom(deals, bookedBefore, from, to, today), problems: [] };
}

/**
 * The booked deals among `deals` with an event day from `from` to `to`, each
 * with its billed crew hours: the rule loadCateringBookings applies, apart
 * from its reads, so another reader of the same rows (the Labor Hours
 * Planning local preview, bj-finance #742) books them identically.
 * `bookedBefore` holds the ids whose stage history shows a booked stage.
 */
export function bookingsFrom(deals: BookingDeal[], bookedBefore: Set<number>, from: string, to: string, today: string): CateringBooking[] {
  const catering: CateringBooking[] = [];
  for (const d of deals) {
    const day = eventDay(d);
    if (d.archived || !day || day < from || day > to || !isBooked(d, today, bookedBefore)) continue;
    catering.push({ id: d.id, day, billedHours: billedCrewHours(d) });
  }
  return catering;
}
