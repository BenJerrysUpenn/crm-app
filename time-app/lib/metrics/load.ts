// Everything the Metrics page draws, read once per page load as the
// signed-in manager (bj-finance #671). Each widget then slices what it needs
// for its own period and stream on the client, so changing a setting never
// waits on the network.
//
// Two halves:
//   loadMetricsInputs  the Supabase reads (deals, stage history, punches,
//                      shifts, people, outreach events, targets). A section
//                      that fails is reported in `problems` and drawn as
//                      "could not load", never as zeros.
//   buildMetricsData   pure arithmetic over those rows (tested).
//
// Deals, deal_events and outreach_events belong to the CRM in the same
// Postgres and are readable by managers through its RLS policies.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingTable } from "@/lib/storeHours";
import { addDays, addMonths, lastMonths, lastWeeks, monthEnd, nyToday } from "./dates.ts";
import { arSummary, cateringByDay, suspectDeals, type ArSummary, type DealRow } from "./catering.ts";
import { labourByWeek, type LabourWeek, type PersonRow, type PunchRow } from "./labour.ts";
import { forwardCatering, type ForwardDay, type ShiftRow } from "./forward.ts";
import { leadsByWeek, outreachByWeek, quoteToBooking, type LeadWeek, type OutreachEventRow, type OutreachWeek, type QuoteCohort } from "./funnel.ts";
import { MONTHS, MONTHS_AHEAD, WEEKS } from "./series.ts";
import type { SalesTargetRow } from "./targets.ts";
import { parseCash, parseClosedMonth, parseDaily, type ClosedMonth, type DailySnapshot } from "./feed.ts";
import { laborVsTarget, laborWindow, type LaborDayRow, type LaborTargetInputs, type LaborTargetWeek, type SalesDayRow } from "./laborTarget.ts";
import { defaultLaborRange, laborWeekStarts, type WeekRange } from "./weekRange.ts";
import { loadBoard } from "@/lib/controlBoard/load";
import { PROFILE_COLUMNS, laborPerson, loadCateringBookings } from "@/lib/controlBoard/scheduleLoad";
import type { LaborShift } from "@/lib/controlBoard/schedule";

/** What the page's data spans on `today`: the weeks and months behind it, and the days from the first of those months to the end of the last month ahead. */
function metricsWindow(today: string): { weeks: string[]; months: string[]; from: string; to: string } {
  const weeks = lastWeeks(today, WEEKS);
  const months = lastMonths(today, MONTHS);
  return { weeks, months, from: months[0], to: monthEnd(addMonths(today, MONTHS_AHEAD)) };
}

export type StageEventRow = { deal_id: number; new_value: string | null };

export type MetricsInputs = {
  today: string;
  deals: DealRow[] | null;
  stageEvents: StageEventRow[] | null;
  punches: PunchRow[] | null;
  shifts: ShiftRow[] | null;
  people: PersonRow[] | null;
  outreach: OutreachEventRow[] | null;
  targets: SalesTargetRow[] | null;
  /** Labor vs target's reads: the paid hourly actuals, the daily in-store sales and the control board. */
  laborTarget: Omit<LaborTargetInputs, "today"> | null;
  feed: FeedInputs;
  problems: string[];
};

/** The finance feed as read: raw rows, parsed in buildMetricsData. */
export type FeedInputs =
  | { status: "not_enabled" }
  | { status: "unreadable"; message: string }
  | {
      status: "read";
      latestDaily: { period: string; built_at: string; payload: unknown } | null;
      cashHistory: { period: string; built_at: string; cash: unknown }[];
      closedMonths: { period: string; built_at: string; payload: unknown }[];
    };

export type FeedData =
  | { status: "not_enabled" | "empty" }
  | { status: "unreadable"; message: string }
  | { status: "unrecognised"; builtAt: string }
  | {
      status: "ok";
      builtAt: string | null;
      daily: DailySnapshot | null;
      /** On hand at the end of each day the feed has published, oldest first. */
      cashHistory: { day: string; onHand: number }[];
      /** Latest publish per closed month, oldest first. */
      closedMonths: ClosedMonth[];
    };

export type SuspectDeal = { id: number; company: string | null; eventDay: string | null };

export type MetricsData = {
  today: string;
  /** public.sales_targets, the only source; null when it could not be read (named in problems). */
  targets: SalesTargetRow[] | null;
  catering: null | {
    from: string;
    to: string;
    byDay: Record<string, number>;
    estimatedIds: number[];
    missingValueIds: number[];
    suspect: SuspectDeal[];
  };
  ar: ArSummary | null;
  labour: null | { weeks: LabourWeek[]; openPunches: number };
  forward: null | { days: ForwardDay[]; overdue: number; uncostedShifts: number };
  leads: LeadWeek[] | null;
  outreach: OutreachWeek[] | null;
  quotes: QuoteCohort[] | null;
  /** Labor vs target for each week on offer, oldest first, and the range a card shows until one is chosen. */
  laborTarget: null | { weeks: LaborTargetWeek[]; defaultRange: WeekRange };
  feed: FeedData;
  problems: string[];
};

const PAGE = 1000; // PostgREST's row cap per request
const MAX_PAGES = 50;

type Query = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string; code?: string } | null }> };

async function paged<T>(make: () => Query): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await make().range(page * PAGE, (page + 1) * PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const DEAL_COLUMNS = "id, stage, payment_status, event_date, created_at, subtotal_pretax, total_with_tax, amount_paid, company, source, archived";

/** An ISO instant at New York midnight starting `day` (EDT or EST: the earlier, so nothing is missed). */
function nyMidnight(day: string): string {
  return `${day}T04:00:00Z`;
}

export async function loadMetricsInputs(supabase: SupabaseClient, now: Date = new Date()): Promise<MetricsInputs> {
  const today = nyToday(now);
  const { weeks, from: firstMonth, to: lastDay } = metricsWindow(today);
  const firstWeek = weeks[0];
  const problems: string[] = [];

  async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (e) {
      problems.push(`${label}: ${(e as { message?: string })?.message ?? String(e)}`);
      return null;
    }
  }

  const [byEvent, byCreated, stageEvents, punches, shifts, people, outreach, targets, laborTarget, feed] = await Promise.all([
    attempt("catering deals", () =>
      paged<DealRow>(() =>
        supabase.from("deals").select(DEAL_COLUMNS).gte("event_date", firstMonth).lte("event_date", `${lastDay}T23:59:59`).order("id"),
      ),
    ),
    attempt("new enquiries", () =>
      paged<DealRow>(() => supabase.from("deals").select(DEAL_COLUMNS).gte("created_at", firstMonth).order("id")),
    ),
    attempt("deal stage history", () =>
      paged<StageEventRow>(() =>
        supabase
          .from("deal_events")
          .select("deal_id, new_value")
          .eq("field", "stage")
          .in("new_value", ["Sent Quote", "Booked Unpaid", "Booked Paid"])
          .gte("at", addMonths(firstMonth, -6))
          .order("id"),
      ),
    ),
    attempt("time clock", () =>
      paged<PunchRow>(() =>
        supabase.from("time_entries").select("employee_id, clock_in_at, clock_out_at, shift_id").gte("clock_in_at", nyMidnight(firstWeek)).order("id"),
      ),
    ),
    attempt("shifts", () =>
      paged<ShiftRow>(() =>
        supabase
          .from("shifts")
          .select("id, employee_id, starts_at, ends_at, deal_id")
          .gte("starts_at", nyMidnight(addDays(firstWeek, -1)))
          .lte("starts_at", nyMidnight(addDays(today, 15)))
          .order("id"),
      ),
    ),
    attempt("people", async () => {
      const { data, error } = await supabase.from("profiles").select("id, hourly_rate, pay_type");
      if (error) throw error;
      return (data ?? []) as PersonRow[];
    }),
    attempt("outreach", () =>
      paged<OutreachEventRow>(() =>
        supabase.from("outreach_events").select("event, occurred_at").in("event", ["sequenced", "replied"]).gte("occurred_at", nyMidnight(firstWeek)).order("id"),
      ),
    ),
    attempt("sales targets", async () => {
      const { data, error } = await supabase.from("sales_targets").select("month, stream, amount, basis, provisional, measure");
      if (error) throw error;
      return ((data ?? []) as SalesTargetRow[]).map((r) => ({ ...r, amount: Number(r.amount) }));
    }),
    attempt("labor vs target", () => loadLaborTarget(supabase, today, problems)),
    loadFeed(supabase, addDays(today, -95), addMonths(today, -13)),
  ]);

  let deals: DealRow[] | null = null;
  if (byEvent && byCreated) {
    const merged = new Map<number, DealRow>();
    for (const d of [...byEvent, ...byCreated]) merged.set(d.id, d);
    deals = [...merged.values()];
  }

  return { today, deals, stageEvents, punches, shifts, people, outreach, targets, laborTarget, feed, problems };
}

/**
 * Labor vs target (bj-finance #696): public.labor_daily_actuals (migration
 * 46) and public.sales_daily_in_store (migration 41) over the weeks on
 * offer, the control board's settings, salaries and fixed-payroll people
 * (loadBoard, the same reads the Targets tab makes), and for the catering
 * offset the booked deals (loadCateringBookings, the Schedule page's read),
 * the shifts that crew them and the team. Any of the first three, the shifts
 * or the team failing fails the card: a target without its actuals, or the
 * reverse, is not shown. Bookings that cannot be read are named in
 * `problems` and make each week's labor not available.
 */
async function loadLaborTarget(supabase: SupabaseClient, today: string, problems: string[]): Promise<Omit<LaborTargetInputs, "today">> {
  const { from, to } = laborWindow(today);
  const [labor, sales, board, bookings, crewShifts, team] = await Promise.all([
    paged<Record<string, unknown>>(() =>
      supabase.from("labor_daily_actuals").select("day, hours, wages, catering_premium, solo_close").gte("day", from).lte("day", to).order("day"),
    ),
    paged<Record<string, unknown>>(() => supabase.from("sales_daily_in_store").select("day, in_store").gte("day", from).lte("day", to).order("day")),
    loadBoard(supabase, today),
    loadCateringBookings(supabase, from, to, today),
    paged<LaborShift>(() =>
      supabase
        .from("shifts")
        .select("id, employee_id, starts_at, ends_at, position, deal_id")
        .not("deal_id", "is", null)
        .gte("starts_at", nyMidnight(addDays(from, -1)))
        .lte("starts_at", nyMidnight(addDays(to, 2)))
        .order("id"),
    ),
    paged<Parameters<typeof laborPerson>[0]>(() => supabase.from("profiles").select(PROFILE_COLUMNS).order("id")),
  ]);
  if (!board.ready) throw new Error(board.reason);
  problems.push(...bookings.problems.map((p) => `labor vs target: ${p}`));
  return {
    labor: labor.map(
      (r): LaborDayRow => ({
        day: String(r.day),
        hours: Number(r.hours),
        wages: Number(r.wages),
        catering_premium: Number(r.catering_premium),
        solo_close: Number(r.solo_close),
      }),
    ),
    sales: sales.map((r): SalesDayRow => ({ day: String(r.day), in_store: Number(r.in_store) })),
    settings: board.settings,
    salaries: board.salaries,
    salaried: board.salaried,
    catering: { bookings: bookings.catering, shifts: crewShifts, people: team.map(laborPerson) },
  };
}

/** Reads public.metrics_snapshots (migration 40): the latest daily, the daily cash history, the closed months. */
async function loadFeed(supabase: SupabaseClient, cashFrom: string, monthsFrom: string): Promise<FeedInputs> {
  try {
    const latest = await supabase
      .from("metrics_snapshots")
      .select("period, built_at, payload")
      .eq("kind", "daily")
      .order("period", { ascending: false })
      .order("built_at", { ascending: false })
      .limit(1);
    if (latest.error) return isMissingTable(latest.error) ? { status: "not_enabled" } : { status: "unreadable", message: latest.error.message };
    const [cash, months] = await Promise.all([
      supabase
        .from("metrics_snapshots")
        .select("period, built_at, cash:payload->cash")
        .eq("kind", "daily")
        .gte("period", cashFrom)
        .order("period")
        .order("built_at"),
      supabase.from("metrics_snapshots").select("period, built_at, payload").eq("kind", "closed_month").gte("period", monthsFrom).order("period").order("built_at"),
    ]);
    if (cash.error) return { status: "unreadable", message: cash.error.message };
    if (months.error) return { status: "unreadable", message: months.error.message };
    return {
      status: "read",
      latestDaily: ((latest.data ?? [])[0] as { period: string; built_at: string; payload: unknown } | undefined) ?? null,
      cashHistory: (cash.data ?? []) as { period: string; built_at: string; cash: unknown }[],
      closedMonths: (months.data ?? []) as { period: string; built_at: string; payload: unknown }[],
    };
  } catch (e) {
    return { status: "unreadable", message: (e as Error).message };
  }
}

export function buildFeed(f: FeedInputs): FeedData {
  if (f.status !== "read") return f;
  if (!f.latestDaily && f.closedMonths.length === 0) return { status: "empty" };
  const daily = f.latestDaily ? parseDaily(f.latestDaily.payload) : null;
  if (f.latestDaily && !daily) return { status: "unrecognised", builtAt: f.latestDaily.built_at };
  // Latest publish per day / per month wins (rows arrive oldest first).
  const cash = new Map<string, number>();
  for (const r of f.cashHistory) {
    const c = parseCash(r.cash);
    if (c) cash.set(c.as_of, c.on_hand);
  }
  const months = new Map<string, ClosedMonth>();
  for (const r of f.closedMonths) {
    const m = parseClosedMonth(r.payload);
    if (m) months.set(m.month, m);
  }
  return {
    status: "ok",
    builtAt: f.latestDaily?.built_at ?? null,
    daily,
    cashHistory: [...cash.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, onHand]) => ({ day, onHand })),
    closedMonths: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

export function buildMetricsData(inputs: MetricsInputs): MetricsData {
  const { today } = inputs;
  const { weeks, months, from, to } = metricsWindow(today);

  const bookedBefore = new Set<number>();
  const quotedBefore = new Set<number>();
  for (const e of inputs.stageEvents ?? []) {
    if (e.new_value === "Sent Quote") quotedBefore.add(e.deal_id);
    else bookedBefore.add(e.deal_id);
  }

  const people = new Map((inputs.people ?? []).map((p) => [p.id, p]));
  const deals = inputs.deals;

  let catering: MetricsData["catering"] = null;
  let ar: ArSummary | null = null;
  let quotes: QuoteCohort[] | null = null;
  let leads: LeadWeek[] | null = null;
  if (deals) {
    const days = cateringByDay(deals, from, to, today, bookedBefore);
    catering = {
      from,
      to,
      byDay: days.byDay,
      estimatedIds: days.estimatedIds,
      missingValueIds: days.missingValueIds,
      suspect: suspectDeals(deals, today, bookedBefore).map((d) => ({ id: d.id, company: d.company, eventDay: d.event_date?.slice(0, 10) ?? null })),
    };
    ar = arSummary(deals, today, bookedBefore);
    leads = leadsByWeek(deals, weeks);
    quotes = quoteToBooking(deals, months, today, { quotedBefore, bookedBefore });
  }

  let labour: MetricsData["labour"] = null;
  if (inputs.punches && inputs.shifts && inputs.people) {
    const shiftDeal = new Map(inputs.shifts.map((s) => [s.id, s.deal_id]));
    labour = labourByWeek(inputs.punches, shiftDeal, people, weeks);
  }

  let forward: MetricsData["forward"] = null;
  if (deals && inputs.shifts && inputs.people) {
    forward = forwardCatering(deals, inputs.shifts, people, today, bookedBefore);
  }

  return {
    today,
    targets: inputs.targets,
    catering,
    ar,
    labour,
    forward,
    leads,
    outreach: inputs.outreach ? outreachByWeek(inputs.outreach, weeks) : null,
    quotes,
    laborTarget: inputs.laborTarget
      ? {
          weeks: laborVsTarget(laborWeekStarts(today), { today, ...inputs.laborTarget! }),
          defaultRange: defaultLaborRange(today),
        }
      : null,
    feed: buildFeed(inputs.feed),
    problems: inputs.problems,
  };
}
