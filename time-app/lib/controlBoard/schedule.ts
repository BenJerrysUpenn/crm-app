// The Schedule page's labor line (bj-finance #695, spec by Alina 2026-10-13).
// Manager view only. The week reads as an aligned block
// (components/ScheduleLaborLine.tsx), the day headers as the date only:
//
//   Target Hourly Labor       target hours         target $
//   Scheduled Hourly Labor    hourly-paid hours    projected $
//   Remaining Hourly Labor    target - scheduled, hours and $
//
//   Projected hourly labor $ = in-store hourly-paid scheduled hours x rate
//                            + solo-close bonus per qualifying night
//                            + open in-store shifts at the average active
//                              hourly rate.
//                            Salaried and overhead staff are left out.
//   Day projected sales      = last year's in-store sales on the same weekday
//                              52 weeks earlier x trend factor. IN-STORE ONLY:
//                              catering bookings never feed projected sales.
//   Target $                 = projected sales x the hourly goal in force that day.
//   Target hours             = target $ / average rate of ACTIVE hourly staff
//                              who are not overhead.
//   Closed day               = the store is closed that date (a closed day
//                              from the Targets tab, a "Business closed"
//                              note, a weekday the season closes; resolved
//                              by lib/coverage.ts resolveOpenWindow, as the
//                              Labor Hours Planning card does): no projected
//                              in-store sales, so no target, even if the
//                              store was open the year before or has no
//                              sales on file.
//
// Catering work and marketing work never count in the labor line (Alina,
// 2026-11-16: "since we're taking it out of the analytics, we should also be
// taking it out of the labor percent on the scheduler in the same way"). The
// shifts the Labor vs target card's punches come from (bj-finance
// modules/labor_days.py) are left out of the scheduled side, hours and $,
// catering premium and all: a Catering shift, a Marketing shift, and any
// shift on a marketing deal (event type starting "Marketing", or stage
// Closed Marketing Event; never also catering). They do not close for the
// solo-close bonus either. The target is in-store only: nothing is added for
// a booked deal, so a deal's quote (labor_hours, staff_count) is never read
// and a deal with no shifts, a pickup or a deal missing its quote fields
// cannot move the line or make it missing. The page shows scheduled hours
// on past days too, never punches.
//
// Overhead staff (profiles.is_overhead, migration 45; bj-finance #692, ruled
// 2026-10-15) are not part of the payroll target: out of hourly labor hours
// and $, the average rate and the solo-close bonus. Their shifts still count
// in total hours and the day's scheduled hours.
//
// Every rate comes from the control board in force on the shift's date
// (computeBoard / boardOn), never a constant here. A pay rule (solo-close
// bonus) before its first row did not exist yet and pays nothing; one never
// set is missing (ruleOn in settings.ts). Fixed payroll on a date counts the
// people salaried that date (inFixedPayroll in board.ts). Pay type is read
// strictly: only `pay_type = 'hourly'` is hourly. A missing input is missing,
// with a short reason, never zero.
//
// Pure, so `node --test` runs it.

import { boardOn } from "./board.ts";
import type { Derived, Trend } from "./math.ts";
import { ruleOn, type SalaryRow, type SettingRow } from "./settings.ts";
import type { SalariedProfile } from "./load.ts";

const TZ = "America/New_York";

/** The shift position the CRM and the payroll page give a catering event's crew (lib/payroll/eventShift.ts). */
export const CATERING_POSITION = "Catering";

/** The shift position of marketing work (lib/scheduleEvents.ts MARKETING_POSITION, which Node's test runner cannot import from here). */
const MARKETING_POSITION = "Marketing";

/** The stage a marketing event closes at. */
const MARKETING_STAGE = "Closed Marketing Event";

/**
 * A marketing deal, as bj-finance modules/labor_days.py reads one for the
 * Labor vs target card: its event type starts "Marketing" (any case) or its
 * stage is Closed Marketing Event. Any shift on it is marketing work.
 */
export function isMarketingDeal(d: { event_type: string | null; stage: string | null }): boolean {
  return /^\s*marketing/i.test(d.event_type ?? "") || d.stage === MARKETING_STAGE;
}

const positionIs = (s: LaborShift, position: string) => (s.position ?? "").trim().toLowerCase() === position.toLowerCase();

/**
 * Which work a shift is, as the Labor vs target card splits its punches:
 * marketing (a Marketing position, or any shift on a marketing deal),
 * catering (a Catering position on any other deal or none), else null:
 * in-store.
 */
export function workKind(s: LaborShift, marketingDeals: ReadonlySet<number>): "catering" | "marketing" | null {
  if (positionIs(s, MARKETING_POSITION) || (s.deal_id != null && marketingDeals.has(s.deal_id))) return "marketing";
  if (positionIs(s, CATERING_POSITION)) return "catering";
  return null;
}

export type LaborShift = {
  id: number;
  employee_id: string | null;
  starts_at: string;
  ends_at: string;
  position: string | null;
  /** The deal the shift crews (the CRM's shift writer sets it; a manager links it in the shift's popup). */
  deal_id?: number | null;
};

/** A booked catering deal with the crew hours billed on it: the Labor Hours Planning card's booked band (the labor line does not read deals' quotes). */
export type CateringBooking = {
  id: number;
  /** The event day, New York. */
  day: string;
  /** Crew hours billed on the deal in the CRM: labor_hours (per crew member) x staff_count. 0 when the deal bills no crew (a pickup); null when the deal does not say. */
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
  /** The ids of the marketing deals (isMarketingDeal) among the week's shifts' deals. */
  marketingDeals: ReadonlySet<number>;
  /** The week's dates the store is closed. None given: every day is open. */
  closedDays?: Set<string>;
};

export type DayLabor = {
  date: string;
  /** The same weekday 52 weeks earlier. */
  lastYearDay: string;
  /** The store is closed: no in-store target that day. */
  closed: boolean;
  scheduledHours: number;
  lastYearInStore: Derived;
  trendedInStore: Derived;
  /** In-store only: catering bookings never feed it. Zero on a closed day. */
  projectedSales: Derived;
  hourlyGoal: Derived;
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
  solo: "solo-close bonus not set on the control board",
} as const;

const lastYearNeed = (day: string) => `no in-store sales on file for ${longDay(day)}`;

/** One or two words for a day header, from the first thing its target needs. */
function shortReason(d: Pick<DayLabor, "hourlyGoal" | "lastYearInStore" | "trendedInStore" | "targetHours">): string | null {
  if (d.targetHours.value != null) return null;
  if (d.hourlyGoal.needs.length) return "board not set";
  if (d.lastYearInStore.needs.length) return "no last-year sales";
  if (d.trendedInStore.needs.length) return "no trend";
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

export function scheduleLabor(input: ScheduleLaborInput): ScheduleLabor {
  const { dates, people, settings } = input;
  const dateSet = new Set(dates);
  const shifts = input.shifts.filter((s) => dateSet.has(nyDate(s.starts_at)));
  const kind = (s: LaborShift) => workKind(s, input.marketingDeals);
  // Catering and marketing work never put someone behind the counter.
  const isInStore = (s: LaborShift) => {
    if (kind(s)) return false;
    const key = s.position?.trim();
    return key ? input.inStoreByName.get(key) ?? true : true;
  };
  const notes: string[] = [];

  const { avgRate, over: avgRateOver, unrated } = averageHourlyRate(people.values());
  if (unrated.length) notes.push(`Left out of the average rate, no hourly rate on the Team page: ${unrated.map((p) => p.name).join(", ")}`);

  // ---- Projected hourly labor $ ----
  let wages = 0;
  let open = 0;
  let hourlyHours = 0;
  let priced = 0;
  const noRate = new Map<string, number>();
  const noPayType = new Map<string, number>();
  let openUnpriced = 0;

  for (const s of shifts) {
    // Catering and marketing work are out of the line, whoever works it.
    if (kind(s)) continue;
    const h = hoursOf(s);
    if (!s.employee_id) {
      hourlyHours += h;
      if (avgRate.value == null) {
        openUnpriced += h;
        continue;
      }
      open += h * avgRate.value;
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
    const on = ruleOn(settings, "rule.solo_close", date);
    if (on.state === "not_yet") continue; // no bonus before the rule's first row
    const rule = on.state === "in_force" ? on.row : undefined;
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
  if (soloUnset) notCounted.push(MISSING.solo);
  for (const [who, h] of noPayType) notCounted.push(`${who}: pay type not set on the Team page (${hrs(h)}, not in hourly labor)`);
  const somethingToPrice = priced > 0 || noRate.size > 0 || openUnpriced > 0;

  // ---- Day targets ----
  const days: DayLabor[] = dates.map((date) => {
    const scheduledHours = input.shifts.filter((s) => nyDate(s.starts_at) === date).reduce((a, s) => a + hoursOf(s), 0);
    const lastYearDay = addDays(date, -364);
    const closed = input.closedDays?.has(date) ?? false;
    const ly = input.inStoreByDay.get(lastYearDay);
    const lastYearInStore = ly == null ? missing(lastYearNeed(lastYearDay)) : known(ly);
    const trendedInStore = both(lastYearInStore, input.trend.factor, (a, t) => a * t);
    const projectedSales = closed ? known(0) : trendedInStore;
    const board = boardOn(date, settings, input.salaries, input.salaried);
    const hourlyGoal: Derived = board.hourlyGoalPct.value == null
      ? missing(...board.hourlyGoalPct.needs.map((n) => (n === "sales above zero" ? "a sales estimate above zero" : n)))
      : board.hourlyGoalPct;
    const targetDollars = both(projectedSales, hourlyGoal, (s, g) => s * g);
    const targetHours = both(targetDollars, avgRate, (d, r) => (r > 0 ? d / r : null));
    const day = { date, lastYearDay, closed, scheduledHours, lastYearInStore, trendedInStore, projectedSales, hourlyGoal, targetDollars, targetHours, short: null as string | null };
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
      solo,
      open,
      total: wages + solo + open,
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
