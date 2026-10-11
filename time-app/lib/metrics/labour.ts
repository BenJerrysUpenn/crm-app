// Hours and hourly labour cost from the time clock (bj-finance #671, W5).
//
// WHAT THE TIMESHEETS LEAVE OUT, said on the page, never hidden:
//   * the salaried GM's pay: their hours are counted, their cost is not (it
//     is a salary, and comes with the finance feed);
//   * the owners and anyone else with no hourly rate on file: hours counted,
//     cost not (the owners are not paid; LER adds owner comp separately);
//   * employer payroll tax.
// So "hourly labour $" here is a floor, not total labour.
//
// A punch is catering when its shift belongs to a catering deal
// (shifts.deal_id), otherwise in-store. It falls in the week of its clock-in
// (New York day). Open punches (still clocked in) are not counted.

import { mondayOf, nyDay } from "./dates.ts";

export type PunchRow = { employee_id: string; clock_in_at: string; clock_out_at: string | null; shift_id: number | null };
export type PersonRow = { id: string; hourly_rate: number | null; pay_type?: "hourly" | "salaried" | null };

export type LabourWeek = {
  week: string;
  inStoreHours: number;
  cateringHours: number;
  /** In-store hours x hourly rate, hourly staff only. */
  inStoreHourlyCost: number;
  cateringHourlyCost: number;
  /** Hours worked by salaried staff (cost not included). */
  salariedHours: number;
  /** Hours worked by people with no hourly rate (cost not included). */
  noRateHours: number;
};

const two = (n: number) => Math.round(n * 100) / 100;

export function emptyLabourWeek(week: string): LabourWeek {
  return { week, inStoreHours: 0, cateringHours: 0, inStoreHourlyCost: 0, cateringHourlyCost: 0, salariedHours: 0, noRateHours: 0 };
}

export function labourByWeek(
  punches: PunchRow[],
  shiftDeal: Map<number, number | null>,
  people: Map<string, PersonRow>,
  weeks: string[],
): { weeks: LabourWeek[]; openPunches: number } {
  const byWeek = new Map(weeks.map((w) => [w, emptyLabourWeek(w)]));
  let openPunches = 0;
  for (const p of punches) {
    if (!p.clock_out_at) {
      openPunches++;
      continue;
    }
    const w = byWeek.get(mondayOf(nyDay(p.clock_in_at)));
    if (!w) continue;
    const hours = Math.max(0, (new Date(p.clock_out_at).getTime() - new Date(p.clock_in_at).getTime()) / 3_600_000);
    const catering = p.shift_id != null && shiftDeal.get(p.shift_id) != null;
    const person = people.get(p.employee_id);
    if (catering) w.cateringHours += hours;
    else w.inStoreHours += hours;
    if (person?.pay_type === "salaried") w.salariedHours += hours;
    else if (!person?.hourly_rate) w.noRateHours += hours;
    else if (catering) w.cateringHourlyCost += hours * person.hourly_rate;
    else w.inStoreHourlyCost += hours * person.hourly_rate;
  }
  const out = weeks.map((wk) => {
    const w = byWeek.get(wk)!;
    return {
      week: wk,
      inStoreHours: two(w.inStoreHours),
      cateringHours: two(w.cateringHours),
      inStoreHourlyCost: two(w.inStoreHourlyCost),
      cateringHourlyCost: two(w.cateringHourlyCost),
      salariedHours: two(w.salariedHours),
      noRateHours: two(w.noRateHours),
    };
  });
  return { weeks: out, openPunches };
}

/** Sales per scooper-hour; null without hours or sales. */
export function salesPerHour(sales: number | null, hours: number): number | null {
  if (sales == null || hours <= 0) return null;
  return two(sales / hours);
}

/** Labour as a share of sales (0..1, three places); null without sales. */
export function labourPct(cost: number | null, sales: number | null): number | null {
  if (cost == null || sales == null || sales <= 0) return null;
  return Math.round((cost / sales) * 1000) / 1000;
}
