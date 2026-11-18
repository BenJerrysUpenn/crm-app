// Hours and hourly labour cost from the time clock (bj-finance #671, W5).
//
// WHAT THE TIMESHEETS LEAVE OUT, said on the page, never hidden:
//   * the salaried GM's pay: their hours are counted, their cost is not (it
//     is a salary; Labor vs target carries it);
//   * the owners and anyone else with no hourly rate on file: hours counted,
//     cost not (the owners are not paid);
//   * employer payroll tax.
// So "hourly labour $" here is a floor, not total labour.
//
// WHICH WORK A PUNCH IS: by its shift, the same rule as the Schedule page's
// labor line and bj-finance modules/labor_days.py (Labor vs target), so the
// three never disagree (Alina, 2026-11-18):
//   marketing  a Marketing shift, or any shift on a marketing deal (event
//              type starting "Marketing", or stage Closed Marketing Event);
//   catering   otherwise a Catering shift;
//   in-store   everything else.
// A punch with no shift is in-store, except the part of it that overlaps
// the same person's shift of catering or marketing work that has no punch of
// its own: that part is that work (a crew member who clocked in without
// picking the shift).
//
// A punch falls in the Sunday-to-Saturday week of its clock-in (New York
// day). Open punches (still clocked in) are not counted.

import { workKind, type LaborShift } from "../controlBoard/schedule.ts";
import { nyDay, spanHours, weekOf } from "./dates.ts";
import { round2 } from "./round.ts";

export type PunchRow = { employee_id: string; clock_in_at: string; clock_out_at: string | null; shift_id: number | null };
export type PersonRow = { id: string; hourly_rate: number | null; pay_type?: "hourly" | "salaried" | null };
export type Work = "inStore" | "catering" | "marketing";

export type LabourWeek = {
  week: string;
  inStoreHours: number;
  cateringHours: number;
  marketingHours: number;
  /** Hours x hourly rate, hourly staff only. */
  inStoreHourlyCost: number;
  cateringHourlyCost: number;
  marketingHourlyCost: number;
  /** Hours worked by salaried staff (cost not included). */
  salariedHours: number;
  /** Hours worked by people with no hourly rate (cost not included). */
  noRateHours: number;
};

export function emptyLabourWeek(week: string): LabourWeek {
  return {
    week,
    inStoreHours: 0,
    cateringHours: 0,
    marketingHours: 0,
    inStoreHourlyCost: 0,
    cateringHourlyCost: 0,
    marketingHourlyCost: 0,
    salariedHours: 0,
    noRateHours: 0,
  };
}

const KEY = { inStore: "inStore", catering: "catering", marketing: "marketing" } as const;
const ms = (iso: string) => new Date(iso).getTime();

/** Hours of a punch by the work they were: its shift's work, or, with no shift, by overlap with the person's unpunched work shifts. */
export function punchWork(
  p: PunchRow & { clock_out_at: string },
  shifts: Map<number, LaborShift>,
  unpunched: LaborShift[],
  marketingDeals: ReadonlySet<number>,
): Partial<Record<Work, number>> {
  const hours = spanHours(p.clock_in_at, p.clock_out_at);
  const linked = p.shift_id != null ? shifts.get(p.shift_id) : undefined;
  if (linked) return { [workKind(linked, marketingDeals) ?? KEY.inStore]: hours };
  const out: Partial<Record<Work, number>> = {};
  let worked = 0;
  const [a, b] = [ms(p.clock_in_at), ms(p.clock_out_at)];
  for (const s of unpunched) {
    if (s.employee_id !== p.employee_id) continue;
    const overlap = Math.max(0, Math.min(b, ms(s.ends_at)) - Math.max(a, ms(s.starts_at))) / 3_600_000;
    if (overlap <= 0) continue;
    const kind = workKind(s, marketingDeals)!;
    const take = Math.min(overlap, hours - worked);
    out[kind] = (out[kind] ?? 0) + take;
    worked += take;
  }
  if (hours - worked > 0) out.inStore = hours - worked;
  return out;
}

export function labourByWeek(
  punches: PunchRow[],
  shiftRows: LaborShift[],
  marketingDeals: ReadonlySet<number>,
  people: Map<string, PersonRow>,
  weeks: string[],
): { weeks: LabourWeek[]; openPunches: number } {
  const byWeek = new Map(weeks.map((w) => [w, emptyLabourWeek(w)]));
  const shifts = new Map(shiftRows.map((s) => [s.id, s]));
  const punched = new Set(punches.map((p) => p.shift_id).filter((id): id is number => id != null));
  // Catering and marketing shifts nobody punched against: a punch with no shift may have worked them.
  const unpunched = shiftRows.filter((s) => !punched.has(s.id) && workKind(s, marketingDeals) != null);
  let openPunches = 0;
  for (const p of punches) {
    if (!p.clock_out_at) {
      openPunches++;
      continue;
    }
    const w = byWeek.get(weekOf(nyDay(p.clock_in_at)));
    if (!w) continue;
    const person = people.get(p.employee_id);
    const rate = person?.pay_type === "salaried" ? null : person?.hourly_rate || null;
    for (const [kind, hours] of Object.entries(punchWork({ ...p, clock_out_at: p.clock_out_at }, shifts, unpunched, marketingDeals)) as [Work, number][]) {
      w[`${kind}Hours`] += hours;
      if (person?.pay_type === "salaried") w.salariedHours += hours;
      else if (rate == null) w.noRateHours += hours;
      else w[`${kind}HourlyCost`] += hours * rate;
    }
  }
  const out = weeks.map((wk) => {
    const w = byWeek.get(wk)!;
    return {
      week: wk,
      inStoreHours: round2(w.inStoreHours),
      cateringHours: round2(w.cateringHours),
      marketingHours: round2(w.marketingHours),
      inStoreHourlyCost: round2(w.inStoreHourlyCost),
      cateringHourlyCost: round2(w.cateringHourlyCost),
      marketingHourlyCost: round2(w.marketingHourlyCost),
      salariedHours: round2(w.salariedHours),
      noRateHours: round2(w.noRateHours),
    };
  });
  return { weeks: out, openPunches };
}

/** Sales per scooper-hour; null without hours or sales. */
export function salesPerHour(sales: number | null, hours: number): number | null {
  if (sales == null || hours <= 0) return null;
  return round2(sales / hours);
}
