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
import { SALES_TARGET_SEED } from "./salesTargetsSeed.ts";
import type { SalesTargetRow } from "./targets.ts";

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
  targets: { rows: SalesTargetRow[]; source: "table" | "seed" };
  problems: string[];
};

export type SuspectDeal = { id: number; company: string | null; eventDay: string | null };

export type MetricsData = {
  today: string;
  targets: SalesTargetRow[];
  targetsSource: "table" | "seed";
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

  const [byEvent, byCreated, stageEvents, punches, shifts, people, outreach, targets] = await Promise.all([
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
      const full = await supabase.from("profiles").select("id, hourly_rate, pay_type");
      if (!full.error) return (full.data ?? []) as PersonRow[];
      // Before migration 26 there is no pay_type: everyone with a rate is hourly.
      const bare = await supabase.from("profiles").select("id, hourly_rate");
      if (bare.error) throw bare.error;
      return (bare.data ?? []) as PersonRow[];
    }),
    attempt("outreach", () =>
      paged<OutreachEventRow>(() =>
        supabase.from("outreach_events").select("event, occurred_at").in("event", ["sequenced", "replied"]).gte("occurred_at", nyMidnight(firstWeek)).order("id"),
      ),
    ),
    (async (): Promise<MetricsInputs["targets"]> => {
      try {
        const { data, error } = await supabase.from("sales_targets").select("month, stream, amount, basis, provisional, measure");
        if (error) {
          if (!isMissingTable(error)) problems.push(`sales targets: ${error.message}; showing the bundled target table`);
          return { rows: SALES_TARGET_SEED, source: "seed" };
        }
        return { rows: ((data ?? []) as SalesTargetRow[]).map((r) => ({ ...r, amount: Number(r.amount) })), source: "table" };
      } catch {
        return { rows: SALES_TARGET_SEED, source: "seed" };
      }
    })(),
  ]);

  let deals: DealRow[] | null = null;
  if (byEvent && byCreated) {
    const merged = new Map<number, DealRow>();
    for (const d of [...byEvent, ...byCreated]) merged.set(d.id, d);
    deals = [...merged.values()];
  }

  return { today, deals, stageEvents, punches, shifts, people, outreach, targets, problems };
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
    targets: inputs.targets.rows,
    targetsSource: inputs.targets.source,
    catering,
    ar,
    labour,
    forward,
    leads,
    outreach: inputs.outreach ? outreachByWeek(inputs.outreach, weeks) : null,
    quotes,
    problems: inputs.problems,
  };
}
