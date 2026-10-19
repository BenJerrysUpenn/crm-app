// Labor Hours Planning (bj-finance #742, rulings by Alina 2026-10-19): target
// labor hours for each Sunday-to-Saturday week ahead, from this week up to 52
// weeks out, built from last year's sales. The schedule (#695) is the
// present, Labor vs target (#696) the past; this is the future.
//
// Each week's bar, stacked bottom to top:
//
//   Affordable hours   (projected in-store sales + concession event net
//                      sales) x the hourly goal / the average active hourly
//                      rate, day by day.
//                        Projected in-store sales = in-store sales on the
//                        same weekday 364 days earlier x the trend factor (the
//                        single factor the schedule uses).
//                        Concession event net sales are spread evenly over
//                        the event's days (earned basis, not cash).
//                        The hourly goal is the board in force on the day
//                        (boardOn), so a value with a future effective date
//                        takes over from that date. The average rate is
//                        today's (averageHourlyRate, the schedule's).
//   Booked catering    the Catering shifts on each booked deal of the week;
//   hours              a booked deal with no shifts yet counts its billed crew
//                      hours (labor_hours x staff_count).
//   Estimated catering max(last year's catering shift hours in the same week
//   hours remaining    - booked, 0), plus the crew hours of any dated crew
//                      event that week (Free Cone Day). No trend factor.
//                      Booking catering moves hours from this band into the
//                      booked one; the bar grows only once booked passes the
//                      estimate. Catering is counted in hours, never as a
//                      share of catering sales.
//
// And a line:
//
//   Coverage hours     the store hours of the season in force each day
//                      (resolveOpenWindow), one person, summed per week.
//
// Closed dates (a store-hours exception that closes the day, a "Business
// closed" annotation, a weekday the season closes) project no in-store sales
// and need no cover, even if the store was open the year before. A last-year
// day with no sales on file is the average of the same weekday in the nearest
// weeks on each side that have sales (one side when only one has), and is
// flagged "filled". A missing input is missing, with the reason, never zero.
//
// Pure, so `node --test` runs it. No figure here is a business value: every
// one arrives as data (crm-app is public).

import { boardOn } from "../controlBoard/board.ts";
import type { Derived, Trend } from "../controlBoard/math.ts";
import { groupBy, inForce, type SalaryRow, type SettingRow } from "../controlBoard/settings.ts";
import type { SalariedProfile } from "../controlBoard/load.ts";
import { CATERING_POSITION, averageHourlyRate, type CateringBooking, type LaborPerson, type LaborShift } from "../controlBoard/schedule.ts";
import { resolveOpenWindow, type ClosedDateRange, type StoreHoursException, type StoreHoursRow } from "../coverage.ts";
import { addDays, eachDay, nyDay, spanHours } from "./dates.ts";
import { PLANNING_WEEKS } from "./planningWeeks.ts";

export { PLANNING_WEEKS, planningWeekCount } from "./planningWeeks.ts";

/** A concession event (public.concession_events, migration 47). */
export type ConcessionEvent = {
  name: string;
  start_date: string;
  end_date: string;
  /** Expected net sales over the whole event. */
  expected_net_sales: number;
  /** A placeholder the owners have still to confirm. */
  provisional?: boolean;
};

/** A dated event with crew hours (public.crew_events, migration 47): Free Cone Day. */
export type CrewEvent = { name: string; day: string; crew_hours: number };

/** A stored revision of an event (concession_events, crew_events): a board value with its own dates. */
export type EventRevision = { id: number; event_key: string; effective_from: string; recorded_at: string; cancelled: boolean };

/**
 * Each event as it stands on `day`: per event_key, the revision with the
 * latest effective_from on or before the day (then recorded_at, then id),
 * as for control_settings; an event whose revision in force is cancelled is
 * left out.
 */
export function eventsInForce<T extends EventRevision>(rows: T[], day: string): T[] {
  const out: T[] = [];
  for (const list of groupBy(rows, "event_key").values()) {
    const row = inForce(list, day);
    if (row && !row.cancelled) out.push(row);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** The days the card reads on `today`. */
export function planningWindow(today: string): {
  firstWeek: string;
  lastDay: string;
  /** Last year's days: 364 days before each day shown. */
  lastYearFrom: string;
  lastYearTo: string;
  /** In-store sales: last year's days and FILL_REACH weeks either side, to fill gaps. */
  salesFrom: string;
  salesTo: string;
} {
  const firstWeek = sundayOf(today);
  const lastDay = addDays(firstWeek, 7 * PLANNING_WEEKS.max - 1);
  const lastYearFrom = addDays(firstWeek, -364);
  const lastYearTo = addDays(lastDay, -364);
  return { firstWeek, lastDay, lastYearFrom, lastYearTo, salesFrom: addDays(lastYearFrom, -7 * FILL_REACH), salesTo: addDays(lastYearTo, 7 * FILL_REACH) };
}

/** Catering shift hours on one day of the past (the estimate's source). */
export type CateringHistoryRow = { day: string; hours: number };

export type LaborPlanningInputs = {
  today: string;
  /** Every control_settings and profile_salaries row (all dates), and everyone in fixed payroll. */
  settings: SettingRow[];
  salaries: SalaryRow[];
  salaried: SalariedProfile[];
  /** The schedule's trend factor (trendFactor on today). */
  trend: Trend;
  /** Everyone on the Team page: today's average active hourly rate. */
  people: LaborPerson[];
  /** In-store sales by day (public.sales_daily_in_store) over last year's days and some weeks either side. */
  sales: { day: string; in_store: number }[];
  /** The standing pattern (store_hours) and every season's rows (store_hours_seasons, with effective_from). */
  storeHours: StoreHoursRow[];
  exceptions: StoreHoursException[];
  closedRanges: ClosedDateRange[];
  /** The booked catering deals in the weeks ahead, or null when they could not be read. */
  bookings: CateringBooking[] | null;
  /** Shifts crewing those deals (deal_id set); only Catering ones count. */
  cateringShifts: LaborShift[];
  /** Last year's catering hours by day (cateringHistory), or null when they could not be read. */
  cateringHistory: CateringHistoryRow[] | null;
  concessionEvents: ConcessionEvent[];
  crewEvents: CrewEvent[];
};

export type PlanningDay = {
  date: string;
  /** The same weekday 364 days earlier. */
  lastYearDay: string;
  closed: boolean;
  /** Last year's in-store sales, as on file or filled. */
  lastYearInStore: number | null;
  /** No sales on file for the last-year day: filled from the nearest weeks around it. */
  filled: boolean;
  /** Last year's x trend; zero on a closed day. */
  projectedInStore: number | null;
  concessionSales: number;
  hourlyGoal: number | null;
  affordableHours: number | null;
  coverageHours: number | null;
};

export type PlanningWeek = {
  /** Sunday. */
  start: string;
  /** Saturday. */
  end: string;
  days: PlanningDay[];
  affordableHours: Derived;
  bookedHours: number;
  estimatedHours: Derived;
  coverageHours: Derived;
  projectedInStore: number | null;
  concessionSales: number;
  /** The hourly goal when it is the same all week. */
  hourlyGoal: Derived;
  /** Last year's catering hours in the same week (concession show days and crew event days left out). */
  lastYearCatering: number | null;
  crewEventHours: number;
  /** Last-year days filled from the weeks around them. */
  filledDays: string[];
  closedDays: string[];
  /** Concession and crew events with a day in the week. */
  events: string[];
  /** Things to know that do not make a number missing. */
  notes: string[];
};

export type LaborPlanning = {
  weeks: PlanningWeek[];
  avgRate: Derived;
  /** How many active hourly people the average is over. */
  avgRateOver: number;
  trend: Trend;
};

const known = (value: number): Derived => ({ value, needs: [] });
const missing = (...needs: string[]): Derived => ({ value: null, needs: [...new Set(needs)] });

/** The Sunday of the week holding `day`. */
export function sundayOf(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -dow);
}

/** How many weeks either way a missing last-year day looks for the same weekday with sales. */
const FILL_REACH = 8;

/** Last year's sales on `day`, or the average of the nearest same weekdays on file either side. */
function lastYearSales(day: string, byDay: Map<string, number>): { value: number | null; filled: boolean } {
  const on = byDay.get(day);
  if (on != null) return { value: on, filled: false };
  const side = (step: number) => {
    for (let k = 1; k <= FILL_REACH; k++) {
      const v = byDay.get(addDays(day, step * 7 * k));
      if (v != null) return v;
    }
    return null;
  };
  const sides = [side(-1), side(1)].filter((v): v is number => v != null);
  return sides.length ? { value: sides.reduce((a, v) => a + v, 0) / sides.length, filled: true } : { value: null, filled: false };
}

function eventDays(e: ConcessionEvent): string[] {
  return e.end_date < e.start_date ? [] : eachDay(e.start_date, e.end_date);
}

const isCatering = (s: { position?: string | null }) => (s.position ?? "").trim() === CATERING_POSITION;

/**
 * Last year's catering hours by day, the estimate's source: the days loaded
 * from When I Work (public.catering_hours_history, written by bj-finance's
 * loader with show days and Free Cone Day already left out), then from the
 * day after the last of them through `through`, the CRM's Catering shifts,
 * leaving out concession event days (they were crewed under Catering and are
 * counted through the event's sales) and crew event days. A day with no
 * shift is zero.
 */
export function cateringHistory(input: {
  loaded: CateringHistoryRow[];
  /** Catering shifts after the loaded days. */
  shifts: { starts_at: string; ends_at: string }[];
  concessionEvents: ConcessionEvent[];
  crewEvents: CrewEvent[];
  through: string;
}): CateringHistoryRow[] {
  const rows = [...input.loaded].sort((a, b) => (a.day < b.day ? -1 : 1)).map((r) => ({ day: r.day, hours: Number(r.hours) }));
  const lastLoaded = rows.length ? rows[rows.length - 1].day : null;
  const from = lastLoaded ? addDays(lastLoaded, 1) : null;
  if (!from || from > input.through) return rows;
  const skip = new Set([...input.concessionEvents.flatMap(eventDays), ...input.crewEvents.map((e) => e.day)]);
  const byDay = new Map<string, number>();
  for (const s of input.shifts) {
    const day = nyDay(s.starts_at);
    if (day < from || day > input.through) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + spanHours(s.starts_at, s.ends_at));
  }
  for (const day of eachDay(from, input.through)) rows.push({ day, hours: skip.has(day) ? 0 : Math.round((byDay.get(day) ?? 0) * 100) / 100 });
  return rows;
}

export function laborHoursPlanning(i: LaborPlanningInputs): LaborPlanning {
  const firstWeek = sundayOf(i.today);
  const salesByDay = new Map(i.sales.map((r) => [r.day, Number(r.in_store)]));
  const history = i.cateringHistory ? new Map(i.cateringHistory.map((r) => [r.day, Number(r.hours)])) : null;
  const { avgRate, over: avgRateOver } = averageHourlyRate(i.people);
  const trend = i.trend.factor;

  // Each event's net sales, a day's share on each of its days.
  const concessionByDay = new Map<string, { sales: number; names: string[] }>();
  for (const e of i.concessionEvents) {
    const days = eventDays(e);
    for (const d of days) {
      const cur = concessionByDay.get(d) ?? { sales: 0, names: [] };
      cur.sales += Number(e.expected_net_sales) / days.length;
      cur.names.push(e.name);
      concessionByDay.set(d, cur);
    }
  }

  // Booked hours per deal: its Catering shifts, else its billed crew hours.
  const shiftHours = new Map<number, number>();
  for (const s of i.cateringShifts) {
    if (s.deal_id == null || !isCatering(s)) continue;
    shiftHours.set(s.deal_id, (shiftHours.get(s.deal_id) ?? 0) + spanHours(s.starts_at, s.ends_at));
  }

  const weeks: PlanningWeek[] = [];
  for (let w = 0; w < PLANNING_WEEKS.max; w++) {
    const start = addDays(firstWeek, 7 * w);
    const end = addDays(start, 6);
    const dates = eachDay(start, end);
    const needs: string[] = [];
    const coverNeeds: string[] = [];
    const days: PlanningDay[] = dates.map((date) => {
      const lastYearDay = addDays(date, -364);
      const open = resolveOpenWindow(date, i.storeHours, i.exceptions, i.closedRanges);
      const closed = open.state === "closed";
      const ly = lastYearSales(lastYearDay, salesByDay);
      if (ly.value == null && !closed) needs.push(`in-store sales for ${lastYearDay} (none on file within ${FILL_REACH} weeks)`);
      const projectedInStore = closed ? 0 : ly.value != null && trend.value != null ? ly.value * trend.value : null;
      if (trend.value == null) needs.push(...trend.needs);
      const concessionSales = concessionByDay.get(date)?.sales ?? 0;
      const goal = boardOn(date, i.settings, i.salaries, i.salaried).hourlyGoalPct;
      if (goal.value == null) needs.push(...goal.needs.map((n) => (n === "sales above zero" ? "a sales estimate above zero" : n)));
      if (avgRate.value == null) needs.push(...avgRate.needs);
      const affordableHours =
        projectedInStore != null && goal.value != null && avgRate.value != null && avgRate.value > 0
          ? ((projectedInStore + concessionSales) * goal.value) / avgRate.value
          : null;
      let coverageHours: number | null = null;
      if (open.state === "open") coverageHours = (open.closes - open.opens) / 60;
      else if (closed) coverageHours = 0;
      else coverNeeds.push(`store hours for ${date}`);
      return {
        date,
        lastYearDay,
        closed,
        lastYearInStore: ly.value,
        filled: ly.filled,
        projectedInStore,
        concessionSales,
        hourlyGoal: goal.value,
        affordableHours,
        coverageHours,
      };
    });

    const sumOf = (pick: (d: PlanningDay) => number | null) => (days.every((d) => pick(d) != null) ? days.reduce((a, d) => a + pick(d)!, 0) : null);
    const affordable = sumOf((d) => d.affordableHours);
    const coverage = sumOf((d) => d.coverageHours);
    const goals = days.map((d) => d.hourlyGoal);
    const hourlyGoal: Derived = goals.some((g) => g == null)
      ? missing("the hourly goal")
      : goals.every((g) => Math.abs(g! - goals[0]!) < 1e-12)
        ? known(goals[0]!)
        : missing("the hourly goal changes during the week");

    // Booked catering.
    const notes: string[] = [];
    let bookedHours = 0;
    if (i.bookings == null) notes.push("catering bookings could not be read: booked hours count none");
    for (const b of i.bookings ?? []) {
      if (b.day < start || b.day > end) continue;
      const fromShifts = shiftHours.get(b.id) ?? 0;
      if (fromShifts > 0) bookedHours += fromShifts;
      else if (b.billedHours != null) bookedHours += b.billedHours;
      else notes.push(`booked deal #${b.id} has no Catering shifts and no billed crew hours: counted as none`);
    }

    // Last year's catering, and what is left of it once bookings are in.
    const crew = i.crewEvents.filter((e) => e.day >= start && e.day <= end);
    const crewEventHours = crew.reduce((a, e) => a + Number(e.crew_hours), 0);
    let lastYearCatering: number | null = null;
    let estimatedHours: Derived;
    if (!history) estimatedHours = missing("last year's catering hours (could not be read)");
    else {
      const lyDays = dates.map((d) => addDays(d, -364));
      const absent = lyDays.filter((d) => !history.has(d));
      if (absent.length) estimatedHours = missing(`last year's catering hours for ${absent.length === 7 ? "the week" : absent.join(", ")}`);
      else {
        lastYearCatering = lyDays.reduce((a, d) => a + history.get(d)!, 0);
        estimatedHours = known(Math.max(lastYearCatering - bookedHours, 0) + crewEventHours);
      }
    }

    weeks.push({
      start,
      end,
      days,
      affordableHours: affordable != null ? known(affordable) : missing(...needs),
      bookedHours,
      estimatedHours,
      coverageHours: coverage != null ? known(coverage) : missing(...coverNeeds),
      projectedInStore: sumOf((d) => d.projectedInStore),
      concessionSales: days.reduce((a, d) => a + d.concessionSales, 0),
      hourlyGoal,
      lastYearCatering,
      crewEventHours,
      filledDays: days.filter((d) => d.filled).map((d) => d.lastYearDay),
      closedDays: days.filter((d) => d.closed).map((d) => d.date),
      events: [...new Set([...dates.flatMap((d) => concessionByDay.get(d)?.names ?? []), ...crew.map((e) => e.name)])],
      notes,
    });
  }
  return { weeks, avgRate, avgRateOver, trend: i.trend };
}
