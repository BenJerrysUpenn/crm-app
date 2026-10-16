// Server-side reads for the Schedule page's labor line (bj-finance #695).
// Reads as the signed-in manager. The control board's own loader
// (loadBoard) supplies the settings, salaries and the trend's sales; this
// adds last year's days, this week's catering bookings and the rates of
// anyone on the week's shifts who is no longer active.
//
// A read that fails is reported and what it fed shows as missing, never zero.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "@/lib/metrics/dates";
import { BOOKED_STAGES, cateringByDay, type DealRow } from "@/lib/metrics/catering";
import { loadBoard } from "./load";
import { trendFactor } from "./math";
import { scheduleLabor, type LaborPerson, type LaborShift, type ScheduleLabor } from "./schedule";

export type ScheduleLaborLoad = { ready: true; labor: ScheduleLabor; problems: string[] } | { ready: false; reason: string };

type ProfileLike = { id: string; full_name: string | null; hourly_rate: number | string | null; pay_type?: "hourly" | "salaried" | null; active: boolean };
type ShiftTypeLike = { name: string; in_store?: boolean | null };

const DEAL_COLUMNS = "id, stage, payment_status, event_date, created_at, subtotal_pretax, total_with_tax, amount_paid, company, source, archived";

function person(p: ProfileLike): LaborPerson {
  return {
    id: p.id,
    name: p.full_name ?? "Unnamed",
    hourly_rate: p.hourly_rate == null ? null : Number(p.hourly_rate),
    pay_type: p.pay_type ?? null,
    active: p.active,
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
  const people = new Map<string, LaborPerson>(week.employees.map((e) => [e.id, person(e)]));
  const absent = [...new Set(week.shifts.map((s) => s.employee_id).filter((id): id is string => !!id && !people.has(id)))];

  const [absentRes, lastYearRes, dealRes] = await Promise.all([
    absent.length
      ? supabase.from("profiles").select("id, full_name, hourly_rate, pay_type, active").in("id", absent)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("sales_daily_in_store").select("day, in_store").gte("day", addDays(weekStart, -364)).lte("day", addDays(weekEnd, -364)),
    supabase.from("deals").select(DEAL_COLUMNS).gte("event_date", weekStart).lte("event_date", `${weekEnd}T23:59:59`),
  ]);

  if (absentRes.error) problems.push(`Staff on this week's shifts could not be read: ${absentRes.error.message}`);
  for (const p of (absentRes.data as ProfileLike[] | null) ?? []) people.set(p.id, person(p));

  const inStoreByDay = new Map<string, number>();
  if (lastYearRes.error) problems.push(`Last year's daily sales could not be read: ${lastYearRes.error.message}`);
  for (const r of (lastYearRes.data as { day: string; in_store: number | string }[] | null) ?? []) inStoreByDay.set(r.day, Number(r.in_store));

  let catering: Record<string, number> | null = null;
  if (dealRes.error) {
    problems.push(`Catering bookings could not be read: ${dealRes.error.message}`);
  } else {
    const deals = (dealRes.data as DealRow[] | null) ?? [];
    const bookedBefore = new Set<number>();
    let historyOk = true;
    if (deals.length) {
      const ev = await supabase
        .from("deal_events")
        .select("deal_id, new_value")
        .eq("field", "stage")
        .in("new_value", BOOKED_STAGES)
        .in("deal_id", deals.map((d) => d.id));
      if (ev.error) {
        historyOk = false;
        problems.push(`Catering bookings could not be read: ${ev.error.message}`);
      }
      for (const e of (ev.data as { deal_id: number }[] | null) ?? []) bookedBefore.add(e.deal_id);
    }
    if (historyOk) {
      const days = cateringByDay(deals, weekStart, weekEnd, today, bookedBefore);
      catering = days.byDay;
      if (days.missingValueIds.length) problems.push(`Booked catering with no value on the deal, left out of projected sales: #${days.missingValueIds.join(", #")}`);
    }
  }

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
    cateringByDay: catering,
  });
  return { ready: true, labor, problems };
}
