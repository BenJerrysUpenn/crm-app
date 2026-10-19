// The reads behind the Labor Hours Planning card (bj-finance #742), as the
// signed-in manager. Two halves, so a second reader can supply the same rows
// another way (the local real-data preview, app/dev/labor-hours-planning):
//
//   loadLaborPlanningRows  the Supabase reads: the control board, the team,
//                          daily in-store sales, store hours with their
//                          seasons, closures, booked catering, marketing
//                          deals, the shifts on deals and Marketing shifts,
//                          last year's catering hours, the concession events.
//   planningInputsFrom     rows -> the pure function's inputs.
//
// Before migration 47 the seasons, events and catering history are not
// there: the store-hours readers use the weekly pattern, there are no events,
// and the catering estimate shows as not available, named in `problems`.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBoard, type SalariedProfile } from "@/lib/controlBoard/load";
import { trendFactor, type DailySalesRow, type MonthlySalesRow } from "@/lib/controlBoard/math";
import type { SalaryRow, SettingRow } from "@/lib/controlBoard/settings";
import { CATERING_POSITION, type CateringBooking, type LaborShift } from "@/lib/controlBoard/schedule";
import { PROFILE_COLUMNS, laborPerson, loadCateringBookings } from "@/lib/controlBoard/scheduleLoad";
import type { ClosedDateRange, StoreHoursException, StoreHoursRow } from "@/lib/coverage";
import { isMissingTable } from "@/lib/storeHours";
import { loadStoreHoursSeasons, seasonHoursRows } from "@/lib/storeHoursSeasons";
import { addDays } from "./dates";
import { nyMidnight, paged } from "./supabaseReads";
import {
  MARKETING_POSITION,
  eventsInForce,
  lastYearHours,
  marketingDealsFrom,
  planningWindow,
  type ConcessionEvent,
  type EventRevision,
  type HistoryRow,
  type HistoryShift,
  type LaborPlanningInputs,
  type MarketingDealRow,
} from "./laborPlanning";

export type ConcessionEventRow = ConcessionEvent & EventRevision;

/** The deal columns a marketing deal is read with. */
export const MARKETING_DEAL_COLUMNS = "id, event_type, stage, archived, event_date, labor_hours, staff_count";

/** The shifts the card reads besides store shifts: Catering and Marketing ones, and any on a deal (PostgREST `or`). */
export const PLANNING_SHIFTS_FILTER = `position.in.(${CATERING_POSITION},${MARKETING_POSITION}),deal_id.not.is.null`;
type ProfileRow = Parameters<typeof laborPerson>[0];

export type LaborPlanningRows = {
  today: string;
  settings: SettingRow[];
  salaries: SalaryRow[];
  salaried: SalariedProfile[];
  /** The trend's two months (loadBoard's reads). */
  monthly: MonthlySalesRow[];
  daily: DailySalesRow[];
  profiles: ProfileRow[];
  sales: { day: string; in_store: number }[];
  /** The weekly pattern and every season's rows. */
  storeHours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  closedRanges: ClosedDateRange[];
  bookings: CateringBooking[] | null;
  /** Every deal whose event type starts with Marketing, or null when they could not be read. */
  marketingDeals: MarketingDealRow[] | null;
  /** Shifts in the weeks ahead (PLANNING_SHIFTS_FILTER). */
  shifts: LaborShift[];
  /** catering_hours_history, or null before migration 47. */
  historyLoaded: HistoryRow[] | null;
  /** Shifts over last year's days (PLANNING_SHIFTS_FILTER; the history after the loaded days). */
  historyShifts: HistoryShift[];
  concessionEvents: ConcessionEventRow[];
  problems: string[];
};

/** Rows -> the planning function's inputs. */
export function planningInputsFrom(rows: LaborPlanningRows): LaborPlanningInputs {
  const concessionEvents = eventsInForce(rows.concessionEvents, rows.today).map((e) => ({
    name: e.name,
    start_date: e.start_date,
    end_date: e.end_date,
    expected_net_sales: Number(e.expected_net_sales),
    provisional: e.provisional,
  }));
  const marketingDeals = rows.marketingDeals ? marketingDealsFrom(rows.marketingDeals) : null;
  const lastYear = rows.historyLoaded
    ? lastYearHours({ loaded: rows.historyLoaded, shifts: rows.historyShifts, marketingDeals: marketingDeals ?? [], concessionEvents, through: addDays(rows.today, -1) })
    : null;
  return {
    today: rows.today,
    settings: rows.settings,
    salaries: rows.salaries,
    salaried: rows.salaried,
    trend: trendFactor(rows.today, rows.monthly, rows.daily),
    people: rows.profiles.map(laborPerson),
    sales: rows.sales,
    storeHours: rows.storeHours,
    exceptions: rows.exceptions,
    closedRanges: rows.closedRanges,
    bookings: rows.bookings,
    marketingDeals,
    shifts: rows.shifts,
    cateringHistory: lastYear?.catering ?? null,
    marketingHistory: lastYear?.marketing ?? null,
    concessionEvents,
  };
}

/** A table of migration 47's: its rows, or null before the migration. */
async function optional<T>(read: () => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }>): Promise<T[] | null> {
  const { data, error } = await read();
  if (isMissingTable(error)) return null;
  if (error) throw new Error(error.message);
  return (data ?? []) as T[];
}

export async function loadLaborPlanningRows(supabase: SupabaseClient, today: string): Promise<LaborPlanningRows> {
  const w = planningWindow(today);
  const problems: string[] = [];
  const [board, profiles, sales, hours, seasons, exceptions, closed, bookings, marketing, shifts, historyLoaded, historyShifts, concession] =
    await Promise.all([
      loadBoard(supabase, today),
      paged<ProfileRow>(() => supabase.from("profiles").select(PROFILE_COLUMNS).order("id")),
      paged<{ day: string; in_store: number | string }>(() =>
        supabase.from("sales_daily_in_store").select("day, in_store").gte("day", w.salesFrom).lte("day", w.salesTo).order("day"),
      ),
      supabase.from("store_hours").select("weekday, is_closed, opens, closes"),
      loadStoreHoursSeasons(supabase),
      supabase.from("store_hours_exceptions").select("date, label, is_closed, opens, closes").gte("date", w.firstWeek).lte("date", w.lastDay),
      supabase.from("annotations").select("title, start_date, end_date").eq("business_closed", true).lte("start_date", w.lastDay).gte("end_date", w.firstWeek),
      loadCateringBookings(supabase, w.firstWeek, w.lastDay, today),
      supabase.from("deals").select(MARKETING_DEAL_COLUMNS).ilike("event_type", "marketing%").order("id"),
      paged<LaborShift>(() =>
        supabase
          .from("shifts")
          .select("id, employee_id, starts_at, ends_at, position, deal_id")
          .or(PLANNING_SHIFTS_FILTER)
          .gte("starts_at", nyMidnight(addDays(w.firstWeek, -1)))
          .lte("starts_at", nyMidnight(addDays(w.lastDay, 2)))
          .order("id"),
      ),
      optional<HistoryRow>(() => supabase.from("catering_hours_history").select("day, hours, kind").gte("day", w.lastYearFrom).order("day")),
      paged<HistoryShift>(() =>
        supabase
          .from("shifts")
          .select("starts_at, ends_at, position, deal_id")
          .or(PLANNING_SHIFTS_FILTER)
          .gte("starts_at", nyMidnight(addDays(w.lastYearFrom, -1)))
          .lte("starts_at", nyMidnight(addDays(today, 1)))
          .order("id"),
      ),
      optional<ConcessionEventRow>(() => supabase.from("concession_events").select("*")),
    ]);
  if (!board.ready) throw new Error(board.reason);
  if (hours.error) throw new Error(`store hours: ${hours.error.message}`);
  if (seasons.error) throw new Error(`store-hours seasons: ${seasons.error}`);
  if (exceptions.error) throw new Error(`store-hours exceptions: ${exceptions.error.message}`);
  problems.push(...board.problems.map((p) => `labor hours planning: ${p}`));
  problems.push(...bookings.problems.map((p) => `labor hours planning: ${p}`));
  if (marketing.error) problems.push(`labor hours planning: marketing deals could not be read: ${marketing.error.message}`);
  if (closed.error) problems.push(`labor hours planning: "Business closed" notes could not be read: ${closed.error.message}`);
  if (historyLoaded == null) problems.push("labor hours planning: last year's catering hours are not loaded yet (migration 47)");
  return {
    today,
    settings: board.settings,
    salaries: board.salaries,
    salaried: board.salaried,
    monthly: board.monthly,
    daily: board.daily,
    profiles,
    sales: sales.map((r) => ({ day: String(r.day), in_store: Number(r.in_store) })),
    storeHours: [...((hours.data ?? []) as StoreHoursRow[]), ...seasonHoursRows(seasons.seasons)],
    exceptions: (exceptions.data ?? []) as StoreHoursException[],
    closedRanges: closed.error ? [] : ((closed.data ?? []) as ClosedDateRange[]),
    bookings: bookings.catering,
    marketingDeals: marketing.error ? null : ((marketing.data ?? []) as MarketingDealRow[]),
    shifts,
    historyLoaded: historyLoaded?.map((r) => ({ day: String(r.day), hours: Number(r.hours), kind: r.kind })) ?? null,
    historyShifts,
    concessionEvents: concession ?? [],
    problems,
  };
}
