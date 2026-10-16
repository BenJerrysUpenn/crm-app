// The Schedule page's labor line (bj-finance #695, spec by Alina 2026-10-13;
// catering rule corrected 2026-10-16). Manager view only. The week reads as
// an aligned block (components/ScheduleLaborLine.tsx), the day headers as the
// date only:
//
//   Target Hourly Labor       target hours         target $
//   Scheduled Hourly Labor    hourly-paid hours    projected $
//   Remaining Hourly Labor    target - scheduled, hours and $
//
//   Projected hourly labor $ = hourly-paid scheduled hours x rate
//                            + catering premium on Catering shifts
//                            + solo-close bonus per qualifying night
//                            + open shifts at the average active hourly rate.
//                            Salaried and overhead staff are left out.
//   Day projected sales      = last year's in-store sales on the same weekday
//                              52 weeks earlier x trend factor. IN-STORE ONLY:
//                              catering bookings never feed projected sales.
//   In-store target $        = projected sales x the hourly goal in force that day.
//   In-store target hours    = in-store target $ / average rate of ACTIVE
//                              hourly staff who are not overhead.
//   Catering offset          = for each booked catering deal that day, the crew
//                              hours billed on it in the CRM (deals.labor_hours,
//                              per crew member, x deals.staff_count), priced at
//                              crew cost + the catering premium: the rate of
//                              whoever is on that deal's Catering shifts (hours-
//                              weighted, open shifts at the average rate), else
//                              the average active hourly rate, plus the board's
//                              rule.catering_premium in force, capped at its
//                              cap_rate per person, exactly as the scheduled
//                              side applies it.
//   Target $ / hours         = in-store target + catering offset.
//
// "We are simply taking out all catering labor by canceling it out with what
// the client paid for" (Alina, 2026-10-16). Scheduled Catering shifts stay on
// the scheduled side, so an event staffed exactly as billed nets to zero and
// over-staffing shows as over target. A booked deal with no billed crew hours
// makes the day's target missing, naming the deal, never zero.
//
// Overhead staff (profiles.is_overhead, migration 45; bj-finance #692, ruled
// 2026-10-15) are not part of the payroll target: out of hourly labor hours
// and $, the average rate, the crew cost and the solo-close bonus. Their
// shifts still count in total hours and the day's scheduled hours.
//
// Every rate comes from the control board in force on the shift's date
// (computeBoard / boardOn), never a constant here. Pay type is read strictly:
// only `pay_type = 'hourly'` is hourly. A missing input is missing, with a
// short reason, never zero.
//
// Pure, so `node --test` runs it.

import { boardOn } from "./board.ts";
import type { Derived, Trend } from "./math.ts";
import { settingsInForce, type SalaryRow, type SettingRow } from "./settings.ts";
import type { SalariedProfile } from "./load.ts";

const TZ = "America/New_York";

/** The shift position the CRM and the payroll page give a catering event's crew (lib/payroll/eventShift.ts). */
export const CATERING_POSITION = "Catering";

/** A shift crewing a catering event: its position is CATERING_POSITION. */
const isCatering = (s: LaborShift) => (s.position ?? "").trim() === CATERING_POSITION;

export type LaborShift = {
  id: number;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  /** The catering deal a Catering shift crews (the CRM's shift writer sets it). */
  deal_id?: number | null;
};

/** A booked catering deal on one of the week's days, with the crew hours billed on it. */
export type CateringBooking = {
  id: number;
  /** The event day, New York. */
  day: string;
  /** Crew hours billed on the deal in the CRM: labor_hours (per crew member) x staff_count. Null when the deal does not say. */
  billedHours: number | null;
};

export type LaborPerson = {
  id: string;
  name: string;
  hourly_rate: number | null;
  pay_type?: "hourly" | "salaried" | null;
  active: boolean;
  /** Overhead: left out of hourly labor and the average rate (profiles.is_overhead). */
  overhead?: boolean;
};

export type ScheduleLaborInput = {
  /** The week's seven days, Sunday first. */
  dates: string[];
  /** The week's shifts; any outside `dates` (the page pads a day each side) are ignored. */
  shifts: LaborShift[];
  /** Everyone active, plus anyone on this week's shifts. */
  people: Map<string, LaborPerson>;
  /** Shift type name -> does it put someone behind the counter. Unknown or blank counts as in-store. */
  inStoreByName: Map<string, boolean>;
  /** Every control_settings row and every profile_salaries row (all dates). */
  settings: SettingRow[];
  salaries: SalaryRow[];
  /** Everyone in fixed payroll. */
  salaried: SalariedProfile[];
  trend: Trend;
  /** In-store sales by day for the days on file (last year's days are looked up here). */
  inStoreByDay: Map<string, number>;
  /** This week's booked catering deals, or null when the bookings could not be read. */
  catering: CateringBooking[] | null;
};

export type DayLabor = {
  date: string;
  /** The same weekday 52 weeks earlier. */
  lastYearDay: string;
  scheduledHours: number;
  lastYearInStore: Derived;
  trendedInStore: Derived;
  /** In-store only: catering bookings never feed it. */
  projectedSales: Derived;
  hourlyGoal: Derived;
  /** The day's catering offset: crew hours billed on its booked deals, and their $ at crew cost + premium. */
  cateringHours: Derived;
  cateringDollars: Derived;
  targetDollars: Derived;
  targetHours: Derived;
  /** One or two words for the header when the target is missing. */
  short: string | null;
};

export type ScheduleLabor = {
  totalHours: number;
  /** Hours of hourly-paid staff who are not overhead, and of open shifts. */
  hourlyHours: number;
  labor: {
    wages: number;
    premium: number;
    solo: number;
    open: number;
    total: number;
    /** Nothing could be priced, but something needed pricing. */
    none: boolean;
    /** What is not in the $, in words. Empty when the $ is complete. */
    notCounted: string[];
  };
  target: { dollars: Derived; hours: Derived };
  avgRate: Derived;
  /** How many active hourly people the average is over. */
  avgRateOver: number;
  trend: Trend;
  days: DayLabor[];
  /** Nothing at all is entered on the control board yet. */
  boardEmpty: boolean;
  /** Things to know that are not missing inputs. */
  notes: string[];
};

// ---------------------------------------------------------------------------
// Day and time helpers (New York wall time)
// ---------------------------------------------------------------------------

function nyDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2025-10-13" -> "Mon, Oct 13, 2025". */
export function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Wall-clock minutes after midnight of `day` in New York; past midnight counts on (24:30 is 1470). */
function nyMinutesFrom(iso: string, day: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const extraDays = Math.round((Date.parse(`${nyDate(iso)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  return extraDays * 1440 + h * 60 + m;
}

function hoursOf(s: LaborShift): number {
  return Math.max(0, (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 3_600_000);
}

const hrs = (h: number) => `${h.toFixed(1)}h`;
const missing = (...needs: string[]): Derived => ({ value: null, needs });
const known = (value: number): Derived => ({ value, needs: [] });
function both(a: Derived, b: Derived, fn: (x: number, y: number) => number | null): Derived {
  const needs = [...new Set([...a.needs, ...b.needs])];
  if (needs.length) return { value: null, needs };
  const v = fn(a.value as number, b.value as number);
  return v == null || !Number.isFinite(v) ? missing("a value above zero") : known(v);
}

// ---------------------------------------------------------------------------
// The words for what is missing
// ---------------------------------------------------------------------------

export const MISSING = {
  board: "Nothing is set on the control board yet",
  avgRate: "no active hourly staff with a rate on the Team page",
  catering: "catering bookings could not be read",
  premium: "catering premium not set on the control board",
  solo: "solo-close bonus not set on the control board",
} as const;

const billedNeed = (id: number) => `no billed crew hours on catering deal #${id}`;

const lastYearNeed = (day: string) => `no in-store sales on file for ${longDay(day)}`;

/** One or two words for a day header, from the first thing its target needs. */
function shortReason(d: Pick<DayLabor, "hourlyGoal" | "lastYearInStore" | "trendedInStore" | "cateringHours" | "targetHours">): string | null {
  if (d.targetHours.value != null) return null;
  if (d.hourlyGoal.needs.length) return "board not set";
  if (d.lastYearInStore.needs.length) return "no last-year sales";
  if (d.trendedInStore.needs.length) return "no trend";
  if (d.cateringHours.needs.includes(MISSING.catering)) return "catering unread";
  if (d.cateringHours.needs.length) return "no billed crew hours";
  return "no average rate";
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

const detailNum = (row: SettingRow | undefined, name: string): number | null => {
  const v = row?.detail?.[name];
  return typeof v === "number" ? v : v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
};

const detailText = (row: SettingRow | undefined, name: string): string | null => {
  const v = row?.detail?.[name];
  return typeof v === "string" && v ? v : null;
};

/**
 * The average rate of ACTIVE hourly staff, overhead left out. Pay type is read
 * strictly ('hourly'); an active hourly person with no rate is left out and
 * listed in `unrated`. Target hours and open shifts are priced at it.
 */
export function averageHourlyRate(people: Iterable<LaborPerson>): { avgRate: Derived; over: number; unrated: LaborPerson[] } {
  const activeHourly = [...people].filter((p) => p.active && p.pay_type === "hourly" && !p.overhead);
  const rated = activeHourly.filter((p) => p.hourly_rate != null && Number(p.hourly_rate) > 0);
  const unrated = activeHourly.filter((p) => !rated.includes(p));
  const avgRate = rated.length ? known(rated.reduce((a, p) => a + Number(p.hourly_rate), 0) / rated.length) : missing(MISSING.avgRate);
  return { avgRate, over: rated.length, unrated };
}

/** The catering premium per hour on `rate` on `date`: the board's rule in force, capped at its cap_rate per person. Null when not set. */
export function cateringPremium(settings: SettingRow[], rate: number, date: string): number | null {
  const rule = settingsInForce(settings, date).get("rule.catering_premium");
  if (!rule) return null;
  const cap = detailNum(rule, "cap_rate");
  const withPremium = rate + rule.value;
  return Math.max(0, (cap == null ? withPremium : Math.min(withPremium, cap)) - rate);
}

export type CateringOffsetInput = {
  /** The booked catering deals, or null when the bookings could not be read. */
  catering: CateringBooking[] | null;
  /** Shifts that may crew those deals: a deal's Catering shifts (deal_id) set its crew rate. */
  shifts: LaborShift[];
  people: Map<string, LaborPerson>;
  /** averageHourlyRate(people). */
  avgRate: Derived;
  /** Every control_settings row (all dates). */
  settings: SettingRow[];
};

/**
 * One day's catering offset (bj-finance #695, ruled 2026-10-16): the crew
 * hours billed on that day's booked deals (labor_hours x staff_count), priced
 * at crew cost + the catering premium exactly as the scheduled side prices a
 * deal's Catering shifts (rate + capped premium, open shifts at the average
 * rate), so a deal staffed as billed nets to zero. Shifts the scheduled side
 * leaves out (salaried, overhead, no pay type, no rate) are left out of the
 * crew cost too, and the deal falls back to the average rate; their billed
 * hours stay in the offset. No cart term: cart deals are billed the extra
 * hour. The Schedule page's labor line and the Labor vs target metric (#696)
 * both take it from here.
 */
export function cateringOffset(input: CateringOffsetInput, date: string): { hours: Derived; dollars: Derived } {
  const { people, avgRate, settings } = input;
  if (input.catering == null) return { hours: missing(MISSING.catering), dollars: missing(MISSING.catering) };
  const crewCostPerHour = (dealId: number): Derived => {
    let hours = 0;
    let dollars = 0;
    for (const s of input.shifts) {
      if (s.deal_id !== dealId || !isCatering(s)) continue;
      let rate: number | null = null;
      if (!s.employee_id) rate = avgRate.value;
      else {
        const p = people.get(s.employee_id);
        if (p?.pay_type === "hourly" && !p.overhead && p.hourly_rate != null && Number(p.hourly_rate) > 0) rate = Number(p.hourly_rate);
      }
      if (rate == null) continue;
      const prem = cateringPremium(settings, rate, nyDate(s.starts_at));
      if (prem == null) return missing(MISSING.premium);
      const h = hoursOf(s);
      hours += h;
      dollars += h * (rate + prem);
    }
    if (hours > 0) return known(dollars / hours);
    if (avgRate.value == null) return missing(MISSING.avgRate);
    const prem = cateringPremium(settings, avgRate.value, date);
    return prem == null ? missing(MISSING.premium) : known(avgRate.value + prem);
  };
  let hours: Derived = known(0);
  let dollars: Derived = known(0);
  for (const deal of input.catering.filter((d) => d.day === date)) {
    const billed = deal.billedHours != null && deal.billedHours > 0 ? known(deal.billedHours) : missing(billedNeed(deal.id));
    hours = both(hours, billed, (a, b) => a + b);
    dollars = both(dollars, both(billed, crewCostPerHour(deal.id), (h, r) => h * r), (a, b) => a + b);
  }
  return { hours, dollars };
}

export function scheduleLabor(input: ScheduleLaborInput): ScheduleLabor {
  const { dates, people, settings } = input;
  const dateSet = new Set(dates);
  const shifts = input.shifts.filter((s) => dateSet.has(nyDate(s.starts_at)));
  const onDay = (date: string) => settingsInForce(settings, date);
  const isInStore = (s: LaborShift) => {
    const key = s.position?.trim();
    return key ? input.inStoreByName.get(key) ?? true : true;
  };
  const notes: string[] = [];

  const { avgRate, over: avgRateOver, unrated } = averageHourlyRate(people.values());
  if (unrated.length) notes.push(`Left out of the average rate, no hourly rate on the Team page: ${unrated.map((p) => p.name).join(", ")}`);

  // ---- Projected hourly labor $ ----
  let wages = 0;
  let premium = 0;
  let open = 0;
  let hourlyHours = 0;
  let priced = 0;
  const noRate = new Map<string, number>();
  const noPayType = new Map<string, number>();
  let openUnpriced = 0;
  let premiumUnset = false;

  for (const s of shifts) {
    const h = hoursOf(s);
    const date = nyDate(s.starts_at);
    if (!s.employee_id) {
      hourlyHours += h;
      if (avgRate.value == null) {
        openUnpriced += h;
        continue;
      }
      let prem = 0;
      if (isCatering(s)) {
        const p = cateringPremium(settings, avgRate.value, date);
        if (p == null) premiumUnset = true;
        else prem = p;
      }
      open += h * (avgRate.value + prem);
      priced++;
      continue;
    }
    const person = people.get(s.employee_id);
    if (person?.pay_type === "salaried" || person?.overhead) continue;
    const who = person?.name ?? "Someone not on the Team page";
    if (person?.pay_type !== "hourly") {
      noPayType.set(who, (noPayType.get(who) ?? 0) + h);
      continue;
    }
    hourlyHours += h;
    const rate = person.hourly_rate != null && Number(person.hourly_rate) > 0 ? Number(person.hourly_rate) : null;
    if (rate == null) {
      noRate.set(who, (noRate.get(who) ?? 0) + h);
      continue;
    }
    wages += h * rate;
    priced++;
    if (isCatering(s)) {
      const p = cateringPremium(settings, rate, date);
      if (p == null) premiumUnset = true;
      else premium += h * p;
    }
  }

  // Solo close, per night: the in-store shift that ends last; its closer is
  // alone from the later of their own start and the last other in-store
  // shift's end. Qualifies at the board's minimum hours alone, out at or
  // after its cut-off. Open closers count (someone hourly will take it);
  // salaried, overhead and no-pay-type closers do not.
  let solo = 0;
  let soloUnset = false;
  for (const date of dates) {
    const inStore = shifts.filter((s) => nyDate(s.starts_at) === date && isInStore(s));
    if (inStore.length === 0) continue;
    const rule = onDay(date).get("rule.solo_close");
    const minAlone = detailNum(rule, "min_alone_hours");
    const outAt = detailText(rule, "out_at_or_after");
    if (!rule || minAlone == null || !outAt) {
      soloUnset = true;
      continue;
    }
    const closer = inStore.reduce((a, b) => (Date.parse(b.ends_at) > Date.parse(a.ends_at) ? b : a));
    const own = inStore.filter((s) => (closer.employee_id ? s.employee_id === closer.employee_id : s.id === closer.id));
    const others = inStore.filter((s) => !own.includes(s));
    let from = Math.min(...own.map((s) => Date.parse(s.starts_at)));
    for (const o of others) from = Math.max(from, Date.parse(o.ends_at));
    const end = Date.parse(closer.ends_at);
    const alone = Math.max(0, (end - Math.min(from, end)) / 3_600_000);
    const [cutH, cutM] = outAt.split(":").map(Number);
    const late = nyMinutesFrom(closer.ends_at, date) >= cutH * 60 + (cutM || 0);
    const closerPerson = closer.employee_id ? people.get(closer.employee_id) : null;
    const closerPays = !closer.employee_id || (closerPerson?.pay_type === "hourly" && !closerPerson.overhead);
    if (alone >= minAlone && late && closerPays) solo += rule.value;
  }

  const notCounted: string[] = [];
  for (const [who, h] of noRate) notCounted.push(`${who}: no hourly rate (${hrs(h)})`);
  if (openUnpriced) notCounted.push(`open shifts (${hrs(openUnpriced)}): ${MISSING.avgRate}`);
  if (premiumUnset) notCounted.push(MISSING.premium);
  if (soloUnset) notCounted.push(MISSING.solo);
  for (const [who, h] of noPayType) notCounted.push(`${who}: pay type not set on the Team page (${hrs(h)}, not in hourly labor)`);
  const somethingToPrice = priced > 0 || noRate.size > 0 || openUnpriced > 0;

  // ---- Day targets ----
  const days: DayLabor[] = dates.map((date) => {
    const scheduledHours = input.shifts.filter((s) => nyDate(s.starts_at) === date).reduce((a, s) => a + hoursOf(s), 0);
    const lastYearDay = addDays(date, -364);
    const ly = input.inStoreByDay.get(lastYearDay);
    const lastYearInStore = ly == null ? missing(lastYearNeed(lastYearDay)) : known(ly);
    const trendedInStore = both(lastYearInStore, input.trend.factor, (a, t) => a * t);
    const projectedSales = trendedInStore;
    const board = boardOn(date, settings, input.salaries, input.salaried);
    const hourlyGoal: Derived = board.hourlyGoalPct.value == null
      ? missing(...board.hourlyGoalPct.needs.map((n) => (n === "sales above zero" ? "a sales estimate above zero" : n)))
      : board.hourlyGoalPct;
    const inStoreDollars = both(projectedSales, hourlyGoal, (s, g) => s * g);
    const inStoreHours = both(inStoreDollars, avgRate, (d, r) => (r > 0 ? d / r : null));
    const { hours: cateringHours, dollars: cateringDollars } = cateringOffset({ catering: input.catering, shifts: input.shifts, people, avgRate, settings }, date);
    const targetDollars = both(inStoreDollars, cateringDollars, (a, c) => a + c);
    const targetHours = both(inStoreHours, cateringHours, (a, c) => a + c);
    const day = { date, lastYearDay, scheduledHours, lastYearInStore, trendedInStore, projectedSales, hourlyGoal, cateringHours, cateringDollars, targetDollars, targetHours, short: null as string | null };
    day.short = shortReason(day);
    return day;
  });

  const sum = (pick: (d: DayLabor) => Derived): Derived => {
    const needs = [...new Set(days.flatMap((d) => pick(d).needs))];
    return needs.length ? { value: null, needs } : known(days.reduce((a, d) => a + (pick(d).value as number), 0));
  };

  return {
    totalHours: shifts.reduce((a, s) => a + hoursOf(s), 0),
    hourlyHours,
    labor: {
      wages,
      premium,
      solo,
      open,
      total: wages + premium + solo + open,
      none: priced === 0 && somethingToPrice,
      notCounted,
    },
    target: { dollars: sum((d) => d.targetDollars), hours: sum((d) => d.targetHours) },
    avgRate,
    avgRateOver,
    trend: input.trend,
    days,
    boardEmpty: settings.length === 0,
    notes,
  };
}
