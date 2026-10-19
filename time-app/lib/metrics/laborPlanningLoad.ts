// The reads behind the Labor Hours Planning card (bj-finance #742), as the
// signed-in manager. Two halves, so a second reader can supply the same rows
// another way (the local real-data preview, app/dev/labor-hours-planning):
//
//   loadLaborPlanningRows  the Supabase reads: the control board, the team,
//                          daily in-store sales, store hours with their
//                          seasons, closures, booked catering and its crew,
//                          last year's catering hours, the events.
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
import {
  cateringHistory,
  eventsInForce,
  planningWindow,
  type CateringHistoryRow,
  type ConcessionEvent,
  type CrewEvent,
  type EventRevision,
  type LaborPlanningInputs,
} from "./laborPlanning";

export type ConcessionEventRow = ConcessionEvent & EventRevision;
export type CrewEventRow = CrewEvent & EventRevision;
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
  /** Catering shifts on deals in the weeks ahead. */
  cateringShifts: LaborShift[];
  /** catering_hours_history, or null before migration 47. */
  historyLoaded: CateringHistoryRow[] | null;
  /** Catering shifts over last year's days (the history after the loaded days). */
  historyShifts: { starts_at: string; ends_at: string }[];
  concessionEvents: ConcessionEventRow[];
  crewEvents: CrewEventRow[];
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
  const crewEvents = eventsInForce(rows.crewEvents, rows.today).map((e) => ({ name: e.name, day: e.day, crew_hours: Number(e.crew_hours) }));
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
    cateringShifts: rows.cateringShifts,
    cateringHistory: rows.historyLoaded
      ? cateringHistory({ loaded: rows.historyLoaded, shifts: rows.historyShifts, concessionEvents, crewEvents, through: addDays(rows.today, -1) })
      : null,
    concessionEvents,
    crewEvents,
  };
}

const PAGE = 1000;
type Query = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }> };

async function paged<T>(make: () => Query): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < 50; page++) {
    const { data, error } = await make().range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/** New York midnight starting `day`, the earlier offset so nothing is missed. */
const nyMidnight = (day: string) => `${day}T04:00:00Z`;

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
  const [board, profiles, sales, hours, seasons, exceptions, closed, bookings, cateringShifts, historyLoaded, historyShifts, concession, crew] =
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
      paged<LaborShift>(() =>
        supabase
          .from("shifts")
          .select("id, employee_id, starts_at, ends_at, position, deal_id")
          .eq("position", CATERING_POSITION)
          .not("deal_id", "is", null)
          .gte("starts_at", nyMidnight(addDays(w.firstWeek, -1)))
          .lte("starts_at", nyMidnight(addDays(w.lastDay, 2)))
          .order("id"),
      ),
      optional<CateringHistoryRow>(() => supabase.from("catering_hours_history").select("day, hours").gte("day", w.lastYearFrom).order("day")),
      paged<{ starts_at: string; ends_at: string }>(() =>
        supabase
          .from("shifts")
          .select("starts_at, ends_at")
          .eq("position", CATERING_POSITION)
          .gte("starts_at", nyMidnight(addDays(w.lastYearFrom, -1)))
          .lte("starts_at", nyMidnight(addDays(today, 1)))
          .order("id"),
      ),
      optional<ConcessionEventRow>(() => supabase.from("concession_events").select("*")),
      optional<CrewEventRow>(() => supabase.from("crew_events").select("*")),
    ]);
  if (!board.ready) throw new Error(board.reason);
  if (hours.error) throw new Error(`store hours: ${hours.error.message}`);
  if (seasons.error) throw new Error(`store-hours seasons: ${seasons.error}`);
  if (exceptions.error) throw new Error(`store-hours exceptions: ${exceptions.error.message}`);
  problems.push(...board.problems.map((p) => `labor hours planning: ${p}`));
  problems.push(...bookings.problems.map((p) => `labor hours planning: ${p}`));
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
    cateringShifts,
    historyLoaded: historyLoaded?.map((r) => ({ day: String(r.day), hours: Number(r.hours) })) ?? null,
    historyShifts,
    concessionEvents: concession ?? [],
    crewEvents: crew ?? [],
    problems,
  };
}
