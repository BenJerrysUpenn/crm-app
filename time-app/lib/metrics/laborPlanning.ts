// Labor Hours Planning (bj-finance #742, rulings by Alina 2026-10-19): target
// labor hours for each Sunday-to-Saturday week ahead, from this week up to 52
// weeks out, built from last year's sales. The schedule (#695) is the
// present, Labor vs target (#696) the past; this is the future.
//
// Each week's bar, stacked bottom to top:
//
//   Affordable hours   (projected in-store sales + concession event net
//                      sales) x the hourly goal / the average active hourly
//                      rate, day by day; drawn as two bands, in-store hours
//                      and concession hours.
//                        Projected in-store sales = in-store sales on the
//                        same weekday 364 days earlier x the trend factor (the
//                        single factor the schedule uses).
//                        Concession event net sales are spread evenly over
//                        the event's days (earned basis, not cash).
//                        The hourly goal is the board in force on the day
//                        (boardOn), so a value with a future effective date
//                        takes over from that date. The average rate is
//                        today's (averageHourlyRate, the schedule's).
//   Catering booked    the Catering shifts on each booked deal of the week;
//   hours              a booked deal with no shifts yet counts its billed crew
//                      hours (labor_hours x staff_count). Marketing deals are
//                      left out.
//   Catering estimated max(last year's catering shift hours in the same week
//   hours              - booked, 0). No trend factor. Booking catering moves
//                      hours from this band into the booked one; the bar
//                      grows only once booked passes the estimate. Catering
//                      is counted in hours, never as a share of catering
//                      sales.
//   Marketing booked   the shifts (any position) on each marketing deal of
//   hours              the week, else its labor_hours x staff_count, plus
//                      every other Marketing shift (no deal, or a deal that
//                      is not marketing).
//   Marketing          max(last year's marketing hours in the same week -
//   estimated hours    marketing booked, 0), the same shape as catering.
//
// A marketing deal is a deal whose event type starts with "Marketing", at any
// stage but Closed Lost, never archived (bj-finance #742, ruled 2026-10-19).
// Its hours are never catering hours.
//
// And a line:
//
//   Coverage hours     the staffed hours each day, one person, summed per
//                      week: the open hours of the season in force
//                      (resolveOpenWindow) widened by the open-up and
//                      close-down minutes in force (staffedWindow). With
//                      the minutes not set, the open hours, and the week's
//                      notes say so. Sales projections and affordable hours
//                      stay on open hours.
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
import {
  CLOSE_DOWN_WORDS,
  OPEN_UP_WORDS,
  resolveOpenWindow,
  staffedWindow,
  type ClosedDateRange,
  type StoreHoursException,
  type StoreHoursRow,
} from "../coverage.ts";
import { billedCrewHours, eventDay } from "./catering.ts";
import { addDays, eachDay, nyDay, spanHours } from "./dates.ts";
import { PLANNING_WEEKS } from "./planningWeeks.ts";
import { sundayOf } from "./weekRange.ts";

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

/** A stored revision of a concession event: a board value with its own dates. */
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

/** Hours on one day of the past (an estimate's source). */
export type CateringHistoryRow = { day: string; hours: number };

/**
 * A day of public.catering_hours_history: the raw Catering-position hours
 * When I Work scheduled that day. `kind` "marketing" marks a day whose
 * Catering shifts were a marketing event (the archive has no other marker).
 */
export type HistoryRow = { day: string; hours: number; kind?: "catering" | "marketing" };

/** A shift of the past as the history reads it. */
export type HistoryShift = { starts_at: string; ends_at: string; position: string | null; deal_id: number | null };

/** The marketing stage rule: every stage counts but this one. */
const MARKETING_LOST_STAGE = "Closed Lost";

/** A deal whose event type starts with "Marketing" (any case). */
export const isMarketingEventType = (t: string | null | undefined) => /^marketing/i.test((t ?? "").trim());

/** A deal whose event type marks it marketing. Only `counts` ones are marketing deals; the others still never count as catering. */
export type MarketingDeal = {
  id: number;
  /** The event day, New York. */
  day: string | null;
  /** Labor hours x staff count; 0 when it bills no crew; null when the deal does not say. */
  billedHours: number | null;
  /** Any stage but Closed Lost, and not archived. */
  counts: boolean;
};

export type MarketingDealRow = {
  id: number;
  event_type: string | null;
  stage: string;
  archived: number | boolean | null;
  event_date: string | null;
  labor_hours: number | string | null;
  staff_count: number | string | null;
};

/** The deals among `rows` whose event type marks them marketing. */
export function marketingDealsFrom(rows: MarketingDealRow[]): MarketingDeal[] {
  return rows
    .filter((d) => isMarketingEventType(d.event_type))
    .map((d) => ({ id: d.id, day: eventDay(d), billedHours: billedCrewHours(d), counts: !d.archived && d.stage !== MARKETING_LOST_STAGE }));
}

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
  /** The booked deals in the weeks ahead, or null when they could not be read. Marketing deals among them are left out. */
  bookings: CateringBooking[] | null;
  /** Every deal whose event type marks it marketing (marketingDealsFrom), or null when they could not be read. */
  marketingDeals: MarketingDeal[] | null;
  /** The weeks' shifts on deals, and their Marketing shifts. */
  shifts: LaborShift[];
  /** Last year's catering and marketing hours by day (lastYearHours), or null when they could not be read. */
  cateringHistory: CateringHistoryRow[] | null;
  marketingHistory: CateringHistoryRow[] | null;
  concessionEvents: ConcessionEvent[];
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
  /** In-store share of affordable hours (projected in-store sales). */
  inStoreHours: number | null;
  /** Concession share of affordable hours (concession event sales). */
  concessionHours: number | null;
  affordableHours: number | null;
  coverageHours: number | null;
};

export type PlanningWeek = {
  /** Sunday. */
  start: string;
  /** Saturday. */
  end: string;
  days: PlanningDay[];
  /** Affordable hours = in-store hours + concession hours; each is its own band on the chart. */
  inStoreHours: Derived;
  concessionHours: Derived;
  affordableHours: Derived;
  /** Catering booked and estimated hours. */
  bookedHours: number;
  estimatedHours: Derived;
  marketingBookedHours: number;
  marketingEstimatedHours: Derived;
  coverageHours: Derived;
  projectedInStore: number | null;
  concessionSales: number;
  /** The hourly goal when it is the same all week. */
  hourlyGoal: Derived;
  /** Last year's catering hours in the same week (concession event days and marketing left out). */
  lastYearCatering: number | null;
  lastYearMarketing: number | null;
  /** Last-year days filled from the weeks around them. */
  filledDays: string[];
  closedDays: string[];
  /** Concession events with a day in the week, "(placeholder)" after one still to confirm. */
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

/** How many weeks either way a missing last-year day looks for the same weekday with sales. */
const FILL_REACH = 8;

/** The week's note when coverage could not add the open-up or close-down minutes. */
function staffingNote(missing: Set<string>): string | null {
  const up = missing.has(OPEN_UP_WORDS);
  const down = missing.has(CLOSE_DOWN_WORDS);
  if (up && down) return `${OPEN_UP_WORDS} and ${CLOSE_DOWN_WORDS} not set on the Targets tab: coverage counts open hours only`;
  if (up) return `${OPEN_UP_WORDS} not set on the Targets tab: coverage counts from opening time`;
  if (down) return `${CLOSE_DOWN_WORDS} not set on the Targets tab: coverage counts to closing time`;
  return null;
}

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
export const MARKETING_POSITION = "Marketing";
const isMarketingShift = (s: { position?: string | null }) => (s.position ?? "").trim() === MARKETING_POSITION;

/** Which deals are marketing: every marketing-type deal (never catering), and the ones that count as marketing. */
function marketingIds(deals: MarketingDeal[] | null): { typed: Set<number>; counted: Set<number> } {
  return { typed: new Set((deals ?? []).map((d) => d.id)), counted: new Set((deals ?? []).filter((d) => d.counts).map((d) => d.id)) };
}

/**
 * Last year's catering and marketing hours by day, the estimates' source.
 * The days loaded from When I Work (public.catering_hours_history, raw
 * Catering-position hours) first, then from the day after the last of them
 * through `through`, the CRM's shifts. A day with no shift is zero.
 *
 * Exclusions are made here, as the rows are read, so an edited event counts
 * at once:
 *   - a concession event day has no catering (the shows were crewed under
 *     Catering and are counted through the event's sales);
 *   - a loaded day marked marketing is marketing, not catering;
 *   - from the CRM, marketing is the shifts on marketing deals (any position)
 *     plus every other Marketing shift; catering is the Catering shifts on
 *     no deal or on a deal that is not marketing.
 */
export function lastYearHours(input: {
  loaded: HistoryRow[];
  /** Shifts after the loaded days. */
  shifts: HistoryShift[];
  marketingDeals: MarketingDeal[];
  concessionEvents: ConcessionEvent[];
  through: string;
}): { catering: CateringHistoryRow[]; marketing: CateringHistoryRow[] } {
  const showDays = new Set(input.concessionEvents.flatMap(eventDays));
  const catering: CateringHistoryRow[] = [];
  const marketing: CateringHistoryRow[] = [];
  const push = (day: string, c: number, m: number) => {
    catering.push({ day, hours: showDays.has(day) ? 0 : Math.round(c * 100) / 100 });
    marketing.push({ day, hours: Math.round(m * 100) / 100 });
  };
  const loaded = [...input.loaded].sort((a, b) => (a.day < b.day ? -1 : 1));
  for (const r of loaded) {
    const hours = Number(r.hours);
    if (r.kind === "marketing") push(r.day, 0, hours);
    else push(r.day, hours, 0);
  }
  const lastLoaded = loaded.length ? loaded[loaded.length - 1].day : null;
  const from = lastLoaded ? addDays(lastLoaded, 1) : null;
  if (!from || from > input.through) return { catering, marketing };
  const { typed, counted } = marketingIds(input.marketingDeals);
  const cByDay = new Map<string, number>();
  const mByDay = new Map<string, number>();
  for (const s of input.shifts) {
    const day = nyDay(s.starts_at);
    if (day < from || day > input.through) continue;
    const onDeal = s.deal_id != null;
    let into: Map<string, number> | null = null;
    if (onDeal && counted.has(s.deal_id!)) into = mByDay;
    else if (onDeal && typed.has(s.deal_id!)) into = null;
    else if (isMarketingShift(s)) into = mByDay;
    else if (isCatering(s)) into = cByDay;
    if (into) into.set(day, (into.get(day) ?? 0) + spanHours(s.starts_at, s.ends_at));
  }
  for (const day of eachDay(from, input.through)) push(day, cByDay.get(day) ?? 0, mByDay.get(day) ?? 0);
  return { catering, marketing };
}

export function laborHoursPlanning(i: LaborPlanningInputs): LaborPlanning {
  const firstWeek = sundayOf(i.today);
  const salesByDay = new Map(i.sales.map((r) => [r.day, Number(r.in_store)]));
  const history = i.cateringHistory ? new Map(i.cateringHistory.map((r) => [r.day, Number(r.hours)])) : null;
  const mHistory = i.marketingHistory ? new Map(i.marketingHistory.map((r) => [r.day, Number(r.hours)])) : null;
  const { typed, counted } = marketingIds(i.marketingDeals);
  const { avgRate, over: avgRateOver } = averageHourlyRate(i.people);
  const trend = i.trend.factor;

  // Each event's net sales, a day's share on each of its days.
  const concessionByDay = new Map<string, { sales: number; names: string[] }>();
  for (const e of i.concessionEvents) {
    const days = eventDays(e);
    for (const d of days) {
      const cur = concessionByDay.get(d) ?? { sales: 0, names: [] };
      cur.sales += Number(e.expected_net_sales) / days.length;
      cur.names.push(e.provisional ? `${e.name} (placeholder)` : e.name);
      concessionByDay.set(d, cur);
    }
  }

  // Booked hours per deal: its Catering shifts (a marketing deal's shifts of
  // any position), else its billed crew hours; and by day every other
  // Marketing shift (no deal, or a deal that is not marketing).
  const shiftHours = new Map<number, number>();
  const marketingLoose = new Map<string, number>();
  for (const s of i.shifts) {
    const hours = spanHours(s.starts_at, s.ends_at);
    if (s.deal_id != null && counted.has(s.deal_id)) shiftHours.set(s.deal_id, (shiftHours.get(s.deal_id) ?? 0) + hours);
    else if (s.deal_id != null && typed.has(s.deal_id)) continue;
    else if (isMarketingShift(s)) marketingLoose.set(nyDay(s.starts_at), (marketingLoose.get(nyDay(s.starts_at)) ?? 0) + hours);
    else if (s.deal_id != null && isCatering(s)) shiftHours.set(s.deal_id, (shiftHours.get(s.deal_id) ?? 0) + hours);
  }
  /** A deal's booked hours: its shifts, else its billed hours; null when it has neither. */
  const dealHours = (id: number, billed: number | null) => {
    const fromShifts = shiftHours.get(id) ?? 0;
    return fromShifts > 0 ? fromShifts : billed;
  };

  const weeks: PlanningWeek[] = [];
  for (let w = 0; w < PLANNING_WEEKS.max; w++) {
    const start = addDays(firstWeek, 7 * w);
    const end = addDays(start, 6);
    const dates = eachDay(start, end);
    const needs: string[] = [];
    const coverNeeds: string[] = [];
    const staffingMissing = new Set<string>();
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
      const rateOk = goal.value != null && avgRate.value != null && avgRate.value > 0;
      const inStoreHours = projectedInStore != null && rateOk ? (projectedInStore * goal.value!) / avgRate.value! : null;
      const concessionHours = rateOk ? (concessionSales * goal.value!) / avgRate.value! : null;
      const affordableHours = inStoreHours != null && concessionHours != null ? inStoreHours + concessionHours : null;
      const staffed = staffedWindow(date, open, i.settings);
      let coverageHours: number | null = null;
      if (staffed.state === "open") {
        coverageHours = (staffed.closes - staffed.opens) / 60;
        for (const m of staffed.missing) staffingMissing.add(m);
      } else if (closed) coverageHours = 0;
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
        inStoreHours,
        concessionHours,
        affordableHours,
        coverageHours,
      };
    });

    const sumOf = (pick: (d: PlanningDay) => number | null) => (days.every((d) => pick(d) != null) ? days.reduce((a, d) => a + pick(d)!, 0) : null);
    const affordable = sumOf((d) => d.affordableHours);
    const inStore = sumOf((d) => d.inStoreHours);
    const concession = sumOf((d) => d.concessionHours);
    const coverage = sumOf((d) => d.coverageHours);
    const goals = days.map((d) => d.hourlyGoal);
    const hourlyGoal: Derived = goals.some((g) => g == null)
      ? missing("the hourly goal")
      : goals.every((g) => Math.abs(g! - goals[0]!) < 1e-12)
        ? known(goals[0]!)
        : missing("the hourly goal changes during the week");

    // Booked catering.
    const notes: string[] = [];
    const staffingWords = staffingNote(staffingMissing);
    if (staffingWords) notes.push(staffingWords);
    let bookedHours = 0;
    if (i.bookings == null) notes.push("catering bookings could not be read: booked hours count none");
    for (const b of i.bookings ?? []) {
      if (b.day < start || b.day > end || typed.has(b.id)) continue;
      const h = dealHours(b.id, b.billedHours);
      if (h != null) bookedHours += h;
      else notes.push(`booked deal #${b.id} has no Catering shifts and no billed crew hours: counted as none`);
    }

    // Booked marketing.
    let marketingBookedHours = 0;
    if (i.marketingDeals == null) notes.push("marketing deals could not be read: marketing booked hours count only Marketing shifts off marketing deals");
    for (const m of i.marketingDeals ?? []) {
      if (!m.counts || !m.day || m.day < start || m.day > end) continue;
      const h = dealHours(m.id, m.billedHours);
      if (h != null) marketingBookedHours += h;
      else notes.push(`marketing deal #${m.id} has no shifts and no labor hours: counted as none`);
    }
    for (const d of dates) marketingBookedHours += marketingLoose.get(d) ?? 0;

    // Last year's hours, and what is left of them once bookings are in.
    const lyDays = dates.map((d) => addDays(d, -364));
    const lastYear = (h: Map<string, number> | null, what: string): number | Derived => {
      if (!h) return missing(`last year's ${what} hours (could not be read)`);
      const absent = lyDays.filter((d) => !h.has(d));
      if (absent.length) return missing(`last year's ${what} hours for ${absent.length === 7 ? "the week" : absent.join(", ")}`);
      return lyDays.reduce((a, d) => a + h.get(d)!, 0);
    };
    const lyCatering = lastYear(history, "catering");
    const lyMarketing = lastYear(mHistory, "marketing");
    const lastYearCatering = typeof lyCatering === "number" ? lyCatering : null;
    const lastYearMarketing = typeof lyMarketing === "number" ? lyMarketing : null;
    const estimatedHours = typeof lyCatering === "number" ? known(Math.max(lyCatering - bookedHours, 0)) : lyCatering;
    const marketingEstimatedHours = typeof lyMarketing === "number" ? known(Math.max(lyMarketing - marketingBookedHours, 0)) : lyMarketing;

    weeks.push({
      start,
      end,
      days,
      inStoreHours: inStore != null ? known(inStore) : missing(...needs),
      concessionHours: concession != null ? known(concession) : missing(...needs),
      affordableHours: affordable != null ? known(affordable) : missing(...needs),
      bookedHours,
      estimatedHours,
      marketingBookedHours,
      marketingEstimatedHours,
      coverageHours: coverage != null ? known(coverage) : missing(...coverNeeds),
      projectedInStore: sumOf((d) => d.projectedInStore),
      concessionSales: days.reduce((a, d) => a + d.concessionSales, 0),
      hourlyGoal,
      lastYearCatering,
      lastYearMarketing,
      filledDays: days.filter((d) => d.filled).map((d) => d.lastYearDay),
      closedDays: days.filter((d) => d.closed).map((d) => d.date),
      events: [...new Set(dates.flatMap((d) => concessionByDay.get(d)?.names ?? []))],
      notes,
    });
  }
  return { weeks, avgRate, avgRateOver, trend: i.trend };
}
